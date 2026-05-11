from unittest.mock import patch

import httpx
import pytest
import respx

from notitia.low_level_client import LowLevelClient, NotitiaError
from notitia.retry import RetryConfig
from notitia.types import NotitiaClientConfig


def _client(retry: RetryConfig | None = None) -> LowLevelClient:
    return LowLevelClient(
        NotitiaClientConfig(
            base_url="http://service",
            retry=retry or RetryConfig(jitter="none", base_delay=0.1),
        )
    )


@respx.mock
async def test_200_first_try():
    respx.delete("http://service/schedule/abc").mock(
        return_value=httpx.Response(200, json=True)
    )
    client = _client()

    with patch("asyncio.sleep") as sleep:
        result = await client.cancel_scheduled_job("abc")

    assert result is True
    sleep.assert_not_called()
    await client.close()


@respx.mock
async def test_429_then_200():
    respx.delete("http://service/schedule/abc").mock(
        side_effect=[
            httpx.Response(429),
            httpx.Response(200, json=True),
        ]
    )
    client = _client()

    with patch("asyncio.sleep") as sleep:
        result = await client.cancel_scheduled_job("abc")

    assert result is True
    assert sleep.await_count == 1
    await client.close()


@respx.mock
async def test_500_then_200():
    respx.delete("http://service/schedule/abc").mock(
        side_effect=[
            httpx.Response(500),
            httpx.Response(200, json=False),
        ]
    )
    client = _client()

    with patch("asyncio.sleep") as sleep:
        result = await client.cancel_scheduled_job("abc")

    assert result is False
    assert sleep.await_count == 1
    await client.close()


@respx.mock
async def test_429_exhausts_and_raises():
    respx.delete("http://service/schedule/abc").mock(
        return_value=httpx.Response(429)
    )
    client = _client(RetryConfig(max_attempts=3, jitter="none", base_delay=0.01))

    with patch("asyncio.sleep") as sleep:
        with pytest.raises(NotitiaError) as exc:
            await client.cancel_scheduled_job("abc")

    assert exc.value.status == 429
    assert sleep.await_count == 2
    await client.close()
