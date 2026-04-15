"""Beanie (MongoDB ODM) adapter for the Notitia events bus.

Provides:
- ``BeanieStateTracker`` — persists scheduled event state on Beanie Documents
- ``BeanieAwareSerializer`` — serializes Document instances as ID references
  and fetches them back on deserialization

Install with: ``pip install notitia[beanie]``

Usage::

    from notitia.contrib.beanie import BeanieStateTracker, BeanieAwareSerializer

    EventsBus.configure(
        client=notitia_client,
        webhook_target="https://api.example.com/notitia/",
        state_tracker=BeanieStateTracker(),
        serializer=BeanieAwareSerializer(),
    )
"""

import json
import hashlib
import hmac
import logging
from datetime import datetime, timezone
from typing import Any, Optional, Tuple, Type

from ..events.event import ScheduledEvent
from ..events.serialization import EventSerializer

logger = logging.getLogger("notitia.contrib.beanie")


class BeanieStateTracker(EventSerializer):
    """Tracks scheduled events on Beanie Document instances.

    Expects the target object to be a Beanie ``Document`` with a
    ``scheduled_events: list[ScheduledEvent]`` field. If the field
    is missing, operations are silently skipped.
    """

    async def on_event_scheduled(
        self,
        target: Any,
        event_name: str,
        job_id: str,
        when: Optional[datetime | str],
    ) -> None:
        if not hasattr(target, "scheduled_events"):
            return

        # Cancel existing scheduled event for the same event name
        await self.on_event_cancelled(target, event_name, job_id="", _silent=True)

        target.scheduled_events.append(
            ScheduledEvent(event=event_name, job_id=job_id, when=when)
        )
        await self._save(target)

    async def on_event_executed(
        self,
        target: Any,
        event_name: str,
        job_id: str,
    ) -> None:
        if not hasattr(target, "scheduled_events"):
            return

        scheduled = self._find_event(target, job_id=job_id)
        if scheduled is None:
            logger.warning(
                "Scheduled event %s (id=%s) not found on %s",
                event_name,
                job_id,
                target,
            )
            return

        # Don't mark recurring events as executed — they keep running
        if isinstance(scheduled.when, str):
            logger.info(
                "Scheduled event %s (%s) is recurring, not marking as executed",
                scheduled.event,
                scheduled.job_id,
            )
            return

        scheduled.executed_on = datetime.now(timezone.utc)
        logger.info(
            "Marked scheduled event %s (id=%s) as executed at %s",
            scheduled.event,
            job_id,
            scheduled.executed_on,
        )
        await self._save(target)

    async def on_event_cancelled(
        self,
        target: Any,
        event_name: str,
        job_id: str,
        _silent: bool = False,
    ) -> None:
        if not hasattr(target, "scheduled_events"):
            return

        scheduled = self._find_event(target, event_name=event_name)
        if scheduled is None:
            if not _silent:
                logger.warning(
                    "Scheduled event %s not found on %s for cancellation",
                    event_name,
                    target,
                )
            return

        target.scheduled_events.remove(scheduled)
        await self._save(target)

    async def get_scheduled_event_job_id(
        self,
        target: Any,
        event_name: str,
    ) -> Optional[str]:
        if not hasattr(target, "scheduled_events"):
            return None

        scheduled = self._find_event(target, event_name=event_name)
        return scheduled.job_id if scheduled else None

    @staticmethod
    def _find_event(
        target: Any,
        *,
        event_name: Optional[str] = None,
        job_id: Optional[str] = None,
    ) -> Optional[ScheduledEvent]:
        for se in target.scheduled_events:
            if se.executed_on is not None:
                continue
            if event_name is not None and se.event == event_name:
                return se
            if job_id is not None and se.job_id == job_id:
                return se
        return None

    @staticmethod
    async def _save(target: Any) -> None:
        from beanie import Document

        if isinstance(target, Document):
            await target.update(
                {
                    "$set": {
                        "scheduled_events": [
                            _scheduled_event_to_dict(se)
                            for se in target.scheduled_events
                        ]
                    }
                }
            )


def _scheduled_event_to_dict(se: ScheduledEvent) -> dict:
    d: dict[str, Any] = {"event": se.event, "job_id": se.job_id}
    if se.when is not None:
        d["when"] = se.when.isoformat() if isinstance(se.when, datetime) else se.when
    if se.executed_on is not None:
        d["executed_on"] = se.executed_on.isoformat()
    return d


# --- Document-aware serializer ---

# Registry mapping qualname -> Document subclass for deserialization
_document_type_registry: dict[str, Type] = {}


def register_document_type(cls: Type) -> Type:
    """Register a Beanie Document subclass for deserialization.

    Call this for each Document type that may be passed as an event argument::

        @register_document_type
        class User(Document):
            ...
    """
    _document_type_registry[f"{cls.__module__}.{cls.__qualname__}"] = cls
    return cls


class BeanieAwareSerializer:
    """Serializer that handles Beanie Document instances.

    Documents are serialized as ``{"__beanie_doc__": qualname, "id": str}``.
    On deserialization, the document is fetched from the database by ID.

    Other arguments are serialized as plain JSON (like ``JsonSerializer``).

    Args:
        signing_key: Optional HMAC-SHA256 signing key.
    """

    def __init__(self, signing_key: Optional[str] = None):
        self._signing_key = signing_key

    def serialize(self, *args: Any, **kwargs: Any) -> str:
        from beanie import Document

        def encode(obj: Any) -> Any:
            if isinstance(obj, Document):
                qualname = f"{type(obj).__module__}.{type(obj).__qualname__}"
                return {"__beanie_doc__": qualname, "id": str(obj.id)}
            raise TypeError(f"Object of type {type(obj)} is not JSON serializable")

        payload = {
            "args": list(args),
            "kwargs": kwargs,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "version": "1.0",
        }
        body = json.dumps(payload, default=encode, ensure_ascii=False)

        if self._signing_key is not None:
            sig = self._compute_signature(body)
            return json.dumps({"body": body, "sig": sig}, ensure_ascii=False)
        return body

    async def deserialize(self, payload: str) -> Tuple[tuple, dict]:
        data = json.loads(payload)

        if self._signing_key is not None and "body" in data and "sig" in data:
            expected = self._compute_signature(data["body"])
            if not hmac.compare_digest(expected, data["sig"]):
                raise ValueError("HMAC signature verification failed")
            data = json.loads(data["body"])
        elif self._signing_key is not None and "body" not in data:
            raise ValueError("Signing key is configured but payload is not signed")

        args = await self._resolve_documents(data.get("args", []))
        kwargs = await self._resolve_documents(data.get("kwargs", {}))
        return tuple(args), kwargs

    async def _resolve_documents(self, obj: Any) -> Any:
        if isinstance(obj, dict) and "__beanie_doc__" in obj:
            qualname = obj["__beanie_doc__"]
            doc_cls = _document_type_registry.get(qualname)
            if doc_cls is None:
                raise ValueError(
                    f"Document type '{qualname}' is not registered. "
                    f"Use @register_document_type on the class."
                )
            doc = await doc_cls.get(obj["id"])
            if doc is None:
                raise ValueError(
                    f"{qualname} with id '{obj['id']}' not found in database"
                )
            return doc
        elif isinstance(obj, list):
            return [await self._resolve_documents(item) for item in obj]
        elif isinstance(obj, dict):
            return {k: await self._resolve_documents(v) for k, v in obj.items()}
        return obj

    def _compute_signature(self, body: str) -> str:
        return hmac.new(
            self._signing_key.encode(),
            body.encode(),
            hashlib.sha256,
        ).hexdigest()
