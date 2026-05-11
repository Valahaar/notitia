import notitia


def test_package_imports():
    assert notitia.NotitiaError
    assert notitia.LowLevelClient
    assert notitia.NotitiaClientConfig


def test_retry_config_exported():
    assert notitia.RetryConfig
    cfg = notitia.RetryConfig()
    assert cfg.max_attempts == 5
