import email.utils
import time

import httpx

from notitia.retry import _parse_rate_limit_headers, _parse_retry_after


def test_integer_seconds():
    assert _parse_retry_after("5") == 5.0


def test_float_seconds():
    assert _parse_retry_after("2.5") == 2.5


def test_zero():
    assert _parse_retry_after("0") == 0.0


def test_negative():
    assert _parse_retry_after("-3") == -3.0  # caller filters


def test_garbage_returns_none():
    assert _parse_retry_after("not a number or date") is None


def test_http_date_future():
    five_sec_future = time.time() + 5
    header = email.utils.formatdate(five_sec_future, usegmt=True)
    result = _parse_retry_after(header)
    assert result is not None
    assert 3.0 <= result <= 7.0


def test_http_date_past():
    five_sec_past = time.time() - 5
    header = email.utils.formatdate(five_sec_past, usegmt=True)
    result = _parse_retry_after(header)
    assert result is not None
    assert result < 0  # caller filters negatives


def test_whitespace_stripped():
    assert _parse_retry_after("  10  ") == 10.0


def _resp(headers: dict) -> httpx.Response:
    return httpx.Response(status_code=429, headers=headers)


def test_no_headers_returns_none():
    assert _parse_rate_limit_headers(_resp({})) is None


def test_retry_after_only():
    assert _parse_rate_limit_headers(_resp({"Retry-After": "5"})) == 5.0


def test_ratelimit_reset_only():
    assert _parse_rate_limit_headers(_resp({"RateLimit-Reset": "10"})) == 10.0


def test_x_ratelimit_reset_unix_timestamp():
    target = time.time() + 15
    result = _parse_rate_limit_headers(
        _resp({"X-RateLimit-Reset": str(int(target))})
    )
    assert result is not None
    assert 13.0 <= result <= 17.0


def test_max_across_multiple_headers():
    target = time.time() + 3
    result = _parse_rate_limit_headers(
        _resp(
            {
                "Retry-After": "5",
                "RateLimit-Reset": "20",
                "X-RateLimit-Reset": str(int(target)),
            }
        )
    )
    assert result == 20.0


def test_garbage_values_skipped():
    result = _parse_rate_limit_headers(
        _resp({"Retry-After": "garbage", "RateLimit-Reset": "8"})
    )
    assert result == 8.0


def test_negative_values_skipped():
    past = time.time() - 30
    result = _parse_rate_limit_headers(
        _resp({"X-RateLimit-Reset": str(int(past))})
    )
    assert result is None


def test_zero_values_skipped():
    assert _parse_rate_limit_headers(_resp({"Retry-After": "0"})) is None
