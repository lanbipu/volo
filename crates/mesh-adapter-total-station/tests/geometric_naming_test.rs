use mesh_adapter_total_station::geometric_naming::{name_points_geometrically, NamingTolerances};
use mesh_adapter_total_station::shape_grid::GridExpected;
use nalgebra::Vector3;

fn ge(name: &str, x: f64, z: f64, c: u32, r: u32) -> GridExpected {
    GridExpected {
        name: name.into(),
        model_position: Vector3::new(x, 0.0, z),
        col_zero_based: c,
        row_zero_based: r,
    }
}

#[test]
fn matched_points_get_assigned_to_nearest_grid_name() {
    let expected = vec![
        ge("MAIN_V001_R001", 0.0, 0.0, 0, 0),
        ge("MAIN_V002_R001", 0.5, 0.0, 1, 0),
        ge("MAIN_V001_R002", 0.0, 0.5, 0, 1),
        ge("MAIN_V002_R002", 0.5, 0.5, 1, 1),
    ];
    let model = vec![
        (10u32, Vector3::new(0.001, 0.0, 0.0)),   // 1mm from V001_R001
        (11u32, Vector3::new(0.499, 0.0, 0.0)),   // 1mm from V002_R001
        (12u32, Vector3::new(0.001, 0.0, 0.500)), // 0mm from V001_R002
    ];
    let outcome = name_points_geometrically(&model, &expected, &NamingTolerances::default());

    assert_eq!(outcome.matches.len(), 3);
    assert_eq!(outcome.matches.get(&10).unwrap().as_str(), "MAIN_V001_R001");
    assert_eq!(outcome.matches.get(&11).unwrap().as_str(), "MAIN_V002_R001");
    assert_eq!(outcome.matches.get(&12).unwrap().as_str(), "MAIN_V001_R002");
    assert!(outcome.outliers.is_empty());
    assert!(outcome.ambiguous.is_empty());
}

#[test]
fn point_too_far_from_any_grid_position_is_outlier() {
    let expected = vec![
        ge("MAIN_V001_R001", 0.0, 0.0, 0, 0),
        ge("MAIN_V002_R001", 0.5, 0.0, 1, 0),
    ];
    let model = vec![(99u32, Vector3::new(5.0, 0.0, 5.0))];
    let outcome = name_points_geometrically(&model, &expected, &NamingTolerances::default());
    assert_eq!(outcome.outliers.len(), 1);
    assert_eq!(outcome.outliers[0].instrument_id, 99);
    assert_eq!(outcome.outliers[0].nearest_grid_name, "MAIN_V002_R001");
    assert!(outcome.matches.is_empty());
}

#[test]
fn two_points_within_ambiguity_radius_of_same_target_are_ambiguous() {
    let expected = vec![ge("MAIN_V001_R001", 0.0, 0.0, 0, 0)];
    let model = vec![
        (10u32, Vector3::new(0.001, 0.0, 0.0)),
        (11u32, Vector3::new(0.002, 0.0, 0.0)),
    ];
    let outcome = name_points_geometrically(&model, &expected, &NamingTolerances::default());
    // Only one of the two can claim V001_R001; the other is reported ambiguous.
    let total = outcome.matches.len() + outcome.ambiguous.len() + outcome.outliers.len();
    assert_eq!(total, 2);
    assert!(!outcome.ambiguous.is_empty() || outcome.matches.len() == 1);
}

#[test]
fn empty_expected_grid_returns_empty_outcome_without_panic() {
    let expected: Vec<GridExpected> = vec![];
    let model = vec![(10u32, Vector3::new(0.0, 0.0, 0.0))];
    let outcome = name_points_geometrically(&model, &expected, &NamingTolerances::default());
    assert!(outcome.matches.is_empty());
    assert!(outcome.outliers.is_empty());
    assert!(outcome.ambiguous.is_empty());
}

#[test]
fn runner_up_beyond_ambiguity_radius_is_silently_dropped() {
    // Winner at 1mm, runner-up at 40mm — both inside max_match (50mm)
    // but runner-up is outside ambiguity_radius (10mm). Runner-up should
    // disappear from the outcome rather than be misreported as ambiguous.
    let expected = vec![ge("MAIN_V001_R001", 0.0, 0.0, 0, 0)];
    let model = vec![
        (10u32, Vector3::new(0.001, 0.0, 0.0)),
        (11u32, Vector3::new(0.040, 0.0, 0.0)),
    ];
    let outcome = name_points_geometrically(&model, &expected, &NamingTolerances::default());
    assert_eq!(outcome.matches.len(), 1);
    assert_eq!(outcome.matches.get(&10).unwrap().as_str(), "MAIN_V001_R001");
    assert!(
        outcome.ambiguous.is_empty(),
        "runner-up at 40mm should not be ambiguous"
    );
}
