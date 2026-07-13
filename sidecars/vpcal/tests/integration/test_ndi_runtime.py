"""Optional smoke test for a real cyndilib runtime; no source is required."""

import pytest


def test_cyndilib_runtime_can_enumerate():
    pytest.importorskip("cyndilib")
    from vpcal.core.ndi import enumerate_sources

    assert isinstance(enumerate_sources(0.1), list)
