//! `uecm-cli ssh <action>` handlers — SSH transport onboarding + probe.
//! Replaces the retired `winrm` command domain (`probe` from P1, `package-bootstrap`
//! from P5a). `ssh authorize` is deferred (see args.rs SshAction TODO).

use crate::args::SshAction;
use crate::run::Ctx;
use crate::EmitSerialize;
use cache_core::core::keystore::KeyStore;
use cache_core::core::powershell;
use cache_core::core::ssh::{RemoteExecutor, SshExecutor};
use cache_core::error::{UecmError, UecmResult};

/// Top-level result object — mirrors `winrm probe`'s `ProbeOut` shape so CLI /
/// JSON automation that parsed `{host, ok, message, latency_ms}` from
/// `winrm probe` keeps working against `ssh probe`.
#[derive(serde::Serialize, schemars::JsonSchema)]
pub struct ProbeOut {
    pub host: String,
    pub ok: bool,
    pub message: String,
    pub latency_ms: i64,
}

/// Parsed stdout of `package-bootstrap.ps1` (extra keys ignored).
#[derive(serde::Deserialize)]
struct PackageOut {
    ok: bool,
    output_directory: String,
    files: Vec<String>,
}

pub fn handle(ctx: &mut Ctx<'_>, action: SshAction) -> UecmResult<()> {
    match action {
        SshAction::Probe { host } => probe(ctx, &host),
        SshAction::PackageBootstrap { out, local_admin_password } => {
            package_bootstrap(ctx, &out, local_admin_password.as_deref())
        }
    }
}

/// Assemble a USB SSH onboarding bundle. Ensures the operator keystore keypair
/// exists, then shells out to `package-bootstrap.ps1` (Windows-only sidecar) to
/// copy UECM-Bootstrap.cmd + enable-ssh.ps1 + uecm.pub + PsExec64.exe + README
/// into `out`. Replaces the retired `winrm bootstrap-script`.
fn package_bootstrap(
    ctx: &mut Ctx<'_>,
    out: &str,
    local_admin_password: Option<&str>,
) -> UecmResult<()> {
    let cfg = cache_core::startup::resolve_config_dir()?;
    let ks = KeyStore::at(&cfg);
    ks.ensure_keypair()?;
    let pubkey_str = ks.public_key_path().to_string_lossy().into_owned();

    let mut args: Vec<&str> = vec!["-OutputDirectory", out, "-UecmPublicKeyPath", &pubkey_str];
    if let Some(p) = local_admin_password {
        args.push("-LocalAdminPassword");
        args.push(p);
    }
    let res: PackageOut =
        powershell::run_json(&powershell::script_path("package-bootstrap.ps1"), &args)?;
    if !res.ok {
        return Err(UecmError::OperationFailed(format!(
            "package-bootstrap failed for {}",
            res.output_directory
        )));
    }
    ctx.emitter
        .emit_result(&serde_json::json!({
            "output_directory": res.output_directory,
            "files": res.files,
        }))
        .ok();
    Ok(())
}

fn probe(ctx: &mut Ctx<'_>, host: &str) -> UecmResult<()> {
    let exec = SshExecutor::from_config()?;
    let result = exec.probe(host, None)?;
    if !result.ok {
        // Failure: let run()'s dispatcher emit a single `error` event (one value
        // per invocation), same as winrm probe.
        return Err(UecmError::SshConnect(format!(
            "ssh probe of {} reported failure: {}",
            host, result.message
        )));
    }
    let out = ProbeOut {
        host: host.into(),
        ok: result.ok,
        message: result.message,
        latency_ms: result.latency_ms,
    };
    ctx.emitter.emit_result(&out).ok();
    Ok(())
}
