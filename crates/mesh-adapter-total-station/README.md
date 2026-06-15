# mesh-adapter-total-station

M1 adapter: total-station CSV + project YAML → `mesh_core::MeasuredPoints` +
JSON validation report + instruction card (PDF + HTML).

## Single-screen scope (M1.1)

Currently supports **one screen per project** (`MAIN`). The first 3
CSV rows must be the user-selected reference points (origin / X-axis /
XY-plane), per the field SOP. Multi-screen attribution (FLOOR + others)
is M1.2.

## Public API

```rust
use mesh_adapter_total_station::{
    csv_parser::parse_csv,
    project_loader::load_project,
    builder::{build_screen_measured_points, build_screen_measured_points_with_outcome},
    report_builder::build_screen_report,
    instruction_card::{html::generate_html, pdf::generate_pdf, InstructionCard},
};
```

## Pipeline

1. `parse_csv` — Trimble/Leica CSV (mm, instrument-numbered) → `Vec<RawPoint>`
   - validates finite coords, rejects duplicates and id=0
2. `load_project` — YAML → `ProjectConfig` (calls `ProjectConfig::validate()`)
3. `build_screen_measured_points` — first 3 raw points build the coord
   frame (Y/Z basis permuted to match M0.1 row=+Z convention);
   transforms every point to model frame, computes nominal grid for the
   screen, KD-tree-matches measured points to grid names, fabricates
   bottom-row fallback when `bottom_completion` is set
4. `build_screen_report` — counts measured / fabricated / missing /
   outliers / ambiguous; warns on low coverage and fabricated rows
5. Pass `MeasuredPoints` to `mesh_core::reconstruct::auto_reconstruct`,
   then `mesh_core::export::targets::{Disguise|Unreal|Neutral}Target::export`

## Spec

`docs/superpowers/specs/2026-05-10-led-mesh-toolkit-design.md` §4
