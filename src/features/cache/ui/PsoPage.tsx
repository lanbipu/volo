/* 集群 › PSO 预热（设计：Pso.dc.html）。矩阵：一行 = 一个工程，一列 = 一台机器，格子 = 这台机器上的 PSO 绿灯状态。
   Inspector：节点 / 预热设置（与工程详情同一块表单）/ 历史（list_pso_warmup_runs）。
   “PSO 个数”后端没有数据 → 节点列表只写状况；“验证” = 冷启动验证（start_pso_coldtest，先清空驱动缓存再跑）。 */
import { useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN } from "@/lib/nav";
import { errText, toast } from "@/lib/toast";
import {
  Activity,
  Button,
  ChipFilter,
  Crumbs,
  Empty,
  GroupRow,
  HeadRow,
  IconButton,
  Inspector,
  InspectorBody,
  InspectorHead,
  InspectorToggle,
  Meta,
  Note,
  Props,
  Row,
  RowEnd,
  RowTitle,
  Search,
  Sep,
  Spacer,
  Status,
  Table,
  TableBody,
  Tag,
  Toolbar,
  ToolTabs,
  Workspace,
  type ActivityItem,
  type StatusKind,
} from "@/ui";
import type { Machine, PsoWarmupRun } from "@/api/types";
import { useClusterUi } from "../model/clusterUi";
import { fmtFull, fmtTime, parseTs } from "../model/machines";
import { isOffline } from "../model/cache";
import { emptySettings, targetIds, usePsoPrefs, usePsoRuns, usePsoSettings, useStartWarmup } from "../model/pso";
import { useProjects, type CopyView, type ProjectView } from "../model/projects";
import { useClusterMachines } from "./ProjectsPage";
import { PsoSettingsForm } from "./PsoSettingsForm";
import css from "./cachePage.module.css";

type Filter = "all" | "need" | "ready";

const REASON_TAG: Record<string, string> = {
  gpu_driver_changed: "GPU 驱动变更",
  cache_shrunk: "驱动缓存被清过",
  cache_directory_missing: "驱动缓存目录不见了",
  interactive_user_changed: "登录用户换了",
  node_rebooted: "机器重启过",
};

const REASON_NOTE: Record<string, string> = {
  gpu_driver_changed: "的 GPU 驱动在预热之后变了，原有的 PSO 缓存不再适用。先修好驱动再预热，否则还会再过期一次。",
  cache_shrunk: "的显卡驱动缓存被清理过，原有的 PSO 缓存已经不完整。重新预热一次即可。",
  cache_directory_missing: "的显卡驱动缓存目录不见了，原有的 PSO 缓存不再存在。重新预热一次即可。",
  interactive_user_changed: "登录桌面的用户换了，驱动缓存跟着用户走，原有的 PSO 缓存用不上。用上屏的那个用户重新预热。",
  node_rebooted: "重启过，驱动缓存可能已被清掉。重新预热一次即可。",
};

interface Cell {
  machine: Machine;
  copy: CopyView | null;
  kind: StatusKind | null;
  label: string;
}

interface PsoRow {
  v: ProjectView;
  cells: Cell[];
  need: CopyView[];
  online: CopyView[];
  reason: string | null;
  last: string | null;
}

function buildRow(v: ProjectView, machines: Machine[]): PsoRow {
  const cells = machines.map((m): Cell => {
    const copy = v.copies.find((c) => c.loc.machine_id === m.id) ?? null;
    if (!copy) return { machine: m, copy, kind: null, label: "—" };
    if (copy.offline || isOffline(m)) return { machine: m, copy, kind: "offline", label: "离线" };
    if (copy.pso?.status === "ok") return { machine: m, copy, kind: "success", label: "就绪" };
    if (copy.pso?.status === "degraded") return { machine: m, copy, kind: "attention", label: "已过期" };
    return { machine: m, copy, kind: "queued", label: "未预热" };
  });
  const online = v.copies.filter((c) => !c.offline);
  const need = online.filter((c) => c.pso?.status !== "ok");
  const reason = v.copies.flatMap((c) => c.pso?.invalidation_reasons ?? []).map((r) => REASON_TAG[r.reason])[0] ?? null;
  const times = v.copies.map((c) => c.pso?.green_verified_at).filter((x): x is string => !!x).sort();
  return { v, cells, need, online, reason, last: times[times.length - 1] ?? null };
}

function dur(secs: number | null | undefined): string {
  if (secs == null) return "—";
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

export function PsoPage() {
  const { views, fetching, updatedAt, refetch } = useProjects();
  const machinesQ = useClusterMachines();
  const machines = [...(machinesQ.data ?? [])].sort((a, b) => a.hostname.localeCompare(b.hostname, "zh-CN", { numeric: true }));
  const psoProjectId = useClusterUi((s) => s.psoProjectId);
  const focusPso = useClusterUi((s) => s.focusPso);
  const [inspOpen, setInsp] = useInspector("pso");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const start = useStartWarmup();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA"))) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rows = views.map((v) => buildRow(v, machines));
  const needRows = rows.filter((r) => r.need.length > 0);
  const readyRows = rows.filter((r) => r.need.length === 0);
  const match = (r: PsoRow) => !q.trim() || r.v.name.toLowerCase().includes(q.trim().toLowerCase());
  const shown = rows.filter(match).filter((r) => (filter === "need" ? r.need.length > 0 : filter === "ready" ? r.need.length === 0 : true));
  const groups: [StatusKind, string, PsoRow[]][] = [
    ["attention", "需要预热", shown.filter((r) => r.need.length > 0)],
    ["success", "就绪", shown.filter((r) => r.need.length === 0)],
  ];
  const ordered = groups.flatMap((g) => g[2]);
  const selected = ordered.find((r) => r.v.id === psoProjectId) ?? ordered[0] ?? null;
  const cols = `minmax(200px, 1fr) ${machines.map(() => "104px").join(" ")} 96px`;

  const settingsQ = usePsoSettings(selected?.v.id ?? 0);
  const cold = usePsoPrefs((s) => (selected ? (s.coldVerify[String(selected.v.id)] ?? false) : false));

  const run = (r: PsoRow, ids: number[], asCold: boolean) => {
    const s = settingsQ.data ?? emptySettings(r.v.id);
    start.mutate(
      { settings: s, machineIds: ids, ue: r.v.ue, cold: asCold },
      {
        onSuccess: () => toast(`${asCold ? "已开始冷启动验证" : "已开始预热"} · ${r.v.name} · ${ids.length} 台`),
        onError: (e) => toast(`${asCold ? "验证" : "预热"}没有开始：${errText(e)}`),
      },
    );
  };
  /** 预热目标：需要预热的在线节点；若预跑设置里限定了机器，取交集。 */
  const targetsOf = (r: PsoRow) => {
    const limit = settingsQ.data ? targetIds(settingsQ.data) : [];
    const base = (r.need.length ? r.need : r.online).map((c) => c.loc.machine_id);
    return limit.length ? base.filter((id) => limit.includes(id)) : base;
  };

  return (
    <Workspace
      inspector={selected && <PsoInspector row={selected} width={inspW} onClose={() => setInsp(false)} onRun={(ids) => run(selected, ids, cold)} busy={start.isPending} />}
      inspectorOpen={inspOpen && !!selected}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      <Toolbar loc label="位置与对象操作">
        <Crumbs icon="pso" current="PSO 预热" />
        <Spacer />
        {selected && (
          <Meta>
            已选 {selected.v.name} · {selected.need.length ? `${selected.need.length} 个节点需要预热` : "全部就绪"}
          </Meta>
        )}
        <Button icon="success" disabled={!selected || start.isPending} onClick={() => selected && run(selected, selected.online.map((c) => c.loc.machine_id), true)}>
          验证
        </Button>
        <Button variant="primary" icon="play" disabled={!selected || start.isPending} onClick={() => selected && run(selected, targetsOf(selected), cold)}>
          开始预热
        </Button>
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>
      <Toolbar label="视图：筛选、搜索与显示">
        <ChipFilter<Filter>
          label="按状况筛选"
          value={filter}
          onChange={setFilter}
          options={[
            { key: "all", label: "全部", count: rows.length },
            { key: "need", label: "需要预热", count: needRows.length },
            { key: "ready", label: "就绪", count: readyRows.length },
          ]}
        />
        <Spacer />
        <Search ref={searchRef} value={q} onChange={setQ} placeholder="筛选…" aria-label="筛选工程" shortcut="/" />
        <IconButton icon="refresh" disabled={fetching} label={`刷新 · 上次 ${updatedAt ? new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}`} onClick={refetch} />
      </Toolbar>

      {rows.length ? (
        <Table label="工程与节点的预热状况">
          <HeadRow cols={cols}>
            <span>工程</span>
            {machines.map((m) => (
              <span key={m.id} className="ry-mono">
                {m.hostname}
              </span>
            ))}
            <RowEnd>上次预热</RowEnd>
          </HeadRow>
          <TableBody>
            {groups.map(([kind, label, list]) =>
              list.length
                ? [
                    <GroupRow key={`g-${label}`} kind={kind} label={label} count={list.length} />,
                    ...list.map((r) => (
                      <Row key={r.v.id} cols={cols} selected={selected === r} onSelect={() => focusPso(r.v.id)} onOpen={() => setInsp(true)}>
                        <RowTitle tags={r.reason ? <Tag>{r.reason}</Tag> : undefined}>{r.v.name}</RowTitle>
                        {r.cells.map((c) => (c.kind ? <Status key={c.machine.id} kind={c.kind} label={c.label} /> : <span key={c.machine.id} className="ry-meta">—</span>))}
                        <RowEnd>{fmtTime(r.last)}</RowEnd>
                      </Row>
                    )),
                  ]
                : null,
            )}
          </TableBody>
        </Table>
      ) : (
        <Empty icon="project" title="还没有工程">
          先在“工程”里扫描到工程，才能为它预热 PSO。
        </Empty>
      )}
    </Workspace>
  );
}

function PsoInspector({ row, width, onClose, onRun, busy }: { row: PsoRow; width: number; onClose: () => void; onRun: (ids: number[]) => void; busy: boolean }) {
  const [tab, setTab] = useState<"nodes" | "settings" | "history">("nodes");
  const v = row.v;
  const runs = usePsoRuns(v.id);
  const settings = usePsoSettings(v.id);
  const list: PsoWarmupRun[] = [...(runs.data ?? [])].sort((a, b) => (parseTs(b.started_at ?? "")?.getTime() ?? 0) - (parseTs(a.started_at ?? "")?.getTime() ?? 0));
  const lastRun = list[0] ?? null;
  const okRuns = list.filter((r) => r.status === "ok" && r.duration_secs != null);
  const est = okRuns.length ? Math.round(okRuns.reduce((a, r) => a + (r.duration_secs ?? 0), 0) / okRuns.length / 60) : null;
  const s = settings.data;
  const n = row.online.length;
  const need = row.need;
  const degraded = v.copies.filter((c) => c.pso?.status === "degraded");
  const src = v.source;
  const ids = need.map((c) => c.loc.machine_id);
  const cmd = `voloctl pso warmup --project-id ${v.id} --targets ${(ids.length ? ids : row.online.map((c) => c.loc.machine_id)).join(",") || "<机器>"}`;
  const hostOf = (id: number) => v.copies.find((c) => c.loc.machine_id === id)?.host ?? `#${id}`;

  const nodeItems: ActivityItem[] = [...v.copies]
    .sort((a, b) => a.host.localeCompare(b.host, "zh-CN", { numeric: true }))
    .map((c) => {
      const green = list.find((r) => r.id != null && r.id === c.pso?.green_run_id);
      if (c.offline) return { key: String(c.loc.machine_id), icon: "offline", text: <><span className="ry-mono">{c.host}</span> · 离线</>, time: "—" };
      if (c.pso?.status === "ok")
        return { key: String(c.loc.machine_id), icon: "success", iconColor: "var(--status-success)", text: <><span className="ry-mono">{c.host}</span> · 就绪</>, time: dur(green?.duration_secs) };
      if (c.pso?.status === "degraded") {
        const r = c.pso.invalidation_reasons[0];
        const detail = r ? `${r.reason === "gpu_driver_changed" ? "驱动 " : ""}${r.detail || REASON_TAG[r.reason] || r.reason}` : "";
        return { key: String(c.loc.machine_id), icon: "attention", iconColor: "var(--volo-attention)", text: <><span className="ry-mono">{c.host}</span> · 已过期{detail ? ` · ${detail}` : ""}</>, time: "—" };
      }
      return { key: String(c.loc.machine_id), icon: "queued", text: <><span className="ry-mono">{c.host}</span> · 还没有预热</>, time: "—" };
    });

  const RUN_LABEL: Record<string, [ActivityItem["icon"], string | undefined, string]> = {
    running: ["spinner", "var(--status-running)", "进行中"],
    ok: ["success", "var(--status-success)", "就绪"],
    not_ready: ["attention", "var(--volo-attention)", "跑完但仍有卡顿"],
    err: ["failed", "var(--status-failed)", "失败"],
    cancelled: ["close", undefined, "已取消"],
  };

  return (
    <Inspector width={width}>
      <InspectorHead
        onClose={onClose}
        tabs={
          <ToolTabs
            label="Inspector 内容"
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "nodes", label: "节点" },
              { key: "settings", label: "预热设置" },
              { key: "history", label: "历史" },
            ]}
          />
        }
        meta={
          <>
            <span>工程</span>
            {need.length ? <Status kind="attention" label={`需要预热 · ${need.length} / ${n}`} pill size="sm" /> : <Status kind="success" label="就绪" pill size="sm" />}
          </>
        }
        title={v.name}
        actions={
          <>
            {need.length > 0 && (
              <Button disabled={busy} onClick={() => onRun(ids)}>
                {need.length === 1 ? `只预热 ${need[0].host}` : `预热 ${need.length} 台`}
              </Button>
            )}
            {lastRun?.id != null && (
              <Button onClick={() => setTab("history")}>
                上次任务 <span className="ry-mono">#{lastRun.id}</span>
              </Button>
            )}
          </>
        }
      />
      <InspectorBody>
        {tab === "nodes" && (
          <>
            {degraded.map((c) => {
              const r = c.pso?.invalidation_reasons[0]?.reason;
              return (
                <Note key={c.loc.machine_id} kind="attention" icon="attention">
                  <p>
                    <span className="ry-mono">{c.host}</span>
                    {(r && REASON_NOTE[r]) || " 的 PSO 缓存已过期，重新预热一次即可。"}
                  </p>
                </Note>
              );
            })}
            <Activity items={nodeItems} style={{ gap: 10, marginTop: degraded.length ? 16 : 0 }} />
            <Props
              className={css.propsGap}
              items={[
                { label: "工程", value: src ? <span className="ry-mono">{src.loc.uproject_path || `${src.loc.abs_path}\\${v.uproject}.uproject`}</span> : null },
                { label: "地图", value: s ? (s.map_path?.trim() ? s.map_path.split("/").pop() : "不遍历 · 固定机位") : null },
                { label: "画质", value: "与上屏一致" },
                { label: "预计", value: <span className="ry-num">{est != null ? `约 ${Math.max(1, est)} 分钟` : `最长 ${s?.max_minutes ?? 20} 分钟`} · 期间该节点黑场</span> },
                { label: "上次预热", value: row.last ? <span className="ry-num">{fmtFull(row.last)}</span> : null },
                { label: "命令", value: <span className="ry-mono">{cmd}</span>, action: <IconButton size="sm" icon="copy" label="复制等效命令" onClick={() => copyText(cmd)} /> },
              ]}
            />
          </>
        )}
        {tab === "settings" && <PsoSettingsForm v={v} />}
        {tab === "history" &&
          (list.length ? (
            <Activity
              items={list.map((r) => {
                const [icon, color, label] = RUN_LABEL[r.status] ?? ["queued", undefined, r.status];
                return {
                  key: String(r.id ?? `${r.machine_id}-${r.started_at}`),
                  icon,
                  iconColor: color,
                  text: (
                    <>
                      <span className="ry-mono">#{r.id ?? "—"}</span> · <span className="ry-mono">{hostOf(r.machine_id)}</span> · {r.mode === "coldtest" ? "冷启动验证" : "预热"} · {label}
                      {r.error_message ? ` · ${r.error_message}` : ""}
                    </>
                  ),
                  time: fmtTime(r.started_at),
                };
              })}
            />
          ) : (
            <Empty icon="clock" title="还没有预热记录">
              开始预热之后，每台机器的每一次运行都会记在这里。
            </Empty>
          ))}
      </InspectorBody>
    </Inspector>
  );
}
