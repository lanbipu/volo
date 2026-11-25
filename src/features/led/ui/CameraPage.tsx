/* 舞台 LED · 摄影机（设计：Camera.dc.html 采集中 / CameraSources.dc.html 空闲监看 + 信号源 / CameraResult.dc.html 结果）。
   列表是 project.yaml 里的摄影机；对象页签 camera:<id> 是一台摄影机的镜头标定：采集 / 结果 / 历史。 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProjectCamera, ProjectConfig } from "@/api/types";
import type { LensSessionSummary } from "@/api/lensCommands";
import { useActiveObject, useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN } from "@/lib/nav";
import { errText, toast } from "@/lib/toast";
import {
  Button,
  Chip,
  ConfirmDialog,
  Crumbs,
  Dialog,
  Empty,
  Field,
  Fields,
  Icon,
  IconButton,
  Inspector,
  InspectorBody,
  InspectorHead,
  InspectorToggle,
  Kbd,
  Menu,
  MenuItem,
  Progress,
  Props,
  Row,
  RowEnd,
  RowTitle,
  Sep,
  Spacer,
  Status,
  Table,
  TableBody,
  TextInput,
  Toolbar,
  ToolTabs,
  Workspace,
  cx,
  type StatusKind,
} from "@/ui";
import {
  abortLensCapture,
  baseName,
  cameraLabel,
  camTab,
  finishLensCapture,
  formatSource,
  GRID_CELLS,
  lensVerdict,
  missingText,
  newCamera,
  PROTOCOL_LABEL,
  profileFor,
  resetCapture,
  RMS_ADOPT_PX,
  sessionsFor,
  snapNow,
  startLensCapture,
  startMonitor,
  startTracking,
  stopMonitor,
  stopTracking,
  useCameraUi,
  useCapture,
  useCaptureProfiles,
  useCoverage,
  useLensInfo,
  useLensSessions,
  useMonitor,
  useTracking,
  videoOf,
  withCamera,
  type CamTab,
} from "../model/camera";
import { dur, shortTime } from "../model/rebuild";
import { useLedStage, useSaveStage } from "../model/screens";
import { CaptureInspector, ResultInspector } from "./CameraInspector";
import { stageKeys } from "@/features/stage";
import { useQueryClient } from "@tanstack/react-query";
import css from "./led.module.css";

/** AR 舞台复用列表，换上自己的详情页、状态和空态文案。 */
export interface CameraVariant {
  detail: (camId: string) => ReactNode;
  status: (c: ProjectCamera) => { kind: StatusKind; label: string };
  empty: string;
}

export function CameraPage({ variant }: { variant?: CameraVariant }) {
  const active = useActiveObject("camera");
  const m = active?.match(/^camera:(.+)$/);
  if (m) return variant ? <>{variant.detail(m[1])}</> : <CameraDetail camId={m[1]} />;
  return <CameraList variant={variant} />;
}

/** 进行中的计时，每秒走一次。 */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{dur(now - since)}</>;
}

const lensKind = (c: ProjectCamera): { kind: StatusKind; label: string } =>
  c.lens?.calibration_rms_px != null ? (c.lens.calibration_rms_px < RMS_ADOPT_PX ? { kind: "success", label: "就绪" } : { kind: "attention", label: "残差偏高" }) : { kind: "queued", label: "未标定" };

/* ------------------------------ 列表 ------------------------------ */

const LIST_COLS = "16px minmax(120px, 1fr) 64px 72px 88px 128px";

function CameraList({ variant }: { variant?: CameraVariant }) {
  const { stage, config, loading } = useLedStage();
  const path = stage?.path ?? null;
  const save = useSaveStage(path);
  const profiles = useCaptureProfiles().data?.profiles;
  const capture = useCapture();
  const openObject = useNav((s) => s.openObject);
  const [inspOpen, setInsp] = useInspector("camera");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const ui = useCameraUi();
  const cams = config?.cameras ?? [];
  const sel = cams.find((c) => c.id === ui.sel) ?? cams[0] ?? null;

  const crumbs = <Crumbs icon="camera" current="摄影机" />;
  if (!stage || !config) {
    return (
      <main className="ry-main">
        <Toolbar loc label="位置与对象操作">
          {crumbs}
        </Toolbar>
        {!loading && (
          <Empty icon="stage" title="还没有打开 Stage">
            打开一个 Stage 之后，这里列出它的摄影机和镜头标定。
          </Empty>
        )}
      </main>
    );
  }
  const add = () => {
    const cam = newCamera(config);
    save.mutate({ ...config, cameras: [...cams, cam] }, { onSuccess: () => openObject("camera", camTab(cam)), onError: (e) => toast(`添加失败：${errText(e)}`) });
  };

  return (
    <Workspace
      inspector={sel && <CameraSummary cam={sel} status={(variant?.status ?? lensKind)(sel)} profileName={profileFor(sel, profiles)?.name ?? null} width={inspW} onClose={() => setInsp(false)} onOpen={() => openObject("camera", camTab(sel))} />}
      inspectorOpen={inspOpen && !!sel}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      <Toolbar loc label="位置与对象操作">
        {crumbs}
        <Spacer />
        <Button variant="primary" icon="plus" busy={save.isPending} onClick={add}>
          添加摄影机
        </Button>
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>
      <Progress on={save.isPending} />
      {cams.length ? (
        <Table label="摄影机">
          <TableBody>
            {cams.map((c) => {
              const st = capture.camId === c.id && capture.phase === "capturing" ? { kind: "running" as const, label: "采集中" } : (variant?.status ?? lensKind)(c);
              return (
                <Row key={c.id} cols={LIST_COLS} selected={c === sel} onSelect={() => ui.set({ sel: c.id })} onOpen={() => openObject("camera", camTab(c))}>
                  <Status kind={st.kind} label={st.label} srOnly />
                  <RowTitle>{c.name}</RowTitle>
                  <RowEnd>{c.lens?.focal_mm ? `${+c.lens.focal_mm.toFixed(1)} mm` : "—"}</RowEnd>
                  <RowEnd>{c.lens?.calibration_rms_px != null ? `${c.lens.calibration_rms_px.toFixed(2)} px` : "—"}</RowEnd>
                  <span className={css.cell}>{profileFor(c, profiles)?.name ?? "—"}</span>
                  <span className={css.cell}>{c.tracking ? `${PROTOCOL_LABEL[c.tracking.protocol] ?? c.tracking.protocol} · UDP ${c.tracking.port ?? "—"}` : "没有追踪"}</span>
                </Row>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <Empty
          icon="camera"
          title="还没有摄影机"
          actions={
            <Button variant="primary" icon="plus" onClick={add}>
              添加摄影机
            </Button>
          }
        >
          {variant?.empty ?? "视觉重建要用标定好镜头的摄影机。先添加一台，再接上视频源做镜头标定。"}
        </Empty>
      )}
    </Workspace>
  );
}

function CameraSummary({ cam, status: st, profileName, width, onClose, onOpen }: { cam: ProjectCamera; status: { kind: StatusKind; label: string }; profileName: string | null; width: number; onClose: () => void; onOpen: () => void }) {
  return (
    <Inspector width={width}>
      <InspectorHead
        onClose={onClose}
        meta={<Status pill kind={st.kind} label={st.label} />}
        title={cameraLabel(cam)}
        actions={
          <Button icon="open" kbd="↵" onClick={onOpen}>
            打开
          </Button>
        }
      />
      <InspectorBody>
        <Props
          items={[
            { label: "镜头标定", value: cam.lens?.calibration_rms_px != null ? <span className="ry-num">{`RMS ${cam.lens.calibration_rms_px.toFixed(2)} px · ${cam.lens.calibration_poses ?? "—"} 帧`}</span> : null },
            { label: "镜头档案", value: cam.lens?.profile_path ? <span className="ry-mono">{baseName(cam.lens.profile_path.replace(/[\\/]lens\.json$/, ""))}</span> : null },
            { label: "视频源", value: profileName },
            { label: "追踪", value: cam.tracking ? `${PROTOCOL_LABEL[cam.tracking.protocol] ?? cam.tracking.protocol} · UDP ${cam.tracking.port ?? "—"}` : "没有" },
            { label: "标识", value: <span className="ry-mono">{cam.id}</span> },
          ]}
        />
      </InspectorBody>
    </Inspector>
  );
}

/* ------------------------------ 详情 ------------------------------ */

function CameraDetail({ camId }: { camId: string }) {
  const { stage, config } = useLedStage();
  const path = stage?.path ?? null;
  const save = useSaveStage(path);
  const qc = useQueryClient();
  const profilesQ = useCaptureProfiles();
  const sessionsQ = useLensSessions(path);
  const ui = useCameraUi();
  const capture = useCapture();
  const showList = useNav((s) => s.showList);
  const [inspOpen, setInsp] = useInspector("camera:detail");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const [starting, setStarting] = useState(false);

  const cam = config?.cameras?.find((c) => c.id === camId) ?? null;
  const profile = profileFor(cam, profilesQ.data?.profiles);
  const video = videoOf(profile);
  const mine = capture.camId === camId;
  const phase = mine ? capture.phase : "idle";
  const live = phase === "preparing" || phase === "capturing" || phase === "solving";
  const sessions = useMemo(() => sessionsFor(sessionsQ.data, camId), [sessionsQ.data, camId]);
  const screenIds = Object.keys(config?.screens ?? {});
  const screen = ui.screen && screenIds.includes(ui.screen) ? ui.screen : (screenIds[0] ?? null);
  const tab: CamTab = ui.tab === "result" && !sessions.length ? "capture" : ui.tab;
  const resultSession = sessions.find((s) => s.session_dir === ui.session) ?? sessions[0] ?? null;
  const resultInfo = useLensInfo(resultSession?.lens_json);

  /* 空闲时在采集页开监看；采集时由 capture stills 自己出画面。 */
  const monitorOn = tab === "capture" && !live && !!video && video.backend !== "synthetic" && !!video.device;
  const videoKey = video ? JSON.stringify(video) : "";
  useEffect(() => {
    if (monitorOn && video) void startMonitor(video);
    else void stopMonitor();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- video 以 videoKey 作比较
  }, [monitorOn, videoKey]);
  useEffect(() => () => void stopMonitor(), []);

  /* 采集中：Space 手动抓一帧。 */
  useEffect(() => {
    if (phase !== "capturing") return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.code === "Space" && !(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) {
        e.preventDefault();
        void snapNow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]);

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

  const start = async () => {
    if (!video) return toast("先在「信号源」里选好视频源");
    if (!screen) return toast("这个 Stage 还没有屏幕");
    setStarting(true);
    ui.set({ tab: "capture" });
    try {
      await startLensCapture({
        path,
        cfg: config,
        cam,
        video,
        screen,
        target: ui.target,
        minMarkers: ui.minMarkers,
        auto: ui.auto,
        save: (next) => save.mutateAsync(next),
        latestCfg: () => qc.getQueryData<ProjectConfig>(stageKeys.config(path)),
        onSessions: () => void sessionsQ.refetch(),
      });
    } catch (e) {
      toast(`没能开始标定：${errText(e)}`);
    } finally {
      setStarting(false);
    }
  };

  const doneNote = mine && capture.phase === "done" && capture.done;
  const onResult = tab === "result" && resultSession && cam;
  const verdict = onResult ? lensVerdict(cam, resultSession, resultInfo.data, resultInfo.isError) : null;
  const statusPill = (() => {
    if (verdict) return <Status pill kind={verdict.kind} label={verdict.label} />;
    if (phase === "preparing") return <Status pill kind="running" label="正在准备图案" />;
    if (phase === "capturing") return <Status pill kind="running" label={`采集中 · ${capture.snaps.length} / ${capture.target} 帧`} />;
    if (phase === "solving") return <Status pill kind="running" label="正在求解" />;
    if (phase === "failed") return <Status pill kind="failed" label="失败" />;
    const st = lensKind(cam);
    return <Status pill kind={st.kind} label={st.label} />;
  })();

  const inspector =
    tab === "result" && resultSession ? (
      <ResultInspector cam={cam} session={resultSession} config={config} width={inspW} onClose={() => setInsp(false)} save={(next) => save.mutateAsync(next)} />
    ) : (
      <CaptureInspector cam={cam} config={config} path={path} profile={profile} profiles={profilesQ.data?.profiles ?? []} screen={screen} width={inspW} onClose={() => setInsp(false)} save={(next) => save.mutateAsync(next)} live={live} />
    );

  return (
    <Workspace inspector={inspector} inspectorOpen={inspOpen} inspectorWidth={inspW} onInspectorWidth={setInspW} minWidth={INSPECTOR_MIN} maxWidth={INSPECTOR_MAX}>
      <Toolbar loc label="位置与对象操作">
        {crumbs}
        <Spacer />
        {phase === "capturing" ? (
          <>
            <Button variant="danger" icon="stop" onClick={() => void abortLensCapture(path, config)}>
              放弃采集
            </Button>
            <Button variant="primary" icon="check" disabled={capture.snaps.length < 3} title={capture.snaps.length < 3 ? "至少要 3 帧才能求解" : undefined} onClick={() => void finishLensCapture()}>
              完成并求解
            </Button>
          </>
        ) : phase === "preparing" || phase === "solving" ? (
          <Button variant="primary" busy>
            {phase === "preparing" ? "正在准备…" : "正在求解…"}
          </Button>
        ) : (
          <Button variant="primary" icon="play" busy={starting} disabled={!video} title={!video ? "先在「信号源」里选好视频源" : undefined} onClick={() => void start()}>
            {tab === "result" && resultSession && cam.lens?.profile_path !== resultSession.lens_json ? "补采并重新求解" : "开始标定"}
          </Button>
        )}
        <CameraMore cam={cam} config={config} path={path} live={live} />
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>

      <div className={`ry-detail ${css.camTop}`}>
        <div className={`ry-detail__head ${css.camHead}`}>
          <h1 className="ry-detail__title">{cameraLabel(cam)}</h1>
          <div className="ry-detail__meta">
            {statusPill}
            {cam.lens?.calibration_rms_px != null && !live && !verdict && <span className="ry-num">{`镜头标定 RMS ${cam.lens.calibration_rms_px.toFixed(2)} px`}</span>}
            {(live || verdict) && <span>镜头标定</span>}
            {(live || verdict) && <span>多机位抓帧</span>}
            {verdict && resultSession && <span className="ry-mono">{resultSession.id}</span>}
            {mine && capture.outDir && <span className="ry-mono">{baseName(capture.outDir)}</span>}
            {mine && phase === "capturing" && capture.startedAt && (
              <span className="ry-num">
                <Elapsed since={capture.startedAt} />
              </span>
            )}
          </div>
        </div>
        <div className="ry-detail__tools">
          <ToolTabs
            label="摄影机内容"
            value={tab}
            onChange={(k) => ui.set({ tab: k })}
            tabs={[
              { key: "capture", label: "采集" },
              { key: "result", label: "结果", disabled: live || !sessions.length },
              { key: "history", label: "历史" },
            ]}
          />
          {tab === "capture" && live && (
            <>
              <Chip pressed={ui.heat} onClick={() => ui.set({ heat: !ui.heat })}>
                {ui.heat && <Icon name="check" size="sm" className={css.chipIcon} />}
                覆盖热区
              </Chip>
              <Spacer />
              {phase === "capturing" && (
                <Button icon="capture" onClick={() => void snapNow()}>
                  手动抓一帧
                  <Kbd>Space</Kbd>
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {doneNote && tab === "capture" && (
        <div className={css.camBanner}>
          <Status kind={capture.done!.adopted ? "success" : "attention"} label={capture.done!.adopted ? "已采用" : "未采用"} srOnly />
          <span>
            {capture.done!.adopted
              ? `标定完成，RMS ${capture.done!.info.rms.toFixed(2)} px，已经采用。`
              : `标定完成，RMS ${capture.done!.info.rms.toFixed(2)} px，${capture.done!.info.qualified_master ? "没有比现在采用的更好" : "没通过资格检查"}，没有采用。`}
          </span>
          <Spacer />
          <Button
            onClick={() => {
              ui.set({ tab: "result", session: null });
              resetCapture();
            }}
          >
            看结果
          </Button>
        </div>
      )}
      {mine && capture.phase === "failed" && capture.error && tab === "capture" && (
        <div className={css.camBanner}>
          <Status kind="failed" label="失败" srOnly />
          <span className={css.cell}>{capture.error}</span>
          <Spacer />
          <Button onClick={resetCapture}>知道了</Button>
        </div>
      )}

      {tab === "capture" && (live ? <CaptureStage cam={cam} /> : <MonitorStage cam={cam} hasVideo={!!video} sourceName={profile?.name ?? null} />)}
      {tab === "result" && resultSession && <LensResult cam={cam} session={resultSession} />}
      {tab === "history" && <LensHistory cam={cam} sessions={sessions} loading={sessionsQ.isLoading} onPick={(s) => ui.set({ session: s.session_dir, tab: "result" })} />}

    </Workspace>
  );
}

/** 更多操作：改名、删除这台摄影机（AR 详情也用）。 */
export function CameraMore({ cam, config, path, live }: { cam: ProjectCamera; config: ProjectConfig; path: string; live: boolean }) {
  const save = useSaveStage(path);
  const closeObject = useNav((s) => s.closeObject);
  const updateObject = useNav((s) => s.updateObject);
  const [dialog, setDialog] = useState<"rename" | "remove" | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const rename = (name: string) =>
    save.mutate(withCamera(config, cam.id, (c) => ({ ...c, name })), {
      onSuccess: () => {
        updateObject("camera", `camera:${cam.id}`, { label: cameraLabel({ ...cam, name }) });
        setDialog(null);
      },
      onError: (e) => toast(`改名失败：${errText(e)}`),
    });
  const remove = () =>
    save.mutate(
      { ...config, cameras: (config.cameras ?? []).filter((c) => c.id !== cam.id) },
      {
        onSuccess: () => {
          setDialog(null);
          closeObject("camera", `camera:${cam.id}`);
          toast(`已删除 ${cam.name}，标定记录留在磁盘上`);
        },
        onError: (e) => toast(`删除失败：${errText(e)}`),
      },
    );
  return (
    <>
      <IconButton ref={ref} icon="more" label="更多操作：改名、删除这台摄影机" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <Menu anchor={ref} onClose={() => setOpen(false)} label="更多操作" alignEnd>
          <MenuItem onSelect={() => (setOpen(false), setDialog("rename"))}>改名</MenuItem>
          <MenuItem danger disabled={live} onSelect={() => (setOpen(false), setDialog("remove"))}>
            删除这台摄影机
          </MenuItem>
        </Menu>
      )}
      {dialog === "rename" && <RenameDialog name={cam.name} busy={save.isPending} onClose={() => setDialog(null)} onSave={rename} />}
      {dialog === "remove" && (
        <ConfirmDialog
          title={`删除 ${cam.name}？`}
          body="从 Stage 里去掉这台摄影机。磁盘上的标定记录不删，之后可以手动清理。"
          safeLabel="保留"
          dangerLabel="删除"
          busy={save.isPending}
          onClose={() => setDialog(null)}
          onConfirm={remove}
        />
      )}
    </>
  );
}

function RenameDialog({ name, busy, onClose, onSave }: { name: string; busy: boolean; onClose: () => void; onSave: (n: string) => void }) {
  const [v, setV] = useState(name);
  const ok = v.trim().length > 0;
  return (
    <Dialog
      title="改名"
      width={400}
      onClose={onClose}
      actions={
        <>
          <Button kbd="Esc" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" busy={busy} disabled={!ok} onClick={() => onSave(v.trim())}>
            保存
          </Button>
        </>
      }
    >
      <Fields>
        <Field label="名称" htmlFor="cam-name">
          <TextInput id="cam-name" value={v} onChange={setV} onKeyDown={(e) => e.key === "Enter" && ok && onSave(v.trim())} />
        </Field>
      </Fields>
    </Dialog>
  );
}

/* ------------------------------ 采集中 ------------------------------ */

function HeatGrid({ cells, overlay }: { cells: boolean[]; overlay?: boolean }) {
  const miss = missingText(cells);
  return (
    <div className={cx(css.heat, overlay && css.heatOverlay)} role="img" aria-label={`监看画面的覆盖热区：6 列 4 行，${miss ? `${miss}还没有观测` : "全部有观测"}`}>
      {cells.map((ok, i) => (ok ? <div key={i} className={css.heatOk} /> : <div key={i} className={css.heatMiss}>缺</div>))}
    </div>
  );
}

function CaptureStage({ cam }: { cam: ProjectCamera }) {
  const capture = useCapture();
  const ui = useCameraUi();
  const fmt = formatSource(capture.source);
  const left = capture.target - capture.snaps.length;
  const miss = missingText(capture.cells);
  const hint =
    capture.phase === "preparing"
      ? "正在导出屏幕定义、生成校正图案并推到上屏…"
      : capture.phase === "solving"
        ? "采集完成，正在求解镜头内参…"
        : capture.warning
          ? capture.warning
          : miss
            ? `把机位转向画面${miss}，再补 ${Math.max(1, Math.min(left, 3))} 帧。`
            : left > 0
              ? `换个机位角度继续拍，还差 ${left} 帧。`
              : "帧数够了，正在收尾。";
  return (
    <div className={css.camBody}>
      <div className={css.stage}>
        <div className={`ry-meta ${css.stageMetaL}`}>{fmt ?? "等待画面"}</div>
        <div className={`ry-meta ${css.stageMetaR}`}>{cam.tracking ? `${PROTOCOL_LABEL[cam.tracking.protocol] ?? cam.tracking.protocol} 追踪不参与镜头标定` : "追踪未接入 · 按固定机位求解"}</div>
        <div className={css.stageFrame}>
          {capture.preview && <img className={css.stageImg} src={capture.preview} alt="" />}
          {(ui.heat || !capture.preview) && <HeatGrid cells={capture.cells} overlay={!!capture.preview} />}
        </div>
      </div>
      <div className={css.strip}>
        <span className="ry-meta">{`已采 ${capture.snaps.length} 帧${capture.markers != null ? ` · 当前画面 ${capture.markers} 个标记` : ""}`}</span>
        <div className={css.snaps}>
          {capture.snaps.slice(-14).map((s, i, arr) => (
            <span key={s.index} className={cx("ry-tag", css.snap, i === arr.length - 1 && css.snapLast)} title={s.markers != null ? `${s.markers} 个标记${s.auto ? " · 自动" : " · 手动"}` : undefined}>
              {String(s.index + 1).padStart(2, "0")}
            </span>
          ))}
        </div>
        <Spacer />
        <span className={css.hint}>{hint}</span>
      </div>
    </div>
  );
}

/* ------------------------------ 空闲：监看 + 追踪 ------------------------------ */

function MonitorStage({ cam, hasVideo, sourceName }: { cam: ProjectCamera; hasVideo: boolean; sourceName: string | null }) {
  const mon = useMonitor();
  const track = useTracking();
  const [fit, setFit] = useState<"contain" | "cover">("contain");
  const fmt = formatSource(mon.source);
  const sigLabel = mon.sig === "ok" ? "信号正常" : mon.sig === "waiting" ? "等待信号" : mon.sig === "lost" ? "没有信号" : "监看未开";
  return (
    <>
      <div className={`volo-viewport ${css.monitor}`}>
        {mon.url ? (
          <img className={cx(css.monitorImg, fit === "cover" && css.monitorCover)} src={mon.url} alt={`${cam.name} 的实时画面`} />
        ) : (
          <div className={css.monitorEmpty}>{!hasVideo ? "还没选视频源。在 Inspector 的「信号源」里选。" : mon.sig === "lost" ? (mon.error ?? "视频源没有信号") : "正在连接视频源…"}</div>
        )}
        <div className="volo-viewport__hud volo-viewport__hud--col" data-at="tr" role="toolbar" aria-label="视角">
          <IconButton icon="fit" label={fit === "contain" ? "铺满窗口" : "适应窗口"} pressed={fit === "cover"} onClick={() => setFit((f) => (f === "contain" ? "cover" : "contain"))} />
        </div>
        <div className="volo-viewport__readout" data-at="bl">
          <span>{sourceName ?? "没有视频源"}</span>
          {fmt && <span>{fmt}</span>}
          <span>{sigLabel}</span>
        </div>
      </div>
      {cam.tracking && (
        <section aria-label="追踪数据" className={css.track}>
          <div className={css.trackHead}>
            {track.task ? (
              track.pose ? (
                <Status pill kind="success" label="追踪数据正常" />
              ) : (
                <Status pill kind="running" label="等待追踪数据" />
              )
            ) : (
              <Status pill kind="queued" label={track.error ? "监听已停止" : "没在监听"} />
            )}
            <span className="ry-meta">
              {[`${PROTOCOL_LABEL[cam.tracking.protocol] ?? cam.tracking.protocol} · UDP ${cam.tracking.port ?? 6301}`, cam.tracking.camera_id != null ? `机位 #${cam.tracking.camera_id}` : null, track.rate != null ? `${track.rate} 包 / 秒` : null].filter(Boolean).join(" · ")}
            </span>
            <Spacer />
            {track.task ? (
              <Button icon="stop" onClick={() => void stopTracking()}>
                停止监听
              </Button>
            ) : (
              <Button icon="play" onClick={() => void startTracking(cam.tracking!.protocol, cam.tracking!.host ?? "0.0.0.0", cam.tracking!.port ?? 6301)}>
                开始监听
              </Button>
            )}
          </div>
          <div className={css.trackGrid}>
            {(
              [
                ["X", track.pose?.x, 3, "m"],
                ["Y", track.pose?.y, 3, "m"],
                ["Z", track.pose?.z, 3, "m"],
                ["水平", track.pose?.pan, 2, "°"],
                ["俯仰", track.pose?.tilt, 2, "°"],
                ["横滚", track.pose?.roll, 2, "°"],
                ["变焦", track.pose?.zoom, 0, ""],
                ["对焦", track.pose?.focus, 0, ""],
              ] as [string, number | null | undefined, number, string][]
            ).map(([k, v, d, u]) => (
              <div key={k} className={css.trackCell}>
                <div className={css.trackLabel}>{k}</div>
                <div className={css.trackVal}>
                  {v == null ? "—" : v.toFixed(d).replace("-", "−")}
                  {v != null && u && <span className={css.trackUnit}>{u}</span>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/* ------------------------------ 结果 ------------------------------ */

function LensResult({ cam, session }: { cam: ProjectCamera; session: LensSessionSummary }) {
  const info = useLensInfo(session.lens_json);
  const cells = useCoverage((s) => s.byDir[session.session_dir]) ?? null;
  const i = info.data;
  const frames = session.poses_captured;
  const covered = cells ? cells.filter(Boolean).length : null;
  const miss = cells ? missingText(cells) : null;
  const sensorW = cam.lens?.sensor_w_mm;
  const focalMm = i && sensorW && i.image_size?.[0] ? (i.fx * sensorW) / i.image_size[0] : null;
  const k = i?.dist_coeffs ?? [];
  const fmt = (n: number, d: number) => n.toFixed(d).replace("-", "−");
  const steps: string[] = [];
  if (i) {
    if (miss) steps.push(`把机位转向画面${miss}补几帧，让每一格都有观测。`);
    if (!i.qualified_master) i.reasons.forEach((r) => steps.push(r));
    if (i.rms >= RMS_ADOPT_PX) steps.push("确认上次采集之后没有动过对焦和变焦。动过的话全部重采。");
    if (steps.length) steps.push(`重新求解。RMS 低于 ${RMS_ADOPT_PX.toFixed(2)} px 才会自动采用。`);
  }
  return (
    <div className={css.resultBody}>
      {info.isError && <p className={css.resultErr}>{`读不到这次的镜头结果：${errText(info.error)}`}</p>}
      <div className={css.stats}>
        <Stat label="重投影 RMS" value={i ? i.rms.toFixed(2) : "—"} unit={i ? "px" : ""} note={`阈值 ${RMS_ADOPT_PX.toFixed(2)} px`} />
        <Stat label="用上的帧" value={i ? String(i.num_images) : "—"} unit={frames != null ? `/ ${frames}` : ""} note={i && frames != null && frames > i.num_images ? `${frames - i.num_images} 帧被剔除` : i ? `${i.num_points} 个点` : ""} />
        <Stat label="画面覆盖" value={covered != null ? String(covered) : "—"} unit={covered != null ? `/ ${GRID_CELLS} 格` : ""} note={cells ? (miss ? `${miss}没有观测` : "全部有观测") : "这次没有记录覆盖"} />
        <Stat label="焦距" value={focalMm ? focalMm.toFixed(1) : "—"} unit={focalMm ? "mm" : ""} note={cam.lens?.focal_mm ? `标称 ${+cam.lens.focal_mm.toFixed(1)} mm` : sensorW ? "" : "没填传感器宽度，换算不了毫米"} />
      </div>
      <div className={css.resultCols}>
        <div>
          <h3 className={`volo-fields__title ${css.secTitle}`}>哪些位置有观测</h3>
          {cells ? (
            <div className={css.covGrid} role="img" aria-label={`画面分成 6 列 4 行，${miss ? `${miss}没有观测` : "全部有观测"}`}>
              {cells.map((ok, idx) => (
                <span key={idx} className={cx(css.covCell, !ok && css.covMiss)}>
                  {ok ? "" : "缺"}
                </span>
              ))}
            </div>
          ) : (
            <p className={css.dim}>覆盖只在采集的那台电脑上记录。</p>
          )}
        </div>
        <div>
          <h3 className={`volo-fields__title ${css.secTitleTight}`}>求出来的参数</h3>
          <ParamRow k="焦距 fx · fy" v={i ? `${i.fx.toFixed(1)} · ${i.fy.toFixed(1)} px` : "—"} />
          <ParamRow k="主点 cx · cy" v={i ? `${i.cx.toFixed(1)} · ${i.cy.toFixed(1)} px` : "—"} />
          <ParamRow k="畸变 k1 · k2" v={k.length >= 2 ? `${fmt(k[0], 4)} · ${fmt(k[1], 4)}` : "—"} note={miss ? "边角的畸变是外推的，没有观测支撑" : undefined} />
          <ParamRow k="画幅" v={i?.image_size ? `${i.image_size[0]} × ${i.image_size[1]} px` : "—"} note={i ? (i.qualified_master ? "通过镜头资格检查" : "没通过镜头资格检查") : undefined} />
        </div>
      </div>
      {steps.length > 0 && (
        <>
          <h3 className={`volo-fields__title ${css.secTitleTop}`}>建议按这个顺序处理</h3>
          <ol className={css.steps}>
            {steps.map((s, idx) => (
              <li key={idx}>{s}</li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, unit, note }: { label: string; value: string; unit: string; note: string }) {
  return (
    <div className={css.stat}>
      <span className="ry-meta">{label}</span>
      <span className={`ry-num ${css.statVal}`}>
        {value} {unit && <span className={css.statUnit}>{unit}</span>}
      </span>
      <span className={`ry-meta ${css.statNote}`}>{note}</span>
    </div>
  );
}

function ParamRow({ k, v, note }: { k: string; v: string; note?: string }) {
  return (
    <div className={css.paramRow}>
      <span className={css.paramK}>{k}</span>
      <span className={`ry-mono ${css.paramV}`}>{v}</span>
      <span>{note}</span>
    </div>
  );
}

/* ------------------------------ 历史 ------------------------------ */

const HIST_COLS = "16px minmax(180px, 1fr) 72px 84px 96px";

function LensHistory({ cam, sessions, loading, onPick }: { cam: ProjectCamera; sessions: LensSessionSummary[]; loading: boolean; onPick: (s: LensSessionSummary) => void }) {
  if (!sessions.length) {
    return loading ? null : (
      <Empty icon="clock" title="还没有标定记录">
        开始一次镜头标定，结果会记在这里。
      </Empty>
    );
  }
  return (
    <Table label="镜头标定记录">
      <TableBody>
        {sessions.map((s) => (
          <HistoryRow key={s.session_dir} s={s} adopted={!!s.lens_json && cam.lens?.profile_path === s.lens_json} onOpen={() => onPick(s)} />
        ))}
      </TableBody>
    </Table>
  );
}

function HistoryRow({ s, adopted, onOpen }: { s: LensSessionSummary; adopted: boolean; onOpen: () => void }) {
  const info = useLensInfo(s.lens_json);
  const st: { kind: StatusKind; label: string } = s.error || info.isError ? { kind: "failed", label: "失败" } : !info.data ? { kind: "queued", label: "未求解" } : info.data.qualified_master && info.data.rms < RMS_ADOPT_PX ? { kind: "success", label: "可用" } : { kind: "attention", label: "需处理" };
  return (
    <Row cols={HIST_COLS} onSelect={onOpen} onOpen={onOpen}>
      <Status kind={st.kind} label={st.label} srOnly />
      <RowTitle
        tags={
          adopted && (
            <span className={`ry-tag ${css.tagCurrent}`}>
              <Icon name="check" size="sm" />
              当前采用
            </span>
          )
        }
      >
        <span className="ry-mono">{s.id}</span>
      </RowTitle>
      <RowEnd>{s.poses_captured != null ? `${s.poses_captured} 帧` : "—"}</RowEnd>
      <RowEnd>{info.data ? `${info.data.rms.toFixed(2)} px` : "—"}</RowEnd>
      <RowEnd>{s.modified_at ? shortTime(s.modified_at) : "—"}</RowEnd>
    </Row>
  );
}

