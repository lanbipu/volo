"""vpcal tracker-free — lens calibration + spatial solve without a tracking system."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

# Gap between the last cabinet column of Screen A and the first of Screen B
# when auto-computing offset-b. Ensures no marker ID collisions even if the
# screen definition's column count changes slightly (e.g. after re-running
# auto_cabinet_size with different parameters).
_COL_OFFSET_GAP = 5

import click
import numpy as np

from vpcal.cli._common import OperationOutput, common_options, run_operation


@click.group(name="tracker-free")
@click.pass_context
def tracker_free(ctx: click.Context) -> None:
    """Tracker-free calibration: lens + spatial solve from images only."""


@tracker_free.command(name="lens-cal")
@click.option("--images", required=True, type=click.Path(exists=True, file_okay=False), help="Directory of calibration images.")
@click.option("--screen", "screen_path", required=True, type=click.Path(exists=True), help="Screen definition JSON.")
@click.option("--cab-col-offset", type=int, default=0, show_default=True, help="Cabinet column offset (must match pattern generation).")
@click.option("--screen-id", type=int, default=0, show_default=True, help="VP-QSP screen_id (must match pattern generation).")
@click.option("--out", "out_path", required=True, type=click.Path(), help="Output lens profile JSON.")
@common_options
@click.pass_context
def lens_cal(ctx, images, screen_path, cab_col_offset, screen_id, out_path, **flags) -> None:
    """Calibrate camera intrinsics from multiple images of one screen's pattern.

    Take 8-20 photos of the calibration pattern from varying angles and distances.
    The solver uses cv2.calibrateCamera to estimate focal length and distortion.
    """

    def body() -> OperationOutput:
        from vpcal.core.tracker_free import lens_calibrate
        from vpcal.io.screen_io import load_screen

        screen = load_screen(screen_path)
        if flags.get("dry_run"):
            return OperationOutput(
                data={"exit_code": 0, "dry_run_plan": {"images": images, "output": out_path}},
                text="Dry run OK.",
            )

        result = lens_calibrate(
            Path(images), screen, cab_col_offset=cab_col_offset, screen_id=screen_id,
        )

        out = {
            "fx": result.fx,
            "fy": result.fy,
            "cx": result.cx,
            "cy": result.cy,
            "dist_coeffs": result.dist_coeffs,
            "rms": result.rms,
            "num_images": result.num_images,
            "num_points": result.num_points,
            "image_size": list(result.image_size),
            "calibration_kind": "multi_view_intrinsics",
            "is_master": True,
            "session_coupled": False,
            "calibrated_at": datetime.now(timezone.utc).isoformat(),
        }
        reasons = _lens_qualification_reasons(out)
        if reasons:
            raise ValueError(
                "Lens calibration did not qualify as a master lens: " + "; ".join(reasons)
            )
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        Path(out_path).write_text(json.dumps(out, indent=2))

        text = (
            f"Lens calibration OK (RMS {result.rms:.4f} px, "
            f"{result.num_images} images, {result.num_points} points)\n"
            f"  fx={result.fx:.2f}  fy={result.fy:.2f}  "
            f"cx={result.cx:.2f}  cy={result.cy:.2f}\n"
            f"  dist={[round(d, 6) for d in result.dist_coeffs]}\n"
            f"  → {out_path}"
        )
        return OperationOutput(data=out, text=text)

    run_operation("tracker_free.lens_cal", body, **flags)


def _load_lens(path: str):
    from vpcal.core.tracker_free import LensCalResult
    d = json.loads(Path(path).read_text())
    if "focal_length_mm" in d:
        from vpcal.models.lens import LensProfile

        profile = LensProfile.model_validate(d)
        distortion = profile.distortion
        return LensCalResult(
            fx=profile.fx, fy=profile.fy, cx=profile.cx, cy=profile.cy,
            dist_coeffs=[distortion.k1, distortion.k2, distortion.p1,
                         distortion.p2, distortion.k3],
            rms=0.0, num_images=0, num_points=0,
            image_size=(profile.image_width_px, profile.image_height_px),
        )
    return LensCalResult(
        fx=d["fx"], fy=d["fy"], cx=d["cx"], cy=d["cy"],
        dist_coeffs=d["dist_coeffs"], rms=d.get("rms", 0.0),
        num_images=d.get("num_images", 0), num_points=d.get("num_points", 0),
        image_size=tuple(d.get("image_size", [0, 0])),
    )


def _lens_qualification_reasons(data: dict) -> list[str]:
    reasons: list[str] = []
    if data.get("is_master") is not True:
        reasons.append("is_master is not true")
    if data.get("session_coupled") is True:
        reasons.append("session-coupled lens estimates are not reusable master lenses")
    if data.get("calibration_kind") not in {"multi_view_intrinsics", "offline_chart"}:
        reasons.append("calibration_kind must be multi_view_intrinsics or offline_chart")
    if int(data.get("num_images", 0) or 0) < 8:
        reasons.append("num_images must be >= 8")
    if int(data.get("num_points", 0) or 0) < 60:
        reasons.append("num_points must be >= 60")
    image_size = data.get("image_size")
    if not (
        isinstance(image_size, (list, tuple))
        and len(image_size) >= 2
        and int(image_size[0]) > 0
        and int(image_size[1]) > 0
    ):
        reasons.append("image_size must be present and positive")
    rms = float(data.get("rms", float("inf")))
    if not np.isfinite(rms) or rms >= 2.0:
        reasons.append("lens calibration RMS must be < 2.0 px")
    return reasons


@tracker_free.command(name="lens-info")
@click.option("--lens", "lens_path", required=True, type=click.Path(exists=True))
@common_options
@click.pass_context
def lens_info(ctx, lens_path, **flags) -> None:
    """Inspect master-lens provenance and formal fixed-pose eligibility."""

    def body() -> OperationOutput:
        raw = json.loads(Path(lens_path).read_text(encoding="utf-8"))
        lens = _load_lens(lens_path)
        reasons = _lens_qualification_reasons(raw)
        data = {
            "path": str(Path(lens_path)),
            "qualified_master": not reasons,
            "reasons": reasons,
            "calibration_kind": raw.get("calibration_kind"),
            "is_master": raw.get("is_master") is True,
            "session_coupled": raw.get("session_coupled") is True,
            "num_images": int(raw.get("num_images", lens.num_images) or 0),
            "num_points": int(raw.get("num_points", lens.num_points) or 0),
            "rms": float(raw.get("rms", lens.rms)),
            "image_size": list(lens.image_size),
            "fx": lens.fx,
            "fy": lens.fy,
            "cx": lens.cx,
            "cy": lens.cy,
            "dist_coeffs": list(lens.dist_coeffs),
        }
        return OperationOutput(
            data=data,
            text=("Master lens qualified" if not reasons else "Master lens rejected: " + "; ".join(reasons)),
        )

    run_operation("tracker_free.lens_info", body, **flags)


@tracker_free.command(name="pose")
@click.option("--image", required=True, type=click.Path(exists=True), help="Single fixed-camera image.")
@click.option(
    "--screen-target", "screen_targets", multiple=True, required=True,
    type=(click.Path(exists=True), click.IntRange(0, 15), click.IntRange(min=0)),
    metavar="PATH SCREEN_ID CAB_COL_OFFSET",
    help="Repeatable Stage screen target; targets may be outside the image.",
)
@click.option("--lens", "lens_path", type=click.Path(exists=True), default=None,
              help="Pixel-domain LensProfile or tracker-free lens JSON.")
@click.option("--fx", type=click.FloatRange(min=0.0, min_open=True), default=None,
              help="Capture-domain focal length X in pixels.")
@click.option("--fy", type=click.FloatRange(min=0.0, min_open=True), default=None,
              help="Capture-domain focal length Y in pixels.")
@click.option("--cx", type=float, default=None, help="Capture-domain principal point X in pixels.")
@click.option("--cy", type=float, default=None, help="Capture-domain principal point Y in pixels.")
@click.option("--focal-mm", type=float, default=None, help="Known focal length when --lens is omitted.")
@click.option("--sensor-width-mm", type=float, default=None)
@click.option("--sensor-height-mm", type=float, default=None)
@click.option("--principal-x-mm", type=float, default=0.0, show_default=True)
@click.option("--principal-y-mm", type=float, default=0.0, show_default=True)
@click.option("--k1", type=float, default=0.0, show_default=True)
@click.option("--k2", type=float, default=0.0, show_default=True)
@click.option("--k3", type=float, default=0.0, show_default=True)
@click.option(
    "--debug-unqualified", is_flag=True,
    help="Allow explicit/manual intrinsics for a non-formal diagnostic solve.",
)
@click.option("--out", "out_path", type=click.Path(), default=None, help="Optional pose result JSON.")
@common_options
@click.pass_context
def pose(ctx, image, screen_targets, lens_path, fx, fy, cx, cy, focal_mm,
         sensor_width_mm, sensor_height_mm, principal_x_mm, principal_y_mm,
         k1, k2, k3, debug_unqualified, out_path, **flags) -> None:
    """One-shot camera-to-Stage pose from any visible selected screen."""

    def body() -> OperationOutput:
        import cv2

        from vpcal.core.tracker_free import (
            LensCalResult,
            StagePoseTarget,
            solve_stage_pose,
        )
        from vpcal.io.screen_io import load_screen

        loaded = [
            StagePoseTarget(
                screen=load_screen(path), screen_id=screen_id,
                cab_col_offset=offset,
                label=Path(path).stem.removesuffix(".screen"),
            )
            for path, screen_id, offset in screen_targets
        ]
        frame = cv2.imread(str(image))
        if frame is None:
            raise click.UsageError(f"cannot read image: {image}")
        height, width = frame.shape[:2]

        pixel_values = (fx, fy, cx, cy)
        has_any_pixel = any(value is not None for value in pixel_values)
        has_all_pixel = all(value is not None for value in pixel_values)
        has_any_physical = any(
            value is not None for value in (focal_mm, sensor_width_mm, sensor_height_mm)
        )
        source_count = int(bool(lens_path)) + int(has_any_pixel) + int(has_any_physical)
        if source_count != 1:
            raise click.UsageError(
                "provide exactly one intrinsics source: --lens, --fx/--fy/--cx/--cy, "
                "or --focal-mm/--sensor-width-mm/--sensor-height-mm"
            )

        if lens_path:
            raw_lens = json.loads(Path(lens_path).read_text(encoding="utf-8"))
            qualification_reasons = _lens_qualification_reasons(raw_lens)
            if qualification_reasons:
                from vpcal.core.errors import MasterLensRequired
                raise MasterLensRequired(
                    "fixed formal solve requires a qualified master lens: "
                    + "; ".join(qualification_reasons),
                    details={"reasons": qualification_reasons},
                )
            lens = _load_lens(lens_path)
        elif has_any_pixel:
            if not debug_unqualified:
                from vpcal.core.errors import MasterLensRequired
                raise MasterLensRequired(
                    "fixed formal solve requires --lens <qualified master>; "
                    "explicit pixel intrinsics are debug-only"
                )
            if not has_all_pixel:
                raise click.UsageError("--fx, --fy, --cx and --cy must be provided together")
            lens = LensCalResult(
                fx=float(fx), fy=float(fy), cx=float(cx), cy=float(cy),
                dist_coeffs=[k1, k2, 0.0, 0.0, k3],
                rms=0.0, num_images=0, num_points=0,
                image_size=(width, height),
            )
        else:
            if not debug_unqualified:
                from vpcal.core.errors import MasterLensRequired
                raise MasterLensRequired(
                    "fixed formal solve requires --lens <qualified master>; "
                    "physical/default intrinsics are debug-only"
                )
            if not focal_mm or not sensor_width_mm or not sensor_height_mm:
                raise click.UsageError(
                    "--focal-mm, --sensor-width-mm and --sensor-height-mm are required "
                    "when --lens is omitted"
                )
            active_width, active_height, pixel_scale, crop_mode = _center_crop_sensor(
                float(sensor_width_mm), float(sensor_height_mm), width, height,
            )
            focal_px = float(focal_mm) * pixel_scale
            lens = LensCalResult(
                fx=focal_px,
                fy=focal_px,
                cx=width / 2.0 + float(principal_x_mm) * pixel_scale,
                cy=height / 2.0 + float(principal_y_mm) * pixel_scale,
                dist_coeffs=[k1, k2, 0.0, 0.0, k3],
                rms=0.0, num_images=0, num_points=0,
                image_size=(width, height),
            )

        lens_size = tuple(int(value) for value in lens.image_size)
        if lens_size != (0, 0) and lens_size != (width, height):
            raise click.UsageError(
                f"lens image_size {lens_size[0]}x{lens_size[1]} does not match "
                f"capture {width}x{height}"
            )

        if not debug_unqualified:
            invalid_geometry = {
                target.label: (
                    target.screen.geometry_provenance.get("reasons", ["geometry provenance missing"])
                    if target.screen.geometry_provenance
                    else ["geometry provenance missing"]
                )
                for target in loaded
                if not target.screen.geometry_provenance
                or target.screen.geometry_provenance.get("formal_eligible") is not True
            }
            if invalid_geometry:
                from vpcal.core.errors import ScreenGeometryInconsistent
                raise ScreenGeometryInconsistent(
                    "fixed formal solve requires anchored, withheld-validated screen geometry",
                    details={"screens": invalid_geometry},
                )

        if flags.get("dry_run"):
            return OperationOutput(
                data={"dry_run_plan": {
                    "image": image,
                    "targets": [target.label for target in loaded],
                    "partial_visibility_allowed": False,
                    "intrinsics": {
                        "fx": lens.fx, "fy": lens.fy,
                        "cx": lens.cx, "cy": lens.cy,
                        "image_size": list(lens.image_size),
                        "active_sensor_mm": (
                            [active_width, active_height]
                            if not lens_path and not has_any_pixel else None
                        ),
                        "crop_mode": (
                            crop_mode if not lens_path and not has_any_pixel else None
                        ),
                    },
                }},
                text="Dry run OK.",
            )

        result = solve_stage_pose(Path(image), loaded, lens)
        solved = result.camera_from_stage
        camera_position = solved.camera_position_in_screen
        # OpenCV camera basis is +X right, +Y down, +Z forward. Volo's Three.js
        # frustum is +X right, +Y up, -Z forward. Convert the local basis before
        # exposing a Stage camera transform or decomposing UI Pan/Tilt/Roll.
        camera_rotation = _volo_camera_rotation(solved.rotation_matrix.T)
        euler = _rotation_to_euler(camera_rotation)
        ptr = _rotation_to_ptr(camera_rotation)
        camera_matrix = np.eye(4, dtype=np.float64)
        camera_matrix[:3, :3] = camera_rotation
        camera_matrix[:3, 3] = camera_position
        out = {
            "schema_version": "volo_stage_pose.v2",
            "solve_kind": "fixed_extrinsics_only",
            "formal": not debug_unqualified,
            "image": image,
            "image_size": [width, height],
            "camera_from_stage": {
                "position_mm": camera_position.tolist(),
                "euler_deg": {"rx": euler[0], "ry": euler[1], "rz": euler[2]},
                "ptr_deg": {"pan": ptr[0], "tilt": ptr[1], "roll": ptr[2]},
                "matrix_4x4": camera_matrix.tolist(),
            },
            "rms_reprojection_px": result.rms_reprojection_px,
            "num_markers": result.num_markers,
            "num_inliers": result.num_inliers,
            "markers_by_screen": result.markers_by_target,
            "inliers_by_screen": result.inliers_by_target,
            "rms_by_screen": result.rms_by_target,
            "independent_rms_by_screen": result.independent_rms_by_target,
            "screen_to_screen_consistency": result.screen_to_screen_consistency,
            "rejected_observations": result.rejected_observations,
            "preflight": result.preflight,
            "qualification": {
                "passed": not debug_unqualified,
                "master_lens": bool(lens_path),
                "fail_closed": True,
            },
            "visible_screens": [
                label for label, count in result.markers_by_target.items() if count > 0
            ],
            "selected_screens": [target.label for target in loaded],
            "partial_visibility_allowed": False,
        }
        if out_path:
            Path(out_path).write_text(json.dumps(out, indent=2), encoding="utf-8")
        return OperationOutput(
            data=out,
            text=(f"Stage pose OK: {result.num_markers} markers / "
                  f"{result.num_inliers} inliers, RMS {result.rms_reprojection_px:.3f} px"),
        )

    run_operation("tracker_free.pose", body, **flags)


@tracker_free.command(name="spatial")
@click.option("--images", required=True, type=click.Path(exists=True, file_okay=False), help="Directory of co-visible images (both screens).")
@click.option("--screen-a", required=True, type=click.Path(exists=True), help="Screen A definition JSON.")
@click.option("--screen-b", required=True, type=click.Path(exists=True), help="Screen B definition JSON.")
@click.option("--lens", "lens_path", required=True, type=click.Path(exists=True), help="Lens profile JSON from lens-cal.")
@click.option("--offset-a", type=int, default=0, show_default=True, help="Screen A cab_col_offset.")
@click.option("--offset-b", type=int, default=None, help="Screen B cab_col_offset (auto = A's column count + 5).")
@click.option("--screen-id", type=int, default=0, show_default=True, help="VP-QSP screen_id.")
@click.option("--out", "out_path", required=True, type=click.Path(), help="Output spatial result JSON.")
@common_options
@click.pass_context
def spatial(ctx, images, screen_a, screen_b, lens_path, offset_a, offset_b, screen_id, out_path, **flags) -> None:
    """Solve relative screen positions from images showing both screens.

    Each image must show calibration patterns on BOTH screens simultaneously.
    The solver uses solvePnP per screen per image, then computes the relative
    transform. Screen A is the reference (origin).
    """

    def body() -> OperationOutput:
        from vpcal.core.tracker_free import spatial_solve
        from vpcal.io.screen_io import load_screen

        from vpcal.core.screen_geometry import section_grid

        scr_a = load_screen(screen_a)
        scr_b = load_screen(screen_b)
        lens = _load_lens(lens_path)

        effective_offset_b = offset_b
        if effective_offset_b is None:
            total_cols_a = sum(section_grid(scr_a, s)[1] for s in scr_a.sections)
            effective_offset_b = offset_a + total_cols_a + _COL_OFFSET_GAP

        if flags.get("dry_run"):
            return OperationOutput(
                data={"exit_code": 0, "dry_run_plan": {"images": images, "output": out_path}},
                text="Dry run OK.",
            )

        result = spatial_solve(
            Path(images), scr_a, scr_b, lens,
            cab_col_offset_a=offset_a, cab_col_offset_b=effective_offset_b, screen_id=screen_id,
        )

        pose = result.screen_b_pose
        R = pose.rotation_matrix
        t = pose.tvec.ravel()
        euler = _rotation_to_euler(R)

        out = {
            "screen_a": result.screen_a_name,
            "screen_b": result.screen_b_name,
            "screen_b_relative": {
                "translation_mm": t.tolist(),
                "rotation_matrix": R.tolist(),
                "rvec": pose.rvec.ravel().tolist(),
                "euler_deg": {"rx": euler[0], "ry": euler[1], "rz": euler[2]},
                "matrix_4x4": pose.matrix_4x4.tolist(),
            },
            "num_co_visible": result.num_co_visible,
            "num_rejected": result.num_rejected,
            "rms_reprojection_a_px": result.rms_reprojection_a,
            "rms_reprojection_b_px": result.rms_reprojection_b,
            "consistency": result.consistency,
            "per_image": result.per_image_poses,
        }
        Path(out_path).write_text(json.dumps(out, indent=2))

        cons = result.consistency
        text = (
            f"Spatial solve OK ({result.num_co_visible} co-visible images, "
            f"{result.num_rejected} rejected)\n"
            f"  Screen B relative to A:\n"
            f"    translation: [{t[0]:.1f}, {t[1]:.1f}, {t[2]:.1f}] mm\n"
            f"    rotation:    [{euler[0]:.2f}°, {euler[1]:.2f}°, {euler[2]:.2f}°]\n"
            f"  reprojection RMS: A={result.rms_reprojection_a:.3f} px, "
            f"B={result.rms_reprojection_b:.3f} px\n"
            f"  dispersion: rot {cons.get('rotation_deg_max', 0.0):.3f}° max, "
            f"trans {cons.get('translation_mm_max', 0.0):.2f} mm max\n"
            f"  → {out_path}"
        )
        return OperationOutput(data=out, text=text)

    run_operation("tracker_free.spatial", body, **flags)


@tracker_free.command(name="grid")
@click.option(
    "--screen-target", "screen_targets", multiple=True, required=True,
    type=(click.Path(exists=True), click.IntRange(0, 15), click.IntRange(min=0)),
    metavar="PATH SCREEN_ID CAB_COL_OFFSET",
    help="Repeatable Stage screen target (screen_id/offset unused for geometry; kept for pose CLI parity).",
)
@click.option("--pose", "pose_path", required=True, type=click.Path(exists=True),
              help="stage_pose.json from tracker-free pose.")
@click.option("--lens", "lens_path", type=click.Path(exists=True), default=None,
              help="Pixel-domain LensProfile or tracker-free lens JSON.")
@click.option("--fx", type=click.FloatRange(min=0.0, min_open=True), default=None)
@click.option("--fy", type=click.FloatRange(min=0.0, min_open=True), default=None)
@click.option("--cx", type=float, default=None)
@click.option("--cy", type=float, default=None)
@click.option("--k1", type=float, default=0.0, show_default=True)
@click.option("--k2", type=float, default=0.0, show_default=True)
@click.option("--k3", type=float, default=0.0, show_default=True)
@click.option("--image-width", type=click.IntRange(min=1), default=None)
@click.option("--image-height", type=click.IntRange(min=1), default=None)
@click.option("--no-markers", is_flag=True, help="Omit cabinet-corner / cell marker points.")
@common_options
@click.pass_context
def grid(ctx, screen_targets, pose_path, lens_path, fx, fy, cx, cy, k1, k2, k3,
         image_width, image_height, no_markers, **flags) -> None:
    """Project cabinet-grid wireframes through a solved Stage pose (normalised 2D)."""

    def body() -> OperationOutput:
        from vpcal.core.grid_overlay import opencv_T_from_stage_pose, project_grid_overlay
        from vpcal.core.projection import CameraIntrinsics
        from vpcal.core.tracker_free import LensCalResult
        from vpcal.io.screen_io import load_screen

        pose = json.loads(Path(pose_path).read_text(encoding="utf-8"))
        pixel_values = (fx, fy, cx, cy)
        has_any_pixel = any(value is not None for value in pixel_values)
        has_all_pixel = all(value is not None for value in pixel_values)
        if int(bool(lens_path)) + int(has_any_pixel) != 1:
            raise click.UsageError(
                "provide exactly one intrinsics source: --lens or --fx/--fy/--cx/--cy"
            )
        if lens_path:
            lens = _load_lens(lens_path)
        else:
            if not has_all_pixel:
                raise click.UsageError("--fx, --fy, --cx and --cy must be provided together")
            if (image_width is None) != (image_height is None):
                raise click.UsageError("--image-width and --image-height must be provided together")
            image_size = [image_width, image_height] if image_width is not None else pose.get("image_size")
            if not (
                isinstance(image_size, list)
                and len(image_size) >= 2
                and int(image_size[0]) > 0
                and int(image_size[1]) > 0
            ):
                raise click.UsageError(
                    "stage_pose.json must persist a positive image_size; "
                    "principal point cannot be used to infer frame dimensions"
                )
            width, height = int(image_size[0]), int(image_size[1])
            pose_image_size = pose.get("image_size")
            if (
                image_width is not None
                and isinstance(pose_image_size, list)
                and len(pose_image_size) >= 2
                and [width, height] != [int(pose_image_size[0]), int(pose_image_size[1])]
            ):
                raise click.UsageError(
                    "explicit image dimensions do not match stage_pose.json image_size"
                )
            lens = LensCalResult(
                fx=float(fx), fy=float(fy), cx=float(cx), cy=float(cy),
                dist_coeffs=[k1, k2, 0.0, 0.0, k3],
                rms=0.0, num_images=0, num_points=0,
                image_size=(width, height),
            )

        # The calibrated image domain is part of the lens contract.  Principal
        # point is not an image-size proxy when it has an optical offset.
        lw, lh = (int(lens.image_size[0]), int(lens.image_size[1]))
        if lw <= 0 or lh <= 0:
            raise click.UsageError("lens profile must contain a positive image_size")
        dist = list(lens.dist_coeffs) + [0.0] * 5
        intr = CameraIntrinsics(
            fx=lens.fx, fy=lens.fy, cx=lens.cx, cy=lens.cy,
            k1=dist[0], k2=dist[1], p1=dist[2], p2=dist[3], k3=dist[4],
            width=float(lw), height=float(lh),
        )
        loaded = [
            (Path(path).stem.removesuffix(".screen"), load_screen(path))
            for path, _screen_id, _offset in screen_targets
        ]
        if flags.get("dry_run"):
            return OperationOutput(
                data={"dry_run_plan": {
                    "pose": pose_path,
                    "targets": [label for label, _ in loaded],
                    "image_size": [lw, lh],
                }},
                text="Dry run OK.",
            )
        T_C_from_S = opencv_T_from_stage_pose(pose)
        out = project_grid_overlay(
            loaded, T_C_from_S, intr, include_markers=not no_markers,
        )
        n_seg = sum(len(s["segments"]) for s in out["screens"])
        n_mk = sum(len(s["markers"]) for s in out["screens"])
        return OperationOutput(
            data=out,
            text=(f"Grid overlay: {len(out['screens'])} screen(s), "
                  f"{n_seg} segment(s), {n_mk} marker(s)"),
        )

    run_operation("tracker_free.grid", body, **flags)


@tracker_free.command(name="verify")
@click.option("--image", required=True, type=click.Path(exists=True), help="Verification image.")
@click.option("--screen-a", required=True, type=click.Path(exists=True), help="Screen A definition JSON.")
@click.option("--screen-b", required=True, type=click.Path(exists=True), help="Screen B definition JSON.")
@click.option("--lens", "lens_path", required=True, type=click.Path(exists=True), help="Lens profile JSON.")
@click.option("--offset-a", type=int, default=0, show_default=True, help="Screen A cab_col_offset.")
@click.option("--offset-b", type=int, default=None, help="Screen B cab_col_offset (auto = A's column count + 5).")
@click.option("--screen-id", type=int, default=0, show_default=True, help="VP-QSP screen_id.")
@common_options
@click.pass_context
def verify(ctx, image, screen_a, screen_b, lens_path, offset_a, offset_b, screen_id, **flags) -> None:
    """Verify calibration by computing camera pose from a single image.

    Reports the camera's position relative to each screen, so you can
    cross-check against physical measurements.
    """

    def body() -> OperationOutput:
        from vpcal.core.tracker_free import verify_pose
        from vpcal.core.screen_geometry import section_grid
        from vpcal.io.screen_io import load_screen

        scr_a = load_screen(screen_a)
        scr_b = load_screen(screen_b)
        lens = _load_lens(lens_path)

        effective_offset_b = offset_b
        if effective_offset_b is None:
            total_cols_a = sum(section_grid(scr_a, s)[1] for s in scr_a.sections)
            effective_offset_b = offset_a + total_cols_a + _COL_OFFSET_GAP

        result = verify_pose(
            Path(image), scr_a, scr_b, lens,
            cab_col_offset_a=offset_a, cab_col_offset_b=effective_offset_b, screen_id=screen_id,
        )

        out: dict = {
            "image": image,
            "markers_a": result.num_markers_a,
            "markers_b": result.num_markers_b,
        }
        lines = [f"Verify: {result.num_markers_a} markers (A), {result.num_markers_b} markers (B)"]

        for label, pose in [("A", result.camera_pose_from_a), ("B", result.camera_pose_from_b)]:
            if pose is not None:
                cam_pos = pose.camera_position_in_screen
                R_inv = pose.rotation_matrix.T
                euler = _rotation_to_euler(R_inv)
                dist = float(np.linalg.norm(cam_pos))
                out[f"camera_from_{label.lower()}"] = {
                    "position_mm": cam_pos.tolist(),
                    "euler_deg": {"rx": euler[0], "ry": euler[1], "rz": euler[2]},
                    "distance_mm": dist,
                }
                lines.append(
                    f"  Camera from {label}: distance {dist:.0f} mm, "
                    f"position [{cam_pos[0]:.1f}, {cam_pos[1]:.1f}, {cam_pos[2]:.1f}] mm"
                )
            else:
                lines.append(f"  Camera from {label}: NOT DETECTED (< 4 markers)")

        return OperationOutput(data=out, text="\n".join(lines))

    run_operation("tracker_free.verify", body, **flags)


@tracker_free.command(name="export")
@click.option("--spatial", "spatial_path", required=True, type=click.Path(exists=True), help="Spatial result JSON from spatial command.")
@click.option("--screen-a", required=True, type=click.Path(exists=True), help="Screen A definition JSON.")
@click.option("--screen-b", required=True, type=click.Path(exists=True), help="Screen B definition JSON.")
@click.option("--root", type=click.Choice(["a", "b"]), default="b", show_default=True, help="Which screen is the world-origin reference.")
@click.option("--out-dir", required=True, type=click.Path(file_okay=False), help="Output directory for OBJ files.")
@common_options
@click.pass_context
def export_cmd(ctx, spatial_path, screen_a, screen_b, root, out_dir, **flags) -> None:
    """Export calibrated screen meshes as OBJ (disguise coordinate system).

    The --root screen is placed at the origin. The other screen is
    positioned relative to it using the spatial calibration result.
    Default root is Screen B (matching LMT/disguise convention where
    the largest screen is the reference).
    """

    def body() -> OperationOutput:
        from vpcal.core.tracker_free import export_obj
        from vpcal.io.screen_io import load_screen

        scr_a = load_screen(screen_a)
        scr_b = load_screen(screen_b)

        if flags.get("dry_run"):
            return OperationOutput(
                data={"exit_code": 0, "dry_run_plan": {"out_dir": out_dir, "root": root}},
                text="Dry run OK.",
            )

        screens = export_obj(
            Path(spatial_path), scr_a, scr_b, Path(out_dir), root=root,
        )

        files = [f"{s.name.replace(' ', '_')}.obj" for s in screens]
        root_name = scr_b.name if root == "b" else scr_a.name
        text = (
            f"Exported {len(files)} screen meshes (root: {root_name})\n"
            + "\n".join(f"  → {out_dir}/{f}" for f in files)
        )
        return OperationOutput(data={"files": files, "root": root_name}, text=text)

    run_operation("tracker_free.export", body, **flags)


def _rotation_to_euler(R: np.ndarray) -> tuple[float, float, float]:
    """Rotation matrix → extrinsic XYZ Euler angles (degrees)."""
    sy = np.sqrt(R[0, 0] ** 2 + R[1, 0] ** 2)
    if sy > 1e-6:
        rx = np.arctan2(R[2, 1], R[2, 2])
        ry = np.arctan2(-R[2, 0], sy)
        rz = np.arctan2(R[1, 0], R[0, 0])
    else:
        rx = np.arctan2(-R[1, 2], R[1, 1])
        ry = np.arctan2(-R[2, 0], sy)
        rz = 0.0
    return (float(np.degrees(rx)), float(np.degrees(ry)), float(np.degrees(rz)))


def _center_crop_sensor(
    sensor_width_mm: float,
    sensor_height_mm: float,
    image_width_px: int,
    image_height_px: int,
) -> tuple[float, float, float, str]:
    """Infer a centered active-sensor crop for the capture aspect ratio.

    Camera video modes commonly crop a 3:2 or 4:3 physical sensor to 16:9.
    Preserve square pixels by fitting the capture inside the declared sensor
    and cropping the excess physical dimension symmetrically.
    """
    capture_aspect = image_width_px / image_height_px
    sensor_aspect = sensor_width_mm / sensor_height_mm
    if capture_aspect > sensor_aspect:
        active_width = sensor_width_mm
        active_height = sensor_width_mm / capture_aspect
        crop_mode = "center_crop_height"
    else:
        active_width = sensor_height_mm * capture_aspect
        active_height = sensor_height_mm
        crop_mode = "center_crop_width"
    crop_x = (sensor_width_mm - active_width) / 2.0
    crop_y = (sensor_height_mm - active_height) / 2.0
    if max(crop_x, crop_y) < 1e-9:
        crop_mode = "none"
    pixel_scale = image_width_px / active_width
    return active_width, active_height, pixel_scale, crop_mode


def _volo_camera_rotation(stage_from_cv_camera: np.ndarray) -> np.ndarray:
    """Convert OpenCV camera-local basis to Volo/Three.js camera-local basis."""
    cv_from_volo_camera = np.diag([1.0, -1.0, -1.0])
    return np.asarray(stage_from_cv_camera, dtype=np.float64) @ cv_from_volo_camera


def _rotation_to_ptr(R: np.ndarray) -> tuple[float, float, float]:
    """Stage camera rotation → values consumed by Three.js Euler YXZ.

    ``gridScene.CameraFrustum`` constructs ``Euler(tilt, pan, roll, 'YXZ')``.
    Return that UI ordering so a solved matrix round-trips through the existing
    project camera schema without changing the rendered orientation.
    """
    m11, m13 = float(R[0, 0]), float(R[0, 2])
    m21, m22, m23 = float(R[1, 0]), float(R[1, 1]), float(R[1, 2])
    m31, m33 = float(R[2, 0]), float(R[2, 2])
    tilt = float(np.arcsin(-np.clip(m23, -1.0, 1.0)))
    if abs(m23) < 0.9999999:
        pan = float(np.arctan2(m13, m33))
        roll = float(np.arctan2(m21, m22))
    else:
        pan = float(np.arctan2(-m31, m11))
        roll = 0.0
    return (
        float(np.degrees(pan)),
        float(np.degrees(tilt)),
        float(np.degrees(roll)),
    )
