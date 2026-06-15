"""vpcal tracker-free — lens calibration + spatial solve without a tracking system."""

from __future__ import annotations

import json
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
        }
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
    return LensCalResult(
        fx=d["fx"], fy=d["fy"], cx=d["cx"], cy=d["cy"],
        dist_coeffs=d["dist_coeffs"], rms=d.get("rms", 0.0),
        num_images=d.get("num_images", 0), num_points=d.get("num_points", 0),
        image_size=tuple(d.get("image_size", [0, 0])),
    )


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
