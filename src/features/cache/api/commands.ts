// Volo · Cache 控制台 —— Tauri 命令封装
//
// 每个函数对应一个已注册的 #[tauri::command]。参数 key 用 camelCase（Tauri v2 默认把
// snake_case 函数参数转 camelCase）；struct 入参（request/input/cred/plan）整体作为一个
// key 传入，其内部字段保持 snake_case（见 types.ts）。
//
// 注入参数（State<Db> / State<UeJobRegistry> / AppHandle / Window）后端自动注入，前端不传。

import { invoke } from "@tauri-apps/api/core";
import type {
  Machine,
  MachineDetail,
  ScanResult,
  RefreshResult,
  WinrmBootstrapResult,
  CredentialRecord,
  CredentialKind,
  IniKey,
  WriteIniResponse,
  IniFinding,
  ScanInisRequest,
  ScanInisResponse,
  ScanRun,
  ShareConfig,
  ShareMode,
  CreateShareResponse,
  InjectionResult,
  ProjectSummary,
  ProjectLocation,
  DiscoveryResult,
  BackendChoice,
  GenerateJobResponse,
  DistributeJobResponse,
  PakOutput,
  PsoCollectJobResponse,
  PsoCacheFile,
  DistributePsoCacheRequest,
  PsoDistributeJobResponse,
  HealthCheckRow,
  HealthRunSummary,
  RunHealthCheckRequest,
  GpuMatrix,
  DeployPlan,
  DeployStepKind,
  ZenStatusRow,
  ZenEndpoint,
  ZenProbeReport,
  ZenCacheStatsReport,
  ZenRegisterInput,
  ZenRegisterOutcome,
  ZenLuaPreviewResult,
  ZenCredentialInput,
  ZenOpResult,
} from "./types";

/** 是否运行在 Tauri 宿主里（浏览器纯 vite dev 下为 false）。 */
export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/* =========================== 机器 / 节点 =========================== */
export const listMachines = () => invoke<Machine[]>("list_machines");
export const addMachine = (hostname: string, ip: string) =>
  invoke<number>("add_machine", { hostname, ip });
export const deleteMachine = (id: number) => invoke<void>("delete_machine", { id });
export const renameMachine = (id: number, hostname: string) =>
  invoke<void>("rename_machine", { id, hostname });
export const getMachineDetail = (id: number) =>
  invoke<MachineDetail>("get_machine_detail", { id });
export const scanNetwork = (cidr: string) => invoke<ScanResult>("scan_network", { cidr });
export const addDiscoveredMachine = (ip: string, hostname?: string) =>
  invoke<number>("add_discovered_machine", { ip, hostname });
export const refreshMachine = (machineId: number) =>
  invoke<RefreshResult>("refresh_machine", { machineId });
export const getWinrmBootstrapScript = () =>
  invoke<string>("get_winrm_bootstrap_script");
export const bootstrapWinrm = (
  machineId: number,
  credentialAlias: string,
  enableLocalAccountRemoteAdmin: boolean,
) =>
  invoke<WinrmBootstrapResult>("bootstrap_winrm", {
    machineId,
    credentialAlias,
    enableLocalAccountRemoteAdmin,
  });

/* =========================== 凭据 =========================== */
export const listCredentials = () => invoke<CredentialRecord[]>("list_credentials");
export const saveCredential = (
  alias: string,
  kind: CredentialKind,
  username: string,
  password: string,
) => invoke<number>("save_credential", { alias, kind, username, password });
export const deleteCredential = (alias: string) =>
  invoke<void>("delete_credential", { alias });

/* =========================== 环境变量 / INI 编辑 =========================== */
export const getMachineEnvVar = (machineId: number, name: string) =>
  invoke<string | null>("get_machine_env_var", { machineId, name });
export const setMachineEnvVar = (machineId: number, name: string, value: string) =>
  invoke<void>("set_machine_env_var", { machineId, name, value });
export const readIniSection = (machineId: number, filePath: string, section: string) =>
  invoke<IniKey[]>("read_ini_section", { machineId, filePath, section });
export const setIniKey = (
  machineId: number,
  filePath: string,
  section: string,
  name: string,
  value: string,
) => invoke<WriteIniResponse>("set_ini_key", { machineId, filePath, section, name, value });
export const batchSetEnvVar = (
  machineIds: number[],
  name: string,
  value: string,
  credentialAlias: string,
) => invoke<void>("batch_set_env_var", { machineIds, name, value, credentialAlias });
export const batchSetIniKey = (
  machineIds: number[],
  filePath: string,
  section: string,
  name: string,
  value: string,
  credentialAlias: string,
) =>
  invoke<void>("batch_set_ini_key", {
    machineIds,
    filePath,
    section,
    name,
    value,
    credentialAlias,
  });

/* =========================== INI 扫描 / 修复 =========================== */
export const scanInis = (request: ScanInisRequest) =>
  invoke<ScanInisResponse>("scan_inis", { request });
export const verifyPsoPrecaching = (request: ScanInisRequest) =>
  invoke<ScanInisResponse>("verify_pso_precaching", { request });
export const listFindings = (scanRunId: number) =>
  invoke<IniFinding[]>("list_findings", { scanRunId });
export const listFindingsForRun = (scanRunId: number) =>
  invoke<IniFinding[]>("list_findings_for_run", { scanRunId });
export const getFinding = (findingId: number) =>
  invoke<IniFinding | null>("get_finding", { findingId });
export const applyFinding = (findingId: number, credentialAlias: string) =>
  invoke<string>("apply_finding", { findingId, credentialAlias });
export const skipFinding = (findingId: number) =>
  invoke<void>("skip_finding", { findingId });
export const listRecentIniRuns = (limit: number) =>
  invoke<ScanRun[]>("list_recent_ini_runs", { limit });
export const listScanRuns = (scanType: string, limit: number) =>
  invoke<ScanRun[]>("list_scan_runs", { scanType, limit });

/* =========================== DDC 留存 / GC =========================== */
export const gcPause = (machineId: number, projectId: number) =>
  invoke<string>("gc_pause", { machineId, projectId });
export const gcResume = (machineId: number, projectId: number, unusedFileAge: number) =>
  invoke<string>("gc_resume", { machineId, projectId, unusedFileAge });
export const zenGcPause = (machineId: number, projectId: number) =>
  invoke<string>("zen_gc_pause", { machineId, projectId });
export const zenGcResume = (machineId: number, projectId: number, gcSeconds: number) =>
  invoke<string>("zen_gc_resume", { machineId, projectId, gcSeconds });

/* =========================== 共享 DDC =========================== */
export const createShare = (args: {
  hostMachineId: number;
  mode: ShareMode;
  shareName: string;
  localPath: string;
  operatorCredentialAlias?: string;
  svcUsername?: string;
}) => invoke<CreateShareResponse>("create_share", args);
export const listShares = () => invoke<ShareConfig[]>("list_shares");
export const injectShareCredentialToClients = (
  shareConfigId: number,
  clientMachineIds: number[],
  operatorCredentialAlias?: string,
) =>
  invoke<InjectionResult[]>("inject_share_credential_to_clients", {
    shareConfigId,
    clientMachineIds,
    operatorCredentialAlias,
  });
export const deleteShare = (shareConfigId: number, alsoRemoveRemote: boolean) =>
  invoke<void>("delete_share", { shareConfigId, alsoRemoveRemote });

/* =========================== 项目 =========================== */
export const listProjects = () => invoke<ProjectSummary[]>("list_projects");
export const listProjectLocations = (projectId: number) =>
  invoke<ProjectLocation[]>("list_project_locations", { projectId });
export const discoverProjects = (
  machineId: number,
  searchRoots: string[],
  operatorCredentialAlias?: string,
) =>
  invoke<DiscoveryResult[]>("discover_projects", {
    machineId,
    searchRoots,
    operatorCredentialAlias,
  });
export const setProjectLocation = (args: {
  projectId: number;
  machineId: number;
  absPath: string;
  uprojectPath: string;
  manual: boolean;
}) => invoke<number>("set_project_location", args);
export const createProjectManual = (uprojectName: string, displayName?: string) =>
  invoke<number>("create_project_manual", { uprojectName, displayName });
export const deleteProject = (projectId: number) =>
  invoke<void>("delete_project", { projectId });
export const deleteProjectLocation = (locationId: number) =>
  invoke<void>("delete_project_location", { locationId });

/* =========================== DDC Pak（长任务） =========================== */
export const generateDdcPak = (args: {
  backend: BackendChoice;
  sourceMachineId?: number;
  projectId: number;
  localUprojectPath?: string;
  localEnginePath?: string;
  ueVersion?: string;
  operatorCredentialAlias?: string;
}) => invoke<GenerateJobResponse>("generate_ddc_pak", args);
export const verifyPakOutput = (
  machineId: number,
  projectId: number,
  operatorCredentialAlias?: string,
) => invoke<PakOutput>("verify_pak_output", { machineId, projectId, operatorCredentialAlias });
export const distributeDdcPak = (args: {
  sourceMachineId: number;
  projectId: number;
  targetMachineIds: number[];
  namedShareUnc?: string;
  operatorCredentialAlias?: string;
  sourceSmbCredentialAlias?: string;
}) => invoke<DistributeJobResponse>("distribute_ddc_pak", args);
export const cancelUeJob = (jobId: string) => invoke<boolean>("cancel_ue_job", { jobId });

/* =========================== PSO 缓存（长任务） =========================== */
export const startPsoCollection = (args: {
  sourceMachineId: number;
  projectId: number;
  ueVersion?: string;
  resolutionW: number;
  resolutionH: number;
  windowed: boolean;
  maxMinutes: number;
  operatorCredentialAlias?: string;
}) => invoke<PsoCollectJobResponse>("start_pso_collection", args);
export const listPsoCacheFiles = (
  projectId: number,
  sourceMachineId?: number,
  gpuSignature?: string,
) =>
  invoke<PsoCacheFile[]>("list_pso_cache_files", {
    projectId,
    sourceMachineId,
    gpuSignature,
  });
export const distributePsoCache = (request: DistributePsoCacheRequest) =>
  invoke<PsoDistributeJobResponse>("distribute_pso_cache", { request });

/* =========================== 健康 / 一致性 / 部署 =========================== */
export const runHealthCheck = (request: RunHealthCheckRequest) =>
  invoke<HealthRunSummary>("run_health_check", { request });
export const listRecentHealthRuns = (limit: number) =>
  invoke<ScanRun[]>("list_recent_health_runs", { limit });
export const listHealthResultsForRun = (scanRunId: number) =>
  invoke<HealthCheckRow[]>("list_health_results_for_run", { scanRunId });
export const getGpuConsistencyMatrix = () =>
  invoke<GpuMatrix>("get_gpu_consistency_matrix");
export const deployDdcPlanPreview = (plan: DeployPlan) =>
  invoke<DeployStepKind[]>("deploy_ddc_plan_preview", { plan });
export const deployDdcRun = (
  plan: DeployPlan,
  stopOnFailure: boolean,
  credentialAlias?: string,
) => invoke<void>("deploy_ddc_run", { plan, credentialAlias, stopOnFailure });
// 一致性快照（host 级 UE/GPU/RHI/项目对齐）+ 启动日志校验。返回 [快照[], 不一致[]] 元组。
export const runConsistencyCheck = (hosts: string[], credentialAlias?: string) =>
  invoke<[unknown[], unknown[]]>("run_consistency_check", { hosts, credentialAlias });
export const runLogVerify = (
  host: string,
  editorExe: string,
  project: string,
  timeout: number,
  credentialAlias?: string,
) =>
  invoke<Record<string, unknown>>("run_log_verify", {
    host,
    editorExe,
    project,
    timeout,
    credentialAlias,
  });

/* =========================== Zen 缓存服务 =========================== */
export const zenStatus = (machineId?: number) =>
  invoke<ZenStatusRow[]>("zen_status", { machineId });
export const zenProbe = (machineId?: number, credAlias?: string, timeoutSeconds?: number) =>
  invoke<ZenProbeReport>("zen_probe", { machineId, credAlias, timeoutSeconds });
export const zenCacheStats = (endpointId?: number, timeoutSeconds?: number) =>
  invoke<ZenCacheStatsReport>("zen_cache_stats", { endpointId, timeoutSeconds });
export const zenListEndpoints = (machineId?: number) =>
  invoke<ZenEndpoint[]>("zen_list_endpoints", { machineId });
export const zenRegister = (input: ZenRegisterInput) =>
  invoke<ZenRegisterOutcome>("zen_register", { input });
export const zenLuaPreview = (endpointId: number) =>
  invoke<ZenLuaPreviewResult>("zen_lua_preview", { endpointId });
export const zenApplyConfig = (
  endpointId: number,
  destPath: string,
  confirmed: boolean,
  dryRun: boolean,
  cred: ZenCredentialInput = {},
) => invoke<ZenOpResult>("zen_apply_config", { endpointId, destPath, confirmed, dryRun, cred });
export const zenServiceInstall = (args: {
  endpointId: number;
  serviceUser?: string;
  servicePass?: string;
  confirmed: boolean;
  dryRun: boolean;
  cred?: ZenCredentialInput;
}) => invoke<ZenOpResult>("zen_service_install", { cred: {}, ...args });
export const zenServiceStart = (endpointId: number, cred: ZenCredentialInput = {}) =>
  invoke<ZenOpResult>("zen_service_start", { endpointId, cred });
export const zenUrlaclAdd = (
  endpointId: number,
  principal: string,
  confirmed: boolean,
  dryRun: boolean,
  cred: ZenCredentialInput = {},
) => invoke<ZenOpResult>("zen_urlacl_add", { endpointId, principal, confirmed, dryRun, cred });
export const zenDetectBinary = (machineId?: number, credAlias?: string) =>
  invoke<ZenOpResult>("zen_detect_binary", { machineId, credAlias });
export const zenBaselineList = (zenBuildVersion?: string, binaryKind?: string) =>
  invoke<unknown[]>("zen_baseline_list", { zenBuildVersion, binaryKind });
export const zenBaselineLock = (zenBuildVersion: string, binaryKind: string, lockedBy: string) =>
  invoke<void>("zen_baseline_lock", { zenBuildVersion, binaryKind, lockedBy });
export const zenBaselineUnlock = (zenBuildVersion: string, binaryKind: string) =>
  invoke<void>("zen_baseline_unlock", { zenBuildVersion, binaryKind });
export const zenUnregister = (endpointId: number, confirmed: boolean, dryRun: boolean) =>
  invoke<ZenOpResult>("zen_unregister", { endpointId, confirmed, dryRun });
export const zenChangeRole = (
  endpointId: number,
  newRole: string,
  confirmed: boolean,
  dryRun: boolean,
  newUpstreamEndpointId?: number,
) =>
  invoke<ZenOpResult>("zen_change_role", {
    endpointId,
    newRole,
    newUpstreamEndpointId,
    confirmed,
    dryRun,
  });
export const zenServiceUninstall = (
  endpointId: number,
  confirmed: boolean,
  dryRun: boolean,
  cred: ZenCredentialInput = {},
) => invoke<ZenOpResult>("zen_service_uninstall", { endpointId, confirmed, dryRun, cred });
export const zenServiceStop = (
  endpointId: number,
  confirmed: boolean,
  dryRun: boolean,
  cred: ZenCredentialInput = {},
) => invoke<ZenOpResult>("zen_service_stop", { endpointId, confirmed, dryRun, cred });
export const zenServiceStatus = (endpointId: number, cred: ZenCredentialInput = {}) =>
  invoke<ZenOpResult>("zen_service_status", { endpointId, cred });
export const zenUrlaclList = (machineId: number, cred: ZenCredentialInput = {}, portFilter?: string) =>
  invoke<ZenOpResult>("zen_urlacl_list", { machineId, portFilter, cred });
export const zenUrlaclRemove = (
  endpointId: number,
  confirmed: boolean,
  dryRun: boolean,
  cred: ZenCredentialInput = {},
) => invoke<ZenOpResult>("zen_urlacl_remove", { endpointId, confirmed, dryRun, cred });
export const zenVerifyRules = (
  ueVersion: string,
  ueInstall: string,
  writeVerified: boolean,
  runEditor?: unknown,
) => invoke<ZenOpResult>("zen_verify_rules", { ueVersion, ueInstall, writeVerified, runEditor });
