//! Mesh (LMT) export Tauri command shims.

pub use mesh_app::export::{build_cabinet_array, run_export};

use crate::commands::mesh::MeshDb;
use mesh_core::rigid::RigidTransform;
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
    geometry_provenance: VpcalGeometryProvenance,
}

#[derive(Debug, Clone, Serialize)]
struct VpcalGeometryProvenance {
    source: &'static str,
    solve_ref: Option<String>,
    solve_ref_sha256: Option<String>,
    visual_solve_digest: Option<String>,
    intrinsics_source: Option<String>,
    warning_codes: Vec<String>,
    withheld_validation_passed: bool,
    formal_eligible: bool,
    reasons: Vec<String>,
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

fn quaternion_matrix([w, x, y, z]: [f64; 4]) -> [[f64; 3]; 3] {
    [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w)],
        [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w)],
        [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y)],
    ]
}

fn matrix_mul(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut out = [[0.0; 3]; 3];
    for row in 0..3 {
        for col in 0..3 {
            out[row][col] = (0..3).map(|k| a[row][k] * b[k][col]).sum();
        }
    }
    out
}

fn matrix_quaternion(m: &[[f64; 3]; 3]) -> [f64; 4] {
    let trace = m[0][0] + m[1][1] + m[2][2];
    let (w, x, y, z) = if trace > 0.0 {
        let s = (trace + 1.0).sqrt() * 2.0;
        (0.25 * s, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s)
    } else if m[0][0] > m[1][1] && m[0][0] > m[2][2] {
        let s = (1.0 + m[0][0] - m[1][1] - m[2][2]).sqrt() * 2.0;
        ((m[2][1] - m[1][2]) / s, 0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s)
    } else if m[1][1] > m[2][2] {
        let s = (1.0 + m[1][1] - m[0][0] - m[2][2]).sqrt() * 2.0;
        ((m[0][2] - m[2][0]) / s, (m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s)
    } else {
        let s = (1.0 + m[2][2] - m[0][0] - m[1][1]).sqrt() * 2.0;
        ((m[1][0] - m[0][1]) / s, (m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s)
    };
    let norm = (w * w + x * x + y * y + z * z).sqrt();
    [w / norm, x / norm, y / norm, z / norm]
}

fn transform_point_mm(xf: &RigidTransform, point_mm: [f64; 3]) -> [f64; 3] {
    let p_m = [point_mm[0] / 1000.0, point_mm[1] / 1000.0, point_mm[2] / 1000.0];
    let mut out = [0.0; 3];
    for (row, value) in out.iter_mut().enumerate() {
        *value = ((0..3).map(|k| xf.rotation[row][k] * p_m[k]).sum::<f64>() + xf.t_m[row]) * 1000.0;
    }
    out
}

fn transform_section(section: VpcalSection, xf: &RigidTransform) -> VpcalSection {
    let transform_rotation = |rotation: [f64; 4]| {
        matrix_quaternion(&matrix_mul(&xf.rotation, &quaternion_matrix(rotation)))
    };
    match section {
        VpcalSection::Plane { name, origin, rotation, width_mm, height_mm } => VpcalSection::Plane {
            name,
            origin: transform_point_mm(xf, origin),
            rotation: transform_rotation(rotation),
            width_mm,
            height_mm,
        },
        VpcalSection::Arc {
            name, origin, rotation, arc_radius_mm, arc_angle_deg, arc_center_angle_deg, height_mm,
        } => VpcalSection::Arc {
            name,
            origin: transform_point_mm(xf, origin),
            rotation: transform_rotation(rotation),
            arc_radius_mm,
            arc_angle_deg,
            arc_center_angle_deg,
            height_mm,
        },
    }
}

fn rebuilt_export_placement(
    project_path: &Path,
    project: &ProjectConfig,
    screen_id: &str,
) -> VoloResult<Option<(RigidTransform, Option<String>)>> {
    let Some(group) = mesh_app::placement::alignment_for_screen(project, screen_id) else {
        return Ok(None);
    };
    let transforms = if let Some(solve_ref) = group.solve_ref.as_deref() {
        let path = PathBuf::from(solve_ref);
        let path = if path.is_absolute() { path } else { project_path.join(path) };
        let bytes = std::fs::read(&path).map_err(|error| {
            VoloError::Io(format!(
                "rebuilt_alignment solve_ref is required for vpcal export but cannot be read ({}): {error}",
                path.display()
            ))
        })?;
        let parsed = mesh_app::visual::load_screen_transforms(&path)?;
        if !parsed.transforms.iter().any(|entry| entry.screen_id == screen_id) {
            return Err(VoloError::InvalidInput(format!(
                "rebuilt_alignment solve_ref {} has no transform for screen {screen_id}",
                path.display()
            )));
        }
        let digest = format!("{:x}", Sha256::digest(&bytes));
        Some((parsed, digest))
    } else {
        if group.screens.len() > 1 {
            return Err(VoloError::InvalidInput(format!(
                "multi-screen rebuilt_alignment for {screen_id} has no solve_ref; refusing nominal vpcal export"
            )));
        }
        None
    };
    let placement = mesh_app::placement::resolve_rebuilt_placement(
        project,
        screen_id,
        transforms.as_ref().map(|(value, _)| value),
    );
    Ok(Some((placement, transforms.map(|(_, digest)| digest))))
}

fn export_geometry_provenance(
    project_path: &Path,
    project: &ProjectConfig,
    screen_id: &str,
    solve_ref_sha256: Option<String>,
) -> VpcalGeometryProvenance {
    let solve_ref = mesh_app::placement::alignment_for_screen(project, screen_id)
        .and_then(|group| group.solve_ref.as_deref())
        .map(|raw| {
            let path = PathBuf::from(raw);
            if path.is_absolute() { path } else { project_path.join(path) }
        });
    let mut digest_path: Option<PathBuf> = None;
    let mut digest_value: Option<serde_json::Value> = None;
    if let Some(ref_path) = solve_ref.as_ref() {
        let visual_dir = project_path.join("measurements").join("visual_solves");
        if let Ok(entries) = std::fs::read_dir(visual_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|v| v.to_str()) != Some("json") { continue; }
                let Ok(bytes) = std::fs::read(&path) else { continue };
                let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else { continue };
                let Some(recorded) = value.get("screen_transforms_path").and_then(serde_json::Value::as_str) else { continue };
                let candidate = PathBuf::from(recorded);
                let candidate = if candidate.is_absolute() { candidate } else { project_path.join(candidate) };
                let candidate_cmp = candidate.canonicalize().unwrap_or(candidate);
                let ref_cmp = ref_path.canonicalize().unwrap_or_else(|_| ref_path.clone());
                if candidate_cmp == ref_cmp {
                    let newer = digest_value.as_ref().map_or(true, |current| {
                        value.get("finished_at").and_then(serde_json::Value::as_str)
                            > current.get("finished_at").and_then(serde_json::Value::as_str)
                    });
                    if newer { digest_path = Some(path); digest_value = Some(value); }
                }
            }
        }
    }
    let intrinsics_source = digest_value.as_ref()
        .and_then(|value| value.get("intrinsics_source"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let warning_codes: Vec<String> = digest_value.as_ref()
        .and_then(|value| value.get("warnings"))
        .and_then(serde_json::Value::as_array)
        .into_iter().flatten()
        .filter_map(|warning| warning.get("code").and_then(serde_json::Value::as_str).map(str::to_string))
        .collect();
    let validation_path = solve_ref.as_ref().map(|path| PathBuf::from(format!("{}.validation.json", path.display())));
    let withheld_validation_passed = validation_path.as_ref()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.pointer("/withheld_validation/passed").and_then(serde_json::Value::as_bool))
        == Some(true);
    let mut reasons = Vec::new();
    if solve_ref.is_none() { reasons.push("missing_solve_ref".into()); }
    if digest_value.is_none() { reasons.push("missing_visual_solve_digest".into()); }
    if intrinsics_source.as_deref() == Some("auto_self_calibrated") {
        reasons.push("auto_self_calibrated".into());
    }
    for blocked in ["no_intrinsics_anchor", "ba_budget_exhausted"] {
        if warning_codes.iter().any(|code| code == blocked) { reasons.push(blocked.into()); }
    }
    if !withheld_validation_passed { reasons.push("missing_withheld_validation".into()); }
    if digest_value.as_ref().and_then(|v| v.get("status")).and_then(serde_json::Value::as_str) != Some("success") {
        reasons.push("visual_solve_not_success".into());
    }
    VpcalGeometryProvenance {
        source: if solve_ref.is_some() { "rebuilt_alignment_solve_ref" } else { "nominal" },
        solve_ref: solve_ref.as_ref().map(|path| path.display().to_string()),
        solve_ref_sha256,
        visual_solve_digest: digest_path.map(|path| path.display().to_string()),
        intrinsics_source,
        warning_codes,
        withheld_validation_passed,
        formal_eligible: reasons.is_empty(),
        reasons,
    }
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
        // Windows rename does not replace an existing destination. Move the
        // previous export aside first, and restore it if installing the new
        // file fails, so an update error never silently destroys valid data.
        if path.exists() {
            let backup = path.with_extension(format!(
                "{}.bak",
                path.extension().and_then(|s| s.to_str()).unwrap_or("json")
            ));
            if backup.exists() {
                std::fs::remove_file(&backup)?;
            }
            std::fs::rename(path, &backup)?;
            if let Err(install_error) = std::fs::rename(&tmp, path) {
                let restore_result = std::fs::rename(&backup, path);
                return match restore_result {
                    Ok(()) => Err(install_error.into()),
                    Err(restore_error) => Err(VoloError::Io(format!(
                        "failed to install new export ({install_error}); also failed to restore {} from {} ({restore_error})",
                        path.display(),
                        backup.display()
                    ))),
                };
            }
            std::fs::remove_file(&backup)?;
        } else {
            return Err(first.into());
        }
    }
    Ok(())
}

/// Export the active Stage geometry to vpcal ScreenDefinition v1.  Screens in
/// a rebuilt-alignment group use `A ∘ B_s` (`solve_ref` SE(3) for joint
/// screens); only screens without measured alignment use nominal placement.
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
    let rebuilt = rebuilt_export_placement(&project_path, &project, &screen_id)?;
    let source = serde_json::to_vec(&serde_json::json!({
        "screen_id": screen_id,
        "screen": screen,
        "project_unit": project.project.unit,
        "rebuilt_alignment": mesh_app::placement::alignment_for_screen(&project, &screen_id),
        "solve_ref_digest": rebuilt.as_ref().and_then(|(_, digest)| digest.as_ref()),
    }))?;
    let fingerprint = format!("{:x}", Sha256::digest(&source));
    let grid = mesh_app::lens_workspace::pattern_grid_for_screen(screen);
    let geometry_provenance = export_geometry_provenance(
        &project_path, &project, &screen_id,
        rebuilt.as_ref().and_then(|(_, digest)| digest.clone()),
    );
    let sections = if let Some((placement, _)) = rebuilt.as_ref() {
        let mut local_screen = screen.clone();
        local_screen.position_m = [0.0, 0.0, 0.0];
        local_screen.yaw_deg = 0.0;
        local_screen.height_offset_mm = 0.0;
        vpcal_sections(&screen_id, &local_screen, &project)?
            .into_iter()
            .map(|section| transform_section(section, placement))
            .collect()
    } else {
        vpcal_sections(&screen_id, screen, &project)?
    };
    let definition = VpcalScreenDefinition {
        name: format!("{} / {}", project.project.name, screen_id),
        unit: "mm",
        cabinet_size: grid.cell_size_mm,
        led_pixel_pitch_mm: pixel_pitch(screen)?,
        markers_per_cabinet: grid.markers_per_cell,
        sections,
        geometry_provenance,
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
        let grid = json["cabinet_size"].as_array().unwrap();
        assert!((grid[0].as_f64().unwrap() - 500.0 / 3.0).abs() < 1.0e-9);
        assert!((grid[1].as_f64().unwrap() - 500.0 / 3.0).abs() < 1.0e-9);
        assert_eq!(json["markers_per_cabinet"], 1);
        assert_eq!(json["led_pixel_pitch_mm"], 2.0);
        assert_eq!(json["sections"][0]["type"], "plane");
        assert_eq!(json["sections"][0]["width_mm"], 2000.0);
        assert_eq!(json["geometry_provenance"]["formal_eligible"], false);
        assert!(json["geometry_provenance"]["reasons"]
            .as_array().unwrap().iter().any(|value| value == "missing_solve_ref"));
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

    #[test]
    fn atomic_write_replaces_existing_export_without_leaving_backup() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("screen.json");
        std::fs::write(&path, b"old").unwrap();

        write_atomic(&path, b"new").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert!(!dir.path().join("screen.json.bak").exists());
        assert!(!dir.path().join("screen.json.tmp").exists());
    }
}
