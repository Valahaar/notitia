from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Callable, ClassVar, Coroutine, Optional


class Event(str, Enum):
    """Base enum for event bus events.

    Subclass within an EventsBus subclass to define domain events.
    Members can be used as decorators to register handler methods.

    Example::

        class UserLifecycle(EventsBus):
            class Event(EventsBus.Event):
                __notitia_queue__ = "lifecycle-user"
                WELCOME = "welcome"
                WEEKLY_DIGEST = "weekly_digest"

            @Event.WELCOME
            async def on_welcome(self):
                ...
    """

    __notitia_queue__: ClassVar[Optional[str]] = None

    def __call__(self, func: Callable[..., Coroutine]) -> Callable[..., Coroutine]:
        """Use enum members as decorators to register event handlers."""
        if not hasattr(func, "_event_handlers"):
            func._event_handlers = []
        func._event_handlers.append(self)
        return func


@dataclass
class ScheduledEventInvocation:
    """Payload sent to the Notitia service when scheduling a bus event.

    Carried through the scheduling service and delivered back to the
    webhook endpoint at execution time.
    """

    event_qualname: str
    signed_payload: str
    original_emitter_timestamp_iso: str
    execution_datetime_iso: Optional[str] = None
    recurrence_rule: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "event_qualname": self.event_qualname,
            "signed_payload": self.signed_payload,
            "original_emitter_timestamp_iso": self.original_emitter_timestamp_iso,
        }
        if self.execution_datetime_iso is not None:
            d["execution_datetime_iso"] = self.execution_datetime_iso
        if self.recurrence_rule is not None:
            d["recurrence_rule"] = self.recurrence_rule
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ScheduledEventInvocation":
        return cls(
            event_qualname=data["event_qualname"],
            signed_payload=data["signed_payload"],
            original_emitter_timestamp_iso=data["original_emitter_timestamp_iso"],
            execution_datetime_iso=data.get("execution_datetime_iso"),
            recurrence_rule=data.get("recurrence_rule"),
        )


@dataclass
class ScheduledEvent:
    """Tracks a scheduled event on a domain object."""

    event: str
    job_id: str
    when: Optional[datetime | str] = None
    executed_on: Optional[datetime] = None
