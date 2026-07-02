//! `lmt fuse` —— W6 R1 M1(全站仪)+ M2(视觉 BA)融合。Thin transport:
//! parse → call mesh_app::fuse → envelope. 业务逻辑全在 mesh_app::fuse。

use crate::lmt::commands::util::{self, DestructiveDecision};
use crate::lmt::output::{self, Mode};
use std::io::Write as _;
use std::path::Path;
use volo_shared::envelope::ApiError;

#[allow(clippy::too_many_arguments)]
pub fn run(
    mode: Mode,
    project_path: &str,
    screen_id: &str,
    pose_report: &str,
    measurements: &str,
    allow_scale: bool,
    yes: bool,
    dry_run: bool,
) -> i32 {
    let decision = match util::gate_destructive(yes, dry_run, "fuse") {
        Ok(d) => d,
        Err(e) => return output::err(mode, e),
    };

    match decision {
        DestructiveDecision::DryRun => {
            let payload = serde_json::json!({
                "dry_run": true,
                "would_write": format!("{project_path}/measurements/{screen_id}_fused_pose_report.json"),
                "pose_report": pose_report,
                "measurements": measurements,
                "allow_scale": allow_scale,
            });
            output::ok(mode, payload, |_| {
                let _ = writeln!(
                    std::io::stdout(),
                    "[dry-run] would fuse screen {screen_id}: {pose_report} + {measurements}"
                );
            })
        }
        DestructiveDecision::Execute => {
            match mesh_app::fuse::run_fuse(
                Path::new(project_path),
                screen_id,
                Path::new(pose_report),
                Path::new(measurements),
                allow_scale,
            ) {
                Ok(r) => output::ok(mode, r, |p| {
                    let _ = writeln!(
                        std::io::stdout(),
                        "fused {} anchors (rms={:.2}mm, scale={:.4}{}) → {}",
                        p.anchor_count,
                        p.anchor_rms_mm,
                        p.scale,
                        if p.scale_locked { " locked" } else { "" },
                        p.fused_pose_report_path,
                    );
                }),
                Err(e) => output::err(mode, ApiError::from(e)),
            }
        }
    }
}
