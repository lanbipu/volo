"""vpcal quick — one-shot calibration pipeline (operation quick.run)."""

from __future__ import annotations

import json
from pathlib import Path

import click

from vpcal.cli._common import OperationOutput, common_options, run_operation
from vpcal.core.errors import ArgumentError, ConfigError
from vpcal.models.session import SessionConfig


@click.group()
@click.pass_context
def quick(ctx: click.Context) -> None:
    """Run the quick calibration pipeline (validate → detect → solve → report)."""


def _load_session(config_path: str) -> tuple[SessionConfig, dict, Path]:
    p = Path(config_path)
    if not p.exists():
        raise ConfigError(f"session config not found: {p}", details={"path": str(p)})
    try:
        raw = json.loads(p.read_text())
    except json.JSONDecodeError as exc:
        raise ArgumentError(f"session config is not valid JSON: {exc}", details={"path": str(p)}) from exc
    try:
        session = SessionConfig.model_validate(raw)
    except Exception as exc:  # noqa: BLE001 — pydantic ValidationError → argument error
        raise ArgumentError(f"session config validation failed: {exc}") from exc
    return session, raw, p.parent


@quick.command()
@click.option("--config", "config", required=True, type=click.Path(), help="Path to a session config JSON.")
@click.option(
    "--stage",
    type=click.Choice(["validate", "detect", "solve", "report"], case_sensitive=False),
    default=None,
    help="Run only up to this stage.",
)
@click.option("--output-dir", type=click.Path(file_okay=False), default=None, help="Directory for outputs.")
@click.option("--per-marker", is_flag=True, help="Include per-marker detail in the QA report.")
@click.option("--scipy", "force_scipy", is_flag=True, help="Force the scipy fallback solver.")
@click.option("--estimate-lens", is_flag=True, default=None,
              help="Enable Quick Lens Estimate (Level 2): jointly estimate lens params with no master lens.")
@click.option("--lens-params", default=None,
              help="Comma-separated lens params to free, e.g. 'k1,k2,cx,cy' (overrides config).")
@click.option("--refine-focal", is_flag=True, default=None, help="Also estimate focal length (gated opt-in).")
@click.option("--handeye-init", "handeye_init", is_flag=True, default=False,
              help="Force closed-form hand-eye initialisation of T_C_from_B "
                   "(automatic when no tracker_to_camera_prior is configured).")
@click.option("--cv2-bootstrap", is_flag=True, default=None,
              help="Seed lens init with cv2.calibrateCamera (init-only).")
@common_options
@click.pass_context
def run(ctx, config, stage, output_dir, per_marker, force_scipy,
        estimate_lens, lens_params, refine_focal, handeye_init, cv2_bootstrap, **flags) -> None:
    """Execute the quick calibration pipeline."""

    def body() -> OperationOutput:
        from vpcal.core.pipeline import run_quick

        session, raw, session_dir = _load_session(config)
        _apply_lens_estimate_overrides(session, estimate_lens, lens_params, refine_focal, cv2_bootstrap)
        out_dir = Path(output_dir) if output_dir else session_dir / "output"
        result = run_quick(
            session, session_dir, out_dir,
            raw_session=raw, stage=stage, dry_run=flags.get("dry_run", False),
            per_marker=per_marker, prefer_cpp=not force_scipy, handeye_init=handeye_init,
        )
        text = _render_text(result)
        return OperationOutput(data=result, text=text, exit_code=result.get("exit_code", 0))

    run_operation("quick.run", body, **flags)


def _apply_lens_estimate_overrides(session, estimate_lens, lens_params, refine_focal, cv2_bootstrap) -> None:
    """Apply CLI lens-estimate flags onto the loaded session (CLI overrides config)."""
    le = session.solver.lens_estimate
    if estimate_lens:
        le.enabled = True
    if lens_params is not None:
        parts = {p.strip() for p in lens_params.split(",") if p.strip()}
        bad = parts - {"k1", "k2", "cx", "cy"}
        if bad:
            raise ArgumentError(f"unknown --lens-params: {sorted(bad)}; allowed: k1,k2,cx,cy")
        if "k2" in parts and "k1" not in parts:
            raise ArgumentError("--lens-params: 'k2' requires 'k1'")
        le.params = parts  # type: ignore[assignment]
        le.enabled = True
    if refine_focal:
        le.refine_focal = True
        le.enabled = True
    if cv2_bootstrap:
        le.cv2_bootstrap = True
        le.enabled = True


def _render_text(result: dict) -> str:
    if "dry_run_plan" in result:
        return "Dry run OK — validation passed. Stages: validate → detect → solve → report."
    if result.get("stage"):
        return f"Stage '{result['stage']}' complete."
    q = result.get("result", {}).get("quality", {})
    lines = [
        f"Calibration complete (confidence: {result.get('confidence')}, backend: {result.get('solver_backend')}).",
        f"  reprojection RMS : {q.get('reprojection_rms_px', 0):.4f} px",
        f"  observations     : {q.get('total_observations')} ({q.get('num_poses')} poses, "
        f"{q.get('inlier_observations')} inliers)",
        f"  outputs written  : {result.get('output_dir')}",
    ]
    cov = result.get("qa", {}).get("coverage", {}).get("sensor_coverage", {}).get("regions", {})
    missing = [k for k, v in cov.items() if not v]
    if missing:
        lines.append(f"  suggestion       : sensor regions uncovered: {', '.join(missing)} — add poses there.")
    lines += _render_lens_estimate(q.get("lens_estimate"))
    qa = result.get("qa", {})
    ground = qa.get("ground_plane")
    if ground and ground.get("available"):
        lines.append(
            f"  ground plane     : residual RMS {ground['residual_rms_mm']:.2f} mm, "
            f"tilt {ground['tilt_from_z_deg']:.3f}°, offset {ground['offset_from_z0_mm']:.2f} mm"
        )
        for w in ground.get("warnings", []):
            lines.append(f"  ⚠ {w}")
    alignment = qa.get("world_alignment")
    if alignment:
        grade = alignment.get("grade", "n/a")
        max_u = alignment.get("max_uncertainty_mm")
        lines.append(
            "  world alignment  : " + grade
            + (f" (max declared uncertainty {max_u:.1f} mm)" if max_u is not None else " (no uncertainty declared)")
        )
    offsets = qa.get("tracker_offsets")
    if offsets:
        from vpcal.core.tracker_offsets import render_offsets_text

        lines += render_offsets_text(offsets)
    return "\n".join(lines)


def _render_lens_estimate(est: dict | None) -> list[str]:
    """Render the session-coupled Quick Lens Estimate block (QLE spec §6.4)."""
    if not est:
        return []
    lines = ["", "QUICK LENS ESTIMATE (Session-Coupled, Non-Master):",
             f"  confidence       : {est.get('confidence')}"]

    def fmt(name: str, p: dict | None, unit: str) -> None:
        if not p:
            return
        if p.get("observable"):
            std = p.get("std")
            std_s = f" ± {std:.4g}" if std is not None else ""
            lines.append(f"  {name:<16}: KEPT  {p['value']:.5g}{std_s} {unit}")
        else:
            lines.append(f"  {name:<16}: LOCKED ({p.get('locked_reason', 'n/a')})")

    fmt("focal_length_mm", est.get("focal_length_mm"), "mm")
    pp = est.get("principal_point_offset_mm")
    if pp:
        fmt("cx_offset_mm", pp[0], "mm")
        fmt("cy_offset_mm", pp[1], "mm")
    fmt("distortion_k1", est.get("distortion_k1"), "")
    fmt("distortion_k2", est.get("distortion_k2"), "")
    lines.append(
        f"  RMS              : spatial-only {est.get('spatial_only_rms_px', 0):.4f} → "
        f"refined {est.get('refined_rms_px', 0):.4f} px"
    )
    for f in est.get("identifiability_flags", []):
        lines.append(f"  ! {f}")
    lines.append("  ⚠ SESSION-COUPLED estimate — NOT a master lens, DO NOT reuse across stage/lens setups.")
    lines.append("    For a reusable master lens, run offline chart calibration (Level 5).")
    return lines
