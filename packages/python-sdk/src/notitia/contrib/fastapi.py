"""FastAPI adapter for the Notitia events bus.

Provides a router factory that creates a webhook endpoint for receiving
scheduled event callbacks from the Notitia service.

Install with: ``pip install notitia[fastapi]``

Usage::

    from notitia.contrib.fastapi import create_notitia_router

    app = FastAPI()
    app.include_router(create_notitia_router())
"""

import importlib
import logging
from typing import Annotated, Optional, Type

from ..events.bus import EventsBus
from ..events.serialization import EventSerializer

logger = logging.getLogger("notitia.contrib.fastapi")


def _locate_type_by_qualname(qualname: str) -> Optional[Type[EventsBus]]:
    """Dynamically import and return an EventsBus subclass by its fully qualified name."""
    try:
        module_name, class_name = qualname.rsplit(".", 1)
        module = importlib.import_module(module_name)
        cls = getattr(module, class_name)
        if not issubclass(cls, EventsBus):
            logger.error("Class %s does not extend EventsBus", cls.__name__)
            return None
        return cls
    except (ImportError, AttributeError, ValueError) as e:
        logger.error("Could not locate type by qualname '%s': %s", qualname, e)
        return None


def create_notitia_router(
    path: str = "/notitia",
    serializer: Optional[EventSerializer] = None,
):
    """Create a FastAPI router for receiving Notitia event callbacks.

    Args:
        path: URL prefix for the router.
        serializer: Override the serializer used to deserialize event payloads.
            Defaults to the serializer configured on ``EventsBus``.

    Returns:
        A FastAPI ``APIRouter`` ready to be included in your app.
    """
    from fastapi import APIRouter, Header
    from pydantic import BaseModel

    class ScheduledEventInvocationModel(BaseModel):
        event_qualname: str
        signed_payload: str
        original_emitter_timestamp_iso: str
        execution_datetime_iso: Optional[str] = None
        recurrence_rule: Optional[str] = None

    router = APIRouter(prefix=path, tags=["notitia"])

    @router.post("/")
    async def execute_scheduled_event(
        payload: ScheduledEventInvocationModel,
        x_notitia_task_id: Annotated[Optional[str], Header()] = None,
    ):
        # 1. Parse event qualname: "module.ClassName.Event.MEMBER"
        parts = payload.event_qualname.split(".")
        class_module_str = ".".join(parts[:-3])
        class_name_str = parts[-3]
        event_member_name_str = parts[-1]

        # 2. Locate target class
        target_cls = _locate_type_by_qualname(
            f"{class_module_str}.{class_name_str}"
        )
        if not target_cls:
            return {"status": "error", "message": f"Class not found: {class_module_str}.{class_name_str}"}, 400

        # 3. Locate event enum member
        event_enum_type = getattr(target_cls, "Event", None)
        if not event_enum_type:
            return {"status": "error", "message": f"Event enum not found on {class_name_str}"}, 400

        try:
            actual_event = event_enum_type(event_member_name_str)
        except ValueError:
            return {"status": "error", "message": f"Event member '{event_member_name_str}' not found"}, 400

        # 4. Deserialize arguments
        ser = serializer or EventsBus._serializer
        args, kwargs = await ser.deserialize(payload.signed_payload)

        # 5. If the class defines resolve() and the first arg looks like an entity ID,
        #    reconstruct the domain object
        if (
            args
            and isinstance(args[0], str)
            and target_cls.resolve is not EventsBus.resolve
        ):
            resolved = await target_cls.resolve(args[0])
            if resolved is not None:
                args = (resolved, *args[1:])

        # 6. Execute handlers
        await target_cls._execute_locally(
            actual_event, *args, notitia_task_id=x_notitia_task_id, **kwargs
        )

        return {"status": "ok"}

    return router
