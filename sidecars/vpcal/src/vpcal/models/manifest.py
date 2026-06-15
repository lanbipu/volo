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
            exit_codes=[0, 2, 5],
        ),
        _op(
            "export.ndisplay",
            "Export calibrated screen geometry + transforms for UE nDisplay.",
            "vpcal export ndisplay",
            tool_name="export_ndisplay",
            exit_codes=[0, 1, 2, 5],
        ),
        _op(
            "capture.track",
            "Record a timestamped tracking stream from a live FreeD / OpenTrackIO source.",
            "vpcal capture track",
            tool_name="capture_track",
            exit_codes=[0, 1, 2, 5, 6],
        ),
        _op(
            "capture.video",
            "Capture an SDI/NDI/UVC video stream (scaffold — requires hardware).",
            "vpcal capture video",
            tool_name="capture_video",
            exit_codes=[0, 2, 6],
        ),
        _op(
            "capture.playback",
            "Drive synchronized pattern playback (scaffold — requires hardware).",
            "vpcal capture playback",
            tool_name="capture_playback",
            exit_codes=[0, 2, 6],
        ),
    ]
    return ContractManifest(contract_version="1.0", operations=operations)
