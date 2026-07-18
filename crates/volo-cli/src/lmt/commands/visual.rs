//! `lmt visual ...` subcommands. Thin transport: parse → call mesh_app::visual → envelope.
//! No business logic here; all logic lives in mesh_app::visual.

use crate::lmt::cli::{SeqFormat, VisualCmd};
use crate::lmt::commands::util::{self, DestructiveDecision};
use crate::lmt::output::{self, Mode};
use volo_shared::envelope::{error_codes, ApiError};
use std::io::Write as _;
use std::path::Path;

/// Print any non-fatal warnings a sidecar-backed command collected onto its result.
/// The sidecar's live WarningEvents are dropped on this headless path (no progress
/// consumer), so the durable `warnings` field is the only place they surface in human mode;
/// `--json` carries the same list in the envelope. Written to STDERR (matching the
/// total-station import warnings convention) so a `> result.txt` redirect of stdout stays
/// clean. No-op when the run was clean.
fn print_warnings(warnings: &[volo_shared::dto::WarningDto]) {
    for w in warnings {
        let loc = w
            .cabinet
            .as_deref()
            .map(|c| format!(" ({c})"))
            .unwrap_or_default();
        let _ = writeln!(std::io::stderr(), "  warning [{}]{} {}", w.code, loc, w.message);
    }
}

pub fn run(cmd: VisualCmd, mode: Mode, yes: bool, dry_run: bool) -> i32 {
    match cmd {
        VisualCmd::Reconstruct {
            project_path,
            screen_id,
            capture_manifest,
            images,
            method,
            intrinsics,
            intrinsics_crosscheck,
        } => reconstruct(
            mode,
            &project_path,
            &screen_id,
            capture_manifest,
            images,
            &method,
            intrinsics.as_deref(),
            intrinsics_crosscheck.as_deref(),
            yes,
            dry_run,
        ),
        VisualCmd::Simulate { config, out } => simulate(mode, &config, &out, yes, dry_run),
        VisualCmd::Eval {
            dataset,
            method,
            seed_matrix,
            init,
        } => eval(mode, &dataset, &method, seed_matrix, &init),
        VisualCmd::CompareKnown { report, known, max_size_mm, max_dist_mm, max_angle_deg } => {
            compare_known(mode, &report, &known, max_size_mm, max_dist_mm, max_angle_deg)
        }
        VisualCmd::PlanCapture {
            project_path,
            screen_id,
            image_size,
            hfov_deg,
            vfov_deg,
            standoff,
            height,
            target_mm,
            trials,
            seed,
            min_views,
        } => plan_capture(
            mode,
            &project_path,
            &screen_id,
            &image_size,
            hfov_deg,
            vfov_deg,
            &standoff,
            &height,
            target_mm,
            trials,
            seed,
            min_views,
        ),
        VisualCmd::CaptureCard {
            project_path,
            screen_id,
            image_size,
            hfov_deg,
            vfov_deg,
            standoff,
            height,
            target_mm,
            trials,
            seed,
        } => capture_card(
            mode,
            &project_path,
            &screen_id,
            &image_size,
            hfov_deg,
            vfov_deg,
            &standoff,
            &height,
            target_mm,
            trials,
            seed,
        ),
        VisualCmd::Calibrate {
            project_path,
            screen_id,
            checkerboard_dir,
            square_mm,
            inner,
        } => calibrate(
            mode,
            &project_path,
            &screen_id,
            &checkerboard_dir,
            square_mm,
            &inner,
            yes,
            dry_run,
        ),
        VisualCmd::GeneratePattern {
            project_path,
            screen_id,
            method,
            screen_id_code,
            screen_mapping,
        } => generate_pattern(
            mode, &project_path, &screen_id, &method, screen_id_code,
            screen_mapping.as_deref(), yes, dry_run,
        ),
        VisualCmd::GenerateStructuredLight {
            project_path,
            screen_id,
            dot_spacing,
            dot_radius,
            margin,
            seq_format,
            screen_mapping,
        } => generate_structured_light(
            mode, &project_path, &screen_id, dot_spacing, dot_radius, margin, seq_format,
            screen_mapping.as_deref(), yes, dry_run,
        ),
        VisualCmd::DecodeStructuredLight {
            input_path,
            sl_meta,
            out,
            sentinel_threshold,
            screen_roi,
            emit_debug_image,
        } => decode_structured_light(
            mode, &input_path, &sl_meta, &out, sentinel_threshold,
            screen_roi.as_deref(), emit_debug_image, yes, dry_run,
        ),
        VisualCmd::ReconstructStructuredLight {
            project_path,
            screen_id,
            sl_meta,
            intrinsics,
            correspondences,
            intrinsics_crosscheck,
        } => reconstruct_structured_light(
            mode, &project_path, &screen_id, &sl_meta, &intrinsics,
            intrinsics_crosscheck.as_deref(), &correspondences, yes, dry_run,
        ),
        VisualCmd::CalibrateStructuredLight {
            project_path,
            screen_id,
            sl_meta,
            correspondences,
            out,
            force,
            max_rms_px,
            intrinsics_crosscheck,
        } => calibrate_structured_light(
            mode, &project_path, &screen_id, &sl_meta, &correspondences,
            out.as_deref(), force, max_rms_px, intrinsics_crosscheck.as_deref(), yes, dry_run,
        ),
    }
}

// ---------------------------------------------------------------------------
// reconstruct
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn reconstruct(
    mode: Mode,
    project_path: &str,
    screen_id: &str,
    capture_manifest: Option<String>,
    images: Option<String>,
    method: &str,
    intrinsics: Option<&str>,
    intrinsics_crosscheck: Option<&str>,
    yes: bool,
    dry_run: bool,
) -> i32 {
    // vpqsp (default) + charuco are implemented; the manifest's own `method` is
    // authoritative for the actual detection path. structured-light is gated (spec §16).
    if method != "charuco" && method != "vpqsp" {
        return output::err(
            mode,
            ApiError::new(
                error_codes::UNSUPPORTED,
                "only --method vpqsp|charuco implemented (structured-light is gated, spec §16)",
            ),
        );
    }

    // Resolve manifest path from the two mutually-exclusive convenience args.
    let manifest = match (capture_manifest, images) {
        (Some(m), _) => m,
        (None, Some(_)) => {
            return output::err(
                mode,
                ApiError::new(
                    error_codes::UNSUPPORTED,
                    "--images convenience not yet wired; pass --capture-manifest",
                ),
            );
        }
        (None, None) => {
            return output::err(
                mode,
                ApiError::new(
                    error_codes::INVALID_INPUT,
                    "need --capture-manifest <json> (or --images <dir>)",
                ),
            );
        }
    };

    let decision = match util::gate_destructive(yes, dry_run, "visual reconstruct") {
        Ok(d) => d,
        Err(e) => return output::err(mode, e),
    };

    match decision {
        DestructiveDecision::DryRun => {
            // Match run_reconstruct's actual write targets: both files land under
            // <project>/measurements/. Use a vec! array (machine-parsable, no '+'
            // ambiguity), mirroring total_station's grid dry-run branch.
            // FIX-13 ④: visual 重建只写 pose report,不再碰 measured.yaml。
            let would_write = vec![
                format!("{project_path}/measurements/{screen_id}_cabinet_pose_report.json"),
            ];
            let payload = serde_json::json!({
                "dry_run": true,
                "would_write": would_write,
                "capture_manifest": manifest,
                // null = use the manifest's intrinsics; "auto" = self-calibrate.
                "intrinsics": intrinsics,
                "intrinsics_crosscheck": intrinsics_crosscheck,
            });
            output::ok(mode, payload, |_| {
                let _ = writeln!(
                    std::io::stdout(),
                    "[dry-run] would reconstruct screen {screen_id} from manifest {manifest}"
                );
            })
        }
        DestructiveDecision::Execute => {
            match mesh_app::visual::run_reconstruct(
                Path::new(project_path),
                &[screen_id.to_string()],
                Path::new(&manifest),
                intrinsics,
                intrinsics_crosscheck,
            ) {
                Ok(r) => output::ok(mode, r, |p| {
                    let _ = writeln!(
                        std::io::stdout(),
                        "reconstructed {} cabinets (ba_rms={:.3}px)\n  poses: {}",
                        p.cabinet_count,
                        p.ba_rms_px,
                        p.pose_report_path
                    );
                    print_warnings(&p.warnings);
                }),
                Err(e) => output::err(mode, ApiError::from(e)),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// calibrate
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn calibrate(
    mode: Mode,
    project_path: &str,
    screen_id: &str,
    checkerboard_dir: &str,
    square_mm: f64,
    inner: &str,
    yes: bool,
    dry_run: bool,
) -> i32 {
    let decision = match util::gate_destructive(yes, dry_run, "visual calibrate") {
        Ok(d) => d,
        Err(e) => return output::err(mode, e),
    };

    match decision {
        DestructiveDecision::DryRun => {
            let payload = serde_json::json!({
                "dry_run": true,
                "would_write": format!("{project_path}/calibration/{screen_id}_intrinsics.json"),
                "checkerboard_dir": checkerboard_dir,
                "square_mm": square_mm,
                "inner": inner,
            });
            output::ok(mode, payload, |_| {
                let _ = writeln!(
                    std::io::stdout(),
                    "[dry-run] would calibrate screen {screen_id} from {checkerboard_dir}"
                );
            })
        }
        DestructiveDecision::Execute => {
            match mesh_app::visual::run_calibrate(
                Path::new(project_path),
                screen_id,
                Path::new(checkerboard_dir),
                square_mm,
                inner,
            ) {
                Ok(r) => output::ok(mode, r, |p| {
                    let _ = writeln!(
                        std::io::stdout(),
                        "calibrated: reproj={:.3}px frames={} → {}",
                        p.reproj_error_px,
                        p.frames_used,
                        p.intrinsics_path
                    );
                    print_warnings(&p.warnings);
                }),
                Err(e) => output::err(mode, ApiError::from(e)),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// generate_pattern
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn generate_pattern(
    mode: Mode,
    project_path: &str,
    screen_id: &str,
    method: &str,
    screen_id_code: u8,
    screen_mapping: Option<&str>,
    yes: bool,
    dry_run: bool,
) -> i32 {
    if method != "charuco" && method != "vpqsp" {
        return output::err(
            mode,
            ApiError::new(
                error_codes::UNSUPPORTED,
                format!("unsupported pattern method '{method}' (expected 'vpqsp' or 'charuco')"),
            ),
        );
    }

    let decision = match util::gate_destructive(yes, dry_run, "visual generate-pattern") {
        Ok(d) => d,
        Err(e) => return output::err(mode, e),
    };

    match decision {
        DestructiveDecision::DryRun => {
            let payload = serde_json::json!({
                "dry_run": true,
                "would_write": format!("{project_path}/patterns/{screen_id}/"),
                "method": method,
            });
            output::ok(mode, payload, |_| {
                let _ = writeln!(
                    std::io::stdout(),
                    "[dry-run] would generate {method} patterns for screen {screen_id}"
                );
            })
        }
        DestructiveDecision::Execute => {
            match mesh_app::visual::run_generate_pattern(
                Path::new(project_path),
                screen_id,
                method,
                screen_id_code,
                screen_mapping.map(Path::new),
            ) {
                Ok(r) => output::ok(mode, r, |p| {
                    let _ = writeln!(
                        std::io::stdout(),
                        "generated {} cabinets, {} total markers → {}",
                        p.cabinet_count,
                        p.total_markers,
                        p.output_dir
                    );
                    print_warnings(&p.warnings);
                }),
                Err(e) => output::err(mode, ApiError::from(e)),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// generate_structured_light
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn generate_structured_light(
    mode: Mode,
    project_path: &str,
    screen_id: &str,
    dot_spacing: Option<u32>,
    dot_radius: u32,
    margin: Option<u32>,
    seq_format: SeqFormat,
    screen_mapping: Option<&str>,
    yes: bool,
    dry_run: bool,
) -> i32 {
    let decision = match util::gate_destructive(yes, dry_run, "visual generate-structured-light") {
        Ok(d) => d,
        Err(e) => return output::err(mode, e),
    };

    match decision {
        DestructiveDecision::DryRun => {
            let payload = serde_json::json!({
                "dry_run": true,
                "would_write": format!("{project_path}/patterns/{screen_id}/sl/"),
            });
            output::ok(mode, payload, |_| {
                let _ = writeln!(
                    std::io::stdout(),
                    "[dry-run] would generate structured-light sequence for screen {screen_id}"
                );
            })
        }
        DestructiveDecision::Execute => {
            let emit_tiff_seq = match seq_format {
                SeqFormat::Auto => None,
                SeqFormat::None => Some(false),
                SeqFormat::Tiff => Some(true),
            };
            match mesh_app::visual::run_generate_structured_light(
                Path::new(project_path),
                screen_id,
                dot_spacing,
                dot_radius,
                margin,
                emit_tiff_seq,
                screen_mapping.map(Path::new),
            ) {
                Ok(r) => output::ok(mode, r, |p| {
                    let _ = writeln!(
                        std::io::stdout(),
                        "generated {} dots across {} frames → {}",
                        p.n_dots,
                        p.n_frames,
                        p.output_dir
                    );
                }),
                Err(e) => output::err(mode, ApiError::from(e)),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// decode_structured_light
// ---------------------------------------------------------------------------

/// Parse a `X,Y,W,H` ROI string into four u32. Returns None on any malformed
/// part (mapped by the caller to INVALID_INPUT before the destructive gate).
fn parse_screen_roi(s: &str) -> Option<[u32; 4]> {
    let parts: Vec<&str> = s.split(',').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut out = [0u32; 4];
    for (i, p) in parts.iter().enumerate() {
        out[i] = p.trim().parse::<u32>().ok()?;
    }
    Some(out)
}

#[allow(clippy::too_many_arguments)]
fn decode_structured_light(
    mode: Mode,
    input_path: &str,
    sl_meta: &str,
    out: &str,
    sentinel_threshold: Option<f64>,
    screen_roi: Option<&str>,
    emit_debug_image: bool,
    yes: bool,
    dry_run: bool,
) -> i32 {
    // Validate ROI format BEFORE the destructive gate, so --dry-run does not
    // falsely report success for a command that would always fail on execute
    // (mirrors reconstruct-structured-light's >=2-corr pre-check).
    let roi: Option<[u32; 4]> = match screen_roi {
        Some(s) => match parse_screen_roi(s) {
            Some(r) => Some(r),
            None => {
                return output::err(
                    mode,
                    ApiError::new(
                        error_codes::INVALID_INPUT,
                        "--screen-roi must be four comma-separated non-negative integers: X,Y,W,H",
                    ),
                );
            }
        },
        None => None,
    };

    let decision = match util::gate_destructive(yes, dry_run, "visual decode-structured-light") {
        Ok(d) => d,
        Err(e) => return output::err(mode, e),
    };

    match decision {
        DestructiveDecision::DryRun => {
            let mut would_write = vec![out.to_string()];
            if emit_debug_image {
                would_write.push(format!("{out}.debug.png"));
            }
            let payload = serde_json::json!({
                "dry_run": true,
                "would_write": would_write,
            });
            output::ok(mode, payload, |_| {
                let _ = writeln!(std::io::stdout(), "[dry-run] would decode → {out}");
            })
        }
        DestructiveDecision::Execute => {
            match mesh_app::visual::run_decode_structured_light(
                Path::new(input_path),
                Path::new(sl_meta),
                Path::new(out),
                sentinel_threshold,
                roi,
                emit_debug_image,
            ) {
                Ok(r) => output::ok(mode, r, |p| {
                    let _ = writeln!(
                        std::io::stdout(),
                        "decoded {} dots → {}",
                        p.n_dots_decoded,
                        p.output_path
                    );
                }),
                Err(e) => output::err(mode, ApiError::from(e)),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// reconstruct_structured_light
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn reconstruct_structured_light(
    mode: Mode,
    project_path: &str,
    screen_id: &str,
    sl_meta: &str,
    intrinsics: &str,
    intrinsics_crosscheck: Option<&str>,
    correspondences: &[String],
    yes: bool,
    dry_run: bool,
) -> i32 {
    // Enforce the >= 2 camera-pose contract (mirrors the sidecar's min_length=2)
    // BEFORE the gate, so --dry-run doesn't falsely report success for a command
    // that would always fail on execute.
    if correspondences.len() < 2 {
        return output::err(
            mode,
            ApiError::new(
                error_codes::INVALID_INPUT,
                "reconstruct-structured-light needs >= 2 --corr files (one per camera pose)",
            ),
        );
    }
    let decision =
        match util::gate_destructive(yes, dry_run, "visual reconstruct-structured-light") {
            Ok(d) => d,
            Err(e) => return output::err(mode, e),
        };

    match decision {
        DestructiveDecision::DryRun => {
            // FIX-13 ④: visual 重建只写 pose report,不再碰 measured.yaml。
            let would_write = vec![
                format!("{project_path}/measurements/{screen_id}_cabinet_pose_report.json"),
            ];
            let payload = serde_json::json!({
                "dry_run": true,
                "would_write": would_write,
                "correspondences": correspondences,
                "sl_meta": sl_meta,
                "intrinsics": intrinsics,
            });
            output::ok(mode, payload, |_| {
                let _ = writeln!(
                    std::io::stdout(),
                    "[dry-run] would reconstruct screen {screen_id} from {} poses",
                    correspondences.len()
                );
            })
        }
        DestructiveDecision::Execute => {
            match mesh_app::visual::run_reconstruct_structured_light(
                Path::new(project_path),
                screen_id,
                Path::new(sl_meta),
                intrinsics,
                intrinsics_crosscheck,
                correspondences,
            ) {
                Ok(r) => output::ok(mode, r, |p| {
                    let _ = writeln!(
                        std::io::stdout(),
                        "reconstructed {} cabinets (ba_rms={:.3}px)\n  poses: {}",
                        p.cabinet_count, p.ba_rms_px, p.pose_report_path
                    );
                    print_warnings(&p.warnings);
                }),
                Err(e) => output::err(mode, ApiError::from(e)),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// calibrate_structured_light
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn calibrate_structured_light(
    mode: Mode,
    project_path: &str,
    screen_id: &str,
    sl_meta: &str,
    correspondences: &[String],
    out: Option<&str>,
    force: bool,
    max_rms_px: f64,
    intrinsics_crosscheck: Option<&str>,
    yes: bool,
    dry_run: bool,
) -> i32 {
    let out_path = out
        .map(str::to_string)
        .unwrap_or_else(|| format!("{project_path}/calibration/{screen_id}_sl_intrinsics.json"));

    // Enforce the no-clobber contract BEFORE gate_destructive so --dry-run and
    // execute agree: both refuse with invalid_input when the output file exists
    // and --force is not passed (mirrors reconstruct_structured_light's pre-gate
    // pattern for its >= 2 correspondences check).
    if std::path::Path::new(&out_path).exists() && !force {
        return output::err(
            mode,
            ApiError::new(
                error_codes::INVALID_INPUT,
                format!(
                    "output file already exists: {out_path}; pass --force to overwrite or --out to use a different path"
                ),
            ),
        );
    }

    let decision = match util::gate_destructive(yes, dry_run, "visual calibrate-structured-light") {
        Ok(d) => d,
        Err(e) => return output::err(mode, e),
    };

    match decision {
        DestructiveDecision::DryRun => {
            let payload = serde_json::json!({
                "dry_run": true,
                "would_write": out_path,
                "sl_meta": sl_meta,
                "correspondences": correspondences,
                "force": force,
                "max_rms_px": max_rms_px,
            });
            output::ok(mode, payload, |_| {
                let _ = writeln!(
                    std::io::stdout(),
                    "[dry-run] would calibrate screen {screen_id} from {} poses → {out_path}",
                    correspondences.len()
                );
            })
        }
        DestructiveDecision::Execute => {
            match mesh_app::visual::run_calibrate_structured_light(
                Path::new(project_path),
                screen_id,
                Path::new(sl_meta),
                correspondences,
                out.map(Path::new),
                force,
                max_rms_px,
                intrinsics_crosscheck,
            ) {
                Ok(r) => output::ok(mode, r, |p| {
                    let _ = writeln!(
                        std::io::stdout(),
                        "calibrated (SL): reproj={:.3}px frames={} → {}",
                        p.reproj_error_px, p.frames_used, p.intrinsics_path
                    );
                    print_warnings(&p.warnings);
                }),
                Err(e) => output::err(mode, ApiError::from(e)),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------------

fn simulate(mode: Mode, config: &str, out: &str, yes: bool, dry_run: bool) -> i32 {
    let decision = match util::gate_destructive(yes, dry_run, "visual simulate") {
        Ok(d) => d,
        Err(e) => return output::err(mode, e),
    };

    match decision {
        DestructiveDecision::DryRun => {
            let payload = serde_json::json!({
                "dry_run": true,
                "would_write": format!("{out}/scene.npz + meta.json"),
                "config": config,
            });
            output::ok(mode, payload, |_| {
                let _ = writeln!(
                    std::io::stdout(),
                    "[dry-run] would simulate dataset from config {config} → {out}"
                );
            })
        }
        DestructiveDecision::Execute => {
            match mesh_app::visual::run_simulate(Path::new(config), Path::new(out)) {
                Ok(r) => output::ok(mode, r, |p| {
                    let _ = writeln!(
                        std::io::stdout(),
                        "simulated {} views, {} obs → {}",
                        p.n_views,
                        p.n_observations,
                        p.dataset_dir
                    );
                }),
                Err(e) => output::err(mode, ApiError::from(e)),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// eval
// ---------------------------------------------------------------------------

fn eval(mode: Mode, dataset: &str, method: &str, seed_matrix: Vec<i64>, init: &str) -> i32 {
    // eval is write_safe — no gate needed.
    match mesh_app::visual::run_eval(Path::new(dataset), method, seed_matrix, init) {
        Ok(r) => output::ok(mode, r, |p| {
            let fmt_h = |v: Option<f64>| match v {
                Some(x) => format!("{x:.2}mm"),
                None => "n/a".to_string(), // < 2 cabinets: holdout undefined
            };
            let _ = writeln!(
                std::io::stdout(),
                "eval {}: holdout_rms={} holdout_p95={} size={:.2}mm dist={:.2}mm angle={:.3}deg",
                p.method,
                fmt_h(p.holdout_rms_mm),
                fmt_h(p.holdout_p95_mm),
                p.max_size_error_mm,
                p.max_distance_error_mm,
                p.max_angle_error_deg
            );
        }),
        Err(e) => output::err(mode, ApiError::from(e)),
    }
}

// ---------------------------------------------------------------------------
// compare_known
// ---------------------------------------------------------------------------

fn compare_known(mode: Mode, report: &str, known: &str, max_size_mm: Option<f64>,
                 max_dist_mm: Option<f64>, max_angle_deg: Option<f64>) -> i32 {
    // compare-known is write_safe (reads two JSON files, writes nothing) — no gate.
    match mesh_app::visual::run_compare_known(Path::new(report), Path::new(known),
                                             max_size_mm, max_dist_mm, max_angle_deg) {
        Ok(r) => output::ok(mode, r, |p| {
            let _ = writeln!(
                std::io::stdout(),
                "compare-known: passed={} ({} cabinets, {} pairs)",
                p.passed,
                p.cabinets.len(),
                p.pairs.len()
            );
        }),
        Err(e) => output::err(mode, ApiError::from(e)),
    }
}

#[allow(clippy::too_many_arguments)]
fn plan_capture(
    mode: Mode,
    project_path: &str,
    screen_id: &str,
    image_size: &str,
    hfov_deg: Option<f64>,
    vfov_deg: Option<f64>,
    standoff: &str,
    height: &str,
    target_mm: f64,
    trials: u32,
    seed: u32,
    min_views: Option<u32>,
) -> i32 {
    // plan-capture is write_safe (computes a plan, writes nothing) — no gate.
    match mesh_app::visual::run_plan_capture(
        Path::new(project_path),
        screen_id,
        image_size,
        hfov_deg,
        vfov_deg,
        standoff,
        height,
        target_mm,
        trials,
        seed,
        min_views,
    ) {
        Ok(p) => output::ok(mode, p, |plan| {
            let _ = writeln!(
                std::io::stdout(),
                "plan-capture: {} stations, all_pass={} ({} unreachable region(s))",
                plan.stations.len(),
                plan.all_pass,
                plan.unreachable_regions.len()
            );
        }),
        Err(e) => output::err(mode, ApiError::from(e)),
    }
}

#[allow(clippy::too_many_arguments)]
fn capture_card(
    mode: Mode,
    project_path: &str,
    screen_id: &str,
    image_size: &str,
    hfov_deg: Option<f64>,
    vfov_deg: Option<f64>,
    standoff: &str,
    height: &str,
    target_mm: f64,
    trials: u32,
    seed: u32,
) -> i32 {
    // read_only: HTML to stdout in human mode (`... > card.html`); --json wraps {html_content}.
    match mesh_app::visual::run_capture_card(
        Path::new(project_path),
        screen_id,
        image_size,
        hfov_deg,
        vfov_deg,
        standoff,
        height,
        target_mm,
        trials,
        seed,
    ) {
        Ok(c) => output::ok(mode, c, |card| {
            let _ = std::io::stdout().write_all(card.html_content.as_bytes());
            let _ = writeln!(std::io::stdout());
        }),
        Err(e) => output::err(mode, ApiError::from(e)),
    }
}
