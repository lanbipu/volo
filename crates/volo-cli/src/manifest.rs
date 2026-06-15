//! Contract Manifest (spec §2). Canonical operation_id registry; every operation
//! carries input_schema (from clap), output_schema (per-result type), and a shared
//! error_schema. Built at runtime so output_schema can call schema_for!.

use crate::args::Domain;
use schemars::schema_for;

#[derive(Debug, Clone, Copy)]
pub struct SideEffects {
    pub writes: bool,
    pub external_calls: bool,
    pub idempotent: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct Operation {
    pub operation_id: &'static str,
    pub summary: &'static str,
    pub cli_command: &'static str,
    pub side_effects: SideEffects,
    pub exit_codes: &'static [i32],
}

/// 静态操作表（不含 schema；schema 在 manifest_json 运行时拼装）。Task 6 补其余域。
pub fn operations() -> &'static [Operation] {
    const OPS: &[Operation] = &[
        Operation { operation_id: "system.version",    summary: "Print binary + library version",         cli_command: "voloctl uecm system version",    side_effects: SideEffects{writes:false,external_calls:false,idempotent:true}, exit_codes: &[0] },
        Operation { operation_id: "system.db_path",    summary: "Print resolved SQLite DB path",           cli_command: "voloctl uecm system db-path",    side_effects: SideEffects{writes:false,external_calls:false,idempotent:true}, exit_codes: &[0,3] },
        Operation { operation_id: "system.ps_dir",     summary: "Print resolved ps-scripts dir",           cli_command: "voloctl uecm system ps-dir",     side_effects: SideEffects{writes:false,external_calls:false,idempotent:true}, exit_codes: &[0] },
        Operation { operation_id: "system.migrate_db", summary: "Force-run schema migrations",             cli_command: "voloctl uecm system migrate-db", side_effects: SideEffects{writes:true, external_calls:false,idempotent:true}, exit_codes: &[0,3] },
        Operation { operation_id: "system.echo",       summary: "Round-trip a message via PowerShell",     cli_command: "voloctl uecm system echo",       side_effects: SideEffects{writes:false,external_calls:true, idempotent:true}, exit_codes: &[0,4] },
        Operation { operation_id: "system.schema",     summary: "Dump clap command tree as JSON",          cli_command: "voloctl uecm system schema",     side_effects: SideEffects{writes:false,external_calls:false,idempotent:true}, exit_codes: &[0] },
        Operation { operation_id: "system.exit_codes", summary: "Print documented exit-code table",        cli_command: "voloctl uecm system exit-codes", side_effects: SideEffects{writes:false,external_calls:false,idempotent:true}, exit_codes: &[0] },
        Operation { operation_id: "system.completion", summary: "Generate a shell completion script",                         cli_command: "voloctl uecm system completion",  side_effects: SideEffects{writes:false,external_calls:false,idempotent:true}, exit_codes: &[0,2] },
        Operation { operation_id: "machine.list",      summary: "List all known machines",                 cli_command: "voloctl uecm machine list",      side_effects: SideEffects{writes:false,external_calls:false,idempotent:true}, exit_codes: &[0,3] },
        Operation { operation_id: "machine.scan",      summary: "Probe a CIDR for live hosts",             cli_command: "voloctl uecm machine scan",      side_effects: SideEffects{writes:false,external_calls:true, idempotent:true}, exit_codes: &[0,2] },
        Operation { operation_id: "machine.add",       summary: "Add a machine to inventory",              cli_command: "voloctl uecm machine add",       side_effects: SideEffects{writes:true, external_calls:false,idempotent:false}, exit_codes: &[0,2,3] },
        Operation { operation_id: "machine.refresh",   summary: "Refresh a machine (probe + detect)",      cli_command: "voloctl uecm machine refresh",   side_effects: SideEffects{writes:true, external_calls:true, idempotent:true}, exit_codes: &[0,2,3,4] },
        Operation { operation_id: "machine.detail",    summary: "Show machine detail",                     cli_command: "voloctl uecm machine detail",    side_effects: SideEffects{writes:false,external_calls:false,idempotent:true}, exit_codes: &[0,2] },
        Operation { operation_id: "machine.delete",    summary: "Delete machine(s)",                       cli_command: "voloctl uecm machine delete",    side_effects: SideEffects{writes:true, external_calls:false,idempotent:true}, exit_codes: &[0,2] },
        Operation { operation_id: "machine.rename",    summary: "Rename a machine",                        cli_command: "voloctl uecm machine rename",    side_effects: SideEffects{writes:true, external_calls:false,idempotent:true}, exit_codes: &[0,2] },
        Operation { operation_id: "machine.deep_scan", summary: "Refresh + INI scan + health per machine", cli_command: "voloctl uecm machine deep-scan", side_effects: SideEffects{writes:true, external_calls:true, idempotent:true}, exit_codes: &[0,2,3,4] },
        Operation { operation_id: "machine.authorize",   summary: "Authorize machines for remote mgmt",          cli_command: "voloctl uecm machine authorize",   side_effects: SideEffects{writes:true, external_calls:true, idempotent:true}, exit_codes: &[0,2,4] },
        Operation { operation_id: "machine.set_ue_user", summary: "Set Windows UE runtime user for global INI",  cli_command: "voloctl uecm machine set-ue-user", side_effects: SideEffects{writes:true, external_calls:false,idempotent:true}, exit_codes: &[0,2] },
        // ---- Task 6 batch 1: gpu / log / ssh / deploy / cred / local-cache / secret ----
        Operation { operation_id: "gpu.matrix",             summary: "GPU consistency matrix across all machines",          cli_command: "voloctl uecm gpu matrix",            side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "log.verify_startup",     summary: "Run UE nullrhi + parse DDC startup output",            cli_command: "voloctl uecm log verify-startup",    side_effects: SideEffects{writes:false,external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "ssh.probe",              summary: "Probe a host's SSH reachability",                      cli_command: "voloctl uecm ssh probe",             side_effects: SideEffects{writes:false,external_calls:true, idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "ssh.package_bootstrap",  summary: "Assemble a USB SSH onboarding bundle (replaces winrm bootstrap-script)", cli_command: "voloctl uecm ssh package-bootstrap", side_effects: SideEffects{writes:true, external_calls:false,idempotent:true},  exit_codes: &[0,1,3,4] },
        Operation { operation_id: "deploy.ddc",             summary: "Run the full DDC deployment plan from a JSON file",    cli_command: "voloctl uecm deploy ddc",            side_effects: SideEffects{writes:true, external_calls:true, idempotent:false}, exit_codes: &[0,1,2,3] },
        Operation { operation_id: "cred.list",              summary: "List saved credential aliases",                        cli_command: "voloctl uecm cred list",             side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "cred.save",              summary: "Save a credential (SecretStore + SQLite metadata)",    cli_command: "voloctl uecm cred save",             side_effects: SideEffects{writes:true, external_calls:false,idempotent:true},  exit_codes: &[0,2,3] },
        Operation { operation_id: "cred.delete",            summary: "Delete a credential alias",                            cli_command: "voloctl uecm cred delete",           side_effects: SideEffects{writes:true, external_calls:false,idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "localcache.create",      summary: "Create the local DDC directory on one or more hosts",  cli_command: "voloctl uecm local-cache create",    side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3] },
        Operation { operation_id: "secret.set",             summary: "Store (or overwrite) a secret under an alias",         cli_command: "voloctl uecm secret set",            side_effects: SideEffects{writes:true, external_calls:false,idempotent:true},  exit_codes: &[0,2,3] },
        Operation { operation_id: "secret.get",             summary: "Print the stored secret for an alias",                 cli_command: "voloctl uecm secret get",            side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,2,3] },
        Operation { operation_id: "secret.list",            summary: "List all stored aliases (keys only)",                  cli_command: "voloctl uecm secret list",           side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "secret.delete",          summary: "Delete the secret for an alias",                       cli_command: "voloctl uecm secret delete",         side_effects: SideEffects{writes:true, external_calls:false,idempotent:true},  exit_codes: &[0,2,3] },
        // ---- Task 6 batch 2: share / env / project / ddc / pso / health / ini / zen ----
        Operation { operation_id: "share.list",                summary: "List share configs in the local inventory",                       cli_command: "voloctl uecm share list",                 side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "share.forget",              summary: "Forget a share config (local inventory only)",                    cli_command: "voloctl uecm share forget",               side_effects: SideEffects{writes:true, external_calls:false,idempotent:true},  exit_codes: &[0,2,3] },
        Operation { operation_id: "share.create",              summary: "Create an SMB share (Mode A open / Mode B dedicated)",            cli_command: "voloctl uecm share create",               side_effects: SideEffects{writes:true, external_calls:true, idempotent:false}, exit_codes: &[0,2,3,4] },
        Operation { operation_id: "share.inject_system_cred",  summary: "Inject the share's SYSTEM-context credential on a client",         cli_command: "voloctl uecm share inject-system-cred",   side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "env.get",                   summary: "Read a remote environment variable on one host",                  cli_command: "voloctl uecm env get",                    side_effects: SideEffects{writes:false,external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "env.set",                   summary: "Write a remote env var on one or more hosts",                      cli_command: "voloctl uecm env set",                    side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "project.list",              summary: "List all projects",                                               cli_command: "voloctl uecm project list",               side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "project.locations",         summary: "List all locations for a project",                                cli_command: "voloctl uecm project locations",          side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "project.discover",          summary: "Discover .uproject files on a remote machine",                    cli_command: "voloctl uecm project discover",           side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "project.create_manual",     summary: "Create a project manually (no discovery)",                        cli_command: "voloctl uecm project create-manual",      side_effects: SideEffects{writes:true, external_calls:false,idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "project.set_location",      summary: "Add or update a location for an existing project",                cli_command: "voloctl uecm project set-location",       side_effects: SideEffects{writes:true, external_calls:false,idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "project.delete",            summary: "Delete a project and cascade its locations",                      cli_command: "voloctl uecm project delete",             side_effects: SideEffects{writes:true, external_calls:false,idempotent:true},  exit_codes: &[0,2,3] },
        Operation { operation_id: "project.delete_location",   summary: "Delete a single project_location row",                            cli_command: "voloctl uecm project delete-location",    side_effects: SideEffects{writes:true, external_calls:false,idempotent:true},  exit_codes: &[0,2,3] },
        Operation { operation_id: "ddc.generate",              summary: "Generate a DDC pak file via UE -DDC=CreatePak",                   cli_command: "voloctl uecm ddc generate",               side_effects: SideEffects{writes:true, external_calls:true, idempotent:false}, exit_codes: &[0,1,2,3,4] },
        Operation { operation_id: "ddc.verify",                summary: "Verify a previously generated .ddp pak exists",                   cli_command: "voloctl uecm ddc verify",                 side_effects: SideEffects{writes:false,external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "ddc.distribute",            summary: "Distribute the DDC pak to target machines via Robocopy",          cli_command: "voloctl uecm ddc distribute",             side_effects: SideEffects{writes:true, external_calls:true, idempotent:false}, exit_codes: &[0,1,2,3,4] },
        Operation { operation_id: "pso.verify",                summary: "Verify PSO precaching CVars (R008-R010) for a project",           cli_command: "voloctl uecm pso verify",                 side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,2,3] },
        Operation { operation_id: "pso.collect",               summary: "Run UE -game to collect PSO cache files (streaming)",             cli_command: "voloctl uecm pso collect",                side_effects: SideEffects{writes:true, external_calls:true, idempotent:false}, exit_codes: &[0,1,2,3,4] },
        Operation { operation_id: "pso.list",                  summary: "List collected PSO cache files for a project",                    cli_command: "voloctl uecm pso list",                   side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "pso.distribute",            summary: "Distribute PSO cache files to target machines",                   cli_command: "voloctl uecm pso distribute",             side_effects: SideEffects{writes:true, external_calls:true, idempotent:false}, exit_codes: &[0,1,2,3,4] },
        Operation { operation_id: "health.run",                summary: "Run L1/L2/L3 health probes with remediation hints",               cli_command: "voloctl uecm health run",                 side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "health.runs",               summary: "List recent health scan runs",                                    cli_command: "voloctl uecm health runs",                side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "health.results",            summary: "List per-row health results for a scan run",                      cli_command: "voloctl uecm health results",             side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "health.consistency_check",  summary: "Snapshot N hosts and report inconsistencies",                     cli_command: "voloctl uecm health consistency-check",   side_effects: SideEffects{writes:false,external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "health.scan_command_line",  summary: "Scan shortcuts/bat/services for DDC path overrides",              cli_command: "voloctl uecm health scan-command-line",   side_effects: SideEffects{writes:false,external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "health.file_stats",         summary: "Local vs Shared DDC file count/size with imbalance classifier",   cli_command: "voloctl uecm health file-stats",          side_effects: SideEffects{writes:false,external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "health.analyze_advisories", summary: "Log verify + file stats then emit symptom advisories",            cli_command: "voloctl uecm health analyze-advisories",  side_effects: SideEffects{writes:false,external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "ini.read",                  summary: "Read all keys from one INI section on a single host",             cli_command: "voloctl uecm ini read",                   side_effects: SideEffects{writes:false,external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "ini.set",                   summary: "Write a single INI key on one or more hosts",                     cli_command: "voloctl uecm ini set",                    side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "ini.remove",                summary: "Remove a single INI key on one or more hosts",                    cli_command: "voloctl uecm ini remove",                 side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "ini.scan",                  summary: "Run cluster INI scan across one or more machines",                cli_command: "voloctl uecm ini scan",                   side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "ini.runs",                  summary: "List recent INI scan runs",                                       cli_command: "voloctl uecm ini runs",                   side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "ini.findings",              summary: "List findings for a given scan run",                              cli_command: "voloctl uecm ini findings",               side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "ini.get_finding",           summary: "Get one finding by id",                                           cli_command: "voloctl uecm ini get-finding",            side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "ini.apply",                 summary: "Auto-fix a finding's recommendation on the remote machine",       cli_command: "voloctl uecm ini apply",                  side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "ini.skip",                  summary: "Mark a finding as skipped",                                       cli_command: "voloctl uecm ini skip",                   side_effects: SideEffects{writes:true, external_calls:false,idempotent:true},  exit_codes: &[0,2,3] },
        Operation { operation_id: "ini.config",                summary: "List captured DDC/PSO/Zen config snapshots for a scan run",       cli_command: "voloctl uecm ini config",                 side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "ini.verify_pso_precaching", summary: "Verify PSO precaching CVars in ConsoleVariables.ini",             cli_command: "voloctl uecm ini verify-pso-precaching",  side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,2,3] },
        Operation { operation_id: "ini.backend_graph",         summary: "Read/write/scan [DerivedDataBackendGraph] tuple nodes",           cli_command: "voloctl uecm ini backend-graph",          side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "ini.gc_pause",              summary: "Pause Shared DDC GC (DeleteUnused=false)",                        cli_command: "voloctl uecm ini gc-pause",               side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "ini.gc_resume",             summary: "Resume Shared DDC GC (DeleteUnused=true)",                        cli_command: "voloctl uecm ini gc-resume",              side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "zen.status",                summary: "Read-only view of latest probe per endpoint",                     cli_command: "voloctl uecm zen status",                 side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "zen.probe",                 summary: "Probe one or more endpoints now and persist each",                cli_command: "voloctl uecm zen probe",                  side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3] },
        Operation { operation_id: "zen.cache_stats",           summary: "Fetch /stats + /stats/z$ now and persist a row",                  cli_command: "voloctl uecm zen cache-stats",            side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3] },
        Operation { operation_id: "zen.detect_binary",         summary: "Run zen-detect-binary sidecar against a machine and persist",     cli_command: "voloctl uecm zen detect-binary",          side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "zen.list_endpoints",        summary: "Read-only list of registered zen endpoints",                      cli_command: "voloctl uecm zen list-endpoints",         side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,3] },
        Operation { operation_id: "zen.baseline",              summary: "Baseline inspection and lock/unlock",                             cli_command: "voloctl uecm zen baseline",               side_effects: SideEffects{writes:true, external_calls:false,idempotent:true},  exit_codes: &[0,2,3] },
        Operation { operation_id: "zen.register",              summary: "Register a zen endpoint for a machine (idempotent)",              cli_command: "voloctl uecm zen register",               side_effects: SideEffects{writes:true, external_calls:false,idempotent:true},  exit_codes: &[0,2,3] },
        Operation { operation_id: "zen.unregister",            summary: "Delete a registered endpoint",                                    cli_command: "voloctl uecm zen unregister",             side_effects: SideEffects{writes:true, external_calls:false,idempotent:true},  exit_codes: &[0,2,3] },
        Operation { operation_id: "zen.change_role",           summary: "Switch an endpoint's role (local <-> shared_upstream)",           cli_command: "voloctl uecm zen change-role",            side_effects: SideEffects{writes:true, external_calls:false,idempotent:true},  exit_codes: &[0,2,3] },
        Operation { operation_id: "zen.apply_config",          summary: "Render zen.lua and write it to the target host",                  cli_command: "voloctl uecm zen apply-config",           side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "zen.lua_preview",           summary: "Render zen.lua to stdout (read-only)",                            cli_command: "voloctl uecm zen lua-preview",            side_effects: SideEffects{writes:false,external_calls:false,idempotent:true},  exit_codes: &[0,2,3] },
        Operation { operation_id: "zen.service",               summary: "Windows-service management for the endpoint's zenserver",         cli_command: "voloctl uecm zen service",                side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "zen.sponsor_down",          summary: "Gracefully shut down an editor sponsor zenserver on the port",    cli_command: "voloctl uecm zen sponsor-down",           side_effects: SideEffects{writes:false,external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "zen.urlacl",                summary: "URL ACL (netsh http) management for the endpoint",                cli_command: "voloctl uecm zen urlacl",                 side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "zen.enable",                summary: "Enable ZenShared upstream on a project across N machines",        cli_command: "voloctl uecm zen enable",                 side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "zen.disable",               summary: "Remove the ZenShared upstream entry from each machine's INI",     cli_command: "voloctl uecm zen disable",                side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "zen.verify_rules",          summary: "Resolve the zen INI rule set for a UE version",                   cli_command: "voloctl uecm zen verify-rules",           side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "zen.clean_env",             summary: "Clear a DDC env var (UE-SharedDataCachePath etc.) across machines", cli_command: "voloctl uecm zen clean-env",              side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
        Operation { operation_id: "zen.set_region_host",       summary: "Set the per-machine ZenShared region override (UE-ZenSharedDataCacheHost)", cli_command: "voloctl uecm zen set-region-host",        side_effects: SideEffects{writes:true, external_calls:true, idempotent:true},  exit_codes: &[0,2,3,4] },
    ];
    OPS
}

pub fn operation_id_for(cmd: &Domain) -> &'static str {
    use crate::args::{MachineAction, SystemAction};
    match cmd {
        Domain::System { action } => match action {
            SystemAction::Version => "system.version",
            SystemAction::DbPath => "system.db_path",
            SystemAction::PsDir => "system.ps_dir",
            SystemAction::MigrateDb => "system.migrate_db",
            SystemAction::Echo { .. } => "system.echo",
            SystemAction::Schema => "system.schema",
            SystemAction::ExitCodes => "system.exit_codes",
            SystemAction::Completion { .. } => "system.completion",
        },
        Domain::Machine { action } => match action {
            MachineAction::List => "machine.list",
            MachineAction::Scan { .. } => "machine.scan",
            MachineAction::Add { .. } => "machine.add",
            MachineAction::Refresh { .. } => "machine.refresh",
            MachineAction::Detail { .. } => "machine.detail",
            MachineAction::Delete { .. } => "machine.delete",
            MachineAction::Rename { .. } => "machine.rename",
            MachineAction::SetUeUser { .. } => "machine.set_ue_user",
            MachineAction::DeepScan { .. } => "machine.deep_scan",
            MachineAction::Authorize { .. } => "machine.authorize",
            // 不加 `_ =>`：保持穷尽，新增变体编译器强制来补。
        },
        // Task 6: per-domain exhaustive maps (no `_` wildcard — new variants must
        // force a compile error so the manifest can never silently drift).
        Domain::Ssh { action } => match action {
            crate::args::SshAction::Probe { .. } => "ssh.probe",
            crate::args::SshAction::PackageBootstrap { .. } => "ssh.package_bootstrap",
        },
        Domain::Cred { action } => match action {
            crate::args::CredAction::List => "cred.list",
            crate::args::CredAction::Save { .. } => "cred.save",
            crate::args::CredAction::Delete { .. } => "cred.delete",
        },
        Domain::Secret { action } => match action {
            crate::args::SecretAction::Set { .. } => "secret.set",
            crate::args::SecretAction::Get { .. } => "secret.get",
            crate::args::SecretAction::List => "secret.list",
            crate::args::SecretAction::Delete { .. } => "secret.delete",
        },
        // ---- Task 6 batch 2: share / env / project / ddc / pso / health / ini / zen ----
        Domain::Share { action } => match action {
            crate::args::ShareAction::List => "share.list",
            crate::args::ShareAction::Forget { .. } => "share.forget",
            crate::args::ShareAction::Create { .. } => "share.create",
            crate::args::ShareAction::InjectSystemCred { .. } => "share.inject_system_cred",
        },
        Domain::Env { action } => match action {
            crate::args::EnvAction::Get { .. } => "env.get",
            crate::args::EnvAction::Set { .. } => "env.set",
        },
        Domain::Project { action } => match action {
            crate::args::ProjectAction::List => "project.list",
            crate::args::ProjectAction::Locations { .. } => "project.locations",
            crate::args::ProjectAction::Discover { .. } => "project.discover",
            crate::args::ProjectAction::CreateManual { .. } => "project.create_manual",
            crate::args::ProjectAction::SetLocation { .. } => "project.set_location",
            crate::args::ProjectAction::Delete { .. } => "project.delete",
            crate::args::ProjectAction::DeleteLocation { .. } => "project.delete_location",
        },
        Domain::Ddc { action } => match action {
            // NB: operation_id is `ddc.*` (domain prefix), NOT the `ddc_pak.*`
            // DB task-label used by operations::start. `ddc_pak` is not a domain.
            crate::args::DdcAction::Generate { .. } => "ddc.generate",
            crate::args::DdcAction::Verify { .. } => "ddc.verify",
            crate::args::DdcAction::Distribute { .. } => "ddc.distribute",
        },
        Domain::Pso { action } => match action {
            crate::args::PsoAction::Verify { .. } => "pso.verify",
            crate::args::PsoAction::Collect { .. } => "pso.collect",
            crate::args::PsoAction::List { .. } => "pso.list",
            crate::args::PsoAction::Distribute { .. } => "pso.distribute",
        },
        Domain::Health { action } => match action {
            crate::args::HealthAction::Run { .. } => "health.run",
            crate::args::HealthAction::Runs { .. } => "health.runs",
            crate::args::HealthAction::Results { .. } => "health.results",
            crate::args::HealthAction::ConsistencyCheck { .. } => "health.consistency_check",
            crate::args::HealthAction::ScanCommandLine { .. } => "health.scan_command_line",
            crate::args::HealthAction::FileStats { .. } => "health.file_stats",
            crate::args::HealthAction::AnalyzeAdvisories { .. } => "health.analyze_advisories",
        },
        Domain::Ini { action } => match action {
            crate::args::IniAction::Read { .. } => "ini.read",
            crate::args::IniAction::Set { .. } => "ini.set",
            crate::args::IniAction::Remove { .. } => "ini.remove",
            crate::args::IniAction::Scan { .. } => "ini.scan",
            crate::args::IniAction::Runs { .. } => "ini.runs",
            crate::args::IniAction::Findings { .. } => "ini.findings",
            crate::args::IniAction::GetFinding { .. } => "ini.get_finding",
            crate::args::IniAction::Apply { .. } => "ini.apply",
            crate::args::IniAction::Skip { .. } => "ini.skip",
            crate::args::IniAction::Config { .. } => "ini.config",
            crate::args::IniAction::VerifyPsoPrecaching { .. } => "ini.verify_pso_precaching",
            // Nested `backend-graph` sub-subcommands all roll up to one
            // operation_id (the leaf-count guard treats `ini backend-graph`
            // as a single leaf — it does not recurse a third level).
            crate::args::IniAction::BackendGraph { .. } => "ini.backend_graph",
            crate::args::IniAction::GcPause { .. } => "ini.gc_pause",
            crate::args::IniAction::GcResume { .. } => "ini.gc_resume",
        },
        Domain::Gpu { action } => match action {
            crate::args::GpuAction::Matrix => "gpu.matrix",
        },
        Domain::Log { action } => match action {
            crate::args::LogAction::VerifyStartup { .. } => "log.verify_startup",
        },
        Domain::LocalCache { action } => match action {
            crate::args::LocalCacheAction::Create { .. } => "localcache.create",
        },
        Domain::Deploy { action } => match action {
            crate::args::DeployAction::Ddc { .. } => "deploy.ddc",
        },
        Domain::Zen { action } => match action {
            // Nested baseline/service/urlacl sub-subcommands roll up to one id
            // each (leaf-count guard treats `zen baseline|service|urlacl` as a
            // single leaf). These ids match the existing DB task labels.
            crate::args::ZenAction::Status { .. } => "zen.status",
            crate::args::ZenAction::Probe { .. } => "zen.probe",
            crate::args::ZenAction::CacheStats { .. } => "zen.cache_stats",
            crate::args::ZenAction::DetectBinary { .. } => "zen.detect_binary",
            crate::args::ZenAction::ListEndpoints { .. } => "zen.list_endpoints",
            crate::args::ZenAction::Baseline { .. } => "zen.baseline",
            crate::args::ZenAction::Register { .. } => "zen.register",
            crate::args::ZenAction::Unregister { .. } => "zen.unregister",
            crate::args::ZenAction::ChangeRole { .. } => "zen.change_role",
            crate::args::ZenAction::ApplyConfig { .. } => "zen.apply_config",
            crate::args::ZenAction::LuaPreview { .. } => "zen.lua_preview",
            crate::args::ZenAction::Service { .. } => "zen.service",
            crate::args::ZenAction::SponsorDown { .. } => "zen.sponsor_down",
            crate::args::ZenAction::Urlacl { .. } => "zen.urlacl",
            crate::args::ZenAction::Enable { .. } => "zen.enable",
            crate::args::ZenAction::Disable { .. } => "zen.disable",
            crate::args::ZenAction::VerifyRules { .. } => "zen.verify_rules",
            crate::args::ZenAction::CleanEnv { .. } => "zen.clean_env",
            crate::args::ZenAction::SetRegionHost { .. } => "zen.set_region_host",
        },
        Domain::Manifest => "manifest.get",
    }
}

/// 共享错误 schema（所有 operation 的 error_schema 都是这个）。
pub fn error_schema() -> serde_json::Value {
    serde_json::to_value(schema_for!(crate::envelope::ErrorBody)).unwrap()
}

/// 流式操作（emit_event 序列）的共享输出 schema。
pub fn event_schema() -> serde_json::Value {
    serde_json::to_value(schema_for!(crate::output::Event)).unwrap()
}

/// ad-hoc `serde_json::Value` 输出（无命名类型）用的宽 object schema。
fn dynamic_object_schema() -> serde_json::Value {
    serde_json::json!({ "type": "object", "additionalProperties": true })
}

/// 每个操作的输出（`data`）schema。typed 结果用 schema_for!；流式用 event_schema；
/// ad-hoc json 用 dynamic_object_schema。Task 6 为其余域补 match 臂。
pub fn output_schema_for(operation_id: &str) -> serde_json::Value {
    match operation_id {
        "system.version" => serde_json::to_value(schema_for!(crate::domain_system::VersionInfo)).unwrap(),
        "system.db_path" | "system.ps_dir" => serde_json::to_value(schema_for!(crate::domain_system::PathInfo)).unwrap(),
        "system.migrate_db" | "system.echo" | "system.schema" | "system.exit_codes" | "system.completion" => dynamic_object_schema(),
        // emit_event(...) handlers -> event-shaped output. add/delete/rename emit
        // Event::Completed{..} just like scan/refresh/deep_scan/authorize.
        "machine.scan" | "machine.deep_scan" | "machine.refresh" | "machine.authorize"
        | "machine.add" | "machine.delete" | "machine.rename" => event_schema(),
        // emit_result(&T) handlers (machine.list / machine.detail) return ad-hoc json
        // (Task 6 可换成命名类型）：
        s if s.starts_with("machine.") => dynamic_object_schema(),

        // ---- Task 6 batch 1 ----
        // Typed emit_result(&T): named Serialize structs given schemars::JsonSchema.
        "gpu.matrix"         => serde_json::to_value(schema_for!(cache_core::core::gpu_consistency::GpuMatrix)).unwrap(),
        "log.verify_startup" => serde_json::to_value(schema_for!(cache_core::core::ue_log_verify::VerifyReport)).unwrap(),
        "ssh.probe"          => serde_json::to_value(schema_for!(crate::domain_ssh::ProbeOut)).unwrap(),
        "cred.list"          => serde_json::to_value(schema_for!(Vec<cache_core::data::credentials::CredentialRecord>)).unwrap(),
        // emit_event(...) only: cred save/delete emit Event::Completed; local-cache
        // create emits the full Started/ItemStarted/ItemCompleted stream.
        "cred.save" | "cred.delete" | "localcache.create" => event_schema(),
        // Dynamic: ad-hoc serde_json::Value emit_result, or a single op that emits
        // two unrelated shapes so no one schema is honest.
        //   secret.*            -> all four emit ad-hoc json (set/get/list, and
        //                          delete's success {alias,deleted}; delete dry-run
        //                          emits an Event, hence not typed).
        //   deploy.ddc          -> streams typed DeployEvent items on success but
        //                          emits Event::Completed on --dry-run; mixed.
        s if s.starts_with("secret.") => dynamic_object_schema(),
        "deploy.ddc"              => dynamic_object_schema(),
        "ssh.package_bootstrap"   => dynamic_object_schema(),

        // ---- Task 6 batch 2: share / env / project / ddc / pso / health / ini / zen ----
        // Typed emit_result(&T): named Serialize structs given schemars::JsonSchema.
        "share.list"          => serde_json::to_value(schema_for!(Vec<cache_core::data::share_configs::ShareConfig>)).unwrap(),
        "project.list"        => serde_json::to_value(schema_for!(Vec<cache_core::data::Project>)).unwrap(),
        "project.locations"   => serde_json::to_value(schema_for!(Vec<cache_core::data::ProjectLocation>)).unwrap(),
        "pso.list"            => serde_json::to_value(schema_for!(Vec<cache_core::data::pso_cache_files::PsoCacheFile>)).unwrap(),
        "health.runs" | "ini.runs"
                              => serde_json::to_value(schema_for!(Vec<cache_core::data::scan_runs::ScanRun>)).unwrap(),
        "health.results"      => serde_json::to_value(schema_for!(Vec<cache_core::data::health_check_runs::HealthCheckRow>)).unwrap(),
        "health.scan_command_line"
                              => serde_json::to_value(schema_for!(Vec<cache_core::core::command_line_scanner::CmdLineHit>)).unwrap(),
        "ini.findings"        => serde_json::to_value(schema_for!(Vec<cache_core::data::IniFinding>)).unwrap(),
        "ini.get_finding"     => serde_json::to_value(schema_for!(Option<cache_core::data::IniFinding>)).unwrap(),
        // ini.config emit_result(&Vec<ConfigSnapshot>) in json mode (human mode
        // uses emit_text); the structured contract is the typed snapshot list.
        "ini.config"          => serde_json::to_value(schema_for!(Vec<cache_core::data::ini_config_snapshots::ConfigSnapshot>)).unwrap(),

        // emit_event(...) streams (Started/Item*/Completed; dry-run emit_plan also
        // emits Event::Completed) -> event-shaped output.
        //   share.forget/create/inject_system_cred, env.set, project mutations,
        //   pso.collect/distribute, health.run, ini set/remove/scan/apply/skip/
        //   gc_pause/gc_resume.
        "share.forget" | "share.create" | "share.inject_system_cred"
        | "env.set"
        | "project.discover" | "project.create_manual" | "project.set_location"
        | "project.delete" | "project.delete_location"
        | "pso.collect" | "pso.distribute"
        | "health.run"
        | "ini.set" | "ini.remove" | "ini.scan" | "ini.apply" | "ini.skip"
        | "ini.gc_pause" | "ini.gc_resume" => event_schema(),
        // zen ops that emit ONLY an Event stream (incl. dry-run plan):
        "zen.probe" | "zen.cache_stats" | "zen.detect_binary"
        | "zen.unregister" | "zen.change_role" | "zen.apply_config" => event_schema(),

        // Dynamic: ad-hoc serde_json::Value emit_result, or a single op (or a
        // group rolled into one id) that emits multiple unrelated shapes so no
        // one schema is honest.
        //   env.get             -> EnvGetOut<'a> (borrowed lifetime; schema_for!
        //                          needs a concrete lifetime, so dynamic is the
        //                          honest fallback for the small typed struct).
        //   ini.read            -> IniReadOut<'a> (same lifetime constraint).
        //   ini.verify_pso_precaching -> ad-hoc {project_id, machine_ids, note}.
        //   ini.backend_graph   -> get(ad-hoc json) / set(event|plan) /
        //                          scan(typed Vec) rolled into one id -> mixed.
        //   pso.verify          -> ad-hoc {project_id, machine_ids, note}.
        //   ddc.generate/verify/distribute -> each can stream events OR emit a
        //                          one-shot ad-hoc result (zen-skip / verify
        //                          output / dry-run) -> mixed per op.
        //   health.consistency_check/file_stats/analyze_advisories -> ad-hoc
        //                          composite {…} json.
        //   zen.status          -> ad-hoc {endpoints:[…]}.
        //   zen.list_endpoints  -> typed Vec but rolled in with the rest of the
        //                          ad-hoc-dominant zen domain (see note below).
        //   zen.baseline        -> list(typed Vec) / lock/unlock(event) mixed.
        //   zen.register/lua_preview/verify_rules -> ad-hoc doc json.
        //   zen.service/urlacl  -> each rolls 3+ sub-subcommands (event + ad-hoc
        //                          result) into one id -> mixed.
        //   zen.enable/disable  -> emit BOTH a one-shot ad-hoc result doc AND a
        //                          terminal Event::Completed -> mixed.
        "env.get" | "ini.read" | "ini.verify_pso_precaching" | "ini.backend_graph"
        | "pso.verify"
        | "ddc.generate" | "ddc.verify" | "ddc.distribute"
        | "health.consistency_check" | "health.file_stats" | "health.analyze_advisories"
            => dynamic_object_schema(),
        s if s.starts_with("zen.") => dynamic_object_schema(),

        // Defensive bottom: every current op_id is classified above; this only
        // catches a FUTURE op_id that nobody mapped — schema-completeness test
        // still passes because dynamic_object_schema() is a valid object schema.
        _ => dynamic_object_schema(),
    }
}

/// 从 clap 命令树为某操作派生 input_schema（参数 -> JSON Schema properties）。
pub fn input_schema_for(cli_command: &str) -> serde_json::Value {
    use clap::CommandFactory;
    // cli_command is now `voloctl uecm <domain> <action…>` (review #9). The clap
    // tree we parse against is the UECM `Cli::command()` whose top-level
    // subcommands are the domains, so drop the 2-token `voloctl uecm` prefix.
    let parts: Vec<&str> = cli_command.split_whitespace().skip(2).collect();
    let root = crate::args::Cli::command();
    let mut current: &clap::Command = &root;
    for p in &parts {
        match current.find_subcommand(p) {
            Some(sub) => current = sub,
            None => return dynamic_object_schema(),
        }
    }
    let mut props = serde_json::Map::new();
    let mut required = Vec::new();
    for arg in current.get_arguments() {
        let id = arg.get_id().as_str();
        if id == "help" || id == "version" {
            continue;
        }
        let ty = if arg.get_action().takes_values() { "string" } else { "boolean" };
        props.insert(id.to_string(), serde_json::json!({ "type": ty }));
        if arg.is_required_set() {
            required.push(serde_json::json!(id));
        }
    }
    serde_json::json!({
        "type": "object",
        "properties": props,
        "required": required,
        "additionalProperties": false
    })
}

/// 渲染 spec §2.1 完整 manifest 文档。
pub fn manifest_json() -> serde_json::Value {
    let err = error_schema();
    let ops: Vec<serde_json::Value> = operations()
        .iter()
        .map(|op| {
            serde_json::json!({
                "operation_id": op.operation_id,
                "summary": op.summary,
                "input_schema": input_schema_for(op.cli_command),
                "output_schema": output_schema_for(op.operation_id),
                "error_schema": err,
                "side_effects": {
                    "writes": op.side_effects.writes,
                    "external_calls": op.side_effects.external_calls,
                    "idempotent": op.side_effects.idempotent,
                },
                "exit_codes": op.exit_codes,
                "cli": { "command": op.cli_command }
            })
        })
        .collect();
    serde_json::json!({ "contract_version": "1.0", "operations": ops })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_ids_are_unique() {
        let mut ids: Vec<&str> = operations().iter().map(|o| o.operation_id).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "duplicate operation_id");
    }

    #[test]
    fn manifest_has_three_schemas_per_op() {
        let m = manifest_json();
        for op in m["operations"].as_array().unwrap() {
            let id = op["operation_id"].as_str().unwrap();
            assert!(op["input_schema"].is_object(), "{id} missing input_schema");
            assert!(op["output_schema"].is_object(), "{id} missing output_schema");
            assert!(op["error_schema"].is_object(), "{id} missing error_schema");
        }
    }

    #[test]
    fn output_schema_modes_match_emission() {
        // emit_event(...) handlers carry event-shaped output.
        assert_eq!(output_schema_for("machine.scan"), event_schema());
        // machine.add was reclassified from dynamic to event (it emits
        // Event::Completed{..} from its handler).
        assert_eq!(output_schema_for("machine.add"), event_schema());
        // emit_result(&T) handlers return dynamic object schemas.
        assert_eq!(output_schema_for("machine.list"), super::dynamic_object_schema());
    }

    #[test]
    fn manifest_command_parses() {
        use crate::args::{Cli, Domain};
        use clap::Parser;
        let cli = Cli::try_parse_from(["uecm-cli", "manifest"]).unwrap();
        assert!(matches!(cli.command, Domain::Manifest));
    }

    #[test]
    fn every_operation_id_well_formed_and_known_domain() {
        let known = ["system","machine","ssh","cred","secret","env","ini","share","project","health","gpu","ddc","pso","log","localcache","deploy","zen"];
        for op in operations() {
            let domain = op.operation_id.split('.').next().unwrap();
            assert!(known.contains(&domain), "unknown domain in {}", op.operation_id);
            assert!(op.operation_id.contains('.'), "id must be <domain>.<action>: {}", op.operation_id);
        }
    }

    #[test]
    fn no_operation_has_empty_or_unmapped_schema() {
        let m = manifest_json();
        for op in m["operations"].as_array().unwrap() {
            let id = op["operation_id"].as_str().unwrap();
            assert!(!id.contains("unmapped"), "{id} still unmapped");
            for key in ["input_schema","output_schema","error_schema"] {
                let s = &op[key];
                assert!(s.is_object(), "{id}.{key} missing");
                // schema 必须至少有一个有效关键字，避免空对象冒充。
                // oneOf/anyOf/allOf 是 schemars 对 enum 的合法输出（如 Event）；
                // type/properties/$ref 覆盖 struct / dynamic_object_schema。
                let valid = s.get("type").is_some()
                    || s.get("$ref").is_some()
                    || s.get("properties").is_some()
                    || s.get("oneOf").is_some()
                    || s.get("anyOf").is_some()
                    || s.get("allOf").is_some();
                assert!(valid, "{id}.{key} is an empty/invalid schema");
            }
        }
    }

    #[test]
    fn operation_count_covers_command_leaves() {
        use clap::CommandFactory;
        let cmd = crate::args::Cli::command();
        let mut leaves = 0usize;
        for sub in cmd.get_subcommands() {
            if sub.get_name() == "help" { continue; }
            let inner = sub.get_subcommands().filter(|s| s.get_name() != "help").count();
            leaves += if inner == 0 { 1 } else { inner };
        }
        // Locked numbers (2026-05-24, post SSH migration): operations().len()=87, leaves=88.
        // `manifest` is a leaf subcommand (no sub-subcommands → counts as 1 leaf)
        // but is NOT in the OPERATIONS table (it's the meta-command that *prints*
        // the manifest). That accounts for the deliberate gap of exactly 1.
        // If you add a new CLI subcommand without a matching OPERATIONS row,
        // leaves will grow past 91 while operations().len() stays at 90,
        // breaking the assertion below — add the OPERATIONS row to fix it.
        assert_eq!(
            operations().len() + 1,
            leaves,
            "manifest ops ({}) + 1 must equal CLI leaves ({}); \
             add a matching OPERATIONS row for any new subcommand",
            operations().len(),
            leaves,
        );
    }
}
