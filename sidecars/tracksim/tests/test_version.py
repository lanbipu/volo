import tracksim


def test_version_constant():
    assert tracksim.__version__ == "0.1.0"


def test_version_is_string():
    assert isinstance(tracksim.__version__, str)
