import math
import numpy as np
import pytest

from lmt_vba_sidecar.ipc import (
    CabinetArray, CabinetRect, CodeSpec, SequenceSpec,
    ShapePriorCurved, ShapePriorCurvedBody, StructuredLightDot, StructuredLightMeta,
)
from lmt_vba_sidecar.nominal import (
    nominal_dot_positions_world,
    nominal_cabinet_centers_model_frame,
    _cabinet_R_y_model,
)
from lmt_vba_sidecar.sl_geometry import sl_local_mm


def _meta(cabinets, dots, screen_res=(1080, 540)):
    return StructuredLightMeta(
        schema_version=1, screen_id="MAIN", screen_resolution=list(screen_res),
        dot_radius_px=4,
        code=CodeSpec(data_bits=8, total_bits=9),
        sequence=SequenceSpec(n_code_frames=9, hold_ms=100, fps=30),
        cabinets=cabinets, dots=dots,
    )


def test_flat_dot_is_center_plus_local_offset():
    # One flat cabinet (0,0), 500x500mm, 540x540px -> pitch ~0.9259 mm/px.
    cab = CabinetArray(cols=1, rows=1, cabinet_size_mm=[500.0, 500.0])
    rect = CabinetRect(col=0, row=0, input_rect_px=[0, 0, 540, 540], pixel_pitch_mm=[500.0/540, 500.0/540])
    # A dot at the cabinet pixel center (u,v)=(270,270) -> local (0,0,0).
    dot = StructuredLightDot(id=0, u=270.0, v=270.0, cabinet=[0, 0])
    meta = _meta([rect], [dot], screen_res=(540, 540))
    world = nominal_dot_positions_world(meta, cab, "flat")
    center = np.array(nominal_cabinet_centers_model_frame(cab, "flat")[(0, 0)])
    assert np.allclose(world[0], center, atol=1e-9)


def test_flat_offset_dot_matches_sl_local_mm_translation():
    # FIX-2: model frame is +y-UP (same as sl_local_mm's local frame), so for a
    # flat single cabinet R=I and world == center + RAW local — no sign flip
    # anywhere (the old +y-DOWN center grid forced a local-y negation here).
    cab = CabinetArray(cols=1, rows=1, cabinet_size_mm=[500.0, 500.0])
    rect = CabinetRect(col=0, row=0, input_rect_px=[0, 0, 540, 540], pixel_pitch_mm=[500.0/540, 500.0/540])
    dot = StructuredLightDot(id=7, u=400.0, v=120.0, cabinet=[0, 0])
    meta = _meta([rect], [dot], screen_res=(540, 540))
    world = nominal_dot_positions_world(meta, cab, "flat")
    center = np.array(nominal_cabinet_centers_model_frame(cab, "flat")[(0, 0)])
    local_m = sl_local_mm((0, 0, 540, 540), 400.0, 120.0, 500.0/540, 500.0/540) / 1000.0
    assert np.allclose(world[7], center + local_m, atol=1e-9)
    # The dot sits HIGH on the cabinet (v=120 of 540 -> upper part) => its world
    # y must be ABOVE the center (y-up; a y-down frame would put it below).
    assert world[7][1] > center[1]


def _rigid_residual_m(A: np.ndarray, B: np.ndarray) -> float:
    """RMS residual of the best rigid (rotation+translation, no scale) fit A->B."""
    ca, cb = A.mean(0), B.mean(0)
    Ac, Bc = A - ca, B - cb
    U, _s, Vt = np.linalg.svd(Ac.T @ Bc)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    R = Vt.T @ np.diag([1.0, 1.0, d]) @ U.T
    Aaln = (R @ Ac.T).T + cb
    return float(np.sqrt(((Aaln - B) ** 2).sum(1).mean()))


def test_multirow_flat_wall_is_rigid():
    # A 2-col x 3-row flat wall must be ONE rigid plane: all dots at z==0, world-y
    # monotonic with screen-v across the WHOLE wall (no per-cabinet sawtooth), and
    # a rigid fit to the true flat grid with ~0 residual. Pins FIX 1 (the local-y
    # sign reconciliation): the pre-fix composition made this a vertical sawtooth.
    px = 540
    cols, rows = 2, 3
    pitch = 500.0 / px
    cab = CabinetArray(cols=cols, rows=rows, cabinet_size_mm=[500.0, 500.0])
    rects, dots, did = [], [], 0
    for r in range(rows):
        for c in range(cols):
            rects.append(CabinetRect(col=c, row=r, input_rect_px=[c * px, r * px, px, px],
                                     pixel_pitch_mm=[pitch, pitch]))
            for i in range(3):
                for j in range(3):
                    u = c * px + (i + 0.5) * px / 3
                    v = r * px + (j + 0.5) * px / 3
                    dots.append(StructuredLightDot(id=did, u=float(u), v=float(v), cabinet=[c, r])); did += 1
    meta = _meta(rects, dots, screen_res=(cols * px, rows * px))
    world = nominal_dot_positions_world(meta, cab, "flat")
    W = np.array([world[d.id] for d in dots])
    # planar
    assert np.allclose(W[:, 2], 0.0, atol=1e-9)
    # world-y DECREASES as screen-v increases across the WHOLE wall (canvas v=0
    # is the displayed top; model frame is y-up) — rigid, no per-cabinet sawtooth
    order = np.argsort([d.v for d in dots], kind="stable")
    ys = W[order, 1]
    assert all(ys[k] >= ys[k + 1] - 1e-9 for k in range(len(ys) - 1))
    # EXACT (not just rigid-fit) match to the true y-up grid: world y == full
    # wall height minus v (in mm), x == u. Pins both rigidity AND the frame.
    true = np.array([[d.u * pitch / 1000.0, (rows * px - d.v) * pitch / 1000.0, 0.0]
                     for d in dots])
    assert np.allclose(W, true, atol=1e-9)
    assert _rigid_residual_m(W, true) < 1e-6


def test_curved_wall_is_continuous_across_cabinets():
    # Two dots 1px apart straddling the cab[0,0]/cab[1,0] boundary (same v) must be
    # <2mm apart in 3D for a continuous curved wall. Pins FIX 2 (R_y(-alpha)): the
    # pre-fix R_y(+alpha) tilted tiles the wrong way and opened a ~124mm gap here.
    px = 540
    cab = CabinetArray(cols=4, rows=1, cabinet_size_mm=[500.0, 500.0])
    shape = ShapePriorCurved(curved=ShapePriorCurvedBody(radius_mm=4000.0))
    rects = [CabinetRect(col=c, row=0, input_rect_px=[c * px, 0, px, px],
                         pixel_pitch_mm=[500.0 / px, 500.0 / px]) for c in range(4)]
    dots = [
        StructuredLightDot(id=0, u=539.5, v=270.0, cabinet=[0, 0]),
        StructuredLightDot(id=1, u=540.5, v=270.0, cabinet=[1, 0]),
    ]
    meta = _meta(rects, dots, screen_res=(4 * px, px))
    world = nominal_dot_positions_world(meta, cab, shape)
    gap_mm = float(np.linalg.norm(world[0] - world[1]) * 1000.0)
    assert gap_mm < 2.0, f"boundary discontinuity {gap_mm:.2f}mm (>= 2mm => wrong R_y sign)"


def test_curved_cabinet_dot_centroid_is_cabinet_center():
    # 3 cols curved; the centroid of a cabinet's dots == its nominal center,
    # and the dot-plane normal == the nominal normal (independent oracles).
    cab = CabinetArray(cols=3, rows=1, cabinet_size_mm=[500.0, 500.0])
    shape = ShapePriorCurved(curved=ShapePriorCurvedBody(radius_mm=4000.0))
    rects = [CabinetRect(col=c, row=0, input_rect_px=[c*540, 0, 540, 540], pixel_pitch_mm=[500.0/540, 500.0/540]) for c in range(3)]
    # 4 symmetric dots around each cabinet center -> centroid == center.
    dots, did = [], 0
    for c in range(3):
        for (u, v) in [(c*540+135, 135), (c*540+405, 135), (c*540+135, 405), (c*540+405, 405)]:
            dots.append(StructuredLightDot(id=did, u=float(u), v=float(v), cabinet=[c, 0])); did += 1
    meta = _meta(rects, dots, screen_res=(1620, 540))
    world = nominal_dot_positions_world(meta, cab, shape)
    centers = nominal_cabinet_centers_model_frame(cab, shape)
    for c in range(3):
        ids = [d.id for d in dots if d.cabinet == [c, 0]]
        pts = np.array([world[i] for i in ids])
        assert np.allclose(pts.mean(axis=0), np.array(centers[(c, 0)]), atol=1e-6)
        # Plane normal via SVD: smallest singular vector of centered points. The
        # dots are placed with the TILE rotation _cabinet_R_y_model = R_y(-alpha),
        # which since FIX-1 is also THE source of nominal_cabinet_normals_model_frame
        # (the old separate R_y(+alpha) normal formula was the mirror and is gone).
        u_, s_, vt = np.linalg.svd(pts - pts.mean(axis=0))
        n = vt[-1]
        tile_n = _cabinet_R_y_model(c, 0, cab, shape) @ np.array([0.0, 0.0, 1.0])
        assert abs(abs(np.dot(n, tile_n)) - 1.0) < 1e-6  # parallel (sign-free)
