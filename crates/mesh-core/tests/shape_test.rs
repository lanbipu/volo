use mesh_core::shape::{CabinetArray, ShapePrior};

#[test]
fn rectangle_array_yields_correct_grid_size() {
    let arr = CabinetArray::rectangle(120, 20, [500.0, 500.0]);
    assert_eq!(arr.cols, 120);
    assert_eq!(arr.rows, 20);
    assert_eq!(arr.cabinet_size_mm, [500.0, 500.0]);
    assert_eq!(arr.total_size_mm(), [60000.0, 10000.0]);
    assert!(arr.is_present(0, 0));
    assert!(arr.is_present(119, 19));
}

#[test]
fn irregular_array_respects_mask() {
    let arr = CabinetArray::irregular(
        10,
        10,
        [500.0, 500.0],
        vec![(5, 5), (5, 6), (6, 5), (6, 6)], // 4 missing cells
    );
    assert!(arr.is_present(0, 0));
    assert!(!arr.is_present(5, 5));
    assert!(!arr.is_present(6, 6));
    assert!(arr.is_present(4, 5));
}

#[test]
fn flat_prior_serializes() {
    let p = ShapePrior::Flat;
    let s = serde_yaml::to_string(&p).unwrap();
    assert!(s.contains("flat"));
}

#[test]
fn curved_prior_carries_radius() {
    let p = ShapePrior::Curved { radius_mm: 30000.0 };
    let s = serde_yaml::to_string(&p).unwrap();
    assert!(s.contains("curved"));
    assert!(s.contains("30000"));
}

#[test]
fn is_present_returns_false_out_of_bounds() {
    let arr = CabinetArray::rectangle(10, 10, [500.0, 500.0]);
    assert!(!arr.is_present(10, 0)); // col == cols
    assert!(!arr.is_present(0, 10)); // row == rows
    assert!(!arr.is_present(100, 100));
}

#[test]
fn cabinet_array_absent_cells_default_when_omitted_in_yaml() {
    // YAML missing absent_cells should deserialize fine (serde default).
    let yaml = r#"
cols: 4
rows: 4
cabinet_size_mm: [500.0, 500.0]
"#;
    let arr: CabinetArray = serde_yaml::from_str(yaml).unwrap();
    assert!(arr.absent_cells.is_empty());
    assert_eq!(arr.cols, 4);
}

#[test]
fn folded_prior_carries_seam_columns() {
    let p = ShapePrior::Folded {
        fold_seam_columns: vec![40, 80],
    };
    let s = serde_yaml::to_string(&p).unwrap();
    assert!(s.contains("folded"));
    assert!(s.contains("40"));
    assert!(s.contains("80"));

    // round-trip
    let back: ShapePrior = serde_yaml::from_str(&s).unwrap();
    match back {
        ShapePrior::Folded { fold_seam_columns } => {
            assert_eq!(fold_seam_columns, vec![40, 80]);
        }
        _ => panic!("expected Folded variant"),
    }
}

#[test]
fn deserialize_rejects_cabinet_array_exceeding_max_grid_dim() {
    let yaml = "cols: 20000\nrows: 100\ncabinet_size_mm: [500.0, 500.0]\n";
    let result: Result<CabinetArray, _> = serde_yaml::from_str(yaml);
    assert!(result.is_err());
}

#[test]
fn deserialize_rejects_cabinet_array_non_positive_size() {
    let yaml = "cols: 10\nrows: 10\ncabinet_size_mm: [0.0, 500.0]\n";
    let result: Result<CabinetArray, _> = serde_yaml::from_str(yaml);
    assert!(result.is_err(), "should reject zero size");

    let yaml = "cols: 10\nrows: 10\ncabinet_size_mm: [-100.0, 500.0]\n";
    let result: Result<CabinetArray, _> = serde_yaml::from_str(yaml);
    assert!(result.is_err(), "should reject negative size");

    let yaml = "cols: 10\nrows: 10\ncabinet_size_mm: [.nan, 500.0]\n";
    let result: Result<CabinetArray, _> = serde_yaml::from_str(yaml);
    assert!(result.is_err(), "should reject NaN size");
}

#[test]
fn deserialize_rejects_cabinet_array_zero_dimensions() {
    let yaml = "cols: 0\nrows: 10\ncabinet_size_mm: [500.0, 500.0]\n";
    let result: Result<CabinetArray, _> = serde_yaml::from_str(yaml);
    assert!(result.is_err(), "should reject cols == 0");

    let yaml = "cols: 10\nrows: 0\ncabinet_size_mm: [500.0, 500.0]\n";
    let result: Result<CabinetArray, _> = serde_yaml::from_str(yaml);
    assert!(result.is_err(), "should reject rows == 0");
}
