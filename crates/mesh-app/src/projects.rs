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

/// GUI「新建项目」:把 example 内容直接释放进 `dest_dir`(该目录本身即项目根),
/// 并把 project.name 改写为 `dest_dir` 的目录名。拒绝已含 project.yaml 的目录,
/// 避免覆盖既有项目。
pub fn seed_example_as_new_project(
    examples_root: &Path,
    example_name: &str,
    dest_dir: &Path,
) -> VoloResult<PathBuf> {
    let src = examples_root.join(example_name);
    if !src.is_dir() {
        return Err(VoloError::NotFound(format!(
            "example '{example_name}' (looked in {})",
            examples_root.display()
        )));
    }
    if dest_dir.join("project.yaml").is_file() {
        return Err(VoloError::InvalidInput(format!(
            "destination is already a project: {}",
            dest_dir.display()
        )));
    }
    copy_dir_recursive(&src, dest_dir)?;
    let mut config = load_project_yaml_from_path(dest_dir)?;
    if let Some(name) = dest_dir.file_name().and_then(|n| n.to_str()) {
        config.project.name = name.to_string();
    }
    save_project_yaml_to_path(dest_dir, &config)?;
    Ok(dest_dir.to_path_buf())
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
                output_topology: None,
                shape_prior: ShapePriorConfig::Flat,
                shape_mode: ShapeMode::Rectangle,
                irregular_mask: vec![],
                bottom_completion: None,
                position_m: [0.0, 0.0, 0.0],
                yaw_deg: 0.0,
                height_offset_mm: 0.0,
                normal_flip: false,
                origin_aligned: false,
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
            output_topology: None,
            rebuilt_alignment: None,
            cameras: vec![],
        }
    }

    #[test]
    fn load_save_roundtrip_with_method_m1() {
        let dir = tempdir().unwrap();
        let mut cfg = minimal_config(Some(SurveyMethod::M1));
        cfg.screens.get_mut("MAIN").unwrap().normal_flip = true;
        cfg.screens.get_mut("MAIN").unwrap().origin_aligned = true;
        save_project_yaml_to_path(dir.path(), &cfg).unwrap();
        let loaded = load_project_yaml_from_path(dir.path()).unwrap();
        assert_eq!(loaded.project.method, Some(SurveyMethod::M1));
        assert!(loaded.screens["MAIN"].normal_flip);
        assert!(loaded.screens["MAIN"].origin_aligned);
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
        assert!(!loaded.screens["MAIN"].normal_flip);
        assert!(!loaded.screens["MAIN"].origin_aligned);
    }

    #[test]
    fn seed_example_as_new_project_uses_folder_name() {
        let root = tempdir().unwrap();
        // 伪造 examples_root/demo,内含 project.yaml + 子目录文件
        let examples_root = root.path().join("examples");
        let src = examples_root.join("demo");
        std::fs::create_dir_all(src.join("measurements")).unwrap();
        save_project_yaml_to_path(&src, &minimal_config(None)).unwrap();
        std::fs::write(src.join("measurements/a.csv"), "x").unwrap();

        let dest = root.path().join("MyStage");
        std::fs::create_dir_all(&dest).unwrap();
        let out = seed_example_as_new_project(&examples_root, "demo", &dest).unwrap();
        assert_eq!(out, dest);
        let loaded = load_project_yaml_from_path(&dest).unwrap();
        assert_eq!(loaded.project.name, "MyStage");
        assert!(dest.join("measurements/a.csv").is_file());
    }

    #[test]
    fn seed_example_as_new_project_refuses_existing_project() {
        let root = tempdir().unwrap();
        let examples_root = root.path().join("examples");
        let src = examples_root.join("demo");
        std::fs::create_dir_all(&src).unwrap();
        save_project_yaml_to_path(&src, &minimal_config(None)).unwrap();

        let dest = root.path().join("Existing");
        save_project_yaml_to_path(&dest, &minimal_config(None)).unwrap();
        let err = seed_example_as_new_project(&examples_root, "demo", &dest).unwrap_err();
        assert!(matches!(err, VoloError::InvalidInput(_)));
        // 原 project.yaml 未被覆盖
        assert_eq!(load_project_yaml_from_path(&dest).unwrap().project.name, "X");
    }
}
