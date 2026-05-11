import notitia


def test_package_imports():
    assert notitia.NotitiaError
    assert notitia.LowLevelClient
    assert notitia.NotitiaClientConfig
