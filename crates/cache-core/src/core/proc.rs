//! 子进程 spawn 的平台修饰。
//!
//! Windows 上从 GUI 进程(windows_subsystem = "windows",或 dev 下无继承控制台的
//! detached 场景)spawn 控制台程序(ssh.exe / powershell.exe / icacls …)时,系统
//! 默认为子进程分配一个新控制台窗口 —— 用户看到的就是一闪而过的"终端弹窗"。
//! 所有 Command 构造点统一过一遍 `hide_console` 加 CREATE_NO_WINDOW;非 Windows
//! 平台为 no-op。

use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 在 Windows 上抑制子进程的控制台窗口;其他平台原样返回。
pub fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
