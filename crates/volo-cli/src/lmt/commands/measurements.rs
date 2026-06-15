//! `lmt measurements ...` 子命令。

use crate::lmt::cli::MeasurementsCmd;
use crate::lmt::output::{self, Mode};
use volo_shared::envelope::ApiError;
use std::io::Write as _;
use std::path::Path;

pub fn run(cmd: MeasurementsCmd, mode: Mode) -> i32 {
    match cmd {
        MeasurementsCmd::Load { path } => load(mode, &path),
    }
}

fn load(mode: Mode, path: &str) -> i32 {
    match mesh_app::measurements::load_measurements_from_path(Path::new(path)) {
        Ok(mp) => output::ok(mode, mp, |m| {
            let _ = writeln!(
                std::io::stdout(),
                "screen_id={}  points={}  cabinets={}x{}",
                m.screen_id,
                m.points.len(),
                m.cabinet_array.cols,
                m.cabinet_array.rows
            );
        }),
        Err(e) => output::err(mode, ApiError::from(e)),
    }
}
