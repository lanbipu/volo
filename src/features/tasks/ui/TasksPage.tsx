/* 任务（设计：TaskList.dc.html 列表 + Tasks.dc.html 详情）。
   列表按状态分组；单击选中 → Inspector，双击 / ↵ / “打开” → 任务详情页签 task:<id>。
   后端没有分步记录 / 日志 / 重试的类型：步骤与日志页签给空态，“从失败步骤重试”不可用。 */
import { useEffect, useRef, useState } from "react";
import type { ObjectTab } from "@/lib/nav";
import { useActiveObject, useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN } from "@/lib/nav";
import { copyText } from "@/lib/clipboard";
import { errText, toast } from "@/lib/toast";
import {
  Banner,
  Button,
  Chip,
  ChipFilter,
  Crumbs,
  Empty,
  GroupRow,
  IconButton,
  Inspector,
  InspectorBody,
  InspectorHead,
  InspectorToggle,
  Menu,
  MenuItem,
  Meter,
  Progress,
  Props,
  Row,
  RowEnd,
  RowTitle,
  Search,
  Sep,
  Skel,
  Spacer,
  Status,
  Table,
  TableBody,
  Tag,
  Toolbar,
  ToolTabs,
  Workspace,
  type PropItem,
} from "@/ui";
import { dur, fullAt, shortAt, TASK_STATE_LABEL, TASK_STATE_ORDER, useHealthSteps, useTasks, type TaskRow, type TaskState, type TaskStep } from "../model/tasks";
import css from "./tasks.module.css";

const COLS = "16px 40px minmax(200px, 1fr) max-content 168px 64px 84px";
type Scope = "all" | "stage" | "cluster";

export const taskTab = (t: TaskRow): ObjectTab => ({ id: `task:${t.id}`, label: `任务 ${t.no ?? ""} ${t.short}`.replace(/\s+/g, " "), status: t.state, statusLabel: t.stateLabel });

export function TasksPage() {
  const active = useActiveObject("tasks");
  const tasks = useTasks();
  const id = active?.startsWith("task:") ? active.slice(5) : null;
  return id ? <TaskDetail id={id} tasks={tasks} /> : <TaskList tasks={tasks} />;
}

type Tasks = ReturnType<typeof useTasks>;

function useSlashFocus() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA"))) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return ref;
}

function TaskList({ tasks }: { tasks: Tasks }) {
  const { rows, loading, fetching, error, refetch, updatedAt } = tasks;
  const openObject = useNav((s) => s.openObject);
  const [inspOpen, setInsp] = useInspector("tasks");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const [scope, setScope] = useState<Scope>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const searchRef = useSlashFocus();

  const s = q.trim().toLowerCase();
  const shown = rows.filter((t) => (scope === "all" || t.scope === scope) && (!s || `${t.no ?? ""} ${t.title} ${t.tag} ${t.progress ?? ""}`.toLowerCase().includes(s)));
  const selected = shown.find((t) => t.id === sel) ?? shown[0] ?? null;
  const open = (t: TaskRow) => openObject("tasks", taskTab(t));
  const options = [
    { key: "all" as Scope, label: "全部", count: rows.length },
    { key: "stage" as Scope, label: "舞台", count: rows.filter((t) => t.scope === "stage").length },
    { key: "cluster" as Scope, label: "集群", count: rows.filter((t) => t.scope === "cluster").length },
  ];
  const updated = updatedAt ? shortAt(updatedAt) : null;

  const inspector = selected ? (
    <TaskInspector t={selected} machines={tasks.machines} width={inspW} onClose={() => setInsp(false)} onOpen={() => open(selected)} />
  ) : (
    <aside className={`ry-inspector ${css.inspEmpty}`} aria-label="Inspector" style={{ width: inspW }}>
      <Empty icon="inspector" title="未选择任务">
        在列表中选择一行，这里会显示它的进度、步骤与属性。
      </Empty>
    </aside>
  );

  return (
    <Workspace inspector={inspector} inspectorOpen={inspOpen} inspectorWidth={inspW} onInspectorWidth={setInspW} minWidth={INSPECTOR_MIN} maxWidth={INSPECTOR_MAX}>
      <Toolbar loc label="位置与对象操作">
        <Crumbs icon="tasks" current="任务" />
        <Spacer />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>
      <Toolbar label="视图：筛选、搜索与显示">
        <ChipFilter label="按范围筛选" options={options} value={scope} onChange={setScope} />
        <Chip disabled>只看我发起的</Chip>
        <Spacer />
        <Search ref={searchRef} value={q} onChange={setQ} aria-label="筛选任务：编号、对象、机器" />
        <Button variant="ghost" icon="sliders" disabled title="显示选项还没接入">
          显示
        </Button>
        <IconButton icon="refresh" label={updated ? `刷新 · 上次 ${updated}` : "刷新"} onClick={refetch} aria-busy={fetching || undefined} />
      </Toolbar>
      <Progress on={fetching && !loading} />
      {error && !loading && (
        <Banner actions={<Button icon="refresh" onClick={refetch}>重试</Button>}>
          <b>刷新失败</b>：{errText(error)}
        </Banner>
      )}
      <Table label="任务">
        <TableBody>
          {loading &&
            [52, 40, 66, 58].map((w, i) => (
              <div key={i} className="ry-row" aria-hidden="true" style={{ ["--cols" as string]: COLS }}>
                <span>
                  <Skel circle />
                </span>
                <span>
                  <Skel width={28} />
                </span>
                <span>
                  <Skel width={`${w}%`} />
                </span>
                <span>
                  <Skel width={36} />
                </span>
                <span>
                  <Skel width={96} end />
                </span>
                <span>
                  <Skel width={40} end />
                </span>
                <span>
                  <Skel width={44} end />
                </span>
              </div>
            ))}
          {!loading && rows.length === 0 && !error && (
            <Empty icon="tasks" title="还没有任务记录">
              巡检、PSO 预热、重建、镜头标定和空间求解跑过之后会出现在这里。
            </Empty>
          )}
          {!loading && rows.length > 0 && shown.length === 0 && <Empty icon="search" title="没有匹配的任务">换个关键词，或清除筛选。</Empty>}
          {TASK_STATE_ORDER.map((st) => {
            const list = shown.filter((t) => t.state === st);
            if (!list.length) return null;
            return (
              <div key={st} className={css.contents}>
                <GroupRow kind={st} label={TASK_STATE_LABEL[st]} count={list.length} />
                {list.map((t) => (
                  <Row key={t.id} cols={COLS} selected={t.id === selected?.id} onSelect={() => setSel(t.id)} onOpen={() => open(t)}>
                    <Status kind={t.state} label={t.stateLabel} srOnly />
                    <span className="ry-row__id">{t.no ?? "—"}</span>
                    <RowTitle>{t.title}</RowTitle>
                    <span>
                      <Tag>{t.tag}</Tag>
                    </span>
                    <RowEnd>{t.meter ? <Meter inline label={t.meter.label} value={t.meter.value} max={t.meter.max} text={t.meter.text} role="progressbar" /> : (t.progress ?? "—")}</RowEnd>
                    <RowEnd>{dur(t.durationMs)}</RowEnd>
                    <RowEnd>{shortAt(t.startedAt)}</RowEnd>
                  </Row>
                ))}
              </div>
            );
          })}
        </TableBody>
      </Table>
    </Workspace>
  );
}

/* ------------------------------- 共用片段 ------------------------------- */

function Steps({ steps, current, className }: { steps: TaskStep[]; current?: string | null; className?: string }) {
  return (
    <ol className={`ry-steps ${className ?? ""}`}>
      {steps.map((s) => (
        <li key={s.key} className={s.key === current ? css.stepCurrent : s.state === "queued" ? css.stepLater : undefined}>
          <Status kind={s.state} label={s.stateLabel} />
          <span>{s.label}</span>
          <span className="ry-row__end">{s.end ?? "—"}</span>
        </li>
      ))}
    </ol>
  );
}

function taskProps(t: TaskRow): PropItem[] {
  return t.props.map((p) => ({ label: p.label, value: p.value == null ? null : <span className={p.mono ? "ry-mono" : p.num ? "ry-num" : undefined}>{p.value}</span> }));
}

function useOpenTarget() {
  const go = useNav((s) => s.go);
  const openObject = useNav((s) => s.openObject);
  return (t: TaskRow) => {
    if (!t.target) return;
    if (t.target.tab) openObject(t.target.page, t.target.tab);
    else go(t.target.page);
  };
}

function useCancel(t: TaskRow) {
  const [busy, setBusy] = useState(false);
  const run = () => {
    if (!t.cancel) return;
    setBusy(true);
    t.cancel()
      .then(() => toast("已取消"))
      .catch((e) => toast(`取消失败：${errText(e)}`))
      .finally(() => setBusy(false));
  };
  return { busy, run };
}

/* ------------------------------- 列表 Inspector ------------------------------- */

type InspTab = "props" | "activity";

function TaskInspector({ t, machines, width, onClose, onOpen }: { t: TaskRow; machines: Tasks["machines"]; width: number; onClose: () => void; onOpen: () => void }) {
  const [tab, setTab] = useState<InspTab>("props");
  const healthSteps = useHealthSteps(t.healthRunId, machines);
  const steps = t.steps ?? healthSteps;
  const cancel = useCancel(t);
  return (
    <Inspector width={width}>
      <InspectorHead
        onClose={onClose}
        tabs={<ToolTabs label="Inspector 内容" value={tab} onChange={setTab} tabs={[{ key: "props", label: "属性" }, { key: "activity", label: "活动" }]} />}
        meta={
          <>
            <span>
              任务 <span className="ry-mono">{t.no ?? "—"}</span>
            </span>
            <Status kind={t.state} label={t.stateLabel} pill />
          </>
        }
        title={t.short}
        actions={
          <>
            <Button icon="open" kbd="↵" onClick={onOpen}>
              打开
            </Button>
            {t.state === "running" && (
              <Button icon="stop" busy={cancel.busy} disabled={!t.cancel} title={t.cancel ? undefined : "这类任务还不能从这里取消"} onClick={cancel.run}>
                取消任务
              </Button>
            )}
          </>
        }
      />
      <InspectorBody>
        {tab === "props" && (
          <>
            {t.meter && <Meter label={t.meter.label} value={t.meter.value} max={t.meter.max} text={t.meter.text} tone="running" role="progressbar" />}
            {steps && steps.length > 0 && <Steps steps={steps} className={css.inspSteps} />}
            <Props items={[...taskProps(t), { label: "现状", value: t.summary }]} />
          </>
        )}
        {tab === "activity" && (
          <ol className="ry-activity">
            {t.startedAt != null && (
              <li>
                <Status kind="queued" label="开始" srOnly size="sm" />
                <span>开始</span>
                <time>{shortAt(t.startedAt)}</time>
              </li>
            )}
            {t.state !== "running" && (
              <li>
                <Status kind={t.state} label={t.stateLabel} srOnly size="sm" />
                <span>{t.stateLabel}</span>
                <time>{t.startedAt != null && t.durationMs != null ? shortAt(t.startedAt + t.durationMs) : "—"}</time>
              </li>
            )}
          </ol>
        )}
      </InspectorBody>
    </Inspector>
  );
}

/* ------------------------------- 详情页 ------------------------------- */

type DetailTab = "steps" | "log" | "params";

function TaskDetail({ id, tasks }: { id: string; tasks: Tasks }) {
  const t = tasks.rows.find((r) => r.id === id) ?? null;
  const tabId = `task:${id}`;
  const showList = useNav((s) => s.showList);
  const closeObject = useNav((s) => s.closeObject);
  const updateObject = useNav((s) => s.updateObject);

  useEffect(() => {
    if (t) updateObject("tasks", tabId, { status: t.state, statusLabel: t.stateLabel });
  }, [t?.state, t?.stateLabel, tabId, updateObject, t]);

  if (!t) {
    return (
      <main className="ry-main">
        <Toolbar loc label="位置与对象操作">
          <Crumbs icon="tasks" trail={[{ label: "任务", onClick: () => showList("tasks") }]} current="—" />
        </Toolbar>
        {!tasks.loading && (
          <Empty icon="tasks" title="找不到这个任务" actions={<Button onClick={() => closeObject("tasks", tabId)}>关闭页签</Button>}>
            本次会话里的任务在重启后不再保留；记录也可能已被删除。
          </Empty>
        )}
      </main>
    );
  }
  return <Detail t={t} machines={tasks.machines} />;
}

function Detail({ t, machines }: { t: TaskRow; machines: Tasks["machines"] }) {
  const showList = useNav((s) => s.showList);
  const [inspOpen, setInsp] = useInspector("tasks:detail");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const [tab, setTab] = useState<DetailTab>("steps");
  const [wrap, setWrap] = useState(false);
  const healthSteps = useHealthSteps(t.healthRunId, machines);
  const steps = t.steps ?? healthSteps;
  const openTarget = useOpenTarget();
  const moreRef = useRef<HTMLButtonElement>(null);
  const [more, setMore] = useState(false);
  const cancel = useCancel(t);
  const errors = t.log.filter((l) => l.lvl === "ERR").length;
  const current = steps?.find((s) => s.state === "failed" || s.state === "running")?.key ?? null;
  const logText = t.log.map((l, i) => `${i + 1}\t${l.at != null ? fullAt(l.at) : "—"}\t${l.lvl}\t${l.text}`).join("\n");

  const inspector = (
    <Inspector width={inspW}>
      <InspectorHead onClose={() => setInsp(false)} tabs={<ToolTabs label="Inspector 内容" value="props" onChange={() => undefined} tabs={[{ key: "props", label: "属性" }, { key: "activity", label: "活动", disabled: true }]} />} />
      <InspectorBody>
        <Props
          items={[
            { label: "状态", value: <Status kind={t.state} label={t.stateLabel} /> },
            { label: "任务", value: <span className="ry-mono">{t.no ?? "—"}</span> },
            { label: "类型", value: t.tag },
            ...taskProps(t),
            { label: "现状", value: t.summary },
          ]}
        />
      </InspectorBody>
    </Inspector>
  );

  return (
    <Workspace inspector={inspector} inspectorOpen={inspOpen} inspectorWidth={inspW} onInspectorWidth={setInspW} minWidth={INSPECTOR_MIN} maxWidth={INSPECTOR_MAX}>
      <Toolbar loc label="位置与对象操作">
        <Crumbs icon="tasks" trail={[{ label: "任务", onClick: () => showList("tasks") }]} current={<span className="ry-mono">{t.no ?? t.short}</span>} />
        <Spacer />
        {t.state === "failed" && (
          <Button variant="primary" icon="refresh" disabled title="从失败步骤重试还没接入：到对应页面重新发起">
            从失败步骤重试
          </Button>
        )}
        {t.state === "running" && (
          <Button icon="stop" busy={cancel.busy} disabled={!t.cancel} title={t.cancel ? undefined : "这类任务还不能从这里取消"} onClick={cancel.run}>
            取消任务
          </Button>
        )}
        <IconButton icon="terminal" label="复制等效命令（还没接入）" disabled />
        <IconButton ref={moreRef} icon="more" label="更多操作" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore((o) => !o)} />
        {more && (
          <Menu anchor={moreRef} onClose={() => setMore(false)} label="更多操作" alignEnd>
            <MenuItem
              icon="open"
              disabled={!t.target}
              onSelect={() => {
                setMore(false);
                openTarget(t);
              }}
            >
              {t.target ? `去“${t.target.label}”查看` : "没有关联的对象"}
            </MenuItem>
          </Menu>
        )}
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>

      <div className="ry-detail">
        <div className="ry-detail__head">
          <h1 className="ry-detail__title">{t.title}</h1>
          <div className="ry-detail__meta">
            <Status kind={t.state} label={t.stateLabel} pill />
            <span>{t.tag}</span>
            {t.summary && <span>{t.summary}</span>}
            {t.durationMs != null && <span className="ry-num">{dur(t.durationMs)}</span>}
            {t.startedAt != null && <span className="ry-num">{fullAt(t.startedAt)}</span>}
          </div>
        </div>

        <div className="ry-detail__tools">
          <ToolTabs
            label="任务内容"
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "steps", label: "步骤" },
              { key: "log", label: "日志", count: errors, countSr: "处错误" },
              { key: "params", label: "参数" },
            ]}
          />
          <Spacer />
          {tab === "log" && (
            <>
              <IconButton icon="wrap" label="自动换行" aria-pressed={wrap} onClick={() => setWrap((w) => !w)} />
              <IconButton icon="copy" label="复制日志" disabled={!t.log.length} onClick={() => copyText(logText, "日志已复制")} />
            </>
          )}
        </div>

        {tab === "steps" &&
          (steps && steps.length ? (
            <Steps steps={steps} current={current} className={css.flexNone} />
          ) : (
            <Empty icon="tasks" title="这类任务没有分步记录">
              {t.state === "running" ? "正在运行，结束后结果写进记录。" : "只记了结果：看“参数”，或去对应页面查看详情。"}
            </Empty>
          ))}

        {tab === "log" &&
          (t.log.length ? (
            <div className={`ry-log ${wrap ? "ry-log--wrap" : ""}`} role="log" aria-label="任务输出" tabIndex={0}>
              {t.log.map((l, i) => (
                <div key={i} className={`ry-log__line ${l.lvl === "ERR" ? "ry-log__line--err" : l.lvl === "WARN" ? "ry-log__line--warn" : ""}`}>
                  <span className="ry-log__no">{i + 1}</span>
                  <span className="ry-log__time">{l.at != null ? new Date(l.at).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}</span>
                  <span className="ry-log__lvl">{l.lvl}</span>
                  <span className="ry-log__msg">{l.text}</span>
                </div>
              ))}
            </div>
          ) : (
            <Empty icon="file" title="没有日志">
              这类任务的输出没有留存；出错时会记下错误信息。
            </Empty>
          ))}

        {tab === "params" && (
          <div className={css.params}>
            <Props items={taskProps(t)} />
          </div>
        )}
      </div>
    </Workspace>
  );
}

export type { TaskState };
