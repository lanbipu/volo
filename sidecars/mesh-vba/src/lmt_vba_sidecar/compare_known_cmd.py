"""CLI run-function for the 'compare_known' subcommand.

Reads a cabinet_pose_report.json (reconstruct output) and a user-filled
known_geometry.json, computes per-cabinet size errors and per-pair
distance/angle errors via compare_known, and emits a CompareKnownResultEvent.
"""
from __future__ import annotations

import json
import pathlib

from lmt_vba_sidecar.compare_known import compare_known
from lmt_vba_sidecar.io_utils import write_event
from lmt_vba_sidecar.ipc import (
    CompareKnownInput,
    CompareKnownResultData,
    CompareKnownResultEvent,
    ErrorEvent,
)


def _load_json(path_str: str) -> dict | None:
    """Read+parse JSON, or emit an invalid_input ErrorEvent and return None."""
    path = pathlib.Path(path_str)
    if not path.exists():
        write_event(ErrorEvent(
            event="error",
            code="invalid_input",
            message=f"file not found: {path}",
            fatal=True,
        ))
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        write_event(ErrorEvent(
            event="error",
            code="invalid_input",
            message=f"file is not valid JSON ({path}): {exc}",
            fatal=True,
        ))
        return None


def run_compare_known(cmd: CompareKnownInput) -> int:
    report = _load_json(cmd.report_path)
    if report is None:
        return 1
    known = _load_json(cmd.known_path)
    if known is None:
        return 1

    try:
        result = compare_known(report, known, thresholds=cmd.thresholds)
    except (KeyError, ValueError) as exc:
        write_event(ErrorEvent(
            event="error",
            code="invalid_input",
            message=str(exc),
            fatal=True,
        ))
        return 1

    # `result` carries `pass` keys; CabinetSizeCheck aliases pass -> pass_.
    write_event(CompareKnownResultEvent(
        event="result",
        data=CompareKnownResultData.model_validate(result),
    ))
    return 0
