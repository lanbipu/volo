/* 集群 › 机器 的数据层。把机器、GPU 一致性矩阵、UE 运行用户、最近一次健康巡检与 INI 检查、
   当前 Stage 的上屏拓扑拼成每台机器一行（设计：Machines.dc.html / MachineDetail.dc.html）。
   后端没有的字段留 null，界面显示「—」。 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import {
  addMachine,
  deleteMachine,
  getGpuConsistencyMatrix,
  getMachineDetail,
  listFindings,
  listHealthResultsForRun,
  listMachines,
  listRecentHealthRuns,
  listRecentIniRuns,
  listUeRuntimeUsers,
  listProjects,
  listProjectLocations,
  refreshMachine,
  renameMachine,
  runHealthCheck,
  scanInis,
  applyFinding,
  skipFinding,
  setUeRuntimeUser,
} from "@/api/commands";
import { isTauri } from "@/api/invoke";
import type { CheckOutcome, GpuMatrix, IniFinding, Machine, ProjectConfig, ProjectLocation, ProjectSummary } from "@/api/types";
import { useCurrentStage } from "@/features/stage";
import { CHECK_TEXT, checkLabel } from "./checks";

export const cacheKeys = {
  machines: ["cache", "machines"] as const,
  gpu: ["cache", "gpu-matrix"] as const,
  ueUsers: ["cache", "ue-users"] as const,
  health: ["cache", "health", "latest"] as const,
  ini: ["cache", "ini", "latest"] as const,
  detail: (id: number) => ["cache", "machine", id] as const,
  projects: ["cache", "projects"] as const,
  projectLocations: ["cache", "project-locations"] as const,
};

export type MachineState = "failed" | "success" | "offline" | "queued";
export type RoleKey = "render" | "shared" | "workstation" | "spare";

export const ROLE_LABEL: Record<RoleKey, string> = { render: "渲染节点", shared: "缓存服务器", workstation: "工作站", spare: "备机" };
export const STATE_LABEL: Record<MachineState, string> = { failed: "需处理", success: "就绪", offline: "离线", queued: "未巡检" };

export interface CheckView {
  key: string;
  label: string;
  status: "pass" | "fail" | "skip" | "offline";
  message: string;
  remediation: string;
}

export interface MachineView {
  id: number;
  uid: string | null;
  host: string;
  ip: string;
  role: RoleKey;
  state: MachineState;
  summary: string;
  driver: string | null;
  gpuModel: string | null;
  driverMismatch: boolean;
  ueUser: string | null;
  lastSeen: string | null;
  checkedAt: string | null;
  checks: CheckView[];
  findings: IniFinding[];
  /** 行内标签：角色、主节点、上屏节点。 */
  tags: string[];
  output: { node: string; primary: boolean } | null;
  raw: Machine;
}

export function roleKey(raw: string): RoleKey {
  const s = (raw || "").toLowerCase();
  if (s.includes("shared") || s.includes("upstream") || s.includes("cache") || s.includes("zen")) return "shared";
  if (s.includes("work") || s === "ws") return "workstation";
  if (s.includes("spare") || s.includes("backup")) return "spare";
  return "render";
}

function outcomeStatus(o: CheckOutcome): CheckView["status"] {
  const s = (o.status || "").toLowerCase();
  if (s === "critical" || s === "warning") return "fail";
  if (s === "offline") return "offline";
  if (s === "healthy") return "pass";
  return "skip";
}

function parseChecks(results: unknown): CheckView[] {
  if (!results || typeof results !== "object") return [];
  return Object.entries(results as Record<string, CheckOutcome>)
    .filter(([, o]) => o && typeof o === "object")
    .map(([key, o]) => ({ key, label: checkLabel(key), status: outcomeStatus(o), message: o.message || "", remediation: o.remediation || "" }));
}

function machineOutput(m: Machine, cfg: ProjectConfig | undefined): MachineView["output"] {
  const nodes = cfg?.output_topology?.nodes ?? [];
  const n = nodes.find((x) => (x.machine.machine_uid && x.machine.machine_uid === m.uid) || x.machine.hostname === m.hostname || x.machine.ip === m.ip);
  return n ? { node: n.node_id, primary: n.primary } : null;
}

/** 一句话状况（设计稿：「GPU 驱动与集群不一致」「8 项巡检全部通过」「SSH 不可达，上次在线 …」）。 */
function summarize(state: MachineState, checks: CheckView[], findings: IniFinding[], lastSeen: string | null): string {
  if (state === "offline") return lastSeen ? `连不上，上次在线 ${fmtTime(lastSeen)}` : "连不上这台机器";
  if (state === "queued") return "还没有巡检过";
  const bad = checks.filter((c) => c.status === "fail");
  if (state === "success") return `${checks.filter((c) => c.status === "pass").length} 项巡检全部通过`;
  const first = bad[0] ? (CHECK_TEXT[bad[0].key]?.fail ?? `${bad[0].label}未通过`) : findings[0]?.symptom || "工程配置有需要调整的项";
  const more = bad.length + findings.length - 1;
  return more > 0 ? `${first}，另有 ${more} 项` : first;
}

function buildViews(machines: Machine[], gpu: GpuMatrix | null, ueUsers: { machine_id: number; ue_runtime_user: string | null }[], health: Map<number, CheckView[]>, healthAt: string | null, findings: IniFinding[], cfg: ProjectConfig | undefined): MachineView[] {
  return machines.map((m) => {
    const id = m.id ?? 0;
    const cell = gpu?.cells.find((c) => c.machine_id === id);
    const checks = health.get(id) ?? [];
    const open = findings.filter((f) => f.machine_id === id && !f.fixed_at && !f.skipped_at);
    const offlineByStatus = (m.status || "").toLowerCase().includes("offline");
    const offlineByChecks = checks.length > 0 && checks.every((c) => c.status === "offline");
    const state: MachineState = offlineByStatus || offlineByChecks ? "offline" : checks.length === 0 ? "queued" : checks.some((c) => c.status === "fail") || open.length ? "failed" : "success";
    const role = roleKey(m.role);
    const output = machineOutput(m, cfg);
    const tags = [output?.primary ? "主节点" : ROLE_LABEL[role]];
    if (output?.primary && role !== "render") tags.push(ROLE_LABEL[role]);
    if (output) tags.push(output.node);
    const driverMismatch = !!(gpu?.baseline && cell?.signature && cell.signature.driver !== gpu.baseline.driver);
    return {
      id,
      uid: m.uid,
      host: m.hostname,
      ip: m.ip,
      role,
      state,
      summary: summarize(state, checks, open, m.last_seen_at),
      driver: cell?.signature?.driver ?? null,
      gpuModel: cell?.signature?.model ?? null,
      driverMismatch,
      ueUser: ueUsers.find((u) => u.machine_id === id)?.ue_runtime_user ?? null,
      lastSeen: m.last_seen_at,
      checkedAt: checks.length ? healthAt : null,
      checks,
      findings: open,
      tags,
      output,
      raw: m,
    };
  });
}

/* ------------------------------- queries ------------------------------- */

async function loadLatestHealth(): Promise<{ byMachine: Map<number, CheckView[]>; at: string | null; runId: number | null }> {
  const runs = await listRecentHealthRuns(1);
  const run = runs[0];
  if (!run || run.id == null) return { byMachine: new Map(), at: null, runId: null };
  const rows = await listHealthResultsForRun(run.id);
  const byMachine = new Map<number, CheckView[]>();
  for (const r of rows) byMachine.set(r.machine_id, parseChecks(r.machine_results));
  return { byMachine, at: run.finished_at || run.started_at, runId: run.id };
}

async function loadLatestFindings(): Promise<IniFinding[]> {
  const runs = await listRecentIniRuns(1);
  const id = runs[0]?.id;
  return id == null ? [] : listFindings(id);
}

export function useMachines() {
  const on = isTauri();
  const { stage } = useCurrentStage();
  const machines = useQuery({ queryKey: cacheKeys.machines, queryFn: listMachines, enabled: on });
  const gpu = useQuery({ queryKey: cacheKeys.gpu, queryFn: getGpuConsistencyMatrix, enabled: on });
  const ueUsers = useQuery({ queryKey: cacheKeys.ueUsers, queryFn: listUeRuntimeUsers, enabled: on });
  const health = useQuery({ queryKey: cacheKeys.health, queryFn: loadLatestHealth, enabled: on });
  const ini = useQuery({ queryKey: cacheKeys.ini, queryFn: loadLatestFindings, enabled: on });
  const views = machines.data
    ? buildViews(machines.data, gpu.data ?? null, ueUsers.data ?? [], health.data?.byMachine ?? new Map(), health.data?.at ?? null, ini.data ?? [], stage?.config)
    : [];
  return {
    views,
    loading: on && machines.isLoading,
    fetching: machines.isFetching || health.isFetching,
    error: on ? machines.error : new Error("浏览器预览没有后端：在原生 App 里打开才能读到机器"),
    healthAt: health.data?.at ?? null,
    refetch: () => {
      void machines.refetch();
      void gpu.refetch();
      void health.refetch();
      void ini.refetch();
    },
  };
}

/** 纳管机器清单（别的域只要名单时用，和集群页共用缓存）。 */
export function useMachineList() {
  return useQuery({ queryKey: cacheKeys.machines, queryFn: listMachines, enabled: isTauri() });
}

export function useMachineDetail(id: number | null) {
  return useQuery({ queryKey: cacheKeys.detail(id ?? 0), queryFn: () => getMachineDetail(id as number), enabled: isTauri() && id != null });
}

/** 工程根目录（巡检 INI 时需要）。 */
async function projectRoots(): Promise<string[]> {
  const projects = await listProjects();
  const locs = await Promise.all(projects.map((p) => listProjectLocations(p.id).catch(() => [])));
  return Array.from(new Set(locs.flat().map((l) => l.abs_path).filter(Boolean)));
}

/** 立即巡检：先 INI 一致性，再健康巡检（顺序同旧版：ini_consistency 探测读最新 INI 结果）。返回失败的环节。 */
export function useRunInspection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: number[]) => {
      if (!ids.length) throw new Error("没有可巡检的在线机器");
      const roots = await projectRoots().catch(() => []);
      const fail: string[] = [];
      await scanInis({ machine_ids: ids, credential_alias: "", project_paths: roots, user_profile_path: null }).catch((e) => fail.push(`INI 检查：${errMsg(e)}`));
      await runHealthCheck({ machine_ids: ids, credential_alias: "", project_paths: roots, expected_local_path: null, expected_shared_path: null }).catch((e) => fail.push(`健康巡检：${errMsg(e)}`));
      if (fail.length === 2) throw new Error(fail.join("；"));
      return fail;
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["cache"] });
    },
  });
}

/** 设置 › 巡检：启动后巡检一次 / 每隔 N 分钟巡检一次全部在线机器（Volo 开着时才执行）。 */
export function useAutoPatrol({ onStart, everyMin }: { onStart: boolean; everyMin: number | null }) {
  const list = useMachineList();
  const inspect = useRunInspection();
  const ids = useMemo(() => (list.data ?? []).filter((m) => m.id != null && m.status !== "offline").map((m) => m.id as number), [list.data]);
  const idsRef = useRef<number[]>([]);
  const busyRef = useRef(false);
  const startedRef = useRef(false);
  const mutate = inspect.mutate;
  useEffect(() => {
    idsRef.current = ids;
  }, [ids]);
  const run = useCallback(
    (why: string) => {
      const targets = idsRef.current;
      if (!targets.length || busyRef.current) return;
      busyRef.current = true;
      mutate(targets, {
        onSuccess: (fail) => {
          if (fail.length) toast(`${why}巡检部分完成：${fail.join("；")}`);
        },
        onError: (e) => toast(`${why}巡检失败：${errMsg(e)}`),
        onSettled: () => {
          busyRef.current = false;
        },
      });
    },
    [mutate],
  );
  useEffect(() => {
    if (!onStart || startedRef.current || !list.isSuccess) return;
    startedRef.current = true;
    run("启动时");
  }, [onStart, list.isSuccess, run]);
  useEffect(() => {
    if (!everyMin || everyMin <= 0) return;
    const t = setInterval(() => run("定时"), everyMin * 60_000);
    return () => clearInterval(t);
  }, [everyMin, run]);
}

export function useRefreshMachine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const r = await refreshMachine(id);
      if (r.error) throw new Error(r.error);
      return r;
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["cache"] }),
  });
}

export function useAddMachine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ hostname, ip }: { hostname: string; ip: string }) => addMachine(hostname, ip),
    onSettled: () => void qc.invalidateQueries({ queryKey: cacheKeys.machines }),
  });
}

export function useRemoveMachine() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => deleteMachine(id), onSettled: () => void qc.invalidateQueries({ queryKey: ["cache"] }) });
}

export function useRenameMachine() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, hostname }: { id: number; hostname: string }) => renameMachine(id, hostname), onSettled: () => void qc.invalidateQueries({ queryKey: ["cache"] }) });
}

export function useApplyFinding() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (findingId: number) => applyFinding(findingId, ""), onSettled: () => void qc.invalidateQueries({ queryKey: cacheKeys.ini }) });
}

export function useSkipFinding() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (findingId: number) => skipFinding(findingId), onSettled: () => void qc.invalidateQueries({ queryKey: cacheKeys.ini }) });
}

export function useSetUeUser() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, user }: { id: number; user: string }) => setUeRuntimeUser(id, user), onSettled: () => void qc.invalidateQueries({ queryKey: cacheKeys.ueUsers }) });
}

/** 某台机器上找到的 UE 工程（工程 × 该机器上的位置）。 */
export function useMachineProjects(id: number) {
  return useQuery({
    queryKey: [...cacheKeys.projectLocations, "machine", id],
    enabled: isTauri(),
    queryFn: async (): Promise<{ project: ProjectSummary; loc: ProjectLocation }[]> => {
      const projects = await listProjects();
      const per = await Promise.all(
        projects.map((p) =>
          listProjectLocations(p.id)
            .then((ls) => ls.filter((l) => l.machine_id === id).map((loc) => ({ project: p, loc })))
            .catch(() => []),
        ),
      );
      return per.flat();
    },
  });
}

/* ------------------------------- 格式化 ------------------------------- */

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** SQLite CURRENT_TIMESTAMP 是 UTC、无时区标记；补 Z 再按本地时区显示。 */
export function parseTs(ts: string): Date | null {
  const s = /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(" ", "T") + "Z";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 列表里的时间：今天 → 14:31；昨天 → 昨天 22:10；更早 → 11-23 09:12。 */
export function fmtTime(ts: string | null): string {
  if (!ts) return "—";
  const d = parseTs(ts);
  if (!d) return ts;
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return hm;
  if (diff === 1) return `昨天 ${hm}`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

/** Inspector 里的完整时间：2026-11-25 14:31:08 UTC+8。 */
export function fmtFull(ts: string | null): string {
  if (!ts) return "—";
  const d = parseTs(ts);
  if (!d) return ts;
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset() / 60;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} UTC${off >= 0 ? "+" : ""}${off}`;
}
