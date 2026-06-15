"""Synthetic dataset generator (spec §8).

Implements the forward model of the §5.1.4 chain to produce ground-truth-known
data: camera poses, tracker SDK output, exact marker reprojections, optional
pixel noise/outliers, and (optionally) rendered camera images.  Used to verify
solver correctness end-to-end.

Coordinate convention for generated data: tracking is emitted in the internal
right-hand frame and the session declares ``coordinate_system = "vicon"`` (a
right-hand passthrough), so the pipeline's conversion is the identity and the
screen stays in its native UE frame.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from vpcal.core.coordinates import m_rh_from_source
from vpcal.core.observations import MarkerId, Observation
from vpcal.core.projection import CameraIntrinsics
from vpcal.core.screen_geometry import DEFAULT_MARKERS_PER_CABINET, ScreenMarker, enumerate_markers
from vpcal.core.transforms import (
    apply_transform,
    compose,
    invert_transform,
    make_transform,
    matrix_to_quat,
    quat_multiply,
    quat_to_matrix,
    stage_to_camera_transform,
)
from vpcal.models.lens import BrownConradyDistortion, LensProfile
from vpcal.models.screen import ScreenDefinition

Array = NDArray[np.float64]
_M_UE = m_rh_from_source("unreal")  # 4x4 diag(1,-1,1)


@dataclass
class GroundTruth:
    tracker_to_stage_q: list[float]
    tracker_to_stage_t: list[float]
    camera_from_tracker_q: list[float]
    camera_from_tracker_t: list[float]


@dataclass
class SimulatorConfig:
    """Bundled simulator parameters incl. the B1 error-source knobs.

    Field ④ (``bake_dot_screen_space``) and the tracking corruptions ①–③
    (``tracker_noise_*``, ``temporal_offset_frames``, ``handeye_perturbation``)
    are the error sources the sensitivity sweep walks (docs/error-budget.md).
    """

    num_poses: int = 10
    noise_px: float = 0.0
    outlier_ratio: float = 0.0
    seed: int = 0
    render_images: bool = False
    # ① tracker pose noise
    tracker_noise_mm: float = 0.0
    tracker_noise_deg: float = 0.0
    # ② image↔tracking timing mis-alignment (needs trajectory=True)
    temporal_offset_frames: float = 0.0
    # ③ reported-vs-true hand-eye offset (rotation_deg, translation_mm)
    handeye_perturbation: tuple[float, float] | None = None
    # ④ screen-space dot bake (vs the bias-free analytic splat)
    bake_dot_screen_space: bool = True
    # smooth camera sweep (required for a meaningful temporal offset)
    trajectory: bool = False
    # write a validation block so the pipeline reports an independent RMS
    holdout_ratio: float | None = None


def _look_at(eye: Array, target: Array, world_up: Array = np.array([0.0, 0.0, 1.0])) -> Array:
    """Camera-in-stage pose ``T_S_from_C`` (OpenCV cam: +Z fwd, +X right, +Y down)."""
    forward = target - eye
    forward = forward / (np.linalg.norm(forward) or 1.0)
    right = np.cross(world_up, forward)
    nr = np.linalg.norm(right)
    if nr < 1e-9:
        right = np.array([1.0, 0.0, 0.0])
    else:
        right = right / nr
    down = np.cross(forward, right)
    R = np.column_stack([right, down, forward])
    T = np.eye(4)
    T[:3, :3] = R
    T[:3, 3] = eye
    return T


def screen_center_rh(screen: ScreenDefinition) -> Array:
    """Centroid of the screen's markers in the right-hand internal frame."""
    pts = np.array([_M_UE[:3, :3] @ np.asarray(m.world) for m in enumerate_markers(screen)])
    return pts.mean(axis=0)


def generate_camera_poses(
    screen: ScreenDefinition, num_poses: int, rng: np.random.Generator
) -> list[Array]:
    """Generate ``num_poses`` camera-in-stage poses looking at the screen."""
    markers = np.array(
        [_M_UE[:3, :3] @ np.asarray(m.world) for m in enumerate_markers(screen, markers_per_cabinet=screen.markers_per_cabinet)]
    )
    center = markers.mean(axis=0)
    # PCA (full 3x3 basis): tangent_u/_v span the screen, normal is the standoff
    # direction.  full_matrices=True guarantees a complete 3D basis even when the
    # marker cloud is rank-deficient (e.g. a single planar cabinet).
    _u, s, vt = np.linalg.svd(markers - center, full_matrices=True)
    tangent_u, tangent_v, normal = vt[0], vt[1], vt[2]
    in_plane_extent = float(2.0 * s[0] / np.sqrt(max(len(markers) - 1, 1)))
    radius = max(in_plane_extent * 0.9, 1500.0)
    # Orient the normal toward the side most markers face (more in front of camera).
    if _front_count(markers, center + radius * normal, center) < _front_count(
        markers, center - radius * normal, center
    ):
        normal = -normal

    poses = []
    for _ in range(num_poses):
        depth = radius * (1.0 + rng.uniform(-0.1, 0.1))
        lateral = rng.uniform(-0.35, 0.35) * in_plane_extent
        vertical = rng.uniform(-0.25, 0.25) * in_plane_extent
        eye = center + depth * normal + lateral * tangent_u + vertical * tangent_v
        target = center + rng.uniform(-0.1, 0.1, size=3) * in_plane_extent
        poses.append(_look_at(eye, target))
    return poses


def _front_count(markers: Array, eye: Array, target: Array) -> int:
    """Count markers in front of a camera at ``eye`` looking at ``target``."""
    fwd = target - eye
    fwd = fwd / (np.linalg.norm(fwd) or 1.0)
    return int(np.sum((markers - eye) @ fwd > 0))


def generate_trajectory_poses(
    screen: ScreenDefinition, num_poses: int, rng: np.random.Generator
) -> list[Array]:
    """A *smooth, temporally-ordered* camera sweep across the screen front.

    Unlike :func:`generate_camera_poses` (independent random standpoints), these
    poses lie on a continuous path so that a fractional temporal offset between
    image and tracking can be interpolated meaningfully — the basis for the
    moving-capture timing study (error-budget B3).
    """
    markers = np.array(
        [_M_UE[:3, :3] @ np.asarray(m.world) for m in enumerate_markers(screen, markers_per_cabinet=screen.markers_per_cabinet)]
    )
    center = markers.mean(axis=0)
    _u, s, vt = np.linalg.svd(markers - center, full_matrices=True)
    tangent_u, tangent_v, normal = vt[0], vt[1], vt[2]
    in_plane_extent = float(2.0 * s[0] / np.sqrt(max(len(markers) - 1, 1)))
    radius = max(in_plane_extent * 0.9, 1500.0)
    if _front_count(markers, center + radius * normal, center) < _front_count(
        markers, center - radius * normal, center
    ):
        normal = -normal

    phase0 = float(rng.uniform(0.0, 2.0 * np.pi))
    poses = []
    for k in range(num_poses):
        u = (k / max(num_poses - 1, 1)) - 0.5  # -0.5 → +0.5 sweep
        lateral = 0.6 * u * in_plane_extent
        vertical = 0.12 * np.sin(phase0 + 2.0 * np.pi * u) * in_plane_extent
        depth = radius * (1.0 + 0.05 * np.cos(phase0 + np.pi * u))
        eye = center + depth * normal + lateral * tangent_u + vertical * tangent_v
        target = center + 0.05 * u * in_plane_extent * tangent_u
        poses.append(_look_at(eye, target))
    return poses


def _slerp(q0: Array, q1: Array, frac: float) -> Array:
    """Spherical-linear interpolation between unit quaternions (w,x,y,z)."""
    q0 = q0 / np.linalg.norm(q0)
    q1 = q1 / np.linalg.norm(q1)
    dot = float(np.dot(q0, q1))
    if dot < 0.0:  # take the shorter arc
        q1 = -q1
        dot = -dot
    if dot > 0.9995:  # nearly parallel → linear blend
        q = q0 + frac * (q1 - q0)
        return q / np.linalg.norm(q)
    theta = np.arccos(np.clip(dot, -1.0, 1.0))
    s0 = np.sin((1.0 - frac) * theta) / np.sin(theta)
    s1 = np.sin(frac * theta) / np.sin(theta)
    return s0 * q0 + s1 * q1


def _interp_camera_pose(camera_poses: list[Array], idx: float) -> Array:
    """Interpolate the camera-in-stage pose ``T_S_from_C`` at fractional ``idx``.

    The index is clamped to ``[0, n-1]``, so the last ``ceil(offset)`` frames of a
    forward temporal offset clamp to the final pose and contribute zero timing
    error — the reported per-cell mean is therefore a (slightly conservative) mix
    of offset-corrupted interior frames and uncorrupted clamped edge frames.
    """
    n = len(camera_poses)
    idx = float(np.clip(idx, 0.0, n - 1))
    i0 = int(np.floor(idx))
    i1 = min(i0 + 1, n - 1)
    frac = idx - i0
    if i0 == i1 or frac == 0.0:
        return camera_poses[i0]
    q = _slerp(matrix_to_quat(camera_poses[i0][:3, :3]), matrix_to_quat(camera_poses[i1][:3, :3]), frac)
    t = (1.0 - frac) * camera_poses[i0][:3, 3] + frac * camera_poses[i1][:3, 3]
    T = np.eye(4)
    T[:3, :3] = quat_to_matrix(q)
    T[:3, 3] = t
    return T


def _perturb_tracker_pose(
    q: Array, t: Array, noise_mm: float, noise_deg: float, rng: np.random.Generator
) -> tuple[Array, Array]:
    """Add Gaussian translation/rotation noise to a reported tracker pose."""
    t_noisy = np.asarray(t, dtype=np.float64).copy()
    if noise_mm > 0.0:
        t_noisy = t_noisy + rng.normal(0.0, noise_mm, size=3)
    q_noisy = np.asarray(q, dtype=np.float64)
    if noise_deg > 0.0:
        axis = rng.normal(size=3)
        axis /= np.linalg.norm(axis) or 1.0
        angle = np.radians(rng.normal(0.0, noise_deg))
        dq = np.array([np.cos(angle / 2.0), *(np.sin(angle / 2.0) * axis)])
        q_noisy = quat_multiply(dq, q_noisy)
        q_noisy = q_noisy / np.linalg.norm(q_noisy)
    return q_noisy, t_noisy


def forward_observations(
    screen: ScreenDefinition,
    intr: CameraIntrinsics,
    gt: GroundTruth,
    camera_poses: list[Array],
    *,
    markers_per_cabinet: int = DEFAULT_MARKERS_PER_CABINET,
    noise_px: float = 0.0,
    outlier_ratio: float = 0.0,
    rng: np.random.Generator | None = None,
    ground_truth_intr: CameraIntrinsics | None = None,
    tracker_noise_mm: float = 0.0,
    tracker_noise_deg: float = 0.0,
    temporal_offset_frames: float = 0.0,
) -> tuple[list[Observation], list[tuple[Array, Array]], dict]:
    """Project all markers for each pose into exact (+ optional noisy) pixels.

    Returns ``(observations, tracker_poses, visibility)`` where ``tracker_poses``
    are the per-frame SDK outputs ``(q, t)`` (internal RH frame) and
    ``visibility`` maps frame_id → list of (MarkerId, [u, v]) for rendering.

    When ``ground_truth_intr`` is given, pixels are projected with *that* lens
    (a lens differing from the nominal ``intr`` the solver will be handed) so
    Quick Lens Estimate recovery can be tested (QLE spec §9).

    Error-budget knobs (B1) corrupt only the *reported* tracker pose, never the
    pixels (which always reflect the true geometry):
      * ``tracker_noise_mm`` / ``tracker_noise_deg`` — Gaussian noise on T_sdk;
      * ``temporal_offset_frames`` — the tracker reports the pose sampled at
        ``frame_id + offset`` along the (interpolated) camera path, modelling
        image↔tracking mis-synchronisation.  Meaningful only for a smooth
        trajectory; for independent static standpoints leave it at 0.
    """
    rng = rng or np.random.default_rng(0)
    proj_intr = ground_truth_intr or intr
    T_S_from_O = make_transform(gt.tracker_to_stage_q, gt.tracker_to_stage_t)
    T_C_from_B = make_transform(gt.camera_from_tracker_q, gt.camera_from_tracker_t)

    markers: list[ScreenMarker] = enumerate_markers(screen, markers_per_cabinet=markers_per_cabinet)
    world_rh = np.array([_M_UE[:3, :3] @ np.asarray(m.world) for m in markers])

    observations: list[Observation] = []
    tracker_poses: list[tuple[Array, Array]] = []
    visibility: dict[int, list] = {}

    w, h = _intr_image_size(proj_intr)
    inv_T_S_from_O = invert_transform(T_S_from_O)
    for frame_id, T_S_from_C in enumerate(camera_poses):
        # TRUE tracker pose for this camera placement (spec §5.1.4) — drives the
        # pixels: T_sdk = inv(T_S_from_O) · T_S_from_C · T_C_from_B
        T_sdk = compose(inv_T_S_from_O, T_S_from_C, T_C_from_B)

        # REPORTED tracker pose — what the solver is handed.  A temporal offset
        # samples the camera path elsewhere; tracker noise perturbs the result.
        if temporal_offset_frames != 0.0:
            sampled = _interp_camera_pose(camera_poses, frame_id + temporal_offset_frames)
            T_sdk_report = compose(inv_T_S_from_O, sampled, T_C_from_B)
        else:
            T_sdk_report = T_sdk
        q_rep = matrix_to_quat(T_sdk_report[:3, :3])
        t_rep = T_sdk_report[:3, 3].copy()
        if tracker_noise_mm > 0.0 or tracker_noise_deg > 0.0:
            q_rep, t_rep = _perturb_tracker_pose(q_rep, t_rep, tracker_noise_mm, tracker_noise_deg, rng)
        q_sdk, t_sdk = q_rep, t_rep
        tracker_poses.append((q_sdk, t_sdk))

        T_C_from_S = stage_to_camera_transform(T_S_from_O, T_sdk, T_C_from_B)
        cam_pts = apply_transform(T_C_from_S, world_rh)
        vis_list = []
        for i, marker in enumerate(markers):
            pc = cam_pts[i]
            if pc[2] <= 1.0:  # behind camera
                continue
            uv = _project_one(pc, proj_intr)
            if not (0 <= uv[0] < w and 0 <= uv[1] < h):
                continue
            noisy = uv.copy()
            if noise_px > 0:
                noisy = uv + rng.normal(0.0, noise_px, size=2)
            if outlier_ratio > 0 and rng.random() < outlier_ratio:
                noisy = np.array([rng.uniform(0, w), rng.uniform(0, h)])
            observations.append(
                Observation(
                    pixel_u=float(noisy[0]),
                    pixel_v=float(noisy[1]),
                    world_rh=tuple(world_rh[i]),
                    track_q=tuple(q_sdk),
                    track_t=tuple(t_sdk),
                    frame_id=frame_id,
                    marker_id=marker.marker_id,
                )
            )
            vis_list.append((marker.marker_id, uv))
        visibility[frame_id] = vis_list
    return observations, tracker_poses, visibility


def _intr_image_size(intr: CameraIntrinsics) -> tuple[float, float]:
    return intr.image_size


def _project_one(pc: Array, intr: CameraIntrinsics) -> Array:
    from vpcal.core.projection import project_point

    return project_point(pc, intr)


def random_ground_truth(rng: np.random.Generator, *, identity: bool = False) -> GroundTruth:
    """A random (or identity) ground-truth transform pair."""
    if identity:
        return GroundTruth([1, 0, 0, 0], [0, 0, 0], [1, 0, 0, 0], [0, 0, 0])
    axis = rng.normal(size=3)
    axis /= np.linalg.norm(axis)
    angle = rng.uniform(-0.5, 0.5)
    q = [np.cos(angle / 2), *(np.sin(angle / 2) * axis)]
    t = rng.uniform(-500, 500, size=3).tolist()
    return GroundTruth(list(q), list(t), [1, 0, 0, 0], [0, 0, 0])


def default_lens(image_width: int = 1920, image_height: int = 1080) -> LensProfile:
    """A reasonable default lens for synthetic datasets."""
    return LensProfile(
        focal_length_mm=24.0,
        sensor_width_mm=36.0,
        sensor_height_mm=24.0,
        principal_point_offset_mm=(0.0, 0.0),
        image_width_px=image_width,
        image_height_px=image_height,
        distortion=BrownConradyDistortion(),
    )


def marker_size_mm(screen: ScreenDefinition, markers_per_cabinet: int) -> float:
    """Physical marker edge length: a fraction of the per-marker sub-cell.

    With markers_per_cabinet == 1 (cell-centred layout), use 90% fill to
    maximise screen utilisation while keeping a 10% dark gap between
    adjacent markers (ported from LED Mesh Toolkit DEFAULT_MARKER_FILL).

    With >1 marker per cabinet the cabinet is split 2×2, so markers shrink
    to avoid overlapping their neighbours.
    """
    if markers_per_cabinet <= 1:
        return 0.9 * min(screen.cabinet_size)
    return 0.55 * min(screen.cabinet_size) / 2


def _marker_corner_uv(
    screen: ScreenDefinition, marker: ScreenMarker, markers_per_cabinet: int
) -> list[tuple[float, float]]:
    """Marker quad corners in section UV (TL, TR, BR, BL), preserving handedness."""
    section = screen.section_by_name(marker.section_name)
    size = marker_size_mm(screen, markers_per_cabinet)
    hu = 0.5 * size / section.u_extent_mm()
    hv = 0.5 * size / section.v_extent_mm()
    u, v = marker.u, marker.v
    return [(u - hu, v + hv), (u + hu, v + hv), (u + hu, v - hv), (u - hu, v - hv)]


def render_frame(
    screen: ScreenDefinition,
    intr: CameraIntrinsics,
    gt: GroundTruth,
    tracker_pose: tuple[Array, Array],
    *,
    markers_per_cabinet: int = DEFAULT_MARKERS_PER_CABINET,
    template_px: int = 96,
    bake_dot_screen_space: bool = True,
) -> NDArray[np.uint8]:
    """Render one synthetic camera image of the marker field (spec §8.3).

    With ``bake_dot_screen_space`` (default, B1④) the locator dot is baked into
    the screen-space marker template and pushed through the full perspective
    warp, so the detected centroid carries the true screen-space dot's
    perspective bias.  Setting it False restores the legacy shortcut (an
    analytic Gaussian splatted at the projected centre), which is bias-free and
    therefore *unrealistically* clean.
    """
    import cv2

    from vpcal.core.pattern import build_marker_template, encode_marker, splat_gaussian_dot

    iw, ih = intr.image_size
    w, h = int(round(iw)), int(round(ih))
    image = np.zeros((h, w), dtype=np.uint8)
    T_S_from_O = make_transform(gt.tracker_to_stage_q, gt.tracker_to_stage_t)
    T_C_from_B = make_transform(gt.camera_from_tracker_q, gt.camera_from_tracker_t)
    T_sdk = make_transform(tracker_pose[0], tracker_pose[1])
    T_C_from_S = stage_to_camera_transform(T_S_from_O, T_sdk, T_C_from_B)

    src = np.array([[0, 0], [template_px - 1, 0], [template_px - 1, template_px - 1], [0, template_px - 1]], np.float32)
    for marker in enumerate_markers(screen, markers_per_cabinet=markers_per_cabinet):
        section = screen.section_by_name(marker.section_name)
        corners_uv = _marker_corner_uv(screen, marker, markers_per_cabinet)
        world = np.array([_M_UE[:3, :3] @ section.uv_to_world(*uv) for uv in corners_uv])
        cam = apply_transform(T_C_from_S, world)
        if np.any(cam[:, 2] <= 1.0):
            continue
        px = np.array([_project_one(c, intr) for c in cam], dtype=np.float32)
        if px[:, 0].min() < -50 or px[:, 0].max() > w + 50 or px[:, 1].min() < -50 or px[:, 1].max() > h + 50:
            continue
        side = np.linalg.norm(px[0] - px[1]) + np.linalg.norm(px[1] - px[2])
        if side < 40:  # too small to be detectable
            continue
        tmpl = build_marker_template(
            encode_marker(marker.marker_id), template_px, bake_dot=bake_dot_screen_space
        )
        H = cv2.getPerspectiveTransform(src, px)
        warped = cv2.warpPerspective(tmpl, H, (w, h))
        mask = warped > 0
        image[mask] = warped[mask]
        if not bake_dot_screen_space:
            # Legacy shortcut: analytic dot at the projected centre (no bias).
            center_world = _M_UE[:3, :3] @ section.uv_to_world(marker.u, marker.v)
            cc = _project_one(apply_transform(T_C_from_S, center_world), intr)
            splat_gaussian_dot(image, float(cc[0]), float(cc[1]), sigma=max(2.0, side / 60.0))
    return image


def simulate_dataset(
    screen: ScreenDefinition,
    out_dir: str | Path,
    *,
    num_poses: int = 10,
    noise_px: float = 0.0,
    outlier_ratio: float = 0.0,
    lens: LensProfile | None = None,
    markers_per_cabinet: int | None = None,
    seed: int = 0,
    render_images: bool = True,
    ground_truth_lens: LensProfile | None = None,
    handeye_perturbation: tuple[float, float] | None = None,
    tracker_noise_mm: float = 0.0,
    tracker_noise_deg: float = 0.0,
    temporal_offset_frames: float = 0.0,
    trajectory: bool = False,
    bake_dot_screen_space: bool = True,
    holdout_ratio: float | None = None,
) -> dict:
    """Generate a full synthetic session on disk (spec §8.3).

    Writes session.json, screen/wall.json, tracking/poses.jsonl, captures/normal
    PNGs, an exact ``observations.jsonl`` (ground-truth correspondences) and
    ``ground_truth.json``.  Returns a summary dict.

    ``handeye_perturbation`` = ``(rotation_deg, translation_mm)`` sets a
    non-identity ground-truth ``T_C_from_B`` while the session keeps the
    (identity) default prior — modelling a rig whose reported hand-eye differs
    from reality (error-budget item B1③; the A3 acceptance tests depend on it).

    Error-budget knobs (B1): ``tracker_noise_mm`` / ``tracker_noise_deg`` add
    Gaussian noise to the reported tracker poses; ``temporal_offset_frames``
    mis-aligns tracking vs image (only meaningful with ``trajectory=True``, a
    smooth camera sweep); ``bake_dot_screen_space`` renders the locator dot
    through the full projection chain (vs the legacy bias-free splat shortcut);
    ``holdout_ratio`` writes a ``validation`` block so the pipeline reports an
    independent validation RMS.
    """
    import cv2

    from vpcal.io.screen_io import save_screen
    from vpcal.io.tracking_io import write_tracking
    from vpcal.models.tracking import RotationData, RotationOrder, TrackingFrame

    out = Path(out_dir)
    (out / "captures" / "normal").mkdir(parents=True, exist_ok=True)
    (out / "tracking").mkdir(parents=True, exist_ok=True)
    (out / "screen").mkdir(parents=True, exist_ok=True)

    lens = lens or default_lens()
    # Marker layout comes from the screen (the shared artifact) so simulate,
    # pattern generation and the solve-stage lookup stay in lockstep.
    mpc = markers_per_cabinet if markers_per_cabinet is not None else screen.markers_per_cabinet
    intr = CameraIntrinsics.from_lens(lens)
    # When a ground-truth lens differs from the (nominal) session lens, pixels are
    # baked with it so Quick Lens Estimate recovery can be exercised end-to-end.
    gt_intr = CameraIntrinsics.from_lens(ground_truth_lens) if ground_truth_lens else None
    rng = np.random.default_rng(seed)
    gt = random_ground_truth(rng)
    if handeye_perturbation is not None:
        rot_deg, trans_mm = handeye_perturbation
        axis = rng.normal(size=3)
        axis /= np.linalg.norm(axis)
        half = np.radians(rot_deg) / 2.0
        gt.camera_from_tracker_q = [float(np.cos(half)), *(float(x) for x in np.sin(half) * axis)]
        t_dir = rng.normal(size=3)
        t_dir /= np.linalg.norm(t_dir)
        gt.camera_from_tracker_t = [float(x) for x in trans_mm * t_dir]
    poses = (
        generate_trajectory_poses(screen, num_poses, rng)
        if trajectory
        else generate_camera_poses(screen, num_poses, rng)
    )
    # A temporal offset is only physical on a smooth trajectory (moving capture).
    # For independent static holds the camera is stationary between the image and
    # tracker samples, so any offset induces no geometric error — model it as 0.
    eff_offset = temporal_offset_frames if trajectory else 0.0
    if temporal_offset_frames != 0.0 and not trajectory:
        import warnings
        warnings.warn(
            "temporal_offset_frames ignored without trajectory=True (static holds "
            "are timing-immune by construction)", stacklevel=2,
        )
    observations, tracker_poses, visibility = forward_observations(
        screen, intr, gt, poses, markers_per_cabinet=mpc,
        noise_px=noise_px, outlier_ratio=outlier_ratio, rng=rng,
        ground_truth_intr=gt_intr,
        tracker_noise_mm=tracker_noise_mm, tracker_noise_deg=tracker_noise_deg,
        temporal_offset_frames=eff_offset,
    )

    # tracking (internal RH frame → session declares coordinate_system "vicon")
    frames = []
    for fid, (q, t) in enumerate(tracker_poses):
        frames.append(
            TrackingFrame(
                frame_id=fid, timestamp_s=fid / 30.0, position=[float(x) for x in t],
                rotation=RotationData(order=RotationOrder.QUATERNION, values=[float(x) for x in q]),
                confidence=1.0,
            )
        )
    write_tracking(frames, out / "tracking" / "poses.jsonl")
    save_screen(screen, out / "screen" / "wall.json")

    # exact observations sidecar (used by quick run on synthetic data)
    with (out / "observations.jsonl").open("w") as fh:
        for o in observations:
            fh.write(json.dumps({
                "frame_id": o.frame_id,
                "marker_id": o.marker_id.to_dict(),
                "pixel_u": o.pixel_u,
                "pixel_v": o.pixel_v,
                "confidence": 1.0,
            }) + "\n")

    if render_images:
        # Render from the TRUE per-frame pose (recomputed from the camera path),
        # NOT the reported tracker pose written to poses.jsonl — otherwise tracker
        # noise / temporal offset would warp the rendered markers away from the
        # exact pixels in observations.jsonl (pixels must reflect true geometry).
        T_S_from_O = make_transform(gt.tracker_to_stage_q, gt.tracker_to_stage_t)
        T_C_from_B = make_transform(gt.camera_from_tracker_q, gt.camera_from_tracker_t)
        inv_T_S_from_O = invert_transform(T_S_from_O)
        for fid, T_S_from_C in enumerate(poses):
            T_sdk_true = compose(inv_T_S_from_O, T_S_from_C, T_C_from_B)
            tp_true = (matrix_to_quat(T_sdk_true[:3, :3]), T_sdk_true[:3, 3].copy())
            img = render_frame(
                screen, intr, gt, tp_true, markers_per_cabinet=mpc,
                bake_dot_screen_space=bake_dot_screen_space,
            )
            cv2.imwrite(str(out / "captures" / "normal" / f"{fid:04d}.png"), img)

    session = {
        "images": {"path": "./captures/", "format": "png"},
        "tracking": {"path": "./tracking/poses.jsonl", "coordinate_system": "vicon", "frame_matching": "frame_id"},
        "screen": {"path": "./screen/wall.json"},
        "lens": lens.model_dump(mode="json", exclude={"fx", "fy", "cx", "cy"}),
        "solver": {"refine_tracker_to_camera": False, "robust_loss": "huber", "robust_loss_scale": 1.0,
                   "max_iterations": 200, "timeout_seconds": 300},
        "capture_mode": "legacy",
        # Provenance marker: synthetic dataset where observations.jsonl and
        # rendered captures legitimately coexist (the pipeline rejects that
        # combination for real captures, D5).
        "_simulator": {
            "render_images": render_images, "noise_px": noise_px,
            "tracker_noise_mm": tracker_noise_mm, "tracker_noise_deg": tracker_noise_deg,
            "temporal_offset_frames": temporal_offset_frames, "trajectory": trajectory,
        },
    }
    if holdout_ratio is not None:
        if not (0.0 < holdout_ratio < 1.0):
            raise ValueError(f"holdout_ratio must be in (0, 1), got {holdout_ratio}")
        session["validation"] = {"holdout_ratio": holdout_ratio}
    (out / "session.json").write_text(json.dumps(session, indent=2))

    gt_doc = {
        "tracker_to_stage": {"rotation": gt.tracker_to_stage_q, "translation": gt.tracker_to_stage_t},
        "camera_from_tracker": {"rotation": gt.camera_from_tracker_q, "translation": gt.camera_from_tracker_t},
        "num_poses": num_poses,
        "num_observations": len(observations),
        "noise_px": noise_px,
        "outlier_ratio": outlier_ratio,
    }
    if ground_truth_lens is not None:
        gt_doc["ground_truth_lens"] = ground_truth_lens.model_dump(
            mode="json", exclude={"fx", "fy", "cx", "cy"}
        )
    (out / "ground_truth.json").write_text(json.dumps(gt_doc, indent=2))

    return {
        "output_dir": str(out),
        "num_poses": num_poses,
        "num_observations": len(observations),
        "ground_truth": gt_doc["tracker_to_stage"],
    }


def simulate_from_config(
    screen: ScreenDefinition,
    out_dir: str | Path,
    config: SimulatorConfig,
    *,
    lens: LensProfile | None = None,
    markers_per_cabinet: int | None = None,
    ground_truth_lens: LensProfile | None = None,
) -> dict:
    """Run :func:`simulate_dataset` from a :class:`SimulatorConfig` bundle."""
    return simulate_dataset(
        screen, out_dir,
        num_poses=config.num_poses, noise_px=config.noise_px,
        outlier_ratio=config.outlier_ratio, lens=lens,
        markers_per_cabinet=markers_per_cabinet, seed=config.seed,
        render_images=config.render_images, ground_truth_lens=ground_truth_lens,
        handeye_perturbation=config.handeye_perturbation,
        tracker_noise_mm=config.tracker_noise_mm, tracker_noise_deg=config.tracker_noise_deg,
        temporal_offset_frames=config.temporal_offset_frames,
        trajectory=config.trajectory, bake_dot_screen_space=config.bake_dot_screen_space,
        holdout_ratio=config.holdout_ratio,
    )
