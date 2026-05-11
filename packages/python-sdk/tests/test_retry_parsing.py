import email.utils
import time

from notitia.retry import _parse_retry_after


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
