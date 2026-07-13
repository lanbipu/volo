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

export interface EnsureOpenDirShareResponse {
  share_config_id: number;
  unc_path: string;
  created: boolean;
  client_results: InjectionResult[];
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
  ue_version_major: number | null;
  ue_version_minor: number | null;
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
  /** Per-machine UE version this location's own .uproject reported at discovery
   *  time — distinct from ProjectSummary.ue_version_*, which is a single,
   *  last-writer-wins value for the whole project. */
  ue_version_major: number | null;
  ue_version_minor: number | null;
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
  /** File mtime (RFC 3339 UTC); null for paks verified before this field existed. */
  modified_at: string | null;
}

/** One (project, machine) location where `list_deployed_ddc_paks` found a
 *  generated DDC pak. The frontend groups by `project_id` — see cacheDdcPak.tsx. */
export interface DeployedPakEntry {
  project_id: number;
  machine_id: number;
  pak_path: string;
  size_bytes: number;
  modified_at: string | null;
}

/** Thumbnail half of `get_project_thumbnail`: a same-name PNG next to the
 *  .uproject, or the Saved\auto_screenshot.png / Saved\autosequence_shot.png
 *  fallbacks. `from` is a raw key ("uproject_same_name" |
 *  "saved_auto_screenshot" | "saved_autosequence") — the frontend maps it to a
 *  human label, mirroring the PROBE_DICT/PROBE_NARRATIVE split in adapters.ts. */
export interface ProjectThumbnail {
  path: string;
  base64: string;
  from: string;
  /** Candidate file's last-write time (UTC RFC3339-ish) — proxy for "recently
   *  worked on", independent of `project_locations.discovered_at` (scan time). */
  mtime: string | null;
}

/** `get_project_thumbnail` result: thumbnail (if any) + project directory
 *  total size (null when unmeasurable) probed in one SSH round-trip. */
export interface ProjectProbe {
  thumbnail: ProjectThumbnail | null;
  size_bytes: number | null;
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

/* pso collect/list/distribute 旧链路 DTO 已随命令下线（表保留停写留档） */

/* ------------- pso warm-up & readiness (per-node -game runs) ------------- */
/** ok = 两段都跑完且验证段 hitch=0（唯一可给绿灯的状态）；not_ready = 跑完但验证段仍有 hitch（未达标，区别于 err=跑挂）；cancelled = 操作员手动取消（未验证）。 */
export type WarmupStatus = "running" | "ok" | "err" | "cancelled" | "not_ready";

export interface StartPsoWarmupRequest {
  project_id: number;
  target_machine_ids: number[];
  resolution_w: number;
  resolution_h: number;
  /** 必须 >= 1：0 会解除 watchdog，后端直接拒绝。 */
  max_minutes: number;
  /** nDisplay config path on the render node. */
  dc_cfg_path?: string | null;
  /** nDisplay node id, e.g. Node_0. */
  dc_node?: string | null;
  /** 默认 true：使用 -RenderOffscreen；false 使用 -fullscreen。 */
  offscreen?: boolean;
  /** Additional Unreal command-line args; empty strings are ignored by backend. */
  extra_args?: string[];
  /** 验证段时长（分钟），默认 2；预跑段跑满 max_minutes 后同参数再跑一段计 hitch。 */
  verify_minutes?: number;
  /** 启用 RC 遍历（两段都驱动舞台扫场）；省略/null = 固定机位。 */
  traversal?: TraversalRequest | null;
  /** 钉死各节点用的 UE 版本；省略 = 工程 EngineAssociation（major.minor）；工程无版本时才回退节点 primary。 */
  ue_version?: string | null;
}

/** RC 遍历参数（host 由后端按目标机填充；省略字段走后端默认）。 */
export interface TraversalRequest {
  /** 已加载地图包路径，如 /Game/InCamVFXBP/Maps/LED_CurvedStage。 */
  map_path: string;
  ws_port?: number | null;
  dwell_ms?: number | null;
  yaw_step_deg?: number | null;
  pitch_levels_deg?: number[] | null;
  /** 收敛采样间隔（秒），默认 30；「设置」子视图的「收敛窗口」写这里。 */
  probe_interval_secs?: number | null;
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
  mode: string;
  dc_node: string | null;
  driver_cache_growth_bytes: number | null;
  /** 预跑段 hitch 数（吸收量，信息性）；null = 仍在跑。 */
  hitch_count: number | null;
  /** 验证段 hitch 数——绿灯依据（0 = ready）；null = 未跑到验证段。 */
  verify_hitch_count: number | null;
  verify_duration_secs: number | null;
  /** 是否启用了 RC 遍历扫场。 */
  traversal: boolean;
  /** 预跑段是否以收敛提前完成（null = 未启用遍历或无结论）。 */
  converged: boolean | null;
  status: WarmupStatus;
  error_message: string | null;
  started_at: string | null;
  duration_secs: number | null;
}

export interface DriverCacheDirectorySnapshot {
  kind: string;
  path: string;
  exists: boolean;
  file_count: number;
  total_bytes: number;
  newest_mtime: string | null;
}

export interface DriverCacheSnapshot {
  id: number | null;
  machine_id: number;
  gpu_model: string | null;
  gpu_driver_version: string | null;
  interactive_user: string | null;
  node_last_boot_time: string | null;
  local_appdata_dxcache: DriverCacheDirectorySnapshot;
  locallow_per_driver_dxcache: DriverCacheDirectorySnapshot;
  total_file_count: number;
  total_bytes: number;
  newest_mtime: string | null;
  captured_at: string | null;
}

export interface DriverCacheClearStats {
  exists: boolean;
  file_count: number;
  total_bytes: number;
  newest_mtime: string | null;
}

export interface DriverCacheClearDirectoryResult {
  kind: string;
  path: string;
  before: DriverCacheClearStats;
  after: DriverCacheClearStats;
  cleared_file_count: number;
  cleared_bytes: number;
  failed_file_count: number;
  failed_bytes: number;
  residual_file_count: number;
  residual_bytes: number;
}

export interface DriverCacheClearResult {
  ok: boolean;
  message: string | null;
  residual_threshold_bytes: number;
  before_file_count: number;
  before_bytes: number;
  after_file_count: number;
  after_bytes: number;
  cleared_file_count: number;
  cleared_bytes: number;
  failed_file_count: number;
  failed_bytes: number;
  residual_file_count: number;
  residual_bytes: number;
  directories: DriverCacheClearDirectoryResult[];
}

export type PsoGreenlightStatus = "ok" | "degraded" | "none";

export type PsoInvalidationReason =
  | "gpu_driver_changed"
  | "cache_shrunk"
  | "cache_directory_missing"
  | "interactive_user_changed"
  | "node_rebooted";

export interface PsoInvalidationEvent {
  id: number | null;
  project_id: number;
  machine_id: number;
  warmup_run_id: number;
  driver_cache_snapshot_id: number;
  reason: PsoInvalidationReason;
  detail: string;
  detected_at: string | null;
}

export interface PsoStatusCell {
  project_id: number;
  machine_id: number;
  status: PsoGreenlightStatus;
  green_run_id: number | null;
  green_verified_at: string | null;
  baseline_snapshot_id: number | null;
  latest_snapshot_id: number | null;
  invalidation_reasons: PsoInvalidationEvent[];
}

export type StartPsoColdtestRequest = StartPsoWarmupRequest;

export interface PsoColdtestLaunched {
  machine_id: number;
  run_id: number;
  job_id: string | null;
  clear_result: DriverCacheClearResult | null;
  error_message: string | null;
}

export interface PsoColdtestJobResponse {
  job_id: string;
  runs: PsoColdtestLaunched[];
}

/** 每工程持久化的预跑设置（PSO Dashboard「设置」子视图）。extra_args 是空格分隔的单串（与
 *  StartPsoWarmupRequest.extra_args 的 string[] 之间调用方自己 split/join）；target_machine_ids
 *  是 JSON 数组文本（如 "[1,2,3]"），不是原生数组——后端表列是 TEXT，调用方自行 JSON.parse/stringify。 */
export interface PsoProjectSettings {
  project_id: number;
  /** "asset" | "manual" */
  dc_cfg_source: string;
  dc_cfg_asset: string | null;
  dc_cfg_manual_path: string | null;
  extra_args: string;
  offscreen: boolean;
  target_machine_ids: string;
  max_minutes: number;
  probe_interval_secs: number;
  /** 遍历引擎地图包路径；留空 = 该工程预跑不启用遍历（固定机位，行为不变）。 */
  map_path: string | null;
  /** nDisplay 集群节点 id（如 "Node_0"），传给 UE 的 -dc_node/-StageFriendlyName；必须与 dc_cfg
   *  指向的 .ndisplay 配置内定义的节点名一致，与配置文件路径无关。留空时调用方退回 "Node_0"。 */
  dc_node: string | null;
  updated_at: string | null;
}

export interface PsoConfigPreflightResult {
  machine_id: number;
  exists: boolean;
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
  cache_disk_size_bytes: number | null;
  error_message: string | null;
}

export interface ZenDiskSpaceResult {
  endpoint_id: number;
  machine_id: number;
  host: string;
  drive: string;
  total_bytes: number | null;
  free_bytes: number | null;
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

export interface ZenUpdateDeployConfigInput {
  endpoint_id: number;
  scheme: string;
  data_dir: string;
  httpserverclass: string;
  install_dir?: string | null;
  config_path_override?: string | null;
}

export interface ZenUpdateDeployConfigOutcome {
  endpoint_id: number;
  scheme: string;
  data_dir: string;
  httpserverclass: string;
  install_dir: string | null;
  config_path_override: string | null;
  install_dir_changed: boolean;
  data_dir_changed: boolean;
  previous_data_dir: string;
}

export interface ZenMigrateDataDirResult {
  endpoint_id: number;
  machine_id: number;
  host: string;
  dry_run: boolean;
  migrated: boolean;
  old_data_dir: string;
  new_data_dir: string;
  message: string;
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

/** `zen_read_local_runcontext` — 客户端本地 Zen 缓存目录的生效值真实回读。 */
export interface ZenLocalRunContext {
  machine_id: number;
  host: string;
  ue_runtime_user: string;
  /** false = 该机编辑器从未启动过本地 Zen（无 runcontext 文件）。 */
  found: boolean;
  /** 上次实际使用的持久化根目录 —— UE 全优先级链之后的生效值。 */
  data_path: string | null;
  executable: string | null;
  commandline_arguments: string | null;
  /** runcontext 指向的那个 zen 二进制现在是否在运行。 */
  running: boolean;
  /** HKCU Zen\DataPath 注册表覆盖（Volo「本地 Zen 缓存目录」的主写入通道，编辑器内迁移
   *  也写这里；压过 UE-ZenDataPath 环境变量）；best-effort：null = 不存在或读不到
   *  （该用户 hive 未加载）。 */
  registry_data_path: string | null;
}

/** `zen_set_local_datapath` — 设置 / 清除客户端本地 Zen 缓存目录。 */
export interface ZenSetLocalDataPathResult {
  machine_id: number;
  host: string;
  ue_runtime_user: string;
  /** null = 已清除（注册表覆盖 + 环境变量都清掉）。 */
  data_path: string | null;
  /** HKU\<SID> Zen\DataPath 注册表是否写入成功；false = 该用户未登录（hive 未加载），
   *  只落了机器级环境变量兜底 —— 该用户下次登录后才生效，而不是重启编辑器即生效。 */
  registry_written: boolean;
  message: string;
}

/** `zen_local_port_set` / `zen_local_port_clear` — 本地 Zen DesiredPort 覆盖写入结果。 */
export interface ZenLocalPortApply {
  machine_id: number;
  host: string;
  ini_file: string;
  /** false = INI 已处于目标状态（幂等无写入）。 */
  changed: boolean;
  previous_port: number | null;
  /** null = 已清除覆盖（恢复 UE 默认 8558）。 */
  port: number | null;
  /** PS sidecar 的 .bak.<timestamp> 备份路径；无写入时为 null。 */
  backup: string | null;
}

/** `zen_local_port_status` — 配置端口（INI）+ 实际运行端口（runcontext）合并视图。 */
export interface ZenLocalPortStatus {
  machine_id: number;
  host: string;
  ue_runtime_user: string;
  ini_file: string;
  /** [Zen.AutoLaunch] DesiredPort；null = 无覆盖（UE 默认 8558 生效）。 */
  configured_port: number | null;
  /** 本地 Zen 当前是否在运行；null = runcontext 读不到（离线 / 从未启动）。 */
  running: boolean | null;
  /** 实际启动命令行里的 --port 值；编辑器重启前可能滞后于配置值；null = 未知。 */
  actual_port: number | null;
  /** 本机 shared_upstream 端点的 declared_port；本地端口必须避开它。 */
  shared_upstream_port: number | null;
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

/* ====================== mesh visual (M2 visual-BA) ======================
   Source of truth: src-tauri/src/commands/mesh_visual.rs + crates/mesh-app
   (visual.rs / export.rs) + crates/volo-shared/src/dto.rs. No UI consumes
   these yet (M2 UI pending Claude Design handoff) — see meshVisualCommands.ts. */

export interface WarningDto {
  code: string;
  message: string;
  cabinet?: string | null;
}

export interface CabinetPoseSummary {
  cabinet_id: string;
  position_mm: [number, number, number];
  normal: [number, number, number];
  reprojection_rms_px: number;
  observed_views: number;
  quality: string;
}

export interface VisualReconstructResult {
  screen_id: string;
  pose_report_path: string;
  cabinet_count: number;
  ba_rms_px: number;
  ba_observations_total: number;
  ba_observations_used: number;
  ba_rejected: number;
  procrustes_align_rms_m: number;
  /** "file" | "auto_self_calibrated" */
  intrinsics_source: string;
  warnings: WarningDto[];
  cabinets: CabinetPoseSummary[];
}

export interface CalibrateResult {
  intrinsics_path: string;
  reproj_error_px: number;
  frames_used: number;
  /** "radial2" | "full" */
  distortion_model: string;
  focal_stddev_px?: [number, number] | null;
  pp_stddev_px?: [number, number] | null;
  warnings: WarningDto[];
}

export interface GeneratePatternResult {
  output_dir: string;
  cabinet_count: number;
  total_markers: number;
  warnings: WarningDto[];
}

export interface GenerateStructuredLightResult {
  output_dir: string;
  n_dots: number;
  n_frames: number;
}

export interface DecodeStructuredLightResult {
  output_path: string;
  n_dots_decoded: number;
}

export interface SimulateResult {
  dataset_dir: string;
  n_views: number;
  n_observations: number;
  seed: number;
}

export interface EvalResult {
  method: string;
  max_size_error_mm: number;
  rms_size_error_mm: number;
  max_distance_error_mm: number;
  max_angle_error_deg: number;
  holdout_rms_mm: number | null;
  holdout_p95_mm: number | null;
  holdout_max_mm: number | null;
  seeds: number[];
}

export interface CabinetSizeCheck {
  cabinet_id: string;
  size_error_mm: number;
  pass: boolean;
}

export interface PairCheck {
  a: string;
  b: string;
  distance_error_mm: number;
  angle_error_deg: number;
  distance_pass: boolean;
  angle_pass: boolean;
}

export interface CompareKnownResult {
  cabinets: CabinetSizeCheck[];
  pairs: PairCheck[];
  passed: boolean;
  thresholds: Record<string, number>;
}

export interface CaptureStation {
  id: string;
  position_mm: [number, number, number];
  look_at_mm: [number, number, number];
  standoff_mm: number;
  height_mm: number;
  role: string;
  covers_cabinets: [number, number][];
}

export interface CabinetCoverage {
  col: number;
  row: number;
  p95_residual_mm: number | null;
  n_views: number;
  total_observations: number;
  reconstructable: boolean;
  low_observation: boolean;
  bridged: boolean;
  pass: boolean;
  /** "low_coverage" | "low_parallax", null when the cabinet passes. */
  fail_reason?: string | null;
}

export interface UnreachableRegion {
  cabinets: [number, number][];
  reason: string;
}

export interface CapturePlan {
  stations: CaptureStation[];
  coverage: CabinetCoverage[];
  unreachable_regions: UnreachableRegion[];
  all_pass: boolean;
  target_p95_residual_mm: number;
}

export interface CaptureCardResult {
  html_content: string;
}

/** `frame.gauge_strategy` — "fix_root_cabinet" (legacy) | "align_to_nominal". */
export type PoseReportGauge = "fix_root_cabinet" | "align_to_nominal";

export interface PoseReportFrame {
  gauge_strategy: PoseReportGauge;
}

export interface CabinetPoseEntry {
  cabinet_id: string;
  /** World-frame corners in mm, order BL,BR,TR,TL. */
  corners_mm: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]];
  covariance_mm2?: [[number, number, number], [number, number, number], [number, number, number]] | null;
}

export interface CabinetPoseReportFile {
  schema_version: string;
  frame: PoseReportFrame;
  cabinet_poses: CabinetPoseEntry[];
}

export interface ExportPoseObjResult {
  target: string;
  cabinet_count: number;
  /** Merged mode: single OBJ path. `--split` mode: output directory. */
  file: string;
  /** `--split` mode: per-cabinet OBJ paths. Empty in merged mode. */
  files: string[];
}

/** Tauri event `mesh-visual-progress` payload. `event` is the adapter's raw
 *  tagged union (`{event: "progress"|"warning"|"result"|"error"|"unknown", ...}`),
 *  forwarded verbatim — see mesh-adapter-visual-ba::ipc::Event. */
export interface MeshVisualProgressPayload {
  job_id: string;
  event: unknown;
}

/** Tauri event `mesh-visual-reconstruct-done` payload — exactly one of
 *  `result` / `error` is set. */
export interface MeshVisualReconstructDonePayload {
  job_id: string;
  result: VisualReconstructResult | null;
  error: string | null;
}

export interface MeshVisualJobResponse {
  job_id: string;
}

/* ----------------------------- W6 R1: M1+M2 fuse ----------------------------- */

/** Per-anchor alignment residual (mm) — one row per matched grid-vertex point. */
export interface FuseAnchorResidual {
  /** Grid-vertex point name shared by both sides, e.g. "MAIN_V001_R001". */
  point_name: string;
  residual_mm: number;
  delta_mm: [number, number, number];
}

/** `mesh_fuse_run` 结果:视觉重建(M2 cabinet_pose_report)对齐到全站仪
 *  测点(M1 measured.yaml)的刚体/相似变换 + 逐锚点残差。 */
export interface FuseResult {
  screen_id: string;
  /** 参与配准的锚点数(两侧按 grid-vertex 命名匹配上的点)。 */
  anchor_count: number;
  /** 3×3 旋转矩阵(行主序)。 */
  rotation: [[number, number, number], [number, number, number], [number, number, number]];
  translation_mm: [number, number, number];
  /** 相似变换缩放因子。`scale_locked=true` 时恒为 1.0。 */
  scale: number;
  /** `allowScale` 未传时为 true(scale 锁 1.0,不吸收系统性误差)。 */
  scale_locked: boolean;
  anchor_residuals: FuseAnchorResidual[];
  anchor_rms_mm: number;
  /** 对齐后的 cabinet_pose_report 副本路径(全部角点 + 协方差已变换)。 */
  fused_pose_report_path: string;
}

/* ====================== mesh core (W2: Calibrate M1 接线) ======================
   Source of truth: src-tauri/src/commands/mesh_{projects,reconstruct,total_station,
   measurements,export}.rs + crates/volo-shared/src/dto.rs + crates/mesh-core.
   See ./meshCommands for the command wrappers. */

export interface RecentProject {
  id: number;
  abs_path: string;
  display_name: string;
  last_opened_at: string;
}

/** `project.yaml` 顶层结构。`method`/`pixels_per_cabinet`/`bottom_completion` 省略时为 null。 */
export interface ProjectConfig {
  project: ProjectMeta;
  /** Keyed by screen_id, e.g. "MAIN". */
  screens: Record<string, ScreenConfig>;
  coordinate_system: CoordinateSystemConfig;
  output: OutputConfig;
}

export interface ProjectMeta {
  name: string;
  unit: string;
  /** "m1" | "m2", null when not yet chosen. */
  method?: SurveyMethod | null;
}

export type SurveyMethod = "m1" | "m2";

export interface ScreenConfig {
  /** [cols, rows] — cabinet grid dimensions (vertex grid is (cols+1)×(rows+1)). */
  cabinet_count: [number, number];
  cabinet_size_mm: [number, number];
  pixels_per_cabinet?: [number, number] | null;
  shape_prior: ShapePriorConfig;
  shape_mode: ShapeMode;
  /** Cabinet-indexed [col, row] pairs explicitly absent from the array. */
  irregular_mask: [number, number][];
  bottom_completion?: BottomCompletionConfig | null;
  /** World-space placement for multi-screen stages. [0,0,0] on screens saved before this field existed. */
  position_m: [number, number, number];
  /** Rotation about the world Y (up) axis, in degrees. 0 on screens saved before this field existed. */
  yaw_deg: number;
  /** Bottom-edge height off the ground, mm. Extra world-Z translation; 0 on screens saved before this field existed. */
  height_offset_mm?: number;
}

export type ShapePriorConfig =
  | { type: "flat" }
  | { type: "curved"; radius_mm: number; fold_seams_at_columns: number[] }
  | { type: "folded"; fold_seams_at_columns: number[] }
  /** Symmetric arc: a flat center span, then a constant per-column turn angle accumulating outward on both sides. */
  | { type: "arc"; center_flat_cols: number; angle_per_col_deg: number }
  /** Two straight legs meeting at one corner; right_cols = total_cols - left_cols - soften_cols (derived, not stored). */
  | { type: "l_shape"; left_cols: number; soften_cols: number; corner_angle_deg: number }
  /** Two symmetric corners (a center span flanked by two equal wings). */
  | { type: "u_shape"; wing_cols: number; soften_cols: number; corner_angle_deg: number }
  /** Explicit column-run segments; segment `cols` must sum to the screen's total column count. */
  | { type: "custom_segments"; segments: ShapeSegment[] };

export interface ShapeSegment {
  cols: number;
  cum_angle_deg: number;
}

export type ShapeMode = "rectangle" | "irregular";

export interface BottomCompletionConfig {
  lowest_measurable_row: number;
  fallback_method: string;
  assumed_height_mm: number;
}

/** Point NAMES (e.g. "MAIN_V001_R001"), not cabinet grid cells — see
 *  crates/mesh-core/src/reconstruct/nominal.rs point-naming convention
 *  ({screen}_V{col+1:03}_R{row+1:03}, col/row are VERTEX indices). */
export interface CoordinateSystemConfig {
  origin_point: string;
  x_axis_point: string;
  xy_plane_point: string;
}

export interface OutputConfig {
  target: string;
  obj_filename: string;
  weld_vertices_tolerance_mm: number;
  triangulate: boolean;
}

export interface ReconstructionResult {
  run_id: number;
  surface: ReconstructedSurface;
  report_json_path: string;
}

export interface ReconstructionRun {
  id: number;
  screen_id: string;
  method: string;
  estimated_rms_mm: number | null;
  vertex_count: number;
  target: string | null;
  output_obj_path: string | null;
  created_at: string;
  /** Explicit "pinned as current" flag; absent/false → caller falls back to newest by created_at. */
  is_current: boolean;
}

export interface ReconstructionReport {
  surface: ReconstructedSurface;
  quality_metrics: QualityMetrics;
  project_path: string;
  screen_id: string;
  measurements_path: string;
  created_at: string;
  cabinet_array: CabinetArray;
  weld_tolerance_mm: number;
  /** Scatter 路径的拟合元数据；grid 路径为 null。未在 UI 消费，类型从简。 */
  scatter_fit?: unknown;
}

export interface GridTopology {
  cols: number;
  rows: number;
}

/** Per-vertex measurement provenance. Empty array = "unknown" (legacy surface), NOT "all measured". */
export type VertexProvenance = "measured" | "interpolated" | "extrapolated";

export interface QualityMetrics {
  method: string;
  middle_max_dev_mm: number;
  middle_mean_dev_mm: number;
  measured_count: number;
  expected_count: number;
  missing: string[];
  outliers: string[];
  /** null when no holdout residual exists (exact interpolators, or below MIN_MEASURED_FOR_CV_STATS). */
  estimated_rms_mm: number | null;
  estimated_p95_mm: number | null;
  extrapolated_count: number;
  warnings: string[];
}

export interface ReconstructedSurface {
  screen_id: string;
  topology: GridTopology;
  /** (cols+1)×(rows+1) vertices, row-major, meters. */
  vertices: [number, number, number][];
  uv_coords: [number, number][];
  quality_metrics: QualityMetrics;
  scatter_fit?: unknown;
  /** Parallel to `vertices`; empty = provenance unknown (pre-M1 surface). */
  vertex_provenance: VertexProvenance[];
}

export interface CabinetArray {
  cols: number;
  rows: number;
  cabinet_size_mm: [number, number];
  absent_cells: [number, number][];
}

/** `{ isotropic: sigma_mm }` (total-station) | `{ covariance: 3×3 row-major matrix }` (visual BA). */
export type Uncertainty = { isotropic: number } | { covariance: [[number, number, number], [number, number, number], [number, number, number]] };

/** `"total_station"` (unit variant) | `{ visual_ba: { camera_count } }` (struct variant). */
export type PointSource = "total_station" | { visual_ba: { camera_count: number } };

export interface MeasuredPoint {
  /** Grid vertex name, e.g. "MAIN_V001_R005". */
  name: string;
  /** Model-frame position, meters. */
  position: [number, number, number];
  uncertainty: Uncertainty;
  source: PointSource;
}

export interface CoordinateFrame {
  origin_world: [number, number, number];
  /** Columns: X, Y, Z (world frame). */
  basis: [[number, number, number], [number, number, number], [number, number, number]];
}

export interface MeasuredPoints {
  screen_id: string;
  coordinate_frame: CoordinateFrame;
  cabinet_array: CabinetArray;
  shape_prior: ShapePriorConfig | "flat";
  points: MeasuredPoint[];
  sampling_mode: "grid" | "scatter";
}

export interface TotalStationImportResult {
  /** Relative to project_abs_path, e.g. "measurements/measured.yaml". */
  measurementsYamlPath: string;
  /** Relative to project_abs_path, e.g. "measurements/import_report.json". */
  reportJsonPath: string;
  measuredCount: number;
  fabricatedCount: number;
  outlierCount: number;
  missingCount: number;
  warnings: string[];
}

export interface InstructionCardResult {
  /** HTML string for iframe srcdoc rendering. */
  htmlContent: string;
}
