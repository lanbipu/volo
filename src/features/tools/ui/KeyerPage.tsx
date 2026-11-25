/* 工具 · 键控实验（设计：Keyer.dc.html）。
   绿幕色键器的验证台：本机 WebGPU 跑 ../keyer 引擎，与 Stage 无关。
   实验台：打开视频 / 图片，调参数，看结果 / 遮罩 / 原始 / 对比；基准测试：按测试集出误差表。 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
  Note,
  Props,
  Seg,
  Sep,
  Spacer,
  SwitchRow,
  TextInput,
  Toolbar,
  ToolTabs,
  Workspace,
  type ActivityItem,
} from "@/ui";
import { KeyerEngine } from "../keyer/engine";
import { probeWebGpu, type GpuProbeResult } from "../keyer/gpu";
import { DEFAULTS, type KeyerParams } from "../keyer/params";
import {
  applyPreset,
  attachEngine,
  autoKey,
  clock,
  exportPng,
  getEngine,
  keyColorBytes,
  keyColorCss,
  logKeyer,
  resetDefaults,
  sampleAt,
  setParam,
  setPlate,
  setView,
  useKeyer,
  useKeyerPresets,
  type KeyerView,
  type PlateState,
} from "../model/keyer";
import { BenchView } from "./KeyerBench";
import css from "./tools.module.css";

const TEST_TOOLS = import.meta.env.DEV || import.meta.env.VITE_KEYER_TEST_TOOLS === "1";
const bitmap = (src: Blob) => createImageBitmap(src, { colorSpaceConversion: "none" });

export function KeyerPage() {
  const [tab, setTab] = useState<"lab" | "bench">("lab");
  const [inspOpen, setInsp] = useInspector("keyer");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const source = useKeyer((s) => s.source);
  const [ready, setReady] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const plateRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [busy, setBusy] = useState(false);

  const openMedia = () => fileRef.current?.click();
  const doExport = async () => {
    setBusy(true);
    try {
      const p = await exportPng();
      if (p) toast("已导出");
    } catch (e) {
      toast(`导出失败：${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const crumbs = source ? <Crumbs icon="keyer" trail={[{ label: "键控实验" }]} current={source.name} /> : <Crumbs icon="keyer" current="键控实验" />;
  const tabs = (
    <Toolbar label="视图：筛选、搜索与显示">
      <ToolTabs
        label="键控实验内容"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "lab", label: "实验台" },
          { key: "bench", label: "基准测试" },
        ]}
      />
      <Spacer />
      <Meta>与 Stage 无关 · 只在本机运行</Meta>
    </Toolbar>
  );

  if (tab === "bench") {
    return (
      <main className="ry-main">
        <Toolbar loc label="位置与对象操作">
          <Crumbs icon="keyer" trail={[{ label: "键控实验" }]} current="基准测试" />
        </Toolbar>
        {tabs}
        <BenchView />
      </main>
    );
  }

  return (
    <Workspace
      inspector={<KeyerInspector width={inspW} onClose={() => setInsp(false)} ready={ready} onLoadPlate={() => plateRef.current?.click()} />}
      inspectorOpen={inspOpen}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      <Toolbar loc label="位置与对象操作">
        {crumbs}
        <Spacer />
        {TEST_TOOLS && (
          <Button variant="ghost" disabled={!ready} onClick={() => void loadDevVideo(videoRef.current)}>
            加载测试视频
          </Button>
        )}
        <Button icon="folder" disabled={!ready} onClick={openMedia}>
          打开素材
        </Button>
        <Button variant="primary" icon="export" busy={busy} disabled={!ready || !source} onClick={() => void doExport()}>
          导出
        </Button>
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>
      {tabs}
      <input
        ref={fileRef}
        type="file"
        hidden
        accept="image/png,image/jpeg,video/mp4,video/quicktime"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void loadMedia(f, videoRef.current);
        }}
      />
      <input
        ref={plateRef}
        type="file"
        hidden
        accept="image/png,image/jpeg"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          const bmp = await bitmap(f);
          setPlate(1, bmp);
          bmp.close();
        }}
      />
      <video ref={videoRef} hidden muted loop playsInline />
      <KeyerViewer videoRef={videoRef} onReady={setReady} onOpen={openMedia} />
    </Workspace>
  );
}

/* ------------------------------ 素材 ------------------------------ */

let vfc = 0;
function stopPump(v: HTMLVideoElement | null) {
  if (v && vfc) v.cancelVideoFrameCallback(vfc);
  vfc = 0;
}
function pump(v: HTMLVideoElement) {
  stopPump(v);
  let n = 0;
  const cb = () => {
    const e = getEngine();
    if (!e) return;
    e.loadImage(v);
    e.renderOnce();
    if (++n % 10 === 0) useKeyer.setState({ stats: e.stats(), time: v.currentTime });
    vfc = v.requestVideoFrameCallback(cb);
  };
  vfc = v.requestVideoFrameCallback(cb);
}

async function loadMedia(file: File, v: HTMLVideoElement | null) {
  const e = getEngine();
  if (!e || !v) return;
  v.pause();
  stopPump(v);
  if (v.src) URL.revokeObjectURL(v.src);
  v.removeAttribute("src");
  try {
    if (/^video\//.test(file.type) || /\.(mp4|mov)$/i.test(file.name)) {
      v.src = URL.createObjectURL(file);
      await new Promise<void>((res, rej) => {
        v.onloadedmetadata = () => res();
        v.onerror = () => rej(new Error("视频解码失败"));
      });
      useKeyer.setState({ source: { name: file.name, kind: "video", w: v.videoWidth, h: v.videoHeight, duration: v.duration }, time: 0, stats: null });
      e.resetHistory();
      await v.play();
      useKeyer.setState({ playing: true });
      pump(v);
    } else {
      const bmp = await bitmap(file);
      useKeyer.setState({ source: { name: file.name, kind: "image", w: bmp.width, h: bmp.height, duration: 0 }, playing: false, time: 0 });
      e.loadImage(bmp);
      e.resetHistory();
      e.renderOnce();
      useKeyer.setState({ stats: e.stats() });
      bmp.close();
    }
    logKeyer("success", `打开 ${file.name}`);
  } catch (err) {
    useKeyer.setState({ source: null, playing: false });
    logKeyer("failed", `打开 ${file.name} 失败：${errText(err)}`);
    toast(`打开失败：${errText(err)}`);
  }
}

async function loadDevVideo(v: HTMLVideoElement | null) {
  try {
    const res = await fetch(import.meta.env.DEV ? `/@fs${__KEYER_VIDEO_FS__}` : "/greenscreen_1080p60_h264.mp4");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadMedia(new File([await res.blob()], "greenscreen_1080p60_h264.mp4", { type: "video/mp4" }), v);
  } catch (e) {
    toast(`测试视频加载失败：${errText(e)}`);
  }
}

function togglePlay(v: HTMLVideoElement | null) {
  if (!v || useKeyer.getState().source?.kind !== "video") return;
  if (v.paused) {
    void v.play();
    useKeyer.setState({ playing: true });
    pump(v);
  } else {
    v.pause();
    stopPump(v);
    useKeyer.setState({ playing: false, time: v.currentTime });
  }
}

/* ------------------------------ 画面 ------------------------------ */

const VIEWS: { value: string; label: string }[] = [
  { value: "0", label: "结果" },
  { value: "1", label: "遮罩" },
  { value: "2", label: "原始" },
  { value: "3", label: "对比" },
];

function KeyerViewer({ videoRef, onReady, onOpen }: { videoRef: React.RefObject<HTMLVideoElement | null>; onReady: (ok: boolean) => void; onOpen: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [probe, setProbe] = useState<GpuProbeResult | null>(null);
  const [area, setArea] = useState<[number, number]>([0, 0]);
  const [cover, setCover] = useState(false);
  const k = useKeyer();
  const view = k.params.viewMode as KeyerView;

  useEffect(() => {
    let dead = false;
    const canvas = canvasRef.current!;
    probeWebGpu(canvas)
      .then((r) => {
        if (dead) return;
        setProbe(r);
        if (r.ok) {
          attachEngine(new KeyerEngine(r));
          onReady(true);
        }
      })
      .catch((e) => !dead && setProbe({ ok: false, reason: errText(e) }));
    const v = videoRef.current;
    return () => {
      dead = true;
      stopPump(v);
      v?.pause();
      attachEngine(null);
      onReady(false);
      useKeyer.setState({ playing: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时探测一次 WebGPU
  }, []);

  /* 画布内部尺寸跟素材走，显示尺寸按容器等比放进去。 */
  useEffect(() => {
    const c = canvasRef.current;
    if (c && k.source && (c.width !== k.source.w || c.height !== k.source.h)) {
      c.width = k.source.w;
      c.height = k.source.h;
      getEngine()?.renderOnce();
    }
  }, [k.source]);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setArea([e.contentRect.width, e.contentRect.height]));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fit = useMemo(() => {
    const [aw, ah] = area;
    const sw = k.source?.w ?? 16;
    const sh = k.source?.h ?? 9;
    const s = cover ? Math.max(aw / sw, ah / sh) : Math.min(aw / sw, ah / sh);
    return { width: Math.max(1, Math.round(sw * s)), height: Math.max(1, Math.round(sh * s)) };
  }, [area, k.source, cover]);

  const onCanvas = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!k.sampling) return;
    const r = e.currentTarget.getBoundingClientRect();
    void sampleAt(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
  };
  const dragWipe = (e: ReactPointerEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      setView({ wipe: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) });
    };
    const t = e.currentTarget;
    const up = () => {
      t.removeEventListener("pointermove", move);
      t.removeEventListener("pointerup", up);
    };
    t.addEventListener("pointermove", move);
    t.addEventListener("pointerup", up);
  };

  const failed = probe && !probe.ok ? probe.reason : null;
  return (
    <div className={`volo-viewport ${css.keyView}`}>
      <div ref={boxRef} className={css.keyArea}>
        <div className={css.keyFrame} style={{ width: fit.width, height: fit.height }} hidden={!k.source}>
          <canvas ref={canvasRef} width={1280} height={720} className={`${css.keyCanvas} ${k.sampling ? css.keyCanvasPick : ""}`} onClick={onCanvas} />
          {view === 3 && k.source && <div className={css.wipe} style={{ left: `${k.params.wipe * 100}%` }} onPointerDown={dragWipe} role="separator" aria-label="对比分割线" />}
        </div>
        {!k.source && (
          <div className={css.keyEmpty}>
            {failed ? (
              <Note kind="failed">
                <p>{`这台电脑的 WebGPU 不可用：${failed}`}</p>
              </Note>
            ) : (
              <Empty
                icon="keyer"
                title="打开一段绿幕素材"
                actions={
                  <Button variant="primary" icon="folder" disabled={!probe?.ok} onClick={onOpen}>
                    打开素材
                  </Button>
                }
              >
                视频（mp4 / mov）或图片（png / jpg）。素材只在本机读，不上传。
              </Empty>
            )}
          </div>
        )}
      </div>
      <div className="volo-viewport__hud" data-at="tl" role="toolbar" aria-label="视图">
        <Seg label="视图" options={VIEWS} value={String(view)} onChange={(v) => setView({ viewMode: Number(v) })} />
      </div>
      <div className="volo-viewport__hud volo-viewport__hud--col" data-at="tr" role="toolbar" aria-label="视角">
        <IconButton icon="fit" label={cover ? "适应窗口" : "铺满窗口"} pressed={cover} onClick={() => setCover((c) => !c)} />
        <IconButton icon="focus" label="在画面上取样幕布色" pressed={k.sampling} disabled={!k.source} onClick={() => useKeyer.setState({ sampling: !k.sampling })} />
      </div>
      {k.source && (
        <div className="volo-viewport__readout" data-at="bl">
          <span>{`${k.source.w} × ${k.source.h}`}</span>
          <span>{k.source.kind === "video" && k.stats ? `${k.stats.fps.toFixed(0)} fps` : "单帧"}</span>
          <span>{k.stats && k.stats.frameMs > 0 ? `${k.stats.frameMs.toFixed(1)} ms / 帧` : "— ms / 帧"}</span>
        </div>
      )}
      {k.source?.kind === "video" && (
        <div className="volo-viewport__hud" data-at="bc" role="toolbar" aria-label="播放">
          <IconButton icon={k.playing ? "stop" : "play"} label={k.playing ? "暂停" : "播放"} onClick={() => togglePlay(videoRef.current)} />
          <span className={`ry-num ${css.keyTime}`}>{`${clock(k.time)} / ${clock(k.source.duration)}`}</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Inspector ------------------------------ */

function NumField({ id, label, k, min, max, step, unit }: { id: string; label: string; k: keyof KeyerParams; min: number; max: number; step: number; unit?: string }) {
  const value = useKeyer((s) => s.params[k] as number);
  const fmt = (v: number) => v.toFixed(step < 0.01 ? 3 : step < 0.1 ? 2 : 1);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    const n = Number(draft);
    if (Number.isFinite(n)) setParam(k, Math.min(max, Math.max(min, n)));
    setDraft(null);
  };
  const bad = draft != null && !Number.isFinite(Number(draft));
  return (
    <Field label={label} inline htmlFor={id}>
      <TextInput
        id={id}
        num
        value={draft ?? fmt(value)}
        unit={unit}
        invalid={bad}
        title={`${fmt(min)} – ${fmt(max)}`}
        onChange={setDraft}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(null);
        }}
      />
    </Field>
  );
}

function KeyerInspector({ width, onClose, ready, onLoadPlate }: { width: number; onClose: () => void; ready: boolean; onLoadPlate: () => void }) {
  const [tab, setTab] = useState<"params" | "presets" | "activity">("params");
  const k = useKeyer();
  const tabs = (
    <ToolTabs
      label="Inspector 内容"
      value={tab}
      onChange={setTab}
      tabs={[
        { key: "params", label: "参数" },
        { key: "presets", label: "预设" },
        { key: "activity", label: "活动" },
      ]}
    />
  );
  if (tab === "presets") return <PresetsPane width={width} onClose={onClose} tabs={tabs} />;
  if (tab === "activity") {
    const items: ActivityItem[] = k.log.map((e) => ({
      key: e.key,
      icon: e.kind === "failed" ? "failed" : e.kind === "success" ? "success" : "clock",
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
              打开素材、取样、自动键控、导出都会记在这里。
            </Empty>
          )}
        </InspectorBody>
      </Inspector>
    );
  }

  const p = k.params;
  const rgb = keyColorBytes(p.keyColor);
  const stab = p.matteStab > 0;
  return (
    <Inspector width={width}>
      <InspectorHead
        tabs={tabs}
        onClose={onClose}
        meta={
          <>
            <span>键控参数</span>
            {k.preset && <span>{`预设：${k.preset}`}</span>}
          </>
        }
        title={k.source?.name ?? "还没有素材"}
        actions={
          <>
            <Button icon="focus" disabled={!ready || !k.source} onClick={() => void autoKey()}>
              自动键控
            </Button>
            <Button variant="ghost" icon="refresh" onClick={resetDefaults}>
              重置默认
            </Button>
          </>
        }
      />
      <InspectorBody>
        <Fields>
          <FieldsTitle>取样</FieldsTitle>
          <Field label="幕布色" inline>
            <button
              type="button"
              className="volo-input volo-input--select"
              aria-pressed={k.sampling}
              aria-label={`幕布色：R ${rgb[0]} G ${rgb[1]} B ${rgb[2]}，点击后在画面上取样`}
              disabled={!k.source}
              onClick={() => useKeyer.setState({ sampling: !k.sampling })}
            >
              <i aria-hidden="true" className={css.swatch} style={{ background: keyColorCss(p.keyColor) }} />
              <span className="volo-input__value ry-mono">{k.sampling ? "在画面上点一下…" : rgb.join(" · ")}</span>
            </button>
          </Field>
          <Field label="干净背景" inline hint="没有人物的幕布画面。有它，阴影和不均匀的布光才抠得干净。">
            <Seg
              label="干净背景"
              block
              disabled={!ready}
              options={[
                { value: "0", label: "无" },
                { value: "1", label: "已加载" },
                { value: "2", label: "已估计", disabled: !k.source },
                { value: "3", label: "动态", disabled: k.source?.kind !== "video" },
              ]}
              value={String(k.plate)}
              onChange={(v) => (v === "1" ? onLoadPlate() : setPlate(Number(v) as PlateState))}
            />
          </Field>
        </Fields>
        <div className={css.gap12} />
        <Fields>
          <FieldsTitle>遮罩</FieldsTitle>
          <NumField id="k-balance" label="色差平衡" k="balance" min={0} max={1} step={0.01} />
          <NumField id="k-black" label="黑位" k="blackClip" min={0} max={0.5} step={0.005} />
          <NumField id="k-white" label="白位" k="whiteClip" min={0.5} max={1} step={0.005} />
          <NumField id="k-soft" label="柔和度" k="softness" min={0.4} max={3} step={0.02} />
          <NumField id="k-despill" label="溢色抑制" k="despillStrength" min={0} max={1} step={0.01} />
          <NumField id="k-despill-b" label="溢色平衡" k="despillBalance" min={0} max={1} step={0.01} />
          <NumField id="k-shrink" label="边缘收缩" k="shrink" min={-3} max={3} step={0.1} unit="px" />
          <NumField id="k-feather" label="羽化" k="feather" min={0} max={1.5} step={0.05} unit="px" />
          <NumField id="k-despot" label="去孤点" k="despot" min={0} max={1} step={0.01} />
        </Fields>
        <div className={css.gap12} />
        <Fields>
          <FieldsTitle>输出</FieldsTitle>
          <NumField id="k-denoise" label="降噪" k="denoise" min={0} max={1} step={0.01} />
          <SwitchRow title="时域稳定" desc="用前后帧压住遮罩边缘的闪烁。" checked={stab} onChange={(on) => setParam("matteStab", on ? DEFAULTS.matteStab || 0.5 : 0)} />
          <SwitchRow title="显示透明棋盘格" desc="引擎的结果视图固定带棋盘格。" checked disabled onChange={() => {}} />
        </Fields>
        <div className={css.gap20} />
        <Props
          items={[
            { label: "素材", value: k.source ? <span className="ry-mono">{k.source.name}</span> : null },
            { label: "长度", value: k.source ? <span className="ry-num">{k.source.kind === "video" ? `${Math.round(k.source.duration)} 秒` : "单帧图片"}</span> : null },
          ]}
        />
      </InspectorBody>
    </Inspector>
  );
}

function PresetsPane({ width, onClose, tabs }: { width: number; onClose: () => void; tabs: React.ReactNode }) {
  const presets = useKeyerPresets();
  const current = useKeyer((s) => s.preset);
  const params = useKeyer((s) => s.params);
  const [name, setName] = useState("");
  const names = Object.keys(presets.items).sort((a, b) => a.localeCompare(b, "zh"));
  const save = () => {
    const n = name.trim();
    if (!n) return;
    presets.save(n, params);
    useKeyer.setState({ preset: n });
    logKeyer("success", `存为预设「${n}」`);
    setName("");
  };
  return (
    <Inspector width={width}>
      <InspectorHead tabs={tabs} onClose={onClose} meta={<span>预设</span>} title={current ? `当前：${current}` : "当前参数没有存为预设"} />
      <InspectorBody>
        <Fields>
          <FieldsTitle>存为预设</FieldsTitle>
          <Field label="名称" htmlFor="k-preset">
            <div className={css.pathRow}>
              <TextInput id="k-preset" value={name} onChange={setName} placeholder="比如：演播室绿" onKeyDown={(e) => e.key === "Enter" && save()} />
              <Button disabled={!name.trim()} onClick={save}>
                保存
              </Button>
            </div>
          </Field>
        </Fields>
        <div className={css.gap20} />
        {names.length ? (
          <ul className={css.presetList} aria-label="已存的预设">
            {names.map((n) => (
              <li key={n} className={css.presetRow} aria-current={n === current || undefined}>
                <span className={css.presetName}>{n}</span>
                <Button variant="ghost" onClick={() => applyPreset(n)}>
                  载入
                </Button>
                <IconButton
                  icon="close"
                  size="sm"
                  label={`删除预设 ${n}`}
                  onClick={() => {
                    presets.remove(n);
                    if (n === current) useKeyer.setState({ preset: null });
                  }}
                />
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon="sliders" title="还没有预设">
            调好一组参数后在上面存一个名字，下次直接载入。预设只存在这台电脑上。
          </Empty>
        )}
      </InspectorBody>
    </Inspector>
  );
}
