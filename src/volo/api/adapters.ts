/* Volo — DTO → ViewModel adapters.
   The custom-CSS Cache page was built against richer mock shapes than the
   backend exposes (see CACHE-CAPABILITIES.md · "后端无此指标"). These mappers
   project the real `Serialize` DTOs onto the shapes the page reads, filling
   fields the backend cannot provide with safe placeholders ("—" / null / "na")
   so no consumer crashes and no fabricated metric is invented. */
import type { Machine, CredentialRecord, ShareConfig, ProjectSummary, ProjectLocation, HealthCheckRow, IniFinding } from "./types";

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

export function toNodeVM(m: Machine): NodeVM {
  const machineId = m.id ?? 0;
  const roleKey = normalizeRoleKey(m.role);
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
    user: "—",
    auth: "SSH 公钥",
    domain: "—",
    zen: null,
    share: null,
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
  mode: string;
  clients: number;
  size: string;
  status: "healthy" | "warning";
}

export function toShareVM(s: ShareConfig): ShareVM {
  return {
    id: String(s.id ?? 0),
    shareConfigId: s.id ?? 0,
    path: s.unc_path,
    mode: s.mode === "open" ? "Mode A · 开放" : "Mode B · 专用账号",
    clients: 0,
    size: "—",
    status: "healthy",
  };
}

/* ----------------------------- project ----------------------------- */
/** Shape the DDC PAK / PSO views read (UE_PROJECTS element). The backend
 *  surfaces project identity (list_projects) + per-machine locations
 *  (list_project_locations). UE version / size / pak-presence / warnings are
 *  not exposed by any command → "—" / false / null (TODO: 后端无源).
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
    const meta = PROBE_DICT[key] || { label: key, layer: "L3" };
    const hosts = g.bad.map((b) => b.host);
    return {
      id: key,
      layer: meta.layer,
      label: meta.label,
      status: normHealthStatus(worst),
      detail: hosts.length ? hosts.length + " 台异常：" + hosts.join(" / ") : "全部正常",
      remediation: g.remediation || null,
      desc: g.bad.length && g.bad[0].msg ? g.bad[0].msg : undefined,
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
    ue: "—",
    size: "—",
    root: first ? first.abs_path : "—",
    last: first && first.discovered_at ? first.discovered_at : "—",
    machines,
    primary: machines[0] ?? null,
    hasPak: false,
    warn: null,
    locByMachine,
  };
}
