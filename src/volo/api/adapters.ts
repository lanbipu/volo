/* Volo — DTO → ViewModel adapters.
   The custom-CSS Cache page was built against richer mock shapes than the
   backend exposes (see CACHE-CAPABILITIES.md · "后端无此指标"). These mappers
   project the real `Serialize` DTOs onto the shapes the page reads, filling
   fields the backend cannot provide with safe placeholders ("—" / null / "na")
   so no consumer crashes and no fabricated metric is invented. */
import type { Machine, CredentialRecord, ShareConfig, ShareMode, ProjectSummary, ProjectLocation, HealthCheckRow, IniFinding, UeRuntimeUserRow } from "./types";
/* Machine is referenced by toShareVM (host_machine_id → hostname reverse-lookup). */

/* ----------------------------- machine ----------------------------- */
/** Shape the Cache page reads off each node (RENDER_NODES element). */
export interface NodeVM {
  id: string;
  host: string;
  ip: string;
  status: "healthy" | "warning" | "critical" | "offline" | "na";
  roleKey: "shared" | "render" | "workstation" | "spare";
  role: string;
  last: string;
  chan: "winrm" | "ssh";
  /** per-machine cache metrics — backend exposes none, so null (UI shows "—"). */
  ddc: number | null;
  pso: number | null;
  health: number | null;
  gpu: string;
  vendor: string;
  driver: string;
  vram: string;
  ue: string;
  uePath: string;
  user: string;
  auth: string;
  domain: string;
  zen: string | null;
  share: string | null;
  proj: string[];
  tags: string[];
  cfg: null;
  /** 入网状态：后端 Machine DTO 无「待入网」字段，机器在库即视为受管 → 固定 'ready'
   *  （入网脚本仍可在机器列表逐台获取；无后端信号无法区分未入网机）。 */
  env: string;
  /** numeric machine id for backend calls (NodeVM.id is the string render key). */
  machineId: number;
}

function normalizeStatus(raw: string): NodeVM["status"] {
  const s = (raw || "").toLowerCase();
  if (s.includes("offline") || s === "off") return "offline";
  if (s.includes("crit") || s.includes("error") || s.includes("fail")) return "critical";
  if (s.includes("warn")) return "warning";
  if (s.includes("online") || s.includes("healthy") || s.includes("ok") || s === "up") return "healthy";
  return "na";
}

function normalizeRoleKey(raw: string): NodeVM["roleKey"] {
  const s = (raw || "").toLowerCase();
  if (s.includes("shared") || s.includes("upstream")) return "shared";
  if (s.includes("work") || s.includes("ws")) return "workstation";
  if (s.includes("spare")) return "spare";
  return "render";
}

export function toNodeVM(m: Machine, shares: ShareConfig[] = [], ueRuntimeUsers: UeRuntimeUserRow[] = []): NodeVM {
  const machineId = m.id ?? 0;
  const roleKey = normalizeRoleKey(m.role);
  /* 该机作为宿主托管的共享（share_configs.host_machine_id 命中）→ 机器详情「关联」
     段显示「共享 DDC 宿主」。客户端是否「已接入」靠机器详情⑥读 UE-SharedDataCachePath
     体现（那是异步逐机读，不放进同步的列表 VM）。 */
  const hosted = shares.find((s) => s.host_machine_id === machineId);
  /* 该机 UE 运行 Windows 用户（machine set-ue-user 设置）——cacheZen ②「用户全局」配置
     范围判断该机是否可写 UserEngine.ini 靠这个字段；未设置时占位 "—"（同其余空字段）。 */
  const ueUser = ueRuntimeUsers.find((r) => r.machine_id === machineId)?.ue_runtime_user;
  return {
    id: String(machineId),
    host: m.hostname,
    ip: m.ip,
    status: normalizeStatus(m.status),
    roleKey,
    role: m.role || roleKey,
    last: m.last_seen_at || "—",
    chan: "winrm",
    ddc: null,
    pso: null,
    health: null,
    gpu: "—",
    vendor: "—",
    driver: "—",
    vram: "—",
    ue: "—",
    uePath: "—",
    user: ueUser || "—",
    auth: "SSH 公钥",
    domain: "—",
    zen: null,
    share: hosted ? hosted.unc_path : null,
    proj: [],
    tags: [roleKey],
    cfg: null,
    env: "ready",
    machineId,
  };
}

/* ----------------------------- credential ----------------------------- */
/** Shape the CredsPanel + DDC cred selectors read (CREDS element). */
export interface CredVM {
  id: string;
  alias: string;
  name: string;
  kind: string;
  rawKind: "winrm" | "share";
  domain: string;
  use: string;
  machines: number;
  last: string;
}

export function toCredVM(c: CredentialRecord): CredVM {
  const isShare = c.kind === "share";
  return {
    id: String(c.id ?? 0),
    alias: c.alias,
    name: c.alias,
    kind: isShare ? "共享 DDC" : "WinRM",
    rawKind: c.kind,
    domain: "—",
    use: isShare ? "共享 DDC 创建 / 接入" : "远程执行",
    machines: 0,
    last: "—",
  };
}

/* ----------------------------- share ----------------------------- */
/** Shape the DDC legacy view reads (SHARES element). */
export interface ShareVM {
  id: string;
  shareConfigId: number;
  path: string;
  /** 宿主机器主机名（host_machine_id 反查 machines）；未命中机器列表时 "—"。 */
  host: string;
  /** 宿主机器渲染 id = String(host_machine_id)，与 NodeVM.id 对齐，供部署面板
   *  匹配「该服务器是否已部署共享」（srvShare = shares.find(hostId === srv)）。 */
  hostId: string;
  /** 原始共享模式，供 Mode B 凭据注入等逻辑判断。 */
  shareMode: ShareMode;
  mode: string;
  clients: number;
  size: string;
  status: "healthy" | "warning";
}

export function toShareVM(s: ShareConfig, machines: Machine[] = []): ShareVM {
  const hostM = machines.find((m) => (m.id ?? 0) === s.host_machine_id);
  return {
    id: String(s.id ?? 0),
    shareConfigId: s.id ?? 0,
    path: s.unc_path,
    host: hostM ? hostM.hostname : "—",
    hostId: String(s.host_machine_id),
    shareMode: s.mode,
    mode: s.mode === "open" ? "Mode A · 开放" : "Mode B · 专用账号",
    clients: 0,
    size: "—",
    status: "healthy",
  };
}

/* ----------------------------- project ----------------------------- */
/** Shape the DDC PAK / PSO views read (UE_PROJECTS element). The backend
 *  surfaces project identity (list_projects) + per-machine locations
 *  (list_project_locations). UE version comes from the parsed EngineAssociation
 *  (ue_version_major/minor；GUID 形关联无版本号 → "—"). `warn` comes from comparing
 *  each location's own per-machine ue_version_major/minor (see describeVersionDrift).
 *  size / pak-presence are not exposed by any command → "—" / false (TODO: 后端无源;
 *  DDC PAK 页面自己用 list_deployed_ddc_paks 反推准确的 hasPak，见 cacheDdcPak.tsx)。
 *  `machines` is String(machine_id)[] so it aligns with NodeVM.id (= String(id)). */
export interface ProjectVM {
  id: number;
  name: string;
  uproject: string;
  ue: string;
  size: string;
  root: string;
  last: string;
  machines: string[];
  primary: string | null;
  hasPak: boolean;
  warn: string | null;
  /** String(machine_id) → 该机上的工程目录 abs_path（每机独立，不要复用 root）。
   *  客户端写 [StorageServers] 时要用各机自己的路径。 */
  locByMachine: Record<string, string>;
}

/* ----------------------------- health ----------------------------- */
/** Canonical probe key → {人类标签, L1/L2/L3 层}. 源自后端 PROBE_REGISTRY
 *  (crates/cache-core/src/core/probe_keys.rs) —— layer/label 的唯一真相源在那。 */
const PROBE_DICT: Record<string, { label: string; layer: string }> = {
  tcp_5985: { label: "端口 5985 · WinRM", layer: "L1" },
  tcp_445: { label: "端口 445 · SMB", layer: "L1" },
  tcp_135: { label: "端口 135 · RPC", layer: "L1" },
  firewall_445: { label: "防火墙 445", layer: "L2" },
  local_account_token_filter: { label: "本地账户令牌过滤", layer: "L2" },
  long_paths_enabled: { label: "长路径支持", layer: "L2" },
  lanman_server: { label: "LanmanServer 服务", layer: "L2" },
  share_reachable: { label: "共享可达", layer: "L3" },
  ntfs_perm: { label: "NTFS 权限", layer: "L3" },
  cred_user: { label: "凭据 · 用户", layer: "L3" },
  cred_system: { label: "凭据 · 系统", layer: "L3" },
  env_vars: { label: "DDC 环境变量", layer: "L3" },
  env_local: { label: "本地缓存路径", layer: "L3" },
  env_shared: { label: "共享缓存路径", layer: "L3" },
  system_write: { label: "系统账户可写", layer: "L3" },
  winmgmt: { label: "WMI 服务", layer: "L3" },
  rs_service: { label: "RenderStream 服务", layer: "L3" },
  ini_consistency: { label: "INI 一致性", layer: "L3" },
  pso_precaching: { label: "PSO 预缓存", layer: "L3" },
  gpu_consistency: { label: "GPU 一致性", layer: "L3" },
  zen_reachable: { label: "Zen 可达", layer: "L3" },
  zen_version_consistent: { label: "Zen 版本一致", layer: "L3" },
  zen_binary_intact: { label: "Zen 程序完整", layer: "L3" },
  zen_cache_provider_ready: { label: "Zen 缓存 provider 就绪", layer: "L3" },
};

/* 面向用户的自然语言文案：诊断面板不该出现 probe key、端口号、服务名、英文 message
 *  或 L1/L2/L3 层级代号。这里给每个探测项一个「人话标题 + 这条出问题意味着什么」，
 *  替代后端英文 CheckOutcome.message 直显。技术名（PROBE_DICT.label）留作 tooltip。 */
const PROBE_NARRATIVE: Record<string, { label: string; hint: string }> = {
  tcp_5985: { label: "远程管理通道", hint: "连不上这台机器的远程管理通道，Volo 没法远程下发配置或采集状态。" },
  tcp_445: { label: "文件共享通道", hint: "文件共享通道不通，这台机器访问不了共享缓存盘。" },
  tcp_135: { label: "远程调用通道", hint: "远程调用通道不通，部分远程操作无法进行。" },
  firewall_445: { label: "文件共享防火墙", hint: "防火墙挡住了文件共享，共享缓存可能连不上。" },
  local_account_token_filter: { label: "本地账户远程权限", hint: "本地账户的远程访问权限没放开，部分远程操作会被系统拒绝。" },
  long_paths_enabled: { label: "长路径支持", hint: "系统没开启长路径支持，目录很深的缓存文件可能写不进去。" },
  lanman_server: { label: "文件共享服务", hint: "Windows 文件共享服务没在运行，这台机器没法对外提供共享。" },
  share_reachable: { label: "共享缓存盘连通性", hint: "这台机器连不上共享缓存盘。" },
  ntfs_perm: { label: "共享目录权限", hint: "共享缓存目录的访问权限不正确。" },
  cred_user: { label: "共享访问账号", hint: "访问共享缓存盘的账号凭据还没准备好。" },
  cred_system: { label: "后台服务访问凭据", hint: "系统账户访问共享缓存的凭据还没准备好，后台服务可能读不到共享。" },
  env_vars: { label: "缓存路径配置", hint: "缓存相关的路径配置没设好，UE 可能找不到缓存盘。" },
  env_local: { label: "本地缓存路径", hint: "本地缓存路径还没设好。" },
  env_shared: { label: "共享缓存路径", hint: "这台机器还没指向共享缓存盘，渲染时用不上团队共享的缓存，会各自重新生成。" },
  system_write: { label: "缓存目录写入权限", hint: "系统账户对缓存目录没有写入权限，缓存写不进去。" },
  winmgmt: { label: "系统信息服务", hint: "系统信息服务没在运行，部分硬件和状态信息采集不到。" },
  rs_service: { label: "RenderStream 服务", hint: "RenderStream 服务还没就绪。" },
  ini_consistency: { label: "工程配置检查", hint: "工程配置里有需要调整的项。" },
  pso_precaching: { label: "着色器预缓存", hint: "着色器预缓存没打开，画面首次出现时可能卡顿。" },
  gpu_consistency: { label: "显卡一致性", hint: "集群里各机器的显卡型号或驱动不一致，可能导致渲染结果有差异。" },
  zen_reachable: { label: "共享缓存服务器连通性", hint: "连不上共享缓存服务器（Zen）。" },
  zen_version_consistent: { label: "缓存服务器版本一致性", hint: "共享缓存服务器的版本和集群其他机器不一致。" },
  zen_binary_intact: { label: "缓存服务器程序完整性", hint: "共享缓存服务器的程序文件不完整。" },
  zen_cache_provider_ready: { label: "缓存服务器就绪", hint: "共享缓存服务器还没准备好对外提供缓存。" },
};

const STAT_RANK: Record<string, number> = { critical: 3, warning: 2, healthy: 1, na: 0, offline: 0, unknown: 0 };
const normHealthStatus = (s: string): string =>
  s === "critical" || s === "warning" || s === "healthy" ? s : "na";

/** 把 list_health_results_for_run 的每机×探测项结果（machine_results = probe_key→
 *  CheckOutcome 的 JSON map）聚合成页面 HEALTH_CHECKS 形状（每检查一行，取最差状态 +
 *  受影响机器 + 首条 remediation）。layer/label 后端无源 → 来自 PROBE_DICT（UI 作者维护）。 */
export function toHealthVMs(rows: HealthCheckRow[], machines: NodeVM[]): any[] {
  const hostOf = (mid: number): string => {
    const m = machines.find((x) => x.machineId === mid);
    return m ? m.host : "#" + mid;
  };
  const byKey: Record<string, { statuses: string[]; bad: { host: string; msg: string }[]; remediation: string }> = {};
  rows.forEach((row) => {
    const res = row.machine_results as Record<string, any> | null;
    if (!res || typeof res !== "object") return;
    Object.keys(res).forEach((key) => {
      const oc = res[key];
      if (!oc || typeof oc !== "object") return;
      const g = (byKey[key] = byKey[key] || { statuses: [], bad: [], remediation: "" });
      g.statuses.push(oc.status);
      if (oc.status === "critical" || oc.status === "warning") g.bad.push({ host: hostOf(row.machine_id), msg: oc.message || "" });
      if (!g.remediation && oc.remediation) g.remediation = oc.remediation;
    });
  });
  return Object.keys(byKey).map((key) => {
    const g = byKey[key];
    const worst = g.statuses.reduce((a, s) => ((STAT_RANK[s] || 0) > (STAT_RANK[a] || 0) ? s : a), "na");
    const tech = PROBE_DICT[key] || { label: key, layer: "L3" };
    const nat = PROBE_NARRATIVE[key] || { label: tech.label, hint: "" };
    const hosts = g.bad.map((b) => b.host);
    return {
      id: key,
      layer: tech.layer,      // 保留供他处用；诊断面板不再显示
      tech: tech.label,       // 技术名，留作 tooltip
      label: nat.label,       // 自然语言标题
      hint: nat.hint,         // 自然语言「这条出问题意味着什么」
      status: normHealthStatus(worst),
      detail: hosts.length ? (hosts.length === 1 ? "影响 " + hosts[0] : "影响 " + hosts.length + " 台：" + hosts.join("、")) : "全部正常",
      remediation: g.remediation || null,
      desc: nat.hint || undefined,  // 诊断面板 detail 取 desc → 现为自然语言，不再直显后端 message
    };
  });
}

/* ----------------------------- ini findings ----------------------------- */
/** IniFinding → 页面 INI_FINDINGS 形状。只取未修复未跳过的「open」项；severity 后端永不
 *  发 info；findingId 携带真实数字 id 供 apply_finding 用。 */
export function toIniVMs(findings: IniFinding[], machines: NodeVM[]): any[] {
  const hostOf = (mid: number): string => {
    const m = machines.find((x) => x.machineId === mid);
    return m ? m.host : "#" + mid;
  };
  return findings
    .filter((f) => !f.fixed_at && !f.skipped_at)
    .map((f) => ({
      id: f.rule_id + "@" + f.machine_id,
      findingId: f.id ?? null,
      rule: f.rule_id,
      sev: f.severity,
      machine: hostOf(f.machine_id),
      file: f.file_path,
      section: f.section || "",
      cur: f.snippet_before,
      rec: f.recommended_value || f.snippet_after || f.recommended_action,
      summary: f.symptom,
      why: f.rationale,
      auto: !!f.recommended_value,
    }));
}

export function toProjectVM(p: ProjectSummary, locations: ProjectLocation[]): ProjectVM {
  const machines = Array.from(new Set(locations.map((l) => String(l.machine_id))));
  const first = locations[0];
  const locByMachine: Record<string, string> = {};
  locations.forEach((l) => { locByMachine[String(l.machine_id)] = l.abs_path; });
  return {
    id: p.id,
    name: p.display_name || p.uproject_name,
    uproject: p.uproject_name,
    /* EngineAssociation 为版本形（"5.7"）时才有 major/minor；GUID 形（源码/自编引擎）
     * 无法映射到发行版本号 → 保持 "—"。 */
    ue: p.ue_version_major != null && p.ue_version_minor != null
      ? p.ue_version_major + "." + p.ue_version_minor
      : "—",
    size: "—",
    root: first ? first.abs_path : "—",
    last: first && first.discovered_at ? first.discovered_at : "—",
    machines,
    primary: machines[0] ?? null,
    hasPak: false,
    warn: describeVersionDrift(locations),
    locByMachine,
  };
}

/** 同一工程在不同机器上的 .uproject 各自解析出的 UE 版本若不一致（跨机器各自 checkout 到
 *  不同引擎版本），给出一条人话提示串；否则 null。只在 ≥2 种非空版本组合同时出现时才判定
 *  为"不一致"——单机 / 全部为空（GUID 形关联、未曾扫描等）不算。 */
function describeVersionDrift(locations: ProjectLocation[]): string | null {
  const counts = new Map<string, number>();
  locations.forEach((l) => {
    if (l.ue_version_major == null || l.ue_version_minor == null) return;
    const key = l.ue_version_major + "." + l.ue_version_minor;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  if (counts.size < 2) return null;
  const parts = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([ver, n]) => "UE " + ver + "（" + n + " 台）");
  return "版本不一致：" + parts.join(" · ");
}
