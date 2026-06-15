"""vpcal report — QA report generation (operation report.generate)."""

from __future__ import annotations

import json
from pathlib import Path

import click

from vpcal.cli._common import OperationOutput, common_options, run_operation
from vpcal.core.errors import ResourceNotFoundError


@click.group()
@click.pass_context
def report(ctx: click.Context) -> None:
    """Generate calibration reports."""


@report.command()
@click.option("--result", "result_path", required=True, type=click.Path(), help="Path to result.json.")
@click.option("--qa-dir", type=click.Path(file_okay=False), default=None, help="QA directory (default: alongside result).")
@common_options
@click.pass_context
def generate(ctx, result_path, qa_dir, **flags) -> None:
    """Consolidate a calibration result + QA into a report with suggestions."""

    def body() -> OperationOutput:
        rp = Path(result_path)
        if not rp.exists():
            raise ResourceNotFoundError(f"result not found: {rp}", details={"path": str(rp)})
        result = json.loads(rp.read_text())
        qa = Path(qa_dir) if qa_dir else rp.parent / "qa"
        reproj = _load_optional(qa / "reprojection.json")
        coverage = _load_optional(qa / "coverage.json")
        data = {"result": result, "reprojection": reproj, "coverage": coverage}
        return OperationOutput(data=data, text=_render(result, reproj, coverage))

    run_operation("report.generate", body, **flags)


@report.command()
@click.argument("result_a", type=click.Path())
@click.argument("result_b", type=click.Path())
@click.option("--trans-threshold-mm", type=float, default=2.0, show_default=True,
              help="Translation drift alert threshold (mm).")
@click.option("--rot-threshold-deg", type=float, default=0.05, show_default=True,
              help="Rotation drift alert threshold (deg).")
@common_options
@click.pass_context
def diff(ctx, result_a, result_b, trans_threshold_mm, rot_threshold_deg, **flags) -> None:
    """Compare two calibration results for drift (daily drift check).

    Reports translation / rotation drift of T_S_from_O and T_C_from_B plus the
    validation-RMS delta, flagging any value past the thresholds.  Read
    ``any_alert`` in the JSON envelope for scripted monitoring.
    """

    def body() -> OperationOutput:
        from vpcal.core.drift import compare_results, render_drift

        pa, pb = Path(result_a), Path(result_b)
        for p in (pa, pb):
            if not p.exists():
                raise ResourceNotFoundError(f"result not found: {p}", details={"path": str(p)})
        a = json.loads(pa.read_text())
        b = json.loads(pb.read_text())
        diff_data = compare_results(
            a, b, trans_threshold_mm=trans_threshold_mm, rot_threshold_deg=rot_threshold_deg,
        )
        return OperationOutput(data=diff_data, text=render_drift(diff_data, label_a=pa.name, label_b=pb.name))

    run_operation("report.diff", body, **flags)


def _load_optional(p: Path) -> dict | None:
    return json.loads(p.read_text()) if p.exists() else None


def _render(result: dict, reproj: dict | None, coverage: dict | None) -> str:
    q = result.get("quality", {})
    lines = [
        f"Calibration QA report (confidence: {q.get('confidence')})",
        f"  reprojection RMS : {q.get('reprojection_rms_px', 0):.4f} px",
        f"  observations     : {q.get('total_observations')} ({q.get('num_poses')} poses)",
        f"  outlier ratio    : {q.get('outlier_ratio', 0):.3f}",
    ]
    if reproj and reproj.get("lens_residual_check", {}).get("radial_pattern_detected"):
        lines.append("  ⚠ lens         : " + reproj["lens_residual_check"]["description"])
    if coverage:
        regions = coverage.get("sensor_coverage", {}).get("regions", {})
        missing = [k for k, v in regions.items() if not v]
        if missing:
            lines.append(f"  suggestion       : uncovered sensor regions ({', '.join(missing)}); add poses there.")
        for sec in coverage.get("screen_coverage", {}).get("per_section", []):
            if sec.get("percentage", 1.0) < 0.7:
                lines.append(
                    f"  suggestion       : section '{sec['name']}' only "
                    f"{sec['percentage']*100:.0f}% covered; capture more of it."
                )
    if q.get("confidence") in ("very_low", "low"):
        lines.append("  suggestion       : low confidence — add poses (8-15 recommended) and ensure >= 50 observations.")
    return "\n".join(lines)
