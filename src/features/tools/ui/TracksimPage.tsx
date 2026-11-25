/* 工具 · 追踪模拟（设计：Tracksim.dc.html）。
   用 tracksim 合成一路摄影机追踪信号（FreeD / OpenTrackIO）发给 UE / Disguise，没有真追踪设备时测接收端。
   画面：俯视 / 侧视 / 透视下的整条轨迹（只预览 .json 轨迹）+ 已播部分 + 摄影机视野；下面是正在发送的数值。 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { pickFile } from "@/api/commands";
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
  IconButton,
  Inspector,
  InspectorBody,
  InspectorHead,
  InspectorToggle,
  Meta,
  Meter,
  Note,
  Props,
  Seg,
  Sep,
  Spacer,
  Status,
  SwitchRow,
  TextInput,
  Toolbar,
  ToolTabs,
  Workspace,
  type ActivityItem,
} from "@/ui";
import {
  DEFAULT_MAPPING,
  PROTOCOL_LABEL,
  SOURCE_LABEL,
  isLive,
  loadTrackPreview,
  pathLength,
  settingsProblem,
  startTracksim,
  stopTracksim,
  targetLabel,
  useTracksim,
  useTracksimSettings,
  type Pose,
  type TrackPreview,
  type TracksimSettings,
} from "../model/tracksim";
import css from "./tools.module.css";

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const num = (v: number, d: number) => (v < 0 ? `−${Math.abs(v).toFixed(d)}` : v.toFixed(d));
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;

export function TracksimPage() {
  const [tab, setTab] = useState<"live" | "log">("live");
  const [inspOpen, setInsp] = useInspector("tracksim");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const settings = useTracksimSettings();
  const run = useTracksim();
  const live = isLive(run.phase);
  const shown = run.run ?? settings;
  const previewPath = shown.source === "track" ? shown.file.trim() : "";
  const previewQ = useQuery({ queryKey: ["tools", "tracksim", "preview", previewPath], queryFn: () => loadTrackPreview(previewPath), enabled: !!previewPath, retry: false });
  const preview = previewPath ? (previewQ.data ?? null) : null;

  const start = async () => {
    const problem = settingsProblem(settings);
    if (problem) {
      setInsp(true);
      return toast(problem);
    }
    try {
      await startTracksim({ ...settings });
    } catch (e) {
      toast(`没能开始：${errText(e)}`);
    }
  };

  const status = run.phase === "starting" ? { kind: "running" as const, label: "正在启动" } : run.phase === "running" ? { kind: "running" as const, label: "进行中" } : run.phase === "failed" ? { kind: "failed" as const, label: "失败" } : run.phase === "done" ? { kind: "queued" as const, label: "已停止" } : { kind: "queued" as const, label: "未开始" };
  const rate = run.rate ?? (Number(shown.rate) > 0 ? Number(shown.rate) : preview?.rate || null);
  const meta = `${PROTOCOL_LABEL[shown.protocol]} → ${targetLabel(shown)} · ${shown.transport === "serial" ? "串口" : "UDP"}${rate ? ` · ${Math.round(rate)} Hz` : ""}`;

  return (
    <Workspace
      inspector={<TracksimInspector width={inspW} onClose={() => setInsp(false)} live={live} />}
      inspectorOpen={inspOpen}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      <Toolbar loc label="位置与对象操作">
        <Crumbs icon="tracksim" current="追踪模拟" />
        <Spacer />
        {live ? (
          <Button icon="stop" onClick={() => void stopTracksim()}>
            停止
          </Button>
        ) : (
          <Button variant="primary" icon="play" onClick={() => void start()}>
            开始发送
          </Button>
        )}
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>
      <Toolbar label="视图：筛选、搜索与显示">
        <ToolTabs
          label="追踪模拟内容"
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "live", label: "实时" },
            { key: "log", label: "日志" },
          ]}
        />
        <span className={css.ml8}>
          <Status pill kind={status.kind} label={status.label} />
        </span>
        <Meta className={css.ml8}>{meta}</Meta>
        <Spacer />
        <Meta>与 Stage 无关 · 只在本机运行</Meta>
      </Toolbar>

      {run.phase === "failed" && run.error && (
        <div className={css.banner}>
          <Status kind="failed" label="失败" srOnly />
          <span>{run.error}</span>
        </div>
      )}

      {tab === "live" ? (
        <>
          <TrackViewer preview={preview} previewError={previewQ.error ? errText(previewQ.error) : null} trail={run.trail} pose={run.pose} />
          <LiveValues preview={preview} rate={rate} />
        </>
      ) : (
        <LogView />
      )}
    </Workspace>
  );
}

/* ------------------------------ 轨迹画面 ------------------------------ */

type ViewKind = "top" | "side" | "persp";
const C30 = Math.cos(Math.PI / 6) * 0.5;
const S30 = Math.sin(Math.PI / 6) * 0.5;
const project = (v: ViewKind, [x, y, z]: [number, number, number]): [number, number] => (v === "top" ? [x, -y] : v === "side" ? [x, -z] : [x + y * C30, -(z + y * S30)]);

function TrackViewer({ preview, previewError, trail, pose }: { preview: TrackPreview | null; previewError: string | null; trail: [number, number, number][]; pose: Pose | null }) {
  const [view, setView] = useState<ViewKind>("top");
  /* 画布按视口的实际像素大小画（1 单位 = 1 px），文字和网格不随窗口缩放。 */
  const wrapRef = useRef<HTMLDivElement>(null);
  const [[W, H], setSize] = useState<[number, number]>([840, 440]);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (width > 0 && height > 0) setSize([Math.round(width), Math.round(height)]);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [follow, setFollow] = useState(false);
  const cam: [number, number, number] | null = pose ? [pose.x, pose.y, pose.z] : null;

  /* 视窗：整条轨迹 + 已播 + 摄影机的包围盒；跟随时以摄影机为中心、±4 m。 */
  const box = (() => {
    const pts = [...(preview?.points ?? []), ...trail, ...(cam ? [cam] : [])].map((p) => project(view, p));
    if (follow && cam) {
      const [cu, cv] = project(view, cam);
      return { u0: cu - 4 * (W / H), u1: cu + 4 * (W / H), v0: cv - 4, v1: cv + 4 };
    }
    if (!pts.length) return { u0: -5, u1: 5, v0: -3, v1: 3 };
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const [u, v] of pts) {
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const pad = Math.max(0.5, Math.max(u1 - u0, v1 - v0) * 0.06);
    return { u0: u0 - pad, u1: u1 + pad, v0: v0 - pad, v1: v1 + pad };
  })();

  /* 四周留出视野楔形的位置（M px），画面按 meet 放进视口，网格画到视口外补满两侧。 */
  const M = 70;
  const s = Math.min((W - 2 * M) / (box.u1 - box.u0), (H - 2 * M) / (box.v1 - box.v0));
  const ou = (W - (box.u1 - box.u0) * s) / 2 - box.u0 * s;
  const ov = (H - (box.v1 - box.v0) * s) / 2 - box.v0 * s;
  const px = (p: [number, number, number]) => {
    const [u, v] = project(view, p);
    return [u * s + ou, v * s + ov] as [number, number];
  };
  const pathD = (pts: [number, number, number][]) => pts.map((p, i) => `${i ? "L" : "M"}${px(p)[0].toFixed(1)} ${px(p)[1].toFixed(1)}`).join("");

  /* 地面网格（z=0），太密时放大步长。 */
  const span = Math.max(box.u1 - box.u0, box.v1 - box.v0);
  const step = span > 120 ? 10 : span > 40 ? 5 : 1;
  const grid = (() => {
    if (view === "side") {
      const out: string[] = [];
      const ext = span * 1.5;
      for (let x = Math.floor((box.u0 - ext) / step) * step; x <= box.u1 + ext; x += step) out.push(`M${(x * s + ou).toFixed(1)} ${-H}V${2 * H}`);
      for (let z = Math.floor((-box.v1 - ext) / step) * step; z <= -box.v0 + ext; z += step) out.push(`M${-W} ${(-z * s + ov).toFixed(1)}H${2 * W}`);
      return out.join("");
    }
    const ext = span * 1.5;
    const cx = (box.u0 + box.u1) / 2;
    const cy = view === "top" ? -(box.v0 + box.v1) / 2 : 0;
    const out: string[] = [];
    for (let x = Math.floor((cx - ext) / step) * step; x <= cx + ext; x += step) {
      const a = px([x, cy - ext, 0]);
      const b = px([x, cy + ext, 0]);
      out.push(`M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`);
    }
    for (let y = Math.floor((cy - ext) / step) * step; y <= cy + ext; y += step) {
      const a = px([cx - ext, y, 0]);
      const b = px([cx + ext, y, 0]);
      out.push(`M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`);
    }
    return out.join("");
  })();

  /* 摄影机视野楔形：水平角 0 = +Y，按 36 mm 画幅算视角。 */
  const wedge = (() => {
    if (!pose || !cam) return null;
    const [cx, cy] = px(cam);
    const half = Math.atan(18 / Math.max(1, pose.focal_length || 35));
    const L = 90;
    let a: number;
    if (view === "side") a = (-pose.tilt * Math.PI) / 180;
    else {
      const pan = (pose.pan * Math.PI) / 180;
      const d: [number, number, number] = [cam[0] + Math.sin(pan), cam[1] + Math.cos(pan), cam[2]];
      const [dx, dy] = px(d);
      a = Math.atan2(dy - cy, dx - cx);
    }
    const p1 = [cx + L * Math.cos(a - half), cy + L * Math.sin(a - half)];
    const p2 = [cx + L * Math.cos(a + half), cy + L * Math.sin(a + half)];
    return { d: `M${cx.toFixed(1)} ${cy.toFixed(1)}L${p1[0].toFixed(1)} ${p1[1].toFixed(1)}L${p2[0].toFixed(1)} ${p2[1].toFixed(1)}Z`, cx, cy };
  })();

  const pts = preview?.points ?? [];
  const first = pts[0];
  const last = pts[pts.length - 1];
  const len = pathLength(pts.length ? pts : trail);
  const axis = view === "side" ? ["X", "Z"] : ["X", "Y"];

  return (
    <div ref={wrapRef} className={`volo-viewport ${css.trackView}`}>
      <svg className="volo-viewport__canvas" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`${view === "top" ? "俯视" : view === "side" ? "侧视" : "透视"}的摄影机轨迹`}>
        <path className="volo-scene-grid" d={grid} />
        {pts.length > 1 && <path className="volo-scene-shape is-ghost" d={pathD(pts)} />}
        {trail.length > 1 && <path className="volo-scene-axis" d={pathD(trail)} />}
        {first && <circle className="volo-scene-shape" cx={px(first)[0]} cy={px(first)[1]} r="4" />}
        {last && pts.length > 1 && <circle className="volo-scene-shape" cx={px(last)[0]} cy={px(last)[1]} r="4" />}
        {first && (
          <text className="volo-scene-text" x={px(first)[0] - 16} y={px(first)[1] + 24}>
            起点
          </text>
        )}
        {last && pts.length > 1 && (
          <text className="volo-scene-text" x={px(last)[0] + 12} y={px(last)[1] - 4}>
            终点
          </text>
        )}
        {wedge && (
          <>
            <path className="volo-scene-shape is-selected" d={wedge.d} />
            <circle className="volo-scene-shape is-selected" cx={wedge.cx} cy={wedge.cy} r="6" />
            <text className="volo-scene-text" x={wedge.cx - 34} y={wedge.cy + 26}>
              摄影机
            </text>
          </>
        )}
        <path className="volo-scene-axis" d={`M60 ${H - 56}h44M60 ${H - 56}v-44`} />
        <text className="volo-scene-text" x="110" y={H - 52}>
          {axis[0]}
        </text>
        <text className="volo-scene-text" x="56" y={H - 108}>
          {axis[1]}
        </text>
      </svg>
      {!pts.length && !trail.length && (
        <div className={css.keyEmpty}>
          <span className={css.trackHint}>{previewError ? `没能预览轨迹：${previewError}` : "选好轨迹文件后这里显示整条轨迹；FBX 和手柄开始发送后画出走过的路径。"}</span>
        </div>
      )}
      <div className="volo-viewport__hud" data-at="tl" role="toolbar" aria-label="视角">
        <Seg
          label="视角"
          options={[
            { value: "top", label: "俯视" },
            { value: "side", label: "侧视" },
            { value: "persp", label: "透视" },
          ]}
          value={view}
          onChange={setView}
        />
      </div>
      <div className="volo-viewport__hud volo-viewport__hud--col" data-at="tr" role="toolbar" aria-label="视角与显示">
        <IconButton
          icon="fit"
          label="框住整条轨迹"
          onClick={() => setFollow(false)}
        />
        <IconButton icon="camera" label="跟随摄影机" pressed={follow} disabled={!pose} onClick={() => setFollow((f) => !f)} />
      </div>
      <div className="volo-viewport__readout" data-at="bl">
        <span>{`网格 ${step} m`}</span>
        <span>{len > 0 ? `轨迹长 ${len.toFixed(1)} m` : "轨迹长 —"}</span>
      </div>
      <div className="volo-viewport__legend" data-at="br">
        <span className="volo-viewport__key">
          <i className={css.keySelected} />
          摄影机与视野
        </span>
        <span className="volo-viewport__key">
          <i className={css.keyDashed} />
          还没播到的轨迹
        </span>
      </div>
    </div>
  );
}

/* ------------------------------ 数值 ------------------------------ */

function LiveValues({ preview, rate }: { preview: TrackPreview | null; rate: number | null }) {
  const run = useTracksim();
  const p = run.pose;
  const loop = run.run?.loop ?? false;
  const total = preview && rate ? Math.max(1, Math.ceil(preview.duration * rate)) : null;
  const frame = p?.frame ?? 0;
  const inLoop = total ? ((frame - 1) % total) + 1 : frame;
  const t = p?.timestamp ?? 0;
  const tIn = preview && preview.duration > 0 && loop ? t % preview.duration : t;
  const vals: [string, string, string][] = [
    ["X", p ? num(p.x, 3) : "—", "m"],
    ["Y", p ? num(p.y, 3) : "—", "m"],
    ["Z", p ? num(p.z, 3) : "—", "m"],
    ["水平", p ? num(p.pan, 2) : "—", "°"],
    ["俯仰", p ? num(p.tilt, 2) : "—", "°"],
    ["横滚", p ? num(p.roll, 2) : "—", "°"],
    ["焦距", p ? p.focal_length.toFixed(1) : "—", "mm"],
    ["对焦", p ? p.focus_distance.toFixed(2) : "—", "m"],
  ];
  return (
    <section aria-label="正在发送的数值" className={css.values}>
      <Meter
        role="progressbar"
        tone={isLive(run.phase) ? "running" : run.phase === "failed" ? "failed" : "default"}
        label={total ? `第 ${frame ? inLoop : 0} / ${total} 帧` : `第 ${frame} 帧`}
        value={total ? inLoop : frame ? 1 : 0}
        max={total ?? 1}
        extra={<span className="ry-mono">{preview && preview.duration > 0 ? `${mmss(tIn)} / ${mmss(preview.duration)}` : mmss(t)}</span>}
        text={`已发 ${run.packets} 包 · 丢 ${run.warnings}`}
      />
      <div className={css.valueGrid}>
        {vals.map(([k, v, u]) => (
          <div key={k} className={css.valueCell}>
            <div className={css.valueLabel}>{k}</div>
            <div className={css.valueNum}>
              {v}
              <span className={css.valueUnit}>{u}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function LogView() {
  const lines = useTracksim((s) => s.lines);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  if (!lines.length) {
    return (
      <Empty icon="terminal" title="还没有日志">
        开始发送后，tracksim 的启动、警告和结束信息会显示在这里（每帧的位姿不记）。
      </Empty>
    );
  }
  return (
    <pre ref={ref} className={css.logView}>
      {lines.join("\n")}
    </pre>
  );
}

/* ------------------------------ Inspector ------------------------------ */

function TracksimInspector({ width, onClose, live }: { width: number; onClose: () => void; live: boolean }) {
  const [tab, setTab] = useState<"settings" | "mapping" | "activity">("settings");
  const s = useTracksimSettings();
  const log = useTracksim((st) => st.log);
  const tabs = (
    <ToolTabs
      label="Inspector 内容"
      value={tab}
      onChange={setTab}
      tabs={[
        { key: "settings", label: "设置" },
        { key: "mapping", label: "手柄映射" },
        { key: "activity", label: "活动" },
      ]}
    />
  );

  if (tab === "activity") {
    const items: ActivityItem[] = log.map((e) => ({
      key: e.key,
      icon: e.kind === "failed" ? "failed" : e.kind === "success" ? "success" : e.kind === "running" ? "play" : "clock",
      iconColor: e.kind === "failed" ? "var(--status-failed)" : e.kind === "success" ? "var(--status-success)" : undefined,
      text: <span className={css.wrapAny}>{e.text}</span>,
      time: new Date(e.at).toTimeString().slice(0, 5),
    }));
    return (
      <Inspector width={width}>
        <InspectorHead tabs={tabs} onClose={onClose} title="活动" />
        <InspectorBody>
          {items.length ? (
            <Activity style={{ gap: 10 }} items={items} />
          ) : (
            <Empty icon="clock" title="这次打开后还没有操作">
              开始、停止和发送失败都会记在这里。
            </Empty>
          )}
        </InspectorBody>
      </Inspector>
    );
  }
  if (tab === "mapping") {
    return (
      <Inspector width={width}>
        <InspectorHead tabs={tabs} onClose={onClose} meta={<span>手柄映射</span>} title="内置默认映射" />
        <InspectorBody>
          <p className={css.lead}>来源选“手柄”时，按下面的映射把手柄输入换成摄影机运动。速度类输入松手即停。</p>
          <Props items={DEFAULT_MAPPING.map((m) => ({ label: m.channel, value: <span>{`${m.input} · ${m.note}`}</span> }))} />
        </InspectorBody>
      </Inspector>
    );
  }

  const set = (p: Partial<TracksimSettings>) => s.set(p);
  const browse = async () => {
    const f = s.source === "fbx" ? await pickFile("FBX", ["fbx"]).catch(() => null) : await pickFile("轨迹文件", ["json", "csv"]).catch(() => null);
    if (f) set({ file: f });
  };
  const problem = settingsProblem(s);
  return (
    <Inspector width={width}>
      <InspectorHead
        tabs={tabs}
        onClose={onClose}
        meta={
          <>
            <span>模拟设置</span>
            {live && <span>发送中不能修改，先停止</span>}
          </>
        }
        title={s.source === "controller" ? "手柄" : s.file ? baseName(s.file) : "还没选轨迹"}
      />
      <InspectorBody>
        {!live && problem && (
          <>
            <Note kind="attention">
              <p>{`还不能开始：${problem}。`}</p>
            </Note>
            <div className={css.gap20} />
          </>
        )}
        <Fields>
          <FieldsTitle>轨迹</FieldsTitle>
          <Field label="来源" inline>
            <Seg
              label="来源"
              block
              disabled={live}
              options={(["track", "fbx", "controller"] as const).map((v) => ({ value: v, label: SOURCE_LABEL[v] }))}
              value={s.source}
              onChange={(v) => set({ source: v, file: v === s.source ? s.file : "" })}
            />
          </Field>
          {s.source !== "controller" && (
            <Field label="文件" inline htmlFor="ts-file">
              <div className={css.pathRow}>
                <TextInput id="ts-file" mono disabled={live} value={s.file} onChange={(v) => set({ file: v })} placeholder={s.source === "fbx" ? "镜头动画 .fbx" : ".track.json / .csv"} />
                <IconButton icon="folder" label="选择文件" disabled={live} onClick={() => void browse()} />
              </div>
            </Field>
          )}
          {s.source === "fbx" && (
            <Field label="相机" inline htmlFor="ts-cam" hint="FBX 里有多台相机时填名字；FBX 要先经 Blender 转换，第一次会慢。">
              <TextInput id="ts-cam" disabled={live} value={s.camera} onChange={(v) => set({ camera: v })} placeholder="只有一台时留空" />
            </Field>
          )}
          <Field label="频率" inline htmlFor="ts-rate" hint={s.source === "controller" ? "留空时 60 Hz。" : "留空时跟随轨迹自带的帧率。"}>
            <TextInput id="ts-rate" num disabled={live} value={s.rate} onChange={(v) => set({ rate: v })} unit="Hz" invalid={!!s.rate.trim() && !(Number(s.rate) > 0)} />
          </Field>
        </Fields>
        <div className={css.gap12} />
        <Fields>
          <FieldsTitle>发送</FieldsTitle>
          <Field label="协议" inline>
            <Seg
              label="协议"
              block
              disabled={live}
              options={[
                { value: "freed", label: "FreeD" },
                { value: "opentrackio", label: "OpenTrackIO" },
              ]}
              value={s.protocol}
              onChange={(v) => set({ protocol: v, transport: v === "opentrackio" ? "udp" : s.transport, port: s.port === "6301" && v === "opentrackio" ? "55555" : s.port === "55555" && v === "freed" ? "6301" : s.port })}
            />
          </Field>
          <Field label="传输" inline>
            <Seg
              label="传输"
              block
              disabled={live}
              options={[
                { value: "udp", label: "UDP" },
                { value: "serial", label: "串口", disabled: s.protocol !== "freed" },
              ]}
              value={s.transport}
              onChange={(v) => set({ transport: v })}
            />
          </Field>
          {s.transport === "serial" ? (
            <Field label="串口设备" inline htmlFor="ts-serial">
              <TextInput id="ts-serial" mono disabled={live} value={s.serial} onChange={(v) => set({ serial: v })} placeholder="COM3 或 /dev/tty.usbserial" />
            </Field>
          ) : (
            <>
              <Field label="目标地址" inline htmlFor="ts-ip" hint="接收端（UE / Disguise）所在机器的地址。">
                <TextInput id="ts-ip" mono disabled={live} value={s.ip} onChange={(v) => set({ ip: v })} />
              </Field>
              <Field label="端口" inline htmlFor="ts-port">
                <TextInput id="ts-port" mono num disabled={live} value={s.port} onChange={(v) => set({ port: v })} />
              </Field>
            </>
          )}
        </Fields>
        <div className={css.gap12} />
        <Fields>
          <SwitchRow title="循环播放" checked={s.loop && s.source !== "controller"} disabled={live || s.source === "controller"} onChange={(v) => set({ loop: v })} />
          <SwitchRow title="结束时保持最后一帧" desc="tracksim 还不支持：播完就停止发包，接收端会显示信号丢失。" checked={false} disabled onChange={() => {}} />
        </Fields>
      </InspectorBody>
    </Inspector>
  );
}
