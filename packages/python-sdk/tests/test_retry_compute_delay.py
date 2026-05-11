import httpx

from notitia.retry import RetryConfig, _compute_delay


def _resp(status_code: int, headers: dict | None = None) -> httpx.Response:
    return httpx.Response(status_code=status_code, headers=headers or {})


def test_429_with_retry_after_uses_server_value():
    cfg = RetryConfig(jitter="none", base_delay=99.0, max_retry_after=60.0)
    assert _compute_delay(_resp(429, {"Retry-After": "5"}), 1, cfg) == 5.0


def test_429_with_retry_after_over_cap_returns_none():
    cfg = RetryConfig(max_retry_after=60.0)
    assert _compute_delay(_resp(429, {"Retry-After": "600"}), 1, cfg) is None


def test_429_at_exact_cap_is_honored():
    cfg = RetryConfig(max_retry_after=60.0)
    assert _compute_delay(_resp(429, {"Retry-After": "60"}), 1, cfg) == 60.0


def test_429_without_headers_uses_backoff():
    cfg = RetryConfig(jitter="none", base_delay=0.5)
    assert _compute_delay(_resp(429), 1, cfg) == 0.5


def test_5xx_ignores_headers_uses_backoff():
    cfg = RetryConfig(jitter="none", base_delay=0.5, max_retry_after=60.0)
    # Even with Retry-After present, 5xx uses backoff
    assert _compute_delay(_resp(503, {"Retry-After": "5"}), 1, cfg) == 0.5
