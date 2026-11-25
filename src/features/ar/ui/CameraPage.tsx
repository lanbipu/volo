/* 舞台 AR · 摄影机（设计：ArCamera.dc.html）。
   列表复用 LED 的摄影机列表；详情是这台摄影机的延迟校准（vpcal capture delay-cal）+ 随空间求解估计的镜头 + 信号源 + 历史。
   vpcal 只输出最吻合的时间差和峰的深度，不输出相关曲线：图上画峰的位置、高度按峰的深度，曲线不画。 */
import { useMemo, type ReactNode } from "react";
import type { ProjectCamera } from "@/api/types";
import { pickDirectory, pickFile } from "@/api/commands";
import { CameraMore, CameraPage as LedCameraPage, CameraSources, cameraLabel, profileFor, useCaptureProfiles, useLedStage, useSaveStage, type CameraVariant } from "@/features/led";
import { useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN } from "@/lib/nav";
import { errText, toast } from "@/lib/toast";
import {
  Activity,
  Button,
  Crumbs,
  Empty,
  Field,
  Fields,
  FieldsTitle,
  GroupRow,
  HeadRow,
  IconButton,
  Inspector,
  InspectorBody,
  InspectorHead,
  InspectorToggle,
  Progress,
  Props,
  Row,
  RowEnd,
  RowTitle,
  Seg,
  Sep,
  Spacer,
  Status,
  Table,
  TableBody,
  TextInput,
  Toolbar,
  ToolTabs,
  Workspace,
  type StatusKind,
} from "@/ui";
import {
  adoptedRun,
  baseName,
  CONF_LABEL,
  driftLabel,
  fullTime,
  patchWs,
  peakLabel,
  runDelayCal,
  runLabel,
  shortTime,
  signed,
  useArJobs,
  useArLog,
  useArRun,
  useArRuns,
  useArUi,
  useArWorkspace,
  type ArWorkspace,
  type DelayRecord,
  type LensParam,
} from "../model/ar";
import { logItems } from "./hooks";
import css from "./ar.module.css";

const LOW_PEAK = 0.6;
const recordsFor = (ws: ArWorkspace, camId: string) => ws.delay.filter((r) => r.camId === camId || r.camId == null);
const delayKind = (r: DelayRecord | null): { kind: StatusKind; label: string } => {
  const c = r?.data.cameras[0];
  if (!c) return { kind: "queued", label: "未校准" };
  return c.confidence < LOW_PEAK ? { kind: "attention", label: "峰不明显" } : { kind: "success", label: "就绪" };
};

/** 摄影机页：AR 舞台换上延迟校准的详情。 */
export function ArCameraPage() {
  const { stage } = useLedStage();
  const ws = useArWorkspace(stage?.path ?? null);
  const variant = useMemo<CameraVariant>(
    () => ({
      detail: (camId) => <ArCameraDetail camId={camId} />,
      status: (c: ProjectCamera) => delayKind(recordsFor(ws, c.id)[0] ?? null),
      empty: "AR 合成要知道每台摄影机的追踪延迟。先添加一台，接上视频源和追踪，再做延迟校准。",
    }),
    [ws],
  );
  return <LedCameraPage variant={variant} />;
}

/* ------------------------------ 详情 ------------------------------ */

function ArCameraDetail({ camId }: { camId: string }) {
  const { stage, config } = useLedStage();
  const path = stage?.path ?? null;
  const ws = useArWorkspace(path);
  const runsQ = useArRuns(path);
  const ui = useArUi();
  const jobs = useArJobs();
  const showList = useNav((s) => s.showList);
  const [inspOpen, setInsp] = useInspector("camera:detail");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);

  const cam = config?.cameras?.find((c) => c.id === camId) ?? null;
  const records = recordsFor(ws, camId);
  const rec = records[0] ?? null;
  const c0 = rec?.data.cameras[0] ?? null;
  const adopted = adoptedRun(runsQ.data, ws);

  const crumbs = <Crumbs icon="camera" trail={[{ label: "摄影机", onClick: () => showList("camera") }]} current={cam ? cameraLabel(cam) : "摄影机"} />;
  if (!config || !cam || !path) {
    return (
      <main className="ry-main">
        <Toolbar loc label="位置与对象操作">
          {crumbs}
        </Toolbar>
        {config && <Empty icon="camera" title="找不到这台摄影机">它可能属于另一个 Stage，或者已经删除。</Empty>}
      </main>
    );
  }

  const calibrate = async () => {
    const fps = Number(ui.delayFps);
    const missing = !adopted ? "先做一次空间求解" : !ws.session ? "先在「空间求解」里选好采集会话" : !ui.delayVideo.trim() ? "选好录制的帧目录" : !ui.delayTracking.trim() ? "选好同一次的追踪数据" : !(fps > 0) ? "填好帧率" : null;
    if (missing || !adopted || !ws.session) {
      ui.set({ camInsp: "delay" });
      setInsp(true);
      return toast(missing ?? "还差输入");
    }
    ui.set({ camTab: "delay" });
    try {
      await runDelayCal(path, { session: ws.session, run: adopted, video: ui.delayVideo.trim(), tracking: ui.delayTracking.trim(), fps, camId });
    } catch (e) {
      toast(`延迟校准失败：${errText(e)}`);
    }
  };

  const st = jobs.delaying ? { kind: "running" as const, label: "正在校准" } : delayKind(rec);
  const tab = ui.camTab;

  return (
    <Workspace
      inspector={<DelayInspector rec={rec} width={inspW} onClose={() => setInsp(false)} />}
      inspectorOpen={inspOpen}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      <Toolbar loc label="位置与对象操作">
        {crumbs}
        <Spacer />
        <Button variant="primary" icon="refresh" busy={jobs.delaying} onClick={() => void calibrate()}>
          {rec ? "重新校准" : "开始校准"}
        </Button>
        <CameraMore cam={cam} config={config} path={path} live={jobs.delaying} />
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>
      <Progress on={jobs.delaying} />

      <div className={`ry-detail ${css.camTop}`}>
        <div className={`ry-detail__head ${css.camHead}`}>
          <h1 className="ry-detail__title">{cameraLabel(cam)}</h1>
          <div className="ry-detail__meta">
            <Status pill kind={st.kind} label={st.label} />
            <span className="ry-num">{c0 ? `延迟 ${signed(c0.delay_ms)} ms` : "延迟 —"}</span>
            <span>镜头随空间求解一起估计</span>
          </div>
        </div>
        <div className="ry-detail__tools">
          <ToolTabs
            label="摄影机内容"
            value={tab}
            onChange={(k) => ui.set({ camTab: k })}
            tabs={[
              { key: "delay", label: "延迟" },
              { key: "lens", label: "镜头" },
              { key: "source", label: "信号源" },
              { key: "history", label: "历史" },
            ]}
          />
        </div>
      </div>

      {tab === "delay" &&
        (rec && c0 ? (
          <DelayView rec={rec} />
        ) : (
          <Empty
            icon="clock"
            title="还没有校准延迟"
            actions={
              <Button variant="primary" icon="play" busy={jobs.delaying} onClick={() => void calibrate()}>
                开始校准
              </Button>
            }
          >
            让摄影机来回大幅度摇，录一段画面和追踪，算出追踪比画面早多少。合成时按它推后追踪数据，虚拟物体才不会在摇镜头时“飘”。
          </Empty>
        ))}
      {tab === "lens" && <LensView resultPath={adopted?.result_path ?? null} runName={adopted ? runLabel(adopted) : null} />}
      {tab === "source" && <SourceView cam={cam} live={jobs.delaying} />}
      {tab === "history" && (
        <DelayHistory
          records={records}
          current={rec}
          onPick={(r) => {
            patchWs(path, (w) => ({ delay: [r, ...w.delay.filter((x) => x !== r)] }));
            ui.set({ camTab: "delay" });
          }}
        />
      )}
    </Workspace>
  );
}

/* ------------------------------ 延迟 ------------------------------ */

const X0 = 60;
const X1 = 800;
const Y_BASE = 300;
const Y_TOP = 92;

function DelayView({ rec }: { rec: DelayRecord }) {
  const c = rec.data.cameras[0]!;
  const S = c.search_ms ?? 200;
  const x = (d: number) => X0 + ((Math.max(-S, Math.min(S, d)) + S) / (2 * S)) * (X1 - X0);
  const px = x(c.delay_ms);
  const py = Y_BASE - Math.max(0, Math.min(1, c.confidence)) * (Y_BASE - Y_TOP);
  const ticks = [-S, -S / 2, 0, S / 2, S];
  const tickText = (t: number, i: number) => `${t > 0 ? "+" : t < 0 ? "−" : ""}${Math.abs(t)}${i === 4 ? " ms" : ""}`;
  const tickX = [44, 230, 426, 600, 770];
  const peak = peakLabel(c.confidence);
  const drift = driftLabel(c.sigma_ms);
  const secs = rec.fps > 0 ? Math.round(c.num_frames / rec.fps) : null;

  return (
    <>
      <div className={`volo-viewport ${css.delayView}`}>
        <svg className="volo-viewport__canvas" viewBox="0 0 840 360" preserveAspectRatio="none" role="img" aria-label={`延迟校准：横轴是时间差，从负 ${S} 到正 ${S} 毫秒；最吻合的时间差是 ${signed(c.delay_ms)} 毫秒`}>
          <path className="volo-scene-grid" d={`M${X0} ${Y_BASE}h${X1 - X0}${ticks.map((t) => `M${x(t)} 60v240`).join("")}M${X0} 180h${X1 - X0}`} />
          {c.sigma_ms != null && c.sigma_ms > 0 && <rect className={css.delayBand} x={x(c.delay_ms - c.sigma_ms)} y={60} width={Math.max(1, x(c.delay_ms + c.sigma_ms) - x(c.delay_ms - c.sigma_ms))} height={Y_BASE - 60} />}
          <path className="volo-scene-shape is-selected" d={`M${px} ${py - 10}V${Y_BASE}`} />
          <circle className="volo-scene-shape is-selected" cx={px} cy={py} r="5" />
          <text className="volo-scene-text" x={px + 24} y={py - 14}>{`${signed(c.delay_ms)} ms`}</text>
          {ticks.map((t, i) => (
            <text key={i} className="volo-scene-text" x={tickX[i]} y="322">
              {tickText(t, i)}
            </text>
          ))}
        </svg>
        <div className="volo-viewport__readout" data-at="tl">
          <span>峰的位置和深度</span>
          <span>越高越可信</span>
        </div>
        <div className="volo-viewport__legend" data-at="tr">
          <span className="volo-viewport__key">
            <i className={css.keySelectedSolid} />
            最吻合的时间差
          </span>
        </div>
      </div>
      <section aria-label="延迟校准结果" className={css.stats}>
        <Stat label="延迟" value={signed(c.delay_ms)} unit="ms" note={c.delay_ms >= 0 ? "追踪比画面早到" : "追踪比画面晚到"} />
        <Stat label="峰有多明显" value={peak.text} note={peak.note} />
        <Stat label="用了多少" value={secs != null ? String(secs) : "—"} unit={`秒 · ${c.num_frames} 帧`} />
        <Stat label="前后漂移" value={drift.text} unit={c.sigma_ms != null ? "ms" : undefined} note={drift.note || undefined} />
      </section>
    </>
  );
}

function Stat({ label, value, unit, note }: { label: string; value: string; unit?: string; note?: string }) {
  return (
    <div className={css.stat}>
      <span className="ry-meta">{label}</span>
      <span className={`ry-num ${css.statValue}`}>
        {value}
        {unit && <span className={css.statUnit}>{` ${unit}`}</span>}
      </span>
      {note && <span className={`ry-meta ${css.statNote}`}>{note}</span>}
    </div>
  );
}

/* ------------------------------ 镜头 ------------------------------ */

const num = (v: number, d: number) => (v < 0 ? `−${Math.abs(v).toFixed(d)}` : v.toFixed(d));
const lp = (p: LensParam | null | undefined, unit: string, d = 3): ReactNode =>
  p ? (
    <span className="ry-num">
      {`${num(p.value, d)}${unit}`}
      {p.std != null ? ` ± ${p.std.toFixed(d)}` : ""}
      {p.observable === false ? ` · ${p.locked_reason ? "未释放" : "不可观测"}` : ""}
    </span>
  ) : null;

function LensView({ resultPath, runName }: { resultPath: string | null; runName: string | null }) {
  const runQ = useArRun(resultPath);
  const le = runQ.data?.result.quality?.lens_estimate ?? null;
  if (!resultPath) {
    return (
      <Empty icon="camera" title="还没有镜头估计">
        AR 舞台的镜头随空间求解一起估计。先在「空间求解」里做一次求解。
      </Empty>
    );
  }
  if (runQ.isLoading) return null;
  if (!le) {
    return (
      <Empty icon="camera" title="这次求解没有估计镜头">
        {`空间求解 ${runName ?? ""} 用的是固定镜头参数。可复用的镜头档案还没接入。`}
      </Empty>
    );
  }
  const pp = le.principal_point_offset_mm;
  return (
    <section className={css.pane} aria-label="镜头估计">
      <p className={css.lead}>{`随空间求解 ${runName ?? ""} 一起估计，只对那一次采集有效，不是可复用的镜头档案。`}</p>
      <Props
        items={[
          { label: "焦距", value: lp(le.focal_length_mm, " mm", 2) },
          { label: "主点偏移", value: pp ? <span className="ry-num">{`${num(pp[0].value, 3)}, ${num(pp[1].value, 3)} mm`}</span> : null },
          { label: "k1", value: lp(le.distortion_k1, "", 4) },
          { label: "k2", value: lp(le.distortion_k2, "", 4) },
          { label: "置信度", value: le.confidence ? (CONF_LABEL[le.confidence]?.replace("置信度", "") ?? le.confidence) : null },
          { label: "RMS", value: le.spatial_only_rms_px != null && le.refined_rms_px != null ? <span className="ry-num">{`${le.spatial_only_rms_px.toFixed(2)} → ${le.refined_rms_px.toFixed(2)} px`}</span> : null },
          { label: "提醒", value: le.identifiability_flags?.length ? le.identifiability_flags.join("、") : null },
        ]}
      />
    </section>
  );
}

/* ------------------------------ 信号源 ------------------------------ */

function SourceView({ cam, live }: { cam: ProjectCamera; live: boolean }) {
  const { stage, config } = useLedStage();
  const save = useSaveStage(stage?.path ?? null);
  const profilesQ = useCaptureProfiles();
  const profiles = profilesQ.data?.profiles ?? [];
  if (!config) return null;
  return (
    <section className={css.pane} aria-label="信号源">
      <CameraSources cam={cam} config={config} profile={profileFor(cam, profiles)} profiles={profiles} save={(next) => save.mutateAsync(next)} live={live} />
    </section>
  );
}

/* ------------------------------ 历史 ------------------------------ */

const HIST_COLS = "16px minmax(120px, 1fr) 84px 64px 84px 84px";

function DelayHistory({ records, current, onPick }: { records: DelayRecord[]; current: DelayRecord | null; onPick: (r: DelayRecord) => void }) {
  if (!records.length) {
    return (
      <Empty icon="clock" title="还没有校准记录">
        每次延迟校准都会记在这里，可以换回之前的结果。
      </Empty>
    );
  }
  return (
    <Table label="延迟校准历史">
      <TableBody>
        <HeadRow cols={HIST_COLS}>
          <span />
          <span>完成于</span>
          <RowEnd>延迟</RowEnd>
          <RowEnd>峰</RowEnd>
          <RowEnd>漂移</RowEnd>
          <RowEnd>帧</RowEnd>
        </HeadRow>
        <GroupRow kind="success" label="校准记录" count={records.length} />
        {records.map((r) => {
          const c = r.data.cameras[0];
          const k = delayKind(r);
          return (
            <Row key={`${r.at}-${r.path}`} cols={HIST_COLS} selected={r === current} onSelect={() => onPick(r)}>
              <Status kind={k.kind} label={k.label} srOnly />
              <RowTitle>
                {shortTime(r.at)}
                {r === current && <span className={`ry-tag ${css.tagCurrent}`}>当前使用</span>}
              </RowTitle>
              <RowEnd>{c ? `${signed(c.delay_ms)} ms` : "—"}</RowEnd>
              <RowEnd>{c ? peakLabel(c.confidence).text : "—"}</RowEnd>
              <RowEnd>{c?.sigma_ms != null ? `${c.sigma_ms.toFixed(1)} ms` : "—"}</RowEnd>
              <RowEnd>{c ? String(c.num_frames) : "—"}</RowEnd>
            </Row>
          );
        })}
      </TableBody>
    </Table>
  );
}

/* ------------------------------ Inspector ------------------------------ */

function DelayInspector({ rec, width, onClose }: { rec: DelayRecord | null; width: number; onClose: () => void }) {
  const ui = useArUi();
  const jobs = useArJobs();
  const events = useArLog((s) => s.events);
  const log = useMemo(() => events.filter((e) => e.area === "delay"), [events]);
  const tabs = (
    <ToolTabs
      label="Inspector 内容"
      value={ui.camInsp}
      onChange={(k) => ui.set({ camInsp: k })}
      tabs={[
        { key: "delay", label: "延迟" },
        { key: "activity", label: "活动" },
      ]}
    />
  );
  if (ui.camInsp === "activity") {
    return (
      <Inspector width={width}>
        <InspectorHead tabs={tabs} onClose={onClose} title="活动" />
        <InspectorBody>
          {log.length ? (
            <Activity style={{ gap: 10 }} items={logItems(log)} />
          ) : (
            <Empty icon="clock" title="这次打开后还没有操作">
              延迟校准会记在这里。
            </Empty>
          )}
        </InspectorBody>
      </Inspector>
    );
  }
  const c = rec?.data.cameras[0] ?? null;
  const k = jobs.delaying ? { kind: "running" as const, label: "正在校准" } : c ? (c.confidence < LOW_PEAK ? { kind: "attention" as const, label: "峰不明显" } : { kind: "success" as const, label: "成功" }) : { kind: "queued" as const, label: "未校准" };
  const browse = async (key: "delayVideo" | "delayTracking") => {
    const p = key === "delayVideo" ? await pickDirectory().catch(() => null) : await pickFile("追踪数据", ["jsonl", "json", "csv"]).catch(() => null);
    if (p) ui.set({ [key]: p });
  };
  return (
    <Inspector width={width}>
      <InspectorHead
        tabs={tabs}
        onClose={onClose}
        meta={
          <>
            <span>延迟校准</span>
            <Status pill kind={k.kind} label={k.label} />
          </>
        }
        title={c ? `追踪比画面${c.delay_ms >= 0 ? "早" : "晚"} ${Math.abs(c.delay_ms).toFixed(1)} ms` : "还没有校准延迟"}
      />
      <InspectorBody>
        <p className={css.leadTight}>合成时把追踪数据推后这么多，虚拟物体才不会在摇镜头时“飘”。导出 OpenTrackIO 时可以选择是否已经扣掉它。</p>
        {c?.boundary_hit && (
          <p className={css.errText}>{`峰落在搜索范围边上（±${c.search_ms ?? 200} ms），这次结果不可信。`}</p>
        )}
        <Fields>
          <FieldsTitle>下一次校准</FieldsTitle>
          <Field label="用什么" inline>
            <Seg
              label="用什么"
              block
              options={[
                { value: "live", label: "现场采集", disabled: true },
                { value: "recording", label: "已有录制" },
              ]}
              value={ui.delaySource === "live" ? "recording" : ui.delaySource}
              onChange={(v) => ui.set({ delaySource: v })}
            />
          </Field>
          <Field label="帧目录" htmlFor="delay-video">
            <div className={css.pathRow}>
              <TextInput id="delay-video" mono value={ui.delayVideo} onChange={(v) => ui.set({ delayVideo: v })} placeholder="swing test 的帧目录" />
              <IconButton icon="folder" label="选择帧目录" onClick={() => void browse("delayVideo")} />
            </div>
          </Field>
          <Field label="追踪数据" htmlFor="delay-tracking">
            <div className={css.pathRow}>
              <TextInput id="delay-tracking" mono value={ui.delayTracking} onChange={(v) => ui.set({ delayTracking: v })} placeholder="同一次录的追踪 .jsonl" />
              <IconButton icon="folder" label="选择追踪数据" onClick={() => void browse("delayTracking")} />
            </div>
          </Field>
          <Field label="帧率" htmlFor="delay-fps" inline>
            <TextInput id="delay-fps" num value={ui.delayFps} onChange={(v) => ui.set({ delayFps: v })} unit="fps" invalid={!(Number(ui.delayFps) > 0)} />
          </Field>
        </Fields>
        <p className={`volo-field__hint ${css.hintGap}`}>录的时候让摄影机来回摇，幅度要大。动得太少，峰不明显，算出来的延迟不可信。现场采集还没接入。</p>
        <Props
          items={[
            { label: "镜头", value: "随空间求解一起估计，只对那一次有效。可复用的镜头档案还没接入。" },
            { label: "档案", value: rec ? <span className="ry-mono">{baseName(rec.path)}</span> : null },
            { label: "完成于", value: rec ? <span className="ry-num">{fullTime(rec.at)}</span> : null },
          ]}
        />
      </InspectorBody>
    </Inspector>
  );
}
