"""Unit tests for the marker map model + operations (plan Phase A/B)."""

from __future__ import annotations

import numpy as np
import pytest

from vpcal.core.errors import ArgumentError, PreconditionError
from vpcal.core.marker_map import (
    fit_ground_plane,
    physical_world_map,
    rebase_to_ground,
    validate_marker_map,
    world_alignment_uncertainty,
)
from vpcal.core.observations import PhysicalMarkerId, marker_id_from_dict
from vpcal.io.marker_map_io import marker_map_from_csv
from vpcal.models.marker_map import MarkerMapDefinition, SurveyedMarker


def _wall_marker(tid: int, x: float, z: float, **kw) -> SurveyedMarker:
    return SurveyedMarker(
        marker_id=f"AT_36h11_{tid}",
        marker_type="apriltag",
        dictionary="DICT_APRILTAG_36h11",
        tag_id=tid,
        center_stage_mm=[x, 0.0, z],
        size_mm=200.0,
        normal=[0.0, -1.0, 0.0],
        **kw,
    )


def _grid_map(**map_kw) -> MarkerMapDefinition:
    markers = [
        _wall_marker(i * 3 + j, x=j * 600.0, z=800.0 + i * 500.0)
        for i in range(2)
        for j in range(3)
    ]
    return MarkerMapDefinition(frame_name="test RH Z-up", markers=markers, **map_kw)


# ── model geometry ───────────────────────────────────────────────────


def test_resolved_corners_orientation_convention():
    m = _wall_marker(0, x=0.0, z=1000.0)
    corners = m.resolved_corners()
    c = np.array([0.0, 0.0, 1000.0])
    # normal -Y faces the viewer; up = +Z projected; right = up × n = +X.
    np.testing.assert_allclose(corners[0], c + [-100, 0, 100])   # TL = c + h·up − h·right
    np.testing.assert_allclose(corners[1], c + [100, 0, 100])    # TR
    np.testing.assert_allclose(corners[2], c + [100, 0, -100])   # BR
    np.testing.assert_allclose(corners[3], c + [-100, 0, -100])  # BL


def test_corner_and_center_forms_equivalent():
    derived = _wall_marker(0, x=100.0, z=900.0)
    explicit = SurveyedMarker(
        marker_id="AT_36h11_0",
        marker_type="apriltag",
        dictionary="DICT_APRILTAG_36h11",
        corners_stage_mm=[[float(x) for x in c] for c in derived.resolved_corners()],
    )
    np.testing.assert_allclose(explicit.resolved_corners(), derived.resolved_corners())
    np.testing.assert_allclose(explicit.resolved_center(), derived.resolved_center())


def test_horizontal_marker_up_fallback():
    m = SurveyedMarker(
        marker_id="AT_36h11_9", marker_type="apriltag",
        dictionary="DICT_APRILTAG_36h11",
        center_stage_mm=[0.0, 0.0, 0.0], size_mm=200.0, normal=[0.0, 0.0, 1.0],
    )
    corners = m.resolved_corners()
    # up_hint falls back to +X: TL = c + h·X − h·right, right = X × Z... = up × n = -Y? →
    # just check the quad is planar in Z=0 and 200mm sided.
    assert np.allclose(corners[:, 2], 0.0)
    assert np.isclose(np.linalg.norm(corners[0] - corners[1]), 200.0)


def test_missing_geometry_rejected():
    with pytest.raises(ValueError, match="corners_stage_mm"):
        SurveyedMarker(
            marker_id="AT_36h11_1", marker_type="apriltag",
            dictionary="DICT_APRILTAG_36h11", center_stage_mm=[0, 0, 0],
        )


def test_tag_id_fallback_from_marker_id():
    m = _wall_marker(7, 0.0, 0.0)
    assert m.resolved_tag_id() == 7
    m2 = m.model_copy(update={"tag_id": None})
    assert m2.resolved_tag_id() == 7  # trailing integer of "AT_36h11_7"


# ── world map + marker id dispatch ───────────────────────────────────


def test_physical_world_map_four_corners_per_quad():
    world = physical_world_map(_grid_map())
    assert len(world) == 6 * 4
    key = PhysicalMarkerId("AT_36h11_0", 0)
    assert key in world


def test_marker_id_from_dict_dispatch():
    phys = marker_id_from_dict({"marker": "AT_36h11_3", "corner": 2})
    assert isinstance(phys, PhysicalMarkerId) and phys.corner == 2
    qsp = marker_id_from_dict({"screen_id": 0, "cab_col": 1, "cab_row": 2, "local_id": 3})
    assert qsp.cab_col == 1


# ── validation degeneracy (plan A4) ──────────────────────────────────


def test_validate_ok():
    report = validate_marker_map(_grid_map())
    assert report["passed"] and report["num_detectable"] == 6


def test_validate_rejects_too_few_points():
    mm = MarkerMapDefinition(
        frame_name="f",
        markers=[SurveyedMarker(marker_id="P_1", marker_type="point", center_stage_mm=[0, 0, 0])],
    )
    with pytest.raises(PreconditionError, match="correspondence points"):
        validate_marker_map(mm)


def test_validate_rejects_collinear():
    markers = [
        SurveyedMarker(marker_id=f"P_{i}", marker_type="point", center_stage_mm=[i * 100.0, 0, 0])
        for i in range(8)
    ]
    mm = MarkerMapDefinition(frame_name="f", markers=markers)
    with pytest.raises(PreconditionError, match="collinear"):
        validate_marker_map(mm)


def test_validate_rejects_duplicate_ids():
    mm = _grid_map()
    mm.markers[1] = mm.markers[1].model_copy(update={"marker_id": mm.markers[0].marker_id})
    with pytest.raises(PreconditionError, match="duplicate"):
        validate_marker_map(mm)


def test_validate_rejects_duplicate_dictionary_tag():
    # Distinct marker_ids resolving to the same (dictionary, tag_id) would let
    # the detector bind one tag's pixels to the wrong 3D geometry.
    mm = _grid_map()
    mm.markers[1] = mm.markers[1].model_copy(
        update={"marker_id": "AT_dup", "tag_id": mm.markers[0].resolved_tag_id()}
    )
    with pytest.raises(PreconditionError, match="cannot tell them"):
        validate_marker_map(mm)


def test_validate_requires_detectable_marker():
    markers = [
        SurveyedMarker(marker_id=f"P_{i}", marker_type="point",
                       center_stage_mm=[(i % 3) * 100.0, (i // 3) * 100.0, 0])
        for i in range(9)
    ]
    mm = MarkerMapDefinition(frame_name="f", markers=markers)
    with pytest.raises(PreconditionError, match="detectable"):
        validate_marker_map(mm)


# ── ground plane (plan B2) ───────────────────────────────────────────


def _ground_map(*, tilt_deg: float = 0.0, noise_mm: float = 0.0, seed: int = 0):
    rng = np.random.default_rng(seed)
    markers = list(_grid_map().markers)
    tilt = np.radians(tilt_deg)
    tid = 100
    for gx in range(3):
        for gy in range(2):
            x, y = gx * 800.0, -400.0 - gy * 800.0
            z = x * np.tan(tilt) + (rng.normal(0.0, noise_mm) if noise_mm else 0.0)
            markers.append(SurveyedMarker(
                marker_id=f"AT_36h11_{tid}", marker_type="apriltag",
                dictionary="DICT_APRILTAG_36h11", tag_id=tid,
                center_stage_mm=[x, y, float(z)], size_mm=200.0,
                normal=[0.0, 0.0, 1.0], on_ground=True,
            ))
            tid += 1
    return MarkerMapDefinition(frame_name="f", markers=markers)


def test_ground_plane_noise_residual_reported():
    fit = fit_ground_plane(_ground_map(noise_mm=2.0), tolerance_mm=50.0, tolerance_deg=45.0)
    assert fit["available"]
    assert 0.3 < fit["residual_rms_mm"] < 6.0
    assert fit["warnings"] == []


def test_ground_plane_tilt_warning():
    fit = fit_ground_plane(_ground_map(tilt_deg=1.0))
    assert fit["available"]
    assert fit["tilt_from_z_deg"] == pytest.approx(1.0, abs=0.05)
    assert fit["warnings"], "1° tilt must trigger the ground warning (default 0.2°)"


def test_ground_plane_needs_three_noncollinear():
    mm = _grid_map()  # no on_ground markers
    fit = fit_ground_plane(mm)
    assert not fit["available"]


def test_rebase_to_ground_flattens_and_audits():
    mm = _ground_map(tilt_deg=1.0)
    rebased, audit = rebase_to_ground(mm)
    fit = fit_ground_plane(rebased)
    assert fit["tilt_from_z_deg"] == pytest.approx(0.0, abs=1e-6)
    assert abs(fit["offset_from_z0_mm"]) < 1e-6
    assert len(rebased.rebase_history) == 1
    assert audit["tilt_corrected_deg"] == pytest.approx(1.0, abs=0.05)


def test_rebase_preserves_geometry():
    # The rebase moves only the frame definition: pairwise point distances are
    # invariant, so reprojection residuals of any solve are unchanged.
    mm = _ground_map(tilt_deg=1.0)
    rebased, _ = rebase_to_ground(mm)
    before = np.array(list(physical_world_map(mm).values()))
    after = np.array(list(physical_world_map(rebased).values()))
    d_before = np.linalg.norm(before[None, :, :] - before[:, None, :], axis=-1)
    d_after = np.linalg.norm(after[None, :, :] - after[:, None, :], axis=-1)
    np.testing.assert_allclose(d_after, d_before, atol=1e-9)


# ── world-alignment uncertainty (plan B3) ────────────────────────────


def test_world_alignment_na_without_declared_uncertainty():
    summary = world_alignment_uncertainty(_grid_map())
    assert summary["grade"] == "n/a"
    assert summary["max_uncertainty_mm"] is None


def test_world_alignment_grades_from_declared():
    mm = _grid_map()
    mm.markers[0] = mm.markers[0].model_copy(
        update={"uncertainty_mm": 0.5, "survey_source": "total_station"}
    )
    summary = world_alignment_uncertainty(mm)
    assert summary["grade"] == "millimetre"
    assert summary["by_source"]["total_station"]["max_uncertainty_mm"] == 0.5
    assert summary["markers_without_uncertainty"] == 5


# ── CSV import (plan A3/B1) ──────────────────────────────────────────


def test_csv_rich_layout(tmp_path):
    csv = tmp_path / "survey.csv"
    lines = ["marker_id,marker_type,dictionary,tag_id,point,x,y,z,on_ground,size_mm,uncertainty_mm,survey_source"]
    base = _wall_marker(0, 0.0, 1000.0).resolved_corners()
    for k, pt in enumerate(("c1", "c2", "c3", "c4")):
        x, y, z = base[k]
        lines.append(f"AT_36h11_0,apriltag,DICT_APRILTAG_36h11,0,{pt},{x},{y},{z},0,200,0.5,total_station")
    lines.append("AT_36h11_1,apriltag,DICT_APRILTAG_36h11,1,center,600,0,1000,1,200,0.5,total_station")
    csv.write_text("\n".join(lines) + "\n")
    with pytest.raises(ArgumentError, match="center_stage_mm|size_mm|normal"):
        # the centre-form row lacks a normal → model validation must reject
        marker_map_from_csv(csv, frame_name="f")


def test_csv_rich_layout_with_normal(tmp_path):
    csv = tmp_path / "survey.csv"
    lines = [
        "marker_id,marker_type,dictionary,tag_id,point,x,y,z,on_ground,size_mm,"
        "uncertainty_mm,survey_source,normal_x,normal_y,normal_z"
    ]
    base = _wall_marker(0, 0.0, 1000.0).resolved_corners()
    for k, pt in enumerate(("c1", "c2", "c3", "c4")):
        x, y, z = base[k]
        lines.append(f"AT_36h11_0,apriltag,DICT_APRILTAG_36h11,0,{pt},{x},{y},{z},0,200,0.5,total_station,,,")
    lines.append(
        "AT_36h11_1,apriltag,DICT_APRILTAG_36h11,1,center,600,0,1000,1,200,0.5,total_station,0,-1,0"
    )
    csv.write_text("\n".join(lines) + "\n")
    mm = marker_map_from_csv(csv, frame_name="f")
    assert len(mm.markers) == 2
    m0 = mm.marker_by_id("AT_36h11_0")
    np.testing.assert_allclose(m0.resolved_corners(), base)
    m1 = mm.marker_by_id("AT_36h11_1")
    assert m1.on_ground and m1.uncertainty_mm == 0.5


def test_csv_total_station_layout(tmp_path):
    csv = tmp_path / "survey.csv"
    base = _wall_marker(0, 0.0, 1000.0).resolved_corners()
    note = "type=apriltag dict=DICT_APRILTAG_36h11 tag=0 size=200 sigma=0.5 src=total_station"
    lines = ["name,x,y,z,note"]
    for k, pt in enumerate(("c1", "c2", "c3", "c4")):
        x, y, z = base[k]
        lines.append(f"AT_36h11_0#{pt},{x},{y},{z},{note}")
    csv.write_text("\n".join(lines) + "\n")
    mm = marker_map_from_csv(csv, frame_name="f")
    m = mm.marker_by_id("AT_36h11_0")
    assert m.survey_source == "total_station" and m.uncertainty_mm == 0.5
    np.testing.assert_allclose(m.resolved_corners(), base)


def test_csv_incomplete_corners_rejected(tmp_path):
    csv = tmp_path / "survey.csv"
    csv.write_text(
        "marker_id,marker_type,dictionary,tag_id,point,x,y,z\n"
        "AT_36h11_0,apriltag,DICT_APRILTAG_36h11,0,c1,0,0,0\n"
        "AT_36h11_0,apriltag,DICT_APRILTAG_36h11,0,c2,100,0,0\n"
    )
    with pytest.raises(ArgumentError, match="corner rows"):
        marker_map_from_csv(csv, frame_name="f")
