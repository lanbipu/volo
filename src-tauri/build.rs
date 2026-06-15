fn main() {
    // review #16: the bundle binds `../target/sidecar-vendor` as a resource so
    // the PyInstaller-vendored vpcal/tracksim/mesh-vba binaries ship next to the
    // app. tauri_build errors if that path is missing, and it only exists after
    // a sidecar `build_exe.sh` run — so ensure an (empty) dir exists on every
    // build. Empty is fine: it bundles nothing until the sidecars are built.
    // CARGO_MANIFEST_DIR = <workspace>/src-tauri; target/ is one level up.
    let vendor = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../target/sidecar-vendor");
    let _ = std::fs::create_dir_all(&vendor);

    tauri_build::build()
}
