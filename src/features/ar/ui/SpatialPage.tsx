/* 舞台 AR · 空间求解（设计：ArSpatial.dc.html）。
   每次求解 = vpcal quick run 写出的一个 ar-runs/run-NNN-<时间>/ 目录；进行中 / 失败只有本次会话发起的。
   当前采用的那次给验证和导出 OpenTrackIO 用。 */
import { useMemo, useRef, useState } from "react";
import { pickFile, revealPath } from "@/api/commands";
import { useCurrentStage } from "@/features/stage";
import { useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN } from "@/lib/nav";
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
  Meter,
  Note,
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
import {
  adoptedRun,
  baseName,
  cancelSpatial,
  CONF_LABEL,
  dirOf,
  dur,
  fullTime,
  groundOver,
  isLowConf,
  patchWs,
  runLabel,
  runTitle,
  shortTime,
  signed,
  startSpatialSolve,
  useArLog,
  useArRun,
  useArRuns,
  useArUi,
  useArWorkspace,
  useStageSpatialJobs,
  type ArRunSummary,
  type SpatialFilter,
} from "../model/ar";
import { Elapsed, logItems, useSlashFocus } from "./hooks";
import css from "./ar.module.css";

const COLS = "16px 36px minmax(200px, 1fr) max-content 84px 64px 84px";

export function SpatialPage() {
  const { stage, loading } = useCurrentStage();
  const path = stage?.path ?? null;
  const ws = useArWorkspace(path);
  const runsQ = useArRuns(path);
  const jobs = useStageSpatialJobs(path);
  const go = useNav((s) => s.go);
  const [inspOpen, setInsp] = useInspector("spatial");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const [filter, setFilter] = useState<SpatialFilter>("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"time" | "rms">("time");
  const [selId, setSelId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);

  const runs = useMemo(() => runsQ.data ?? [], [runsQ.data]);
  const adopted = adoptedRun(runs, ws);
  const match = (s: string) => !q.trim() || s.toLowerCase().includes(q.trim().toLowerCase());
  const pass = (r: ArRunSummary, f: SpatialFilter) => (f === "adopted" ? r.id === adopted?.id : f === "low" ? isLowConf(r.confidence) : true);
  const shown = runs
    .filter((r) => pass(r, filter) && match(`${runLabel(r)} ${runTitle(r)} ${CONF_LABEL[r.confidence ?? ""] ?? ""}`))
    .sort((a, b) => (sort === "rms" ? (a.validation_rms_px ?? Infinity) - (b.validation_rms_px ?? Infinity) : (b.timestamp ?? "").localeCompare(a.timestamp ?? "")));
  const shownJobs = filter === "all" ? jobs.filter((j) => match(`#${j.no} ${j.text}`)) : [];
  const running = shownJobs.filter((j) => j.state === "running");
  const failed = shownJobs.filter((j) => j.state === "failed");
  const sel = shown.find((r) => r.id === selId) ?? shown[0] ?? null;

  const crumbs = <Crumbs icon="spatial" current="空间求解" />;
  if (!stage) {
    return (
      <main className="ry-main">
        <Toolbar loc label="位置与对象操作">
          {crumbs}
        </Toolbar>
        {!loading && (
          <Empty icon="stage" title="还没有打开 Stage">
            打开一个 AR Stage 之后，这里列出它的空间求解记录。
          </Empty>
        )}
      </main>
    );
  }

  const start = async () => {
    let session = ws.session;
    if (!session) {
      session = await pickFile("采集会话 session.json", ["json"]).catch(() => null);
      if (!session) return;
      patchWs(stage.path, { session });
    }
    void startSpatialSolve(stage.path, session, runs, () => void runsQ.refetch());
  };
  const updated = runsQ.dataUpdatedAt ? new Date(runsQ.dataUpdatedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—";
  const busy = running.length > 0;

  return (
    <Workspace
      inspector={sel && <RunInspector stagePath={stage.path} run={sel} adopted={sel.id === adopted?.id} width={inspW} onClose={() => setInsp(false)} onVerify={() => go("verify")} />}
      inspectorOpen={inspOpen && !!sel}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      <Toolbar loc label="位置与对象操作">
        {crumbs}
        <Spacer />
        <Button variant="primary" icon="play" busy={busy} title={ws.session ? `用 ${baseName(dirOf(ws.session))} 求解` : "先选择采集会话"} onClick={() => void start()}>
          开始求解
        </Button>
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>
      <Toolbar label="视图：筛选、搜索与显示">
        <Group label="按结果筛选" fixed>
          <Chip pressed={filter === "all"} count={runs.length + jobs.length} onClick={() => setFilter("all")}>
            全部
          </Chip>
          <Chip pressed={filter === "adopted"} count={adopted ? 1 : 0} onClick={() => setFilter("adopted")}>
            当前采用
          </Chip>
          <Chip pressed={filter === "low"} count={runs.filter((r) => isLowConf(r.confidence)).length} onClick={() => setFilter("low")}>
            置信度低
          </Chip>
        </Group>
        <Spacer />
        <Search ref={searchRef} value={q} onChange={setQ} placeholder="筛选…" aria-label="筛选求解：编号、机位、置信度" shortcut="/" />
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
      <Progress on={runsQ.isFetching || busy} />

      {shown.length || shownJobs.length ? (
        <Table label="空间求解">
          <TableBody>
            {running.length > 0 && <GroupRow kind="running" label="进行中" count={running.length} />}
            {running.map((j) => (
              <Row key={j.key} cols={COLS}>
                <Status kind="running" label="进行中" srOnly />
                <span className="ry-row__id">#{j.no}</span>
                <RowTitle
                  tags={
                    <button type="button" className={`ry-tag ${css.tagBtn}`} onClick={() => void cancelSpatial(j)}>
                      取消
                    </button>
                  }
                >
                  {j.text}
                </RowTitle>
                <span>
                  <span className="ry-tag">—</span>
                </span>
                <RowEnd>—</RowEnd>
                <RowEnd>
                  <Elapsed since={j.startedAt} />
                </RowEnd>
                <RowEnd>{shortTime(j.startedAt)}</RowEnd>
              </Row>
            ))}
            {failed.length > 0 && <GroupRow kind="failed" label="失败" count={failed.length} />}
            {failed.map((j) => (
              <Row key={j.key} cols={COLS} unread>
                <Status kind="failed" label="失败" srOnly />
                <span className="ry-row__id">#{j.no}</span>
                <RowTitle>{j.text}</RowTitle>
                <span>
                  <span className="ry-tag">—</span>
                </span>
                <RowEnd>—</RowEnd>
                <RowEnd>{j.finishedAt ? dur(j.finishedAt - j.startedAt) : "—"}</RowEnd>
                <RowEnd>{shortTime(j.startedAt)}</RowEnd>
              </Row>
            ))}
            {shown.length > 0 && <GroupRow kind="success" label="成功" count={shown.length} />}
            {shown.map((r) => (
              <Row key={r.id} cols={COLS} selected={r === sel} onSelect={() => setSelId(r.id)} onOpen={() => void revealPath(dirOf(r.result_path)!).catch(() => undefined)}>
                <Status kind="success" label="成功" srOnly />
                <span className="ry-row__id">{runLabel(r)}</span>
                <RowTitle
                  tags={
                    r.id === adopted?.id && (
                      <span className={`ry-tag ${css.tagCurrent}`}>
                        <Icon name="check" size="sm" />
                        当前采用
                      </span>
                    )
                  }
                >
                  {runTitle(r)}
                </RowTitle>
                <span>
                  <span className="ry-tag">{CONF_LABEL[r.confidence ?? ""] ?? "置信度不详"}</span>
                </span>
                <RowEnd>{r.validation_rms_px != null ? `${r.validation_rms_px.toFixed(2)} px` : "—"}</RowEnd>
                <RowEnd>{ws.durations[r.id] != null ? dur(ws.durations[r.id]) : "—"}</RowEnd>
                <RowEnd>{r.timestamp ? shortTime(r.timestamp) : "—"}</RowEnd>
              </Row>
            ))}
          </TableBody>
        </Table>
      ) : (
        !runsQ.isLoading && (
          <Empty
            icon="spatial"
            title={q || filter !== "all" ? "没有符合条件的求解" : "还没有空间求解"}
            actions={
              !q &&
              filter === "all" && (
                <Button variant="primary" icon="play" onClick={() => void start()}>
                  开始求解
                </Button>
              )
            }
          >
            {q || filter !== "all"
              ? "换个筛选条件试试。"
              : "用一次多机位采集（session.json）把追踪坐标对齐到标记真值：检测标记 → 光束法平差 → 手眼标定。每次求解都留一条记录。"}
          </Empty>
        )
      )}
    </Workspace>
  );
}

/* ------------------------------ Inspector ------------------------------ */

function RunInspector({ stagePath, run, adopted, width, onClose, onVerify }: { stagePath: string; run: ArRunSummary; adopted: boolean; width: number; onClose: () => void; onVerify: () => void }) {
  const ui = useArUi();
  const ws = useArWorkspace(stagePath);
  const go = useNav((s) => s.go);
  const detail = useArRun(run.result_path);
  const events = useArLog((s) => s.events);
  const log = useMemo(() => events.filter((e) => e.area === "spatial"), [events]);
  const d = detail.data;
  const qa = d?.qa;
  const res = d?.result;
  const g = qa?.ground_plane;
  const over = groundOver(g);
  const delay = ws.delay[0]?.data.cameras[0];
  const images = res?.inputs?.image_count;
  const poses = run.num_poses;
  const det = qa?.coverage?.marker_coverage?.percentage;
  const cov = qa?.coverage?.sensor_coverage?.percentage;
  const holdout = new Set(qa?.validation?.holdout_frames ?? []);
  const tab = ui.spatialInsp;

  return (
    <Inspector width={width}>
      <InspectorHead
        tabs={
          <ToolTabs
            label="Inspector 内容"
            value={tab}
            onChange={(k) => ui.set({ spatialInsp: k })}
            tabs={[
              { key: "result", label: "结果" },
              { key: "poses", label: "机位" },
              { key: "activity", label: "活动" },
            ]}
          />
        }
        onClose={onClose}
        meta={
          <>
            <span>
              空间求解 <span className="ry-mono">{runLabel(run)}</span>
            </span>
            <Status pill kind="success" label="成功" />
          </>
        }
        title={runTitle(run)}
        actions={
          <>
            {adopted ? (
              <Button icon="verify" onClick={onVerify}>
                去验证
              </Button>
            ) : (
              <Button icon="check" onClick={() => (patchWs(stagePath, { adopted: run.id }), toast(`改用空间求解 ${runLabel(run)}`))}>
                设为当前采用
              </Button>
            )}
            <Button icon="open" kbd="↵" onClick={() => void revealPath(dirOf(run.result_path)!).catch((e) => toast(`打不开目录：${errText(e)}`))}>
              打开
            </Button>
          </>
        }
      />
      <InspectorBody>
        {tab === "result" && (
          <>
            {over && g && (
              <Note kind="attention" actions={<Button onClick={() => go("markers")}>去“标记”校平</Button>}>
                {`这次求解用的标记真值还没有校平（地面倾斜 ${g.tilt_from_z_deg!.toFixed(2)}°）。校平之后需要重新求解，这一条才算数。`}
              </Note>
            )}
            <div className={css.meters}>
              <Meter label="标记检出" value={det != null ? Math.round(det * 100) : 0} max={100} text={det != null ? `${Math.round(det * 100)}%` : "—"} tone={det == null ? "default" : det >= 0.85 ? "success" : "attention"} />
              <Meter label="画面覆盖" value={cov != null ? Math.round(cov * 100) : 0} max={100} text={cov != null ? `${Math.round(cov * 100)}%` : "—"} tone={cov == null ? "default" : cov >= 0.6 ? "success" : "attention"} />
              <Meter label="旋转范围" value={0} max={100} text="—" />
            </div>
            <Props
              items={[
                {
                  label: "验证 RMS",
                  value: run.validation_rms_px != null ? <span className="ry-num">{`${run.validation_rms_px.toFixed(2)} px${run.holdout_poses ? ` · 留出的 ${run.holdout_poses} 个机位` : ""}`}</span> : null,
                },
                { label: "机位", value: poses != null ? <span className="ry-num">{`${poses} 个${images != null && images > poses ? `，其中 ${images - poses} 个被剔除` : ""}`}</span> : null },
                { label: "方法", value: d ? `光束法平差${qa?.handeye?.applied ? " + 手眼标定" : ""}` : null },
                {
                  label: "延迟",
                  value: delay ? <span className="ry-num">{`${signed(delay.delay_ms)} ms · ${delay.delay_ms >= 0 ? "追踪领先画面" : "画面领先追踪"}，在“摄影机”里校准`}</span> : "还没校准 · 在“摄影机”里校准",
                },
                { label: "会话", value: ws.session ? <span className="ry-mono">{baseName(dirOf(ws.session))}</span> : null },
                { label: "真值", value: res?.inputs?.screen_definition ? <span className="ry-mono">{baseName(res.inputs.screen_definition)}</span> : null },
                { label: "完成于", value: run.timestamp ? <span className="ry-num">{fullTime(run.timestamp)}</span> : null },
              ]}
            />
            {detail.isError && <p className={css.errText}>{`读不了这次求解的报告：${errText(detail.error)}`}</p>}
          </>
        )}
        {tab === "poses" &&
          (qa?.reprojection?.per_pose?.length ? (
            <Props
              items={qa.reprojection.per_pose.map((p) => ({
                label: `帧 ${p.frame_id}`,
                value: <span className="ry-num">{`${p.rms_px.toFixed(2)} px · ${p.num_observations} 个观测${holdout.has(p.frame_id) ? " · 留出验证" : ""}`}</span>,
              }))}
            />
          ) : (
            <Empty icon="camera" title={detail.isLoading ? "正在读取…" : "没有逐机位的记录"}>
              {detail.isLoading ? "" : "这次求解的报告里没有逐机位残差（qa/reprojection.json）。"}
            </Empty>
          ))}
        {tab === "activity" && (
          <Activity
            style={{ gap: 10 }}
            items={[
              ...(adopted ? [{ key: "adopted", icon: "check" as const, text: "当前采用这次求解" }] : []),
              ...logItems(log),
              ...(run.timestamp ? [{ key: "done", icon: "success" as const, iconColor: "var(--status-success)", text: `完成空间求解 ${runLabel(run)}`, time: shortTime(run.timestamp) }] : []),
            ]}
          />
        )}
      </InspectorBody>
    </Inspector>
  );
}
