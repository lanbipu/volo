"""vpcal capture — real-time capture service (C1).

``track`` (C1.1) is implemented: listen for FreeD / OpenTrackIO over UDP and
record a timestamped tracking stream.  ``video`` (C1.2) and ``playback`` (C1.3)
need capture/display hardware and currently raise a clear precondition error
(see docs/c1-capture-service.md).
"""

from __future__ import annotations

import click

from vpcal.cli._common import OperationOutput, common_options, run_operation
from vpcal.core.errors import PreconditionError


@click.group()
@click.pass_context
def capture(ctx: click.Context) -> None:
    """Real-time capture service: tracking ingest, video, pattern playback."""


@capture.command(name="track")
@click.option("--protocol", type=click.Choice(["freed", "opentrackio"]), default="freed",
              show_default=True, help="Tracking wire protocol.")
@click.option("--port", type=int, required=True, help="UDP port to listen on.")
@click.option("--duration", "duration_s", type=float, default=30.0, show_default=True,
              help="Capture duration (seconds).")
@click.option("--host", default="0.0.0.0", show_default=True, help="Bind address.")
@click.option("--max-packets", type=int, default=None, help="Stop after N packets (optional).")
@click.option("--out", "out_path", required=True, type=click.Path(), help="Output poses.jsonl path.")
@common_options
@click.pass_context
def track(ctx, protocol, port, duration_s, host, max_packets, out_path, **flags) -> None:
    """Record a timestamped tracking stream from a live FreeD / OpenTrackIO source."""

    def body() -> OperationOutput:
        from vpcal.core.capture import COORDINATE_SYSTEM, capture_tracking_udp

        if flags.get("dry_run"):
            return OperationOutput(
                data={"exit_code": 0, "dry_run_plan": {"protocol": protocol, "port": port,
                                                        "duration_s": duration_s, "out": out_path}},
                text="Dry run OK.",
            )
        frames = capture_tracking_udp(
            port, protocol=protocol, duration_s=duration_s, host=host,
            max_packets=max_packets, out=out_path,
        )
        summary = {
            "output": out_path, "protocol": protocol,
            "coordinate_system": COORDINATE_SYSTEM[protocol], "frames": len(frames),
            "duration_s": frames[-1].timestamp_s if frames else 0.0,
        }
        return OperationOutput(
            data=summary,
            text=(f"Recorded {len(frames)} {protocol} frames → {out_path} "
                  f"(use coordinate_system='{COORDINATE_SYSTEM[protocol]}')"),
        )

    run_operation("capture.track", body, **flags)


def _hardware_stub(step: str, roadmap: str) -> None:
    raise PreconditionError(
        f"capture {step} ({roadmap}) requires capture/display hardware and is not yet "
        "implemented — see docs/c1-capture-service.md",
        details={"step": step, "roadmap": roadmap, "status": "scaffolded"},
    )


@capture.command(name="video")
@common_options
@click.pass_context
def video(ctx, **flags) -> None:
    """[C1.2 — hardware required] Capture an SDI/NDI/UVC video stream (scaffold)."""
    run_operation("capture.video", lambda: _hardware_stub("video", "C1.2"), **flags)


@capture.command(name="playback")
@common_options
@click.pass_context
def playback(ctx, **flags) -> None:
    """[C1.3 — hardware required] Drive synchronized pattern playback (scaffold)."""
    run_operation("capture.playback", lambda: _hardware_stub("playback", "C1.3"), **flags)
