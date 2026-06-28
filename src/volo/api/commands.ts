/* Volo — Cache/UECM typed command bindings.
   One wrapper per registered `#[tauri::command]` (85 total). Arg keys are
   camelCase (Rust snake_case → JS camelCase); a struct/request input is passed
   whole under one camelCase key, its inner fields staying snake_case. Optional
   Rust params (`Option<T>`) are passed as explicit `null` when omitted.
   See ./types for the DTO shapes; ./invoke for the transport.

   UI 接入状态标注（goal: 对应 UI 没有的后端代码做上标注）——每条命令一个 marker：
     ✅ wired  —— 已接 live UI 数据/动作路径（真实 invoke 被消费）
     🔌 ui-sim —— 前端有对应 UI 入口（按钮/面板/流程），当前 runTask 模拟或读 mock，
                  待接真实 invoke（wire-target）
     📝 no-ui  —— 当前设计无对应 UI 承载点（后端-only 能力）；附原因，不强造 UI
   现状汇总：✅ 46 · 🔌 0 · 📝 39 = 85。 */
import { call } from "./invoke";
import type {
  Machine, MachineDetail, WinrmBootstrapResult, EchoResult,
  ScanResult, RefreshResult, CredentialRecord, CredentialKind,
  IniKey, WriteIniResponse, ScanInisRequest, ScanInisResponse, IniFinding, ScanRun,
  VerifyReport, DeployPlan, DeployStep, GpuMatrix, ConsistencyResult,
  ShareMode, CreateShareResponse, TeardownShareResult, InjectionResult, ShareConfig,
  ProjectSummary, ProjectLocation, DiscoveryResult,
  BackendChoice, GenerateJobResponse, PakOutput, DistributeJobResponse,
  PsoCollectJobResponse, PsoCacheFile, DistributePsoCacheRequest, PsoDistributeJobResponse,
  RunHealthCheckRequest, HealthRunSummary, HealthCheckRow,
  ZenStatusRow, ZenProbeReport, ZenCacheStatsReport, ZenDetectBinaryReport, ZenEndpoint,
  ZenBinaryExpected, ZenRegisterInput, ZenRegisterOutcome, ZenUnregisterResult,
  ZenChangeRoleResult, ZenLuaPreviewResult, ZenCredentialInput, ZenApplyConfigResult,
  ZenServiceResult, ZenServiceSummary, ZenServiceStatusResult,
  ZenUrlaclResult, ZenUrlaclListResult, ZenVerifyRunEditorInput, ZenVerifyRulesResult,
} from "./types";

/* ----------------------------- machines ----------------------------- */
// ✅ wired: shell → loadCacheResources → window.RENDER_NODES（机器列表/总览）
export const listMachines = () => call<Machine[]>("list_machines");
// 📝 no-ui: 无手动添加机器入口（入网走 scan_network → add_discovered_machine）
export const addMachine = (hostname: string, ip: string) => call<number>("add_machine", { hostname, ip });
// ✅ wired: machineDetail「删除机器」+ MachineSection 批量删除 → deleteMachine(machineId) + reloadCache
export const deleteMachine = (id: number) => call<void>("delete_machine", { id });
// 📝 no-ui: 无重命名机器入口
export const renameMachine = (id: number, hostname: string) => call<void>("rename_machine", { id, hostname });
// ✅ wired: 机器详情抽屉 → getMachineDetail（异步填真实 UE 安装 / GPU）
export const getMachineDetail = (id: number) => call<MachineDetail>("get_machine_detail", { id });

/* ----------------------------- bootstrap / system ----------------------------- */
// ✅ wired: ScriptPanel → getWinrmBootstrapScript（异步加载真实脚本）
export const getWinrmBootstrapScript = () => call<string>("get_winrm_bootstrap_script");
// 📝 no-ui: 入网已改 SSH-key 现场（"后端不再远程推送"），WinRM bootstrap 被取代
export const bootstrapWinrm = (machineId: number, credentialAlias: string, enableLocalAccountRemoteAdmin: boolean) =>
  call<WinrmBootstrapResult>("bootstrap_winrm", { machineId, credentialAlias, enableLocalAccountRemoteAdmin });
// 📝 no-ui: PowerShell 桥诊断用，无 UI 承载点
export const testPowershellBridge = (message: string) => call<EchoResult>("test_powershell_bridge", { message });

/* ----------------------------- discovery ----------------------------- */
// ✅ wired: ScanWizard → scanNetwork（单 IP→/32，多目标 allSettled，剔除已纳管）
export const scanNetwork = (cidr: string) => call<ScanResult>("scan_network", { cidr });
// ✅ wired: ScanWizard confirmAdd → addDiscoveredMachine（逐 IP）+ reloadCache
export const addDiscoveredMachine = (ip: string, hostname?: string | null) =>
  call<number>("add_discovered_machine", { ip, hostname: hostname ?? null });
// ✅ wired: machineDetail「刷新」→ refreshMachine（软失败 = Ok+.error）+ reloadCache（注：MachineSection「刷新全部」串行阻塞，仍待接）
export const refreshMachine = (machineId: number) => call<RefreshResult>("refresh_machine", { machineId });

/* ----------------------------- credentials ----------------------------- */
// ✅ wired: shell → loadCacheResources → window.CREDS（凭据列表/DDC 选择器）
export const listCredentials = () => call<CredentialRecord[]>("list_credentials");
// ✅ wired: CredsPanel 新增凭据 → saveCredential（kind winrm/share + username/password 输入）+ reloadCache
export const saveCredential = (alias: string, kind: CredentialKind, username: string, password: string) =>
  call<number>("save_credential", { alias, kind, username, password });
// ✅ wired: CredsPanel 删除凭据 → deleteCredential(alias) + reloadCache
export const deleteCredential = (alias: string) => call<void>("delete_credential", { alias });

/* ----------------------------- env vars ----------------------------- */
// ✅ wired: cacheDdc 接入/退出共享 → setMachineEnvVar(UE-SharedDataCachePath)；本地 DDC 部署 → setMachineEnvVar(UE-LocalDataCachePath)
export const setMachineEnvVar = (machineId: number, name: string, value: string) =>
  call<void>("set_machine_env_var", { machineId, name, value });
// ✅ wired: machineDetail ⑥ → getMachineEnvVar(UE-Local/SharedDataCachePath) 异步读取
export const getMachineEnvVar = (machineId: number, name: string) =>
  call<string | null>("get_machine_env_var", { machineId, name });
// 📝 no-ui: 凭据变体，无 UI 入口
export const setMachineEnvVarWithCredential = (machineId: number, name: string, value: string, credentialAlias: string) =>
  call<void>("set_machine_env_var_with_credential", { machineId, name, value, credentialAlias });
// 📝 no-ui: 凭据变体，无 UI 入口
export const getMachineEnvVarWithCredential = (machineId: number, name: string, credentialAlias: string) =>
  call<string | null>("get_machine_env_var_with_credential", { machineId, name, credentialAlias });

/* ----------------------------- local cache ----------------------------- */
// ✅ wired: cacheDdc 本地 DDC 部署（单机/批量）→ createLocalCache 远端建目录+ACL，再 set UE-LocalDataCachePath
export const createLocalCache = (machineId: number, localPath: string) =>
  call<string>("create_local_cache", { machineId, localPath });

/* ----------------------------- ini editor ----------------------------- */
// ✅ wired: machineDetail ⑥ → readIniSection(DefaultEngine.ini,[StorageServers])（路径从工程 location 推）
export const readIniSection = (machineId: number, filePath: string, section: string) =>
  call<IniKey[]>("read_ini_section", { machineId, filePath, section });
// ✅ wired: cacheZen ② 客户端指向 → setIniKey 写 [StorageServers] Shared
export const setIniKey = (machineId: number, filePath: string, section: string, name: string, value: string) =>
  call<WriteIniResponse>("set_ini_key", { machineId, filePath, section, name, value });
// ✅ wired: cacheDdc 接入共享 → 写工程 [DerivedDataBackendGraph] Shared 的 Path/EnvPathOverride（不写 EnvPathOverride 时 UE 会忽略 UE-SharedDataCachePath）
export const setMachineBackendField = (machineId: number, filePath: string, section: string, nodeName: string, field: string, value: string) =>
  call<string>("set_machine_backend_field", { machineId, filePath, section, nodeName, field, value });
// 📝 no-ui: 凭据变体，无 UI 入口
export const readIniSectionWithCredential = (machineId: number, filePath: string, section: string, credentialAlias: string) =>
  call<IniKey[]>("read_ini_section_with_credential", { machineId, filePath, section, credentialAlias });
// 📝 no-ui: 凭据变体，无 UI 入口
export const setIniKeyWithCredential = (machineId: number, filePath: string, section: string, name: string, value: string, credentialAlias: string) =>
  call<WriteIniResponse>("set_ini_key_with_credential", { machineId, filePath, section, name, value, credentialAlias });

/* ----------------------------- ini scanner ----------------------------- */
// ✅ wired: Overview「立即巡检」并行 scanInis（后端改 async）→ INI 诊断真实数据
export const scanInis = (request: ScanInisRequest) => call<ScanInisResponse>("scan_inis", { request });
// 📝 no-ui: 无「按 scan run 查 findings」的 UI
export const listFindingsForRun = (scanRunId: number) => call<IniFinding[]>("list_findings_for_run", { scanRunId });
// ✅ wired: loadIni → toIniVMs（携真实 findingId）
export const listFindings = (scanRunId: number) => call<IniFinding[]>("list_findings", { scanRunId });
// ✅ wired: loadIni 取最近 INI scan run → 诊断面板
export const listRecentIniRuns = (limit: number) => call<ScanRun[]>("list_recent_ini_runs", { limit });
// 📝 no-ui: 无扫描历史 UI
export const listScanRuns = (scanType: string, limit: number) => call<ScanRun[]>("list_scan_runs", { scanType, limit });
// 📝 no-ui: 无单条 finding 详情 UI
export const getFinding = (findingId: number) => call<IniFinding | null>("get_finding", { findingId });
// ✅ wired: Overview INI「修复」fixIni → applyFinding（后端改 async；真实 findingId + 备份）
export const applyFinding = (findingId: number, credentialAlias: string) => call<string>("apply_finding", { findingId, credentialAlias });
// 📝 no-ui: 无「跳过 finding」按钮
export const skipFinding = (findingId: number) => call<void>("skip_finding", { findingId });
// 📝 no-ui: 无 PSO 预缓存校验 UI
export const verifyPsoPrecaching = (request: ScanInisRequest) => call<ScanInisResponse>("verify_pso_precaching", { request });

/* ----------------------------- gc ----------------------------- */
// 📝 no-ui: 无 DDC GC 控制 UI
export const gcPause = (machineId: number, projectId: number) => call<string>("gc_pause", { machineId, projectId });
// 📝 no-ui: 无 DDC GC 控制 UI
export const gcResume = (machineId: number, projectId: number, unusedFileAge: number) =>
  call<string>("gc_resume", { machineId, projectId, unusedFileAge });
// 📝 no-ui: 无 Zen GC 控制 UI
export const zenGcPause = (machineId: number, projectId: number) => call<string>("zen_gc_pause", { machineId, projectId });
// 📝 no-ui: 无 Zen GC 控制 UI
export const zenGcResume = (machineId: number, projectId: number, gcSeconds: number) =>
  call<string>("zen_gc_resume", { machineId, projectId, gcSeconds });

/* ----------------------------- batch ----------------------------- */
// 📝 no-ui: 无批量写环境变量 UI
export const batchSetEnvVar = (machineIds: number[], name: string, value: string, credentialAlias: string) =>
  call<void>("batch_set_env_var", { machineIds, name, value, credentialAlias });
// 📝 no-ui: 无批量写 ini UI
export const batchSetIniKey = (machineIds: number[], filePath: string, section: string, name: string, value: string, credentialAlias: string) =>
  call<void>("batch_set_ini_key", { machineIds, filePath, section, name, value, credentialAlias });

/* ----------------------------- consistency / log verify ----------------------------- */
// 📝 no-ui: GPU 一致性 KPI 现由 get_gpu_consistency_matrix 服务；本命令是更重的实时跨机 drill（UE/RHI/驱动/renderstream），无专属 UI（需显式「深度一致性检查」动作；一台离线即整体 abort）
export const runConsistencyCheck = (hosts: string[], credentialAlias?: string | null) =>
  call<ConsistencyResult>("run_consistency_check", { hosts, credentialAlias: credentialAlias ?? null });
// 📝 no-ui: 无日志校验 UI
export const runLogVerify = (host: string, editorExe: string, project: string, timeout: number, credentialAlias?: string | null) =>
  call<VerifyReport>("run_log_verify", { host, editorExe, project, timeout, credentialAlias: credentialAlias ?? null });

/* ----------------------------- deploy ----------------------------- */
// 📝 no-ui: 无部署计划预览 UI（DDC 部署走 generate/distribute/zen 各自流程）
export const deployDdcPlanPreview = (plan: DeployPlan) => call<DeployStep[]>("deploy_ddc_plan_preview", { plan });
// 📝 no-ui: 无部署计划执行 UI
export const deployDdcRun = (plan: DeployPlan, stopOnFailure: boolean, credentialAlias?: string | null) =>
  call<void>("deploy_ddc_run", { plan, credentialAlias: credentialAlias ?? null, stopOnFailure });

/* ----------------------------- gpu consistency ----------------------------- */
// ✅ wired: Overview「GPU 一致性」KPI → loadCacheResources → window.GPU_MATRIX（cells/baseline）
export const getGpuConsistencyMatrix = () => call<GpuMatrix>("get_gpu_consistency_matrix");

/* ----------------------------- shares ----------------------------- */
// ✅ wired: cacheDdc deploySMB（共享名/本地路径/mode 表单）→ createShare + reloadCache
export const createShare = (
  hostMachineId: number, mode: ShareMode, shareName: string, localPath: string,
  operatorCredentialAlias?: string | null, svcUsername?: string | null,
) => call<CreateShareResponse>("create_share", {
  hostMachineId, mode, shareName, localPath,
  operatorCredentialAlias: operatorCredentialAlias ?? null, svcUsername: svcUsername ?? null,
});
// 📝 no-ui: 新 ZenServer 客户端走 set_ini_key；inject 属 SMB Mode-B（无当前 UI）
export const injectShareCredentialToClients = (shareConfigId: number, clientMachineIds: number[], operatorCredentialAlias?: string | null) =>
  call<InjectionResult[]>("inject_share_credential_to_clients", { shareConfigId, clientMachineIds, operatorCredentialAlias: operatorCredentialAlias ?? null });
// ✅ wired: shell → loadCacheResources → window.SHARES（已纳管共享列表）
export const listShares = () => call<ShareConfig[]>("list_shares");
// ✅ wired: cacheDdc deleteShare「取消服务器」（仅解除纳管）→ deleteShare(id,false) + reloadCache
export const deleteShare = (shareConfigId: number, alsoRemoveRemote: boolean) =>
  call<void>("delete_share", { shareConfigId, alsoRemoveRemote });
// ✅ wired: cacheDdc undeploySMB「取消该服务器部署」→ teardownShare(id, keepFiles=true)（Remove-SmbShare + Mode B Remove-LocalUser，保留文件夹）+ reloadCache
export const teardownShare = (shareConfigId: number, keepFiles: boolean) =>
  call<TeardownShareResult>("teardown_share", { shareConfigId, keepFiles });

/* ----------------------------- projects ----------------------------- */
// ✅ wired: shell → loadProjects → window.UE_PROJECTS（DDC PAK/PSO 工程列表）
export const listProjects = () => call<ProjectSummary[]>("list_projects");
// ✅ wired: loadProjects 每工程拉 location → machines[] / root / last
export const listProjectLocations = (projectId: number) => call<ProjectLocation[]>("list_project_locations", { projectId });
// ✅ wired: cacheDdc scanProjects/scanPso → discoverProjects（scope=all fan-out）+ reloadCache
export const discoverProjects = (machineId: number, searchRoots: string[], operatorCredentialAlias?: string | null) =>
  call<DiscoveryResult[]>("discover_projects", { machineId, searchRoots, operatorCredentialAlias: operatorCredentialAlias ?? null });
// 📝 no-ui: 无手动设工程位置 UI
export const setProjectLocation = (projectId: number, machineId: number, absPath: string, uprojectPath: string, manual: boolean) =>
  call<number>("set_project_location", { projectId, machineId, absPath, uprojectPath, manual });
// 📝 no-ui: 无删除工程 UI
export const deleteProject = (projectId: number) => call<void>("delete_project", { projectId });
// 📝 no-ui: 无删除工程位置 UI
export const deleteProjectLocation = (locationId: number) => call<void>("delete_project_location", { locationId });
// 📝 no-ui: 无手动建工程 UI（工程靠 discover 发现）
export const createProjectManual = (uprojectName: string, displayName?: string | null) =>
  call<number>("create_project_manual", { uprojectName, displayName: displayName ?? null });

/* ----------------------------- ddc pak ----------------------------- */
// ✅ wired: cacheDdc genPak → generateDdcPak('remote') via runStreamingCmd（ue-runner-progress + pak-verified）
export const generateDdcPak = (
  backend: BackendChoice, projectId: number,
  sourceMachineId?: number | null, localUprojectPath?: string | null, localEnginePath?: string | null,
  ueVersion?: string | null, operatorCredentialAlias?: string | null,
) => call<GenerateJobResponse>("generate_ddc_pak", {
  backend, sourceMachineId: sourceMachineId ?? null, projectId,
  localUprojectPath: localUprojectPath ?? null, localEnginePath: localEnginePath ?? null,
  ueVersion: ueVersion ?? null, operatorCredentialAlias: operatorCredentialAlias ?? null,
});
// 📝 no-ui: 任务抽屉无取消按钮
export const cancelUeJob = (jobId: string) => call<boolean>("cancel_ue_job", { jobId });
// ✅ wired: cacheDdc verifyPak → verifyPakOutput（not-found=后端抛错，非空态）
export const verifyPakOutput = (machineId: number, projectId: number, operatorCredentialAlias?: string | null) =>
  call<PakOutput>("verify_pak_output", { machineId, projectId, operatorCredentialAlias: operatorCredentialAlias ?? null });
// ✅ wired: cacheDdc distribute → distributeDdcPak via runStreamingCmd（pak-distribute-progress BatchEvent）
export const distributeDdcPak = (
  sourceMachineId: number, projectId: number, targetMachineIds: number[],
  namedShareUnc?: string | null, operatorCredentialAlias?: string | null, sourceSmbCredentialAlias?: string | null,
) => call<DistributeJobResponse>("distribute_ddc_pak", {
  sourceMachineId, projectId, targetMachineIds,
  namedShareUnc: namedShareUnc ?? null, operatorCredentialAlias: operatorCredentialAlias ?? null,
  sourceSmbCredentialAlias: sourceSmbCredentialAlias ?? null,
});

/* ----------------------------- pso ----------------------------- */
// ✅ wired: cacheDdc collectPso → startPsoCollection via runStreamingCmd（ue-runner-progress + pso-collect-finalized）
export const startPsoCollection = (
  sourceMachineId: number, projectId: number, resolutionW: number, resolutionH: number,
  windowed: boolean, maxMinutes: number, ueVersion?: string | null, operatorCredentialAlias?: string | null,
) => call<PsoCollectJobResponse>("start_pso_collection", {
  sourceMachineId, projectId, ueVersion: ueVersion ?? null, resolutionW, resolutionH,
  windowed, maxMinutes, operatorCredentialAlias: operatorCredentialAlias ?? null,
});
// ✅ wired: cacheDdc PSO 列表 → listPsoCacheFiles（按 psoProj 加载 + 收集后重载）
export const listPsoCacheFiles = (projectId: number, sourceMachineId?: number | null, gpuSignature?: string | null) =>
  call<PsoCacheFile[]>("list_pso_cache_files", { projectId, sourceMachineId: sourceMachineId ?? null, gpuSignature: gpuSignature ?? null });
// ✅ wired: cacheDdc distribute → distributePsoCache via runStreamingCmd（pso-distribute-progress；force_gpu_mismatch=false）
export const distributePsoCache = (request: DistributePsoCacheRequest) =>
  call<PsoDistributeJobResponse>("distribute_pso_cache", { request });

/* ----------------------------- health check ----------------------------- */
// ✅ wired: Overview「立即巡检」refreshScan → runHealthCheck（后端改 async 不冻 UI）+ 诊断面板真实数据
export const runHealthCheck = (request: RunHealthCheckRequest) => call<HealthRunSummary>("run_health_check", { request });
// ✅ wired: loadCacheResources 取最近 health run → 诊断面板
export const listRecentHealthRuns = (limit: number) => call<ScanRun[]>("list_recent_health_runs", { limit });
// ✅ wired: loadHealth → toHealthVMs（machine_results JSON 按 probe_keys 字典聚合）
export const listHealthResultsForRun = (scanRunId: number) => call<HealthCheckRow[]>("list_health_results_for_run", { scanRunId });

/* ----------------------------- zen ----------------------------- */
// ✅ wired: cacheZen 状态卡 → zenStatus（运行/停/不可达 + 版本/端口）
export const zenStatus = (machineId?: number | null) => call<ZenStatusRow[]>("zen_status", { machineId: machineId ?? null });
// ✅ wired: cacheZen 部署链路 step7 + 状态卡「探活」→ zenProbe（真实回读）
export const zenProbe = (machineId?: number | null, credAlias?: string | null, timeoutSeconds?: number | null) =>
  call<ZenProbeReport>("zen_probe", { machineId: machineId ?? null, credAlias: credAlias ?? null, timeoutSeconds: timeoutSeconds ?? null });
// ✅ wired: cacheZen 状态卡「缓存记录」→ zenCacheStats
export const zenCacheStats = (endpointId?: number | null, timeoutSeconds?: number | null) =>
  call<ZenCacheStatsReport>("zen_cache_stats", { endpointId: endpointId ?? null, timeoutSeconds: timeoutSeconds ?? null });
// ✅ wired: cacheZen 部署链路 step2（前置检查）→ zenDetectBinary
export const zenDetectBinary = (machineId?: number | null, credAlias?: string | null) =>
  call<ZenDetectBinaryReport>("zen_detect_binary", { machineId: machineId ?? null, credAlias: credAlias ?? null });
// ✅ wired: cacheZen loadStatus → zenListEndpoints（取 shared_upstream 端点）
export const zenListEndpoints = (machineId?: number | null) => call<ZenEndpoint[]>("zen_list_endpoints", { machineId: machineId ?? null });
// 📝 no-ui: 无 Zen 二进制基线 UI
export const zenBaselineList = (zenBuildVersion?: string | null, binaryKind?: string | null) =>
  call<ZenBinaryExpected[]>("zen_baseline_list", { zenBuildVersion: zenBuildVersion ?? null, binaryKind: binaryKind ?? null });
// 📝 no-ui: 无 Zen 基线锁定 UI
export const zenBaselineLock = (zenBuildVersion: string, binaryKind: string, lockedBy: string) =>
  call<void>("zen_baseline_lock", { zenBuildVersion, binaryKind, lockedBy });
// 📝 no-ui: 无 Zen 基线解锁 UI
export const zenBaselineUnlock = (zenBuildVersion: string, binaryKind: string) =>
  call<void>("zen_baseline_unlock", { zenBuildVersion, binaryKind });
// ✅ wired: cacheZen 部署链路 step1 → zenRegister（endpoint_id 串后续步骤）
export const zenRegister = (input: ZenRegisterInput) => call<ZenRegisterOutcome>("zen_register", { input });
// ✅ wired: cacheZen「卸载」链路 → zenUnregister
export const zenUnregister = (endpointId: number, confirmed: boolean, dryRun: boolean) =>
  call<ZenUnregisterResult>("zen_unregister", { endpointId, confirmed, dryRun });
// 📝 no-ui: 无 Zen 角色变更 UI
export const zenChangeRole = (endpointId: number, newRole: string, confirmed: boolean, dryRun: boolean, newUpstreamEndpointId?: number | null) =>
  call<ZenChangeRoleResult>("zen_change_role", { endpointId, newRole, newUpstreamEndpointId: newUpstreamEndpointId ?? null, confirmed, dryRun });
// 📝 no-ui: 无 zen.lua 预览 UI
export const zenLuaPreview = (endpointId: number) => call<ZenLuaPreviewResult>("zen_lua_preview", { endpointId });
// ✅ wired: cacheZen 部署链路 step3 → zenApplyConfig
export const zenApplyConfig = (endpointId: number, destPath: string, confirmed: boolean, dryRun: boolean, cred: ZenCredentialInput) =>
  call<ZenApplyConfigResult>("zen_apply_config", { endpointId, destPath, confirmed, dryRun, cred });
// ✅ wired: cacheZen 部署链路 step5 → zenServiceInstall（本地/域账号）
export const zenServiceInstall = (endpointId: number, confirmed: boolean, dryRun: boolean, cred: ZenCredentialInput, serviceUser?: string | null, servicePass?: string | null) =>
  call<ZenServiceResult>("zen_service_install", { endpointId, serviceUser: serviceUser ?? null, servicePass: servicePass ?? null, confirmed, dryRun, cred });
// ✅ wired: cacheZen 状态卡「卸载」→ zenServiceUninstall + zenUnregister
export const zenServiceUninstall = (endpointId: number, confirmed: boolean, dryRun: boolean, cred: ZenCredentialInput) =>
  call<ZenServiceResult>("zen_service_uninstall", { endpointId, confirmed, dryRun, cred });
// ✅ wired: cacheZen 部署链路 step6 + 状态卡「启动」→ zenServiceStart
export const zenServiceStart = (endpointId: number, cred: ZenCredentialInput) =>
  call<ZenServiceSummary>("zen_service_start", { endpointId, cred });
// ✅ wired: cacheZen 状态卡「停止」→ zenServiceStop（preview 二次确认）
export const zenServiceStop = (endpointId: number, confirmed: boolean, dryRun: boolean, cred: ZenCredentialInput) =>
  call<ZenServiceResult>("zen_service_stop", { endpointId, confirmed, dryRun, cred });
// 📝 no-ui: 无 Zen 服务状态 UI
export const zenServiceStatus = (endpointId: number, cred: ZenCredentialInput) =>
  call<ZenServiceStatusResult>("zen_service_status", { endpointId, cred });
// ✅ wired: cacheZen 部署链路 step4 → zenUrlaclAdd（principal=服务账号）
export const zenUrlaclAdd = (endpointId: number, principal: string, confirmed: boolean, dryRun: boolean, cred: ZenCredentialInput) =>
  call<ZenUrlaclResult>("zen_urlacl_add", { endpointId, principal, confirmed, dryRun, cred });
// 📝 no-ui: 无 urlacl 列表 UI
export const zenUrlaclList = (machineId: number, cred: ZenCredentialInput, portFilter?: string | null) =>
  call<ZenUrlaclListResult>("zen_urlacl_list", { machineId, portFilter: portFilter ?? null, cred });
// 📝 no-ui: 无 urlacl 移除 UI
export const zenUrlaclRemove = (endpointId: number, confirmed: boolean, dryRun: boolean, cred: ZenCredentialInput) =>
  call<ZenUrlaclResult>("zen_urlacl_remove", { endpointId, confirmed, dryRun, cred });
// 📝 no-ui: 新 ZenServer 页用 set_ini_key 写 [StorageServers]，不用 verify_rules
export const zenVerifyRules = (ueVersion: string, ueInstall: string, writeVerified: boolean, runEditor?: ZenVerifyRunEditorInput | null) =>
  call<ZenVerifyRulesResult>("zen_verify_rules", { ueVersion, ueInstall, writeVerified, runEditor: runEditor ?? null });
