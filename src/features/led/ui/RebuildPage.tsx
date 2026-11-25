/* 舞台 LED · 重建（设计：Rebuild.dc.html + RebuildNew.dc.html）。
   列表 = mesh 库里的重建记录（按状态分组，进行中 / 失败只有本次会话发起的）；对象页签 run:<id> 是单次重建的详情（三维看网格 + 报告）。 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectConfig, ReconstructionReport, ReconstructionRun } from "@/api/types";
import { copyText } from "@/lib/clipboard";
import { useActiveObject, useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN } from "@/lib/nav";
import { errText, toast } from "@/lib/toast";
import {
  Activity,
  Button,
  Chip,
  Crumbs,
  DisplayMenu,
  Empty,
  Group,
  GroupRow,
  Icon,
  IconButton,
  Inspector,
  InspectorBody,
  InspectorHead,
  InspectorToggle,
  Menu,
  MenuItem,
  Progress,
  Props,
  Row,
  RowEnd,
  RowTitle,
  Search,
  Seg,
  Sep,
  Spacer,
  Status,
  Table,
  TableBody,
  Toolbar,
  ToolTabs,
  Workspace,
} from "@/ui";
import { composite, nodeScreens, resolveTopology, useOutputSession } from "../model/output";
import { alignmentFor, designBoxes, rebuiltBoxes } from "../model/geometry";
import { dirOf, dur, EXPORT_TARGETS, fullTime, runTab, shortTime, useExportRun, useRebuildJobs, useSetCurrent } from "../model/rebuild";
import { currentRun, runSource, useLedStage, useRunReport, useRuns } from "../model/screens";
import { CameraRig, frame, Viewport, type SceneEntry } from "../viewport/Viewport";
import { RebuildNewDialog } from "./RebuildNewDialog";
import css from "./led.module.css";

const COLS = "16px 36px minmax(160px, 1fr) max-content 84px 64px 84px";

export function RebuildPage() {
  const active = useActiveObject("rebuild");
  const m = active?.match(/^run:(\d+)$/);
  if (m) return <RunDetail runId={Number(m[1])} />;
  return <RebuildList />;
}

/* ------------------------------ 列表 ------------------------------ */

function RebuildList() {
  const { stage, config, loading } = useLedStage();
  const path = stage?.path ?? null;
  const runsQ = useRuns(path);
  const jobs = useRebuildJobs((s) => s.jobs);
  const openObject = useNav((s) => s.openObject);
  const [inspOpen, setInsp] = useInspector("rebuild");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const [screen, setScreen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"time" | "rms">("time");
  const [selId, setSelId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

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

  const runs = useMemo(() => runsQ.data ?? [], [runsQ.data]);
  const ids = Object.keys(config?.screens ?? {});
  const match = (s: string) => !q.trim() || s.toLowerCase().includes(q.trim().toLowerCase());
  const shown = runs
    .filter((r) => (!screen || r.screen_id === screen) && match(`#${r.id} ${r.screen_id} ${runSource(r)}`))
    .sort((a, b) => (sort === "rms" ? (a.estimated_rms_mm ?? Infinity) - (b.estimated_rms_mm ?? Infinity) : b.created_at.localeCompare(a.created_at)));
  const shownJobs = jobs.filter((j) => (!screen || j.screen === screen) && match(`${j.screen} ${j.method} ${j.text}`));
  const running = shownJobs.filter((j) => j.state === "running");
  const failed = shownJobs.filter((j) => j.state === "failed");
  const sel = shown.find((r) => r.id === selId) ?? shown[0] ?? null;

  const crumbs = <Crumbs icon="rebuild" current="重建" />;
  if (!stage || !config) {
    return (
      <main className="ry-main">
        <Toolbar loc label="位置与对象操作">
          {crumbs}
        </Toolbar>
        {!loading && (
          <Empty icon="stage" title="还没有打开 Stage">
            打开一个 Stage 之后，这里列出它每块屏幕的重建记录。
          </Empty>
        )}
      </main>
    );
  }
  const updated = runsQ.dataUpdatedAt ? new Date(runsQ.dataUpdatedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—";
  const count = (id: string | null) => runs.filter((r) => !id || r.screen_id === id).length + jobs.filter((j) => !id || j.screen === id).length;

  return (
    <Workspace
      inspector={sel && <RunInspector run={sel} config={config} width={inspW} onClose={() => setInsp(false)} path={path} onOpen={() => openObject("rebuild", runTab(sel))} />}
      inspectorOpen={inspOpen && !!sel}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      <Toolbar loc label="位置与对象操作">
        {crumbs}
        <Spacer />
        <Button variant="primary" icon="plus" disabled={!ids.length} onClick={() => setCreating(true)}>
          新建重建
        </Button>
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>
      <Toolbar label="视图：筛选、搜索与显示">
        <Group label="按屏幕筛选" fixed>
          <Chip pressed={!screen} count={count(null)} onClick={() => setScreen(null)}>
            全部
          </Chip>
          {ids.map((id) => (
            <Chip key={id} pressed={screen === id} count={count(id)} onClick={() => setScreen(id)}>
              {id}
            </Chip>
          ))}
        </Group>
        <Spacer />
        <Search ref={searchRef} value={q} onChange={setQ} placeholder="筛选…" aria-label="筛选重建：编号、屏幕、方式" shortcut="/" />
        <DisplayMenu
          rows={[
            {
              label: "排序",
              control: (
                <Seg
                  label="排序"
                  options={[
                    { value: "time", label: "时间" },
                    { value: "rms", label: "误差" },
                  ]}
                  value={sort}
                  onChange={setSort}
                />
              ),
            },
          ]}
          onReset={() => setSort("time")}
        />
        <IconButton icon="refresh" disabled={runsQ.isFetching} label={`刷新 · 上次 ${updated}`} onClick={() => runsQ.refetch()} />
      </Toolbar>
      <Progress on={runsQ.isFetching} />

      {shown.length || shownJobs.length ? (
        <Table label="重建">
          <TableBody>
            {running.length > 0 && <GroupRow kind="running" label="进行中" count={running.length} />}
            {running.map((j) => (
              <Row key={j.key} cols={COLS}>
                <Status kind="running" label="进行中" srOnly />
                <span className="ry-row__id">—</span>
                <RowTitle>{j.text}</RowTitle>
                <span>
                  <span className="ry-tag">{j.method}</span>
                </span>
                <RowEnd>—</RowEnd>
                <RowEnd><Elapsed since={j.startedAt} /></RowEnd>
                <RowEnd>{shortTime(new Date(j.startedAt).toISOString())}</RowEnd>
              </Row>
            ))}
            {failed.length > 0 && <GroupRow kind="failed" label="失败" count={failed.length} />}
            {failed.map((j) => (
              <Row key={j.key} cols={COLS} unread>
                <Status kind="failed" label="失败" srOnly />
                <span className="ry-row__id">—</span>
                <RowTitle>{j.text}</RowTitle>
                <span>
                  <span className="ry-tag">{j.method}</span>
                </span>
                <RowEnd>—</RowEnd>
                <RowEnd>{j.finishedAt ? dur(j.finishedAt - j.startedAt) : "—"}</RowEnd>
                <RowEnd>{shortTime(new Date(j.startedAt).toISOString())}</RowEnd>
              </Row>
            ))}
            {shown.length > 0 && <GroupRow kind="success" label="成功" count={shown.length} />}
            {shown.map((r) => {
              const cur = currentRun(runs, r.screen_id)?.id === r.id;
              return (
                <Row key={r.id} cols={COLS} selected={r === sel} onSelect={() => setSelId(r.id)} onOpen={() => openObject("rebuild", runTab(r))}>
                  <Status kind="success" label="成功" srOnly />
                  <span className="ry-row__id">#{r.id}</span>
                  <RowTitle
                    tags={
                      cur && (
                        <span className={`ry-tag ${css.tagCurrent}`}>
                          <Icon name="check" size="sm" />
                          当前采用
                        </span>
                      )
                    }
                  >
                    {`${r.screen_id} · ${r.vertex_count} 个顶点`}
                  </RowTitle>
                  <span>
                    <span className="ry-tag">{runSource(r)}</span>
                  </span>
                  <RowEnd>{r.estimated_rms_mm != null ? `${r.estimated_rms_mm.toFixed(2)} mm` : "—"}</RowEnd>
                  <RowEnd>—</RowEnd>
                  <RowEnd>{shortTime(r.created_at)}</RowEnd>
                </Row>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        !runsQ.isLoading && (
          <Empty
            icon="rebuild"
            title={q || screen ? "没有符合条件的重建" : "还没有重建记录"}
            actions={
              !q &&
              !screen && (
                <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                  新建重建
                </Button>
              )
            }
          >
            {q || screen ? "换个筛选条件试试。" : "量出一块屏幕的真实形状。每次重建都留一条记录，量完再决定采不采用。"}
          </Empty>
        )
      )}

      {creating && <RebuildNewDialog config={config} path={path!} runs={runs} initialScreen={screen ?? sel?.screen_id ?? ids[0]} onClose={() => setCreating(false)} />}
    </Workspace>
  );
}

/* ------------------------------ 报告 ------------------------------ */

function useRunFacts(run: ReconstructionRun, config: ProjectConfig, report: ReconstructionReport | undefined, path: string | null) {
  const runs = useRuns(path).data;
  const isCurrent = currentRun(runs, run.screen_id)?.id === run.id;
  const topo = resolveTopology(config);
  const sess = useOutputSession();
  const drivers = topo ? topo.nodes.filter((n) => nodeScreens(n, composite(config.screens)).includes(run.screen_id)).map((n) => n.node_id) : [];
  const cfg = config.screens[run.screen_id];
  const boxes = useMemo(() => (report && cfg ? rebuiltBoxes(report.surface, cfg) : null), [report, cfg]);
  const prov = boxes?.prov ? Object.values(boxes.prov) : null;
  const q = report?.quality_metrics;
  return {
    isCurrent,
    items: [
      {
        label: "采用",
        value: isCurrent ? (
          <span>
            当前采用
            {drivers.length > 0 && (
              <>
                {" "}
                · 上屏节点 <span className="ry-mono">{drivers.join("、")}</span> {sess.phase === "idle" ? "负责输出" : "正在使用"}
              </>
            )}
          </span>
        ) : (
          "没有采用"
        ),
      },
      { label: "重投影", value: null },
      { label: "留出验证", value: q?.estimated_rms_mm != null ? <span className="ry-num">{`${q.estimated_rms_mm.toFixed(2)} mm${q.estimated_p95_mm != null ? ` · P95 ${q.estimated_p95_mm.toFixed(2)} mm` : ""}`}</span> : null },
      {
        label: "箱体",
        value: prov ? (
          <span className="ry-num">{`${prov.length} 个：实测 ${prov.filter((p) => p === "measured").length} · 插值 ${prov.filter((p) => p === "interpolated").length} · 外推 ${prov.filter((p) => p === "extrapolated").length}`}</span>
        ) : boxes ? (
          <span className="ry-num">{`${boxes.boxes.length} 个`}</span>
        ) : null,
      },
      { label: "与设计", value: q && Number.isFinite(q.middle_mean_dev_mm) ? <span className="ry-num">{`均值 ${q.middle_mean_dev_mm.toFixed(1)} mm · 最大 ${q.middle_max_dev_mm.toFixed(1)} mm`}</span> : null },
      { label: "测点", value: q && Number.isFinite(q.measured_count) ? <span className="ry-num">{`${q.measured_count} / ${q.expected_count}${q.outliers?.length ? ` · 剔除 ${q.outliers.length}` : ""}`}</span> : null },
      { label: "镜头", value: null },
      { label: "开始", value: <span className="ry-num">{fullTime(run.created_at)}</span> },
      { label: "耗时", value: null },
      {
        label: "目录",
        value: dirOf(run.output_obj_path ?? run.visual_solve_path ?? report?.measurements_path) && <span className="ry-mono">{dirOf(run.output_obj_path ?? run.visual_solve_path ?? report?.measurements_path)}</span>,
        action: dirOf(run.output_obj_path ?? run.visual_solve_path ?? report?.measurements_path) ? (
          <IconButton icon="copy" size="sm" label="复制目录" onClick={() => copyText(dirOf(run.output_obj_path ?? run.visual_solve_path ?? report?.measurements_path)!, "已复制目录")} />
        ) : undefined,
      },
    ],
    warnings: q?.warnings ?? [],
  };
}

function ExportButton({ runId }: { runId: number }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const ex = useExportRun();
  return (
    <>
      <Button ref={ref} icon="download" busy={ex.isPending} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        导出
      </Button>
      {open && (
        <Menu anchor={ref} onClose={() => setOpen(false)} label="导出到">
          {EXPORT_TARGETS.map((t) => (
            <MenuItem
              key={t.value}
              meta={t.desc}
              onSelect={() => {
                setOpen(false);
                ex.mutate({ runId, target: t.value }, { onSuccess: (p) => toast(`已导出 ${p}`), onError: (e) => toast(`导出失败：${errText(e)}`) });
              }}
            >
              {t.label}
            </MenuItem>
          ))}
        </Menu>
      )}
    </>
  );
}

function RunInspector({ run, config, width, onClose, path, onOpen }: { run: ReconstructionRun; config: ProjectConfig; width: number; onClose: () => void; path: string | null; onOpen?: () => void }) {
  const [tab, setTab] = useState<"report" | "log" | "activity">("report");
  const report = useRunReport(run.id);
  const facts = useRunFacts(run, config, report.data, path);
  const setCur = useSetCurrent(path);
  return (
    <Inspector width={width}>
      <InspectorHead
        tabs={
          <ToolTabs
            label="Inspector 内容"
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "report", label: "报告" },
              { key: "log", label: "日志" },
              { key: "activity", label: "活动" },
            ]}
          />
        }
        onClose={onClose}
        meta={
          <>
            <span className="ry-mono">#{run.id}</span>
            <Status pill kind="success" label="成功" />
          </>
        }
        title={`${run.screen_id} · ${runSource(run)}，${run.vertex_count} 个顶点`}
        actions={
          <>
            {onOpen && (
              <Button icon="open" kbd="↵" onClick={onOpen}>
                打开
              </Button>
            )}
            <ExportButton runId={run.id} />
            {facts.isCurrent ? (
              <Button disabled title="与另一次重建逐点比对的界面还没有接入">
                与另一次比对
              </Button>
            ) : (
              <Button icon="check" busy={setCur.isPending} onClick={() => setCur.mutate(run.id, { onSuccess: () => toast(`${run.screen_id} 改用重建 #${run.id}`), onError: (e) => toast(`设置失败：${errText(e)}`) })}>
                设为当前采用
              </Button>
            )}
          </>
        }
      />
      <InspectorBody>
        {tab === "report" && (
          <>
            <Props items={facts.items} />
            {facts.warnings.length > 0 && (
              <>
                <h3 className={css.subHead}>提醒</h3>
                <Activity style={{ gap: 10 }} items={facts.warnings.map((w, i) => ({ key: String(i), icon: "attention", iconColor: "var(--volo-attention)", text: w }))} />
              </>
            )}
          </>
        )}
        {tab === "log" && (
          <Empty icon="terminal" title="没有保存日志">
            重建过程的日志只在当次运行时显示，记录里只留结果。
          </Empty>
        )}
        {tab === "activity" && (
          <Activity
            style={{ gap: 10 }}
            items={[
              ...(facts.isCurrent ? [{ key: "cur", icon: "check" as const, text: `${run.screen_id} 当前采用这次重建` }] : []),
              { key: "done", icon: "success" as const, iconColor: "var(--status-success)", text: `完成重建 · ${runSource(run)}`, time: shortTime(run.created_at) },
            ]}
          />
        )}
      </InspectorBody>
    </Inspector>
  );
}

/* ------------------------------ 详情（对象页签） ------------------------------ */

function RunDetail({ runId }: { runId: number }) {
  const { stage, config } = useLedStage();
  const path = stage?.path ?? null;
  const runs = useRuns(path);
  const run = runs.data?.find((r) => r.id === runId) ?? null;
  const report = useRunReport(runId);
  const showList = useNav((s) => s.showList);
  const [inspOpen, setInsp] = useInspector("rebuild:detail");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const [rig] = useState(() => new CameraRig());
  const [ghost, setGhost] = useState(true);
  const cfg = run && config ? config.screens[run.screen_id] : undefined;
  const built = useMemo(() => (report.data && cfg && config && run ? rebuiltBoxes(report.data.surface, cfg, alignmentFor(config, run.screen_id)) : null), [report.data, cfg, config, run]);
  const design = useMemo(() => (cfg ? designBoxes(cfg) : null), [cfg]);
  const entries = useMemo<SceneEntry[]>(
    () =>
      built && run
        ? [{ id: run.screen_id, isActive: true, selected: false, boxes: built.boxes, ghostBoxes: ghost ? (design?.boxes ?? null) : null, provByKey: null, cutout: true, patternUrl: null, normalSign: cfg?.normal_flip ? -1 : 1, selKeys: [] }]
        : [],
    [built, design, ghost, run, cfg],
  );
  const boxKey = built?.bbox ? `${built.bbox.min.x},${built.bbox.max.x},${built.bbox.max.z}` : "";
  useEffect(() => {
    if (built?.bbox && !rig.touched) frame(rig, built.bbox, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxKey, rig]);

  const crumbs = <Crumbs icon="rebuild" trail={[{ label: "重建", onClick: () => showList("rebuild") }]} current={run ? `重建 #${run.id} ${run.screen_id}` : `重建 #${runId}`} />;
  if (!run || !config) {
    return (
      <main className="ry-main">
        <Toolbar loc label="位置与对象操作">
          {crumbs}
        </Toolbar>
        {!runs.isLoading && <Empty icon="rebuild" title="找不到这次重建">它可能属于另一个 Stage，或者记录已经删除。</Empty>}
      </main>
    );
  }
  return (
    <Workspace
      inspector={<RunInspector run={run} config={config} width={inspW} onClose={() => setInsp(false)} path={path} />}
      inspectorOpen={inspOpen}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      <Toolbar loc label="位置与对象操作">
        {crumbs}
        <Spacer />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>
      <Viewport rig={rig} entries={entries} label={`三维视口：${run.screen_id} 的重建网格${ghost ? "，叠加设计网格" : ""}`}>
        <div className="volo-viewport__hud volo-viewport__hud--col" data-at="tr" role="toolbar" aria-label="视角与显示">
          <IconButton icon="fit" label="框住全部" onClick={() => frame(rig, built?.bbox ?? null)} />
          <span className="volo-viewport__sep" />
          <IconButton icon="layers" label="叠加设计网格" pressed={ghost} onClick={() => setGhost((g) => !g)} />
        </div>
        <div className="volo-viewport__readout" data-at="bl">
          <span>{run.screen_id}</span>
          {built && <span>{`${built.cols} × ${built.rows} 箱体`}</span>}
          <span>{`重建 #${run.id}`}</span>
          <span>单位 mm</span>
        </div>
        {report.isLoading && (
          <div className="volo-viewport__legend" data-at="tc">
            正在读取网格…
          </div>
        )}
      </Viewport>
    </Workspace>
  );
}

/** 进行中任务的已用时长，每秒走一次。 */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{dur(now - since)}</>;
}
