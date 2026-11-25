/* 待处理（设计：Inbox.dc.html，概览页下半部分复用）。
   每一条是从现状推出来的“需要人处理的事”：机器巡检未通过 / 连不上、镜头残差偏高、上屏拓扑有问题、
   共享目录缺凭据、PSO 预热失败、本次会话里失败的重建 / 空间求解。
   现状好了，这条就不再出现，自动记到“已处理”；已读 / 已处理记在本机。 */
import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { IconName, StatusKind } from "@/ui";
import type { ObjectTab, PageId } from "@/lib/nav";
import { persistOptions } from "@/lib/persist";
import { useMachines, type MachineView } from "@/features/cache";
import { camTab, RMS_ADOPT_PX, resolveTopology, validateTopology } from "@/features/led";
import { useCredRows } from "@/features/settings";
import { useCurrentStage } from "@/features/stage";
import { tsMs, type TaskRow } from "./tasks";

export type IssueScope = "stage" | "cluster";

export interface Issue {
  id: string;
  icon: IconName;
  kind: StatusKind;
  kindLabel: string;
  /** Inspector 头部的类别（摄影机 / 机器 / 上屏 …）。 */
  area: string;
  scope: IssueScope;
  title: string;
  sub: string;
  /** Inspector 里的说明（没有就用 sub）。 */
  note?: string;
  at: number | null;
  object: string;
  blocks: string | null;
  from: string | null;
  until: string;
  target: { page: PageId; tab?: ObjectTab; label: string };
  /** 主操作（例如“重新巡检”）；没有就只给“打开”。 */
  action?: "inspect";
  machineId?: number;
  /** 舞台范围的条目属于哪个 Stage（换了 Stage 就看不到它的现状，不能当成“已恢复”）。 */
  stagePath?: string;
}

export interface DoneIssue {
  id: string;
  icon: IconName;
  area: string;
  scope: IssueScope;
  title: string;
  sub: string;
  doneAt: number;
  auto: boolean;
  stagePath?: string;
}

/* ------------------------------ 本机状态 ------------------------------ */

interface InboxStore {
  read: Record<string, true>;
  done: Record<string, DoneIssue>;
  /** 上一次看到的条目（用来判断哪些“消失”了）。 */
  seen: Record<string, DoneIssue>;
  markRead: (ids: string[]) => void;
  markDone: (issue: Issue) => void;
  /** stagePath = 当前 Stage；别的 Stage 的条目不在列表里不代表恢复了，原样留在 seen 里。 */
  sync: (active: Issue[], stagePath: string | null) => void;
}

const snap = (i: Issue, auto: boolean): DoneIssue => ({ id: i.id, icon: i.icon, area: i.area, scope: i.scope, title: i.title, sub: i.sub, doneAt: Date.now(), auto, stagePath: i.stagePath });

export const useInboxStore = create<InboxStore>()(
  persist(
    (set) => ({
      read: {},
      done: {},
      seen: {},
      markRead: (ids) => set((s) => ({ read: { ...s.read, ...Object.fromEntries(ids.map((id) => [id, true as const])) } })),
      markDone: (issue) => set((s) => ({ done: { ...s.done, [issue.id]: snap(issue, false) }, read: { ...s.read, [issue.id]: true } })),
      sync: (active, stagePath) =>
        set((s) => {
          const ids = new Set(active.map((i) => i.id));
          const done = { ...s.done };
          const carried: Record<string, DoneIssue> = {};
          let changed = false;
          for (const [id, prev] of Object.entries(s.seen)) {
            if (ids.has(id) || done[id]) continue;
            if (prev.stagePath && prev.stagePath !== stagePath) {
              carried[id] = prev;
              continue;
            }
            done[id] = { ...prev, doneAt: Date.now(), auto: true };
            changed = true;
          }
          /* 又出现了的条目：从“已处理”里拿掉（手动标的除外），重新算未读。 */
          const read = { ...s.read };
          for (const i of active) {
            if (done[i.id]?.auto) {
              delete done[i.id];
              delete read[i.id];
              changed = true;
            }
          }
          const seen: Record<string, DoneIssue> = { ...carried, ...Object.fromEntries(active.map((i) => [i.id, snap(i, true)])) };
          const sameSeen = Object.keys(seen).length === Object.keys(s.seen).length && Object.keys(seen).every((k) => s.seen[k]?.title === seen[k].title);
          if (!changed && sameSeen) return s;
          /* “已处理”只留最近 50 条；手动标的、现状还在的条目必须留着，否则它会以未读重新冒出来。 */
          const entries = Object.entries(done).sort((a, b) => b[1].doneAt - a[1].doneAt);
          const pinned = entries.filter(([id, d]) => !d.auto && seen[id]);
          const rest = entries.filter(([id, d]) => d.auto || !seen[id]).slice(0, Math.max(0, 50 - pinned.length));
          return { done: Object.fromEntries([...pinned, ...rest]), read, seen };
        }),
    }),
    persistOptions<InboxStore, Pick<InboxStore, "read" | "done" | "seen">>("tasks.inbox", 1, ({ read, done, seen }) => ({ read, done, seen })),
  ),
);

/* ------------------------------ 来源 ------------------------------ */

function machineIssues(views: MachineView[], healthAt: string | null): Issue[] {
  const at = tsMs(healthAt);
  const out: Issue[] = [];
  for (const v of views) {
    const tab = { id: `machine:${v.id}`, label: v.host };
    if (v.state === "failed") {
      const bad = v.checks.filter((c) => c.status === "fail");
      const first = bad[0];
      out.push({
        id: `machine:${v.id}:failed`,
        icon: "machine",
        kind: "failed",
        kindLabel: "需处理",
        area: "机器",
        scope: "cluster",
        title: `${v.host}：${v.summary}`,
        sub: first ? first.message || first.remediation || `${first.label}未通过` : (v.findings[0]?.symptom ?? "工程配置有需要调整的项"),
        note: first?.remediation || undefined,
        at,
        object: `机器 › ${v.host}`,
        blocks: v.output ? `上屏节点 ${v.output.node}` : null,
        from: "巡检",
        until: "重新巡检全部通过后，这一条自动移到“已处理”",
        target: { page: "machines", tab, label: "机器" },
        action: "inspect",
        machineId: v.id,
      });
    } else if (v.state === "offline") {
      out.push({
        id: `machine:${v.id}:offline`,
        icon: "machine",
        kind: "offline",
        kindLabel: "离线",
        area: "机器",
        scope: "cluster",
        title: `${v.host} 连不上`,
        sub: v.lastSeen ? `上次在线 ${new Date(tsMs(v.lastSeen) ?? 0).toLocaleString("zh-CN", { hour12: false })}。在它连上之前，巡检、部署和上屏都会跳过它。` : "在它连上之前，巡检、部署和上屏都会跳过它。",
        at: tsMs(v.lastSeen),
        object: `机器 › ${v.host}`,
        blocks: v.output ? `上屏节点 ${v.output.node}` : null,
        from: "巡检",
        until: "这台机器重新连上后，这一条自动移到“已处理”",
        target: { page: "machines", tab, label: "机器" },
        action: "inspect",
        machineId: v.id,
      });
    }
  }
  return out;
}

/** 同一件事的任务归成一组：同一工程 + 机器的 PSO 预热、同一摄影机的标定、同一块屏的重建、空间求解。 */
function taskGroup(t: TaskRow): string | null {
  if (t.id.startsWith("pso:")) return `pso|${t.title}`;
  if (t.tag === "摄影机" || t.tag === "重建") return `${t.tag}|${t.short}`;
  if (t.tag === "空间求解") return "spatial";
  return null;
}

/** 失败的任务：每组只看最近一次结束（成功 / 失败）的任务，最近一次是失败才算待处理。
    之后重新跑成功了，这一条就不再出现，自动记到“已处理”。 */
function taskIssues(tasks: TaskRow[], stagePath: string | null): Issue[] {
  const latest = new Map<string, TaskRow>();
  for (const t of tasks) {
    if (t.state !== "failed" && t.state !== "success") continue;
    const g = taskGroup(t);
    if (!g) continue;
    const prev = latest.get(g);
    if (!prev || (t.startedAt ?? 0) > (prev.startedAt ?? 0)) latest.set(g, t);
  }
  const out: Issue[] = [];
  for (const t of latest.values()) {
    if (t.state !== "failed" || t.stateLabel === "已取消" || t.id.startsWith("pso:")) continue;
    out.push({
      id: `task:${t.id}`,
      icon: t.tag === "重建" ? "rebuild" : t.tag === "空间求解" ? "spatial" : "camera",
      kind: "failed",
      kindLabel: "需处理",
      area: t.tag,
      scope: t.scope,
      title: `${t.short}失败`,
      sub: t.progress ?? "任务失败",
      at: t.startedAt,
      object: t.target?.label ?? t.tag,
      blocks: null,
      from: `任务 ${t.no ?? ""} ${t.short}`.replace(/\s+/g, " ").trim(),
      until: "重新跑一次成功后，这一条自动移到“已处理”",
      target: t.target ?? { page: "tasks", label: "任务" },
      stagePath: t.scope === "stage" && stagePath ? stagePath : undefined,
    });
  }
  for (const t of latest.values()) {
    if (t.state !== "failed" || t.stateLabel === "已取消" || !t.id.startsWith("pso:")) continue;
    out.push({
      id: `task:${t.id}`,
      icon: "pso",
      kind: "failed",
      kindLabel: "需处理",
      area: "PSO 预热",
      scope: "cluster",
      title: `${t.title.replace(/^PSO 预热 · /, "")} 的 PSO 预热没有通过`,
      sub: t.progress ?? "预热失败",
      at: t.startedAt,
      object: "PSO 预热",
      blocks: "上场时这台机器可能卡顿",
      from: `任务 ${t.no ?? ""} PSO 预热`.replace(/\s+/g, " "),
      until: "同一工程在这台机器上重新预热通过后，这一条自动移到“已处理”",
      target: { page: "pso", label: "PSO 预热" },
    });
  }
  return out;
}

export function useIssues(tasks: TaskRow[]) {
  const { stage, loading: stageLoading } = useCurrentStage();
  const machines = useMachines();
  const creds = useCredRows();
  const out: Issue[] = [...machineIssues(machines.views, machines.healthAt)];

  const cfg = stage?.config;
  if (stage && cfg) {
    for (const c of cfg.cameras ?? []) {
      const rms = c.lens?.calibration_rms_px;
      if (rms == null || rms < RMS_ADOPT_PX) continue;
      const label = c.lens?.focal_mm ? `${c.name} · ${+c.lens.focal_mm.toFixed(1)} mm` : c.name;
      out.push({
        id: `lens:${stage.path}:${c.id}`,
        icon: "camera",
        kind: "failed",
        kindLabel: "需处理",
        area: "摄影机",
        scope: "stage",
        title: `${label} 的镜头标定残差偏高`,
        sub: `重投影 RMS ${rms.toFixed(2)} px，阈值 ${RMS_ADOPT_PX.toFixed(2)} px。补采后重新求解。`,
        note: `重投影 RMS ${rms.toFixed(2)} px，超过阈值 ${RMS_ADOPT_PX.toFixed(2)} px。在它修好之前，用这支镜头做的网格重建不可信。`,
        at: null,
        object: `摄影机 › ${label}`,
        blocks: stage.type === "ar" ? "上场就绪“摄影机”，以及依赖它的空间求解" : "上场就绪“摄影机”，以及依赖它的网格重建",
        from: "镜头标定",
        until: "重新求解后 RMS 低于阈值，这一条自动移到“已处理”",
        target: { page: "camera", tab: camTab(c), label: "摄影机" },
        stagePath: stage.path,
      });
    }
    const topo = resolveTopology(cfg);
    if (topo && topo.nodes.length) {
      const issues = validateTopology(topo, cfg);
      if (issues.length) {
        out.push({
          id: `topo:${stage.path}`,
          icon: "output",
          kind: "attention",
          kindLabel: "需检查",
          area: "上屏",
          scope: "stage",
          title: `上屏拓扑有 ${issues.length} 处问题`,
          sub: issues.map((i) => i.text).join("；"),
          at: null,
          object: `上屏 › ${stage.name}`,
          blocks: "上场就绪“上屏输出”",
          from: "上屏拓扑检查",
          until: "改好拓扑后，这一条自动移到“已处理”",
          target: { page: "output", label: "上屏" },
          stagePath: stage.path,
        });
      }
    }
  }

  for (const r of creds.rows) {
    if (r.group !== "share" || r.state !== "attention" || !r.share) continue;
    out.push({
      id: `share:${r.share.id ?? r.share.unc_path}`,
      icon: "key",
      kind: "attention",
      kindLabel: "缺凭据",
      area: "凭据",
      scope: "cluster",
      title: `共享目录 ${r.share.unc_path} 缺凭据`,
      sub: `${r.machine} 上的共享目录需要账户才能读写，本机凭据库里没有${r.share.credential_alias ? `“${r.share.credential_alias}”` : "对应的条目"}。`,
      at: null,
      object: `凭据 › ${r.share.unc_path}`,
      blocks: "旧版缓存（共享目录）的读写",
      from: "凭据检查",
      until: "在“设置与凭据”里补上凭据后，这一条自动移到“已处理”",
      target: { page: "settings", label: "设置与凭据" },
    });
  }

  out.push(...taskIssues(tasks, stage?.path ?? null));
  const order: Record<string, number> = { failed: 0, attention: 1, offline: 2 };
  out.sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3) || (b.at ?? 0) - (a.at ?? 0));
  /* 每个来源都读到了才算 loaded：缺一个来源时它的条目会“消失”，同步时会被误记成已恢复。 */
  return { issues: out, loading: machines.loading || stageLoading || creds.loading, healthAt: machines.healthAt, stagePath: stage?.path ?? null };
}

/** 跟踪“消失”的条目（外壳常驻调用一次）。只在后端数据都读到之后同步，免得启动瞬间把全部条目记成已处理。 */
export function useInboxSync(issues: Issue[], ready: boolean, stagePath: string | null) {
  const sync = useInboxStore((s) => s.sync);
  const key = issues.map((i) => `${i.id}|${i.title}`).join("\n");
  useEffect(() => {
    if (ready) sync(issues, stagePath);
    // 以 key 代表 issues 的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready, stagePath, sync]);
}

/** 待处理的当前视图：活动条目（去掉手动标为已处理的）、未读、已处理。 */
export function useInbox(tasks: TaskRow[], tasksReady: boolean) {
  const { issues, loading, healthAt, stagePath } = useIssues(tasks);
  const read = useInboxStore((s) => s.read);
  const done = useInboxStore((s) => s.done);
  const active = issues.filter((i) => !done[i.id] || done[i.id].auto);
  const unread = active.filter((i) => !read[i.id]).length;
  const doneList = Object.values(done).sort((a, b) => b.doneAt - a.doneAt);
  return { issues: active, unread, read, done: doneList, loading, ready: !loading && tasksReady, all: issues, healthAt, stagePath };
}
