from typing import Any, Generic, Optional

from .common_types import Schedule, ScheduleRequest, HttpMethod
from .types import (
    NotitiaClientConfig,
    EventDefinitions,
    PreparedEventData,
    EventNameT,
)
from .low_level_client import LowLevelClient, NotitiaError


class NotitiaClient(Generic[EventNameT]):
    """
    NotitiaClient provides a way to emit pre-defined events asynchronously.
    It uses a LowLevelClient internally for actual HTTP communication.
    """

    def __init__(
        self,
        event_definitions: EventDefinitions[EventNameT],
        config: NotitiaClientConfig = NotitiaClientConfig(),
    ):
        self._low_level_client = LowLevelClient(config)
        self._event_definitions: EventDefinitions[EventNameT] = event_definitions
        self._default_http_method: HttpMethod = HttpMethod.POST

    async def send(
        self,
        endpoint: str,
        queue: Optional[str] = None,
        schedule: Optional[Schedule] = None,
        method: HttpMethod = HttpMethod.POST,
        payload: Any = None,
        headers: Any = None,
        params: Any = None,
        timeout: Optional[int] = None,
    ) -> str:
        """
        Sends a request to the specified endpoint with the given method, payload, headers, and params.

        `timeout` is the max duration in seconds the target HTTP call may run
        (15–1800). Maps to the Cloud Tasks dispatch deadline on the GCP scheduler.
        """

        try:
            # The event_name is used to find the config (target, prepare function) but is not part of the ScheduleRequestDto itself.
            schedule_api_request = ScheduleRequest(
                target=endpoint,
                queue=queue,
                method=method,
                payload=payload,
                headers=headers,
                params=params,
                schedule=schedule,
                timeout=timeout,
            )
        except NotitiaError:  # Re-raise SDK errors directly
            raise
        except Exception as e:
            raise NotitiaError(
                message=f'Error during sending request to endpoint "{endpoint}": {str(e)}',
                cause=e,
            ) from e

        return await self._low_level_client.send_schedule_request(schedule_api_request)

    async def emit(
        self, event_name: EventNameT, data: Any, queue: Optional[str] = None
    ) -> str:
        """
        Emits a pre-defined event asynchronously.

        Args:
            event_name: The name of the event to emit.
            data: The single argument (often a dictionary or dataclass instance)
                  required by the event's `prepare` function.
            queue: The queue to use for the event. If not provided, the queue from the event config or the client config is used.

        Returns:
            The jobId of the scheduled task.

        Raises:
            NotitiaError: If the event name is not defined or if the underlying API call fails.
        """
        event_config = self._event_definitions.get(event_name)

        if not event_config:
            event_name_str = (
                str(event_name.value)
                if hasattr(event_name, "value")
                else str(event_name)
            )
            raise NotitiaError(
                f'Event "{event_name_str}" is not defined in the SDK event definitions.'
            )

        prepared_data: PreparedEventData = event_config.prepare(data)

        target_endpoint = prepared_data.target or event_config.target
        if not target_endpoint:
            event_name_str = (
                str(event_name.value)
                if hasattr(event_name, "value")
                else str(event_name)
            )
            raise NotitiaError(
                f'Target URL for event "{event_name_str}" is not defined in EventConfig or prepared data.'
            )

        return await self.send(
            endpoint=target_endpoint,
            schedule=prepared_data.schedule,
            queue=queue or prepared_data.queue,
            method=prepared_data.method
            or event_config.method
            or self._default_http_method,
            payload=prepared_data.payload,
            headers=prepared_data.headers,
            params=prepared_data.params,
            timeout=prepared_data.timeout,
        )

    async def cancel(self, job_id: str, queue: Optional[str] = None) -> bool:
        """
        Cancels a previously scheduled job using its ID.

        Args:
            job_id: The ID of the job to cancel.

        Returns:
            True if the cancellation was successfully processed, False otherwise.

        Raises:
            NotitiaError: If the underlying API call fails.
        """
        try:
            return await self._low_level_client.cancel_scheduled_job(job_id, queue)
        except NotitiaError:  # Re-raise SDK errors directly
            raise
        except Exception as e:  # Wrap other errors for consistency
            raise NotitiaError(
                message=f'Error during cancelling job "{job_id}" in queue "{queue}": {str(e)}',
                cause=e,
            ) from e

    @property
    def client(self) -> LowLevelClient:
        """
        Provides access to the underlying LowLevelClient for sending dynamic or ad-hoc event requests.
        """
        return self._low_level_client

    async def close(self) -> None:
        """Closes the underlying HTTP client. Should be called when the client is no longer needed."""
        await self._low_level_client.close()
