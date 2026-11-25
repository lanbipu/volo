/* 摄影机 Inspector：前置条件 / 信号源 / 参数（Camera.dc.html、CameraSources.dc.html），结果的结论 / 活动（CameraResult.dc.html）。 */
import { useState } from "react";
import type { CaptureProfile } from "@/api/captureProfiles";
import type { LensSessionSummary } from "@/api/lensCommands";
import type { ProjectCamera, ProjectCameraTracking, ProjectConfig } from "@/api/types";
import { copyText } from "@/lib/clipboard";
import { errText, toast } from "@/lib/toast";
import { Activity, Button, Field, Fields, FieldsTitle, IconButton, Inspector, InspectorBody, InspectorHead, Note, Props, Seg, Select, Status, Switch, TextInput, ToolTabs, type ActivityItem } from "@/ui";
import {
  BACKENDS,
  baseName,
  formatSource,
  lensPatch,
  lensVerdict,
  lensRoot,
  PROTOCOL_LABEL,
  RMS_ADOPT_PX,
  startTracking,
  stopTracking,
  useCameraUi,
  useLensInfo,
  useLensTarget,
  useMonitor,
  useNics,
  useSaveProfiles,
  useTracking,
  useVideoSources,
  videoOf,
  withCamera,
  GRID_CELLS,
} from "../model/camera";
import { composite, nodeScreens, resolveTopology, useOutputSession } from "../model/output";
import { fullTime, shortTime } from "../model/rebuild";
import css from "./led.module.css";

type Save = (next: ProjectConfig) => Promise<unknown>;

/* ------------------------------ 采集 Inspector ------------------------------ */

export function CaptureInspector({ cam, config, path, profile, profiles, screen, width, onClose, save, live }: {
  cam: ProjectCamera;
  config: ProjectConfig;
  path: string;
  profile: CaptureProfile | null;
  profiles: CaptureProfile[];
  screen: string | null;
  width: number;
  onClose: () => void;
  save: Save;
  live: boolean;
}) {
  const ui = useCameraUi();
  return (
    <Inspector width={width}>
      <InspectorHead
        tabs={
          <ToolTabs
            label="Inspector 内容"
            value={ui.insp}
            onChange={(k) => ui.set({ insp: k })}
            tabs={[
              { key: "pre", label: "前置条件" },
              { key: "source", label: "信号源" },
              { key: "params", label: "参数" },
            ]}
          />
        }
        onClose={onClose}
        meta={
          ui.insp === "source" ? (
            <>
              <span>{cam.name} 的信号从哪来</span>
              <span>改动立即保存</span>
            </>
          ) : ui.insp === "params" ? (
            <span>{live ? "采集中不能改" : "下一次标定用"}</span>
          ) : undefined
        }
        title={ui.insp === "source" ? "信号源" : ui.insp === "params" ? "参数" : undefined}
      />
      <InspectorBody>
        {ui.insp === "pre" && <Prereqs cam={cam} config={config} path={path} profile={profile} screen={screen} />}
        {ui.insp === "source" && <CameraSources cam={cam} config={config} profile={profile} profiles={profiles} save={save} live={live} />}
        {ui.insp === "params" && <Params config={config} path={path} screen={screen} live={live} />}
      </InspectorBody>
    </Inspector>
  );
}

function Prereqs({ cam, config, path, profile, screen }: { cam: ProjectCamera; config: ProjectConfig; path: string; profile: CaptureProfile | null; screen: string | null }) {
  const ui = useCameraUi();
  const sess = useOutputSession();
  const mon = useMonitor();
  const target = useLensTarget(path, screen);
  const topo = resolveTopology(config);
  const comp = composite(config.screens);
  const drivers = topo && screen ? topo.nodes.filter((n) => nodeScreens(n, comp).includes(screen)).map((n) => n.node_id) : [];
  const others = Object.keys(config.screens).filter((id) => id !== screen);
  const video = videoOf(profile);
  const ok = { icon: "success" as const, iconColor: "var(--status-success)" };
  const warn = { icon: "attention" as const, iconColor: "var(--volo-attention)" };
  const bad = { icon: "failed" as const, iconColor: "var(--status-failed)" };
  const wait = { icon: "spinner" as const };
  const opt = { icon: "queued" as const };
  const line = (title: string, sub: string) => (
    <span>
      <b>{title}</b>
      <br />
      {sub}
    </span>
  );
  const items: ActivityItem[] = [
    sess.phase === "showing"
      ? { key: "out", ...ok, text: line("上屏正在显示", `${screen ?? "—"} · nDisplay 集群${drivers.length ? ` · ${drivers.join("、")}` : ""}`), time: "就绪" }
      : sess.phase === "standby"
        ? { key: "out", ...ok, text: line("上屏已开始输出", `开始标定时自动把 ${screen ?? "—"} 的校正图案推上屏`), time: "就绪" }
        : { key: "out", ...warn, text: line("上屏还没开始输出", "先到「上屏」开始输出，采集时屏幕要打校正图案。"), time: "未就绪" },
    !video
      ? { key: "video", ...warn, text: line("还没选视频源", "在「信号源」里选采集卡、NDI 或 USB 摄像头。"), time: "未就绪" }
      : video.backend === "synthetic"
        ? { key: "video", ...ok, text: line("合成测试源", "内置图案，只用于演练流程"), time: "就绪" }
        : mon.sig === "ok"
          ? { key: "video", ...ok, text: line("视频源有信号", [profile?.name, formatSource(mon.source)].filter(Boolean).join(" · ")), time: "就绪" }
          : mon.sig === "lost"
            ? { key: "video", ...bad, text: line("视频源没有信号", mon.error ?? "检查线缆、设备和格式"), time: "失败" }
            : { key: "video", ...wait, text: line("等待视频信号", profile?.name ?? video.device), time: "检查中" },
    !screen
      ? { key: "screen", ...warn, text: line("还没有屏幕", "先在「屏幕」里建一块屏。"), time: "未就绪" }
      : target.isLoading
        ? { key: "screen", ...wait, text: line("正在导出屏幕定义", `${screen} 的屏幕定义和校正图案`), time: "进行中" }
        : target.isError
          ? { key: "screen", ...bad, text: line("屏幕定义导出失败", errText(target.error)), time: "失败" }
          : { key: "screen", ...ok, text: line("屏幕定义已导出", `${screen}${others.length ? `；${others.join("、")}不参与本次标定` : ""}`), time: "就绪" },
    cam.tracking
      ? { key: "track", ...opt, text: line(`追踪源 ${PROTOCOL_LABEL[cam.tracking.protocol] ?? cam.tracking.protocol}`, "镜头标定只用画面，追踪数据不参与。"), time: "可选" }
      : { key: "track", ...opt, text: line("追踪源未接入", "可选。没有追踪时按固定机位求解，结果只对当前机位有效。"), time: "可选" },
  ];
  return (
    <>
      <Activity items={items} />
      <h3 className={css.subHead}>本次采集</h3>
      <Props
        items={[
          { label: "目的", value: "镜头内参" },
          { label: "图案", value: screen ? <span className="ry-mono">{`${screen} · 校正图案`}</span> : null },
          { label: "目标", value: <span className="ry-num">{`${ui.target} 帧，画面 ${GRID_CELLS} 格全部有观测`}</span> },
          { label: "稳定", value: ui.auto ? "画面静止后自动抓帧" : "手动抓帧（Space）" },
          { label: "输出", value: <span className="ry-mono">{lensRoot(path)}</span> },
        ]}
      />
    </>
  );
}

export function CameraSources({ cam, config, profile, profiles, save, live }: { cam: ProjectCamera; config: ProjectConfig; profile: CaptureProfile | null; profiles: CaptureProfile[]; save: Save; live: boolean }) {
  const saveProfiles = useSaveProfiles();
  const video = videoOf(profile);
  const backend = video?.backend ?? null;
  const sources = useVideoSources(backend);
  const nics = useNics();
  const track = useTracking();
  const [port, setPort] = useState(String(cam.tracking?.port ?? 6301));

  /* 摄影机没绑采集配置：建一个以它命名的。 */
  const updateProfile = async (patch: Record<string, unknown>) => {
    try {
      if (profile) {
        await saveProfiles.mutateAsync(profiles.map((p) => (p.id === profile.id ? { ...p, ...patch } : p)));
      } else {
        const id = `cam-${cam.id}`;
        const next: CaptureProfile = { id, name: `${cam.name} 视频源`, videoBackend: "decklink", device: "", fmtMode: "auto", transferFunction: "sdr", ...patch };
        await saveProfiles.mutateAsync([...profiles.filter((p) => p.id !== id), next]);
        await save(withCamera(config, cam.id, (c) => ({ ...c, video_profile_id: id })));
      }
    } catch (e) {
      toast(`保存失败：${errText(e)}`);
    }
  };
  const setTracking = (t: ProjectCameraTracking | null) => save(withCamera(config, cam.id, (c) => ({ ...c, tracking: t }))).catch((e) => toast(`保存失败：${errText(e)}`));

  const list = sources.data?.sources ?? [];
  const [card, conn] = video?.device.split(":") ?? ["", ""];
  const deviceOptions =
    backend === "decklink"
      ? list.map((s) => ({ value: String(s.index ?? s.name), label: s.name }))
      : backend === "ndi"
        ? list.map((s) => ({ value: s.name, label: s.name }))
        : list.map((s, i) => ({ value: String(s.index ?? i), label: s.name }));
  const deviceValue = backend === "decklink" ? card || null : video?.device || null;
  /* 当前值不在枚举里（设备离线 / 手填）：也列出来，免得看起来像没选。 */
  if (deviceValue && !deviceOptions.some((o) => o.value === deviceValue)) deviceOptions.unshift({ value: deviceValue, label: deviceValue });
  const connectors = backend === "decklink" ? (list.find((s) => String(s.index) === card)?.connectors ?? []) : [];
  const protocol = cam.tracking?.protocol ?? "none";

  return (
    <>
      <Fields>
        <FieldsTitle>画面</FieldsTitle>
        {profiles.length > 1 && (
          <Field label="采集配置" inline>
            <Select value={profile?.id ?? null} options={profiles.map((p) => ({ value: p.id, label: p.name }))} disabled={live} onChange={(id) => void save(withCamera(config, cam.id, (c) => ({ ...c, video_profile_id: id })))} />
          </Field>
        )}
        <Field label="类型" inline>
          <Select value={backend} options={BACKENDS} disabled={live} placeholder="选择类型…" onChange={(b) => void updateProfile({ videoBackend: b, device: "" })} />
        </Field>
        {backend && backend !== "synthetic" && (
          <Field label="设备" inline hint={sources.isError ? `找设备失败：${errText(sources.error)}` : sources.isLoading ? "正在找设备…" : !list.length ? "没找到设备" : undefined}>
            <Select value={deviceValue} options={deviceOptions} disabled={live || !deviceOptions.length} placeholder="选择设备…" onChange={(d) => void updateProfile({ device: backend === "decklink" ? (connectors.length ? `${d}:${connectors[0].id}` : d) : d })} />
          </Field>
        )}
        {backend === "decklink" && connectors.length > 0 && (
          <Field label="输入口" inline>
            <Select value={conn || null} options={connectors.map((c) => ({ value: c.id, label: c.name }))} disabled={live} onChange={(c) => void updateProfile({ device: `${card}:${c}` })} />
          </Field>
        )}
        {backend && (
          <Field label="格式" inline hint="标定要用摄影机的原始信号，不能带字符叠加或缩放。">
            <Select
              value={video?.fmtMode ?? "auto"}
              options={[
                { value: "auto", label: "跟随信号" },
                { value: "manual", label: video?.width ? `固定 ${video.width} × ${video.height}${video.fps ? ` · ${video.fps}p` : ""}` : "固定格式" },
              ]}
              disabled={live}
              onChange={(m) => void updateProfile({ fmtMode: m })}
            />
          </Field>
        )}
      </Fields>
      <div className={css.gap12} />
      <Fields>
        <FieldsTitle>追踪</FieldsTitle>
        <Field label="协议" inline hint={protocol === "none" ? "没有追踪时按固定机位标定，结果只对当前机位有效。" : undefined}>
          <Seg
            label="协议"
            block
            options={[
              { value: "freed", label: "FreeD" },
              { value: "opentrackio", label: "OpenTrackIO" },
              { value: "none", label: "没有" },
            ]}
            value={protocol}
            onChange={(p) => void setTracking(p === "none" ? null : { protocol: p, host: cam.tracking?.host ?? "0.0.0.0", port: cam.tracking?.port ?? 6301, camera_id: p === "freed" ? (cam.tracking?.camera_id ?? null) : null })}
          />
        </Field>
        {cam.tracking && (
          <>
            <Field label="端口" inline htmlFor="cam-port">
              <TextInput
                id="cam-port"
                num
                mono
                value={port}
                onChange={(t) => setPort(t.replace(/\D/g, ""))}
                onBlur={() => Number(port) > 0 && Number(port) !== cam.tracking?.port && void setTracking({ ...cam.tracking!, port: Number(port) })}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            </Field>
            <Field label="网卡" inline>
              <Select
                value={cam.tracking.host ?? "0.0.0.0"}
                options={[{ value: "0.0.0.0", label: "全部网卡" }, ...(nics.data ?? []).map((n) => ({ value: n.ipv4, label: `${n.ipv4} · ${n.name}` }))]}
                onChange={(h) => void setTracking({ ...cam.tracking!, host: h })}
              />
            </Field>
            {cam.tracking.protocol === "freed" && (
              <Field label="机位" inline hint={track.cameraIds.length > 1 ? `同一个端口上有 ${track.cameraIds.length} 个机位在发数据，选 ${cam.name} 对应的那个。` : undefined}>
                <Select
                  value={cam.tracking.camera_id != null ? String(cam.tracking.camera_id) : null}
                  options={[...new Set([...(cam.tracking.camera_id != null ? [cam.tracking.camera_id] : []), ...track.cameraIds])].map((id) => ({ value: String(id), label: track.cameraIds.length > 1 ? `#${id} · 监听到 ${track.cameraIds.length} 个` : `#${id}` }))}
                  placeholder={track.task ? "等待数据…" : "先开始监听"}
                  onChange={(id) => void setTracking({ ...cam.tracking!, camera_id: Number(id) })}
                />
              </Field>
            )}
          </>
        )}
      </Fields>
      {cam.tracking && (
        <>
          <div className={css.gap12} />
          <div className={css.btnRowTight}>
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
        </>
      )}
    </>
  );
}

function Params({ config, path, screen, live }: { config: ProjectConfig; path: string; screen: string | null; live: boolean }) {
  const ui = useCameraUi();
  const [target, setTarget] = useState(String(ui.target));
  const [minM, setMinM] = useState(String(ui.minMarkers));
  const ids = Object.keys(config.screens);
  return (
    <Fields>
      <Field label="打图案的屏幕" hint="镜头标定只用一块屏。挑摄影机能拍满画面的那块。">
        <Select value={screen} options={ids.map((id) => ({ value: id, label: id }))} disabled={live || !ids.length} onChange={(s) => ui.set({ screen: s })} />
      </Field>
      <Fields row>
        <Field label="目标帧数" htmlFor="cam-target">
          <TextInput id="cam-target" num value={target} disabled={live} onChange={(t) => setTarget(t.replace(/\D/g, ""))} onBlur={() => Number(target) >= 3 ? ui.set({ target: Number(target) }) : setTarget(String(ui.target))} />
        </Field>
        <Field label="每帧最少标记" htmlFor="cam-minm">
          <TextInput id="cam-minm" num value={minM} disabled={live} onChange={(t) => setMinM(t.replace(/\D/g, ""))} onBlur={() => Number(minM) >= 4 ? ui.set({ minMarkers: Number(minM) }) : setMinM(String(ui.minMarkers))} />
        </Field>
      </Fields>
      <Field label="自动抓帧" inline hint="画面静止、并且和已采的帧差别够大时自动抓。关掉就只能按 Space 手动抓。">
        <Switch checked={ui.auto} disabled={live} onChange={(v) => ui.set({ auto: v })} label="自动抓帧" />
      </Field>
      <Field label="输出目录">
        <span className={`ry-mono ${css.cell}`}>{lensRoot(path)}</span>
      </Field>
    </Fields>
  );
}

/* ------------------------------ 结果 Inspector ------------------------------ */

export function ResultInspector({ cam, session, config, width, onClose, save }: { cam: ProjectCamera; session: LensSessionSummary; config: ProjectConfig; width: number; onClose: () => void; save: Save }) {
  const [tab, setTab] = useState<"verdict" | "activity">("verdict");
  const [busy, setBusy] = useState(false);
  const info = useLensInfo(session.lens_json);
  const i = info.data;
  const verdict = lensVerdict(cam, session, i, info.isError);
  const adopted = verdict.adopted;
  const prevRms = cam.lens?.calibration_rms_px;

  const adopt = async () => {
    if (!i || !session.lens_json) return;
    setBusy(true);
    try {
      await save(withCamera(config, cam.id, (c) => ({ ...c, lens: lensPatch(c.lens, session.lens_json!, i) })));
      toast(`${cam.name} 改用 ${session.id}`);
    } catch (e) {
      toast(`采用失败：${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const current = cam.lens?.profile_path ? baseName(cam.lens.profile_path.replace(/[\\/]lens\.json$/, "")) : null;
  const note = (() => {
    if (!i || adopted) return null;
    if (!i.qualified_master) return i.reasons.length ? i.reasons.join("；") : "镜头资格检查没通过。";
    if (prevRms != null && current) return `${cam.name} 现在用的是 ${current} 的结果（RMS ${prevRms.toFixed(2)} px）。这一次${i.rms > prevRms ? "更差" : "没达到阈值"}，所以没有替换它。`;
    return `RMS ${i.rms.toFixed(2)} px，高于自动采用的阈值 ${RMS_ADOPT_PX.toFixed(2)} px。`;
  })();

  return (
    <Inspector width={width}>
      <InspectorHead
        tabs={
          <ToolTabs
            label="Inspector 内容"
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "verdict", label: "结论" },
              { key: "activity", label: "活动" },
            ]}
          />
        }
        onClose={onClose}
        meta={
          <>
            <span>这次结果</span>
            <Status pill kind={verdict.kind} label={verdict.label} />
          </>
        }
        title={verdict.title}
        actions={
          <>
            {!adopted && i?.qualified_master && (
              <Button busy={busy} onClick={() => void adopt()}>
                仍然采用
              </Button>
            )}
            <Button icon="verify" disabled title="验证叠加还没有接入">
              查看验证叠加
            </Button>
          </>
        }
      />
      <InspectorBody>
        {tab === "verdict" && (
          <>
            {note && (
              <>
                <Note kind="failed">
                  <p>{note}</p>
                </Note>
                <div className={css.gap20} />
              </>
            )}
            <Props
              items={[
                { label: "现在采用", value: current ? <span className="ry-num">{`会话 ${current}${prevRms != null ? ` · RMS ${prevRms.toFixed(2)} px` : ""}`}</span> : "还没有" },
                { label: "用到它的", value: null },
                { label: "目的", value: "镜头内参" },
                { label: "完成于", value: session.modified_at ? <span className="ry-num">{fullTime(session.modified_at)}</span> : null },
                {
                  label: "目录",
                  value: <span className="ry-mono">{session.session_dir}</span>,
                  action: <IconButton icon="copy" size="sm" label="复制目录" onClick={() => copyText(session.session_dir, "已复制目录")} />,
                },
              ]}
            />
            <h3 className={css.subHead}>带到别处用</h3>
            <div className={css.btnRowTight}>
              <Button icon="export" disabled title="OpenTrackIO 导出还没有接入">
                导出 OpenTrackIO…
              </Button>
              <Button disabled title="存为镜头档案还没有接入">
                存为可复用的镜头档案…
              </Button>
            </div>
          </>
        )}
        {tab === "activity" && (
          <Activity
            items={[
              ...(adopted ? [{ key: "adopt", icon: "check" as const, text: `${cam.name} 正在使用这次结果` }] : []),
              ...(i ? [{ key: "solve", icon: "success" as const, iconColor: "var(--status-success)", text: `求解完成 · RMS ${i.rms.toFixed(2)} px · ${i.num_images} 帧`, time: session.modified_at ? shortTime(session.modified_at) : undefined }] : []),
              { key: "cap", icon: "capture" as const, text: `采集 ${session.poses_captured ?? "—"} 帧` },
            ]}
          />
        )}
      </InspectorBody>
    </Inspector>
  );
}

