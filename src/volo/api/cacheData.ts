/* Volo — Cache resource loader.
   Fetches the read-path resources the Cache page seeds itself from (machines /
   credentials / shares) via the typed commands and projects them to the page's
   ViewModels. Used by the shell to replace the former hardcoded mock seeds with
   real backend data behind a loading/error gate. */
import { listMachines, listCredentials, listShares, listProjects, listProjectLocations, getGpuConsistencyMatrix,
  listRecentHealthRuns, listHealthResultsForRun, listRecentIniRuns, listFindings, listUeRuntimeUsers } from "./commands";
import { toNodeVM, toCredVM, toShareVM, toProjectVM, toHealthVMs, toIniVMs } from "./adapters";
import type { NodeVM, CredVM, ShareVM, ProjectVM } from "./adapters";
import type { GpuMatrix } from "./types";

export interface CacheResources {
  machines: NodeVM[];
  creds: CredVM[];
  shares: ShareVM[];
  projects: ProjectVM[];
  /** GPU consistency matrix (DB read, no SSH) — drives the Overview GPU KPI.
   *  null when the backend read fails (non-gating; KPI falls back to "—"). */
  gpuMatrix: GpuMatrix | null;
  /** 最近一次健康巡检 / INI 扫描的结果，映射成页面 HEALTH_CHECKS / INI_FINDINGS 形状；
   *  无 run 时为 []（页面诊断面板显示「全部通过 / 暂未巡检」）。 */
  health: any[];
  ini: any[];
  /** 最近一次健康 run 的完成时间戳（SQLite CURRENT_TIMESTAMP, UTC）；驱动派生的
   *  CLUSTER.lastRun / lastRunAgo。无 run 时 null。 */
  healthRunAt: string | null;
}

/** 最近一次健康 run 的逐机结果 → 聚合 VM + 完成时间；无 run 返回空。 */
async function loadHealth(machines: NodeVM[]): Promise<{ vms: any[]; runAt: string | null }> {
  const runs = await listRecentHealthRuns(1);
  const run = runs[0];
  if (!run || run.id == null) return { vms: [], runAt: null };
  const rows = await listHealthResultsForRun(run.id);
  return { vms: toHealthVMs(rows, machines), runAt: run.finished_at || run.started_at || null };
}
/** 最近一次 INI scan run 的 open findings → VM；无 run 返回 []。 */
async function loadIni(machines: NodeVM[]): Promise<any[]> {
  const runs = await listRecentIniRuns(1);
  const id = runs[0]?.id;
  if (id == null) return [];
  const findings = await listFindings(id);
  return toIniVMs(findings, machines);
}

/** UE projects + their per-machine locations (list_projects → N×
 *  list_project_locations). Per-project location failures degrade to [] so one
 *  bad project never sinks the whole list. */
async function loadProjects(): Promise<ProjectVM[]> {
  const summaries = await listProjects();
  return Promise.all(
    summaries.map(async (p) => {
      const locations = await listProjectLocations(p.id).catch(() => []);
      return toProjectVM(p, locations);
    }),
  );
}

/** Load the read-path resources. machines / creds / shares gate the Cache page
 *  (reject → error state). projects are non-gating: a failure degrades to []
 *  (the DDC PAK/PSO views fall back to their "先扫描工程" empty states). */
export async function loadCacheResources(): Promise<CacheResources> {
  const [machinesRaw, creds, shares, projects, gpuMatrix, ueRuntimeUsers] = await Promise.all([
    listMachines(),
    listCredentials(),
    listShares(),
    loadProjects().catch(() => [] as ProjectVM[]),
    getGpuConsistencyMatrix().catch(() => null),
    listUeRuntimeUsers().catch(() => []),
  ]);
  /* volo-zen 是「设置本地 Zen 缓存目录」时自动创建的目录开放共享，仅供 reveal_path
     跨机改写 UNC 用——不是 FileSystem DDC 服务器。滤掉它，否则 cacheDdc 会把它当
     DDC 共享展示/加入/拆除，且宿主机会因 shareHostIds 被排除出 DDC client 候选。 */
  const ddcShares = shares.filter((sh) => sh.share_name.toLowerCase() !== 'volo-zen');
  const machines = machinesRaw.map((m) => toNodeVM(m, ddcShares, ueRuntimeUsers));
  /* health / ini 需要 machines 做 machine_id→host 反查，故在 machines 就绪后加载；
     非阻断（失败 → []）。 */
  const [health, ini] = await Promise.all([
    loadHealth(machines).catch(() => ({ vms: [] as any[], runAt: null })),
    loadIni(machines).catch(() => [] as any[]),
  ]);
  return {
    machines,
    creds: creds.map(toCredVM),
    // toShareVM 需 machines 反查 host_machine_id → hostname / hostId（行内显示宿主 +
    // 部署面板「该服务器是否已部署」匹配）。
    shares: ddcShares.map((sh) => toShareVM(sh, machinesRaw)),
    projects,
    gpuMatrix,
    health: health.vms,
    ini,
    healthRunAt: health.runAt,
  };
}
