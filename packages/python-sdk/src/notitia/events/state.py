from datetime import datetime
from typing import Any, Optional, Protocol, runtime_checkable


@runtime_checkable
class StateTracker(Protocol):
    """Protocol for tracking scheduled event state on domain objects.

    Implement this to persist which events are scheduled, executed, or
    cancelled on your domain entities.  The default ``NoOpStateTracker``
    does nothing — use it when you don't need persistence.
    """

    async def on_event_scheduled(
        self,
        target: Any,
        event_name: str,
        job_id: str,
        when: Optional[datetime | str],
    ) -> None: ...

    async def on_event_executed(
        self,
        target: Any,
        event_name: str,
        job_id: str,
    ) -> None: ...

    async def on_event_cancelled(
        self,
        target: Any,
        event_name: str,
        job_id: str,
    ) -> None: ...

    async def get_scheduled_event_job_id(
        self,
        target: Any,
        event_name: str,
    ) -> Optional[str]: ...


class NoOpStateTracker:
    """Default state tracker that does nothing."""

    async def on_event_scheduled(
        self, target: Any, event_name: str, job_id: str, when: Any
    ) -> None:
        pass

    async def on_event_executed(
        self, target: Any, event_name: str, job_id: str
    ) -> None:
        pass

    async def on_event_cancelled(
        self, target: Any, event_name: str, job_id: str
    ) -> None:
        pass

    async def get_scheduled_event_job_id(
        self, target: Any, event_name: str
    ) -> Optional[str]:
        return None
