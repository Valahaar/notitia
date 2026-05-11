from unittest.mock import patch

import httpx
import pytest
import respx

from notitia.common_types import (
    HttpMethod,
    OneTimeSchedule,
    ScheduleRequest,
)
from notitia.low_level_client import LowLevelClient, NotitiaError
from notitia.retry import RetryConfig
from notitia.types import NotitiaClientConfig


def _request() -> ScheduleRequest:
    return ScheduleRequest(
        target="http://example.com/hook",
        method=HttpMethod.POST,
        payload={"hello": "world"},
        schedule=OneTimeSchedule(time="2099-01-01T00:00:00Z"),
    )


def _client(retry: RetryConfig | None = None) -> LowLevelClient:
    return LowLevelClient(
        NotitiaClientConfig(
            base_url="http://service",
            retry=retry or RetryConfig(jitter="none", base_delay=0.1),
        )
    )


@respx.mock
async def test_202_first_try():
    respx.post("http://service/schedule").mock(
        return_value=httpx.Response(202, json={"jobId": "job-1"})
    )
    client = _client()

    with patch("asyncio.sleep") as sleep:
        job_id = await client.send_schedule_request(_request())

    assert job_id == "job-1"
    sleep.assert_not_called()
    await client.close()


@respx.mock
async def test_429_then_202():
    respx.post("http://service/schedule").mock(
        side_effect=[
            httpx.Response(429),
            httpx.Response(202, json={"jobId": "job-2"}),
        ]
    )
    client = _client()

    with patch("asyncio.sleep") as sleep:
        job_id = await client.send_schedule_request(_request())

    assert job_id == "job-2"
    assert sleep.await_count == 1
    await client.close()


@respx.mock
async def test_500_then_202():
    respx.post("http://service/schedule").mock(
        side_effect=[
            httpx.Response(500),
            httpx.Response(202, json={"jobId": "job-3"}),
        ]
    )
    client = _client()

    with patch("asyncio.sleep") as sleep:
        job_id = await client.send_schedule_request(_request())

    assert job_id == "job-3"
    assert sleep.await_count == 1
    await client.close()


@respx.mock
async def test_retry_after_2_sleeps_exactly_2():
    respx.post("http://service/schedule").mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "2"}),
            httpx.Response(202, json={"jobId": "job-4"}),
        ]
    )
    client = _client()

    with patch("asyncio.sleep") as sleep:
        await client.send_schedule_request(_request())

    sleep.assert_awaited_once_with(2.0)
    await client.close()


@respx.mock
async def test_retry_after_over_cap_raises_immediately():
    respx.post("http://service/schedule").mock(
        return_value=httpx.Response(429, headers={"Retry-After": "600"})
    )
    client = _client(RetryConfig(max_attempts=5, jitter="none", max_retry_after=60.0))

    with patch("asyncio.sleep") as sleep:
        with pytest.raises(NotitiaError) as exc:
            await client.send_schedule_request(_request())

    assert exc.value.status == 429
    sleep.assert_not_called()
    await client.close()


@respx.mock
async def test_429_exhausts_budget_and_raises():
    respx.post("http://service/schedule").mock(
        return_value=httpx.Response(429, json={"error": "rate limited"})
    )
    client = _client(RetryConfig(max_attempts=5, jitter="none", base_delay=0.01))

    with patch("asyncio.sleep") as sleep:
        with pytest.raises(NotitiaError) as exc:
            await client.send_schedule_request(_request())

    assert exc.value.status == 429
    assert sleep.await_count == 4
    await client.close()


@respx.mock
async def test_max_attempts_one_no_retry():
    respx.post("http://service/schedule").mock(
        return_value=httpx.Response(429)
    )
    client = _client(RetryConfig(max_attempts=1, jitter="none"))

    with patch("asyncio.sleep") as sleep:
        with pytest.raises(NotitiaError):
            await client.send_schedule_request(_request())

    sleep.assert_not_called()
    await client.close()


@respx.mock
async def test_connect_error_raises_immediately():
    respx.post("http://service/schedule").mock(
        side_effect=httpx.ConnectError("nope")
    )
    client = _client()

    with patch("asyncio.sleep") as sleep:
        with pytest.raises(NotitiaError):
            await client.send_schedule_request(_request())

    sleep.assert_not_called()
    await client.close()
