import importlib
from typing import Annotated, Type

from fastapi import APIRouter, Header, HTTPException
from loguru import logger

from .lifecycle import EventsBus, NotitiaSerializer, ScheduledEventInvocation

router = APIRouter(prefix="/notitia", tags=["notitia"])


def locate_type_by_qualname(qualname: str) -> Type[EventsBus]:
    """Dynamically imports and returns a type that extends EventsBus by its fully qualified name."""
    try:
        module_name, class_name = qualname.rsplit(".", 1)
        module = importlib.import_module(module_name)
        cls = getattr(module, class_name)
        if not issubclass(cls, EventsBus):
            logger.error(f"Class {cls.__name__} does not extend EventsBus")
            return None
        return cls
    except (ImportError, AttributeError, ValueError) as e:
        logger.error(f"Could not locate type by qualname '{qualname}': {e}")
        return None


@router.post("/")
async def execute_scheduled_event(
    payload: ScheduledEventInvocation,
    x_notitia_task_id: Annotated[str | None, Header()] = None,
):
    try:
        # 1. Parse event qualname
        parts = payload.event_qualname.split(".")
        class_module_str = ".".join(parts[:-3])
        class_name_str = parts[-3]
        event_member_name_str = parts[-1]

        # 2. Locate target class and event
        target_cls_type = locate_type_by_qualname(
            f"{class_module_str}.{class_name_str}"
        )
        if not target_cls_type:
            raise HTTPException(
                status_code=400,
                detail=f"target class not found {class_module_str}.{class_name_str}",
            )

        event_enum_type = getattr(target_cls_type, "Event", None)
        if not event_enum_type:
            raise HTTPException(
                status_code=400,
                detail=f"Event enum not found in {class_module_str}.{class_name_str}",
            )

        try:
            actual_event_member = event_enum_type(event_member_name_str)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"event member not found {event_member_name_str} in {event_enum_type}",
            )

        # 3. Deserialize arguments using jsonpickle
        args, kwargs = await NotitiaSerializer.verify_and_deserialize(
            payload.signed_payload
        )

        # 4. Execute the event and mark as executed if applicable
        await target_cls_type._execute_locally(
            actual_event_member, *args, notitia_task_id=x_notitia_task_id, **kwargs
        )

        return {"status": "ok"}

    except Exception as e:
        logger.error("Error executing scheduled event")
        logger.exception(e)
        raise HTTPException(status_code=500, detail=str(e))
