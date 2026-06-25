// Volo · Cache 控制台 —— 后端 DTO 类型
//
// 这些类型 1:1 对应 src-tauri/src/commands/*.rs 与 crates/cache-core 的 serde 序列化结果。
// 关键约定（实测，见命令契约目录）：
//  · 返回 DTO 字段一律 snake_case（crates 里所有 struct 都是 #[derive(Serialize)] 且无 rename_all）；
//    例外是带 #[serde(rename=...)] 的字段（ProjectDir.Path / .UProject 是 PascalCase）。
//  · enum 值的大小写见各自注释（lowercase / snake_case）。
//  · invoke() 的参数 key 是 camelCase（Tauri v2 默认转换）—— 见 commands.ts，不在本文件。

/* =========================== 机器 / 节点 =========================== */

export type MachineRole = "host" | "render" | "dev" | "editor" | "unknown";
export type MachineStatus = "online" | "offline" | "unknown";

export interface Machine {
  id: number | null;
  hostname: string;
  ip: string;
  role: MachineRole;
  status: MachineStatus;
  last_seen_at: string | null;
}

export type GpuVendor = "nvidia" | "amd" | "intel" | "unknown";

export interface GpuInfo {
  id: number | null;
  machine_id: number;
  gpu_model: string;
  driver_version: string;
  vendor: GpuVendor;
  vram_mb: number | null;
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

export interface MachineDetail {
  machine: Machine;
  ue_installs: UeInstall[];
  gpus: GpuInfo[];
}

// 对齐后端 crates/cache-core/src/core/network.rs::ProbedHost —— 只回端口探活结果，无 hostname。
export interface ProbedHost {
  ip: string;
  winrm_open: boolean; // 5985 — UECM 远程管理
  smb_open: boolean; // 445  — SMB ADMIN$ / 共享
  rpc_open: boolean; // 135  — DCE/RPC Endpoint Mapper
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

export interface WinrmBootstrapResult {
  ok: boolean;
  method: string;
  message: string;
  winrm_ok: boolean;
  changed: string[];
  manual_script: string | null;
}

/* =========================== 凭据 =========================== */

export type CredentialKind = "winrm" | "share";

export interface CredentialRecord {
  id: number | null;
  alias: string;
  kind: CredentialKind;
  username: string;
}

/* =========================== INI / 环境变量 =========================== */

export interface IniKey {
  name: string;
  value: string;
}
export interface WriteIniResponse {
  backup_path: string;
}

export type IniSeverity = "critical" | "warning" | "healthy" | "info";

export interface IniFinding {
  id: number | null;
  scan_run_id: number;
  machine_id: number;
  rule_id: string;
  severity: IniSeverity;
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

export interface IniScanSummary {
  scan_run_id: number;
  critical: number;
  warning: number;
  healthy: number;
  info: number;
  total_files: number;
}

export interface ScanInisResponse {
  scan_run_id: number;
  summary: IniScanSummary;
  findings: IniFinding[];
}

export interface ScanInisRequest {
  machine_ids: number[];
  credential_alias: string;
  project_paths: string[];
  user_profile_path?: string | null;
}

export interface ScanRun {
  id: number | null;
  scan_type: string;
  started_at: string | null;
  finished_at: string | null;
  machine_ids: number[];
  summary: unknown | null;
}

/* =========================== 共享 DDC =========================== */

export type ShareMode = "open" | "managed";

export interface ShareConfig {
  id: number | null;
  host_machine_id: number;
  share_name: string;
  unc_path: string;
  local_path: string;
  mode: ShareMode;
  credential_alias: string | null;
}

export interface CreateShareResponse {
  share_config_id: number;
  unc_path: string;
  mode: ShareMode;
  credential_alias: string | null;
}

export interface InjectionResult {
  client_machine_id: number;
  ok: boolean;
  message: string;
}

/* =========================== 项目 =========================== */

export interface ProjectSummary {
  id: number;
  uproject_name: string;
  display_name: string | null;
  uproject_guid: string | null;
  location_count: number;
}

export type DiscoveryStatus = "auto" | "manual_alias" | "manual_path";

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
  // core::project_discovery —— 字段以后端为准；接线时按返回核对
  [k: string]: unknown;
}

/* =========================== DDC Pak =========================== */

export type BackendChoice = "remote" | "local";

export interface GenerateJobResponse {
  job_id: string;
  source_machine_id: number;
  project_id: number;
  backend: string; // "remote" | "local"
}

export interface DistributePlanItem {
  target_machine_id: number;
  target_host: string;
  source_unc: string;
  target_local: string;
  file_name?: string;
  credential_user: string | null;
  source_smb_user: string | null;
  // credential_pass / source_smb_pass 带 #[serde(skip_serializing)]，前端拿不到
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

/* =========================== PSO 缓存 =========================== */

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
  named_share_unc?: string | null;
  operator_credential_alias?: string | null;
  source_smb_credential_alias?: string | null;
  force_gpu_mismatch: boolean;
}

export interface PsoDistributeJobResponse {
  job_id: string;
  plan: DistributePlanItem[];
}

/* =========================== 健康 / 一致性 / 部署 =========================== */

export type CheckStatus =
  | "healthy"
  | "warning"
  | "critical"
  | "offline"
  | "na"
  | "unknown";

export interface CheckOutcome {
  status: CheckStatus;
  message: string;
  sample: string;
  remediation: string;
}

export interface HealthCheckRow {
  scan_run_id: number;
  machine_id: number;
  // 自由形态 JSON map：key = 探测项名（ini_consistency / pso_precaching / gpu_consistency /
  // rs_service / zen_reachable / zen_* / tcp_* …），value = CheckOutcome
  machine_results: Record<string, CheckOutcome>;
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

export interface RunHealthCheckRequest {
  machine_ids: number[];
  credential_alias: string;
  project_paths: string[];
  expected_local_path?: string | null;
  expected_shared_path?: string | null;
}

export type CellStatus = "match" | "deviation" | "unknown";

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

export type DeployStepKind =
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

export interface DeployPlan {
  project_id: number;
  source_machine_id: number;
  target_machine_ids: number[];
  local_cache: { path: string; service_account?: string | null };
  shared_cache: {
    server_machine_id: number;
    share_name: string;
    server_path: string;
    mode: ShareMode;
    unc_path?: string | null;
  };
  ddc_pak: { enabled: boolean };
  pso: { enabled: boolean; resolution?: string | null; max_minutes?: number | null };
  verify: {
    run_log_verify: boolean;
    editor_exe?: string | null;
    timeout_seconds?: number | null;
  };
}

/* =========================== Zen 缓存服务 =========================== */

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
}

export interface ZenProbeRecord {
  endpoint_id: number;
  machine_id: number;
  host: string;
  reachable: boolean;
  effective_port?: number;
  build_version?: string;
  error_message?: string;
  probe_id?: number;
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
  error_message?: string;
}
export interface ZenCacheStatsReport {
  endpoints: number;
  rows_inserted: number;
  partial_errors: number;
  samples: ZenCacheStatsRecord[];
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
}

export interface ZenLuaPreviewResult {
  endpoint_id: number;
  machine_id: number;
  lua: string;
}

// cred 入参：SSH key 迁移后大多被忽略，但命令签名仍需传（可传 {}）
export interface ZenCredentialInput {
  cred_alias?: string;
  user?: string;
  pass?: string;
}

// 多个 Zen 破坏性命令返回 untagged plan|summary —— 用宽松类型，接线时按字段判别
export type ZenOpResult = Record<string, unknown>;
