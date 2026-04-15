import collections
import inspect
import logging
from datetime import datetime, timezone
from typing import Any, Callable, ClassVar, Coroutine, Optional, Type

from ..common_types import HttpMethod, OneTimeSchedule, RecurringSchedule
from ..types import EventConfig, PreparedEventData
from .event import Event, ScheduledEventInvocation
from .scheduling import SchedulingResolver, WhenType
from .serialization import EventSerializer, JsonSerializer
from .state import NoOpStateTracker, StateTracker

logger = logging.getLogger("notitia.events")

# Sentinel for the internal event name registered with NotitiaClient
_BUS_EVENT_NAME = "_notitia_bus_event"


class EventsBus:
    """Framework-agnostic event bus powered by Notitia scheduling.

    Subclass this to define domain events with decorated async handlers.
    Events can be emitted locally (``emit_now``) or scheduled for later
    execution via the Notitia service (``emit_scheduled``).

    Example::

        class OrderEvents(EventsBus):
            class Event(EventsBus.Event):
                ORDER_PLACED = "order_placed"

            @Event.ORDER_PLACED
            async def on_order_placed(self, order_id: str):
                print(f"Order {order_id} placed!")

        # At startup
        EventsBus.configure(client=notitia_client, webhook_target="http://localhost:8000/notitia/")

        # Usage
        orders = OrderEvents()
        await orders.emit_now(OrderEvents.Event.ORDER_PLACED, "order-123")
        await orders.emit_scheduled(OrderEvents.Event.ORDER_PLACED, "order-123", when=timedelta(hours=1))
    """

    class Event(Event):
        pass

    # --- Class-level configuration (set once via configure()) ---
    _client: ClassVar[Optional[Any]] = None  # NotitiaClient
    _serializer: ClassVar[EventSerializer] = JsonSerializer()
    _state_tracker: ClassVar[StateTracker] = NoOpStateTracker()
    _webhook_target: ClassVar[Optional[str]] = None
    _configured: ClassVar[bool] = False

    # --- Handler registry ---
    _handlers: ClassVar[dict[Type, dict[Event, list[Callable[..., Coroutine]]]]] = (
        collections.defaultdict(lambda: collections.defaultdict(list))
    )

    @classmethod
    def configure(
        cls,
        client: Any,
        webhook_target: str,
        serializer: Optional[EventSerializer] = None,
        state_tracker: Optional[StateTracker] = None,
    ) -> None:
        """One-time configuration. Call at application startup.

        Args:
            client: A ``NotitiaClient`` instance.
            webhook_target: URL where Notitia will POST scheduled events
                back to your application (e.g. ``"https://api.example.com/notitia/"``).
            serializer: Custom serializer for event arguments.
                Defaults to ``JsonSerializer`` (stdlib json, no signing).
            state_tracker: Tracks scheduled event state on domain objects.
                Defaults to ``NoOpStateTracker``.
        """
        if cls._configured:
            raise RuntimeError(
                "EventsBus.configure() has already been called. "
                "It should only be called once at application startup."
            )

        cls._client = client
        cls._webhook_target = webhook_target
        if serializer is not None:
            cls._serializer = serializer
        if state_tracker is not None:
            cls._state_tracker = state_tracker

        # Register the internal bus event with the NotitiaClient
        cls._client._event_definitions[_BUS_EVENT_NAME] = EventConfig(
            target=webhook_target,
            prepare=cls._prepare_bus_event,
            method=HttpMethod.POST,
        )

        cls._configured = True

    @staticmethod
    def _prepare_bus_event(invocation: ScheduledEventInvocation) -> PreparedEventData:
        schedule = None
        if invocation.recurrence_rule:
            schedule = RecurringSchedule(schedule=invocation.recurrence_rule)
        elif invocation.execution_datetime_iso:
            schedule = OneTimeSchedule(time=invocation.execution_datetime_iso)

        return PreparedEventData(
            payload=invocation.to_dict(),
            schedule=schedule,
        )

    # --- Handler registration ---

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        if not cls._handlers[cls]:
            cls._handlers[cls] = collections.defaultdict(list)

        for _, method in inspect.getmembers(cls, inspect.isfunction):
            if hasattr(method, "_event_handlers"):
                for event in method._event_handlers:
                    if method not in cls._handlers[cls][event]:
                        cls._handlers[cls][event].append(method)

    @classmethod
    def on(cls, event: Event) -> Callable:
        """Alternative decorator for registering external event handlers.

        Example::

            @UserLifecycle.on(UserLifecycle.Event.WELCOME)
            async def send_welcome_email(user):
                ...
        """

        def decorator(func: Callable[..., Coroutine]) -> Callable[..., Coroutine]:
            cls._handlers[cls][event].append(func)
            return func

        return decorator

    # --- Resolve pattern ---

    @classmethod
    async def resolve(cls, entity_id: str) -> Any:
        """Override to reconstruct domain objects from their ID.

        When defined, ``emit_scheduled`` serializes ``self`` as an entity
        ID (via ``self.id``), and the webhook side calls ``resolve()`` to
        reconstruct the object before invoking handlers.

        Returns ``None`` by default (no resolution — args are passed as-is).

        Example::

            class UserLifecycle(EventsBus):
                @classmethod
                async def resolve(cls, entity_id: str) -> "User":
                    return await User.get(entity_id)
        """
        return None

    # --- Emit ---

    async def emit_now(self, event: Event, *args: Any, **kwargs: Any) -> None:
        """Execute event handlers locally in the current event loop."""
        await self._execute_locally(event, self, *args, **kwargs)

    async def emit_scheduled(
        self,
        event: Event,
        *args: Any,
        when: WhenType,
        **kwargs: Any,
    ) -> str:
        """Schedule an event for deferred execution via Notitia.

        Args:
            event: The event enum member to schedule.
            *args: Arguments passed to event handlers (must be serializable).
            when: When to execute. See ``WhenType`` for accepted formats.
            **kwargs: Keyword arguments passed to event handlers.

        Returns:
            The Notitia job ID for tracking or cancellation.
        """
        if not self._configured:
            raise RuntimeError(
                "EventsBus is not configured. Call EventsBus.configure() first."
            )

        job_id, execution_datetime = await self._schedule_event(
            event, when, self, *args, **kwargs
        )

        await self._state_tracker.on_event_scheduled(
            self, event.value, job_id, execution_datetime
        )

        return job_id

    async def cancel_scheduled(self, event: Event, silent: bool = False) -> None:
        """Cancel a previously scheduled event.

        Args:
            event: The event to cancel.
            silent: If ``True``, don't log a warning when no scheduled event is found.
        """
        job_id = await self._state_tracker.get_scheduled_event_job_id(self, event.value)

        if job_id is None:
            if not silent:
                logger.warning(
                    "Scheduled event %s not found on %s", event.value, self
                )
            return

        queue = event.__notitia_queue__ if hasattr(event, "__notitia_queue__") else None
        await self._client.cancel(job_id, queue)
        await self._state_tracker.on_event_cancelled(self, event.value, job_id)

    # --- Internal execution ---

    @classmethod
    async def _execute_locally(
        cls,
        event: Event,
        *args: Any,
        notitia_task_id: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        """Invoke registered handlers for an event."""
        if len(args) > 0 and notitia_task_id is not None:
            await cls._state_tracker.on_event_executed(
                args[0], event.value, notitia_task_id
            )

        handlers = cls._handlers.get(cls, {}).get(event, [])
        for handler in handlers:
            await handler(*args, **kwargs)

    @classmethod
    async def _schedule_event(
        cls,
        event: Event,
        when: WhenType,
        *args: Any,
        **kwargs: Any,
    ) -> tuple[str, datetime | str | None]:
        """Serialize arguments, resolve schedule, and emit via NotitiaClient."""
        event_qualname = f"{cls.__module__}.{cls.__name__}.Event.{event.value}"

        # Determine if self should be serialized as an entity ID
        serialization_args = args
        if (
            len(args) > 0
            and isinstance(args[0], EventsBus)
            and hasattr(args[0], "id")
            and cls.resolve is not EventsBus.resolve
        ):
            # Replace self with its ID for serialization; resolve() will
            # reconstruct it on the webhook side.
            serialization_args = (str(args[0].id), *args[1:])

        signed_payload = cls._serializer.serialize(*serialization_args, **kwargs)

        execution_datetime = SchedulingResolver.resolve(when)

        invocation = ScheduledEventInvocation(
            event_qualname=event_qualname,
            signed_payload=signed_payload,
            execution_datetime_iso=(
                execution_datetime.isoformat()
                if isinstance(execution_datetime, datetime)
                else None
            ),
            recurrence_rule=(
                execution_datetime
                if isinstance(execution_datetime, str)
                else None
            ),
            original_emitter_timestamp_iso=datetime.now(timezone.utc).isoformat(),
        )

        queue = event.__notitia_queue__ if hasattr(event, "__notitia_queue__") else None
        job_id = await cls._client.emit(_BUS_EVENT_NAME, invocation, queue=queue)

        return job_id, execution_datetime
