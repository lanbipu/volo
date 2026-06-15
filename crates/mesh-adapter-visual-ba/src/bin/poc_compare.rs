//! PoC compare tool: load two MeasuredPoints (ground truth + visual BA),
//! compute RMS / 95th percentile error per point.
//!
//! In `three_points` mode, RMS / p95 are computed on the *holdout* set
//! (points NOT used as Procrustes anchors); anchor residuals are reported
//! separately. In `nominal_anchoring` mode, RMS uses all matched points.

use std::collections::HashSet;
use std::path::PathBuf;

use mesh_core::measured_points::MeasuredPoints;
use serde::Serialize;

#[derive(Debug)]
struct Args {
    ground_truth: PathBuf,
    measured: PathBuf,
    frame_strategy: String,
    anchor_ids: HashSet<String>,
    allow_partial: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut gt: Option<PathBuf> = None;
    let mut me: Option<PathBuf> = None;
    let mut fs: Option<String> = None;
    let mut anchors: HashSet<String> = HashSet::new();
    let mut allow_partial = false;
    let mut iter = std::env::args().skip(1);
    while let Some(a) = iter.next() {
        match a.as_str() {
            "--ground-truth" => gt = iter.next().map(PathBuf::from),
            "--measured" => me = iter.next().map(PathBuf::from),
            "--frame-strategy" => fs = iter.next(),
            "--anchor-ids" => {
                if let Some(v) = iter.next() {
                    for id in v.split(',') {
                        anchors.insert(id.trim().to_string());
                    }
                }
            }
            "--allow-partial" => allow_partial = true,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(Args {
        ground_truth: gt.ok_or("--ground-truth required")?,
        measured: me.ok_or("--measured required")?,
        frame_strategy: fs.ok_or("--frame-strategy required")?,
        anchor_ids: anchors,
        allow_partial,
    })
}

fn percentile(values: &mut Vec<f64>, p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let idx = ((values.len() as f64 - 1.0) * p).round() as usize;
    values[idx.min(values.len() - 1)]
}

fn rms(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    (values.iter().map(|v| v * v).sum::<f64>() / values.len() as f64).sqrt()
}

#[derive(Serialize)]
struct Report {
    frame_strategy: String,
    n_compared: usize,
    rms_mm: Option<f64>,
    p95_mm: Option<f64>,
    holdout_rms_mm: Option<f64>,
    holdout_p95_mm: Option<f64>,
    anchor_residual_rms_mm: Option<f64>,
    per_point_mm: Vec<(String, f64)>,
}

fn die(msg: String) -> Box<dyn std::error::Error> {
    eprintln!("{msg}");
    msg.into()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args().map_err(|e| {
        eprintln!("{e}");
        e
    })?;

    let gt: MeasuredPoints = serde_json::from_str(&std::fs::read_to_string(&args.ground_truth)?)?;
    let me: MeasuredPoints = serde_json::from_str(&std::fs::read_to_string(&args.measured)?)?;

    let mut per_point: Vec<(String, f64)> = Vec::new();
    let mut unmatched_gt_names: Vec<String> = Vec::new();
    for gp in &gt.points {
        if let Some(mp) = me.find(&gp.name) {
            let d = (gp.position - mp.position).norm() * 1000.0; // m → mm
            per_point.push((gp.name.clone(), d));
        } else {
            unmatched_gt_names.push(gp.name.clone());
        }
    }

    // Fail closed: empty matched set cannot certify anything. Previously the
    // tool returned RMS=0.0 → spurious "pass".
    if per_point.is_empty() {
        return Err(die(format!(
            "no MeasuredPoint names matched between ground truth ({}) and measured ({}); \
             check name format — expected full IR names like MAIN_V000_R000, not numeric ArUco IDs",
            gt.points.len(),
            me.points.len(),
        )));
    }

    // Coverage check: gate metric becomes meaningless if only a small fraction
    // of GT points are present in the measured set. By default require ≥ 90%
    // coverage; partial-result use cases must opt in via --allow-partial.
    let coverage = per_point.len() as f64 / gt.points.len() as f64;
    let min_coverage = 0.90;
    if coverage < min_coverage && !args.allow_partial {
        let preview: Vec<&String> = unmatched_gt_names.iter().take(10).collect();
        let more = if unmatched_gt_names.len() > 10 {
            format!(" (+ {} more)", unmatched_gt_names.len() - 10)
        } else {
            String::new()
        };
        return Err(die(format!(
            "coverage {:.0}% ({}/{}) below {:.0}% threshold — gate metric not trustworthy. \
             Unmatched GT names: {:?}{}. Pass --allow-partial to override.",
            coverage * 100.0,
            per_point.len(),
            gt.points.len(),
            min_coverage * 100.0,
            preview,
            more,
        )));
    }

    let report = if args.frame_strategy == "three_points" {
        // three_points anchors are intended to be the 3 Procrustes anchors.
        // Spec §9.3: holdout RMS is the gate, anchor residuals are reported
        // separately. We require exactly 3 anchors AND that all 3 match
        // names in the measured set, otherwise the gate is undefined.
        if args.anchor_ids.len() != 3 {
            return Err(die(format!(
                "three_points strategy requires --anchor-ids with exactly 3 names; got {}",
                args.anchor_ids.len(),
            )));
        }
        let names_in_measured: std::collections::HashSet<&str> =
            per_point.iter().map(|(n, _)| n.as_str()).collect();
        let unmatched: Vec<&String> = args
            .anchor_ids
            .iter()
            .filter(|a| !names_in_measured.contains(a.as_str()))
            .collect();
        if !unmatched.is_empty() {
            return Err(die(format!(
                "{}/3 anchor name(s) not found in measured points: {:?}. \
                 Use full IR names (e.g. MAIN_V000_R000), not numeric ArUco IDs.",
                unmatched.len(),
                unmatched,
            )));
        }

        let mut holdout: Vec<f64> = Vec::new();
        let mut anchor: Vec<f64> = Vec::new();
        for (name, d) in &per_point {
            if args.anchor_ids.contains(name) {
                anchor.push(*d);
            } else {
                holdout.push(*d);
            }
        }
        if holdout.is_empty() {
            return Err(die(
                "holdout set is empty — every matched point is in --anchor-ids; \
                 gate metric undefined. Need at least one non-anchor point."
                    .to_string(),
            ));
        }
        let mut h = holdout.clone();
        Report {
            frame_strategy: args.frame_strategy,
            n_compared: per_point.len(),
            rms_mm: None,
            p95_mm: None,
            holdout_rms_mm: Some(rms(&holdout)),
            holdout_p95_mm: Some(percentile(&mut h, 0.95)),
            anchor_residual_rms_mm: Some(rms(&anchor)),
            per_point_mm: per_point,
        }
    } else {
        let mut all: Vec<f64> = per_point.iter().map(|(_, d)| *d).collect();
        Report {
            frame_strategy: args.frame_strategy,
            n_compared: per_point.len(),
            rms_mm: Some(rms(&all)),
            p95_mm: Some(percentile(&mut all, 0.95)),
            holdout_rms_mm: None,
            holdout_p95_mm: None,
            anchor_residual_rms_mm: None,
            per_point_mm: per_point,
        }
    };

    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
