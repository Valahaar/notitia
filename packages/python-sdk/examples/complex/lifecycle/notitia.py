from typing import Any, ClassVar, Literal, Optional, TypedDict, overload

from notitia import (
    EventConfig,
    EventDefinitions,
    HttpMethod,
    NotitiaClient,
    NotitiaClientConfig,
    OneTimeSchedule,
    PreparedEventData,
    RecurringSchedule,
)

from .event import ScheduledEventInvocation


class ProcessCallArgs(TypedDict):
    call_id: str
    force: bool


class ComputeViewArgs(TypedDict):
    call_id: str
    view_type: str


class Notitia:
    _client: ClassVar[Optional[NotitiaClient]] = None

    @staticmethod
    def _prepare_process_call(args: ProcessCallArgs) -> PreparedEventData:
        return PreparedEventData(params=args)

    @staticmethod
    def _prepare_compute_view(args: ComputeViewArgs) -> PreparedEventData:
        return PreparedEventData(payload=args)

    @staticmethod
    def _prepare_notitia_event(args: ScheduledEventInvocation) -> PreparedEventData:
        schedule = None
        if args.recurrence_rule:
            schedule = RecurringSchedule(schedule=args.recurrence_rule)
        elif args.execution_datetime_iso:
            schedule = OneTimeSchedule(time=args.execution_datetime_iso)

        return PreparedEventData(
            payload=args.model_dump(),
            schedule=schedule,
        )

    @classmethod
    def init(cls, backend_hostname: str, worker_endpoint: str, notitia_url: str):
        if cls._client is not None:
            raise RuntimeError("NotitiaConfig has already been initialized.")

        event_definitions: EventDefinitions[str] = {
            "notitia_event": EventConfig[ScheduledEventInvocation](
                target=f"{backend_hostname}/notitia/",
                prepare=cls._prepare_notitia_event,
                method=HttpMethod.POST,
            ),
            "compute_view": EventConfig[ComputeViewArgs](
                target=f"{worker_endpoint}/compute-view",
                prepare=cls._prepare_compute_view,
                method=HttpMethod.POST,
            ),
            # special event that needs to be sent to another endpoint
            "process_call": EventConfig[ProcessCallArgs](
                target=f"{worker_endpoint}/process",
                prepare=cls._prepare_process_call,
                method=HttpMethod.POST,
            ),
        }

        config = NotitiaClientConfig(base_url=notitia_url)
        cls._client = NotitiaClient(event_definitions, config)

    @classmethod
    def client(cls) -> NotitiaClient:
        if cls._client is None:
            raise RuntimeError("Notitia not initialized. Call Notitia.init() first.")
        return cls._client

    @overload
    @classmethod
    async def emit(
        cls,
        event_name: Literal["notitia_event"],
        data: ScheduledEventInvocation,
        queue: Optional[str] = None,
    ) -> None: ...

    @overload
    @classmethod
    async def emit(
        cls,
        event_name: Literal["compute_view"],
        data: ComputeViewArgs,
        queue: Optional[str] = None,
    ) -> None: ...

    @overload
    @classmethod
    async def emit(
        cls,
        event_name: Literal["process_call"],
        data: ProcessCallArgs,
        queue: Optional[str] = None,
    ) -> None: ...

    @classmethod
    async def emit(cls, event_name: str, data: Any, queue: Optional[str] = None) -> str:
        return await cls.client().emit(event_name, data, queue)
