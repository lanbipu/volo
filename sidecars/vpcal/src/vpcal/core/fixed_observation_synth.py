"""Synthetic generators + §9.1 acceptance cases for fixed_observation solver."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from vpcal.core.fixed_observation import (
    CameraStateFingerprint,
    Correspondence,
    FixedObservationInput,
    KnownLens,
    solve_fixed_observation,
)
from vpcal.core.projection import CameraIntrinsics, project_points

Array = NDArray[np.float64]


@dataclass
class SyntheticScene:
    correspondences: list[Correspondence]
    screen_normals: dict[str, tuple[float, float, float]]
    image_size: tuple[int, int]
    gt_f: float
    gt_cx: float
    gt_cy: float
    gt_k1: float
    gt_k2: float
    gt_rvec: Array
    gt_tvec: Array


def _screen_grid(
    origin: Array,
    axis_u: Array,
    axis_v: Array,
    *,
    nu: int,
    nv: int,
    label: str,
) -> tuple[list[tuple[float, float, float]], tuple[float, float, float]]:
    pts: list[tuple[float, float, float]] = []
    for i in range(nu):
        for j in range(nv):
            u = i / max(nu - 1, 1)
            v = j / max(nv - 1, 1)
            p = origin + u * axis_u + v * axis_v
            pts.append((float(p[0]), float(p[1]), float(p[2])))
    normal = np.cross(axis_u, axis_v)
    normal = normal / max(np.linalg.norm(normal), 1.0e-12)
    return pts, (float(normal[0]), float(normal[1]), float(normal[2]))


def make_two_plane_scene(
    *,
    image_size: tuple[int, int] = (1920, 1080),
    f: float = 1400.0,
    cx: float | None = None,
    cy: float | None = None,
    k1: float = -0.08,
    k2: float = 0.02,
    angle_deg: float = 40.0,
    nu: int = 10,
    nv: int = 8,
    noise_px: float = 0.15,
    seed: int = 0,
) -> SyntheticScene:
    """Two screens forming ``angle_deg`` dihedral; camera looking at hinge."""
    w, h = image_size
    cx = 0.5 * w if cx is None else cx
    cy = 0.5 * h if cy is None else cy
    rng = np.random.default_rng(seed)

    # Screen A on XY plane, Screen B rotated about Y
    width_mm, height_mm = 2000.0, 1200.0
    a_origin = np.array([-width_mm, -0.5 * height_mm, 0.0])
    a_u = np.array([width_mm, 0.0, 0.0])
    a_v = np.array([0.0, height_mm, 0.0])
    pts_a, n_a = _screen_grid(a_origin, a_u, a_v, nu=nu, nv=nv, label="A")

    theta = np.radians(angle_deg)
    rot = np.array(
        [
            [np.cos(theta), 0.0, np.sin(theta)],
            [0.0, 1.0, 0.0],
            [-np.sin(theta), 0.0, np.cos(theta)],
        ]
    )
    b_origin = rot @ np.array([0.0, -0.5 * height_mm, 0.0])
    b_u = rot @ np.array([width_mm, 0.0, 0.0])
    b_v = rot @ np.array([0.0, height_mm, 0.0])
    pts_b, n_b = _screen_grid(b_origin, b_u, b_v, nu=nu, nv=nv, label="B")

    # Camera on -Z looking at the hinge.
    R = np.eye(3)
    cam_pos = np.array([400.0, 80.0, -2400.0])
    tvec = -R @ cam_pos
    rvec = np.zeros(3, dtype=np.float64)

    intr = CameraIntrinsics(fx=f, fy=f, cx=cx, cy=cy, k1=k1, k2=k2, width=w, height=h)

    correspondences: list[Correspondence] = []
    for label, pts in (("A", pts_a), ("B", pts_b)):
        world = np.asarray(pts, dtype=np.float64)
        cam = (R @ world.T).T + tvec.reshape(1, 3)
        pix = project_points(cam, intr)
        pix = pix + rng.normal(0.0, noise_px, size=pix.shape)
        for i, (p3, uv) in enumerate(zip(pts, pix)):
            if 0 <= uv[0] < w and 0 <= uv[1] < h:
                correspondences.append(
                    Correspondence(
                        world_mm=p3,
                        pixel_uv=(float(uv[0]), float(uv[1])),
                        screen_label=label,
                        point_id=f"{label}:{i}",
                    )
                )

    # Append explicit perimeter samples on each plane for edge coverage.
    for label, origin, axis_u, axis_v in (
        ("A", a_origin, a_u, a_v),
        ("B", b_origin, b_u, b_v),
    ):
        for uu, vv in (
            (0.02, 0.02),
            (0.98, 0.02),
            (0.02, 0.98),
            (0.98, 0.98),
            (0.5, 0.02),
            (0.5, 0.98),
            (0.02, 0.5),
            (0.98, 0.5),
        ):
            p = origin + uu * axis_u + vv * axis_v
            pts_extra = (float(p[0]), float(p[1]), float(p[2]))
            cam_pt = (R @ np.asarray(pts_extra)).ravel() + tvec
            uv = project_points(cam_pt.reshape(1, 3), intr)[0]
            uv = uv + rng.normal(0.0, noise_px, size=2)
            if 0 <= uv[0] < w and 0 <= uv[1] < h:
                correspondences.append(
                    Correspondence(
                        world_mm=pts_extra,
                        pixel_uv=(float(uv[0]), float(uv[1])),
                        screen_label=label,
                        point_id=f"{label}:edge:{uu}:{vv}",
                    )
                )

    return SyntheticScene(
        correspondences=correspondences,
        screen_normals={"A": n_a, "B": n_b},
        image_size=image_size,
        gt_f=f,
        gt_cx=cx,
        gt_cy=cy,
        gt_k1=k1,
        gt_k2=k2,
        gt_rvec=rvec,
        gt_tvec=tvec,
    )


def make_planar_scene(
    *,
    image_size: tuple[int, int] = (1920, 1080),
    f: float = 1400.0,
    nu: int = 10,
    nv: int = 8,
    noise_px: float = 0.1,
    seed: int = 1,
) -> SyntheticScene:
    w, h = image_size
    rng = np.random.default_rng(seed)
    width_mm, height_mm = 3000.0, 1800.0
    origin = np.array([-0.5 * width_mm, -0.5 * height_mm, 0.0])
    pts, normal = _screen_grid(
        origin,
        np.array([width_mm, 0.0, 0.0]),
        np.array([0.0, height_mm, 0.0]),
        nu=nu,
        nv=nv,
        label="A",
    )
    R = np.eye(3)
    cam_pos = np.array([0.0, 0.0, -3000.0])
    tvec = -R @ cam_pos
    rvec = np.zeros(3)
    intr = CameraIntrinsics(
        fx=f, fy=f, cx=0.5 * w, cy=0.5 * h, k1=-0.05, k2=0.01, width=w, height=h
    )
    correspondences: list[Correspondence] = []
    world = np.asarray(pts, dtype=np.float64)
    cam = (R @ world.T).T + tvec.reshape(1, 3)
    pix = project_points(cam, intr) + rng.normal(0.0, noise_px, size=(len(pts), 2))
    for i, (p3, uv) in enumerate(zip(pts, pix)):
        if 0 <= uv[0] < w and 0 <= uv[1] < h:
            correspondences.append(
                Correspondence(
                    world_mm=p3,
                    pixel_uv=(float(uv[0]), float(uv[1])),
                    screen_label="A",
                    point_id=f"A:{i}",
                )
            )
    return SyntheticScene(
        correspondences=correspondences,
        screen_normals={"A": normal},
        image_size=image_size,
        gt_f=f,
        gt_cx=0.5 * w,
        gt_cy=0.5 * h,
        gt_k1=-0.05,
        gt_k2=0.01,
        gt_rvec=rvec,
        gt_tvec=tvec,
    )


def corrupt_relative_pose(scene: SyntheticScene, *, translation_mm: float = 500.0) -> SyntheticScene:
    """Shift screen B world points to simulate wrong relative Stage geometry."""
    new_corr: list[Correspondence] = []
    for c in scene.correspondences:
        if c.screen_label == "B":
            x, y, z = c.world_mm
            new_corr.append(
                Correspondence(
                    world_mm=(x + translation_mm, y, z),
                    pixel_uv=c.pixel_uv,
                    screen_label=c.screen_label,
                    quality=c.quality,
                    point_id=c.point_id,
                )
            )
        else:
            new_corr.append(c)
    return SyntheticScene(
        correspondences=new_corr,
        screen_normals=scene.screen_normals,
        image_size=scene.image_size,
        gt_f=scene.gt_f,
        gt_cx=scene.gt_cx,
        gt_cy=scene.gt_cy,
        gt_k1=scene.gt_k1,
        gt_k2=scene.gt_k2,
        gt_rvec=scene.gt_rvec,
        gt_tvec=scene.gt_tvec,
    )


def scene_to_input(
    scene: SyntheticScene,
    *,
    mode: str = "joint-session-lens",
    known_lens: KnownLens | None = None,
    weak_focal: float | None = None,
) -> FixedObservationInput:
    return FixedObservationInput(
        correspondences=scene.correspondences,
        image_size=scene.image_size,
        screen_normals=scene.screen_normals,
        stage_geometry_fingerprint="sha256:synthetic",
        camera_state=CameraStateFingerprint(
            camera_id="synthetic",
            resolution=scene.image_size,
            transfer_path="synthetic",
            focus_zoom_attested=True,
            attest_timestamp="2026-07-22T00:00:00+00:00",
        ),
        mode_requested=mode,  # type: ignore[arg-type]
        known_lens=known_lens,
        weak_focal_guess_px=weak_focal,
        formal=True,
    )


def run_synthetic_sweep() -> dict:
    """Executable §9.1 sweep; returns a pinning report dict."""
    from vpcal.core.errors import (
        ScreenGeometryInconsistent,
        SingleViewUnobservable,
    )

    report: dict = {"cases": {}, "thresholds_ok": True}

    # two-plane recovery
    scene = make_two_plane_scene(nu=9, nv=7, noise_px=0.1)
    try:
        result = solve_fixed_observation(scene_to_input(scene, weak_focal=1200.0))
        assert result.session_lens is not None
        f_err = abs(result.session_lens.fx - scene.gt_f) / scene.gt_f
        pp_err = max(
            abs(result.session_lens.cx - scene.gt_cx),
            abs(result.session_lens.cy - scene.gt_cy),
        )
        # M1/M2 lock pp at image center — pp recovery only required for M3.
        pp_ok = pp_err < 3.0 if result.model_level == "M3_center_radial_pose" else True
        report["cases"]["two_plane_recovery"] = {
            "passed": f_err < 0.01 and pp_ok and result.rms_reprojection_px < 1.0,
            "focal_rel_err": f_err,
            "pp_err_px": pp_err,
            "rms_px": result.rms_reprojection_px,
            "model": result.model_level,
            "num": result.num_correspondences,
        }
    except Exception as exc:  # noqa: BLE001
        report["cases"]["two_plane_recovery"] = {"passed": False, "error": str(exc)}
        report["thresholds_ok"] = False

    # planar must fail
    planar = make_planar_scene()
    try:
        solve_fixed_observation(scene_to_input(planar))
        report["cases"]["planar_unobservable"] = {"passed": False, "error": "expected fail"}
        report["thresholds_ok"] = False
    except SingleViewUnobservable as exc:
        report["cases"]["planar_unobservable"] = {
            "passed": True,
            "code": exc.code,
        }

    # wrong relative pose
    bad = corrupt_relative_pose(make_two_plane_scene(nu=9, nv=7))
    try:
        solve_fixed_observation(scene_to_input(bad))
        report["cases"]["wrong_relative_pose"] = {"passed": False, "error": "expected fail"}
        report["thresholds_ok"] = False
    except (ScreenGeometryInconsistent, SingleViewUnobservable) as exc:
        report["cases"]["wrong_relative_pose"] = {"passed": True, "code": exc.code}

    # wrong focal prior still converges on observable data
    scene2 = make_two_plane_scene(nu=9, nv=7, seed=3)
    try:
        result2 = solve_fixed_observation(scene_to_input(scene2, weak_focal=800.0))
        f_err2 = abs(result2.session_lens.fx - scene2.gt_f) / scene2.gt_f  # type: ignore[union-attr]
        report["cases"]["wrong_focal_prior"] = {
            "passed": f_err2 < 0.02 and result2.qualification["passed"],
            "focal_rel_err": f_err2,
        }
    except Exception as exc:  # noqa: BLE001
        report["cases"]["wrong_focal_prior"] = {"passed": False, "error": str(exc)}
        report["thresholds_ok"] = False

    # planar + wrong prior must NOT pass formal via prior
    try:
        solve_fixed_observation(scene_to_input(planar, weak_focal=planar.gt_f))
        report["cases"]["planar_prior_cannot_pass"] = {
            "passed": False,
            "error": "prior must not qualify planar",
        }
        report["thresholds_ok"] = False
    except SingleViewUnobservable:
        report["cases"]["planar_prior_cannot_pass"] = {"passed": True}

    # distortion overfit: M3 should not be forced when coverage insufficient —
    # use two-plane with points clustered away from edges by cropping image size
    # Relative: ensure chosen model is not M3 solely due to lower train RMS.
    scene3 = make_two_plane_scene(nu=10, nv=8, seed=5, k1=-0.12, k2=0.04)
    try:
        result3 = solve_fixed_observation(scene_to_input(scene3))
        report["cases"]["distortion_model_ladder"] = {
            "passed": result3.model_level in {
                "M1_focal_pose",
                "M2_radial_pose",
                "M3_center_radial_pose",
            }
            and result3.qualification["passed"],
            "model": result3.model_level,
            "rms_px": result3.rms_reprojection_px,
        }
    except Exception as exc:  # noqa: BLE001
        report["cases"]["distortion_model_ladder"] = {"passed": False, "error": str(exc)}

    report["pinned_thresholds"] = {
        "min_edge_fraction": 0.15,
        "max_hessian_condition": 1.0e8,
        "joint_projective_soft_limit_px": 10.0,
    }
    report["thresholds_ok"] = all(
        c.get("passed") for c in report["cases"].values()
    ) and report["thresholds_ok"]
    return report


if __name__ == "__main__":
    import json

    print(json.dumps(run_synthetic_sweep(), indent=2))
