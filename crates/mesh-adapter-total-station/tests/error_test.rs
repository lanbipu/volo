use mesh_adapter_total_station::AdapterError;

#[test]
fn adapter_error_displays_io_variant() {
    let io = std::io::Error::new(std::io::ErrorKind::NotFound, "file missing");
    let e: AdapterError = io.into();
    let s = format!("{e}");
    assert!(s.contains("io error"));
    assert!(s.contains("file missing"));
}

#[test]
fn adapter_error_carries_invalid_input_detail() {
    let e = AdapterError::InvalidInput("bad column header".into());
    let s = format!("{e}");
    assert!(s.contains("bad column header"));
}

#[test]
fn adapter_error_wraps_core_error() {
    let core = mesh_core::CoreError::InvalidInput("origin coincides".into());
    let e: AdapterError = core.into();
    let s = format!("{e}");
    assert!(s.contains("core error"));
    assert!(s.contains("origin coincides"));
}
