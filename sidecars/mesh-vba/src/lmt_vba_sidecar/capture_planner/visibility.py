"""Per-sample-point visibility and observability-gate-aligned coverage.

Visibility is judged PER POINT (cheirality, in-frame, incidence) — never by a
single cabinet-center test. Coverage then aggregates point visibility to the
real reconstruction gate (see gates.py): a camera 'covers' a cabinet only if it
sees >= MIN_PNP_CORNERS of its sample points (so that view could seed a PnP
pose); a cabinet is 'reconstructable' only with >= MIN_VIEWS covering cameras
and >= MIN_POINTS_PER_CABINET total observations. This is deliberately
conservative vs reconstruct's bare gate (which counts >=1-obs views).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from lmt_vba_sidecar.sl_feasibility import look_at_pose
from lmt_vba_sidecar.capture_planner import gates
from lmt_vba_sidecar.capture_planner.geometry import ScreenGeometry


@dataclass(frozen=True)
class Camera:
    K: np.ndarray          # (3,3)
    R: np.ndarray          # (3,3) world->cam
    t: np.ndarray          # (3,) world->cam
    image_size: tuple      # (W, H)


def intrinsics_from_fov(image_size, hfov_deg=None, vfov_deg=None) -> np.ndarray:
    """Build a pinhole K from FOV + sensor resolution. Centered principal point,
    square pixels, zero skew. Exactly one of hfov_deg / vfov_deg is required."""
    w, h = image_size
    if (hfov_deg is None) == (vfov_deg is None):
        raise ValueError("pass exactly one of hfov_deg / vfov_deg")
    if hfov_deg is not None:
        f = (w / 2.0) / np.tan(np.deg2rad(hfov_deg) / 2.0)
    else:
        f = (h / 2.0) / np.tan(np.deg2rad(vfov_deg) / 2.0)
    return np.array([[f, 0.0, w / 2.0], [0.0, f, h / 2.0], [0.0, 0.0, 1.0]], float)


def look_at_camera(K, cam_pos_mm, target_mm, image_size, up=None) -> Camera:
    R, t = look_at_pose(np.asarray(cam_pos_mm, float), np.asarray(target_mm, float), up)
    return Camera(np.asarray(K, float), R, t, tuple(image_size))


# FIX-16: 遮挡判定的米制净距。交点到目标点的 3D 距离 ≤ 此值视为"目标自身/
# 自家箱体的 mm 级矢高",不算遮挡。远大于矢高 u²/2R(500mm 箱体 @R=8m ≈ 3.9mm),
# 远小于真实遮挡时交点到目标的距离(跨箱体,百 mm 级)。
ARC_OCCLUSION_CLEARANCE_MM = 20.0


def _arc_occludes(arc, cam_center, p) -> bool:
    """True if the cylinder's near arc blocks the camera→point ray (check (d)).
    Solve segment↔circle in the XZ plane (cylinder axis vertical).

    FIX-16: 判据改为米制 —— 交点到目标点的 3D 距离必须超过
    [`ARC_OCCLUSION_CLEARANCE_MM`] 才算遮挡。旧的段长比例 epsilon
    (`t < 1 − 1e-3`)是站距的函数:箱体外侧采样点天然落在弧后方矢高 u²/2R
    处,命中 t ≈ 1 − O(矢高/段长),3m 与 8m 站距下同一面墙判定不同。
    另用墙体 y 范围([arc.y_min, arc.y_max])裁剪交点 —— 旧无限高圆柱把
    越过墙顶/墙底的视线误判为遮挡。"""
    cam3 = np.asarray(cam_center, float)
    q3 = np.asarray(p, float)
    px, pz = float(cam3[0]), float(cam3[2])
    qx, qz = float(q3[0]), float(q3[2])
    dx, dz = qx - px, qz - pz
    fx, fz = px - arc.cx, pz - arc.cz
    a = dx * dx + dz * dz
    if a < 1e-9:
        return False
    b = 2.0 * (fx * dx + fz * dz)
    c = fx * fx + fz * fz - arc.radius * arc.radius
    disc = b * b - 4.0 * a * c
    if disc <= 0.0:
        return False
    sq = math.sqrt(disc)
    for t in ((-b - sq) / (2.0 * a), (-b + sq) / (2.0 * a)):
        if not (0.0 < t < 1.0):
            continue
        pt3 = cam3 + t * (q3 - cam3)
        # 目标自身 / 同箱体矢高(mm 级)→ 不是遮挡。
        if float(np.linalg.norm(pt3 - q3)) <= ARC_OCCLUSION_CLEARANCE_MM:
            continue
        # 视线在交点处越过墙顶/墙底 → 物理上没有墙体可挡。
        if not (arc.y_min - 1e-6 <= pt3[1] <= arc.y_max + 1e-6):
            continue
        ang = math.atan2(pt3[0] - arc.cx, -(pt3[2] - arc.cz))
        if arc.a_min - 1e-6 <= ang <= arc.a_max + 1e-6:
            return True
    return False


def points_visible(cam: Camera, pts_mm, normal, *, margin_frac=0.05,
                   incidence_max_deg=60.0, arc=None) -> np.ndarray:
    """Vectorized visibility check for N points. Returns (N,) bool array."""
    pts = np.asarray(pts_mm, float)  # (N, 3)
    if pts.ndim == 1:
        pts = pts.reshape(1, 3)
    n = pts.shape[0]
    vis = np.ones(n, dtype=bool)
    # (a) cheirality
    p_cam = (cam.R @ pts.T).T + cam.t  # (N, 3)
    vis &= p_cam[:, 2] > 0.0
    # (b) in-frame
    proj = (cam.K @ p_cam.T).T  # (N, 3)
    u = proj[:, 0] / np.where(proj[:, 2] != 0, proj[:, 2], 1e-30)
    v = proj[:, 1] / np.where(proj[:, 2] != 0, proj[:, 2], 1e-30)
    w, h = cam.image_size
    mx, my = margin_frac * w, margin_frac * h
    vis &= (u >= mx) & (u <= w - mx) & (v >= my) & (v <= h - my)
    # (c) incidence
    cam_center = -cam.R.T @ cam.t
    to_cam = cam_center - pts  # (N, 3)
    nrm = np.asarray(normal, float)
    dots = to_cam @ nrm
    dists = np.linalg.norm(to_cam, axis=1)
    cos_inc = np.where(dists > 0, dots / dists, 0.0)
    vis &= cos_inc > 0.0
    cos_limit = np.cos(np.deg2rad(incidence_max_deg))
    vis &= cos_inc >= cos_limit
    # (d) self-occlusion (scalar fallback — geometry is complex)
    if arc is not None:
        for i in range(n):
            if vis[i] and _arc_occludes(arc, cam_center, pts[i]):
                vis[i] = False
    return vis


def point_visible(cam: Camera, p_mm, normal, *, margin_frac=0.05,
                  incidence_max_deg=60.0, arc=None) -> bool:
    return bool(points_visible(cam, np.asarray(p_mm, float).reshape(1, 3), normal,
                               margin_frac=margin_frac, incidence_max_deg=incidence_max_deg,
                               arc=arc)[0])


from lmt_vba_sidecar.capture_planner.geometry import CabinetGeom


@dataclass(frozen=True)
class CabinetCoverage:
    col: int
    row: int
    covering_cams: tuple        # cam indices with >= MIN_PNP_CORNERS visible points
    total_observations: int     # sum of visible points across covering cams
    reconstructable: bool       # >= MIN_VIEWS covering AND >= MIN_POINTS_PER_CABINET obs
    low_observation: bool       # reconstructable AND covering < QUALITY_MIN_VIEWS


def vis_count(cam: Camera, cabg: CabinetGeom, *, margin_frac=0.05,
              incidence_max_deg=60.0, arc=None) -> int:
    return int(points_visible(cam, np.array(cabg.sample_points_mm),
                              cabg.normal, margin_frac=margin_frac,
                              incidence_max_deg=incidence_max_deg, arc=arc).sum())


def coverage_report(geom: ScreenGeometry, cams: list[Camera], *, margin_frac=0.05,
                    incidence_max_deg=60.0, min_views=gates.MIN_VIEWS):
    """Return (per_cabinet: list[CabinetCoverage], counts: dict[(ci,(col,row))->int]).
    `counts` is the per-camera per-cabinet visible-point count, reused downstream
    (bridging, scoring). `min_views` (default gates.MIN_VIEWS) is the covering-view
    count a cabinet needs to be `reconstructable`; the precision profile raises it."""
    arc = geom.arc_occluder
    counts: dict[tuple[int, tuple[int, int]], int] = {}
    for ci, cam in enumerate(cams):
        for cabg in geom.cabinets:
            n = vis_count(cam, cabg, margin_frac=margin_frac,
                          incidence_max_deg=incidence_max_deg, arc=arc)
            if n:
                counts[(ci, (cabg.col, cabg.row))] = n

    per_cabinet: list[CabinetCoverage] = []
    for cabg in geom.cabinets:
        key = (cabg.col, cabg.row)
        covering = tuple(
            ci for ci in range(len(cams))
            if counts.get((ci, key), 0) >= gates.MIN_PNP_CORNERS
        )
        total_obs = sum(counts[(ci, key)] for ci in covering)
        reconstructable = (
            len(covering) >= min_views
            and total_obs >= gates.MIN_POINTS_PER_CABINET
        )
        low_obs = reconstructable and len(covering) < gates.QUALITY_MIN_VIEWS
        per_cabinet.append(
            CabinetCoverage(cabg.col, cabg.row, covering, total_obs,
                            reconstructable, low_obs)
        )
    return per_cabinet, counts


@dataclass(frozen=True)
class BridgingReport:
    n_components: int
    broken_edges: list           # [((col,row),(col,row)), ...] adjacent but unbridged
    components: list             # [[(col,row), ...], ...]


def bridging_report(geom: ScreenGeometry, cams: list[Camera], *, margin_frac=0.05,
                    incidence_max_deg=60.0, counts=None) -> BridgingReport:
    # `counts` is the per-(cam, cabinet) visible-point map from coverage_report.
    # Callers that already computed it (e.g. score_screen) pass it in to avoid a
    # second full visibility scan over the same cameras.
    if counts is None:
        _, counts = coverage_report(geom, cams, margin_frac=margin_frac,
                                    incidence_max_deg=incidence_max_deg)

    def covers(ci, key):
        return counts.get((ci, key), 0) >= gates.MIN_PNP_CORNERS

    present = {(c.col, c.row) for c in geom.cabinets}
    parent = {k: k for k in present}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        parent[find(a)] = find(b)

    broken: list = []
    for (col, row) in present:
        for (dc, dr) in ((1, 0), (0, 1)):            # right / up neighbours only
            nb = (col + dc, row + dr)
            if nb not in present:
                continue
            here = (col, row)
            shared = any(covers(ci, here) and covers(ci, nb) for ci in range(len(cams)))
            if shared:
                union(here, nb)
            else:
                broken.append((here, nb))

    roots: dict = {}
    for k in present:
        roots.setdefault(find(k), []).append(k)
    components = [sorted(v) for v in roots.values()]
    return BridgingReport(len(components), broken, components)
