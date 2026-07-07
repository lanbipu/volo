//! SSH 传输：shell out 系统 `ssh`，在节点上 `-File` 跑预置的纯脚本，stdin 喂 JSON 参数。
//! 这是 Volo 唯一做远程的地方。argv 构造与退出码映射是纯函数，可在任意平台单测。

use crate::error::{VoloError, VoloResult};
use serde::de::DeserializeOwned;
use serde::Deserialize;

/// 节点脚本暂存路径（bootstrap 推到这里）。
pub const STAGING_ROOT: &str = r"C:\ProgramData\UECM\ps-scripts";

/// 一次远程调用：引用节点上预置的脚本名 + 参数（含 secret，运行时经 stdin JSON 传）。
pub struct NodeScript {
    pub name: &'static str,
    pub args: serde_json::Value,
    pub ssh_user: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ProbeResult {
    pub ok: bool,
    pub message: String,
    pub latency_ms: i64,
}

/// 一次远程执行的原始结果。`run` 返回完整三元组（不在非零退出时提前判失败），
/// 让 `run_json` 能像 `powershell::run_json` 那样先解析 stdout 的 `{ok,...}` envelope。
#[derive(Debug, Clone)]
pub struct ScriptOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// 传输抽象。生产实现是 `SshExecutor`；测试用 fake 注入预置输出。
/// `run` 只在「ssh 进程都起不来 / stdin 写失败」时返 Err；进程跑完（任何退出码）
/// 都返回 `ScriptOutput`，由 `run_json` 决定成败语义。
pub trait RemoteExecutor {
    fn run(&self, host: &str, script: &NodeScript) -> VoloResult<ScriptOutput>;
    fn probe(&self, host: &str, ssh_user: Option<&str>) -> VoloResult<ProbeResult>;
}

/// 跑脚本并解析 stdout 为 JSON。语义对齐 `powershell::run_json`：
/// 多数 sidecar 失败时把 `{ok:false,...}` 写 stdout 再 `exit 1`，所以**先**尝试解析
/// 非空 stdout（成功即返回，调用方查 `ok` 字段）；解析不出再按退出码分类报错。
pub fn run_json<T: DeserializeOwned>(
    exec: &dyn RemoteExecutor,
    host: &str,
    script: &NodeScript,
) -> VoloResult<T> {
    let out = exec.run(host, script)?;
    if !out.stdout.trim().is_empty() {
        if let Ok(parsed) = serde_json::from_str::<T>(&out.stdout) {
            return Ok(parsed);
        }
    }
    if out.exit_code != 0 {
        // 区分 ssh 层失败(255 → SshConnect) 与节点脚本失败(其余 → NodeScript)。
        return Err(map_exit(
            out.exit_code,
            &failure_detail(&out.stdout, &out.stderr),
        ));
    }
    serde_json::from_str(&out.stdout).map_err(|e| VoloError::NodeScript {
        exit: 0,
        stderr: format!("bad JSON from node: {e} (stdout: {})", out.stdout),
    })
}

/// 拼系统 ssh 的 argv（纯函数，便于单测）。脚本正文绝不内联——只 `-File` 引用
/// 节点上预置的脚本，规避 Windows 远程命令行长度上限。
pub fn build_ssh_args(
    key_path: &str,
    known_hosts: &str,
    ssh_user: &str,
    host: &str,
    script_name: &str,
    staging_root: &str,
) -> Vec<String> {
    let remote = format!(
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File {staging_root}\\{script_name}"
    );
    vec![
        "-i".into(),
        key_path.into(),
        "-o".into(),
        "IdentitiesOnly=yes".into(),
        "-o".into(),
        format!("UserKnownHostsFile={known_hosts}"),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=10".into(),
        // Keepalive for long-running node scripts (e.g. zen verify-rules' editor
        // run up to 300s, zen service-install). The probes keep the channel alive
        // through app-silent stretches; we only drop after the server fails to
        // answer 10 consecutive 30s probes (~5 min of a genuinely dead node).
        "-o".into(),
        "ServerAliveInterval=30".into(),
        "-o".into(),
        "ServerAliveCountMax=10".into(),
        format!("{ssh_user}@{host}"),
        remote,
    ]
}

/// SSH argv for one-line PowerShell sent over stdin via `-Command -`.
pub fn build_ssh_inline_powershell_args(
    key_path: &str,
    known_hosts: &str,
    ssh_user: &str,
    host: &str,
) -> Vec<String> {
    vec![
        "-i".into(),
        key_path.into(),
        "-o".into(),
        "IdentitiesOnly=yes".into(),
        "-o".into(),
        format!("UserKnownHostsFile={known_hosts}"),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=10".into(),
        "-o".into(),
        "ServerAliveInterval=30".into(),
        "-o".into(),
        "ServerAliveCountMax=10".into(),
        format!("{ssh_user}@{host}"),
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command -".into(),
    ]
}

/// ssh 进程退出码 → 错误分类。255 = ssh 自身（连接/认证/host-key）；其余 = 节点脚本失败。
pub fn map_exit(code: i32, stderr: &str) -> VoloError {
    if code == 255 {
        VoloError::SshConnect(stderr.trim().to_string())
    } else {
        VoloError::NodeScript {
            exit: code,
            stderr: stderr.trim().to_string(),
        }
    }
}

/// 失败时组装错误明细。节点脚本约定可能把结构化 `{ok:false,message}` 写到 stdout
/// 后再非零退出；只取 stderr 会把这条信息丢掉，所以非空 stdout 必须纳入。
pub fn failure_detail(stdout: &str, stderr: &str) -> String {
    let stdout = stdout.trim();
    let stderr = stderr.trim();
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, _) => stderr.to_string(),
        (false, true) => stdout.to_string(),
        (false, false) => format!("{stderr}\n[stdout] {stdout}"),
    }
}

use std::collections::BTreeMap;
use std::path::Path;

/// 算目录下所有 `.ps1` 文件的 SHA256（文件名 → 十六进制 hash），供节点脚本暂存
/// 漂移检测用。
pub fn compute_manifest(dir: &Path) -> VoloResult<BTreeMap<String, String>> {
    use sha2::{Digest, Sha256};
    let mut map = BTreeMap::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("ps1") {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let bytes = std::fs::read(&path)?;
        let hash = Sha256::digest(&bytes);
        map.insert(name, format!("{:x}", hash));
    }
    Ok(map)
}

/// 对比本地与节点 manifest，返回需要重推的文件名（变更 + 新增），排序稳定。
pub fn drifted_files(
    local: &BTreeMap<String, String>,
    remote: &BTreeMap<String, String>,
) -> Vec<String> {
    let mut out: Vec<String> = local
        .iter()
        .filter(|(name, hash)| remote.get(*name) != Some(*hash))
        .map(|(name, _)| name.clone())
        .collect();
    out.sort();
    out
}

/// 解析节点回传的 manifest JSON（`{ "<name>": "<sha256>", ... }`）。
pub fn remote_manifest_from_json(s: &str) -> VoloResult<BTreeMap<String, String>> {
    serde_json::from_str(s).map_err(|e| VoloError::NodeScript {
        exit: 0,
        stderr: format!("bad remote manifest JSON: {e}"),
    })
}

/// scp 把本地文件推到节点暂存目录（用系统 scp，复用同一把 key/known_hosts）。
/// 配合 `compute_manifest` + `drifted_files`：只推漂移的脚本。
pub fn scp_push(
    key_path: &Path,
    known_hosts: &Path,
    ssh_user: &str,
    host: &str,
    local_files: &[PathBuf],
    remote_dir: &str,
) -> VoloResult<()> {
    if local_files.is_empty() {
        return Ok(());
    }
    let mut cmd = Command::new("scp");
    crate::core::proc::hide_console(&mut cmd);
    cmd.arg("-i")
        .arg(key_path)
        .arg("-o")
        .arg("IdentitiesOnly=yes")
        .arg("-o")
        .arg(format!(
            "UserKnownHostsFile={}",
            known_hosts.to_string_lossy()
        ))
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("BatchMode=yes")
        // Same fail-fast budget as the ssh exec path (build_ssh_args), so an
        // offline node errors in ~10s instead of the system SSH default.
        .arg("-o")
        .arg("ConnectTimeout=10");
    for f in local_files {
        cmd.arg(f);
    }
    cmd.arg(format!("{ssh_user}@{host}:{remote_dir}/"));
    let out = cmd
        .output()
        .map_err(|e| VoloError::ScriptStaging(format!("spawn scp failed: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        // scp delegates to ssh; a 255 exit is an ssh-level connect/auth/host-key
        // failure. Surface it as SshConnect (not ScriptStaging) so callers like
        // discovery::with_onboarding_hint can suggest running UECM-Bootstrap.cmd,
        // exactly as they would for a failed `run`.
        if out.status.code() == Some(255) {
            return Err(VoloError::SshConnect(stderr));
        }
        return Err(VoloError::ScriptStaging(format!("scp failed: {stderr}")));
    }
    Ok(())
}

/// Shared scp argv prefix (key / known_hosts / batch-mode / connect budget) —
/// the same conventions as `scp_push`, factored for the single-file transfer
/// helpers used by the SSH-push distribute flow.
fn scp_base(key_path: &Path, known_hosts: &Path) -> Command {
    let mut cmd = Command::new("scp");
    crate::core::proc::hide_console(&mut cmd);
    cmd.arg("-i")
        .arg(key_path)
        .arg("-o")
        .arg("IdentitiesOnly=yes")
        .arg("-o")
        .arg(format!(
            "UserKnownHostsFile={}",
            known_hosts.to_string_lossy()
        ))
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=10");
    cmd
}

fn run_scp(mut cmd: Command, what: &str) -> VoloResult<()> {
    let out = cmd
        .output()
        .map_err(|e| VoloError::ScriptStaging(format!("spawn scp failed: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if out.status.code() == Some(255) {
            return Err(VoloError::SshConnect(stderr));
        }
        return Err(VoloError::ScriptStaging(format!("{what} failed: {stderr}")));
    }
    Ok(())
}

/// scp 拉取节点上的单个文件到本地路径。`remote_path` 必须是**无空格**的
/// forward-slash 路径（传输暂存目录约定），避免远端 shell 二次解析的引号问题。
pub fn scp_pull(
    key_path: &Path,
    known_hosts: &Path,
    ssh_user: &str,
    host: &str,
    remote_path: &str,
    local_path: &Path,
) -> VoloResult<()> {
    let mut cmd = scp_base(key_path, known_hosts);
    cmd.arg(format!("{ssh_user}@{host}:{remote_path}"));
    cmd.arg(local_path);
    run_scp(cmd, "scp pull")
}

/// scp 推送本地单个文件到节点上的明确远端路径（含目标文件名——staged 名由
/// 调用方指定,与本地文件名解耦）。`remote_path` 同样必须是无空格的
/// forward-slash 路径,其父目录须已存在（receive-transfer preflight 负责创建）。
pub fn scp_push_file(
    key_path: &Path,
    known_hosts: &Path,
    ssh_user: &str,
    host: &str,
    local_file: &Path,
    remote_path: &str,
) -> VoloResult<()> {
    let mut cmd = scp_base(key_path, known_hosts);
    cmd.arg(local_file);
    cmd.arg(format!("{ssh_user}@{host}:{remote_path}"));
    run_scp(cmd, "scp push")
}

use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

/// Hosts whose node scripts this process has already staged. Operator-side
/// script changes only reach a node when we re-push them; onboarding
/// (enable-ssh.ps1) stages an initial copy but never updates it. We bulk-push
/// the current scripts once per host per process so every domain that runs
/// `-File <staged>` by name executes the operator's current code.
fn synced_hosts() -> &'static Mutex<HashSet<String>> {
    static SYNCED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SYNCED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Names of stageable `*.ps1` in one dir: everything except the node-local
/// onboarding scripts (`enable-*`), which ship in the bootstrap package and are
/// never run over SSH. Unreadable dir → empty (caller tries other candidates).
fn ps1_names_in(dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return names;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        let is_ps1 = path.extension().is_some_and(|x| x == "ps1");
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if is_ps1 && !name.starts_with("enable-") {
                names.push(name.to_string());
            }
        }
    }
    names
}

/// Local node scripts to stage. Collect the union of script names across all
/// candidate dirs, then resolve each via `script_path` so a script missing
/// from a stale/partial exe-dir still falls back to the repo-root copy — the
/// same per-file resolution used when the script is executed.
fn node_script_files() -> Vec<PathBuf> {
    let mut names: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for dir in crate::core::powershell::script_dirs() {
        names.extend(ps1_names_in(&dir));
    }
    names
        .iter()
        .map(|n| crate::core::powershell::script_path(n))
        .collect()
}

/// 生产传输实现：用系统 ssh 在节点跑预置脚本，参数 JSON 经 stdin 喂入。
pub struct SshExecutor {
    pub key_path: PathBuf,
    pub known_hosts: PathBuf,
    pub default_user: String, // "uecm-svc"
    pub staging_root: String, // STAGING_ROOT
}

impl SshExecutor {
    /// 从 app config 构造默认 executor：Volo keystore（缺则自动生成 keypair）+
    /// `uecm-svc` 登录 + 标准暂存根。所有 domain 迁移到 SSH 的统一入口。
    pub fn from_config() -> VoloResult<Self> {
        let dir = crate::startup::resolve_config_dir()?;
        let ks = crate::core::keystore::KeyStore::at(&dir);
        ks.ensure_keypair()?;
        Ok(Self {
            key_path: ks.private_key_path(),
            known_hosts: ks.known_hosts_path(),
            default_user: "uecm-svc".to_string(),
            staging_root: STAGING_ROOT.to_string(),
        })
    }

    /// GBK 兜底解码（节点 PowerShell 5.1 在中文系统可能吐 CP936 stderr）。
    fn decode(bytes: &[u8]) -> String {
        match std::str::from_utf8(bytes) {
            Ok(s) => s.to_string(),
            Err(_) => encoding_rs::GBK.decode(bytes).0.into_owned(),
        }
    }

    /// Push current node scripts to `host` once per process per login user
    /// (see `synced_hosts`). Staged via the same `user` the script will run as,
    /// so a node that only authorized a per-script account still gets its
    /// scripts. scp wants a forward-slash remote path even on Windows targets;
    /// the backslash `staging_root` is kept for the `-File` exec path.
    fn ensure_scripts_staged(&self, host: &str, user: &str) -> VoloResult<()> {
        // 并发防护：读路径命令 async 化（spawn_blocking）后，同一主机的多条读会并发
        // 首触发 staging；check-then-scp 不加锁时对同一远端路径并发 scp 同名脚本
        // （半写/Windows 文件占用风险）。锁跨越 检查→scp→标记 全程，后到者拿锁后命中
        // 缓存早返回；顺带压平首次挂载的并发 SSH 连接峰值。
        static STAGE_LOCK: Mutex<()> = Mutex::new(());
        let _stage = STAGE_LOCK.lock().unwrap();
        let cache_key = format!("{user}@{host}");
        if synced_hosts().lock().unwrap().contains(&cache_key) {
            return Ok(());
        }
        let files = node_script_files();
        if files.is_empty() {
            // Finding zero local scripts means a broken install / bad UECM_PS_DIR,
            // not "nothing to do". Fail (and don't cache) so the node never runs
            // a stale staged copy on the false premise that we synced it.
            return Err(VoloError::ScriptStaging(
                "no local node scripts found to stage (check ps-scripts dir / UECM_PS_DIR)".into(),
            ));
        }
        let remote_dir = self.staging_root.replace('\\', "/");
        scp_push(
            &self.key_path,
            &self.known_hosts,
            user,
            host,
            &files,
            &remote_dir,
        )?;
        synced_hosts().lock().unwrap().insert(cache_key);
        Ok(())
    }

    /// Spawn a node script and leave the SSH process running. Used by UE
    /// warm-up, where the SSH session lifetime intentionally keeps the remote
    /// UnrealEditor process alive.
    pub fn spawn_script(&self, host: &str, script: &NodeScript) -> VoloResult<std::process::Child> {
        let user = script.ssh_user.as_deref().unwrap_or(&self.default_user);
        self.ensure_scripts_staged(host, user)?;
        let args = build_ssh_args(
            &self.key_path.to_string_lossy(),
            &self.known_hosts.to_string_lossy(),
            user,
            host,
            script.name,
            &self.staging_root,
        );
        let mut child = crate::core::proc::hide_console(Command::new("ssh").args(&args))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| VoloError::SshConnect(format!("spawn ssh failed: {e}")))?;
        {
            let stdin = child
                .stdin
                .as_mut()
                .ok_or_else(|| VoloError::SshConnect("open ssh stdin failed".into()))?;
            let mut payload = serde_json::to_vec(&script.args)
                .map_err(|e| VoloError::InvalidInput(format!("encode args: {e}")))?;
            payload.push(b'\n');
            stdin.write_all(&payload)?;
        }
        Ok(child)
    }

    /// Run one single-line PowerShell command over SSH stdin.
    pub fn run_inline_powershell(&self, host: &str, command: &str) -> VoloResult<ScriptOutput> {
        let user = &self.default_user;
        let args = build_ssh_inline_powershell_args(
            &self.key_path.to_string_lossy(),
            &self.known_hosts.to_string_lossy(),
            user,
            host,
        );
        let mut child = crate::core::proc::hide_console(Command::new("ssh").args(&args))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| VoloError::SshConnect(format!("spawn ssh failed: {e}")))?;
        {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| VoloError::SshConnect("open ssh stdin failed".into()))?;
            stdin.write_all(command.as_bytes())?;
            stdin.write_all(b"\n")?;
        }
        let out = child.wait_with_output()?;
        Ok(ScriptOutput {
            stdout: Self::decode(&out.stdout),
            stderr: Self::decode(&out.stderr),
            exit_code: out.status.code().unwrap_or(-1),
        })
    }
}

impl RemoteExecutor for SshExecutor {
    fn run(&self, host: &str, script: &NodeScript) -> VoloResult<ScriptOutput> {
        // No loopback bypass: a loopback target runs over a real SSH-to-self as
        // uecm-svc (a local admin), so admin-requiring node scripts
        // (zen-service-install, setx-machine, setup-share-mode-b, urlacl-add …)
        // execute elevated even when the Volo process itself isn't. The
        // distribute fan-out uses its own local-robocopy fast path for loopback
        // (no admin needed); everything else goes through SSH here.
        let user = script.ssh_user.as_deref().unwrap_or(&self.default_user);
        self.ensure_scripts_staged(host, user)?;
        let args = build_ssh_args(
            &self.key_path.to_string_lossy(),
            &self.known_hosts.to_string_lossy(),
            user,
            host,
            script.name,
            &self.staging_root,
        );
        let mut child = crate::core::proc::hide_console(Command::new("ssh").args(&args))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| VoloError::SshConnect(format!("spawn ssh failed: {e}")))?;
        // 参数 JSON 经 stdin 喂入（不上命令行，secret 不暴露在节点进程列表里）。
        // 单行紧凑 JSON + '\n' 收尾：节点脚本用 ReadLine() 取参，不等 stdin EOF——
        // Windows 宿主的 ssh.exe 不会把重定向管道的关闭转发成远端 EOF，靠 EOF
        // （ReadToEnd）会让每一次 run 无限挂死。
        {
            let stdin = child
                .stdin
                .as_mut()
                .ok_or_else(|| VoloError::SshConnect("open ssh stdin failed".into()))?;
            let mut payload = serde_json::to_vec(&script.args)
                .map_err(|e| VoloError::InvalidInput(format!("encode args: {e}")))?;
            payload.push(b'\n');
            stdin.write_all(&payload)?;
        }
        // 进程跑完（任何退出码）都返回完整输出，成败判断交给 run_json。
        let out = child.wait_with_output()?;
        Ok(ScriptOutput {
            stdout: Self::decode(&out.stdout),
            stderr: Self::decode(&out.stderr),
            exit_code: out.status.code().unwrap_or(-1),
        })
    }

    fn probe(&self, host: &str, ssh_user: Option<&str>) -> VoloResult<ProbeResult> {
        // No loopback bypass: a loopback target is probed by a real SSH-to-self as
        // uecm-svc (the same path `run` uses), so probe never reports ok for a host
        // the migrated SSH operations can't actually reach. Running node scripts on
        // the operator's own box therefore goes through uecm-svc (a local admin),
        // not the possibly-unelevated Volo process — admin-requiring scripts work.
        let started = std::time::Instant::now();
        let user = ssh_user.unwrap_or(&self.default_user);
        let mut args = build_ssh_args(
            &self.key_path.to_string_lossy(),
            &self.known_hosts.to_string_lossy(),
            user,
            host,
            "noop",
            &self.staging_root,
        );
        // probe 不跑脚本：把最后的远程命令替换为一个 noop。
        if let Some(last) = args.last_mut() {
            *last = "powershell.exe -NoProfile -Command exit 0".into();
        }
        let out = crate::core::proc::hide_console(Command::new("ssh").args(&args))
            .output()
            .map_err(|e| VoloError::SshConnect(format!("spawn ssh failed: {e}")))?;
        let latency_ms = started.elapsed().as_millis() as i64;
        if out.status.success() {
            Ok(ProbeResult {
                ok: true,
                message: "ssh ok".into(),
                latency_ms,
            })
        } else {
            let code = out.status.code().unwrap_or(-1);
            Err(map_exit(code, &Self::decode(&out.stderr)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_ssh_args_uses_key_known_hosts_and_file() {
        let args = build_ssh_args(
            "/cfg/uecm_ed25519",
            "/cfg/known_hosts",
            "uecm-svc",
            "RENDER-01",
            "health-probes.ps1",
            r"C:\ProgramData\UECM\ps-scripts",
        );
        assert!(args.contains(&"-i".to_string()));
        assert!(args.contains(&"/cfg/uecm_ed25519".to_string()));
        assert!(args
            .iter()
            .any(|a| a == "UserKnownHostsFile=/cfg/known_hosts"));
        assert!(args.iter().any(|a| a == "StrictHostKeyChecking=accept-new"));
        assert!(args.iter().any(|a| a == "BatchMode=yes"));
        assert!(args.iter().any(|a| a == "ServerAliveInterval=30"));
        assert!(args.iter().any(|a| a == "ServerAliveCountMax=10"));
        assert!(args.contains(&"uecm-svc@RENDER-01".to_string()));
        let remote = args.last().unwrap();
        assert!(remote.contains(r"-File C:\ProgramData\UECM\ps-scripts\health-probes.ps1"));
        assert!(remote.contains("powershell.exe -NoProfile -ExecutionPolicy Bypass"));
        assert!(!remote.contains("-EncodedCommand"));
    }

    #[test]
    fn build_ssh_inline_powershell_args_uses_command_stdin() {
        let args = build_ssh_inline_powershell_args(
            "/cfg/uecm_ed25519",
            "/cfg/known_hosts",
            "uecm-svc",
            "RENDER-01",
        );
        assert!(args.contains(&"-i".to_string()));
        assert!(args.contains(&"/cfg/uecm_ed25519".to_string()));
        assert!(args.iter().any(|a| a == "UserKnownHostsFile=/cfg/known_hosts"));
        assert!(args.iter().any(|a| a == "StrictHostKeyChecking=accept-new"));
        assert!(args.iter().any(|a| a == "BatchMode=yes"));
        assert!(args.iter().any(|a| a == "ServerAliveInterval=30"));
        assert!(args.iter().any(|a| a == "ServerAliveCountMax=10"));
        assert!(args.contains(&"uecm-svc@RENDER-01".to_string()));
        assert_eq!(
            args.last().map(String::as_str),
            Some("powershell.exe -NoProfile -ExecutionPolicy Bypass -Command -")
        );
    }

    #[test]
    fn ps1_names_in_lists_ps1_excluding_enable() {
        let tmp = tempfile::tempdir().unwrap();
        for name in [
            "health-probes.ps1",
            "setup-share-mode-a.ps1",
            "enable-ssh.ps1", // node-local onboarding, must be excluded
            "readme.txt",     // non-ps1, must be excluded
        ] {
            std::fs::write(tmp.path().join(name), "x").unwrap();
        }
        let mut names = ps1_names_in(tmp.path());
        names.sort();
        assert_eq!(names, ["health-probes.ps1", "setup-share-mode-a.ps1"]);
    }

    #[test]
    fn ps1_names_in_missing_dir_is_empty() {
        assert!(ps1_names_in(Path::new("/no/such/uecm/dir")).is_empty());
    }

    #[test]
    fn map_exit_distinguishes_connect_from_script_failure() {
        match map_exit(
            255,
            "ssh: connect to host RENDER-01 port 22: Connection refused",
        ) {
            VoloError::SshConnect(m) => assert!(m.contains("Connection refused")),
            other => panic!("expected SshConnect, got {other:?}"),
        }
        match map_exit(3, "node side blew up") {
            VoloError::NodeScript { exit, stderr } => {
                assert_eq!(exit, 3);
                assert!(stderr.contains("blew up"));
            }
            other => panic!("expected NodeScript, got {other:?}"),
        }
    }

    #[test]
    fn manifest_lists_files_with_stable_hashes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.ps1"), b"hello").unwrap();
        std::fs::write(dir.path().join("b.ps1"), b"world").unwrap();
        std::fs::write(dir.path().join("ignore.txt"), b"x").unwrap(); // 非 .ps1 不计入
        let m1 = compute_manifest(dir.path()).unwrap();
        assert_eq!(m1.len(), 2);
        assert!(m1.contains_key("a.ps1") && m1.contains_key("b.ps1"));
        std::fs::write(dir.path().join("a.ps1"), b"changed").unwrap();
        let m2 = compute_manifest(dir.path()).unwrap();
        assert_ne!(m1["a.ps1"], m2["a.ps1"]);
        assert_eq!(m1["b.ps1"], m2["b.ps1"]);
    }

    #[test]
    fn from_config_builds_executor_and_generates_keypair() {
        let _lock = crate::ENV_TEST_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("VOLO_DB_PATH", dir.path().join("uecm.sqlite"));
        let exec = SshExecutor::from_config().unwrap();
        std::env::remove_var("VOLO_DB_PATH");
        assert_eq!(exec.default_user, "uecm-svc");
        assert_eq!(exec.staging_root, STAGING_ROOT);
        assert!(
            exec.key_path.exists(),
            "ensure_keypair should have generated the key"
        );
        assert!(exec.key_path.ends_with("uecm_ed25519"));
    }

    // (Removed `probe_bypasses_loopback_without_spawning_ssh`: the loopback bypass
    // was dropped — a loopback target is now probed/run via real SSH-to-self as
    // uecm-svc, so admin-requiring node scripts execute elevated and probe never
    // falsely reports ok. Real-node loopback behavior is validated on lanPC.)

    #[test]
    fn remote_manifest_parses_node_json() {
        let m = remote_manifest_from_json(r#"{"a.ps1":"AAA","b.ps1":"BBB"}"#).unwrap();
        assert_eq!(m.get("a.ps1"), Some(&"AAA".to_string()));
        assert_eq!(m.len(), 2);
    }

    #[test]
    fn drifted_files_detects_only_changed() {
        let mut remote = std::collections::BTreeMap::new();
        remote.insert("a.ps1".to_string(), "AAA".to_string());
        remote.insert("b.ps1".to_string(), "BBB".to_string());
        let mut local = std::collections::BTreeMap::new();
        local.insert("a.ps1".to_string(), "AAA".to_string()); // 同
        local.insert("b.ps1".to_string(), "ZZZ".to_string()); // 变
        local.insert("c.ps1".to_string(), "CCC".to_string()); // 新增
        let drift = drifted_files(&local, &remote);
        assert_eq!(drift, vec!["b.ps1".to_string(), "c.ps1".to_string()]);
    }

    struct FakeExec(ScriptOutput);
    impl RemoteExecutor for FakeExec {
        fn run(&self, _h: &str, _s: &NodeScript) -> VoloResult<ScriptOutput> {
            Ok(self.0.clone())
        }
        fn probe(&self, _h: &str, _u: Option<&str>) -> VoloResult<ProbeResult> {
            Ok(ProbeResult {
                ok: true,
                message: "fake".into(),
                latency_ms: 1,
            })
        }
    }

    fn fake(stdout: &str, stderr: &str, exit_code: i32) -> FakeExec {
        FakeExec(ScriptOutput {
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
            exit_code,
        })
    }

    fn demo_script() -> NodeScript {
        NodeScript {
            name: "x.ps1",
            args: serde_json::json!({}),
            ssh_user: None,
        }
    }

    #[derive(Debug, serde::Deserialize)]
    struct Demo {
        ok: bool,
        value: i64,
    }

    #[test]
    fn run_json_parses_node_stdout() {
        let d: Demo = run_json(
            &fake(r#"{"ok":true,"value":42}"#, "", 0),
            "RENDER-01",
            &demo_script(),
        )
        .unwrap();
        assert!(d.ok && d.value == 42);
    }

    #[test]
    fn run_json_returns_envelope_even_on_nonzero_exit() {
        // 脚本写 {ok:false} 到 stdout 后 exit 1：调用方仍应拿到 typed envelope。
        let d: Demo = run_json(
            &fake(r#"{"ok":false,"value":7}"#, "", 1),
            "RENDER-01",
            &demo_script(),
        )
        .unwrap();
        assert!(!d.ok && d.value == 7);
    }

    #[test]
    fn failure_detail_preserves_structured_stdout() {
        // 节点脚本把结构化失败写 stdout、stderr 为空：信息不能丢。
        let d = failure_detail(r#"{"ok":false,"message":"disk full"}"#, "");
        assert!(d.contains("disk full"));
        // stdout + stderr 都有：两者都保留。
        let d2 = failure_detail(r#"{"ok":false}"#, "winrm noise");
        assert!(d2.contains("winrm noise") && d2.contains("ok"));
        // 只有 stderr：原样。
        assert_eq!(failure_detail("", "boom"), "boom");
    }

    #[test]
    fn run_json_surfaces_bad_json_as_node_script_error() {
        let err =
            run_json::<Demo>(&fake("not json", "", 0), "RENDER-01", &demo_script()).unwrap_err();
        assert!(matches!(err, VoloError::NodeScript { .. }));
    }

    #[test]
    fn run_json_nonzero_empty_stdout_is_script_error() {
        let err = run_json::<Demo>(&fake("", "remote crash", 1), "RENDER-01", &demo_script())
            .unwrap_err();
        assert!(matches!(err, VoloError::NodeScript { .. }));
    }

    #[test]
    fn run_json_exit_255_is_ssh_connect_error() {
        let err = run_json::<Demo>(
            &fake("", "Connection refused", 255),
            "RENDER-01",
            &demo_script(),
        )
        .unwrap_err();
        assert!(matches!(err, VoloError::SshConnect(_)));
    }

    /// 真节点集成验证（默认 ignore）。需要：lanPC 已开 OpenSSH、UECM 公钥已授权、
    /// `_a0-selftest.ps1` 已暂存到 `C:\ProgramData\UECM\ps-scripts\`。运行：
    /// `UECM_IT_HOST=192.168.10.20 UECM_IT_USER=lanpc \`
    /// `UECM_IT_KEY=/tmp/uecm-a0-validate/uecm_ed25519 \`
    /// `UECM_IT_KNOWN_HOSTS=/tmp/uecm-a0-validate/known_hosts \`
    /// `cargo test --lib core::ssh::tests::it_run_against_real_node -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn it_run_against_real_node() {
        let (host, user, key, kh) = match (
            std::env::var("UECM_IT_HOST"),
            std::env::var("UECM_IT_USER"),
            std::env::var("UECM_IT_KEY"),
            std::env::var("UECM_IT_KNOWN_HOSTS"),
        ) {
            (Ok(h), Ok(u), Ok(k), Ok(kh)) => (h, u, k, kh),
            _ => {
                eprintln!("skip: set UECM_IT_HOST/USER/KEY/KNOWN_HOSTS");
                return;
            }
        };
        let exec = SshExecutor {
            key_path: std::path::PathBuf::from(key),
            known_hosts: std::path::PathBuf::from(kh),
            default_user: user.clone(),
            staging_root: STAGING_ROOT.to_string(),
        };
        let p = exec.probe(&host, Some(&user)).unwrap();
        assert!(p.ok, "probe failed: {p:?}");

        #[derive(Debug, serde::Deserialize)]
        struct Echo {
            ok: bool,
            echoed: String,
            host: String,
        }
        let script = NodeScript {
            name: "_a0-selftest.ps1",
            args: serde_json::json!({ "msg": "hello-from-mac" }),
            ssh_user: Some(user),
        };
        let e: Echo = run_json(&exec, &host, &script).unwrap();
        assert!(e.ok);
        assert_eq!(e.echoed, "hello-from-mac");
        eprintln!("OK: node host={} probe_latency_ms={}", e.host, p.latency_ms);
    }
}
