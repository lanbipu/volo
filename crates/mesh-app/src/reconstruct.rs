use crate::export::build_cabinet_array;
use crate::measurements::load_measurements_from_path;
use chrono::Utc;
use mesh_core::reconstruct::auto_reconstruct;
use mesh_core::reconstruct::surface_fit::SurfaceFitReconstructor;
use mesh_core::reconstruct::Reconstructor;
use mesh_core::sampling::SamplingMode;
use volo_shared::data::{runs, Db};
use volo_shared::dto::{ReconstructionReport, ReconstructionResult};
use volo_shared::error::{VoloError, VoloResult};
use std::path::{Path, PathBuf};

pub fn run_reconstruction(
    db: Db,
    project_path: &Path,
    screen_id: &str,
    measurements_rel_path: &str,
) -> VoloResult<ReconstructionResult> {
    // Canonicalize project_path 在入口做一次,让 DB 里写入的字符串与 cwd /
    // symlink 无关。CLI 与 Tauri GUI 都受益:任何 caller 给 `./proj` 或
    // symlink path 都被规范化到真实绝对路径,后续 list_runs_for /
    // read_run_report 才能 exact-match 找到。
    let project_path = &std::fs::canonicalize(project_path).map_err(|e| {
        VoloError::Io(format!(
            "canonicalize project_path {}: {e}",
            project_path.display()
        ))
    })?;
    // Load project.yaml to snapshot cabinet_array and weld_tolerance at this moment.
    let yaml = std::fs::read_to_string(project_path.join("project.yaml"))?;
    let cfg: volo_shared::dto::ProjectConfig =
        serde_yaml::from_str(&yaml).map_err(|e| VoloError::Yaml(format!("project.yaml: {e}")))?;
    let screen_cfg = cfg
        .screens
        .get(screen_id)
        .ok_or_else(|| VoloError::NotFound(format!("screen {screen_id} in project.yaml")))?;
    let cabinet_array = build_cabinet_array(screen_cfg)?;
    let weld_tolerance_mm = cfg.output.weld_vertices_tolerance_mm;

    let m_abs = project_path.join(measurements_rel_path);
    let measurements = load_measurements_from_path(&m_abs)?;
    tracing::info!(
        project_path = %project_path.display(),
        screen_id = %screen_id,
        measurements_abs = %m_abs.display(),
        points_count = measurements.points.len(),
        measurements_screen_id = %measurements.screen_id,
        cabinet_cols = measurements.cabinet_array.cols,
        cabinet_rows = measurements.cabinet_array.rows,
        shape_prior = ?measurements.shape_prior,
        first_point = measurements.points.first().map(|p| p.name.as_str()).unwrap_or("(empty)"),
        "reconstruct: loaded measurements",
    );
    let surface = if measurements.sampling_mode == SamplingMode::Scatter {
        SurfaceFitReconstructor.reconstruct(&measurements).map_err(|e| {
            tracing::error!(
                error = %e,
                points_count = measurements.points.len(),
                cabinet_cols = measurements.cabinet_array.cols,
                cabinet_rows = measurements.cabinet_array.rows,
                shape_prior = ?measurements.shape_prior,
                "reconstruct: surface_fit failed",
            );
            VoloError::SurfaceFitFailed(e.to_string())
        })?
    } else {
        auto_reconstruct(&measurements).map_err(|e| {
            tracing::error!(
                error = %e,
                points_count = measurements.points.len(),
                cabinet_cols = measurements.cabinet_array.cols,
                cabinet_rows = measurements.cabinet_array.rows,
                shape_prior = ?measurements.shape_prior,
                "reconstruct: auto_reconstruct failed",
            );
            VoloError::from(e)
        })?
    };
    let metrics = surface.quality_metrics.clone();

    let now = Utc::now();
    let stamp = now.format("%Y-%m-%dT%H-%M-%S%.3f").to_string();
    let report_rel = PathBuf::from("reports").join(format!("{stamp}.json"));
    let report_abs = project_path.join(&report_rel);
    std::fs::create_dir_all(report_abs.parent().unwrap())?;

    let report = ReconstructionReport {
        surface: surface.clone(),
        quality_metrics: metrics.clone(),
        project_path: project_path.display().to_string(),
        screen_id: screen_id.to_string(),
        measurements_path: measurements_rel_path.to_string(),
        created_at: now.to_rfc3339(),
        cabinet_array,
        weld_tolerance_mm,
        scatter_fit: surface.scatter_fit.clone().map(Into::into),
    };
    let json = serde_json::to_vec_pretty(&report)
        .map_err(|e| VoloError::Yaml(format!("json: {e}")))?;
    std::fs::write(&report_abs, json)?;

    let warnings_json = serde_json::to_string(&metrics.warnings)
        .map_err(|e| VoloError::Yaml(format!("json: {e}")))?;

    let run_id = {
        let conn = db.lock().unwrap();
        runs::insert(
            &conn,
            &runs::NewRun {
                project_path: project_path.display().to_string(),
                screen_id: screen_id.to_string(),
                measurements_path: measurements_rel_path.to_string(),
                method: metrics.method.clone(),
                measured_count: metrics.measured_count,
                expected_count: metrics.expected_count,
                estimated_rms_mm: metrics.estimated_rms_mm,
                estimated_p95_mm: metrics.estimated_p95_mm,
                vertex_count: surface.vertices.len(),
                report_json_path: report_rel.display().to_string(),
                warnings_json,
            },
        )?
    };

    Ok(ReconstructionResult {
        run_id,
        surface,
        report_json_path: report_rel.display().to_string(),
    })
}

pub fn list_runs_for(
    db: Db,
    project_path: &str,
    screen_id: Option<&str>,
) -> VoloResult<Vec<volo_shared::dto::ReconstructionRun>> {
    // 同时按 raw 与 canonical key 查询,合并去重。本 patch 之后写入的
    // run 是 canonical,但 patch 之前的旧 row 可能仍是 raw symlink path;
    // 单按 canonical 查会让升级前的历史 "消失"。所以两种字符串都试,合并
    // 去重(按 id),保持 created_at desc 顺序。
    let canonical = std::fs::canonicalize(project_path)
        .ok()
        .map(|p| p.display().to_string());
    let conn = db.lock().unwrap();
    let mut rows = runs::list_by_project(&conn, project_path, screen_id)?;
    if let Some(canon) = canonical {
        if canon != project_path {
            let extra = runs::list_by_project(&conn, &canon, screen_id)?;
            let seen: std::collections::HashSet<i64> = rows.iter().map(|r| r.id).collect();
            for r in extra {
                if !seen.contains(&r.id) {
                    rows.push(r);
                }
            }
            rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        }
    }
    Ok(rows)
}

pub fn read_run_report(db: Db, run_id: i64) -> VoloResult<serde_json::Value> {
    let (project_path, report_rel) = {
        let conn = db.lock().unwrap();
        runs::get_report_path(&conn, run_id)?
    };
    let report_abs = PathBuf::from(&project_path).join(&report_rel);
    let bytes = std::fs::read(&report_abs)?;
    serde_json::from_slice(&bytes).map_err(|e| VoloError::Yaml(format!("json: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use volo_shared::data;
    use tempfile::tempdir;

    /// Build a minimal project.yaml for a 55×15 curved screen.
    fn write_project_yaml(proj: &std::path::Path) {
        std::fs::write(
            proj.join("project.yaml"),
            r#"
project: { name: T, unit: mm }
screens:
  MAIN:
    cabinet_count: [55, 15]
    cabinet_size_mm: [500, 500]
    shape_prior: { type: curved, radius_mm: 9523 }
    shape_mode: rectangle
coordinate_system:
  origin_point: MAIN_V001_R001
  x_axis_point: MAIN_V055_R001
  xy_plane_point: MAIN_V001_R015
output: { target: disguise, obj_filename: "{screen_id}.obj", weld_vertices_tolerance_mm: 1.0, triangulate: true }
"#,
        )
        .unwrap();
    }

    /// Build a scatter measured.yaml using serde_yaml (same path as run_import_scatter)
    /// so the YAML format is always correct regardless of serde_yaml version.
    fn write_scatter_measured_yaml(proj: &std::path::Path) {
        use mesh_core::coordinate::CoordinateFrame;
        use mesh_core::measured_points::MeasuredPoints;
        use mesh_core::point::{MeasuredPoint, PointSource};
        use mesh_core::sampling::SamplingMode;
        use mesh_core::shape::{CabinetArray, ShapePrior};
        use mesh_core::uncertainty::Uncertainty;
        use nalgebra::Vector3;

        let r = 9.523_f64;
        let mut points = vec![];
        for k in 0..60 {
            let t = -1.4 + 2.8 * (k as f64 / 59.0);
            for (li, &z) in [0.0_f64, 7.5].iter().enumerate() {
                points.push(MeasuredPoint {
                    name: format!("row{k}_{li}"),
                    position: Vector3::new(r * t.cos(), r * t.sin(), z),
                    uncertainty: Uncertainty::Isotropic(1.0),
                    source: PointSource::TotalStation,
                });
            }
        }
        // One outlier point
        points.push(MeasuredPoint {
            name: "row999_CD1".into(),
            position: Vector3::new(0.3, 0.0, 3.0),
            uncertainty: Uncertainty::Isotropic(1.0),
            source: PointSource::TotalStation,
        });

        let measured = MeasuredPoints {
            screen_id: "MAIN".into(),
            coordinate_frame: CoordinateFrame {
                origin_world: [0.0, 0.0, 0.0],
                basis: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            },
            cabinet_array: CabinetArray::rectangle(55, 15, [500.0, 500.0]),
            shape_prior: ShapePrior::Curved { radius_mm: 9523.0 },
            points,
            sampling_mode: SamplingMode::Scatter,
        };

        std::fs::create_dir_all(proj.join("measurements")).unwrap();
        let yaml = serde_yaml::to_string(&measured).unwrap();
        std::fs::write(proj.join("measurements/measured.yaml"), yaml).unwrap();
    }

    #[test]
    fn reconstruct_scatter_fills_report_scatter_fit() {
        let dir = tempdir().unwrap();
        let proj = dir.path();

        write_project_yaml(proj);
        write_scatter_measured_yaml(proj);

        let db = data::open(&proj.join("test.sqlite")).unwrap();
        {
            let mut conn = db.lock().unwrap();
            data::schema::migrate(&mut conn).unwrap();
        }
        let res = run_reconstruction(db.clone(), proj, "MAIN", "measurements/measured.yaml")
            .unwrap();

        let report = read_run_report(db, res.run_id).unwrap();

        // scatter_fit must be present and method must indicate surface_fit
        let scatter_fit = &report["scatter_fit"];
        assert!(
            !scatter_fit.is_null(),
            "report.scatter_fit should not be null for scatter reconstruction"
        );
        let method = report["quality_metrics"]["method"]
            .as_str()
            .unwrap_or("");
        assert!(
            method.starts_with("surface_fit_"),
            "expected method starting with surface_fit_, got: {method}"
        );
        // Verify it's specifically a cylinder fit
        assert_eq!(method, "surface_fit_cylinder");
    }
}
