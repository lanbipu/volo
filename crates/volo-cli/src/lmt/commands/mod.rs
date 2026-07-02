//! 各子命令的实现。每个子命令把入参映射到 lmt-app 的 run_* helper,
//! 再把结果 / 错误转成 [`crate::lmt::output`] 的 envelope 形态。

mod completion;
mod export;
mod fuse;
mod manifest;
mod measurements;
mod project;
mod reconstruct;
mod schema_cmd;
mod seed;
mod total_station;
mod util;
mod version;
mod visual;

use crate::lmt::cli::{Cli, Command};
use crate::lmt::output::Mode;

pub fn dispatch(cli: Cli) -> i32 {
    let mode = Mode::from_format(cli.resolved_format());

    // `--timeout` 是 cli_spec 要求的全局 flag,本版本暂未实现真正的 deadline。
    // 显式 reject 优于 silent ignore,避免 agent 以为调用有上限。
    if cli.timeout.is_some() {
        return crate::lmt::output::err(
            mode,
            volo_shared::envelope::ApiError::new(
                volo_shared::envelope::error_codes::UNSUPPORTED,
                "--timeout is not yet implemented in this CLI version; rerun without it",
            ),
        );
    }

    let db = cli.db.as_deref();
    let yes = cli.yes;
    let dry_run = cli.dry_run;
    match cli.command {
        Command::Schema => schema_cmd::run(mode),
        Command::Manifest => manifest::run(mode),
        Command::Version => version::run(mode),
        Command::Project(cmd) => project::run(cmd, mode, db, yes, dry_run),
        Command::Measurements(cmd) => measurements::run(cmd, mode),
        Command::TotalStation(cmd) => total_station::run(cmd, mode, yes, dry_run),
        Command::Reconstruct(cmd) => reconstruct::run(cmd, mode, db, yes, dry_run),
        Command::Export(cmd) => export::run(cmd, mode, db, yes, dry_run),
        Command::Completion { shell } => completion::run(shell),
        Command::SeedExample { name, dst } => seed::run(mode, &name, &dst, yes, dry_run),
        Command::Visual(cmd) => visual::run(cmd, mode, yes, dry_run),
        Command::Fuse {
            project_path,
            screen_id,
            pose_report,
            measurements,
            allow_scale,
        } => fuse::run(
            mode,
            &project_path,
            &screen_id,
            &pose_report,
            &measurements,
            allow_scale,
            yes,
            dry_run,
        ),
    }
}
