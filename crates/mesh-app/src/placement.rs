//! Rebuilt-mesh world placement: `P_s = A ∘ B_s`.
//!
//! Shared by viewport (via persisted yaml), OBJ export, and nDisplay consumers.
//! See `docs/calibrate/rebuilt-alignment-spec.md` §5.

use mesh_core::rigid::RigidTransform;
use nalgebra::Vector3;
use volo_shared::dto::{ProjectConfig, ScreenConfig, ScreenTransformsFile};

/// Look up the alignment group that contains `screen_id`, if any.
pub fn alignment_for_screen<'a>(
    project: &'a ProjectConfig,
    screen_id: &str,
) -> Option<&'a volo_shared::dto::RebuiltAlignmentGroup> {
    project
        .rebuilt_alignment
        .as_ref()?
        .groups
        .iter()
        .find(|g| g.screens.iter().any(|s| s == screen_id))
}

/// Nominal presentation SE(3) matching `apply_world_transform` / viewport
/// `applyScreenTransform`: yaw about model +Z, then translate (+ height_offset).
pub fn nominal_placement(screen_cfg: &ScreenConfig) -> RigidTransform {
    let theta = screen_cfg.yaw_deg.to_radians();
    let (s, c) = theta.sin_cos();
    let [tx, ty, tz] = screen_cfg.position_m;
    let tz = tz + screen_cfg.height_offset_mm / 1000.0;
    // Row-major R: x' = c·x + s·y, y' = -s·x + c·y, z' = z
    RigidTransform {
        rotation: [[c, s, 0.0], [-s, c, 0.0], [0.0, 0.0, 1.0]],
        t_m: [tx, ty, tz],
    }
}

/// Screen-to-frame SE(3) from a joint `visual_screen_transforms.v1` entry.
pub fn se3_from_screen_transform(
    xf: &ScreenTransformsFile,
    screen_id: &str,
) -> Option<RigidTransform> {
    let entry = xf.transforms.iter().find(|t| t.screen_id == screen_id)?;
    Some(RigidTransform {
        rotation: entry.rotation,
        t_m: [
            entry.t_mm[0] / 1000.0,
            entry.t_mm[1] / 1000.0,
            entry.t_mm[2] / 1000.0,
        ],
    })
}

/// Base placement `B_s`: joint SE(3) when present for this screen, else nominal.
pub fn base_placement(
    screen_cfg: &ScreenConfig,
    screen_id: &str,
    screen_transforms: Option<&ScreenTransformsFile>,
) -> RigidTransform {
    if let Some(xf) = screen_transforms {
        if let Some(se3) = se3_from_screen_transform(xf, screen_id) {
            return se3;
        }
    }
    nominal_placement(screen_cfg)
}

/// Final rebuilt placement `P_s = A ∘ B_s` (A defaults to identity).
pub fn resolve_rebuilt_placement(
    project: &ProjectConfig,
    screen_id: &str,
    screen_transforms: Option<&ScreenTransformsFile>,
) -> RigidTransform {
    let Some(screen_cfg) = project.screens.get(screen_id) else {
        return RigidTransform::identity();
    };
    let b = base_placement(screen_cfg, screen_id, screen_transforms);
    let a = match alignment_for_screen(project, screen_id) {
        Some(g) => RigidTransform {
            rotation: g.rotation,
            t_m: g.t_m,
        },
        None => RigidTransform::identity(),
    };
    a.compose(&b)
}

/// Apply a row-major rigid transform to vertices in place.
pub fn apply_rigid_transform(vertices: &mut [Vector3<f64>], xf: &RigidTransform) {
    xf.apply_inplace(vertices);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use volo_shared::dto::{
        CoordinateSystemConfig, OutputConfig, ProjectMeta, RebuiltAlignment,
        RebuiltAlignmentGroup, RebuiltAlignmentRefPoints, ScreenConfig, ShapeMode,
        ShapePriorConfig,
    };

    fn screen(pos: [f64; 3], yaw: f64) -> ScreenConfig {
        ScreenConfig {
            cabinet_count: [1, 1],
            cabinet_size_mm: [500.0, 500.0],
            pixels_per_cabinet: None,
            output_topology: None,
            shape_prior: ShapePriorConfig::Flat,
            shape_mode: ShapeMode::Rectangle,
            irregular_mask: vec![],
            bottom_completion: None,
            position_m: pos,
            yaw_deg: yaw,
            height_offset_mm: 0.0,
            normal_flip: false,
            origin_aligned: false,
        }
    }

    fn project_with(screens: BTreeMap<String, ScreenConfig>, align: Option<RebuiltAlignment>) -> ProjectConfig {
        ProjectConfig {
            project: ProjectMeta {
                name: "t".into(),
                unit: "m".into(),
                method: None,
            },
            screens,
            coordinate_system: CoordinateSystemConfig {
                origin_point: String::new(),
                x_axis_point: String::new(),
                xy_plane_point: String::new(),
            },
            output: OutputConfig {
                target: "neutral".into(),
                obj_filename: "out.obj".into(),
                weld_vertices_tolerance_mm: 1.0,
                triangulate: true,
            },
            output_topology: None,
            rebuilt_alignment: align,
        }
    }

    #[test]
    fn nominal_matches_legacy_yaw90_translate() {
        let cfg = screen([10.0, 0.0, 0.0], 90.0);
        let p = resolve_rebuilt_placement(
            &project_with(BTreeMap::from([("S".into(), cfg)]), None),
            "S",
            None,
        );
        let out = p.apply(&Vector3::new(1.0, 0.0, 5.0));
        assert!((out.x - 10.0).abs() < 1e-9, "got {out:?}");
        assert!((out.y - (-1.0)).abs() < 1e-9, "got {out:?}");
        assert!((out.z - 5.0).abs() < 1e-9, "got {out:?}");
    }

    #[test]
    fn alignment_composes_over_nominal() {
        let mut screens = BTreeMap::new();
        screens.insert("S".into(), screen([1.0, 0.0, 0.0], 0.0));
        let align = RebuiltAlignment {
            groups: vec![RebuiltAlignmentGroup {
                screens: vec!["S".into()],
                rotation: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
                t_m: [-1.0, 0.0, 0.0],
                ref_points: RebuiltAlignmentRefPoints {
                    origin: "S_V001_R001".into(),
                    x_axis: None,
                    xy_plane: None,
                },
                solve_ref: None,
                applied_at: "2026-07-19T00:00:00Z".into(),
            }],
        };
        let p = resolve_rebuilt_placement(&project_with(screens, Some(align)), "S", None);
        let out = p.apply(&Vector3::new(0.0, 0.0, 0.0));
        // B translates +1 on X, A translates -1 → identity overall for origin.
        assert!(out.norm() < 1e-9, "got {out:?}");
    }

    #[test]
    fn joint_se3_used_as_base() {
        let mut screens = BTreeMap::new();
        screens.insert("LG".into(), screen([99.0, 99.0, 99.0], 45.0)); // ignored when SE3 present
        let xf = ScreenTransformsFile {
            schema_version: "visual_screen_transforms.v1".into(),
            frame_screen_id: "ASUS".into(),
            transforms: vec![volo_shared::dto::ScreenTransformEntry {
                screen_id: "LG".into(),
                rotation: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
                t_mm: [2000.0, 0.0, 0.0],
                rms_px: 0.0,
                bridge_views: 0,
            }],
        };
        let p = resolve_rebuilt_placement(&project_with(screens, None), "LG", Some(&xf));
        let out = p.apply(&Vector3::new(0.0, 0.0, 0.0));
        assert!((out.x - 2.0).abs() < 1e-9, "got {out:?}");
    }
}
