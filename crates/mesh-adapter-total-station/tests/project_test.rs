use mesh_adapter_total_station::project::{
    BottomCompletion, FallbackMethod, ProjectConfig, ScreenConfig, ShapePriorConfig,
};

#[test]
fn project_config_round_trips_curved_screen() {
    let yaml = r#"
project:
  name: Studio_A_Volume
screens:
  MAIN:
    cabinet_count: [120, 20]
    cabinet_size_mm: [500, 500]
    shape_prior:
      type: curved
      radius_mm: 30000
    bottom_completion:
      lowest_measurable_row: 5
      fallback_method: vertical
coordinate_system:
  origin_grid_name: MAIN_V001_R005
  x_axis_grid_name: MAIN_V120_R005
  xy_plane_grid_name: MAIN_V001_R020
"#;
    let cfg: ProjectConfig = serde_yaml::from_str(yaml).unwrap();
    assert_eq!(cfg.project.name, "Studio_A_Volume");
    let main: &ScreenConfig = cfg.screens.get("MAIN").unwrap();
    assert_eq!(main.cabinet_count, [120, 20]);
    assert_eq!(main.cabinet_size_mm, [500.0, 500.0]);
    match &main.shape_prior {
        ShapePriorConfig::Curved { radius_mm } => assert_eq!(*radius_mm, 30000.0),
        _ => panic!("expected Curved"),
    }
    let bc: &BottomCompletion = main.bottom_completion.as_ref().unwrap();
    assert_eq!(bc.lowest_measurable_row, 5);
    assert!(matches!(bc.fallback_method, FallbackMethod::Vertical));
    assert_eq!(cfg.coordinate_system.origin_grid_name, "MAIN_V001_R005");
}

#[test]
fn project_config_flat_no_bottom_completion() {
    let yaml = r#"
project:
  name: TestFlat
screens:
  MAIN:
    cabinet_count: [4, 2]
    cabinet_size_mm: [500, 500]
    shape_prior:
      type: flat
coordinate_system:
  origin_grid_name: MAIN_V001_R001
  x_axis_grid_name: MAIN_V005_R001
  xy_plane_grid_name: MAIN_V001_R003
"#;
    let cfg: ProjectConfig = serde_yaml::from_str(yaml).unwrap();
    let main = cfg.screens.get("MAIN").unwrap();
    assert!(matches!(main.shape_prior, ShapePriorConfig::Flat));
    assert!(main.bottom_completion.is_none());
}

fn parse(yaml: &str) -> ProjectConfig {
    serde_yaml::from_str(yaml).unwrap()
}

#[test]
fn validate_accepts_valid_curved() {
    // radius 30000 vs total width 60000 → 2*radius == width, boundary OK.
    let cfg = parse(
        r#"
project: { name: ok }
screens:
  MAIN:
    cabinet_count: [120, 20]
    cabinet_size_mm: [500, 500]
    shape_prior: { type: curved, radius_mm: 30000 }
coordinate_system:
  origin_grid_name: MAIN_V001_R001
  x_axis_grid_name: MAIN_V120_R001
  xy_plane_grid_name: MAIN_V001_R020
"#,
    );
    assert!(cfg.validate().is_ok());
}

#[test]
fn validate_rejects_zero_cabinet_count() {
    let cfg = parse(
        r#"
project: { name: bad }
screens:
  MAIN:
    cabinet_count: [0, 2]
    cabinet_size_mm: [500, 500]
    shape_prior: { type: flat }
coordinate_system:
  origin_grid_name: MAIN_V001_R001
  x_axis_grid_name: MAIN_V001_R003
  xy_plane_grid_name: MAIN_V001_R002
"#,
    );
    let err = cfg.validate().unwrap_err();
    assert!(format!("{err}").contains("cabinet_count"));
}

#[test]
fn validate_rejects_curved_radius_too_small() {
    let cfg = parse(
        r#"
project: { name: bad }
screens:
  MAIN:
    cabinet_count: [10, 2]
    cabinet_size_mm: [500, 500]
    shape_prior: { type: curved, radius_mm: 1000 }
coordinate_system:
  origin_grid_name: MAIN_V001_R001
  x_axis_grid_name: MAIN_V011_R001
  xy_plane_grid_name: MAIN_V001_R003
"#,
    );
    let err = cfg.validate().unwrap_err();
    assert!(format!("{err}").contains("radius_mm"));
}

#[test]
fn validate_rejects_lowest_row_out_of_range() {
    let cfg = parse(
        r#"
project: { name: bad }
screens:
  MAIN:
    cabinet_count: [4, 2]
    cabinet_size_mm: [500, 500]
    shape_prior: { type: flat }
    bottom_completion: { lowest_measurable_row: 99, fallback_method: vertical }
coordinate_system:
  origin_grid_name: MAIN_V001_R001
  x_axis_grid_name: MAIN_V005_R001
  xy_plane_grid_name: MAIN_V001_R003
"#,
    );
    let err = cfg.validate().unwrap_err();
    assert!(format!("{err}").contains("lowest_measurable_row"));
}

#[test]
fn validate_rejects_duplicate_coordinate_grid_names() {
    let cfg = parse(
        r#"
project: { name: bad }
screens:
  MAIN:
    cabinet_count: [4, 2]
    cabinet_size_mm: [500, 500]
    shape_prior: { type: flat }
coordinate_system:
  origin_grid_name: MAIN_V001_R001
  x_axis_grid_name: MAIN_V001_R001
  xy_plane_grid_name: MAIN_V001_R003
"#,
    );
    let err = cfg.validate().unwrap_err();
    assert!(format!("{err}").contains("distinct"));
}

#[test]
fn load_project_from_path() {
    use mesh_adapter_total_station::project_loader::load_project;
    use std::path::PathBuf;

    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests/fixtures/sample_project.yaml");
    let cfg = load_project(&p).unwrap();
    assert_eq!(cfg.project.name, "Studio_A_Volume");
    assert!(cfg.screens.contains_key("MAIN"));
}

#[test]
fn load_project_rejects_invalid_geometry() {
    use mesh_adapter_total_station::project_loader::load_project;
    use std::path::PathBuf;

    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests/fixtures/invalid_project.yaml");
    let err = load_project(&p).unwrap_err();
    assert!(format!("{err}").contains("cabinet_count"));
}
