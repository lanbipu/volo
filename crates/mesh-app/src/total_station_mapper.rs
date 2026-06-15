//! GUI `dto::ProjectConfig` → `mesh_adapter_total_station::ProjectConfig` 字段映射。
//!
//! 两边各自的 schema 独立演进（GUI 偏面向 UI，adapter 偏面向算法）。
//! 这个模块是唯一的桥。
//!
//! Pre-existing inconsistency（不在本 task 范围）：GUI `CabinetGrid.vue` 用 1-based
//! cell coords 存 `irregular_mask`，但 `core::shape::CabinetArray::absent_cells` 注释
//! 是 0-based。`src-tauri/src/commands/export.rs` 也照 0-based 直传。本 mapper 保持
//! 跟 export.rs 同步（pass-through 当 0-based），等 M0.3 统一修。

use mesh_adapter_total_station::project as m1;
use volo_shared::dto;
use volo_shared::error::{LmtError, LmtResult};

pub fn map_to_adapter(cfg: &dto::ProjectConfig) -> LmtResult<m1::ProjectConfig> {
    use std::collections::HashMap;

    let mut screens: HashMap<String, m1::ScreenConfig> = HashMap::new();
    for (id, s) in &cfg.screens {
        screens.insert(id.clone(), map_screen(s)?);
    }

    let m1_cfg = m1::ProjectConfig {
        project: m1::ProjectMeta {
            name: cfg.project.name.clone(),
        },
        screens,
        coordinate_system: m1::CoordinateSystemConfig {
            origin_grid_name: cfg.coordinate_system.origin_point.clone(),
            x_axis_grid_name: cfg.coordinate_system.x_axis_point.clone(),
            xy_plane_grid_name: cfg.coordinate_system.xy_plane_point.clone(),
        },
    };

    // M1 validate first — catches no-screens, bad cabinet dims, distinct refs,
    // etc. with adapter-authored messages.
    m1_cfg.validate().map_err(LmtError::from)?;

    // Then the GUI-side extra check: grid names must use a known screen ID
    // as prefix. M1 validate doesn't parse names, so this catches typos /
    // wrong-screen refs that would otherwise blow up later in builder.
    let screen_ids: Vec<&str> = cfg.screens.keys().map(String::as_str).collect();
    for (label, name) in [
        ("origin_point", &cfg.coordinate_system.origin_point),
        ("x_axis_point", &cfg.coordinate_system.x_axis_point),
        ("xy_plane_point", &cfg.coordinate_system.xy_plane_point),
    ] {
        check_grid_name_prefix(label, name, &screen_ids)?;
    }

    Ok(m1_cfg)
}

fn check_grid_name_prefix(label: &str, name: &str, screen_ids: &[&str]) -> LmtResult<()> {
    // Longest-prefix-first so e.g. {"MAIN", "MAIN_AUX"} both with "MAIN_AUX_V001_R001"
    // resolves to MAIN_AUX, not MAIN. After matching a screen prefix, the suffix
    // must be exactly `_V<digits>_R<digits>` — no other shape is a valid grid name.
    let mut candidates: Vec<&&str> = screen_ids.iter().collect();
    candidates.sort_by_key(|sid| std::cmp::Reverse(sid.len()));

    for sid in candidates {
        let Some(rest) = name.strip_prefix(sid) else {
            continue;
        };
        let Some(rest) = rest.strip_prefix('_') else {
            continue;
        };
        if grid_suffix_valid(rest) {
            return Ok(());
        }
    }
    Err(LmtError::InvalidInput(format!(
        "coordinate_system.{label} = {name:?} does not look like \
         '<screen_id>_V###_R###' for any screen in this project (known: {screen_ids:?})"
    )))
}

/// Validate the part after `<screen>_`: must be exactly `V<digits>_R<digits>`.
fn grid_suffix_valid(s: &str) -> bool {
    let Some(rest) = s.strip_prefix('V') else {
        return false;
    };
    let Some((v_digits, after_v)) = split_digits(rest) else {
        return false;
    };
    if v_digits.is_empty() {
        return false;
    }
    let Some(rest) = after_v.strip_prefix("_R") else {
        return false;
    };
    let Some((r_digits, tail)) = split_digits(rest) else {
        return false;
    };
    !r_digits.is_empty() && tail.is_empty()
}

fn split_digits(s: &str) -> Option<(&str, &str)> {
    let split = s
        .bytes()
        .position(|b| !b.is_ascii_digit())
        .unwrap_or(s.len());
    Some((&s[..split], &s[split..]))
}

fn map_screen(s: &dto::ScreenConfig) -> LmtResult<m1::ScreenConfig> {
    let shape_prior = match &s.shape_prior {
        dto::ShapePriorConfig::Flat => m1::ShapePriorConfig::Flat,
        dto::ShapePriorConfig::Curved {
            radius_mm,
            fold_seams_at_columns,
        } => {
            if fold_seams_at_columns.is_empty() {
                m1::ShapePriorConfig::Curved {
                    radius_mm: *radius_mm,
                }
            } else {
                return Err(LmtError::InvalidInput(
                    "shape_prior Curved with non-empty fold_seams_at_columns is not supported \
                     by M1 adapter (radius would be lost); pick pure Curved (drop seams) or \
                     switch to Folded"
                        .to_string(),
                ));
            }
        }
        dto::ShapePriorConfig::Folded {
            fold_seams_at_columns,
        } => m1::ShapePriorConfig::Folded {
            fold_seam_columns: fold_seams_at_columns.clone(),
        },
    };

    let bottom_completion = s
        .bottom_completion
        .as_ref()
        .map(|bc| -> LmtResult<m1::BottomCompletion> {
            let fallback_method = match bc.fallback_method.as_str() {
                "vertical" | "vertical_extension" => m1::FallbackMethod::Vertical,
                other => {
                    return Err(LmtError::InvalidInput(format!(
                        "bottom_completion.fallback_method {other:?} is not supported; \
                         M1 currently accepts vertical / vertical_extension"
                    )));
                }
            };
            Ok(m1::BottomCompletion {
                lowest_measurable_row: bc.lowest_measurable_row,
                fallback_method,
            })
        })
        .transpose()?;

    // Mirror export.rs behavior: Rectangle ignores irregular_mask (treated as stale).
    let absent_cells = match s.shape_mode {
        dto::ShapeMode::Rectangle => vec![],
        dto::ShapeMode::Irregular => s
            .irregular_mask
            .iter()
            .map(|c| (c[0], c[1]))
            .collect::<Vec<_>>(),
    };

    Ok(m1::ScreenConfig {
        cabinet_count: s.cabinet_count,
        cabinet_size_mm: s.cabinet_size_mm,
        shape_prior,
        bottom_completion,
        absent_cells,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn flat_screen() -> dto::ScreenConfig {
        dto::ScreenConfig {
            cabinet_count: [4, 2],
            cabinet_size_mm: [500.0, 500.0],
            pixels_per_cabinet: Some([256, 256]),
            shape_prior: dto::ShapePriorConfig::Flat,
            shape_mode: dto::ShapeMode::Rectangle,
            irregular_mask: vec![],
            bottom_completion: None,
        }
    }

    fn base_cfg(screen: dto::ScreenConfig) -> dto::ProjectConfig {
        let mut screens = BTreeMap::new();
        screens.insert("MAIN".into(), screen);
        dto::ProjectConfig {
            project: dto::ProjectMeta {
                name: "T".into(),
                unit: "mm".into(),
                method: None,
            },
            screens,
            coordinate_system: dto::CoordinateSystemConfig {
                origin_point: "MAIN_V001_R001".into(),
                x_axis_point: "MAIN_V005_R001".into(),
                xy_plane_point: "MAIN_V001_R003".into(),
            },
            output: dto::OutputConfig {
                target: "disguise".into(),
                obj_filename: "{screen_id}.obj".into(),
                weld_vertices_tolerance_mm: 1.0,
                triangulate: true,
            },
        }
    }

    #[test]
    fn flat_screen_maps_minimal_fields() {
        let cfg = base_cfg(flat_screen());
        let m = map_to_adapter(&cfg).unwrap();

        assert_eq!(m.project.name, "T");
        assert_eq!(m.screens.len(), 1);
        let s = m.screens.get("MAIN").unwrap();
        assert_eq!(s.cabinet_count, [4, 2]);
        assert_eq!(s.cabinet_size_mm, [500.0, 500.0]);
        assert!(matches!(s.shape_prior, m1::ShapePriorConfig::Flat));
        assert!(s.absent_cells.is_empty());

        assert_eq!(m.coordinate_system.origin_grid_name, "MAIN_V001_R001");
        assert_eq!(m.coordinate_system.x_axis_grid_name, "MAIN_V005_R001");
        assert_eq!(m.coordinate_system.xy_plane_grid_name, "MAIN_V001_R003");
    }

    #[test]
    fn irregular_mask_to_absent_cells() {
        let mut s = flat_screen();
        s.shape_mode = dto::ShapeMode::Irregular;
        s.irregular_mask = vec![[0, 0], [3, 1]];
        let cfg = base_cfg(s);
        let m = map_to_adapter(&cfg).unwrap();
        let cells = &m.screens.get("MAIN").unwrap().absent_cells;
        assert_eq!(cells, &vec![(0u32, 0u32), (3u32, 1u32)]);
    }

    #[test]
    fn curved_without_folds_maps_to_curved() {
        let mut s = flat_screen();
        s.shape_prior = dto::ShapePriorConfig::Curved {
            radius_mm: 6000.0,
            fold_seams_at_columns: vec![],
        };
        let cfg = base_cfg(s);
        let m = map_to_adapter(&cfg).unwrap();
        match &m.screens.get("MAIN").unwrap().shape_prior {
            m1::ShapePriorConfig::Curved { radius_mm } => assert_eq!(*radius_mm, 6000.0),
            other => panic!("expected Curved, got {other:?}"),
        }
    }

    #[test]
    fn folded_renames_seam_field() {
        let mut s = flat_screen();
        s.shape_prior = dto::ShapePriorConfig::Folded {
            fold_seams_at_columns: vec![2, 4],
        };
        let cfg = base_cfg(s);
        let m = map_to_adapter(&cfg).unwrap();
        match &m.screens.get("MAIN").unwrap().shape_prior {
            m1::ShapePriorConfig::Folded { fold_seam_columns } => {
                assert_eq!(fold_seam_columns, &vec![2u32, 4u32]);
            }
            other => panic!("expected Folded, got {other:?}"),
        }
    }

    #[test]
    fn curved_with_folds_returns_error() {
        // Curved + 非空 fold_seams 在 M1 那边没有保留 radius 的表达；
        // 与其静默丢 radius 升级成 Folded，不如让用户显式选 shape_prior。
        let mut s = flat_screen();
        s.shape_prior = dto::ShapePriorConfig::Curved {
            radius_mm: 6000.0,
            fold_seams_at_columns: vec![3],
        };
        let cfg = base_cfg(s);
        let err = map_to_adapter(&cfg).unwrap_err();
        let msg = format!("{err}").to_lowercase();
        assert!(msg.contains("curved") && msg.contains("fold"), "got: {err}");
    }

    #[test]
    fn validate_propagates() {
        let mut cfg = base_cfg(flat_screen());
        cfg.screens.clear();
        let err = map_to_adapter(&cfg).unwrap_err();
        assert!(format!("{err}").to_lowercase().contains("no screens"));
    }

    #[test]
    fn bottom_completion_passes_through() {
        let mut s = flat_screen();
        s.bottom_completion = Some(dto::BottomCompletionConfig {
            lowest_measurable_row: 2,
            fallback_method: "vertical".into(),
            assumed_height_mm: 500.0,
        });
        let cfg = base_cfg(s);
        let m = map_to_adapter(&cfg).unwrap();
        let bc = m
            .screens
            .get("MAIN")
            .unwrap()
            .bottom_completion
            .as_ref()
            .unwrap();
        assert_eq!(bc.lowest_measurable_row, 2);
    }

    #[test]
    fn bottom_completion_accepts_vertical_extension_alias() {
        // GUI default writes "vertical_extension"; M1 only has Vertical.
        let mut s = flat_screen();
        s.bottom_completion = Some(dto::BottomCompletionConfig {
            lowest_measurable_row: 2,
            fallback_method: "vertical_extension".into(),
            assumed_height_mm: 0.0,
        });
        let cfg = base_cfg(s);
        let m = map_to_adapter(&cfg).unwrap();
        assert!(m.screens.get("MAIN").unwrap().bottom_completion.is_some());
    }

    #[test]
    fn bottom_completion_unknown_method_returns_error() {
        let mut s = flat_screen();
        s.bottom_completion = Some(dto::BottomCompletionConfig {
            lowest_measurable_row: 2,
            fallback_method: "telepathy".into(),
            assumed_height_mm: 0.0,
        });
        let cfg = base_cfg(s);
        let err = map_to_adapter(&cfg).unwrap_err();
        let msg = format!("{err}").to_lowercase();
        assert!(msg.contains("telepathy"), "got: {err}");
        assert!(msg.contains("vertical"), "got: {err}");
    }

    #[test]
    fn rectangle_with_stale_mask_drops_mask() {
        // export.rs already ignores irregular_mask under Rectangle;
        // mapper must mirror that to avoid feeding stale entries to M1.
        let mut s = flat_screen();
        s.shape_mode = dto::ShapeMode::Rectangle;
        s.irregular_mask = vec![[0, 0], [3, 1]];
        let cfg = base_cfg(s);
        let m = map_to_adapter(&cfg).unwrap();
        assert!(
            m.screens.get("MAIN").unwrap().absent_cells.is_empty(),
            "rectangle screens must not forward stale mask"
        );
    }

    #[test]
    fn coord_ref_must_match_known_screen_prefix() {
        let mut cfg = base_cfg(flat_screen());
        // Project only has MAIN; refs reference a non-existent FLOOR screen.
        cfg.coordinate_system.origin_point = "FLOOR_V001_R001".into();
        let err = map_to_adapter(&cfg).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("origin_point"), "got: {err}");
        assert!(msg.contains("FLOOR"), "got: {err}");
    }

    #[test]
    fn coord_ref_malformed_grid_name_returns_error() {
        let mut cfg = base_cfg(flat_screen());
        cfg.coordinate_system.x_axis_point = "MAIN_garbage".into();
        let err = map_to_adapter(&cfg).unwrap_err();
        assert!(format!("{err}").contains("x_axis_point"), "got: {err}");
    }

    #[test]
    fn coord_prefix_picks_longest_screen_id_match() {
        // Two screens MAIN and MAIN_AUX both exist. A ref like MAIN_AUX_V001_R001
        // must validate as belonging to MAIN_AUX (longest prefix), not MAIN.
        // We can't have two screens in the dto until multi-screen lands, so simulate
        // by extending the test config directly.
        let mut cfg = base_cfg(flat_screen());
        cfg.screens.insert("MAIN_AUX".into(), flat_screen());
        cfg.coordinate_system.origin_point = "MAIN_AUX_V001_R001".into();
        cfg.coordinate_system.x_axis_point = "MAIN_AUX_V005_R001".into();
        cfg.coordinate_system.xy_plane_point = "MAIN_AUX_V001_R003".into();
        // Should not fail with "does not look like ... for any screen".
        let _ = map_to_adapter(&cfg).unwrap();
    }

    #[test]
    fn coord_suffix_must_be_exactly_v_r_digits() {
        let bad_suffixes = [
            "MAIN_V_R001",          // empty V digits
            "MAIN_V001_R",          // empty R digits
            "MAIN_V01a_R001",       // non-digit in V
            "MAIN_V001_R001_extra", // trailing junk
            "MAIN_W001_R001",       // wrong letter
            "MAIN_V001",            // no R part
        ];
        for bad in bad_suffixes {
            let mut cfg = base_cfg(flat_screen());
            cfg.coordinate_system.origin_point = bad.into();
            let err = map_to_adapter(&cfg).unwrap_err();
            assert!(
                format!("{err}").contains("origin_point"),
                "rejecting {bad:?} should mention origin_point; got: {err}"
            );
        }
    }
}
