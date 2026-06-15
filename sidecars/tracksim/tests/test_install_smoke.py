from importlib.metadata import version

import tracksim


def test_package_importable_from_install():
    assert tracksim.__file__ is not None
    assert tracksim.__file__.endswith("__init__.py")


def test_distribution_version_matches():
    assert version("tracksim") == "0.1.0"
    assert version("tracksim") == tracksim.__version__
