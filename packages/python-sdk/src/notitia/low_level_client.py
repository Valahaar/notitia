import asyncio
from json import JSONDecodeError
import httpx
from typing import Any, Awaitable, Callable, Optional
from dataclasses import asdict

from .types import NotitiaClientConfig
from .common_types import ScheduleRequest, HttpMethod, ScheduleType
from .retry import _compute_delay


class NotitiaError(Exception):
    """Represents an error that occurs during an SDK operation."""

    def __init__(
        self,
        message: str,
        status: Optional[int] = None,
        response_data: Optional[Any] = None,
        cause: Optional[Exception] = None,
    ):
        super().__init__(message)
        self.message = message
        self.status = status
        self.response_data = response_data
        self.cause = cause
        self.name = "NotitiaError"

    def __str__(self):
        return f"{self.name}: {self.message} (Status: {self.status})"


class LowLevelClient:
    """
    LowLevelClient provides a direct way to send `ScheduleRequest` objects
    to the Notification Service's /schedule endpoint asynchronously.
    """

    def __init__(self, config: NotitiaClientConfig):
        if not config.base_url:
            raise NotitiaError("base_url is required in NotificationClientConfig")

        self.base_url = config.base_url.rstrip("/")
        self.default_headers = {
            "Content-Type": "application/json",
            **(config.default_headers or {}),
        }
        self.default_queue = config.default_queue
        self._http_client = httpx.AsyncClient(
            headers=self.default_headers, timeout=config.timeout
        )
        self.retry_config = config.retry

    async def _send_with_retries(
        self,
        attempt_fn: Callable[[], Awaitable[httpx.Response]],
    ) -> httpx.Response:
        """Drive a retry loop around a single-attempt closure.

        Returns the final response — caller is responsible for interpreting
        status codes. Network errors raised by attempt_fn propagate."""
        cfg = self.retry_config
        response: httpx.Response | None = None
        for attempt in range(1, cfg.max_attempts + 1):
            response = await attempt_fn()

            if response.status_code not in cfg.retry_status_codes:
                return response
            if attempt == cfg.max_attempts:
                return response

            delay = _compute_delay(response, attempt, cfg)
            if delay is None:
                return response
            await asyncio.sleep(delay)

        assert response is not None  # loop runs at least once
        return response

    async def send_schedule_request(self, schedule_request: ScheduleRequest) -> str:
        """
        Sends a ScheduleRequest to the Notification Service's /schedule endpoint asynchronously.
        Returns: The jobId of the scheduled task.
        Raises: NotitiaError: If the request fails or the server returns a non-202 status.
        """
        url = f"{self.base_url}/schedule"

        # Prepare data by converting EmitRequestDto to dict and handling enums
        data = asdict(schedule_request)
        if data.get("method") and isinstance(data["method"], HttpMethod):
            data["method"] = data["method"].value
        if (
            data.get("schedule")
            and isinstance(data["schedule"], dict)
            and data["schedule"].get("type")
            and isinstance(data["schedule"]["type"], ScheduleType)
        ):
            data["schedule"]["type"] = data["schedule"]["type"].value

        # Filter out None values from the payload, as asdict includes them
        filtered_data = {k: v for k, v in data.items() if v is not None}
        if "schedule" in filtered_data and filtered_data["schedule"] is not None:
            filtered_data["schedule"] = {
                k: v for k, v in filtered_data["schedule"].items() if v is not None
            }

        if self.default_queue and not filtered_data.get("queue"):
            filtered_data["queue"] = self.default_queue

        async def _attempt() -> httpx.Response:
            return await self._http_client.post(url, json=filtered_data)

        try:
            response = await self._send_with_retries(_attempt)

            if response.status_code != 202:
                error_data: Any = None
                try:
                    error_data = response.json()
                except JSONDecodeError:
                    error_data = response.text
                raise NotitiaError(
                    message=f"Notification service returned an error: {response.status_code}",
                    status=response.status_code,
                    response_data=error_data,
                )
            # Parse the response to get the jobId
            response_data = response.json()
            job_id = response_data.get("jobId")
            if not job_id:
                raise NotitiaError(
                    message="No jobId found in response from notification service.",
                    status=response.status_code,
                    response_data=response_data,
                )
            return job_id
        except httpx.RequestError as e:
            raise NotitiaError(
                message=f"Failed to send emit request: {str(e)}", cause=e
            ) from e
        except JSONDecodeError as e:
            raise NotitiaError(
                message=f"Failed to send emit request: {str(e)}", cause=e
            ) from e

    async def close(self) -> None:
        """Closes the underlying HTTP client. Should be called when the client is no longer needed."""
        await self._http_client.aclose()

    async def cancel_scheduled_job(self, job_id: str, queue: Optional[str] = None) -> bool:
        """
        Sends a request to cancel a scheduled job by its ID.
        Args:
            job_id: The ID of the job to cancel.
        Returns: True if the cancellation request was successfully processed by the server, False otherwise.
        Raises: NotitiaError: If the request fails or the server returns an unexpected status.
        """
        url = f"{self.base_url}/schedule/{job_id}"
        if queue:
            url += f"?queue={queue}"
        try:
            response = await self._http_client.delete(url)

            if response.status_code == 200:
                try:
                    return response.json()  # Expects true or false
                except JSONDecodeError:
                    # If response is not JSON, but status is 200, this is unexpected.
                    # However, the endpoint spec says it returns boolean.
                    raise NotitiaError(
                        message=f"Failed to decode JSON response for cancel job, but status was 200. Response: {response.text}",
                        status=response.status_code,
                        response_data=response.text,
                    )
            elif response.status_code == 404:
                # As per docs, 404 can be treated as success for cancellation (job already gone)
                # The controller however returns boolean true/false.
                # For now, let's stick to what the controller returns for 200.
                # If a 404 specifically means "not found but cancellation is 'true'", API should return 200 true.
                # For now, treat non-200 as an issue or an unsuccessful cancellation from client's perspective.
                error_data: Any = None
                try:
                    error_data = response.json()
                except JSONDecodeError:
                    error_data = response.text
                raise NotitiaError(
                    message=f"Notification service returned an error for cancel job: {response.status_code}",
                    status=response.status_code,
                    response_data=error_data,
                )
            else:  # Any other non-200 status
                error_data: Any = None
                try:
                    error_data = response.json()
                except JSONDecodeError:
                    error_data = response.text
                raise NotitiaError(
                    message=f"Notification service returned an unexpected status for cancel job: {response.status_code}",
                    status=response.status_code,
                    response_data=error_data,
                )
        except httpx.RequestError as e:
            raise NotitiaError(
                message=f"Failed to send cancel schedule request for job {job_id}: {str(e)}",
                cause=e,
            ) from e
