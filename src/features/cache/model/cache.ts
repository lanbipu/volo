/* 集群 › 缓存 的数据层（设计：Cache / CachePak / CacheLegacy / ZenPoint / CacheZenSettings）。
   - Zen：服务器状态（zen_status + zen_list_endpoints，取 shared_upstream 端点）、用量（zen_cache_stats / zen_disk_space）。
   - 每台在线机器的缓存配置通道真实回读（同旧版 cacheZen / cacheDdc 的回读口径）：
       环境变量 UE-ZenSharedDataCacheHost / UE-SharedDataCachePath、
       各工程 DefaultEngine.ini（[StorageServers] Shared 的 Host；[DerivedDataBackendGraph] Shared 的 Path）、
       UE 运行用户的 UserEngine.ini（[StorageServers] Shared）、注册表 HKCU GlobalDataCachePath。
     命令行参数通道（快捷方式 / bat 扫描）开销大，本页不读 → 显示「—」。
   - 命中率 / 请求数后端没有数据源 → 界面显示「—」。 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getDdcRegistryOverrides,
  getMachineBackendField,
  getMachineEnvVar,
  listMachines,
  listProjectLocations,
  listProjects,
  listShares,
  listUeRuntimeUsers,
  readIniSection,
  setIniKey,
  zenCacheStats,
  zenDiskSpace,
  zenEnableGlobal,
  zenListEndpoints,
  zenProbe,
  zenServiceStart,
  zenServiceStop,
  zenStatus,
  zenUpdateGcSettings,
} from "@/api/commands";
import { isTauri } from "@/api/invoke";
import type { IniKey, Machine, ShareConfig, ZenEndpoint, ZenStatusRow } from "@/api/types";

export const cacheTabKeys = {
  zen: ["cache", "zen", "server"] as const,
  usage: (ep: number) => ["cache", "zen", "usage", ep] as const,
  reads: ["cache", "channels"] as const,
  shares: ["cache", "shares"] as const,
};

/** SSH key 免凭据（同旧版：ZenCredentialInput 全 None）。 */
const NO_CRED = {};

/* --------------------------------- Zen 服务器 --------------------------------- */

export interface ZenServer {
  endpointId: number;
  machineId: number;
  host: string;
  ip: string;
  port: number;
  url: string;
  version: string | null;
  reachable: boolean | null;
  probedAt: string | null;
  error: string | null;
  endpoint: ZenEndpoint | null;
}

function pickServer(rows: ZenStatusRow[], eps: ZenEndpoint[]): ZenServer | null {
  const row = rows.find((r) => r.role === "shared_upstream") ?? rows[0];
  if (!row) return null;
  const port = row.effective_port ?? row.declared_port;
  return {
    endpointId: row.endpoint_id,
    machineId: row.machine_id,
    host: row.hostname,
    ip: row.ip,
    port,
    url: `${row.scheme || "http"}://${row.hostname}:${port}`,
    version: row.build_version,
    reachable: row.reachable,
    probedAt: row.last_probed_at,
    error: row.last_error,
    endpoint: eps.find((e) => e.id === row.endpoint_id) ?? null,
  };
}

export function useZenServer() {
  const on = isTauri();
  const q = useQuery({
    queryKey: cacheTabKeys.zen,
    queryFn: async () => {
      const [rows, eps] = await Promise.all([zenStatus(null), zenListEndpoints(null).catch(() => [] as ZenEndpoint[])]);
      return pickServer(rows, eps);
    },
    enabled: on,
  });
  return { server: q.data ?? null, loading: on && q.isLoading, error: on ? q.error : new Error("浏览器预览没有后端：在原生 App 里打开才能读到缓存"), refetch: () => void q.refetch() };
}

/** 已用空间：zen_cache_stats 的缓存盘占用 + zen_disk_space 的卷容量。读不到为 null。 */
export function useZenUsage(endpointId: number | null) {
  return useQuery({
    queryKey: cacheTabKeys.usage(endpointId ?? 0),
    queryFn: async () => {
      const [stats, disk] = await Promise.allSettled([zenCacheStats(endpointId, 8), zenDiskSpace(endpointId)]);
      const s = stats.status === "fulfilled" ? stats.value.samples.find((x) => x.endpoint_id === endpointId) : undefined;
      const d = disk.status === "fulfilled" ? disk.value.find((x) => x.endpoint_id === endpointId) : undefined;
      return { used: s?.cache_disk_size_bytes ?? null, total: d?.total_bytes ?? null, free: d?.free_bytes ?? null };
    },
    enabled: isTauri() && endpointId != null,
    staleTime: 60_000,
    retry: false,
  });
}

export function useZenProbe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (machineId: number) => zenProbe(machineId, null, 5),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["cache"] }),
  });
}

export function useZenService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ endpointId, stop, dryRun }: { endpointId: number; stop: boolean; dryRun?: boolean }) =>
      stop ? zenServiceStop(endpointId, true, !!dryRun, NO_CRED) : zenServiceStart(endpointId, NO_CRED),
    onSettled: () => void qc.invalidateQueries({ queryKey: cacheTabKeys.zen }),
  });
}

export function useZenGc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ endpointId, full, light, keep }: { endpointId: number; full: number; light: number; keep: number }) =>
      zenUpdateGcSettings(endpointId, full, light, keep, true, false, NO_CRED),
    onSettled: () => void qc.invalidateQueries({ queryKey: cacheTabKeys.zen }),
  });
}

/* ------------------------------ 配置通道回读 ------------------------------ */

export type ChannelKey = "cmd" | "env" | "project" | "user" | "registry";
export const CHANNEL_LABEL: Record<ChannelKey, string> = { cmd: "命令行参数", env: "环境变量", project: "工程配置", user: "用户配置", registry: "注册表" };

export interface Channel {
  key: ChannelKey;
  /** 指向的 Zen 地址（Host=…）。 */
  zen: string | null;
  /** 旧版共享目录路径。 */
  share: string | null;
  /** 没读（命令行参数）。 */
  unread?: boolean;
  /** 写着它的工程（工程配置通道）。 */
  projects?: string[];
}

export interface MachineRead {
  machine: Machine;
  id: number;
  host: string;
  offline: boolean;
  /** 读完的时间（ms）；离线 = null。 */
  at: number | null;
  failed: boolean;
  channels: Record<ChannelKey, Channel>;
}

const hostOf = (v: IniKey[] | undefined): string | null => {
  const k = (v ?? []).find((x) => x.name.toLowerCase() === "shared");
  return k ? (/Host\s*=\s*"([^"]+)"/i.exec(k.value)?.[1] ?? null) : null;
};
export const isOffline = (m: Machine) => (m.status || "").toLowerCase().includes("offline");
const userIni = (user: string) => `C:\\Users\\${user}\\AppData\\Local\\Unreal Engine\\Engine\\Config\\UserEngine.ini`;
const projIni = (loc: string) => `${loc.replace(/[\\/]+$/, "")}\\Config\\DefaultEngine.ini`;
const val = <T>(r: PromiseSettledResult<T>): T | undefined => (r.status === "fulfilled" ? r.value : undefined);

function emptyChannels(): Record<ChannelKey, Channel> {
  return {
    cmd: { key: "cmd", zen: null, share: null, unread: true },
    env: { key: "env", zen: null, share: null },
    project: { key: "project", zen: null, share: null, projects: [] },
    user: { key: "user", zen: null, share: null },
    registry: { key: "registry", zen: null, share: null },
  };
}

async function readMachine(m: Machine, user: string | null, locs: { name: string; path: string }[]): Promise<MachineRead> {
  const id = m.id ?? 0;
  const base: MachineRead = { machine: m, id, host: m.hostname, offline: isOffline(m), at: null, failed: false, channels: emptyChannels() };
  if (base.offline) return base;
  const [zenEnv, shareEnv, reg, uIni, ...proj] = await Promise.allSettled([
    getMachineEnvVar(id, "UE-ZenSharedDataCacheHost"),
    getMachineEnvVar(id, "UE-SharedDataCachePath"),
    getDdcRegistryOverrides(id),
    user ? readIniSection(id, userIni(user), "StorageServers") : Promise.resolve([] as IniKey[]),
    ...locs.flatMap((l) => [readIniSection(id, projIni(l.path), "StorageServers"), getMachineBackendField(id, projIni(l.path), "DerivedDataBackendGraph", "Shared")]),
  ]);
  const c = base.channels;
  c.env.zen = val(zenEnv) || null;
  c.env.share = val(shareEnv) || null;
  c.registry.share = val(reg)?.shared_path || null;
  c.user.zen = hostOf(val(uIni) as IniKey[] | undefined);
  locs.forEach((l, i) => {
    const z = hostOf(val(proj[i * 2]) as IniKey[] | undefined);
    const bf = val(proj[i * 2 + 1]) as { found: boolean; fields: Record<string, string> } | undefined;
    const p = bf?.found ? bf.fields.Path || bf.fields.path || null : null;
    if (z || p) c.project.projects?.push(l.name);
    c.project.zen ??= z;
    c.project.share ??= p;
  });
  const allFailed = [zenEnv, shareEnv, reg].every((r) => r.status === "rejected");
  return { ...base, at: Date.now(), failed: allFailed };
}

async function loadReads(): Promise<MachineRead[]> {
  const [machines, users, projects] = await Promise.all([listMachines(), listUeRuntimeUsers().catch(() => []), listProjects().catch(() => [])]);
  const locs = await Promise.all(projects.map((p) => listProjectLocations(p.id).then((ls) => ls.map((l) => ({ l, name: p.display_name || p.uproject_name }))).catch(() => [])));
  const flat = locs.flat();
  return Promise.all(
    machines.map((m) =>
      readMachine(
        m,
        users.find((u) => u.machine_id === m.id)?.ue_runtime_user ?? null,
        flat.filter((x) => x.l.machine_id === m.id).map((x) => ({ name: x.name, path: x.l.abs_path })),
      ),
    ),
  );
}

export function useChannelReads() {
  const q = useQuery({ queryKey: cacheTabKeys.reads, queryFn: loadReads, enabled: isTauri(), staleTime: 60_000 });
  return { reads: q.data ?? [], loading: isTauri() && q.isLoading, fetching: q.isFetching, updatedAt: q.dataUpdatedAt || null, refetch: () => void q.refetch() };
}

export function useShares() {
  return useQuery({ queryKey: cacheTabKeys.shares, queryFn: listShares, enabled: isTauri() });
}

/* ------------------------------ 判定：Zen 指向 ------------------------------ */

/** 地址是否指向这台 Zen 服务器：主机名 / IP 任一相符，端口一致（没写端口按 8558）。 */
export function pointsTo(addr: string | null, s: ZenServer | null): boolean {
  if (!addr || !s) return false;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(addr) ? addr : `http://${addr}`);
    const port = Number(u.port || 8558);
    return port === s.port && [s.host, s.ip].map((x) => x.toLowerCase()).includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** 设计里 Zen 指向的优先级（从上到下递减）。 */
export const ZEN_ORDER: ChannelKey[] = ["cmd", "env", "project", "user"];
/** 共享目录页的四处配置。 */
export const LEGACY_ORDER: ChannelKey[] = ["cmd", "env", "project", "registry"];

export const chanValue = (c: Channel) => c.zen ?? c.share;
export const isSet = (c: Channel) => !c.unread && !!chanValue(c);

/** 生效通道 = 顺序里第一条有值的。 */
export function effective(r: MachineRead, order: ChannelKey[]): Channel | null {
  return order.map((k) => r.channels[k]).find(isSet) ?? null;
}

export type PointState = "pointed" | "elsewhere" | "none" | "offline" | "unknown";
export interface ZenRow {
  r: MachineRead;
  state: PointState;
  eff: Channel | null;
  /** 被盖住的、写着别的值的通道数。 */
  overridden: number;
  isServer: boolean;
}

export function zenRows(reads: MachineRead[], s: ZenServer | null): ZenRow[] {
  return reads.map((r) => {
    const isServer = !!s && r.id === s.machineId;
    if (r.offline) return { r, state: "offline", eff: null, overridden: 0, isServer };
    if (r.failed) return { r, state: "unknown", eff: null, overridden: 0, isServer };
    const eff = effective(r, ZEN_ORDER);
    const state: PointState = !eff ? "none" : pointsTo(eff.zen, s) ? "pointed" : "elsewhere";
    const rest = ZEN_ORDER.slice(eff ? ZEN_ORDER.indexOf(eff.key) + 1 : ZEN_ORDER.length).map((k) => r.channels[k]);
    const overridden = eff ? rest.filter((c) => isSet(c) && chanValue(c) !== chanValue(eff)).length : 0;
    return { r, state, eff, overridden, isServer };
  });
}

/* ---------------------------- 判定：旧版共享目录 ---------------------------- */

export type LegacyGroup = "host" | "configured" | "clean" | "offline";
export interface LegacyRow {
  r: MachineRead;
  group: LegacyGroup;
  share: ShareConfig | null;
  /** 写着共享目录的通道。 */
  where: Channel[];
  /** 共享目录被更高优先级的 Zen 指向盖住。 */
  shadowedBy: Channel | null;
}

export function legacyRows(reads: MachineRead[], shares: ShareConfig[]): LegacyRow[] {
  return reads.map((r) => {
    const share = shares.find((s) => s.host_machine_id === r.id) ?? null;
    if (share) return { r, group: "host", share, where: [], shadowedBy: null };
    if (r.offline || r.failed) return { r, group: "offline", share: null, where: [], shadowedBy: null };
    const where = LEGACY_ORDER.map((k) => r.channels[k]).filter((c) => !c.unread && !!c.share);
    const eff = effective(r, LEGACY_ORDER);
    const shadowedBy = where.length && eff && eff.zen && !eff.share ? eff : null;
    return { r, group: where.length ? "configured" : "clean", share: null, where, shadowedBy };
  });
}

/* -------------------------------- 写入：指向 Zen -------------------------------- */

export type PointScope = "project" | "user";

export interface PointTarget {
  machineId: number;
  host: string;
  /** 这台机器上被选中的工程位置。 */
  locs: { name: string; path: string }[];
}

/** 同旧版 ClientModal.applyTo 的写入值。 */
export const storageValue = (s: ZenServer) =>
  `(Host="${s.url}", Namespace="ue.ddc", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)`;

export function useZenPoint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ server, scope, targets }: { server: ZenServer; scope: PointScope; targets: PointTarget[] }) => {
      const value = storageValue(server);
      const rs = await Promise.allSettled(
        targets.map(async (t) => {
          if (scope === "user") return void (await zenEnableGlobal(t.machineId, server.endpointId));
          if (!t.locs.length) throw new Error(`${t.host} 上没有选中的工程`);
          await Promise.all(t.locs.map((l) => setIniKey(t.machineId, projIni(l.path), "StorageServers", "Shared", value)));
        }),
      );
      const failed = rs.map((r, i) => (r.status === "rejected" ? targets[i].host : null)).filter((x): x is string => !!x);
      if (failed.length === targets.length) throw new Error(`全部写入失败：${failed.join("、")}`);
      return { ok: targets.length - failed.length, failed };
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: cacheTabKeys.reads }),
  });
}

/* --------------------------------- 格式 --------------------------------- */

export const GB = 1073741824;
export function gb(b: number | null | undefined): string {
  return b == null ? "—" : `${Math.round(b / GB).toLocaleString("en-US")}`;
}
