"""vpcal verify — field-verification patterns (architecture §3.3a, W9.1).

Distinct from ``tracker-free verify`` (camera pose verification from a single
image against known screens): ``verify mapping`` checks the LED processor's
input-canvas → physical-pixel mapping is genuinely 1:1, independent of any
tracker/screen calibration; ``verify overlay`` (plan Phase D, AR mode)
reprojects the calibrated marker truth back onto the capture frames for an
eyes-on acceptance check.
"""

from __future__ import annotations

import json
from pathlib import Path

import click

from vpcal.cli._common import (
    OperationOutput,
    StreamEmitter,
    common_options,
    run_operation,
    run_streaming_operation,
)
from vpcal.core.errors import ResourceNotFoundError


@click.group()
@click.pass_context
def verify(ctx: click.Context) -> None:
    """Field-verification patterns (LED processor canvas mapping, ...)."""


@verify.command(name="mapping")
@click.option("--generate", is_flag=True, help="Generate the mapping-verify pattern instead of checking a capture.")
@click.option("--width", type=int, help="Input canvas width (px). Required with --generate or --image.")
@click.option("--height", type=int, help="Input canvas height (px). Required with --generate or --image.")
@click.option("--out", "out_path", type=click.Path(), help="Output pattern PNG path (--generate).")
@click.option("--image", "image_path", type=click.Path(exists=True),
              help="Pixel-accurate mapping-verify capture to check (processor output frame grab, not a photo).")
@click.option("--scale-tol", type=float, default=None, help="Max |scale - 1| tolerance (default: processor_check.DEFAULT_SCALE_TOL).")
@click.option("--offset-tol-px", type=float, default=None, help="Max |offset| tolerance in px (default: processor_check.DEFAULT_OFFSET_TOL_PX).")
@common_options
@click.pass_context
def mapping(ctx, generate, width, height, out_path, image_path, scale_tol, offset_tol_px, **flags) -> None:
    """Verify (or generate) the 1:1 LED-processor canvas mapping test pattern.

    ``--generate --width W --height H --out pattern.png`` renders a test image
    with 5 fiducials (4 corners + centre) at known absolute pixel coordinates
    on the declared input canvas.  Play it full-screen on the processor input
    and record a PIXEL-ACCURATE capture of the processor's output (output
    frame grab / monitoring tap).  A camera photograph of the wall is NOT a
    valid input: the photo's perspective/framing is mathematically
    indistinguishable from a processor scale/offset, so even a genuine 1:1
    canvas would fail the check.

    ``--image capture.png --width W --height H`` (same W/H as generation)
    detects the fiducials in the capture, fits the input→physical affine
    mapping, and fails with a ``PreconditionError`` (exit 6) if it is not 1:1
    — printing the measured scale/offset so the processor config can be fixed.
    """

    def body() -> OperationOutput:
        from vpcal.core.errors import ArgumentError
        from vpcal.core.mapping_verify import generate_mapping_pattern, verify_mapping_image
        from vpcal.core.processor_check import DEFAULT_OFFSET_TOL_PX, DEFAULT_SCALE_TOL

        if generate:
            if not (width and height and out_path):
                raise ArgumentError("--generate requires --width, --height and --out")
            if flags.get("dry_run"):
                return OperationOutput(
                    data={"exit_code": 0, "dry_run_plan": {"width": width, "height": height, "out": out_path}},
                    text="Dry run OK.",
                )
            summary = generate_mapping_pattern(width, height, out_path)
            text = f"Generated mapping-verify pattern ({width}x{height}, {summary['marker_px']}px fiducials) → {out_path}"
            return OperationOutput(data=summary, text=text)

        if not image_path:
            raise ArgumentError("--image is required (or pass --generate)")
        if not (width and height):
            raise ArgumentError("--width and --height are required (the canvas resolution the pattern was generated at)")

        mapping_result = verify_mapping_image(
            image_path, width, height,
            scale_tol=scale_tol if scale_tol is not None else DEFAULT_SCALE_TOL,
            offset_tol_px=offset_tol_px if offset_tol_px is not None else DEFAULT_OFFSET_TOL_PX,
        )
        data = {
            "scale_x": mapping_result.scale_x, "scale_y": mapping_result.scale_y,
            "offset_x_px": mapping_result.offset_x_px, "offset_y_px": mapping_result.offset_y_px,
            "is_one_to_one": True,
        }
        text = (
            f"Mapping OK: 1:1 (scale {mapping_result.scale_x:.4f}/{mapping_result.scale_y:.4f}, "
            f"offset {mapping_result.offset_x_px:.2f}/{mapping_result.offset_y_px:.2f} px)"
        )
        return OperationOutput(data=data, text=text)

    run_operation("verify.mapping", body, **flags)


@verify.command(name="overlay")
@click.option("--config", "config_path", required=True, type=click.Path(), help="Session config JSON.")
@click.option("--result", "result_path", required=True, type=click.Path(), help="Solved result.json.")
@click.option("--out", "out_dir", type=click.Path(file_okay=False), default=None,
              help="Directory for annotated PNGs (omit for the error table only).")
@click.option("--limit", type=int, default=None, help="Only process the first N matched frames.")
@common_options
@click.pass_context
def overlay(ctx, config_path, result_path, out_dir, limit, **flags) -> None:
    """Overlay detected (green cross) vs reprojected (red circle) markers.

    The AR-mode "所见即所校" acceptance view (plan Phase D): the marker truth
    (marker map or screen) is reprojected through the solved calibration and
    drawn over every matched capture frame, with per-marker pixel errors.
    """

    def body() -> OperationOutput:
        from vpcal.cli.quick import _load_session
        from vpcal.core.overlay import overlay_session

        rp = Path(result_path)
        if not rp.exists():
            raise ResourceNotFoundError(f"result not found: {rp}", details={"path": str(rp)})
        session, _raw, session_dir = _load_session(config_path)
        result = json.loads(rp.read_text())
        if flags.get("dry_run"):
            return OperationOutput(
                data={"exit_code": 0, "dry_run_plan": {"out_dir": out_dir, "limit": limit}},
                text="Dry run OK.",
            )
        summary = overlay_session(
            session, session_dir, result, Path(out_dir) if out_dir else None, limit=limit
        )
        lines = [
            f"Overlay done: {summary['num_observations']} correspondences over "
            f"{summary['num_frames']} frame(s), RMS {summary['global_rms_px']:.2f} px "
            f"(max {summary['global_max_px']:.2f} px).",
            f"  {summary['legend']}",
        ]
        for row in sorted(summary["per_marker"], key=lambda r: -r["mean_px"])[:5]:
            lines.append(
                f"  {row['marker_id']:<24} mean {row['mean_px']:.2f} px  "
                f"max {row['max_px']:.2f} px  (n={row['count']})"
            )
        if summary["annotated_images"]:
            lines.append(f"  annotated → {Path(summary['annotated_images'][0]).parent}")
        return OperationOutput(data=summary, text="\n".join(lines))

    run_operation("verify.overlay", body, **flags)


@verify.command(name="live")
@click.option("--config", "config_path", required=True, type=click.Path(),
              help="Session config JSON (lens, truth source and tracking coordinates).")
@click.option("--result", "result_path", required=True, type=click.Path(),
              help="Solved result.json containing tracker-to-stage/camera transforms.")
@click.option("--backend", type=click.Choice(["uvc", "ndi", "decklink", "synthetic"]),
              default="uvc", show_default=True, help="Live camera backend.")
@click.option("--device", default="0", show_default=True,
              help="Device index (uvc/decklink) or source name (ndi).")
@click.option("--width", type=int, default=None, help="Requested frame width.")
@click.option("--height", type=int, default=None, help="Requested frame height.")
@click.option("--fps", type=float, default=None, help="Requested frame rate.")
@click.option("--transfer-function", default="sdr", show_default=True,
              help="Declared source transfer function.")
@click.option("--allow-hx", is_flag=True, help="Allow NDI|HX for this preview-only workflow.")
@click.option("--track-protocol", type=click.Choice(["freed", "opentrackio"]),
              default="freed", show_default=True, help="Tracking UDP protocol.")
@click.option("--track-port", type=int, default=6301, show_default=True,
              help="Tracking UDP port.")
@click.option("--track-host", default="0.0.0.0", show_default=True,
              help="Tracking UDP bind address.")
@click.option("--track-camera-id", default=None,
              help="FreeD camera ID to accept; packets from other IDs are ignored.")
@click.option("--tolerance", "timestamp_tolerance_s", type=click.FloatRange(min=0.0),
              default=0.05, show_default=True, help="Frame-to-tracking pairing tolerance in seconds.")
@click.option("--preview-port", type=int, default=0, show_default=True,
              help="Local MJPEG/WS preview port; 0 chooses a free port.")
@click.option("--duration", "duration_s", type=click.FloatRange(min=0.0), default=0.0,
              show_default=True, help="Run duration in seconds; 0 runs until stopped/source end.")
@click.option("--max-frames", type=click.IntRange(min=1), default=None,
              help="Stop after N camera frames.")
@click.option("--grid", "emit_grid", is_flag=True,
              help="Emit throttled overlay_grid NDJSON events (~15 Hz) for AR canvas; MJPEG stays clean.")
@common_options
@click.pass_context
def live(ctx, config_path, result_path, backend, device, width, height, fps,
         transfer_function, allow_hx, track_protocol, track_port, track_host,
         track_camera_id, timestamp_tolerance_s, preview_port, duration_s, max_frames,
         emit_grid, **flags) -> None:
    """Stream detected vs calibrated marker reprojections over a live camera feed."""

    def body(emitter: StreamEmitter) -> OperationOutput:
        from vpcal.cli.quick import _load_session
        from vpcal.core.capture_backend import CaptureConfig
        from vpcal.core.live_verify import LiveOverlay, run_live_verify

        result_file = Path(result_path)
        if not result_file.exists():
            raise ResourceNotFoundError(
                f"result not found: {result_file}", details={"path": str(result_file)}
            )
        session, _raw, session_dir = _load_session(config_path)
        result = json.loads(result_file.read_text())
        capture_config = CaptureConfig(
            backend=backend,
            device=device,
            width=width,
            height=height,
            fps=fps,
            transfer_function=transfer_function,
            extra={"allow_hx": allow_hx},
        )
        if flags.get("dry_run"):
            LiveOverlay(session, session_dir, result)
            return OperationOutput(
                data={
                    "dry_run_plan": {
                        "backend": backend,
                        "device": device,
                        "track_protocol": track_protocol,
                        "track_host": track_host,
                        "track_port": track_port,
                        "track_camera_id": (
                            track_camera_id if track_protocol == "freed" else None
                        ),
                        "preview_port": preview_port,
                    }
                },
                text="Dry run OK — calibration/truth source loaded; no devices opened.",
            )
        summary = run_live_verify(
            session,
            session_dir,
            result,
            capture_config,
            track_port=track_port,
            track_protocol=track_protocol,
            track_host=track_host,
            track_camera_id=track_camera_id if track_protocol == "freed" else None,
            timestamp_tolerance_s=timestamp_tolerance_s,
            preview_port=preview_port,
            duration_s=duration_s,
            max_frames=max_frames,
            emit_grid=emit_grid,
            event_callback=lambda kind, payload: emitter.emit(kind, payload),
        )
        return OperationOutput(
            data=summary,
            text=(
                f"Live verify stopped: {summary['annotated_frames']}/"
                f"{summary['frames']} frame(s) annotated, "
                f"{summary['num_observations']} observations, "
                f"RMS {summary['global_rms_px']} px."
            ),
        )

    run_streaming_operation("verify.live", body, **flags)
