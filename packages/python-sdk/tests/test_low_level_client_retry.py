from unittest.mock import patch

import httpx
import pytest

from notitia.low_level_client import LowLevelClient
from notitia.retry import RetryConfig
from notitia.types import NotitiaClientConfig


def _make_client(retry: RetryConfig | None = None) -> LowLevelClient:
    return LowLevelClient(
        NotitiaClientConfig(
            base_url="http://test", retry=retry or RetryConfig(jitter="none")
        )
    )


async def test_returns_first_response_when_status_not_retryable():
    client = _make_client()
    success = httpx.Response(status_code=202)

    async def attempt():
        return success

    with patch("asyncio.sleep") as sleep:
        result = await client._send_with_retries(attempt)

    assert result is success
    sleep.assert_not_called()
    await client.close()


async def test_returns_final_response_when_budget_exhausted():
    client = _make_client(RetryConfig(max_attempts=3, jitter="none", base_delay=0.1))
    responses = [
        httpx.Response(status_code=429),
        httpx.Response(status_code=429),
        httpx.Response(status_code=429),
    ]
    calls = iter(responses)

    async def attempt():
        return next(calls)

    with patch("asyncio.sleep") as sleep:
        result = await client._send_with_retries(attempt)

    assert result.status_code == 429
    assert sleep.await_count == 2  # 3 attempts -> 2 sleeps between them
    await client.close()


async def test_retries_until_success():
    client = _make_client(RetryConfig(max_attempts=5, jitter="none", base_delay=0.1))
    responses = [
        httpx.Response(status_code=429),
        httpx.Response(status_code=500),
        httpx.Response(status_code=202),
    ]
    calls = iter(responses)

    async def attempt():
        return next(calls)

    with patch("asyncio.sleep") as sleep:
        result = await client._send_with_retries(attempt)

    assert result.status_code == 202
    assert sleep.await_count == 2
    await client.close()


async def test_honors_retry_after_header():
    client = _make_client(RetryConfig(max_attempts=2, jitter="none"))

    async def attempt():
        return httpx.Response(status_code=429, headers={"Retry-After": "7"})

    with patch("asyncio.sleep") as sleep:
        await client._send_with_retries(attempt)

    sleep.assert_awaited_once_with(7.0)
    await client.close()


async def test_gives_up_when_retry_after_exceeds_cap():
    client = _make_client(
        RetryConfig(max_attempts=5, jitter="none", max_retry_after=60.0)
    )

    async def attempt():
        return httpx.Response(status_code=429, headers={"Retry-After": "600"})

    with patch("asyncio.sleep") as sleep:
        result = await client._send_with_retries(attempt)

    assert result.status_code == 429
    sleep.assert_not_called()
    await client.close()


async def test_max_attempts_one_disables_retries():
    client = _make_client(RetryConfig(max_attempts=1, jitter="none"))

    async def attempt():
        return httpx.Response(status_code=429)

    with patch("asyncio.sleep") as sleep:
        result = await client._send_with_retries(attempt)

    assert result.status_code == 429
    sleep.assert_not_called()
    await client.close()


async def test_network_error_not_caught_here():
    client = _make_client()

    async def attempt():
        raise httpx.ConnectError("boom")

    with patch("asyncio.sleep") as sleep:
        with pytest.raises(httpx.ConnectError):
            await client._send_with_retries(attempt)

    sleep.assert_not_called()
    await client.close()
