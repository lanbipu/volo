//! `lmt completion <shell>` —— 生成 shell 补全脚本到 stdout。
//! side_effect: read_only;纯文本输出,不走 envelope(补全脚本不是数据)。

use crate::lmt::cli::Cli;
use clap::CommandFactory;
use clap_complete::Shell;

pub fn run(shell: Shell) -> i32 {
    let mut cmd = Cli::command();
    let bin = cmd.get_name().to_string();
    clap_complete::generate(shell, &mut cmd, bin, &mut std::io::stdout());
    volo_shared::exit_codes::OK
}
