import pytest

from notitia.retry import RetryConfig


def test_defaults():
    cfg = RetryConfig()
    assert cfg.max_attempts == 5
    assert cfg.base_delay == 0.5
    assert cfg.max_delay == 60.0
    assert cfg.jitter == "equal"
    assert cfg.max_retry_after == 60.0
    assert cfg.retry_status_codes == frozenset({429, 500, 502, 503, 504})


def test_is_frozen():
    cfg = RetryConfig()
    with pytest.raises(Exception):
        cfg.max_attempts = 1  # type: ignore[misc]


def test_override_fields():
    cfg = RetryConfig(max_attempts=1, jitter="none")
    assert cfg.max_attempts == 1
    assert cfg.jitter == "none"
