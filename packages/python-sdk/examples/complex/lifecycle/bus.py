import collections
import inspect
from datetime import datetime, timezone
from enum import Enum
from typing import Callable, ClassVar, Coroutine, Optional, Type, Union

from beanie import Document
from loguru import logger
from pydantic import BaseModel

from .event import ScheduledEventInvocation
from .notitia import Notitia
from .scheduling import SchedulingResolver, WhenType
from .serialization import NotitiaSerializer


class ScheduledEvent(BaseModel):
    event: str
    job_id: str
    when: datetime | str | None
    executed_on: datetime | None = None


class EventsBus:
    class Event(str, Enum):
        __notitia_queue__ = None

        def __call__(self, func: Callable[..., Coroutine]) -> Callable[..., Coroutine]:
            """Allows enum members to be used as decorators for event handlers."""
            if not hasattr(func, "_event_handlers"):
                func._event_handlers = []
            func._event_handlers.append(self)
            return func

    scheduled_events: list[ScheduledEvent] = []

    async def emit_now(self, event: Event, *args, **kwargs):
        # _execute_locally is a classmethod, which will have the class itself as first arg,
        # we force placing self as first argument so that, when the handler gets invoked,
        # the first argument is the instance itself
        await self._execute_locally(event, self, *args, **kwargs)

    async def emit_scheduled(
        self: Union[Document, "EventsBus"],
        event: Event,
        *args,
        # if when == 'now', the event is dispatched to be executed ASAP via Notitia
        # which avoids blocking the current execution for potentially long-running tasks
        when: WhenType,
        **kwargs,
    ) -> str:
        job_id, execution_datetime = await self._schedule_event(
            event, when, self, *args, **kwargs
        )

        # in the unlikely case this is executed on a non-instance of EventsBus,
        if not hasattr(self, "scheduled_events"):
            return job_id

        await self.cancel_scheduled(event, save_document=False, silent=True)
        self.scheduled_events.append(
            ScheduledEvent(event=event.value, job_id=job_id, when=execution_datetime)
        )

        if isinstance(self, Document):
            await self.update({"$set": {"scheduled_events": self.scheduled_events}})

        return job_id

    async def cancel_scheduled(
        self, event: Event, save_document: bool = True, silent: bool = False
    ):
        scheduled_event = next(
            (
                scheduled_event
                for scheduled_event in self.scheduled_events
                if scheduled_event.event == event.value
                and not scheduled_event.executed_on
            ),
            None,
        )
        if scheduled_event is None:
            if not silent:
                logger.warning(
                    f"scheduled event {event.value} not found in {self}'s scheduled events"
                )
            return

        await self.cancel(scheduled_event.job_id, queue=event.__notitia_queue__)
        self.scheduled_events.remove(scheduled_event)
        if save_document and isinstance(self, Document):
            await self.update({"$set": {"scheduled_events": self.scheduled_events}})

    _handlers: ClassVar[dict[Type, dict[Event, list[Callable[..., Coroutine]]]]] = (
        collections.defaultdict(lambda: collections.defaultdict(list))
    )

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        if not cls._handlers[cls]:
            cls._handlers[cls] = collections.defaultdict(list)

        for _, method in inspect.getmembers(cls, inspect.isfunction):
            if hasattr(method, "_event_handlers"):
                for event in method._event_handlers:
                    cls._handlers[cls][event].append(method)

    @classmethod
    def on(cls, event: Event):
        def decorator(func: Callable[..., Coroutine]):
            cls._handlers[cls][event].append(func)
            return func

        return decorator

    @classmethod
    async def _maybe_update_scheduled_events(
        cls, event, target, notitia_task_id: str | None
    ):
        # mark scheduled event as executed if we're in a notitia context and the first argument is an EventsBus
        if (
            not notitia_task_id
            or not isinstance(target, EventsBus)
            or not hasattr(target, "scheduled_events")
        ):
            logger.info(
                f"Not updating scheduled events for {target} because notitia_task_id is {notitia_task_id} or target is not an EventsBus"
            )
            return

        scheduled_event = next(
            (
                scheduled_event
                for scheduled_event in target.scheduled_events
                if scheduled_event.job_id == notitia_task_id
                and scheduled_event.executed_on is None
            ),
            None,
        )

        if scheduled_event is None:
            logger.warning(
                f"Scheduled event {event.value} with id {notitia_task_id} not found in {target}'s scheduled events"
            )
            return

        if scheduled_event is not None and isinstance(scheduled_event.when, str):
            logger.info(
                f"Scheduled event {scheduled_event.event} ({scheduled_event.job_id}) "
                "is recurring, not updating event's executed_on"
            )
            return

        scheduled_event.executed_on = datetime.now(timezone.utc)
        logger.info(
            f"Marked scheduled event {scheduled_event.event} (id={notitia_task_id}) as executed at {scheduled_event.executed_on}"
        )

        if isinstance(target, Document):
            await target.update({"$set": {"scheduled_events": target.scheduled_events}})

    @classmethod
    async def _execute_locally(
        cls, event: Event, *args, notitia_task_id: Optional[str] = None, **kwargs
    ):
        if len(args) > 0 and notitia_task_id is not None:
            await cls._maybe_update_scheduled_events(event, args[0], notitia_task_id)

        handlers = cls._handlers.get(cls, {}).get(event, [])
        for handler in handlers:
            await handler(*args, **kwargs)

    @classmethod
    async def _schedule_event(
        cls,
        event: Event,
        when: WhenType,
        *args,
        **kwargs,
    ) -> tuple[str, datetime | None]:
        # Build event qualname
        event_qualname = f"{cls.__module__}.{cls.__name__}.Event.{event.value}"

        # Serialize and sign arguments securely
        signed_payload = NotitiaSerializer.serialize_and_sign(*args, **kwargs)

        execution_datetime = SchedulingResolver.resolve(when)

        # Create invocation payload
        invocation_payload = ScheduledEventInvocation(
            event_qualname=event_qualname,
            signed_payload=signed_payload,  # JWT token containing signed args/kwargs
            execution_datetime_iso=execution_datetime.isoformat()
            if isinstance(execution_datetime, datetime)
            else None,
            recurrence_rule=execution_datetime
            if isinstance(execution_datetime, str)
            else None,
            original_emitter_timestamp_iso=datetime.now(timezone.utc).isoformat(),
        )

        job_id = await Notitia.emit(
            "notitia_event", invocation_payload, queue=event.__notitia_queue__
        )

        return job_id, execution_datetime

    @classmethod
    async def cancel(cls, job_id: str, queue: Optional[str] = None) -> bool:
        if queue is None and cls.Event.__notitia_queue__ is not None:
            queue = cls.Event.__notitia_queue__

        logger.info(f"cancelling job {job_id} on queue {queue}")
        return await Notitia.client().cancel(job_id, queue)
