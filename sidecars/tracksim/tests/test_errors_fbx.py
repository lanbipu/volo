from tracksim.domain.errors import FbxConversionError, TracksimError


def test_fbx_conversion_error_attrs():
    exc = FbxConversionError("boom", details={"k": "v"})
    assert isinstance(exc, TracksimError)
    assert exc.code == "FBX_CONVERSION_FAILED"
    assert exc.exit_code == 13
    assert exc.retryable is False
    assert exc.message == "boom"
    assert exc.details == {"k": "v"}
