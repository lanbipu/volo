// Volo · Cache 控制台 —— 全局状态（替代原型那个一坨 `s` 对象）。
//
// 提供：左导航、抽屉 / 浮层、任务抽屉（含 runTask 驱动真命令 + 长任务事件流）、NDJSON 控制台。
// 视图层通过 useCache() 读写；runTask 既能跑一次性真命令，也能驱动长任务进度。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CacheNav } from "./nav";
import type { ChannelKey } from "../ui/status";

/* ---------------- 控制台日志（NDJSON 流） ---------------- */
export type LogLevel = "info" | "ok" | "warn" | "err";
export interface LogEntry {
  ts: string;
  lv: LogLevel;
  cat: string;
  ch?: ChannelKey | null;
  task?: number | null;
  msg: string;
}

/* ---------------- 任务抽屉 ---------------- */
export type TaskState = "queued" | "running" | "success" | "failed";
export interface TaskLine {
  lv?: LogLevel;
  msg: string;
}
export interface Task {
  id: string;
  no: number;
  domain: string;
  action: string;
  title: string;
  state: TaskState;
  pct: number;
  chan: ChannelKey;
  started: string;
  elapsed: string;
  target: string;
  note: string;
  stream?: boolean;
  exit?: number;
  stderr?: string;
  channelFail?: boolean;
  jobId?: string | null;
}

/** runTask 的 run() 拿到的上下文：可更新本任务进度 + 推日志。长任务事件流用它驱动。 */
export interface RunCtx {
  update: (patch: Partial<Task>) => void;
  log: (entry: Omit<LogEntry, "ts">) => void;
  /** 确认浮层最终勾选的机器范围（破坏性/分发类用它做真实目标，见 PreviewPanel）。 */
  scope: number[];
}

export interface RunTaskOpts {
  domain: string;
  action: string;
  target: string;
  chan?: ChannelKey;
  note: string;
  /** 展示用 NDJSON 行（按节奏推进控制台）。可与 run 并存。 */
  lines?: TaskLine[];
  /** 真实执行：resolve → success，reject → failed（错误进 stderr）。 */
  run?: (ctx: RunCtx) => Promise<unknown>;
  /**
   * 长任务（后端返回 job_id、远端异步跑：generate_ddc_pak / start_pso_collection / distribute_*）。
   * 标 true 时：run() resolve 只表示「已下发」，**不**判成功（避免远端还在跑就显示完成）；
   * 任务保持 running + 可取消，直到用户取消（真正完成需后端事件接入，待办）。reject 仍判失败。
   */
  job?: boolean;
  /** 确认浮层传入的最终机器范围，喂给 ctx.scope。 */
  scope?: number[];
  /** 无 run 时的纯演示失败标记。 */
  fail?: boolean;
}

/* ---------------- 抽屉 / 浮层规格 ---------------- */
export interface AffScopeRow {
  host: string;
  ip: string;
  msg?: string;
}
export interface ReadbackSpec {
  key: string;
  expected: string;
}
export type DiffLine = ["del" | "add", string];

export interface PreviewSpec {
  title: string;
  icon: string;
  cli: string;
  destructive?: boolean;
  channel?: ChannelKey;
  confirmLabel?: string;
  steps?: string[];
  /** 已知具体目标设备（不走机器选择器）。 */
  simpleScope?: AffScopeRow[];
  /** 走机器选择器时的初始勾选（机器 id 列表）。 */
  scope?: number[];
  readback?: ReadbackSpec;
  backup?: string;
  diff?: DiffLine[];
  ctx?: string;
  confirmInput?: boolean;
  /** 确认后执行的任务。 */
  task?: RunTaskOpts;
  /** 确认后的额外副作用（更新本地视图状态）。 */
  onConfirm?: () => void;
}

export type Drawer =
  | ({ kind: "preview" } & PreviewSpec)
  | { kind: "machine"; id: number }
  | { kind: "script"; id: number } // SSH key 现场入网脚本面板（get_winrm_bootstrap_script）
  | { kind: "creds" } // 凭据管理（SecretStore：list/save/delete）
  | null;

/* ---------------- store 形态 ---------------- */
export interface CacheStore {
  nav: CacheNav;
  setNav: (n: CacheNav) => void;
  ddcOpen: boolean;
  setDdcOpen: (v: boolean | ((p: boolean) => boolean)) => void;

  drawer: Drawer;
  setDrawer: (d: Drawer) => void;
  openPreview: (spec: PreviewSpec) => void;
  /** 本会话内已「跑过入网脚本 + 刷新通过」的机器（SSH key 现场入网）。 */
  enrolled: number[];
  markEnrolled: (id: number) => void;

  tasks: Task[];
  taskTab: "active" | "history";
  setTaskTab: (t: "active" | "history") => void;
  runTask: (opts: RunTaskOpts) => void;
  cancelTask: (id: string) => void;

  logs: LogEntry[];
  pushLog: (entry: Omit<LogEntry, "ts">) => void;
  logOpen: boolean;
  setLogOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  logFilter: "all" | "info" | "warn" | "err";
  setLogFilter: (f: "all" | "info" | "warn" | "err") => void;
  logSearch: string;
  setLogSearch: (s: string) => void;
  logPaused: boolean;
  setLogPaused: (v: boolean | ((p: boolean) => boolean)) => void;
  logH: number;
  setLogH: (h: number) => void;
}

const Ctx = createContext<CacheStore | null>(null);

const hm = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const hms = () => {
  const d = new Date();
  return (
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:` +
    `${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`
  );
};

export function CacheProvider({ children }: { children: ReactNode }) {
  const [nav, setNav] = useState<CacheNav>("home");
  const [ddcOpen, setDdcOpen] = useState(true);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const TASK_CAP = 300; // 任务列表上限（与 logs 的 800 行上限对应）
  const [taskTab, setTaskTab] = useState<"active" | "history">("active");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(true);
  const [logFilter, setLogFilter] = useState<"all" | "info" | "warn" | "err">("all");
  const [logSearch, setLogSearch] = useState("");
  const [logPaused, setLogPaused] = useState(false);
  const [logH, setLogH] = useState(150);
  const seq = useRef(1);
  // 每个任务的待清理定时器（creep 进度条 + 展示日志 setTimeout），取消/卸载时清掉。
  const timers = useRef<
    Map<string, { creep?: ReturnType<typeof setInterval>; timeouts: ReturnType<typeof setTimeout>[] }>
  >(new Map());
  // 已落定（成功/失败/取消）的任务 id —— finalize 据此不覆盖已取消态、不重复落定。
  const settled = useRef<Set<string>>(new Set());

  const clearTimers = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (!t) return;
    if (t.creep) clearInterval(t.creep);
    t.timeouts.forEach(clearTimeout);
    timers.current.delete(id);
  }, []);

  // 卸载时清掉所有遗留定时器（避免 run promise 永不 settle 时 interval 泄漏）。
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) {
        if (t.creep) clearInterval(t.creep);
        t.timeouts.forEach(clearTimeout);
      }
      map.clear();
    };
  }, []);

  const pushLog = useCallback((entry: Omit<LogEntry, "ts">) => {
    // 控制台日志封顶，避免长会话无界增长。
    setLogs((prev) => [{ ts: hms(), ...entry }, ...prev].slice(0, 800));
  }, []);

  const openPreview = useCallback((spec: PreviewSpec) => {
    setDrawer({ kind: "preview", ...spec });
  }, []);

  const [enrolled, setEnrolled] = useState<number[]>([]);
  const markEnrolled = useCallback(
    (id: number) => setEnrolled((v) => (v.includes(id) ? v : [...v, id])),
    [],
  );

  const cancelTask = useCallback(
    (id: string) => {
      settled.current.add(id); // 标记已落定：之后 run promise resolve 不再翻成功
      clearTimers(id);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === id && t.state === "running"
            ? { ...t, state: "failed", note: "已取消", exit: 130 }
            : t,
        ),
      );
      pushLog({ lv: "warn", cat: "job", task: null, msg: "任务已请求取消" });
    },
    [pushLog, clearTimers],
  );

  const runTask = useCallback(
    (opts: RunTaskOpts) => {
      const { domain, action, target, chan = "ssh", note, lines = [], run, job, scope = [], fail } =
        opts;
      const no = seq.current++;
      const id = "t_" + no;
      timers.current.set(id, { timeouts: [] });
      const entry = timers.current.get(id)!;
      setTasks((prev) => {
        const next = [
          {
            id,
            no,
            domain,
            action,
            title: `${domain} ${action}`,
            state: "running" as const,
            pct: 4,
            chan,
            started: hm(),
            elapsed: "0s",
            target,
            note,
            stream: lines.length > 2,
          },
          ...prev,
        ];
        // 与 logs 同样设上限，避免长会话无界增长；裁掉的任务一并从 settled 集合里清理。
        if (next.length > TASK_CAP) {
          const capped = next.slice(0, TASK_CAP);
          const keep = new Set(capped.map((t) => t.id));
          for (const sid of settled.current) if (!keep.has(sid)) settled.current.delete(sid);
          return capped;
        }
        return next;
      });
      setTaskTab("active");
      setLogOpen(true);

      const patch = (p: Partial<Task>) =>
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...p } : t)));

      // 展示用 NDJSON 行按节奏推进（与真实 run 并行，只为可视化）；句柄入册，取消/落定后不再补推。
      const n = Math.max(lines.length, 1);
      lines.forEach((ln, i) =>
        entry.timeouts.push(
          setTimeout(() => {
            if (settled.current.has(id)) return;
            pushLog({ lv: ln.lv || "info", cat: domain, ch: chan, task: no, msg: ln.msg });
            if (!run)
              patch({ pct: Math.min(96, Math.round(((i + 1) / n) * 100)), elapsed: `${i + 1}s` });
          }, 420 * (i + 1)),
        ),
      );

      const startMs = Date.now();
      // 落定：只在任务仍未取消/未落定时改写状态（修复 finalize 覆盖「已取消」态）。
      const finalize = (ok: boolean, stderr?: string) => {
        if (settled.current.has(id)) return;
        settled.current.add(id);
        clearTimers(id);
        patch({
          state: ok ? "success" : "failed",
          pct: 100,
          exit: ok ? 0 : 2,
          ...(stderr ? { stderr } : {}),
        });
        pushLog(
          ok
            ? { lv: "ok", cat: domain, ch: chan, task: no, msg: `<b>${domain} ${action} #${no}</b> 完成` }
            : { lv: "err", cat: domain, ch: chan, task: no, msg: `<b>${domain} ${action} #${no}</b> 失败 · exit 2` },
        );
      };

      if (run) {
        // 真任务进度条：4%→90% 缓爬，到顶即停（避免空转 setState）。
        let p = 4;
        entry.creep = setInterval(() => {
          p += 3;
          patch({ pct: Math.min(90, p), elapsed: `${Math.round((Date.now() - startMs) / 1000)}s` });
          if (p >= 90 && entry.creep) {
            clearInterval(entry.creep);
            entry.creep = undefined;
          }
        }, 700);
        run({ update: patch, log: (e) => pushLog({ ...e, task: no, ch: e.ch ?? chan }), scope })
          .then(() => {
            // 长任务：resolve 只表示「已下发」，保持 running + 可取消，不判完成
            //（避免远端 UE 还在编译/收集就显示成功；真正完成待后端事件接入）。
            if (job) {
              if (settled.current.has(id)) return;
              if (entry.creep) {
                clearInterval(entry.creep);
                entry.creep = undefined;
              }
              patch({ note: note + " · 已下发后台执行（可取消）" });
            } else {
              finalize(true);
            }
          })
          .catch((err) => finalize(false, String(err?.message ?? err)));
      } else {
        // 纯演示：行推完后落定（沿用原型节奏）。
        entry.timeouts.push(setTimeout(() => finalize(!fail), 420 * (n + 1)));
      }
    },
    [pushLog, clearTimers],
  );

  const value = useMemo<CacheStore>(
    () => ({
      nav,
      setNav,
      ddcOpen,
      setDdcOpen,
      drawer,
      setDrawer,
      openPreview,
      enrolled,
      markEnrolled,
      tasks,
      taskTab,
      setTaskTab,
      runTask,
      cancelTask,
      logs,
      pushLog,
      logOpen,
      setLogOpen,
      logFilter,
      setLogFilter,
      logSearch,
      setLogSearch,
      logPaused,
      setLogPaused,
      logH,
      setLogH,
    }),
    [
      nav,
      ddcOpen,
      drawer,
      openPreview,
      enrolled,
      markEnrolled,
      tasks,
      taskTab,
      runTask,
      cancelTask,
      logs,
      pushLog,
      logOpen,
      logFilter,
      logSearch,
      logPaused,
      logH,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCache(): CacheStore {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCache must be used within CacheProvider");
  return v;
}
