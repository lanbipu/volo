//! Mesh (LMT) export Tauri command shims.

pub use mesh_app::export::{build_cabinet_array, run_export};

use crate::commands::mesh::MeshDb;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use volo_shared::dto::{ProjectConfig, ScreenConfig, ShapePriorConfig};
use volo_shared::error::{VoloError, VoloResult};

#[tauri::command]
pub fn export_obj(
    state: tauri::State<'_, MeshDb>,
    run_id: i64,
    target: String,
    dst_abs_path: Option<String>,
) -> VoloResult<String> {
    let dst = dst_abs_path.as_deref().map(std::path::Path::new);
    run_export(state.0.clone(), run_id, &target, dst)
}

#[derive(Debug, Clone, Serialize)]
pub struct VpcalScreenExport {
    pub path: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
struct VpcalScreenDefinition {
    name: String,
    unit: &'static str,
    cabinet_size: [f64; 2],
    led_pixel_pitch_mm: f64,
    markers_per_cabinet: u8,
    sections: Vec<VpcalSection>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum VpcalSection {
    Plane {
        name: String,
        origin: [f64; 3],
        rotation: [f64; 4],
        width_mm: f64,
        height_mm: f64,
    },
    Arc {
        name: String,
        origin: [f64; 3],
        rotation: [f64; 4],
        arc_radius_mm: f64,
        arc_angle_deg: f64,
        arc_center_angle_deg: f64,
        height_mm: f64,
    },
}

fn rotate_z(v: [f64; 3], degrees: f64) -> [f64; 3] {
    let a = degrees.to_radians();
    [
        a.cos() * v[0] - a.sin() * v[1],
        a.sin() * v[0] + a.cos() * v[1],
        v[2],
    ]
}

fn placed_origin(screen: &ScreenConfig, nominal_mm: [f64; 3]) -> [f64; 3] {
    let p = rotate_z(nominal_mm, screen.yaw_deg);
    [
        p[0] + screen.position_m[0] * 1000.0,
        p[1] + screen.position_m[1] * 1000.0,
        p[2] + screen.position_m[2] * 1000.0 + screen.height_offset_mm,
    ]
}

fn z_quaternion(degrees: f64) -> [f64; 4] {
    let half = degrees.to_radians() / 2.0;
    [half.cos(), 0.0, 0.0, half.sin()]
}

fn pixel_pitch(screen: &ScreenConfig) -> VoloResult<f64> {
    let pixels = screen.pixels_per_cabinet.ok_or_else(|| {
        VoloError::InvalidInput(
            "screen.pixels_per_cabinet is required to derive vpcal led_pixel_pitch_mm".into(),
        )
    })?;
    if pixels[0] == 0 || pixels[1] == 0 {
        return Err(VoloError::InvalidInput(
            "screen.pixels_per_cabinet values must be greater than zero".into(),
        ));
    }
    let x = screen.cabinet_size_mm[0] / pixels[0] as f64;
    let y = screen.cabinet_size_mm[1] / pixels[1] as f64;
    let relative_delta = (x - y).abs() / x.max(y);
    if relative_delta > 0.01 {
        return Err(VoloError::InvalidInput(format!(
            "vpcal ScreenDefinition has one led_pixel_pitch_mm, but this screen has non-square pixels ({x:.6}mm x {y:.6}mm)"
        )));
    }
    Ok((x + y) / 2.0)
}

fn plane_section(
    name: String,
    screen: &ScreenConfig,
    nominal_origin_mm: [f64; 3],
    heading_deg: f64,
    width_mm: f64,
    height_mm: f64,
) -> VpcalSection {
    VpcalSection::Plane {
        name,
        origin: placed_origin(screen, nominal_origin_mm),
        rotation: z_quaternion(screen.yaw_deg + heading_deg),
        width_mm,
        height_mm,
    }
}

fn vpcal_sections(
    screen_id: &str,
    screen: &ScreenConfig,
    project: &ProjectConfig,
) -> VoloResult<Vec<VpcalSection>> {
    if screen.normal_flip {
        return Err(VoloError::InvalidInput(
            "normal_flip cannot be represented without reflecting vpcal marker coordinates; export a reconstructed OBJ when that path is available".into(),
        ));
    }
    if !screen.irregular_mask.is_empty() {
        return Err(VoloError::InvalidInput(
            "irregular_mask cannot be represented by vpcal ScreenDefinition v1 nominal sections"
                .into(),
        ));
    }

    let width = screen.cabinet_count[0] as f64 * screen.cabinet_size_mm[0];
    let height = screen.cabinet_count[1] as f64 * screen.cabinet_size_mm[1];
    match &screen.shape_prior {
        ShapePriorConfig::Flat | ShapePriorConfig::Folded { .. } => Ok(vec![plane_section(
            screen_id.to_string(),
            screen,
            [width / 2.0, 0.0, 0.0],
            0.0,
            width,
            height,
        )]),
        ShapePriorConfig::Curved {
            radius_mm,
            fold_seams_at_columns,
        } => {
            if !fold_seams_at_columns.is_empty() {
                return Err(VoloError::InvalidInput(
                    "curved shape with fold seams cannot be represented by vpcal ScreenDefinition v1".into(),
                ));
            }
            if !radius_mm.is_finite() || *radius_mm <= 0.0 {
                return Err(VoloError::InvalidInput(
                    "curved radius_mm must be positive".into(),
                ));
            }
            let half_angle = width / (2.0 * radius_mm);
            let arc_angle_deg = (width / radius_mm).to_degrees();
            if arc_angle_deg > 360.0 {
                return Err(VoloError::InvalidInput(format!(
                    "curved nominal geometry spans {arc_angle_deg:.3} degrees; vpcal ArcSection supports at most 360 degrees"
                )));
            }
            let anchor_x = radius_mm * (-half_angle).sin();
            let anchor_y = radius_mm - radius_mm * (-half_angle).cos();
            Ok(vec![VpcalSection::Arc {
                name: screen_id.to_string(),
                origin: placed_origin(screen, [-anchor_x, radius_mm - anchor_y, 0.0]),
                rotation: z_quaternion(screen.yaw_deg),
                arc_radius_mm: *radius_mm,
                arc_angle_deg,
                arc_center_angle_deg: -90.0,
                height_mm: height,
            }])
        }
        // vpcal v1 has no polyline section. Reuse M1's nominal geometry and
        // represent each cabinet column as one plane. TODO: once reconstructed
        // vertices are part of this export, fit sections from that geometry.
        ShapePriorConfig::Arc { .. }
        | ShapePriorConfig::LShape { .. }
        | ShapePriorConfig::UShape { .. }
        | ShapePriorConfig::CustomSegments { .. } => {
            let mapped = mesh_app::total_station_mapper::map_to_adapter(project)?;
            let mapped_screen = mapped.screens.get(screen_id).ok_or_else(|| {
                VoloError::NotFound(format!("screen {screen_id} in mapped project"))
            })?;
            let vertices = mesh_adapter_total_station::shape_grid::expected_grid_positions(
                screen_id,
                mapped_screen,
            )?;
            let bottom: std::collections::HashMap<u32, [f64; 3]> = vertices
                .iter()
                .filter(|v| v.row_zero_based == 0)
                .map(|v| {
                    (
                        v.col_zero_based,
                        [
                            v.model_position.x * 1000.0,
                            v.model_position.y * 1000.0,
                            0.0,
                        ],
                    )
                })
                .collect();
            let mut sections = Vec::with_capacity(screen.cabinet_count[0] as usize);
            for col in 0..screen.cabinet_count[0] {
                let a = bottom.get(&col).ok_or_else(|| {
                    VoloError::Other(format!("nominal geometry missing column {col}"))
                })?;
                let b = bottom.get(&(col + 1)).ok_or_else(|| {
                    VoloError::Other(format!("nominal geometry missing column {}", col + 1))
                })?;
                let dx = b[0] - a[0];
                let dy = b[1] - a[1];
                sections.push(plane_section(
                    format!("{screen_id}_C{:03}", col + 1),
                    screen,
                    [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0, 0.0],
                    dy.atan2(dx).to_degrees(),
                    dx.hypot(dy),
                    height,
                ));
            }
            Ok(sections)
        }
    }
}

fn default_vpcal_path(project_path: &Path, screen_id: &str) -> PathBuf {
    project_path
        .join("vpcal")
        .join(format!("{screen_id}.screen.json"))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> VoloResult<()> {
    let parent = path.parent().ok_or_else(|| {
        VoloError::InvalidInput(format!("output path has no parent: {}", path.display()))
    })?;
    std::fs::create_dir_all(parent)?;
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|s| s.to_str()).unwrap_or("json")
    ));
    std::fs::write(&tmp, bytes)?;
    if let Err(first) = std::fs::rename(&tmp, path) {
        // Windows rename does not replace an existing destination. Preserve
        // the temp file until the old export is removed, then retry.
        if path.exists() {
            std::fs::remove_file(path)?;
            std::fs::rename(&tmp, path)?;
        } else {
            return Err(first.into());
        }
    }
    Ok(())
}

/// Export project.yaml's nominal screen geometry to vpcal ScreenDefinition v1.
/// Reconstructed-vertex fitting is intentionally not claimed here; the source
/// fingerprint lets the UI identify a stale nominal export.
#[tauri::command]
pub fn export_vpcal_screen(
    project_path: String,
    screen_id: String,
    out_path: Option<String>,
) -> VoloResult<VpcalScreenExport> {
    let project_path = Path::new(&project_path).canonicalize().map_err(|e| {
        VoloError::Io(format!(
            "failed to resolve project path {project_path}: {e}"
        ))
    })?;
    let project = mesh_app::projects::load_project_yaml_from_path(&project_path)?;
    let screen = project
        .screens
        .get(&screen_id)
        .ok_or_else(|| VoloError::NotFound(format!("screen {screen_id} in project.yaml")))?;
    let source = serde_json::to_vec(&serde_json::json!({
        "screen_id": screen_id,
        "screen": screen,
        "project_unit": project.project.unit,
    }))?;
    let fingerprint = format!("{:x}", Sha256::digest(&source));
    let definition = VpcalScreenDefinition {
        name: format!("{} / {}", project.project.name, screen_id),
        unit: "mm",
        cabinet_size: screen.cabinet_size_mm,
        led_pixel_pitch_mm: pixel_pitch(screen)?,
        markers_per_cabinet: 4,
        sections: vpcal_sections(&screen_id, screen, &project)?,
    };
    let bytes = serde_json::to_vec_pretty(&definition)?;
    let path = out_path
        .map(PathBuf::from)
        .unwrap_or_else(|| default_vpcal_path(&project_path, &screen_id));
    write_atomic(&path, &bytes)?;
    let path = path.canonicalize().map_err(|e| {
        VoloError::Io(format!(
            "failed to resolve exported screen {}: {e}",
            path.display()
        ))
    })?;
    Ok(VpcalScreenExport {
        path: path.display().to_string(),
        fingerprint,
    })
}

#[cfg(test)]
mod vpcal_tests {
    use super::*;
    use tempfile::tempdir;

    fn write_project(dir: &Path) {
        std::fs::write(
            dir.join("project.yaml"),
            r#"
project: { name: Test, unit: mm }
screens:
  MAIN:
    cabinet_count: [4, 2]
    cabinet_size_mm: [500, 500]
    pixels_per_cabinet: [250, 250]
    shape_prior: { type: flat }
    shape_mode: rectangle
coordinate_system:
  origin_point: MAIN_V001_R001
  x_axis_point: MAIN_V005_R001
  xy_plane_point: MAIN_V001_R003
output: { target: neutral, obj_filename: "{screen_id}.obj", weld_vertices_tolerance_mm: 1, triangulate: true }
"#,
        )
        .unwrap();
    }

    #[test]
    fn exported_json_matches_vpcal_screen_schema_shape() {
        let dir = tempdir().unwrap();
        write_project(dir.path());
        let result =
            export_vpcal_screen(dir.path().display().to_string(), "MAIN".into(), None).unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&result.path).unwrap()).unwrap();
        assert_eq!(json["unit"], "mm");
        assert_eq!(json["cabinet_size"], serde_json::json!([500.0, 500.0]));
        assert_eq!(json["led_pixel_pitch_mm"], 2.0);
        assert_eq!(json["sections"][0]["type"], "plane");
        assert_eq!(json["sections"][0]["width_mm"], 2000.0);
        assert_eq!(result.fingerprint.len(), 64);

        // Local acceptance gate: when the repo's vpcal venv is present, use
        // the actual Pydantic model rather than only mirroring field names.
        let python = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("sidecars/vpcal/.venv/bin/python");
        if python.is_file() {
            let status = std::process::Command::new(python)
                .args([
                    "-c",
                    "from vpcal.io.screen_io import load_screen; import sys; load_screen(sys.argv[1])",
                    &result.path,
                ])
                .status()
                .unwrap();
            assert!(status.success(), "vpcal Pydantic loader rejected export");
        }
    }
}
