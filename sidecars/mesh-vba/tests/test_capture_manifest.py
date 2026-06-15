"""Tests for capture_manifest loader (Task 1.3)."""
from pathlib import Path

import pytest

from lmt_vba_sidecar.capture_manifest import (
    CaptureManifestError,
    load_capture_manifest,
    manifest_from_images_dir,
)


def test_charuco_manifest_lists_views(tmp_path):
    (tmp_path / "a.png").write_bytes(b"x")
    (tmp_path / "b.png").write_bytes(b"x")
    mf = tmp_path / "capture.json"
    mf.write_text(
        '{"method":"charuco","intrinsics":"i.json","pattern_meta":"pm.json",'
        '"screen_mapping":"sm.json","views":[{"view_id":"c1","images":["a.png"]},'
        '{"view_id":"c2","images":["b.png"]}]}'
    )
    m = load_capture_manifest(str(mf))
    assert m.method == "charuco"
    assert [v.view_id for v in m.views] == ["c1", "c2"]


def test_relative_paths_resolved_to_absolute(tmp_path):
    """Relative paths in intrinsics/pattern_meta/screen_mapping/images become absolute."""
    mf = tmp_path / "capture.json"
    mf.write_text(
        '{"method":"charuco","intrinsics":"i.json","pattern_meta":"pm.json",'
        '"screen_mapping":"sm.json","views":[{"view_id":"v1","images":["img/a.png"]}]}'
    )
    m = load_capture_manifest(str(mf))
    # Compare against resolve()'d expectations since _resolve normalizes paths.
    base = tmp_path.resolve()
    assert m.intrinsics == str(base / "i.json")
    assert m.pattern_meta == str(base / "pm.json")
    assert m.screen_mapping == str(base / "sm.json")
    assert m.views[0].images[0] == str(base / "img" / "a.png")
    # No leftover relative segments — all absolute.
    assert Path(m.intrinsics).is_absolute()
    assert Path(m.views[0].images[0]).is_absolute()


def test_dotdot_segments_normalized(tmp_path):
    """'..' segments in relative paths are collapsed by resolve()."""
    sub = tmp_path / "sub"
    sub.mkdir()
    mf = sub / "capture.json"
    mf.write_text(
        '{"method":"charuco","intrinsics":"../i.json","pattern_meta":"pm.json",'
        '"screen_mapping":"sm.json","views":[{"view_id":"v1","images":["a.png"]}]}'
    )
    m = load_capture_manifest(str(mf))
    # ../i.json relative to sub/ collapses to tmp_path/i.json with no '..'.
    assert m.intrinsics == str((tmp_path / "i.json").resolve())
    assert ".." not in m.intrinsics


def test_absolute_paths_normalized(tmp_path):
    """Absolute paths are kept absolute (and normalized via resolve)."""
    mf = tmp_path / "capture.json"
    abs_img = tmp_path / "abs_image.png"
    mf.write_text(
        f'{{"method":"charuco","intrinsics":"/abs/i.json","pattern_meta":"/abs/pm.json",'
        f'"screen_mapping":"/abs/sm.json","views":[{{"view_id":"v1","images":["{abs_img}"]}}]}}'
    )
    m = load_capture_manifest(str(mf))
    assert Path(m.intrinsics).is_absolute()
    assert m.views[0].images[0] == str(abs_img.resolve())


def test_empty_views_raises(tmp_path):
    """A manifest with zero views raises CaptureManifestError."""
    mf = tmp_path / "capture.json"
    mf.write_text(
        '{"method":"charuco","intrinsics":"i.json","pattern_meta":"pm.json",'
        '"screen_mapping":"sm.json","views":[]}'
    )
    with pytest.raises(CaptureManifestError, match="at least one view"):
        load_capture_manifest(str(mf))


def test_charuco_view_no_images_raises(tmp_path):
    """charuco view with no images and no frames raises CaptureManifestError."""
    mf = tmp_path / "capture.json"
    mf.write_text(
        '{"method":"charuco","intrinsics":"i.json","pattern_meta":"pm.json",'
        '"screen_mapping":"sm.json","views":[{"view_id":"v1","images":[]}]}'
    )
    with pytest.raises(CaptureManifestError, match="no images and no frames"):
        load_capture_manifest(str(mf))


def test_missing_file_raises(tmp_path):
    """Missing manifest file raises CaptureManifestError."""
    with pytest.raises(CaptureManifestError, match="not found"):
        load_capture_manifest(str(tmp_path / "nonexistent.json"))


def test_bad_json_raises(tmp_path):
    """Malformed JSON raises CaptureManifestError."""
    mf = tmp_path / "capture.json"
    mf.write_text("{not valid json}")
    with pytest.raises(CaptureManifestError, match="Invalid JSON"):
        load_capture_manifest(str(mf))


def test_invalid_method_raises(tmp_path):
    """Unknown method value raises CaptureManifestError via pydantic validation."""
    mf = tmp_path / "capture.json"
    mf.write_text(
        '{"method":"unknown","intrinsics":"i.json","pattern_meta":"pm.json",'
        '"screen_mapping":"sm.json","views":[{"view_id":"v1","images":["a.png"]}]}'
    )
    with pytest.raises(CaptureManifestError, match="schema error"):
        load_capture_manifest(str(mf))


def test_frames_field_preserved(tmp_path):
    """Reserved 'frames' field on a view is preserved, with its path resolved."""
    mf = tmp_path / "capture.json"
    mf.write_text(
        '{"method":"structured-light","intrinsics":"i.json","pattern_meta":"pm.json",'
        '"screen_mapping":"sm.json","views":[{"view_id":"v1","images":[],'
        '"frames":[{"path":"f0.png","index":0}]}]}'
    )
    m = load_capture_manifest(str(mf))
    assert m.views[0].frames is not None
    assert m.views[0].frames[0]["index"] == 0
    # frame 'path' is resolved to an absolute path like image paths.
    assert Path(m.views[0].frames[0]["path"]).is_absolute()
    assert m.views[0].frames[0]["path"] == str((tmp_path / "f0.png").resolve())


def test_manifest_from_images_dir(tmp_path):
    """manifest_from_images_dir creates one view per image, sorted by stem."""
    (tmp_path / "cam_b.jpg").write_bytes(b"x")
    (tmp_path / "cam_a.png").write_bytes(b"x")
    (tmp_path / "readme.txt").write_bytes(b"x")  # should be ignored
    m = manifest_from_images_dir(
        str(tmp_path),
        method="charuco",
        intrinsics="/abs/i.json",
        pattern_meta="/abs/pm.json",
        screen_mapping="/abs/sm.json",
    )
    assert m.method == "charuco"
    stems = [v.view_id for v in m.views]
    # sorted: cam_a before cam_b
    assert stems == sorted(stems)
    # all views have absolute image paths
    for v in m.views:
        assert len(v.images) == 1
        assert Path(v.images[0]).is_absolute()
    # .txt is not included
    assert all("readme" not in v.view_id for v in m.views)


def test_manifest_from_empty_dir_raises(tmp_path):
    """A directory with no images raises rather than yielding a 0-view manifest."""
    (tmp_path / "readme.txt").write_bytes(b"x")
    with pytest.raises(CaptureManifestError, match="No image files found"):
        manifest_from_images_dir(
            str(tmp_path),
            method="charuco",
            intrinsics="/abs/i.json",
            pattern_meta="/abs/pm.json",
            screen_mapping="/abs/sm.json",
        )
