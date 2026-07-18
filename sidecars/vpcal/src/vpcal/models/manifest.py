"""Contract Manifest model + the canonical vpcal manifest.

Per CLI_DESIGN_SPEC §2: a single Contract Manifest is the canonical source of
``operation_id`` identifiers that every adapter (CLI today; MCP/HTTP later)
aligns to.  ``vpcal manifest`` emits :func:`build_manifest` as JSON.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class SideEffects(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    writes: bool = False
    external_calls: bool = False
    idempotent: bool = True


class CliBinding(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    command: str
    supports_stdin: bool = False
    supports_dry_run: bool = True


class McpAnnotations(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    readOnlyHint: bool = False
    destructiveHint: bool = False
    idempotentHint: bool = True
    openWorldHint: bool = False


class McpBinding(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    tool_name: str
    annotations: McpAnnotations = Field(default_factory=McpAnnotations)


class Operation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    operation_id: str
    summary: str
    input_schema: dict[str, Any] = Field(default_factory=dict)
    output_schema: dict[str, Any] = Field(default_factory=dict)
    error_schema: dict[str, Any] = Field(default_factory=dict)
    side_effects: SideEffects = Field(default_factory=SideEffects)
    exit_codes: list[int] = Field(default_factory=list)
    cli: CliBinding
    mcp: McpBinding


class ContractManifest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    contract_version: str = "1.0"
    operations: list[Operation]


# Shared error envelope schema (CLI_DESIGN_SPEC §4.2 error object).
_ERROR_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "code": {"type": "string"},
        "exit_code": {"type": "integer"},
        "message": {"type": "string"},
        "retryable": {"type": "boolean"},
        "details": {"type": "object"},
    },
    "required": ["code", "exit_code", "message", "retryable"],
}


def _op(
    operation_id: str,
    summary: str,
    command: str,
    *,
    tool_name: str,
    exit_codes: list[int],
    input_schema: dict[str, Any] | None = None,
    output_schema: dict[str, Any] | None = None,
    supports_stdin: bool = False,
) -> Operation:
    return Operation(
        operation_id=operation_id,
        summary=summary,
        input_schema=input_schema or {},
        output_schema=output_schema or {},
        error_schema=_ERROR_SCHEMA,
        side_effects=SideEffects(writes=True, external_calls=False, idempotent=True),
        exit_codes=exit_codes,
        cli=CliBinding(
            command=command, supports_stdin=supports_stdin, supports_dry_run=True
        ),
        mcp=McpBinding(
            tool_name=tool_name,
            annotations=McpAnnotations(
                readOnlyHint=False, destructiveHint=False, idempotentHint=True
            ),
        ),
    )


def build_manifest() -> ContractManifest:
    """Return the canonical vpcal Contract Manifest (spec §13)."""
    # Imported lazily to keep this module importable without heavy deps.
    from vpcal.models.calibration import CalibrationResult
    from vpcal.models.session import SessionConfig

    session_schema = SessionConfig.model_json_schema()
    result_schema = CalibrationResult.model_json_schema()

    operations = [
        _op(
            "doctor",
            "Diagnose solver, OpenCV, NDI, and DeckLink runtime availability.",
            "vpcal doctor",
            tool_name="doctor",
            exit_codes=[0, 6],
        ),
        _op(
            "quick.run",
            "Run the full calibration pipeline (validate → detect → solve → report).",
            "vpcal quick run",
            tool_name="quick_run",
            exit_codes=[0, 1, 2, 3, 5, 6, 7, 9],
            input_schema=session_schema,
            output_schema=result_schema,
            supports_stdin=True,
        ),
        _op(
            "pattern.generate",
            "Generate VP-QCP calibration patterns for an LED screen.",
            "vpcal pattern generate",
            tool_name="pattern_generate",
            exit_codes=[0, 2, 3, 5],
        ),
        _op(
            "screen.create",
            "Create a screen definition JSON interactively or from parameters.",
            "vpcal screen create",
            tool_name="screen_create",
            exit_codes=[0, 2, 3],
        ),
        _op(
            "screen.import",
            "Import a screen definition from an OBJ mesh.",
            "vpcal screen import",
            tool_name="screen_import",
            exit_codes=[0, 2, 3, 5],
        ),
        _op(
            "simulate",
            "Generate a synthetic calibration dataset with known ground truth.",
            "vpcal simulate",
            tool_name="simulate",
            exit_codes=[0, 2, 3, 5],
        ),
        _op(
            "simulate.sweep",
            "Sweep each error source and tabulate solver sensitivity (error budget).",
            "vpcal simulate sweep",
            tool_name="simulate_sweep",
            exit_codes=[0, 2, 3, 5],
        ),
        _op(
            "report.generate",
            "Generate a QA report from a calibration result.",
            "vpcal report generate",
            tool_name="report_generate",
            exit_codes=[0, 2, 5],
        ),
        _op(
            "report.diff",
            "Compare two calibration results for drift (daily drift check).",
            "vpcal report diff",
            tool_name="report_diff",
            exit_codes=[0, 1, 2, 5],
        ),
        _op(
            "export.opentrackio",
            "Export calibrated tracking data as OpenTrackIO JSONL.",
            "vpcal export opentrackio",
            tool_name="export_opentrackio",
            exit_codes=[0, 2, 5, 6],
        ),
        _op(
            "export.ndisplay",
            "Export calibrated screen geometry + transforms for UE nDisplay.",
            "vpcal export ndisplay",
            tool_name="export_ndisplay",
            exit_codes=[0, 1, 2, 5],
        ),
        _op(
            "marker_map.create",
            "Import a survey CSV into a marker map JSON (AR ground-truth source).",
            "vpcal marker-map create",
            tool_name="marker_map_create",
            exit_codes=[0, 2, 5],
        ),
        _op(
            "marker_map.validate",
            "Geometric / degeneracy validation of a marker map.",
            "vpcal marker-map validate",
            tool_name="marker_map_validate",
            exit_codes=[0, 2, 5, 6],
        ),
        _op(
            "marker_map.board",
            "Generate printable ArUco/AprilTag marker boards + survey CSV template.",
            "vpcal marker-map board",
            tool_name="marker_map_board",
            exit_codes=[0, 2, 3],
        ),
        _op(
            "marker_map.cube",
            "Generate DIY calibration-cube face sheets + CAD-truth marker map.",
            "vpcal marker-map cube",
            tool_name="marker_map_cube",
            exit_codes=[0, 2, 3],
        ),
        _op(
            "marker_map.rebase",
            "Explicitly re-base a marker map's stage frame (e.g. --to-ground).",
            "vpcal marker-map rebase",
            tool_name="marker_map_rebase",
            exit_codes=[0, 2, 5, 6],
        ),
        _op(
            "verify.mapping",
            "Generate / check the 1:1 LED-processor canvas mapping test pattern.",
            "vpcal verify mapping",
            tool_name="verify_mapping",
            exit_codes=[0, 1, 2, 6],
        ),
        _op(
            "verify.overlay",
            "Overlay the reprojected marker truth on capture frames (AR acceptance).",
            "vpcal verify overlay",
            tool_name="verify_overlay",
            exit_codes=[0, 2, 5, 6],
        ),
        _op(
            "verify.live",
            "Stream live detected-vs-reprojected markers over an MJPEG preview.",
            "vpcal verify live",
            tool_name="verify_live",
            exit_codes=[0, 1, 2, 3, 5, 6],
        ),
        _op(
            "capture.delay_cal",
            "Calibrate the video↔tracking delay from a swing-test capture.",
            "vpcal capture delay-cal",
            tool_name="capture_delay_cal",
            exit_codes=[0, 2, 5, 6],
        ),
        _op(
            "capture.track",
            "Record or monitor a timestamped tracking stream from a live FreeD / OpenTrackIO source.",
            "vpcal capture track",
            tool_name="capture_track",
            exit_codes=[0, 1, 2, 5, 6],
        ),
        _op(
            "capture.list_devices",
            "Probe UVC device indices and report availability and negotiated format.",
            "vpcal capture list-devices",
            tool_name="capture_list_devices",
            exit_codes=[0, 1, 2, 6],
        ),
        _op(
            "capture.finalize",
            "Promote an interrupted incremental capture into a session.json.",
            "vpcal capture finalize",
            tool_name="capture_finalize",
            exit_codes=[0, 1, 2, 6],
        ),
        _op(
            "capture.enumerate",
            "Enumerate discoverable video sources for a supported backend.",
            "vpcal capture enumerate",
            tool_name="capture_enumerate",
            exit_codes=[0, 1, 2, 6],
        ),
        _op(
            "capture.video",
            "Capture a video stream via a backend (synthetic / uvc / ndi / decklink).",
            "vpcal capture video",
            tool_name="capture_video",
            exit_codes=[0, 1, 2, 6],
        ),
        _op(
            "capture.stills",
            "Tracker-free stills capture for grid rebuild: MJPEG preview + auto/manual "
            "snaps into captures/normal (no tracking, no capture_manifest).",
            "vpcal capture stills",
            tool_name="capture_stills",
            exit_codes=[0, 1, 2, 6],
        ),
        _op(
            "capture.session",
            "Closed-loop capture session: settle/burst state machine, live detect "
            "feedback, auto-assembled quick-run-ready session directory.",
            "vpcal capture session",
            tool_name="capture_session",
            exit_codes=[0, 1, 2, 5, 6],
        ),
        _op(
            "capture.playback",
            "Pattern playback host lives in the Volo player window (guiding stub).",
            "vpcal capture playback",
            tool_name="capture_playback",
            exit_codes=[0, 2, 6],
        ),
    ]
    return ContractManifest(contract_version="1.0", operations=operations)
