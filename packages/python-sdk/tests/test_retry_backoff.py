from notitia.retry import RetryConfig, _backoff_delay


def test_none_jitter_attempt_1():
    cfg = RetryConfig(base_delay=0.5, max_delay=60.0, jitter="none")
    assert _backoff_delay(1, cfg) == 0.5


def test_none_jitter_attempt_3():
    cfg = RetryConfig(base_delay=0.5, max_delay=60.0, jitter="none")
    # 0.5 * 2 ** 2 = 2.0
    assert _backoff_delay(3, cfg) == 2.0


def test_none_jitter_caps_at_max_delay():
    cfg = RetryConfig(base_delay=10.0, max_delay=15.0, jitter="none")
    # 10 * 2 ** 5 = 320, capped at 15
    assert _backoff_delay(6, cfg) == 15.0


def test_equal_jitter_range():
    cfg = RetryConfig(base_delay=4.0, max_delay=60.0, jitter="equal")
    for _ in range(200):
        result = _backoff_delay(1, cfg)
        # base=4, capped=4, equal jitter -> [2, 4]
        assert 2.0 <= result <= 4.0


def test_full_jitter_range():
    cfg = RetryConfig(base_delay=4.0, max_delay=60.0, jitter="full")
    for _ in range(200):
        result = _backoff_delay(1, cfg)
        assert 0.0 <= result <= 4.0
