/* 集群 › 工程 的数据层（设计：Projects / ProjectsCards / ProjectDetail / ProjectScan）。
   一行 = 一个 UE 工程；把各机器上的位置、已部署 PAK、PSO 绿灯状态拼成一句话状况。
   缓存指向（每机 zen / 环境变量）后端没有读接口 → 界面显示「—」。 */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteProject,
  discoverProjects,
  ensureOpenDirShare,
  getProjectThumbnail,
  isLoopbackMachine,
  listDeployedDdcPaks,
  listMachines,
  listProjectLocations,
  listProjects,
  listPsoStatus,
  revealPath,
  revealRemotePath,
} from "@/api/commands";
import { isTauri } from "@/api/invoke";
import type { DeployedPakEntry, Machine, ProjectLocation, ProjectSummary, PsoStatusCell } from "@/api/types";
import type { ObjectTab } from "@/lib/nav";
import { cacheKeys } from "./machines";

export const projectKeys = {
  all: ["cache", "projects", "rows"] as const,
  paks: ["cache", "paks"] as const,
  thumb: (projectId: number, machineId: number) => ["cache", "project-thumb", projectId, machineId] as const,
};

export function projectTab(p: Pick<ProjectSummary, "id" | "display_name" | "uproject_name">): ObjectTab {
  return { id: `project:${p.id}`, label: p.display_name || p.uproject_name };
}

/** 工程整体状况：已过期（有机器的 PSO 失效）/ 未预热 / 就绪。 */
export type ProjectState = "attention" | "queued" | "success";
export const PROJECT_STATE_LABEL: Record<ProjectState, string> = { attention: "已过期", queued: "未预热", success: "就绪" };
/** 状况 → 状态图标种类（与 ui Status 的 kind 同名）。 */
export const PROJECT_KIND: Record<ProjectState, "attention" | "queued" | "success"> = { attention: "attention", queued: "queued", success: "success" };

export interface CopyView {
  loc: ProjectLocation;
  machine: Machine | null;
  host: string;
  offline: boolean;
  pak: DeployedPakEntry | null;
  pso: PsoStatusCell | null;
}

export interface ProjectView {
  id: number;
  name: string;
  uproject: string;
  ue: string | null;
  copies: CopyView[];
  source: CopyView | null;
  state: ProjectState;
  pakCount: number;
  psoReady: number;
  psoDegraded: number;
  lastChange: string | null;
  /** 一句话状况（卡片 / Inspector 用）。 */
  reason: string;
  pakText: string;
  psoText: string;
  driftNote: string | null;
  raw: ProjectSummary;
}

function ueText(p: ProjectSummary): string | null {
  return p.ue_version_major != null && p.ue_version_minor != null ? `${p.ue_version_major}.${p.ue_version_minor}` : null;
}

/** 同一工程在不同机器上解析出的 UE 版本不一致时给一句提示（同旧版 describeVersionDrift）。 */
function drift(locs: ProjectLocation[]): string | null {
  const set = new Set(locs.filter((l) => l.ue_version_major != null && l.ue_version_minor != null).map((l) => `${l.ue_version_major}.${l.ue_version_minor}`));
  return set.size > 1 ? `各机器上的引擎版本不一致：${Array.from(set).join(" / ")}` : null;
}

function buildView(p: ProjectSummary, locs: ProjectLocation[], machines: Machine[], paks: DeployedPakEntry[], pso: PsoStatusCell[]): ProjectView {
  const copies: CopyView[] = locs.map((loc) => {
    const machine = machines.find((m) => m.id === loc.machine_id) ?? null;
    return {
      loc,
      machine,
      host: machine?.hostname ?? `#${loc.machine_id}`,
      offline: !!machine && (machine.status || "").toLowerCase().includes("offline"),
      pak: paks.find((k) => k.project_id === p.id && k.machine_id === loc.machine_id) ?? null,
      pso: pso.find((c) => c.machine_id === loc.machine_id) ?? null,
    };
  });
  const online = copies.filter((c) => !c.offline);
  const source = copies.find((c) => c.pak) ?? online[0] ?? copies[0] ?? null;
  const pakCount = copies.filter((c) => c.pak).length;
  const psoReady = copies.filter((c) => c.pso?.status === "ok").length;
  const psoDegraded = copies.filter((c) => c.pso?.status === "degraded").length;
  const n = copies.length;
  const state: ProjectState = psoDegraded > 0 ? "attention" : n > 0 && psoReady >= online.length && online.length > 0 ? "success" : "queued";
  const pakText = pakCount === 0 ? "还没有生成" : pakCount === 1 && n > 1 ? `只在源机上 · 1 / ${n} 台` : `已分发 ${pakCount} / ${n} 台`;
  const psoText = psoReady === 0 && psoDegraded === 0 ? "还没有预热" : `${psoReady} / ${n} 台就绪`;
  const ue = ueText(p);
  const reason =
    state === "attention" ? `PSO ${psoReady} / ${n} 台就绪` : pakCount === 0 ? "还没有 PAK" : state === "queued" ? "还没有预热" : `${n} 台${ue ? ` · UE ${ue}` : ""}`;
  const times = locs.map((l) => l.discovered_at).filter((x): x is string => !!x).sort();
  return {
    id: p.id,
    name: p.display_name || p.uproject_name,
    uproject: p.uproject_name,
    ue,
    copies,
    source,
    state,
    pakCount,
    psoReady,
    psoDegraded,
    lastChange: times[times.length - 1] ?? null,
    reason,
    pakText,
    psoText,
    driftNote: drift(locs),
    raw: p,
  };
}

async function loadProjects(): Promise<ProjectView[]> {
  const [projects, machines, paks] = await Promise.all([listProjects(), listMachines(), listDeployedDdcPaks().catch(() => [] as DeployedPakEntry[])]);
  return Promise.all(
    projects.map(async (p) => {
      const [locs, pso] = await Promise.all([listProjectLocations(p.id).catch(() => [] as ProjectLocation[]), listPsoStatus(p.id).catch(() => [] as PsoStatusCell[])]);
      return buildView(p, locs, machines, paks, pso);
    }),
  );
}

export function useProjects() {
  const on = isTauri();
  const q = useQuery({ queryKey: projectKeys.all, queryFn: loadProjects, enabled: on });
  return {
    views: q.data ?? [],
    loading: on && q.isLoading,
    fetching: q.isFetching,
    error: on ? q.error : new Error("浏览器预览没有后端：在原生 App 里打开才能读到工程"),
    updatedAt: q.dataUpdatedAt || null,
    refetch: () => void q.refetch(),
  };
}

/** 卡片缩略图：每个工程取源机器上的截图（懒加载，失败 = 没有截图）。 */
export function useThumbs(views: ProjectView[], enabled: boolean) {
  const qs = useQueries({
    queries: views.map((v) => ({
      queryKey: projectKeys.thumb(v.id, v.source?.loc.machine_id ?? 0),
      queryFn: () => getProjectThumbnail(v.id, v.source?.loc.machine_id ?? 0),
      enabled: enabled && isTauri() && !!v.source,
      staleTime: 10 * 60_000,
      retry: false,
    })),
  });
  const out = new Map<number, { src: string | null; size: number | null }>();
  views.forEach((v, i) => {
    const d = qs[i]?.data;
    out.set(v.id, { src: d?.thumbnail ? `data:image/png;base64,${d.thumbnail.base64}` : null, size: d?.size_bytes ?? null });
  });
  return out;
}

/** 扫描工程：对每台在线机器在给定目录里找 .uproject。返回发现的位置数与失败台数。 */
export function useDiscover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ machineIds, roots }: { machineIds: number[]; roots: string[] }) => {
      if (!roots.length) throw new Error("至少要有一个搜索目录");
      if (!machineIds.length) throw new Error("没有在线机器可扫描");
      const rs = await Promise.allSettled(machineIds.map((id) => discoverProjects(id, roots, null)));
      const ok = rs.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof discoverProjects>>> => r.status === "fulfilled");
      if (!ok.length) throw new Error("全部机器扫描失败");
      return { found: ok.reduce((a, r) => a + r.value.length, 0), failed: rs.length - ok.length };
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["cache"] });
      void qc.invalidateQueries({ queryKey: cacheKeys.projects });
    },
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => deleteProject(id), onSettled: () => void qc.invalidateQueries({ queryKey: ["cache"] }) });
}

/* -------------------------- 在源机上打开文件夹 -------------------------- */

const shareDirFor = (path: string) => {
  const parts = path.replace(/\//g, "\\").replace(/\\+$/, "").split("\\").filter(Boolean);
  return parts.length <= 2 ? parts.join("\\") : parts.slice(0, -1).join("\\");
};
const shareNameFor = (dir: string) =>
  `volo-dir-${dir.toLowerCase().replace(/:/g, "").replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)}`;

/** 本机直接打开；远程走 \\host 路径，不在任何共享里时先把上级目录开放为共享再重试（同旧版）。 */
export async function openFolderOn(machine: Machine, path: string, allMachines: Machine[]): Promise<void> {
  if (await isLoopbackMachine(machine.ip)) return revealPath(path);
  try {
    await revealRemotePath(machine.ip, path);
  } catch {
    let selfId: number | null = null;
    for (const m of allMachines) {
      if (m.id != null && (await isLoopbackMachine(m.ip).catch(() => false))) {
        selfId = m.id;
        break;
      }
    }
    const dir = shareDirFor(path);
    await ensureOpenDirShare(machine.id ?? 0, shareNameFor(dir), dir, selfId != null && selfId !== machine.id ? [selfId] : []);
    await revealRemotePath(machine.ip, path);
  }
}

export function humanBytes(b: number | null | undefined): string {
  if (b == null) return "—";
  if (b >= 1e9) return `${(b / 1073741824).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1048576).toFixed(0)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
}

export const PSO_REASON: Record<string, string> = {
  gpu_driver_changed: "驱动变了",
  cache_shrunk: "驱动缓存被清过",
  cache_directory_missing: "驱动缓存目录不见了",
  interactive_user_changed: "登录桌面的用户换了",
  node_rebooted: "机器重启过",
};

/** 一份副本的 PSO 文案（详情表格 / 机器详情用）。 */
export function copyPsoText(c: CopyView): string {
  if (c.offline) return "—";
  const s = c.pso?.status;
  if (s === "ok") return "就绪";
  if (s === "degraded") {
    const r = c.pso?.invalidation_reasons[0]?.reason;
    return `已过期${r && PSO_REASON[r] ? ` · ${PSO_REASON[r]}` : ""}`;
  }
  return "还没有预热";
}
