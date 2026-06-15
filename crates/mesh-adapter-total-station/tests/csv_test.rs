use mesh_adapter_total_station::csv_parser::parse_csv;
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests");
    p.push("fixtures");
    p.push(name);
    p
}

#[test]
fn parse_csv_returns_5_points_in_instrument_order() {
    let raw = parse_csv(&fixture("sample.csv")).unwrap();
    assert_eq!(raw.len(), 5);
    assert_eq!(raw[0].instrument_id, 1);
    assert_eq!(raw[1].instrument_id, 2);
    assert_eq!(raw[4].instrument_id, 5);
    assert!((raw[0].position_mm.x - 1234.5).abs() < 1e-9);
    assert!((raw[1].position_mm.x - 31234.5).abs() < 1e-9);
    assert_eq!(raw[2].note.as_deref(), Some("origin marker"));
    assert_eq!(raw[0].note, None);
}

#[test]
fn parse_csv_rejects_missing_file() {
    let result = parse_csv(&fixture("does-not-exist.csv"));
    assert!(result.is_err());
}

#[test]
fn parse_csv_rejects_non_numeric_id() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("bad.csv");
    std::fs::write(&p, "name,x,y,z,note\nabc,1.0,2.0,3.0,\n").unwrap();
    let result = parse_csv(&p);
    assert!(result.is_err());
}

#[test]
fn parse_csv_rejects_non_finite_coordinate() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("nan.csv");
    std::fs::write(&p, "name,x,y,z,note\n1,nan,0,0,\n").unwrap();
    let result = parse_csv(&p);
    assert!(result.is_err());
}

#[test]
fn parse_csv_rejects_duplicate_instrument_id() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("dup.csv");
    std::fs::write(&p, "name,x,y,z,note\n1,0,0,0,\n2,1,0,0,\n2,2,0,0,\n").unwrap();
    let err = parse_csv(&p).unwrap_err();
    assert!(format!("{err}").contains("duplicate"));
}

#[test]
fn parse_csv_rejects_zero_instrument_id() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("zero.csv");
    std::fs::write(&p, "name,x,y,z,note\n0,0,0,0,\n").unwrap();
    let err = parse_csv(&p).unwrap_err();
    assert!(format!("{err}").contains("0"));
}
