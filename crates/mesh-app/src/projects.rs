use include_dir::{include_dir, Dir};
use volo_shared::dto::ProjectConfig;
use volo_shared::error::{VoloError, VoloResult};
use std::path::{Path, PathBuf};

// examples/ 在编译期嵌入(相对 crates/mesh-app -> ../../examples)。
static EXAMPLES: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../examples");

/// 内置 example 名列表(供 dry-run 校验 / 错误提示)。
pub fn embedded_example_names() -> Vec<String> {
    EXAMPLES
        .dirs()
        .filter_map(|d| d.path().file_name().and_then(|n| n.to_str()).map(String::from))
        .collect()
}

/// 把内置 example 释放到 `target_dir/<name>`。原子语义:先写到目标同级的
/// staging 目录,成功后 `rename` 到目标;任何一步失败都清掉 staging,目标保持
/// 不存在(无半成品残留)。**拒绝覆盖已存在目标**——避免与既有文件混合成
/// 损坏的 example;要重新 seed 须自己先删目标。
/// transport-free:CLI 与未来 MCP server 共用这一份。
pub fn seed_embedded_example(name: &str, target_dir: &Path) -> VoloResult<PathBuf> {
    // Fix 1: validate against top-level whitelist FIRST so execute and dry-run
    // both reject path components (e.g. "curved-flat/measurements") identically.
    if !embedded_example_names().iter().any(|n| n == name) {
        return Err(VoloError::NotFound(format!(
            "example '{name}' not found; available: {:?}",
            embedded_example_names()
        )));
    }
    let src = EXAMPLES.get_dir(name).ok_or_else(|| {
        VoloError::NotFound(format!("example '{name}' not found; available: {:?}", embedded_example_names()))
    })?;
    let dst = target_dir.join(name);
    if dst.exists() {
        return Err(VoloError::InvalidInput(format!(
            "destination already exists: {} (remove it first to re-seed)",
            dst.display()
        )));
    }
    std::fs::create_dir_all(target_dir)?;
    // staging 放在目标同一父目录下,保证 rename 不跨文件系统(/tmp 会 EXDEV)。
    let staging = target_dir.join(format!(".{name}.seed.{}.tmp", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    let staged = (|| -> VoloResult<()> {
        std::fs::create_dir_all(&staging)?;
        write_embedded_dir_contents(src, &staging)
    })();
    match staged {
        // Fix 2: if rename fails (race: dst created after exists() check, or
        // parent removed), clean up staging before returning the error so no
        // .name.seed.<pid>.tmp dir is left behind.
        Ok(()) => match std::fs::rename(&staging, &dst) {
            Ok(()) => Ok(dst),
            Err(e) => {
                let _ = std::fs::remove_dir_all(&staging);
                Err(VoloError::Io(format!("finalize seed rename: {e}")))
            }
        },
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            Err(e)
        }
    }
}

/// 把 include_dir 的某个 Dir 的内容(剥掉自身名字前缀)递归写到 `out_dir`。
fn write_embedded_dir_contents(dir: &Dir, out_dir: &Path) -> VoloResult<()> {
    for f in dir.files() {
        let name = f.path().file_name().expect("embedded file has a name");
        std::fs::write(out_dir.join(name), f.contents())?;
    }
    for sub in dir.dirs() {
        let name = sub.path().file_name().expect("embedded dir has a name");
        let sub_out = out_dir.join(name);
        std::fs::create_dir_all(&sub_out)?;
        write_embedded_dir_contents(sub, &sub_out)?;
    }
    Ok(())
}

/// Pure helper used by command + integration tests.
pub fn seed_example_to_dir(
    examples_root: &Path,
    example_name: &str,
    target_dir: &Path,
) -> VoloResult<PathBuf> {
    let src = examples_root.join(example_name);
    if !src.is_dir() {
        return Err(VoloError::NotFound(format!(
            "example '{example_name}' (looked in {})",
            examples_root.display()
        )));
    }
    let dst = target_dir.join(example_name);
    copy_dir_recursive(&src, &dst)?;
    Ok(dst)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> VoloResult<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

// ── project.yaml load / save ──────────────────────────────────────────────────

/// Pure helper: read project.yaml from `abs_path/project.yaml`.
/// Returns `NotFound` if the file does not exist.
pub fn load_project_yaml_from_path(abs_path: &Path) -> VoloResult<ProjectConfig> {
    let yaml_path = abs_path.join("project.yaml");
    if !yaml_path.is_file() {
        return Err(VoloError::NotFound(yaml_path.display().to_string()));
    }
    let yaml = std::fs::read_to_string(&yaml_path)?;
    Ok(serde_yaml::from_str(&yaml)?)
}

/// Pure helper: write `config` to `abs_path/project.yaml` atomically (temp + rename).
pub fn save_project_yaml_to_path(abs_path: &Path, config: &ProjectConfig) -> VoloResult<()> {
    std::fs::create_dir_all(abs_path)?;
    let yaml = serde_yaml::to_string(config)?;
    let final_path = abs_path.join("project.yaml");
    let tmp_path = abs_path.join("project.yaml.tmp");
    std::fs::write(&tmp_path, yaml)?;
    std::fs::rename(&tmp_path, &final_path)?;
    Ok(())
}

#[cfg(test)]
mod project_yaml_method_tests {
    use super::*;
    use volo_shared::dto::{ProjectConfig, ProjectMeta, SurveyMethod};
    use tempfile::tempdir;

    fn minimal_config(method: Option<SurveyMethod>) -> ProjectConfig {
        use volo_shared::dto::{
            CoordinateSystemConfig, OutputConfig, ScreenConfig, ShapeMode, ShapePriorConfig,
        };
        use std::collections::BTreeMap;

        let mut screens = BTreeMap::new();
        screens.insert(
            "MAIN".to_string(),
            ScreenConfig {
                cabinet_count: [4, 2],
                cabinet_size_mm: [500.0, 500.0],
                pixels_per_cabinet: None,
                shape_prior: ShapePriorConfig::Flat,
                shape_mode: ShapeMode::Rectangle,
                irregular_mask: vec![],
                bottom_completion: None,
                position_m: [0.0, 0.0, 0.0],
                yaw_deg: 0.0,
                height_offset_mm: 0.0,
            },
        );
        ProjectConfig {
            project: ProjectMeta {
                name: "X".into(),
                unit: "mm".into(),
                method,
            },
            screens,
            coordinate_system: CoordinateSystemConfig {
                origin_point: "MAIN_V001_R001".into(),
                x_axis_point: "MAIN_V004_R001".into(),
                xy_plane_point: "MAIN_V001_R002".into(),
            },
            output: OutputConfig {
                target: "disguise".into(),
                obj_filename: "{screen_id}.obj".into(),
                weld_vertices_tolerance_mm: 1.0,
                triangulate: true,
            },
        }
    }

    #[test]
    fn load_save_roundtrip_with_method_m1() {
        let dir = tempdir().unwrap();
        let cfg = minimal_config(Some(SurveyMethod::M1));
        save_project_yaml_to_path(dir.path(), &cfg).unwrap();
        let loaded = load_project_yaml_from_path(dir.path()).unwrap();
        assert_eq!(loaded.project.method, Some(SurveyMethod::M1));
    }

    #[test]
    fn load_save_roundtrip_with_method_m2() {
        let dir = tempdir().unwrap();
        let cfg = minimal_config(Some(SurveyMethod::M2));
        save_project_yaml_to_path(dir.path(), &cfg).unwrap();
        let loaded = load_project_yaml_from_path(dir.path()).unwrap();
        assert_eq!(loaded.project.method, Some(SurveyMethod::M2));
    }

    #[test]
    fn load_legacy_yaml_without_method() {
        let dir = tempdir().unwrap();
        let legacy = r#"
project:
  name: Legacy
  unit: mm
screens:
  MAIN:
    cabinet_count: [4, 2]
    cabinet_size_mm: [500, 500]
    shape_prior:
      type: flat
    shape_mode: rectangle
    irregular_mask: []
coordinate_system:
  origin_point: MAIN_V001_R001
  x_axis_point: MAIN_V004_R001
  xy_plane_point: MAIN_V001_R002
output:
  target: disguise
  obj_filename: "{screen_id}.obj"
  weld_vertices_tolerance_mm: 1.0
  triangulate: true
"#;
        std::fs::write(dir.path().join("project.yaml"), legacy).unwrap();
        let loaded = load_project_yaml_from_path(dir.path()).unwrap();
        assert_eq!(loaded.project.method, None);
    }
}
