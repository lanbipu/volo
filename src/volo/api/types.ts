/* Volo — Cache DTO types (1:1 with the Rust `Serialize` shapes).
   Field names are snake_case to match the wire format (crates use plain
   `#[derive(Serialize)]` without rename_all unless noted). Enums map to the
   serde `rename_all` casing. `unknown` stands in for `serde_json::Value`.
   Source of truth: src-tauri/src/commands/*.rs + crates/cache-core. */

/* ============================ enums ============================ */
export type GpuVendor = "nvidia" | "amd" | "intel" | "unknown";
export type CredentialKind = "winrm" | "share";
export type ShareMode = "open" | "managed";
export type BatchStatus = "running" | "ok" | "err";
/** Where the UE process runs (remote source machine vs the operator's local
 *  machine) — distinct from the project's cache storage routing (zen/legacy_pak). */
export type ExecutionLocation = "remote" | "local";
export type CellStatus = "match" | "deviation" | "unknown";
export type DiscoveryStatus = "auto" | "manual_alias" | "manual_path";
export type DeployStep =
  | "provision_local_dir"
  | "set_local_env"
  | "create_smb_share"
  | "set_shared_env"
  | "write_backend_graph"
  | "generate_ddc_pak"
  | "distribute_ddc_pak"
  | "set_pso_cvars"
  | "collect_pso"
  | "distribute_pso"
  | "verify_startup_logs";

/* ============================ machines ============================ */
export interface Machine {
  id: number | null;
  hostname: string;
  ip: string;
  role: string;
  status: string;
  last_seen_at: string | null;
}

export interface UeRuntimeUserRow {
  machine_id: number;
  ue_runtime_user: string | null;
}

export interface UeInstall {
  id: number | null;
  machine_id: number;
  version: string;
  install_path: string;
  is_primary: boolean;
  zen_cli_intree_path: string | null;
  zen_cli_intree_version: string | null;
  zen_cli_intree_sha256: string | null;
  zenserver_intree_path: string | null;
  zenserver_intree_version: string | null;
  zenserver_intree_sha256: string | null;
}

export interface GpuInfo {
  id: number | null;
  machine_id: number;
  gpu_model: string;
  driver_version: string;
  vendor: GpuVendor;
  vram_mb: number | null;
}

export interface MachineDetail {
  machine: Machine;
  ue_installs: UeInstall[];
  gpus: GpuInfo[];
}

export interface WinrmBootstrapResult {
  ok: boolean;
  method: string;
  message: string;
  winrm_ok: boolean;
  changed: string[];
  manual_script: string | null;
}

/** Result of `package_ssh_bootstrap` — the assembled USB onboarding bundle. */
export interface PackageBootstrapResult {
  output_directory: string;
  files: string[];
}

export interface EchoResult {
  received: string;
  timestamp: string;
  machine: string;
}

/* ============================ discovery ============================ */
export interface ProbedHost {
  ip: string;
  winrm_open: boolean;
  smb_open: boolean;
  rpc_open: boolean;
}

export interface ScanResult {
  probed: ProbedHost[];
}

export interface RefreshResult {
  machine_id: number;
  winrm_ok: boolean;
  ue_installs: UeInstall[];
  gpus: GpuInfo[];
  error: string | null;
}

/* ============================ credentials ============================ */
export interface CredentialRecord {
  id: number | null;
  alias: string;
  kind: CredentialKind;
  username: string;
}

/* ============================ ini editor / scanner ============================ */
export interface IniKey {
  name: string;
  value: string;
}

export interface WriteIniResponse {
  backup_path: string;
}

export interface ScanInisRequest {
  machine_ids: number[];
  credential_alias: string;
  project_paths: string[];
  user_profile_path: string | null;
}

export interface IniScanSummary {
  scan_run_id: number;
  critical: number;
  warning: number;
  healthy: number;
  info: number;
  total_files: number;
}

export interface IniFinding {
  id: number | null;
  scan_run_id: number;
  machine_id: number;
  rule_id: string;
  severity: string;
  category: string;
  file_path: string;
  section: string | null;
  key_name: string | null;
  line_number: number | null;
  snippet_before: string;
  snippet_after: string | null;
  recommended_action: string;
  recommended_value: string | null;
  symptom: string;
  rationale: string;
  fixed_at: string | null;
  skipped_at: string | null;
}

export interface ScanInisResponse {
  scan_run_id: number;
  summary: IniScanSummary;
  findings: IniFinding[];
}

export interface ScanRun {
  id: number | null;
  scan_type: string;
  started_at: string | null;
  finished_at: string | null;
  machine_ids: number[];
  summary: unknown | null;
}

/* ============================ log verify ============================ */
export interface MaintenanceFact {
  layer: string;
  file_count: number;
  total_bytes: number;
}

export interface VerifyReport {
  host: string;
  local_path: string | null;
  local_writable: boolean | null;
  shared_path: string | null;
  shared_writable: boolean | null;
  shared_deactivated_reason: string | null;
  move_collision_count: number;
  maintenance: MaintenanceFact[];
  paks_opened: string[];
  truncated: boolean;
  log_path: string | null;
}

/* ============================ deploy workflow ============================ */
export interface LocalCacheSpec {
  path: string;
  service_account: string | null;
}

export interface SharedCacheSpec {
  server_machine_id: number;
  share_name: string;
  server_path: string;
  mode: string;
  unc_path: string | null;
}

export interface PakSpec {
  enabled: boolean;
}

export interface PsoSpec {
  enabled: boolean;
  resolution: string;
  max_minutes: number;
}

export interface VerifySpec {
  run_log_verify: boolean;
  editor_exe: string;
  timeout_seconds: number;
}

export interface DeployPlan {
  project_id: number;
  source_machine_id: number;
  target_machine_ids: number[];
  local_cache: LocalCacheSpec;
  shared_cache: SharedCacheSpec;
  ddc_pak: PakSpec;
  pso: PsoSpec;
  verify: VerifySpec;
}

export type DeployEvent =
  | { kind: "step_started"; step: DeployStep; hosts: string[] }
  | { kind: "step_host_ok"; step: DeployStep; host: string; message: string | null }
  | { kind: "step_host_error"; step: DeployStep; host: string; error: string }
  | { kind: "step_completed"; step: DeployStep; ok_count: number; fail_count: number }
  | { kind: "plan_completed"; ok: boolean; summary: string };

/* ============================ consistency check ============================ */
export interface ProjectDir {
  Path: string;
  UProject: string;
}

export interface HostSnapshot {
  host: string;
  ue_installs: UeInstall[];
  gpu: GpuInfo | null;
  rhi: string | null;
  projects: ProjectDir[];
  renderstream_version: string | null;
}

export type Inconsistency =
  | { kind: "ue_version_mismatch"; found: Record<string, string[]> }
  | { kind: "render_stream_version_mismatch"; found: Record<string, string[]> }
  | { kind: "rhi_mismatch"; found: Record<string, string[]> }
  | { kind: "gpu_model_mismatch"; found: Record<string, string[]> }
  | { kind: "gpu_driver_mismatch"; found: Record<string, string[]> }
  | { kind: "missing_ue"; hosts: string[] };

/** run_consistency_check returns a 2-tuple → JSON array [snapshots, issues]. */
export type ConsistencyResult = [HostSnapshot[], Inconsistency[]];

/* ============================ gpu consistency ============================ */
export interface GpuSignature {
  vendor: string;
  model: string;
  driver: string;
}

export interface GpuSignatureCount {
  signature: GpuSignature;
  count: number;
}

export interface MachineGpuCell {
  machine_id: number;
  hostname: string;
  signature: GpuSignature | null;
  status: CellStatus;
}

export interface GpuMatrix {
  signatures: GpuSignatureCount[];
  baseline: GpuSignature | null;
  cells: MachineGpuCell[];
}

/* ============================ shares ============================ */
export interface CreateShareResponse {
  share_config_id: number;
  unc_path: string;
  mode: ShareMode;
  credential_alias: string | null;
}

export interface TeardownShareResult {
  share_config_id: number;
  host: string;
  share_name: string;
  kept_files: boolean;
  message: string;
}

export interface InjectionResult {
  client_machine_id: number;
  ok: boolean;
  message: string;
}

export interface ShareConfig {
  id: number | null;
  host_machine_id: number;
  share_name: string;
  unc_path: string;
  local_path: string;
  mode: ShareMode;
  credential_alias: string | null;
}

/* ============================ projects ============================ */
export interface ProjectSummary {
  id: number;
  uproject_name: string;
  display_name: string | null;
  uproject_guid: string | null;
  location_count: number;
}

export interface ProjectLocation {
  id: number | null;
  project_id: number;
  machine_id: number;
  abs_path: string;
  uproject_path: string;
  discovery_status: DiscoveryStatus;
  discovered_at: string | null;
}

export interface DiscoveryResult {
  project_id: number;
  location_id: number;
  uproject_filename: string;
  abs_path: string;
}

/* ============================ ddc pak ============================ */
export interface GenerateJobResponse {
  job_id: string;
  source_machine_id: number;
  project_id: number;
  backend: string;
}

export interface DistributePlanItem {
  target_machine_id: number;
  target_host: string;
  source_unc: string;
  target_local: string;
  file_name?: string | null;
  source_smb_user: string | null;
}

export interface DistributeJobResponse {
  job_id: string;
  project_id: number;
  source_machine_id: number;
  plan: DistributePlanItem[];
}

export interface PakOutput {
  path: string;
  size_bytes: number;
}

export type UeRunnerEvent =
  | { kind: "spawned"; pid: number; log_path: string }
  | { kind: "log_line"; text: string; parsed_kind: string | null }
  | { kind: "progress"; pct: number | null; label: string }
  | { kind: "completed"; exit_code: number; log_tail: string[] }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export interface BatchEvent {
  machine_id: number;
  status: BatchStatus;
  message: string | null;
}

/* ============================ pso ============================ */
export interface PsoCollectJobResponse {
  job_id: string;
  source_machine_id: number;
  project_id: number;
}

export interface PsoCacheFile {
  id: number | null;
  project_id: number;
  source_machine_id: number;
  file_path: string;
  file_name: string;
  size_bytes: number;
  gpu_signature: string;
  ue_version: string | null;
  collected_at: string | null;
}

export interface DistributePsoCacheRequest {
  file_id: number;
  target_machine_ids: number[];
  named_share_unc: string | null;
  operator_credential_alias: string | null;
  source_smb_credential_alias: string | null;
  force_gpu_mismatch: boolean;
}

/** PsoDistributePlanItem is a Rust type-alias of DistributePlanItem. */
export interface PsoDistributeJobResponse {
  job_id: string;
  plan: DistributePlanItem[];
}

/* ------------- pso warm-up & readiness (per-node -game runs) ------------- */
/** ok = 跑满计划时长或引擎正常退出（唯一可给绿灯的状态）；cancelled = 操作员手动取消（未验证）。 */
export type WarmupStatus = "running" | "ok" | "err" | "cancelled";

export interface StartPsoWarmupRequest {
  project_id: number;
  target_machine_ids: number[];
  resolution_w: number;
  resolution_h: number;
  /** 必须 >= 1：0 会解除 watchdog，后端直接拒绝。 */
  max_minutes: number;
  /** 钉死各节点用的 UE 版本；省略 = 各节点 primary 安装（与工程版本不符时有风险）。 */
  ue_version?: string | null;
}

export interface PsoWarmupLaunched {
  machine_id: number;
  run_id: number;
  job_id: string;
}

export interface PsoWarmupJobResponse {
  job_id: string;
  runs: PsoWarmupLaunched[];
}

export interface PsoWarmupRun {
  id: number | null;
  project_id: number;
  machine_id: number;
  resolution_w: number;
  resolution_h: number;
  max_minutes: number;
  /** null while running; 0 once finished = green light. */
  hitch_count: number | null;
  status: WarmupStatus;
  error_message: string | null;
  started_at: string | null;
  duration_secs: number | null;
}

/* ============================ health check ============================ */
export interface RunHealthCheckRequest {
  machine_ids: number[];
  credential_alias: string;
  project_paths: string[];
  expected_local_path?: string | null;
  expected_shared_path?: string | null;
}

export interface HealthRunSummary {
  scan_run_id: number;
  healthy: number;
  warning: number;
  critical: number;
  offline: number;
  skipped: number;
  total: number;
}

export interface HealthProgressEvent {
  scan_run_id: number;
  machine_id: number;
  done: boolean;
  error: string | null;
}

export interface HealthCheckRow {
  scan_run_id: number;
  machine_id: number;
  /** map of check-id → CheckOutcome; serialized as serde_json::Value. */
  machine_results: unknown;
}

export interface CheckOutcome {
  status: string;
  message: string;
  sample: string;
  remediation: string;
}

/* ============================ zen ============================ */
export interface ZenStatusRow {
  endpoint_id: number;
  machine_id: number;
  hostname: string;
  ip: string;
  declared_port: number;
  scheme: string;
  role: string;
  lifecycle_mode: string;
  effective_port: number | null;
  build_version: string | null;
  reachable: boolean | null;
  last_probed_at: string | null;
  last_error: string | null;
}

export interface ZenProbeRecord {
  endpoint_id: number;
  machine_id: number;
  host: string;
  reachable: boolean;
  effective_port: number | null;
  build_version: string | null;
  error_message: string | null;
  probe_id: number | null;
}

export interface ZenProbeReport {
  probed: number;
  reachable: number;
  unreachable: number;
  probes: ZenProbeRecord[];
}

export interface ZenCacheStatsRecord {
  endpoint_id: number;
  machine_id: number;
  host: string;
  providers: string[];
  records: number;
  error_message: string | null;
}

export interface ZenCacheStatsReport {
  endpoints: number;
  rows_inserted: number;
  partial_errors: number;
  samples: ZenCacheStatsRecord[];
}

export interface ZenDetectBinaryMachineResult {
  machine_id: number;
  hostname: string;
  ip: string;
  ok: boolean;
  install_record_written: boolean;
  install_record_cleared: boolean;
  intree_records_written: number;
  baseline_new_rows: number;
  intree_ref_rows: number;
  warnings: string[];
  error_message: string | null;
}

export interface ZenDetectBinaryReport {
  machines: number;
  ok: number;
  failed: number;
  results: ZenDetectBinaryMachineResult[];
}

export interface ZenRegisterInput {
  machine_id: number;
  declared_port: number;
  scheme: string;
  role: string;
  upstream_endpoint_id?: number | null;
  data_dir: string;
  httpserverclass: string;
  lifecycle?: string | null;
  /** `{ZenInstall}` — see `ZenEndpoint.install_dir`. */
  install_dir?: string | null;
  /** See `ZenEndpoint.config_path_override`. */
  config_path_override?: string | null;
}

export interface ZenRegisterOutcome {
  endpoint_id: number;
  inserted: boolean;
  machine_id: number;
  declared_port: number;
  scheme: string;
  role: string;
  upstream_endpoint_id: number | null;
  lifecycle_mode: string;
  httpserverclass: string;
  data_dir: string;
  install_dir: string | null;
  config_path_override: string | null;
}

export interface ZenUnregisterPlan {
  operation: string;
  endpoint_id: number;
  machine_id: number;
  declared_port: number;
  role: string;
}

export interface ZenUnregisterSummary {
  endpoint_id: number;
  machine_id: number;
  action: string;
}

/** serde(untagged): plan or summary, structurally distinguished by `operation`. */
export type ZenUnregisterResult = ZenUnregisterPlan | ZenUnregisterSummary;

export interface ZenChangeRolePlan {
  operation: string;
  endpoint_id: number;
  machine_id: number;
  declared_port: number;
  current_role: string;
  current_upstream_endpoint_id: number | null;
  new_role: string;
  new_upstream_endpoint_id: number | null;
  lifecycle_mode: string;
}

export interface ZenChangeRoleSummary {
  endpoint_id: number;
  machine_id: number;
  previous_role: string;
  new_role: string;
  previous_upstream_endpoint_id: number | null;
  new_upstream_endpoint_id: number | null;
  action: string;
}

/** serde(tag = "outcome", rename_all = "snake_case"). */
export type ZenChangeRoleResult =
  | ({ outcome: "dry_run" } & ZenChangeRolePlan)
  | ({ outcome: "completed" } & ZenChangeRoleSummary);

export interface ZenLuaPreviewResult {
  endpoint_id: number;
  machine_id: number;
  lua: string;
}

export interface ZenCredentialInput {
  cred_alias?: string | null;
  user?: string | null;
  pass?: string | null;
}

export interface ZenApplyConfigPlan {
  operation: string;
  endpoint_id: number;
  machine_id: number;
  host: string;
  dest_path: string;
  lua: string;
}

export interface ZenApplyConfigSummary {
  endpoint_id: number;
  machine_id: number;
  host: string;
  dest_path: string;
  sha256: string;
  remote: unknown;
}

/** serde(untagged): plan (has `lua`) or summary (has `sha256`). */
export type ZenApplyConfigResult = ZenApplyConfigPlan | ZenApplyConfigSummary;

export interface ZenEnableGlobalResult {
  machine_id: number;
  host: string;
  ini_file: string;
  changed: boolean;
  warnings: string[];
}

export interface ZenServicePlan {
  operation: string;
  endpoint_id: number;
  machine_id: number;
  host: string;
  service_name: string;
  zen_exe_path?: string | null;
  config_path?: string | null;
  service_user?: string | null;
  service_pass_supplied?: boolean | null;
}

/** Result of `zen_create_dedicated_account` — the "创建专用账号" one-click flow. */
export interface ZenDedicatedAccountResult {
  machine_id: number;
  username: string;
  /** Opaque handle for `zenServiceInstall`'s `serviceCredAlias` — never the password. */
  cred_alias: string;
}

export interface ZenGcSettingsPlan {
  operation: string;
  endpoint_id: number;
  machine_id: number;
  host: string;
  dest_path: string;
  lua: string;
  will_restart_service: boolean;
}

export interface ZenGcSettingsSummary {
  endpoint_id: number;
  machine_id: number;
  host: string;
  dest_path: string;
  sha256: string;
  restarted: boolean;
  remote: unknown;
}

/** serde(untagged): plan (has `operation`) or summary (has `remote`). */
export type ZenGcSettingsResult = ZenGcSettingsPlan | ZenGcSettingsSummary;

export interface ZenServiceSummary {
  endpoint_id: number;
  machine_id: number;
  host: string;
  service_name: string;
  remote: unknown;
}

/** serde(untagged): plan (has `operation`) or summary (has `remote`). */
export type ZenServiceResult = ZenServicePlan | ZenServiceSummary;

export interface ZenServiceStatusResult {
  endpoint_id: number;
  machine_id: number;
  host: string;
  service_name: string;
  remote: unknown;
}

export interface ZenUrlaclPlan {
  operation: string;
  endpoint_id: number;
  machine_id: number;
  host: string;
  url_prefix: string;
  principal?: string | null;
}

export interface ZenUrlaclSummary {
  endpoint_id: number;
  machine_id: number;
  host: string;
  url_prefix: string;
  principal?: string | null;
  remote: unknown;
}

/** serde(untagged): plan (has `operation`) or summary (has `remote`). */
export type ZenUrlaclResult = ZenUrlaclPlan | ZenUrlaclSummary;

export interface ZenUrlaclListResult {
  machine_id: number;
  host: string;
  port_filter: string | null;
  remote: unknown;
}

export interface ZenVerifyRunEditorInput {
  machine_id: number;
  uproject_path: string;
  timeout_seconds?: number;
  expected_host?: string | null;
  expected_port?: number | null;
  expected_namespace?: string | null;
  cred?: ZenCredentialInput;
}

export interface ZenVerifyRulesResult {
  ok: boolean;
  ue_version: string;
  matched_rule_version: string;
  ue_install: string;
  policy: string;
  warnings: string[];
  rules?: unknown;
  verified_versions_after: string[];
  wrote: boolean;
  yaml_path?: string | null;
  message?: string | null;
  verify_outcome: unknown | null;
}

export interface ZenEndpoint {
  id: number | null;
  machine_id: number;
  declared_port: number;
  scheme: string;
  role: string;
  upstream_endpoint_id: number | null;
  data_dir: string;
  httpserverclass: string;
  lifecycle_mode: string;
  created_at: string | null;
  updated_at: string | null;
  /** `{ZenInstall}` — directory zenserver.exe + zen_config.lua live in.
   *  `null` means legacy derive-from-detected-binary behavior. */
  install_dir: string | null;
  /** `gc.intervalseconds` — full GC scan interval, in seconds. */
  gc_interval_seconds: number | null;
  /** `gc.lightweightintervalseconds` — lightweight GC scan interval, in seconds. */
  gc_lightweight_interval_seconds: number | null;
  /** `cache.maxdurationseconds` — max cache retention, in seconds. */
  cache_max_duration_seconds: number | null;
  /** Username of the tool-managed dedicated local service account, if any. */
  service_account_username: string | null;
  /** `SecretStore` alias holding that account's password. */
  service_account_cred_alias: string | null;
  /** Manual override for where zen_config.lua lands (takes precedence over install_dir). */
  config_path_override: string | null;
}

export interface ZenBinaryExpected {
  zen_build_version: string;
  binary_kind: string;
  sha256: string;
  locked_by: string | null;
  first_seen_at: string | null;
}
