"""vpcal simulate — synthetic calibration data generator (operation simulate).

``vpcal simulate --screen ...`` runs the dataset generator (the default, kept
flat for backward compatibility); ``vpcal simulate sweep ...`` runs the
error-budget sensitivity sweep (B1).  The group uses ``invoke_without_command``
so the bare form behaves exactly like the original single command.
"""

from __future__ import annotations

import click

from vpcal.cli._common import OperationOutput, common_options, run_operation
from vpcal.core.errors import ArgumentError


@click.group(invoke_without_command=True)
@click.option("--screen", "screen_path", type=click.Path(exists=True), help="Screen definition JSON.")
@click.option("--num-poses", type=int, default=10, show_default=True, help="Number of camera poses.")
@click.option("--noise-px", type=float, default=0.0, show_default=True, help="Gaussian pixel noise sigma.")
@click.option("--outlier-ratio", type=float, default=0.0, show_default=True, help="Fraction of outlier observations.")
@click.option("--output-dir", type=click.Path(file_okay=False), help="Output session directory.")
@click.option("--seed", type=int, default=0, show_default=True, help="Random seed.")
@click.option("--no-images", is_flag=True, help="Skip rendering camera images (faster).")
@click.option("--image-width", type=int, default=1920, show_default=True, help="Rendered image width (px).")
@click.option("--image-height", type=int, default=1080, show_default=True, help="Rendered image height (px).")
@common_options
@click.pass_context
def simulate(ctx, screen_path, num_poses, noise_px, outlier_ratio, output_dir, seed, no_images,
             image_width, image_height, **flags) -> None:
    """Generate a synthetic calibration dataset with known ground truth."""
    if ctx.invoked_subcommand is not None:
        return  # a subcommand (e.g. `sweep`) takes over

    def body() -> OperationOutput:
        from vpcal.core.simulator import default_lens, simulate_dataset
        from vpcal.io.screen_io import load_screen

        if not screen_path:
            raise ArgumentError("--screen is required")
        if not output_dir:
            raise ArgumentError("--output-dir is required")

        screen = load_screen(screen_path)
        if flags.get("dry_run"):
            plan = {"dry_run_plan": {"output_dir": output_dir, "num_poses": num_poses,
                                     "noise_px": noise_px, "render_images": not no_images}}
            return OperationOutput(data={"exit_code": 0, **plan}, text="Dry run OK.")
        lens = default_lens(image_width, image_height)
        summary = simulate_dataset(
            screen, output_dir, num_poses=num_poses, noise_px=noise_px,
            outlier_ratio=outlier_ratio, lens=lens, seed=seed, render_images=not no_images,
        )
        text = (
            f"Simulated {summary['num_poses']} poses, {summary['num_observations']} observations → "
            f"{summary['output_dir']}"
        )
        return OperationOutput(data=summary, text=text)

    run_operation("simulate", body, **flags)


@simulate.command(name="sweep")
@click.option("--screen", "screen_path", required=True, type=click.Path(exists=True), help="Screen definition JSON.")
@click.option("--out-csv", required=True, type=click.Path(dir_okay=False), help="Output CSV path for the sensitivity table.")
@click.option("--out-md", type=click.Path(dir_okay=False), default=None, help="Also write an error-budget.md report here.")
@click.option("--sources", default=None, help="Comma-separated subset of error sources (default: all).")
@click.option("--seeds", type=int, default=3, show_default=True, help="Seeds averaged per (source, magnitude) cell.")
@click.option("--num-poses", type=int, default=12, show_default=True, help="Camera poses per simulated session.")
@click.option("--holdout-ratio", type=float, default=0.25, show_default=True, help="Validation hold-out fraction.")
@click.option("--no-cpp", is_flag=True, help="Force the scipy solver backend.")
@common_options
@click.pass_context
def sweep(ctx, screen_path, out_csv, out_md, sources, seeds, num_poses, holdout_ratio, no_cpp, **flags) -> None:
    """Sweep each error source and tabulate solver sensitivity (B1 error budget)."""

    def body() -> OperationOutput:
        from vpcal.core.sweep import (SWEEP_SOURCES, format_error_budget_md, run_sweep,
                                      write_csv)
        from vpcal.io.screen_io import load_screen

        screen = load_screen(screen_path)
        src_list = [s.strip() for s in sources.split(",")] if sources else None
        if src_list:
            unknown = [s for s in src_list if s not in SWEEP_SOURCES]
            if unknown:
                raise ArgumentError(f"unknown error source(s): {unknown}; valid: {list(SWEEP_SOURCES)}")

        if flags.get("dry_run"):
            return OperationOutput(
                data={"exit_code": 0, "dry_run_plan": {"sources": src_list or list(SWEEP_SOURCES),
                                                       "seeds": seeds, "out_csv": out_csv}},
                text="Dry run OK.",
            )

        cells = run_sweep(screen, sources=src_list, seeds=seeds, num_poses=num_poses,
                          holdout_ratio=holdout_ratio, prefer_cpp=not no_cpp)
        write_csv(cells, out_csv)
        meta = {"num_poses": num_poses, "seeds": seeds, "holdout_ratio": holdout_ratio,
                "backend": "scipy" if no_cpp else "ceres-preferred", "screen_name": screen.name}
        if out_md:
            from pathlib import Path
            Path(out_md).write_text(format_error_budget_md(cells, meta=meta))

        # Rank STATIC main-path sources on a common mm basis (realistic working
        # magnitude). Timing is reported separately — it is moving-path-only and
        # constructively zero on the static main path, so it is NOT a comparable
        # peer of the static sources (avoids the apples-to-oranges "dominant source").
        from vpcal.core.sweep import _interpolate_trans_err, rank_static_sources
        ranked = rank_static_sources(cells)  # [(source, magnitude, err_mm)]
        moving_1f = _interpolate_trans_err(cells, "temporal_moving", 1.0)
        summary = {
            "cells": len(cells), "csv": out_csv, "md": out_md,
            "basis": "trans_err_mm @ realistic working magnitude (static main path)",
            "dominant_static_source": ranked[0][0] if ranked else None,
            "static_ranking": [{"source": s, "magnitude": m, "trans_err_mm": round(e, 4)}
                               for s, m, e in ranked],
            "moving_timing_mm_per_frame": round(moving_1f, 3) if moving_1f is not None else None,
        }
        text = (f"Sweep done: {len(cells)} cells → {out_csv}"
                + (f", {out_md}" if out_md else "")
                + f"\n  static main-path dominant source: {summary['dominant_static_source']}"
                + (f"\n  moving-capture timing: ~{summary['moving_timing_mm_per_frame']} mm / frame"
                   if summary['moving_timing_mm_per_frame'] is not None else ""))
        return OperationOutput(data=summary, text=text)

    run_operation("simulate.sweep", body, **flags)
