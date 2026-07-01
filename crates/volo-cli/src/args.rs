//! clap-derive structures for all `uecm-cli` subcommands.

use clap::{Parser, Subcommand};

/// Operator-facing override for the cache *storage routing* (T3.6) — distinct
/// from where the UE process executes (see `ddc_pak`'s remote/local backend).
///
/// `Auto`   — defer to `core::cache_backend::resolve_for` decision table.
/// `Legacy` — force the legacy `.ddp` pak workflow (skip the router).
/// `Zen`    — force the zen routing. Purely informational: `generate` /
///            `verify` / `distribute` still run regardless of routing — any
///            backend (including Zen) can produce/read/copy a DDC Pak.
///
/// Exposed at the CLI layer only — `core::ddc_pak` / `core::pak_distribute`
/// are intentionally unaware of this choice so they can keep being
/// unit-tested without the routing surface.
#[derive(clap::ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
#[clap(rename_all = "snake_case")]
pub enum CacheBackendChoice {
    Auto,
    Legacy,
    Zen,
}

/// 输出格式（spec §3.5）。`text` 给人类，`json` 单次完整对象，`ndjson` 每行一对象。
/// `stream-json` 是 `ndjson` 的别名（spec §3.5）。
#[derive(clap::ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
#[clap(rename_all = "snake_case")]
pub enum OutputFormat {
    Text,
    Json,
    #[value(alias = "stream-json")]
    Ndjson,
}

/// stdin 结构化输入格式（spec §3.3）。helper 见 Task 7。
#[derive(clap::ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
#[clap(rename_all = "snake_case")]
pub enum InputFormat {
    Json,
    Yaml,
    Ndjson,
}

/// 是否启用 ANSI color。`--no-color` 或 `NO_COLOR` env 任一存在即禁用；
/// 否则跟随 stdout 是否 TTY。(spec §3.2 / §3.4)
pub fn use_color(no_color_flag: bool, is_tty: bool, no_color_env: bool) -> bool {
    !no_color_flag && !no_color_env && is_tty
}

/// 计算有效 tracing 级别。优先级：--quiet > --verbose 计数 > --log-level 基线。
/// (spec §3.2)
pub fn effective_log_level(base: &str, verbose: u8, quiet: bool) -> String {
    if quiet {
        return "error".to_string();
    }
    match verbose {
        0 => base.to_string(),
        1 => "info".to_string(),
        2 => "debug".to_string(),
        _ => "trace".to_string(),
    }
}

#[derive(Parser, Debug)]
#[command(name = "uecm-cli", version, about = "UECM command-line interface")]
pub struct Cli {
    /// DEPRECATED 别名：等价 `--output json`。保留以兼容现有 docs/scripts。
    #[arg(long, global = true)]
    pub json: bool,

    /// Output format: text (human) / json (single object) / ndjson (one object per line).
    #[arg(long, short = 'o', global = true, value_enum)]
    pub output: Option<OutputFormat>,

    /// Disable ANSI color (also honors the NO_COLOR env var).
    #[arg(long, global = true)]
    pub no_color: bool,

    /// Refuse any interactive prompt (recommended for AI / CI callers).
    #[arg(long, global = true)]
    pub no_input: bool,

    /// Equivalent to `--log-level error`.
    #[arg(long, short = 'q', global = true)]
    pub quiet: bool,

    /// Increase log verbosity (-v = info, -vv = debug). Overrides --log-level upward.
    #[arg(long, short = 'v', global = true, action = clap::ArgAction::Count)]
    pub verbose: u8,

    /// Load defaults from a YAML / JSON config file (mode must be <= 0600).
    #[arg(long, global = true)]
    pub config: Option<std::path::PathBuf>,

    /// Format of structured data read from stdin (json / yaml / ndjson).
    #[arg(long, global = true, value_enum)]
    pub input_format: Option<InputFormat>,

    /// Override DB path (otherwise resolved via startup module).
    #[arg(long, global = true, env = "UECM_DB_PATH")]
    pub db_path: Option<String>,

    /// Log level for tracing output to stderr.
    #[arg(long, global = true, default_value = "warn")]
    pub log_level: String,

    #[command(subcommand)]
    pub command: Domain,
}

impl Cli {
    /// 解析有效输出格式。优先级：显式 --output > --json 别名 > AI_AGENT=1 env > 默认 text。
    pub fn resolved_output(&self) -> OutputFormat {
        let ai_agent = std::env::var("AI_AGENT").map(|v| v == "1").unwrap_or(false);
        resolve_output(self.output, self.json, ai_agent)
    }
}

/// 纯函数核心（可单测，不读 env）。spec §3.4：AI_AGENT=1 是 AI 调用的显式信号。
pub fn resolve_output(output: Option<OutputFormat>, json: bool, ai_agent: bool) -> OutputFormat {
    if let Some(fmt) = output {
        return fmt;
    }
    if json {
        return OutputFormat::Json;
    }
    if ai_agent {
        return OutputFormat::Json;
    }
    OutputFormat::Text
}

#[derive(Subcommand, Debug)]
pub enum Domain {
    /// Diagnostic / self-test commands.
    System {
        #[command(subcommand)]
        action: SystemAction,
    },
    /// Machine inventory + discovery.
    Machine {
        #[command(subcommand)]
        action: MachineAction,
    },
    /// SSH transport onboarding + probe (replaced the retired winrm domain).
    Ssh {
        #[command(subcommand)]
        action: SshAction,
    },
    /// Credential alias storage (SecretStore + SQLite metadata).
    Cred {
        #[command(subcommand)]
        action: CredAction,
    },
    /// Manage the cross-platform SecretStore (AES-GCM) directly.
    Secret {
        #[command(subcommand)]
        action: SecretAction,
    },
    /// Read / write system-level environment variables on remote hosts.
    Env {
        #[command(subcommand)]
        action: EnvAction,
    },
    /// Read / write / remove single INI keys on remote hosts.
    Ini {
        #[command(subcommand)]
        action: IniAction,
    },
    /// SMB share inventory + creation + SYSTEM credential injection.
    Share {
        #[command(subcommand)]
        action: ShareAction,
    },
    /// uproject discovery + cross-machine identity.
    Project {
        #[command(subcommand)]
        action: ProjectAction,
    },
    /// Cluster health check (probes + derived consistency checks).
    Health {
        #[command(subcommand)]
        action: HealthAction,
    },
    /// GPU consistency matrix across the cluster.
    Gpu {
        #[command(subcommand)]
        action: GpuAction,
    },
    /// DDC pak workflow (generate / verify / distribute).
    Ddc {
        #[command(subcommand)]
        action: DdcAction,
    },
    /// PSO cache workflow (verify / collect / list / distribute).
    Pso {
        #[command(subcommand)]
        action: PsoAction,
    },
    /// Verify what UE actually used by parsing LogDerivedDataCache startup output.
    Log {
        #[command(subcommand)]
        action: LogAction,
    },
    /// Local DDC directory provisioning.
    LocalCache {
        #[command(subcommand)]
        action: LocalCacheAction,
    },
    /// One-click DDC deployment workflow.
    Deploy {
        #[command(subcommand)]
        action: DeployAction,
    },
    /// Zen daemon inventory + probes + baselines (Plan 7 M1).
    Zen {
        #[command(subcommand)]
        action: ZenAction,
    },
    /// Print the Contract Manifest (canonical operation registry + schemas; spec §2 / §10.1).
    Manifest,
}

// ---------- system ----------
#[derive(Subcommand, Debug)]
pub enum SystemAction {
    /// Print binary + library version.
    Version,
    /// Print resolved SQLite DB path.
    DbPath,
    /// Print resolved ps-scripts directory.
    PsDir,
    /// Force-run schema migrations on the DB.
    MigrateDb,
    /// Round-trip a message through the PowerShell bridge.
    Echo { message: String },
    /// Dump the full clap command tree + exit-code table as JSON. Intended
    /// for AI agents / automation to introspect this CLI's surface without
    /// scraping help text.
    Schema,
    /// Print the documented process exit-code table.
    ExitCodes,
    /// Generate a shell completion script (bash / zsh / fish / powershell / elvish).
    Completion {
        /// Target shell.
        shell: clap_complete::Shell,
    },
}

// ---------- machine ----------
#[derive(Subcommand, Debug)]
pub enum MachineAction {
    /// List all known machines.
    List,
    /// Probe a CIDR for live hosts (ports 5985 / 445).
    Scan {
        /// CIDR (e.g. 192.168.10.0/24).
        cidr: String,
        /// Per-port TCP connect timeout (ms).
        #[arg(long, default_value_t = 1000)]
        timeout_ms: u64,
    },
    /// Add a machine to the inventory by IP / hostname.
    Add {
        #[arg(long)]
        ip: String,
        #[arg(long)]
        hostname: Option<String>,
    },
    /// Refresh a machine: SSH probe + detect UE installs + GPUs.
    ///
    /// Plan 3: now accepts credentials. When supplied, all three remote
    /// calls (probe / detect_ue / detect_gpus) authenticate as the given
    /// user. Without credentials, the caller's Kerberos/NTLM context is used.
    Refresh {
        /// Machine row id.
        id: i64,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Show machine detail (UE installs, GPUs, last-seen).
    Detail { id: i64 },
    /// Delete machine(s): a single positional id, or a batch via --machine-ids / --all.
    Delete {
        /// Machine row id (single delete). Omit when using --machine-ids / --all.
        id: Option<i64>,
        /// Delete these machine ids (comma-separated).
        #[arg(long, value_name = "M1,M2,...", value_delimiter = ',', conflicts_with_all = ["id", "all"])]
        machine_ids: Vec<i64>,
        /// Delete every machine in inventory.
        #[arg(long, conflicts_with_all = ["id", "machine_ids"])]
        all: bool,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
    },
    /// Rename a machine.
    Rename { id: i64, hostname: String },
    /// Record the Windows username that runs UE on this machine.
    /// Used by `zen enable --global` to resolve UserEngine.ini path.
    /// Pass empty string to clear.
    SetUeUser {
        #[arg(long, value_name = "ID")]
        machine: i64,
        /// Windows username (e.g. `lanbp`). Empty string clears the value.
        #[arg(long, value_name = "USERNAME")]
        ue_user: String,
    },
    /// Deep scan a set of machines: refresh (UE/GPU) + INI scan + health, per machine.
    /// SSH-unreachable machines are skipped (re-onboard via UECM-Bootstrap.cmd) and the
    /// batch continues.
    DeepScan {
        #[arg(long, value_name = "M1,M2,...", value_delimiter = ',', conflicts_with = "all")]
        machine_ids: Vec<i64>,
        /// Deep-scan every machine in inventory.
        #[arg(long, conflicts_with = "machine_ids")]
        all: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Deprecated: remote WinRM push is retired (SSH migration). Emits guidance to
    /// build a USB onboarding bundle with `ssh package-bootstrap` and run
    /// UECM-Bootstrap.cmd on each node. `--save-as` / credential flags are accepted
    /// but ignored (kept for back-compat).
    Authorize {
        #[arg(long, value_name = "M1,M2,...", value_delimiter = ',', conflicts_with = "all")]
        machine_ids: Vec<i64>,
        /// Authorize every machine in inventory.
        #[arg(long, conflicts_with = "machine_ids")]
        all: bool,
        /// Accepted but ignored (remote push retired).
        #[arg(long, value_name = "ALIAS")]
        save_as: Option<String>,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
}

// ---------- ssh ----------
#[derive(Subcommand, Debug)]
pub enum SshAction {
    /// Probe a host's SSH reachability (uecm-svc key auth).
    Probe { host: String },
    /// Assemble a USB onboarding bundle (UECM-Bootstrap.cmd + enable-ssh.ps1 +
    /// uecm.pub + PsExec64.exe + README) into an output directory. Replaces the
    /// retired `winrm bootstrap-script`. Windows-only (PowerShell packager).
    PackageBootstrap {
        /// Output directory for the bundle (created if missing).
        #[arg(long, value_name = "DIR")]
        out: String,
        /// Optionally bake the uecm-svc local-admin password into the packaged
        /// .cmd so first-contact double-click creates the account unattended.
        #[arg(long, value_name = "PASS")]
        local_admin_password: Option<String>,
    },
    // TODO(P5-followup): `ssh authorize <host>` — re-push the current keystore
    // pubkey to an already-SSH-reachable node (key rotation). Deferred: not a
    // 1:1 replacement of any retiring command; remote push is intentionally gone.
}

// ---------- secret ----------
#[derive(Subcommand, Debug)]
pub enum SecretAction {
    /// Store (or overwrite) a secret under an alias. Reads the value from
    /// --value or, when omitted, one line from stdin (\r\n trimmed).
    Set {
        alias: String,
        /// Inline secret value. Leaks into shell history — prefer stdin.
        #[arg(long, value_name = "VALUE")]
        value: Option<String>,
    },
    /// Print the stored secret for an alias (plaintext to stdout).
    Get { alias: String },
    /// List all stored aliases (keys only, never the secrets).
    List,
    /// Delete the secret for an alias.
    Delete {
        alias: String,
        /// Confirm the destructive action.
        #[arg(long)]
        yes: bool,
        /// Preview without deleting.
        #[arg(long)]
        dry_run: bool,
    },
}

// ---------- cred ----------
#[derive(Subcommand, Debug)]
pub enum CredAction {
    /// List saved credential aliases.
    List,
    /// Save a credential (SecretStore + SQLite metadata).
    Save {
        #[arg(long)]
        alias: String,
        #[arg(long)]
        user: String,
        #[arg(long, group = "secret", conflicts_with = "pass_stdin")]
        pass: Option<String>,
        #[arg(long, group = "secret", conflicts_with = "pass")]
        pass_stdin: bool,
        #[arg(long, default_value = "winrm")]
        kind: String,
    },
    /// Delete a credential alias.
    Delete {
        alias: String,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
    },
}

// ---------- env ----------
#[derive(Subcommand, Debug)]
pub enum EnvAction {
    /// Read an environment variable on a single host.
    Get {
        #[arg(long)]
        host: String,
        #[arg(long)]
        name: String,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Write an environment variable on one or more hosts.
    Set {
        #[command(flatten)]
        target: crate::host_args::HostArgs,
        #[arg(long)]
        name: String,
        #[arg(long)]
        value: String,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
}

// ---------- ini ----------
#[derive(Subcommand, Debug)]
pub enum IniAction {
    /// Read all keys from one INI section on a single host.
    Read {
        #[arg(long)]
        host: String,
        #[arg(long)]
        file: String,
        #[arg(long)]
        section: String,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Write a single INI key on one or more hosts.
    Set {
        #[command(flatten)]
        target: crate::host_args::HostArgs,
        #[arg(long)]
        file: String,
        #[arg(long)]
        section: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        value: String,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Remove a single INI key on one or more hosts.
    Remove {
        #[command(flatten)]
        target: crate::host_args::HostArgs,
        #[arg(long)]
        file: String,
        #[arg(long)]
        section: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Run cluster INI scan across one or more machines.
    Scan {
        #[arg(long, value_name = "M1,M2,...", value_delimiter = ',')]
        machine_ids: Vec<i64>,
        /// Project deep-scan: scan this project's INI config (via project_locations).
        #[arg(long, conflicts_with = "machine_ids")]
        project_id: Option<i64>,
        /// Narrow a multi-machine project to one machine (only with --project-id).
        #[arg(long, requires = "project_id")]
        machine_id: Option<i64>,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// List recent INI scan runs.
    Runs {
        #[arg(long, default_value_t = 10)]
        limit: i64,
    },
    /// List findings for a given scan run.
    Findings {
        scan_run_id: i64,
        /// Filter by severity (critical / warning / healthy / info).
        #[arg(long)]
        severity: Option<String>,
    },
    /// Get one finding by id.
    GetFinding { finding_id: i64 },
    /// Apply (auto-fix) a finding's recommendation on the remote machine.
    Apply {
        finding_id: i64,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Mark a finding as skipped (won't apply).
    Skip { finding_id: i64 },
    /// List captured DDC/PSO/Zen config snapshots for a scan run.
    Config {
        scan_run_id: i64,
        /// Filter by concern domain (ddc / pso / zen).
        #[arg(long)]
        domain: Option<String>,
    },
    /// Verify PSO precaching CVars (R008-R010) in a project's ConsoleVariables.ini.
    VerifyPsoPrecaching {
        #[arg(long)]
        project_id: i64,
    },
    /// Read or write [DerivedDataBackendGraph] tuple nodes.
    BackendGraph {
        #[command(subcommand)]
        action: BackendGraphAction,
    },
    /// Pause Shared DDC GC (DeleteUnused=false). Reversible with `gc-resume`.
    GcPause {
        #[command(flatten)]
        target: crate::host_args::HostArgs,
        #[arg(long)]
        project_id: i64,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Resume Shared DDC GC (DeleteUnused=true, UnusedFileAge configurable).
    GcResume {
        #[command(flatten)]
        target: crate::host_args::HostArgs,
        #[arg(long)]
        project_id: i64,
        #[arg(long, default_value_t = 10)]
        unused_file_age: u32,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Pause Zen Server GC: set [Zen.AutoLaunch] ExtraArgs --gc-cache-duration-seconds
    /// to ~100 years (cache never expires). Reversible with `zen-gc-resume`.
    ZenGcPause {
        #[command(flatten)]
        target: crate::host_args::HostArgs,
        #[arg(long)]
        project_id: i64,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Restore Zen Server GC retention window (--gc-cache-duration-seconds,
    /// default 1209600 = the engine's 14-day default).
    ZenGcResume {
        #[command(flatten)]
        target: crate::host_args::HostArgs,
        #[arg(long)]
        project_id: i64,
        #[arg(long, default_value_t = 1_209_600)]
        gc_seconds: u64,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
}

#[derive(Subcommand, Debug)]
pub enum BackendGraphAction {
    /// Get a single field value from a Shared/Boot/Local backend node.
    Get {
        #[arg(long)]
        host: String,
        #[arg(long)]
        file_path: String,
        #[arg(long, default_value = "Shared")]
        node: String,
        #[arg(long)]
        field: String,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Set a single field value.
    Set {
        #[command(flatten)]
        target: crate::host_args::HostArgs,
        #[arg(long)]
        file_path: String,
        #[arg(long, default_value = "Shared")]
        node: String,
        #[arg(long)]
        field: String,
        #[arg(long)]
        value: String,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Scan an INI file and emit all BackendGraph nodes as JSON.
    Scan {
        #[arg(long)]
        host: String,
        #[arg(long)]
        file_path: String,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
}

// ---------- share ----------
#[derive(Subcommand, Debug)]
pub enum ShareAction {
    /// List share configs in the local inventory.
    List,
    /// Forget a share config (LOCAL inventory only; remote SMB share is NOT removed).
    Forget {
        id: i64,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
    },
    /// Create an SMB share (Mode A = open Guest+Everyone; Mode B = dedicated ddc-svc).
    Create {
        #[arg(long, value_name = "a|b")]
        mode: String,
        #[arg(long)]
        host: String,
        #[arg(long)]
        share: String,
        #[arg(long)]
        local_path: String,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Inject the share's SYSTEM-context credential on a client machine.
    InjectSystemCred {
        #[arg(long)]
        client_host: String,
        #[arg(long)]
        target_host: String,
        #[arg(long, default_value = "ddc-svc")]
        svc_user: String,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
}

// ---------- project ----------
#[derive(Subcommand, Debug)]
pub enum ProjectAction {
    /// List all projects.
    List,
    /// List all locations (machine + abs_path) for a project.
    Locations { project_id: i64 },
    /// Discover .uproject files on a remote machine under given search roots.
    Discover {
        #[arg(long)]
        machine_id: i64,
        #[arg(long, value_name = "R1,R2,...", value_delimiter = ',')]
        roots: Vec<String>,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Create a project manually (no discovery); yields a project_id.
    CreateManual {
        #[arg(long)]
        uproject_name: String,
        #[arg(long)]
        display_name: Option<String>,
    },
    /// Add or update a location for an existing project.
    SetLocation {
        #[arg(long)]
        project_id: i64,
        #[arg(long)]
        machine_id: i64,
        /// Absolute path to the directory containing the .uproject file.
        #[arg(long)]
        abs_path: String,
        /// Relative path (from abs_path root) to the .uproject file.
        #[arg(long)]
        uproject_path: String,
        /// Use ManualPath status instead of ManualAlias.
        #[arg(long)]
        manual_path: bool,
    },
    /// Delete a project (and cascade its locations).
    Delete {
        id: i64,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
    },
    /// Delete a single project_location row.
    DeleteLocation {
        id: i64,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
    },
}

// ---------- health ----------
#[derive(Subcommand, Debug)]
pub enum HealthAction {
    /// Run health probes — L1 port + L2 bootstrap + L3 business checkup with remediation hints.
    ///
    /// Target selection (exactly one of three modes):
    ///   --machine-ids 1,2,3     diagnose specific inventoried machines (persists results)
    ///   --cidr 192.168.10.0/24  L1 port-layer scan, stdout-only, no DB persistence
    ///   --all                   diagnose every machine in inventory (persists results)
    ///
    /// Credentials are optional. Without --cred-alias/--user, L2 + L3 probes are
    /// reported as `status=na` and counted in a separate `skipped` summary counter
    /// (not `healthy`/`critical`). L1 ports always run.
    Run {
        #[arg(long, value_name = "M1,M2,...", value_delimiter = ',',
              conflicts_with_all = ["cidr", "all"])]
        machine_ids: Vec<i64>,
        #[arg(long, conflicts_with_all = ["machine_ids", "all"])]
        cidr: Option<String>,
        #[arg(long, conflicts_with_all = ["machine_ids", "cidr"])]
        all: bool,
        /// Expected value for UE-LocalDataCachePath env var on each machine.
        /// When supplied, the env_local probe does an exact-match comparison
        /// instead of a presence-only check. Leave unset to keep presence-only.
        #[arg(long, default_value = "")]
        expected_local_path: String,
        /// Expected value for UE-SharedDataCachePath env var on each machine.
        /// Same semantics as --expected-local-path.
        #[arg(long, default_value = "")]
        expected_shared_path: String,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// List recent health scan runs.
    Runs {
        #[arg(long, default_value_t = 10)]
        limit: i64,
    },
    /// List per-row health results for a scan run.
    Results { scan_run_id: i64 },
    /// Snapshot N hosts and report cross-machine inconsistencies.
    ConsistencyCheck {
        #[arg(long, value_name = "H1,H2,...", value_delimiter = ',')]
        hosts: Vec<String>,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Scan shortcuts/bat/services for -LocalDataCachePath / -SharedDataCachePath overrides.
    ScanCommandLine {
        #[arg(long)]
        host: String,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Local vs Shared DDC file count + total size probe, with imbalance classifier.
    FileStats {
        #[arg(long)]
        host: String,
        #[arg(long)]
        local_path: String,
        #[arg(long)]
        shared_path: String,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Run log verification + file stats then emit symptom advisories (S001-S005).
    AnalyzeAdvisories {
        #[arg(long)]
        host: String,
        #[arg(long)]
        editor_exe: String,
        #[arg(long)]
        project: String,
        #[arg(long)]
        local_path: String,
        #[arg(long)]
        shared_path: String,
        #[arg(long, default_value_t = 180)]
        timeout: u32,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
}

// ---------- gpu ----------
#[derive(Subcommand, Debug)]
pub enum GpuAction {
    /// Show GPU consistency matrix across all machines in inventory.
    Matrix,
}

// ---------- ddc ----------
#[derive(Subcommand, Debug)]
pub enum DdcAction {
    /// Generate a DDC pak file by running UE with -DDC=CreatePak.
    Generate {
        #[arg(long)]
        project_id: i64,
        #[arg(long)]
        source_machine: i64,
        /// Cache storage routing to report alongside this operation (T3.6);
        /// `auto` consults the routing table. Informational only — does not
        /// gate whether generation runs.
        #[arg(long, default_value = "auto", value_enum)]
        backend: CacheBackendChoice,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Verify a previously generated .ddp pak file exists and has non-zero size.
    Verify {
        #[arg(long)]
        project_id: i64,
        #[arg(long)]
        source_machine: i64,
        /// Cache storage routing to report (T3.6). See `ddc generate --help`.
        #[arg(long, default_value = "auto", value_enum)]
        backend: CacheBackendChoice,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Distribute the DDC pak to one or more target machines via Robocopy.
    Distribute {
        #[arg(long)]
        project_id: i64,
        #[arg(long)]
        source_machine: i64,
        #[arg(long, value_name = "M1,M2,...", value_delimiter = ',')]
        targets: Vec<i64>,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        /// Cache storage routing to report (T3.6). See `ddc generate --help`.
        #[arg(long, default_value = "auto", value_enum)]
        backend: CacheBackendChoice,
        /// SecretStore alias for the source share's SMB credential. Omit to
        /// auto-derive from a Mode B share registered on the source host.
        #[arg(long)]
        source_smb_cred_alias: Option<String>,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
}

// ---------- pso ----------
#[derive(Subcommand, Debug)]
pub enum PsoAction {
    /// Verify PSO precaching CVars (R008-R010) are set in the project's ConsoleVariables.ini.
    Verify {
        #[arg(long)]
        project_id: i64,
    },
    /// Run UE `-game` to collect PSO cache files. Long-running NDJSON stream.
    Collect {
        #[arg(long)]
        project_id: i64,
        #[arg(long)]
        source_machine: i64,
        #[arg(long, value_name = "WxH", default_value = "1920x1080")]
        resolution: String,
        #[arg(long, default_value_t = true)]
        windowed: bool,
        #[arg(long, default_value_t = 10)]
        max_minutes: u32,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// List collected PSO cache files for a project.
    List {
        #[arg(long)]
        project_id: i64,
    },
    /// Distribute PSO cache files to one or more target machines (with GPU mismatch preflight guard).
    Distribute {
        #[arg(long)]
        project_id: i64,
        #[arg(long)]
        source_machine: i64,
        #[arg(long, value_name = "M1,M2,...", value_delimiter = ',')]
        targets: Vec<i64>,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        /// SecretStore alias for the source share's SMB credential. Omit to
        /// auto-derive from a Mode B share registered on the source host.
        #[arg(long)]
        source_smb_cred_alias: Option<String>,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
}

// ---------- log ----------
#[derive(Subcommand, Debug)]
pub enum LogAction {
    /// Run UE in nullrhi mode and parse its DDC startup output.
    VerifyStartup {
        #[arg(long)]
        host: String,
        #[arg(long)]
        editor_exe: String,
        #[arg(long)]
        project: String,
        #[arg(long, default_value_t = 180)]
        timeout: u32,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
}

// ---------- local-cache ----------
#[derive(Subcommand, Debug)]
pub enum LocalCacheAction {
    /// Create the local DDC directory on one or more hosts.
    Create {
        #[command(flatten)]
        target: crate::host_args::HostArgs,
        #[arg(long, default_value = r"D:\UE-DDC-Local")]
        path: String,
        #[arg(long)]
        service_account: Option<String>,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
}

// ---------- deploy ----------
#[derive(Subcommand, Debug)]
pub enum DeployAction {
    /// Run the full DDC deployment plan from a JSON file.
    Ddc {
        /// Path to a deploy-plan JSON file.
        #[arg(long)]
        plan: std::path::PathBuf,
        #[arg(long)]
        stop_on_failure: bool,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
}

// ---------- zen (Plan 7 M1) ----------
#[derive(Subcommand, Debug)]
pub enum ZenAction {
    /// Read-only view of latest probe per endpoint.
    Status {
        /// Limit to one machine's endpoints (mutually exclusive with --all).
        #[arg(long, conflicts_with = "all")]
        machine: Option<i64>,
        /// Show endpoints across every machine (default).
        #[arg(long)]
        all: bool,
    },
    /// Probe one or more endpoints right now and persist a row each.
    Probe {
        #[arg(long, conflicts_with = "all")]
        machine: Option<i64>,
        #[arg(long)]
        all: bool,
        /// Per-endpoint timeout in seconds (HTTP connect + read).
        #[arg(long, default_value_t = 5)]
        timeout: u64,
        /// Reserved for future WinRM-tunneled probe — accepted but currently ignored.
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Fetch /stats + /stats/z$ now and persist a row.
    CacheStats {
        /// Limit to one endpoint by id (mutually exclusive with --all).
        #[arg(long, conflicts_with = "all")]
        endpoint_id: Option<i64>,
        #[arg(long)]
        all: bool,
        #[arg(long, default_value_t = 5)]
        timeout: u64,
    },
    /// Run the zen-detect-binary.ps1 sidecar against a machine and persist.
    DetectBinary {
        #[arg(long, conflicts_with = "all")]
        machine: Option<i64>,
        #[arg(long)]
        all: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Read-only list of registered zen endpoints.
    ListEndpoints {
        /// Limit to one machine's endpoints.
        #[arg(long)]
        machine: Option<i64>,
    },
    /// Baseline (zen_binary_expected) inspection and lock/unlock.
    Baseline {
        #[command(subcommand)]
        action: ZenBaselineAction,
    },
    /// Register a zen endpoint for a machine (idempotent on (machine, port)).
    Register {
        /// Machine row id this endpoint runs on.
        #[arg(long, value_name = "ID")]
        machine: i64,
        /// Port the endpoint advertises (Plan §1.1 default 8558).
        #[arg(long, value_name = "PORT", default_value_t = 8558)]
        declared_port: i64,
        /// URL scheme (plan §1.1 default `http`; HTTPS unsupported in M2).
        #[arg(long, value_name = "SCHEME", default_value = "http")]
        scheme: String,
        /// Endpoint role: `local` (this machine's own zen) or `shared_upstream`
        /// (cluster master other locals forward to).
        #[arg(long, value_name = "ROLE")]
        role: String,
        /// Existing `shared_upstream` endpoint id this endpoint forwards to.
        /// Required only when `--role local` should join a cluster.
        #[arg(long, value_name = "ID")]
        upstream_endpoint_id: Option<i64>,
        /// Absolute zen data directory on the target machine. Defaults to
        /// `D:\\UECM\\ZenData` if not given — operator should override per
        /// machine to match the real disk layout.
        #[arg(long, value_name = "PATH", default_value = r"D:\UECM\ZenData")]
        data_dir: String,
        /// zen HTTP server backend (asio default, httpsys for kernel-mode).
        #[arg(long, value_name = "CLASS", default_value = "asio")]
        httpserverclass: String,
        /// Lifecycle mode. Defaults derived from role per Plan §1.1:
        /// `shared_upstream` → `installed_service` (T2.1 enforces);
        /// `local` → `editor_owned`. Pass `--lifecycle` to override.
        #[arg(long, value_name = "MODE")]
        lifecycle: Option<String>,
    },
    /// Delete a registered endpoint. Refuses if other endpoints reference it
    /// as their upstream — un-point them first.
    Unregister {
        #[arg(long, value_name = "ID")]
        endpoint_id: i64,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
    },
    /// Switch an existing endpoint's role (`local` ↔ `shared_upstream`).
    ///
    /// Avoids the unregister + re-register dance when an operator only
    /// needs to flip topology. All transitions enforced by
    /// `core::zen::endpoint::change_role`:
    /// - `local → shared_upstream`: caller MUST set `--upstream-endpoint-id None`
    ///   (omit it). A master can't itself point upstream.
    /// - `shared_upstream → local`: optionally set `--upstream-endpoint-id`
    ///   to point at another master, otherwise the endpoint becomes
    ///   standalone.
    /// - `local → local`: rewires the upstream pointer.
    /// - `shared_upstream → local` while dependents still reference this
    ///   endpoint as their upstream → refused (operator un-points first).
    ChangeRole {
        #[arg(long, value_name = "ID")]
        endpoint_id: i64,
        /// New role: `local` or `shared_upstream`.
        #[arg(long, value_name = "ROLE")]
        new_role: String,
        /// Desired upstream pointer AFTER the transition. Omit for
        /// `shared_upstream` (rejected if set) or for standalone `local`.
        #[arg(long, value_name = "ID")]
        upstream_endpoint_id: Option<i64>,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
    },
    /// Render zen_config.lua from the endpoint row + optional upstream and
    /// write it to the target host at the fixed `{ZenInstall}\zen_config.lua`
    /// path (alongside zenserver.exe — required so `service install`'s
    /// `--config=` flag can find it). `--dry-run` previews without invoking
    /// PowerShell.
    ApplyConfig {
        #[arg(long, value_name = "ID")]
        endpoint_id: i64,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Render zen.lua to stdout (read-only). Same engine as apply-config
    /// `--dry-run`, but no destination path is required.
    LuaPreview {
        #[arg(long, value_name = "ID")]
        endpoint_id: i64,
    },
    /// Windows-service management for the endpoint's zenserver.
    Service {
        #[command(subcommand)]
        action: ZenServiceAction,
    },
    /// Gracefully shut down an editor sponsor zenserver squatting the
    /// endpoint's declared port (so `service install`/`start` can take it).
    /// Refuses if the port is served by the installed ZenServer service.
    SponsorDown {
        #[arg(long, value_name = "ID")]
        endpoint_id: i64,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// URL ACL (`netsh http`) management for the endpoint.
    Urlacl {
        #[command(subcommand)]
        action: ZenUrlaclAction,
    },
    /// Enable ZenShared upstream on a project across N machines.
    ///
    /// Rewrites each target machine's `DefaultEngine.ini` (per the version-gated
    /// rule set in `docs/research/zen-ini-rules.yaml`) to:
    ///   * add the `[StorageServers]` `Shared=(Host="http://<host>:<port>", Namespace=..., ...)`
    ///     override — UE's shipped `ZenShared=(Type=Zen, ServerID=Shared)` node
    ///     picks it up (the port lives INSIDE the Host URI; UE's Zen store has
    ///     no separate `Port=` field),
    ///   * strip the legacy `Shared` / `Pak` / `CompressedPak` entries.
    /// After each per-machine INI mutation succeeds, the legacy
    /// `UE-SharedDataCachePath` env var (and any others the rule flagged) is
    /// cleaned on Machine + User scope via `zen-env-cleanup.ps1`.
    ///
    /// Destructive: requires `--yes` or `--dry-run`.
    Enable {
        /// Project row id whose `DefaultEngine.ini` to mutate. The project's
        /// `ue_version_major.minor` selects the rule overrides.
        /// Required unless `--global` is set.
        #[arg(long, value_name = "ID")]
        project_id: Option<i64>,
        /// Write ZenShared to `UserEngine.ini` (all-project global config) for
        /// every target machine. Uses each machine's `ue_runtime_user` to
        /// compute the path. Mutually exclusive with `--project-id`.
        #[arg(long, conflicts_with = "project_id")]
        global: bool,
        /// Comma-separated machine row ids to act on. Each machine MUST have a
        /// `project_locations` row for this project so we know where the INI is.
        #[arg(long, value_name = "M1,M2,...", value_delimiter = ',')]
        machines: Vec<i64>,
        /// Endpoint id of the cluster master (`shared_upstream`). Its host +
        /// declared_port go into the rendered `ZenShared` value.
        #[arg(long, value_name = "ID")]
        upstream_endpoint_id: i64,
        /// DDC namespace string substituted into the value template
        /// (Plan §1.1 default `ue.ddc`).
        #[arg(long, default_value = "ue.ddc")]
        namespace: String,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Reverse `zen enable`: remove the `ZenShared` upstream entry from each
    /// machine's `DefaultEngine.ini`. **Narrow disable** (T3.3): legacy
    /// `Pak` / `CompressedPak` / `Shared` keys that enable stripped are NOT
    /// auto-restored, and the legacy env vars are NOT touched.
    ///
    /// Destructive: requires `--yes` or `--dry-run`.
    Disable {
        /// Project row id whose `DefaultEngine.ini` to mutate.
        /// Required unless `--global` is set.
        #[arg(long, value_name = "ID")]
        project_id: Option<i64>,
        /// Remove ZenShared from `UserEngine.ini` (all-project global config).
        /// Mutually exclusive with `--project-id`.
        #[arg(long, conflicts_with = "project_id")]
        global: bool,
        #[arg(long, value_name = "M1,M2,...", value_delimiter = ',')]
        machines: Vec<i64>,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Resolve the zen INI rule set for a given UE version (T4.5 resolve-only,
    /// extended by T4.4 with `--run-editor`).
    ///
    /// Without `--run-editor` this is the original T4.5 behavior: parse
    /// `zen-ini-rules.yaml`, resolve the effective rules for the supplied
    /// `--ue-version`, and print the plan as JSON. With `--run-editor`, after
    /// the resolve succeeds the command also drives a headless UE editor on
    /// the target machine via the `zen-verify-rules.ps1` sidecar (T4.6) and
    /// watches its log for the ZenShared OK line. See
    /// `docs/research/zen-launch-mechanism.md` §8 for the matching line and
    /// why the editor has to be killed instead of waited on.
    ///
    /// `--ue-install` is captured as metadata for the resolve-only path; it
    /// IS used as the editor root (`Engine\Binaries\Win64\UnrealEditor-Cmd.exe`)
    /// when `--run-editor` is set. `--write-verified` appends the major.minor
    /// to `verified_versions` in the yaml on disk when the resolve succeeds
    /// and the version isn't already listed. The yaml file path is the same
    /// one `load_default()` picks (env override or on-disk candidate);
    /// writing to the embedded fallback is refused.
    VerifyRules {
        /// UE version to resolve rules for (e.g. `5.7` or `5.7.4`). Patch
        /// component is allowed but ignored — overrides and verified-version
        /// lookup are keyed by major.minor only.
        #[arg(long, value_name = "X.Y")]
        ue_version: String,
        /// Engine install path on the target host (used as `UeRoot` when
        /// `--run-editor` is set; metadata-only otherwise).
        #[arg(long, value_name = "PATH")]
        ue_install: String,
        /// On success, append the UE major.minor to `verified_versions` in the
        /// yaml file. No-op if already verified.
        #[arg(long)]
        write_verified: bool,
        /// When set, after the resolve runs the real T4.4 verifier against the
        /// target machine via WinRM: launches `UnrealEditor-Cmd.exe` headless,
        /// tails its log for the ZenShared OK line, kills the editor when the
        /// regex matches. Requires `--uproject-path` and `--machine`.
        #[arg(long)]
        run_editor: bool,
        /// Machine id (from inventory) to run the headless verifier on.
        /// Required with `--run-editor`.
        #[arg(long, value_name = "ID")]
        machine: Option<i64>,
        /// Absolute path on the target host to the `.uproject` to open.
        /// Required with `--run-editor`. The project must already have zen
        /// enabled (run `zen enable` first).
        #[arg(long, value_name = "PATH")]
        uproject_path: Option<String>,
        /// Editor-log tail timeout in seconds. Default 300 — UE 5.7 typically
        /// emits the ZenShared line within 20-60 s of starting; 300 is a
        /// generous ceiling. Only valid with `--run-editor`; supplying this
        /// without `--run-editor` is rejected so callers don't believe the
        /// verifier ran when it didn't.
        #[arg(long, value_name = "SECS")]
        timeout_seconds: Option<u64>,
        /// Optional: assert the matched line's host equals this. Mismatch
        /// flips the run-editor outcome's `ok` to false.
        #[arg(long, value_name = "HOST")]
        expected_host: Option<String>,
        /// Optional: assert the matched neighbour line's port equals this.
        #[arg(long, value_name = "PORT")]
        expected_port: Option<i64>,
        /// Optional: assert the matched line's namespace equals this.
        /// Default `ue.ddc` is applied by the sidecar when omitted.
        #[arg(long, value_name = "NS")]
        expected_namespace: Option<String>,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Clear a DDC-related machine environment variable across N machines over
    /// the elevated SSH channel (DESIGN-3 — reuses `zen-env-cleanup.ps1`).
    ///
    /// Standalone counterpart to the env cleanup `zen enable` already runs
    /// inline: revert a legacy SMB DDC (`UE-SharedDataCachePath`, the default)
    /// or a stale per-machine region override (`UE-ZenSharedDataCacheHost`)
    /// without re-running enable.
    ///
    /// Destructive: requires `--yes` or `--dry-run`.
    CleanEnv {
        /// Machine row ids to clear the variable on.
        #[arg(long, value_name = "M1,M2,...", value_delimiter = ',')]
        machines: Vec<i64>,
        /// Environment variable to clear. Defaults to the legacy SMB DDC path var.
        #[arg(long, default_value = "UE-SharedDataCachePath")]
        name: String,
        /// Scopes to clear. Defaults to both — an operator may have set the var
        /// via `setx` without `/M` (User scope) or with `/M` (Machine scope).
        #[arg(long, value_delimiter = ',', default_value = "machine,user")]
        scopes: Vec<String>,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Set the per-machine ZenShared region-routing override
    /// (`UE-ZenSharedDataCacheHost`) across N machines (ZEN-4).
    ///
    /// The `[StorageServers] Shared` entry `zen enable` writes declares
    /// `EnvHostOverride=UE-ZenSharedDataCacheHost`, so this Machine-scope env
    /// var (when set) overrides the INI Host — letting workstations in
    /// different regions point at their nearest shared Zen server without
    /// re-writing each project's INI. Revert a machine to the INI default with
    /// `zen clean-env --name UE-ZenSharedDataCacheHost`.
    ///
    /// Destructive: requires `--yes` or `--dry-run`.
    SetRegionHost {
        /// Machine row ids to set the override on.
        #[arg(long, value_name = "M1,M2,...", value_delimiter = ',')]
        machines: Vec<i64>,
        /// Region zen server host. Accepts `http://host:port`, `host:port`, or
        /// bare `host` (port defaults to 8558); normalized to a full URI.
        #[arg(long, value_name = "HOST")]
        host: String,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
}

#[derive(Subcommand, Debug)]
pub enum ZenBaselineAction {
    /// List baseline rows, optionally filtered.
    List {
        #[arg(long)]
        zen_build_version: Option<String>,
        /// Filter by binary kind (zen_cli | zenserver).
        #[arg(long, value_name = "KIND")]
        kind: Option<String>,
    },
    /// Set the `locked_by` marker on an existing baseline row.
    Lock {
        #[arg(long)]
        zen_build_version: String,
        #[arg(long, value_name = "KIND")]
        kind: String,
        #[arg(long)]
        locked_by: String,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
    },
    /// Clear the `locked_by` marker on an existing baseline row.
    Unlock {
        #[arg(long)]
        zen_build_version: String,
        #[arg(long, value_name = "KIND")]
        kind: String,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
    },
}

// ---------- zen service ----------
#[derive(Subcommand, Debug)]
pub enum ZenServiceAction {
    /// Install zenserver as a Windows service on the endpoint's host.
    Install {
        #[arg(long, value_name = "ID")]
        endpoint_id: i64,
        /// Optional service account. Forwarded to `zen.exe service
        /// install -u <user>`. Empty / omitted → zen default
        /// (NT AUTHORITY\\LocalService). Common values:
        /// `LocalSystem`, `.\\uecm-test`, `DOMAIN\\renderfarm-svc`.
        #[arg(long, value_name = "USER")]
        service_user: Option<String>,
        /// Password for `--service-user`. Required for non-built-in
        /// accounts (LocalSystem / LocalService / NetworkService have
        /// no password). Visible briefly in zen.exe argv — use
        /// `--service-pass-stdin` to read from stdin instead.
        #[arg(long, value_name = "PASS", conflicts_with = "service_pass_stdin")]
        service_pass: Option<String>,
        /// Read service password from stdin (single line, trailing
        /// CR/LF trimmed). Mutually exclusive with `--service-pass`.
        #[arg(long)]
        service_pass_stdin: bool,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Uninstall the zenserver Windows service.
    Uninstall {
        #[arg(long, value_name = "ID")]
        endpoint_id: i64,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Start the zenserver Windows service (idempotent).
    Start {
        #[arg(long, value_name = "ID")]
        endpoint_id: i64,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Stop the zenserver Windows service (idempotent). Destructive —
    /// stopping a `shared_upstream` cuts the whole cluster off, so the
    /// CLI requires `--yes` (or `--dry-run` to preview).
    Stop {
        #[arg(long, value_name = "ID")]
        endpoint_id: i64,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Report Windows-service status for zenserver.
    Status {
        #[arg(long, value_name = "ID")]
        endpoint_id: i64,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
}

// ---------- zen urlacl ----------
#[derive(Subcommand, Debug)]
pub enum ZenUrlaclAction {
    /// Reserve `<scheme>://+:<port>/` for the given user account.
    Add {
        #[arg(long, value_name = "ID")]
        endpoint_id: i64,
        /// Principal that may bind the prefix (e.g. `NT SERVICE\ZenServer`).
        /// Note: this is the URL ACL owner, NOT the WinRM auth user — clap
        /// would refuse to register both as `--user` on the same subcommand
        /// (`CredentialArgs` already owns that flag).
        #[arg(long, value_name = "PRINCIPAL")]
        principal: String,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// List zen-shaped URL reservations on a machine.
    List {
        #[arg(long, value_name = "ID")]
        machine: i64,
        /// Optional substring port filter (e.g. `8558`).
        #[arg(long, value_name = "PORT")]
        port_filter: Option<String>,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
    /// Remove the reservation for the endpoint's `<scheme>://+:<port>/`.
    Remove {
        #[arg(long, value_name = "ID")]
        endpoint_id: i64,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        cred: crate::credential_args::CredentialArgs,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    fn cli_with(json: bool, output: Option<OutputFormat>) -> Cli {
        Cli {
            json,
            output,
            no_color: false,
            no_input: false,
            quiet: false,
            verbose: 0,
            config: None,
            input_format: None,
            db_path: None,
            log_level: "warn".into(),
            command: Domain::System { action: SystemAction::Version },
        }
    }

    #[test]
    fn output_explicit_wins_over_json() {
        let cli = cli_with(true, Some(OutputFormat::Text));
        assert_eq!(cli.resolved_output(), OutputFormat::Text);
    }

    #[test]
    fn json_alias_maps_to_json() {
        let cli = cli_with(true, None);
        assert_eq!(cli.resolved_output(), OutputFormat::Json);
    }

    #[test]
    fn default_is_text() {
        let cli = cli_with(false, None);
        assert_eq!(cli.resolved_output(), OutputFormat::Text);
    }

    #[test]
    fn ai_agent_env_defaults_to_json() {
        use super::OutputFormat;
        // 无显式 output、无 --json，但 AI_AGENT=1 -> Json
        assert_eq!(super::resolve_output(None, false, true), OutputFormat::Json);
        // 显式 --output text 压过 AI_AGENT
        assert_eq!(super::resolve_output(Some(OutputFormat::Text), false, true), OutputFormat::Text);
        // 无任何信号 -> Text
        assert_eq!(super::resolve_output(None, false, false), OutputFormat::Text);
        // --json 别名仍 -> Json
        assert_eq!(super::resolve_output(None, true, false), OutputFormat::Json);
    }

    #[test]
    fn output_flag_round_trips_through_clap() {
        let cli =
            Cli::try_parse_from(["uecm-cli", "system", "version", "--output", "json"]).unwrap();
        assert_eq!(cli.output, Some(OutputFormat::Json));

        let cli = Cli::try_parse_from(["uecm-cli", "system", "version", "-o", "ndjson"]).unwrap();
        assert_eq!(cli.output, Some(OutputFormat::Ndjson));

        // `stream-json` is a clap alias for `ndjson` (spec §3.5).
        let cli =
            Cli::try_parse_from(["uecm-cli", "system", "version", "--output", "stream-json"])
                .unwrap();
        assert_eq!(cli.output, Some(OutputFormat::Ndjson));
    }

    #[test]
    fn parses_machine_scan() {
        let cli = Cli::try_parse_from(["uecm-cli", "machine", "scan", "192.168.10.0/24"]).unwrap();
        match cli.command {
            Domain::Machine { action: MachineAction::Scan { cidr, timeout_ms } } => {
                assert_eq!(cidr, "192.168.10.0/24");
                assert_eq!(timeout_ms, 1000);
            }
            _ => panic!("wrong variant"),
        }
        assert!(!cli.json);
    }

    #[test]
    fn parses_machine_deep_scan() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "machine", "deep-scan", "--machine-ids", "3,4,5", "--cred-alias", "prod",
        ])
        .unwrap();
        match cli.command {
            Domain::Machine { action: MachineAction::DeepScan { machine_ids, all, .. } } => {
                assert_eq!(machine_ids, vec![3, 4, 5]);
                assert!(!all);
            }
            _ => panic!("expected DeepScan"),
        }
    }

    #[test]
    fn parses_machine_authorize_with_save_as() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "machine", "authorize", "--all", "--user", "Administrator", "--pass-stdin",
            "--save-as", "prod",
        ])
        .unwrap();
        match cli.command {
            Domain::Machine { action: MachineAction::Authorize { all, save_as, .. } } => {
                assert!(all);
                assert_eq!(save_as.as_deref(), Some("prod"));
            }
            _ => panic!("expected Authorize"),
        }
    }

    #[test]
    fn parses_global_json_flag_before_subcommand() {
        let cli = Cli::try_parse_from(["uecm-cli", "--json", "system", "version"]).unwrap();
        assert!(cli.json);
    }

    #[test]
    fn parses_machine_refresh_by_id() {
        let cli = Cli::try_parse_from(["uecm-cli", "machine", "refresh", "3"]).unwrap();
        match cli.command {
            Domain::Machine { action: MachineAction::Refresh { id, cred } } => {
                assert_eq!(id, 3);
                assert!(cred.cred_alias.is_none());
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn refresh_rejects_unknown_flag() {
        let res = Cli::try_parse_from([
            "uecm-cli", "machine", "refresh", "3", "--bogus-flag", "value",
        ]);
        assert!(res.is_err());
    }

    #[test]
    fn parses_machine_refresh_with_cred_alias() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "machine", "refresh", "3", "--cred-alias", "winrm-admin",
        ])
        .unwrap();
        match cli.command {
            Domain::Machine { action: MachineAction::Refresh { id, cred } } => {
                assert_eq!(id, 3);
                assert_eq!(cred.cred_alias.as_deref(), Some("winrm-admin"));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_cred_save_with_alias_and_user() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "cred", "save",
            "--alias", "winrm-admin",
            "--user", "Administrator",
            "--pass-stdin",
        ]).unwrap();
        match cli.command {
            Domain::Cred { action: CredAction::Save { alias, user, pass, pass_stdin, .. } } => {
                assert_eq!(alias, "winrm-admin");
                assert_eq!(user, "Administrator");
                assert_eq!(pass, None);
                assert!(pass_stdin);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn cred_save_rejects_both_pass_and_pass_stdin() {
        let r = Cli::try_parse_from([
            "uecm-cli", "cred", "save",
            "--alias", "a", "--user", "u",
            "--pass", "p", "--pass-stdin",
        ]);
        assert!(r.is_err());
    }

    #[test]
    fn env_set_rejects_both_host_and_hosts() {
        let r = Cli::try_parse_from([
            "uecm-cli", "env", "set",
            "--host", "a", "--hosts", "b,c",
            "--name", "X", "--value", "Y",
        ]);
        assert!(r.is_err());
    }

    #[test]
    fn env_set_accepts_hosts_list() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "env", "set",
            "--hosts", "a,b,c",
            "--name", "X", "--value", "Y",
        ]).unwrap();
        match cli.command {
            Domain::Env { action: EnvAction::Set { target, name, value, .. } } => {
                assert_eq!(target.hosts, Some(vec!["a".into(), "b".into(), "c".into()]));
                assert_eq!(name, "X");
                assert_eq!(value, "Y");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_ini_backend_graph_set() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "ini", "backend-graph", "set",
            "--hosts", "R01,R02", "--file-path", r"D:\Proj\Config\DefaultEngine.ini",
            "--node", "Shared", "--field", "ReadOnly", "--value", "false",
            "--cred-alias", "admin", "--yes",
        ]).unwrap();
        match cli.command {
            Domain::Ini { action: IniAction::BackendGraph { action: BackendGraphAction::Set { node, field, value, .. } } } => {
                assert_eq!(node, "Shared");
                assert_eq!(field, "ReadOnly");
                assert_eq!(value, "false");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_local_cache_create_batch() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "local-cache", "create",
            "--hosts", "RENDER-01,RENDER-02",
            "--path", r"D:\UE-DDC-Local",
            "--cred-alias", "admin",
            "--yes",
        ]).unwrap();
        match cli.command {
            Domain::LocalCache { action: LocalCacheAction::Create { path, yes, .. } } => {
                assert_eq!(path, r"D:\UE-DDC-Local");
                assert!(yes);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_log_verify_startup() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "log", "verify-startup",
            "--host", "RENDER-01",
            "--editor-exe", r"C:\UE\Engine\Binaries\Win64\UnrealEditor.exe",
            "--project", r"D:\Projects\MyVP\MyVP.uproject",
            "--timeout", "180",
        ]).unwrap();
        match cli.command {
            Domain::Log { action: LogAction::VerifyStartup { host, editor_exe, project, timeout, .. } } => {
                assert_eq!(host, "RENDER-01");
                assert!(editor_exe.ends_with("UnrealEditor.exe"));
                assert!(project.ends_with(".uproject"));
                assert_eq!(timeout, 180);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_deploy_ddc() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "deploy", "ddc",
            "--plan", "/tmp/plan.json",
            "--stop-on-failure",
            "--cred-alias", "admin",
            "--yes",
        ]).unwrap();
        match cli.command {
            Domain::Deploy { action: DeployAction::Ddc { plan, stop_on_failure, yes, .. } } => {
                assert_eq!(plan.to_string_lossy(), "/tmp/plan.json");
                assert!(stop_on_failure);
                assert!(yes);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_ini_gc_pause() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "ini", "gc-pause",
            "--hosts", "R01,R02",
            "--project-id", "1",
            "--cred-alias", "admin", "--yes",
        ]).unwrap();
        match cli.command {
            Domain::Ini { action: IniAction::GcPause { project_id, yes, .. } } => {
                assert_eq!(project_id, 1);
                assert!(yes);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_ini_gc_resume_with_age() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "ini", "gc-resume",
            "--hosts", "R01",
            "--project-id", "1",
            "--unused-file-age", "30",
            "--cred-alias", "admin", "--yes",
        ]).unwrap();
        match cli.command {
            Domain::Ini { action: IniAction::GcResume { unused_file_age, .. } } => {
                assert_eq!(unused_file_age, 30);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_ini_zen_gc_pause() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "ini", "zen-gc-pause",
            "--hosts", "R01",
            "--project-id", "7",
            "--cred-alias", "admin", "--yes",
        ]).unwrap();
        match cli.command {
            Domain::Ini { action: IniAction::ZenGcPause { project_id, yes, .. } } => {
                assert_eq!(project_id, 7);
                assert!(yes);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_ini_zen_gc_resume_default_and_override() {
        // default gc_seconds = 14-day engine default
        let cli = Cli::try_parse_from([
            "uecm-cli", "ini", "zen-gc-resume",
            "--hosts", "R01", "--project-id", "1",
            "--cred-alias", "admin", "--yes",
        ]).unwrap();
        match cli.command {
            Domain::Ini { action: IniAction::ZenGcResume { gc_seconds, .. } } => {
                assert_eq!(gc_seconds, 1_209_600);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_health_run_with_expected_paths() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "health", "run",
            "--machine-ids", "1,2",
            "--expected-local-path", r"D:\UE-DDC-Local",
            "--expected-shared-path", r"\\NAS\DDC",
            "--cred-alias", "admin",
        ])
        .unwrap();
        match cli.command {
            Domain::Health {
                action: HealthAction::Run { expected_local_path, expected_shared_path, .. },
            } => {
                assert_eq!(expected_local_path, r"D:\UE-DDC-Local");
                assert_eq!(expected_shared_path, r"\\NAS\DDC");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_health_run_without_expected_paths_defaults_to_empty() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "health", "run",
            "--machine-ids", "1",
        ])
        .unwrap();
        match cli.command {
            Domain::Health {
                action: HealthAction::Run { expected_local_path, expected_shared_path, .. },
            } => {
                assert_eq!(expected_local_path, "");
                assert_eq!(expected_shared_path, "");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_health_scan_command_line() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "health", "scan-command-line",
            "--host", "RENDER-01",
            "--cred-alias", "admin",
        ]).unwrap();
        match cli.command {
            Domain::Health { action: HealthAction::ScanCommandLine { host, .. } } => {
                assert_eq!(host, "RENDER-01");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_health_file_stats() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "health", "file-stats",
            "--host", "RENDER-01",
            "--local-path", r"D:\UE-DDC-Local",
            "--shared-path", r"\\NAS\DDC",
            "--cred-alias", "admin",
        ]).unwrap();
        match cli.command {
            Domain::Health { action: HealthAction::FileStats { host, .. } } => {
                assert_eq!(host, "RENDER-01");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_health_analyze_advisories() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "health", "analyze-advisories",
            "--host", "RENDER-01",
            "--editor-exe", r"C:\UE\UnrealEditor.exe",
            "--project", r"D:\Proj\Foo.uproject",
            "--local-path", r"D:\UE-DDC-Local",
            "--shared-path", r"\\NAS\DDC",
            "--cred-alias", "admin",
        ]).unwrap();
        match cli.command {
            Domain::Health { action: HealthAction::AnalyzeAdvisories { host, .. } } => {
                assert_eq!(host, "RENDER-01");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_health_run_with_machine_ids() {
        let cli = Cli::try_parse_from(["uecm-cli", "health", "run", "--machine-ids", "1,2,3"]).unwrap();
        match cli.command {
            Domain::Health { action: HealthAction::Run { machine_ids, cidr, all, .. } } => {
                assert_eq!(machine_ids, vec![1, 2, 3]);
                assert_eq!(cidr, None);
                assert_eq!(all, false);
            }
            _ => panic!("expected Health::Run"),
        }
    }

    #[test]
    fn parses_health_run_with_cidr() {
        let cli = Cli::try_parse_from(["uecm-cli", "health", "run", "--cidr", "192.168.10.0/24"]).unwrap();
        match cli.command {
            Domain::Health { action: HealthAction::Run { cidr, .. } } => {
                assert_eq!(cidr.as_deref(), Some("192.168.10.0/24"));
            }
            _ => panic!("expected Health::Run"),
        }
    }

    #[test]
    fn parses_health_run_with_all_flag() {
        let cli = Cli::try_parse_from(["uecm-cli", "health", "run", "--all"]).unwrap();
        match cli.command {
            Domain::Health { action: HealthAction::Run { all, .. } } => assert!(all),
            _ => panic!("expected Health::Run"),
        }
    }

    #[test]
    fn parses_health_run_with_no_target_mode() {
        let cli = Cli::try_parse_from(["uecm-cli", "health", "run"]).unwrap();
        match cli.command {
            Domain::Health { action: HealthAction::Run { machine_ids, cidr, all, .. } } => {
                assert!(machine_ids.is_empty());
                assert_eq!(cidr, None);
                assert_eq!(all, false);
            }
            _ => panic!("expected Health::Run"),
        }
    }

    #[test]
    fn rejects_cidr_and_machine_ids_together() {
        let r = Cli::try_parse_from(["uecm-cli", "health", "run", "--cidr", "10.0.0.0/24", "--machine-ids", "1"]);
        assert!(r.is_err(), "should reject --cidr + --machine-ids");
    }

    #[test]
    fn rejects_all_and_cidr_together() {
        let r = Cli::try_parse_from(["uecm-cli", "health", "run", "--all", "--cidr", "10.0.0.0/24"]);
        assert!(r.is_err(), "should reject --all + --cidr");
    }

    // ---------- T3.6: ddc --backend flag ----------

    #[test]
    fn ddc_generate_backend_defaults_to_auto() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "ddc", "generate",
            "--project-id", "1",
            "--source-machine", "1",
        ]).unwrap();
        match cli.command {
            Domain::Ddc { action: DdcAction::Generate { backend, .. } } => {
                assert_eq!(backend, CacheBackendChoice::Auto);
            }
            _ => panic!("expected Ddc::Generate"),
        }
    }

    #[test]
    fn ddc_generate_accepts_backend_zen() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "ddc", "generate",
            "--project-id", "1",
            "--source-machine", "1",
            "--backend", "zen",
        ]).unwrap();
        match cli.command {
            Domain::Ddc { action: DdcAction::Generate { backend, .. } } => {
                assert_eq!(backend, CacheBackendChoice::Zen);
            }
            _ => panic!("expected Ddc::Generate"),
        }
    }

    #[test]
    fn ddc_verify_accepts_backend_legacy() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "ddc", "verify",
            "--project-id", "1",
            "--source-machine", "1",
            "--backend", "legacy",
        ]).unwrap();
        match cli.command {
            Domain::Ddc { action: DdcAction::Verify { backend, .. } } => {
                assert_eq!(backend, CacheBackendChoice::Legacy);
            }
            _ => panic!("expected Ddc::Verify"),
        }
    }

    #[test]
    fn ddc_distribute_accepts_backend_zen() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "ddc", "distribute",
            "--project-id", "1",
            "--source-machine", "1",
            "--targets", "2,3",
            "--backend", "zen",
            "--yes",
        ]).unwrap();
        match cli.command {
            Domain::Ddc { action: DdcAction::Distribute { backend, .. } } => {
                assert_eq!(backend, CacheBackendChoice::Zen);
            }
            _ => panic!("expected Ddc::Distribute"),
        }
    }

    // ---------- T3.7: zen enable / disable ----------

    #[test]
    fn zen_enable_parses_required_flags() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "zen", "enable",
            "--project-id", "7",
            "--machines", "1,2,3",
            "--upstream-endpoint-id", "9",
            "--cred-alias", "winrm-admin",
            "--yes",
        ]).unwrap();
        match cli.command {
            Domain::Zen { action: ZenAction::Enable {
                project_id, machines, upstream_endpoint_id, namespace, yes, dry_run, cred, global: _,
            } } => {
                assert_eq!(project_id, Some(7));
                assert_eq!(machines, vec![1, 2, 3]);
                assert_eq!(upstream_endpoint_id, 9);
                assert_eq!(namespace, "ue.ddc");
                assert!(yes);
                assert!(!dry_run);
                assert_eq!(cred.cred_alias.as_deref(), Some("winrm-admin"));
            }
            _ => panic!("expected Zen::Enable"),
        }
    }

    #[test]
    fn zen_enable_accepts_custom_namespace_and_dry_run() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "zen", "enable",
            "--project-id", "1",
            "--machines", "5",
            "--upstream-endpoint-id", "2",
            "--namespace", "ue.shared",
            "--dry-run",
        ]).unwrap();
        match cli.command {
            Domain::Zen { action: ZenAction::Enable { namespace, dry_run, yes, machines, .. } } => {
                assert_eq!(namespace, "ue.shared");
                assert!(dry_run);
                assert!(!yes);
                assert_eq!(machines, vec![5]);
            }
            _ => panic!("expected Zen::Enable"),
        }
    }

    #[test]
    fn zen_disable_parses_required_flags() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "zen", "disable",
            "--project-id", "1",
            "--machines", "1,2",
            "--yes",
        ]).unwrap();
        match cli.command {
            Domain::Zen { action: ZenAction::Disable {
                project_id, machines, yes, dry_run, ..
            } } => {
                assert_eq!(project_id, Some(1));
                assert_eq!(machines, vec![1, 2]);
                assert!(yes);
                assert!(!dry_run);
            }
            _ => panic!("expected Zen::Disable"),
        }
    }

    // ---------- T4.5: zen verify-rules ----------

    #[test]
    fn zen_verify_rules_parses_required_flags() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "zen", "verify-rules",
            "--ue-version", "5.7",
            "--ue-install", "C:\\UE\\5.7",
        ]).unwrap();
        match cli.command {
            Domain::Zen { action: ZenAction::VerifyRules {
                ue_version, ue_install, write_verified, run_editor,
                machine, uproject_path, timeout_seconds, ..
            } } => {
                assert_eq!(ue_version, "5.7");
                assert_eq!(ue_install, "C:\\UE\\5.7");
                assert!(!write_verified);
                assert!(!run_editor);
                assert!(machine.is_none());
                assert!(uproject_path.is_none());
                // Default is no longer baked into clap — handler applies 300
                // when --run-editor is set. The bare invocation parses None.
                assert!(timeout_seconds.is_none());
            }
            _ => panic!("expected Zen::VerifyRules"),
        }
    }

    #[test]
    fn zen_verify_rules_accepts_write_verified() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "zen", "verify-rules",
            "--ue-version", "5.8.0",
            "--ue-install", "/Users/lan/UE",
            "--write-verified",
        ]).unwrap();
        match cli.command {
            Domain::Zen { action: ZenAction::VerifyRules { write_verified, ue_version, .. } } => {
                assert!(write_verified);
                assert_eq!(ue_version, "5.8.0");
            }
            _ => panic!("expected Zen::VerifyRules"),
        }
    }

    // T4.4: --run-editor adds the headless verifier hop. We just assert
    // the flags plumb through clap into ZenAction::VerifyRules; the actual
    // dispatch lives in `cli::domain_zen::verify_rules`.
    #[test]
    fn zen_verify_rules_accepts_run_editor_flags() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "zen", "verify-rules",
            "--ue-version", "5.7",
            "--ue-install", "D:\\UE_5.7",
            "--run-editor",
            "--machine", "5",
            "--uproject-path", "E:\\proj\\p.uproject",
            "--timeout-seconds", "120",
            "--expected-host", "127.0.0.1",
            "--expected-port", "8558",
            "--expected-namespace", "ue.ddc",
            "--cred-alias", "render-svc",
        ]).unwrap();
        match cli.command {
            Domain::Zen { action: ZenAction::VerifyRules {
                run_editor, machine, uproject_path, timeout_seconds,
                expected_host, expected_port, expected_namespace, cred, ..
            } } => {
                assert!(run_editor);
                assert_eq!(machine, Some(5));
                assert_eq!(uproject_path.as_deref(), Some("E:\\proj\\p.uproject"));
                assert_eq!(timeout_seconds, Some(120));
                assert_eq!(expected_host.as_deref(), Some("127.0.0.1"));
                assert_eq!(expected_port, Some(8558));
                assert_eq!(expected_namespace.as_deref(), Some("ue.ddc"));
                assert_eq!(cred.cred_alias.as_deref(), Some("render-svc"));
            }
            _ => panic!("expected Zen::VerifyRules"),
        }
    }

    #[test]
    fn zen_verify_rules_rejects_missing_ue_version() {
        let r = Cli::try_parse_from([
            "uecm-cli", "zen", "verify-rules",
            "--ue-install", "C:\\UE\\5.7",
        ]);
        assert!(r.is_err());
    }

    #[test]
    fn ddc_generate_rejects_unknown_backend_value() {
        let r = Cli::try_parse_from([
            "uecm-cli", "ddc", "generate",
            "--project-id", "1",
            "--source-machine", "1",
            "--backend", "garbage",
        ]);
        assert!(r.is_err(), "clap must reject unknown --backend values");
    }

    #[test]
    fn parses_ini_config_with_domain() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "ini", "config", "37", "--domain", "ddc",
        ]).unwrap();
        match cli.command {
            Domain::Ini { action: IniAction::Config { scan_run_id, domain } } => {
                assert_eq!(scan_run_id, 37);
                assert_eq!(domain.as_deref(), Some("ddc"));
            }
            _ => panic!("expected ini config"),
        }
    }

    #[test]
    fn parses_ini_scan_project_id() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "ini", "scan", "--project-id", "5", "--machine-id", "11",
        ]).unwrap();
        match cli.command {
            Domain::Ini { action: IniAction::Scan { project_id, machine_id, machine_ids, .. } } => {
                assert_eq!(project_id, Some(5));
                assert_eq!(machine_id, Some(11));
                assert!(machine_ids.is_empty());
            }
            _ => panic!("expected ini scan"),
        }
    }

    #[test]
    fn ini_scan_project_id_conflicts_with_machine_ids() {
        let res = Cli::try_parse_from([
            "uecm-cli", "ini", "scan", "--project-id", "5", "--machine-ids", "1,2",
        ]);
        assert!(res.is_err(), "project-id and machine-ids must conflict");
    }

    #[test]
    fn use_color_truth_table() {
        // flag 关 + 非 TTY + 无 env -> 由 is_tty 决定
        assert!(super::use_color(false, true, false));
        assert!(!super::use_color(false, false, false));
        // --no-color 一票否决
        assert!(!super::use_color(true, true, false));
        // NO_COLOR env 一票否决
        assert!(!super::use_color(false, true, true));
    }

    #[test]
    fn effective_log_level_rules() {
        // 默认透传
        assert_eq!(super::effective_log_level("warn", 0, false), "warn");
        // --quiet 压到 error，优先级最高
        assert_eq!(super::effective_log_level("debug", 2, true), "error");
        // -v -> info, -vv -> debug，覆盖基线
        assert_eq!(super::effective_log_level("warn", 1, false), "info");
        assert_eq!(super::effective_log_level("warn", 2, false), "debug");
        // -vvv 仍封顶 trace
        assert_eq!(super::effective_log_level("warn", 5, false), "trace");
    }

    #[test]
    fn no_input_flag_parses() {
        let cli = Cli::try_parse_from(["uecm-cli", "--no-input", "system", "version"]).unwrap();
        assert!(cli.no_input);
        let cli2 = Cli::try_parse_from(["uecm-cli", "system", "version"]).unwrap();
        assert!(!cli2.no_input);
    }

    #[test]
    fn completion_command_parses_shell() {
        let cli = Cli::try_parse_from(["uecm-cli", "system", "completion", "bash"]).unwrap();
        match cli.command {
            Domain::System { action: SystemAction::Completion { shell } } => {
                assert_eq!(shell, clap_complete::Shell::Bash);
            }
            _ => panic!("expected system completion bash"),
        }
    }

    #[test]
    fn parses_zen_sponsor_down() {
        let cli = Cli::try_parse_from([
            "uecm-cli", "zen", "sponsor-down", "--endpoint-id", "1", "--dry-run",
        ])
        .expect("sponsor-down should parse");
        match cli.command {
            Domain::Zen { action: ZenAction::SponsorDown { endpoint_id, dry_run, yes, .. } } => {
                assert_eq!(endpoint_id, 1);
                assert!(dry_run);
                assert!(!yes);
            }
            _ => panic!("expected ZenAction::SponsorDown"),
        }
    }
}
