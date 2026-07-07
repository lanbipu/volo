// @ts-nocheck
/* Volo — Tools · 键控 Keyer Lab（grill 共识五件套之验证台）。
   算法核心在 src/volo/keyer/（typed TS + WGSL），本文件只做 UI 编排。 */
import * as React from "react";
import "../ds";
import { probeWebGpu } from "../keyer/gpu";
import { KeyerEngine } from "../keyer/engine";
import { DEFAULTS, KNOBS } from "../keyer/params";
import { mad, gradErr } from "../keyer/metrics";

(function () {
  window.KEYER_SKIP = {}; // 全管线
  const { Button, InlineAlert, StatusLight, Tag } = window.Spectrum2DesignSystem_b6d1b3;
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;

  const NAV = [
    { id: "keyer_lab",   label: "抠像实验台", icon: "key" },
    { id: "keyer_bench", label: "基准测试",   icon: "target" },
  ];

  const VIEWS = [
    { mode: 0, label: "结果" },
    { mode: 1, label: "matte" },
    { mode: 2, label: "源" },
    { mode: 3, label: "对比" },
  ];

  const cloneParams = (p) => ({ ...p, keyColor: [p.keyColor[0], p.keyColor[1], p.keyColor[2]] });
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const linearToSrgbByte = (v) => {
    const x = clamp01(v);
    const y = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    return Math.round(clamp01(y) * 255);
  };
  const keyColorCss = (c) => "rgb(" + c.map(linearToSrgbByte).join(",") + ")";
  const knobValue = (v, step) => Number(v).toFixed(step < 0.01 ? 3 : step < 0.1 ? 2 : 1);

  const keyerStore = (() => {
    let params = cloneParams(DEFAULTS);
    let engine = null;
    const subs = new Set();
    const emit = () => subs.forEach((fn) => fn());
    const snapshot = () => ({ params: cloneParams(params), hasEngine: !!engine });
    const applyParams = (next, render = true) => {
      params = cloneParams(next);
      if (engine) {
        engine.setParams(params);
        if (render) engine.renderOnce();
      }
      emit();
    };
    return {
      snapshot,
      subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
      attachEngine(nextEngine) {
        engine = nextEngine;
        if (engine) engine.setParams(params);
        emit();
      },
      setParam(key, value) {
        applyParams({ ...params, [key]: value });
      },
      resetDefaults() {
        applyParams(cloneParams(DEFAULTS));
      },
      applyPreset(p) {
        applyParams(cloneParams({ ...DEFAULTS, ...p }));
      },
      syncFromEngine() {
        if (!engine) return;
        params = engine.getParams();
        emit();
      },
      async sampleAt(u, v) {
        if (!engine) return null;
        await engine.sampleKeyColor(u, v);
        params = engine.getParams();
        engine.renderOnce();
        emit();
        return cloneParams(params);
      },
    };
  })();

  function useKeyerSnapshot() {
    const [snap, setSnap] = useState(keyerStore.snapshot());
    useEffect(() => keyerStore.subscribe(() => setSnap(keyerStore.snapshot())), []);
    return snap;
  }

  function canvasUv(ev, canvas) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const u = clamp01((ev.clientX - rect.left) / rect.width);
    const v = clamp01((ev.clientY - rect.top) / rect.height);
    return {
      u,
      v,
      x: Math.round(u * Math.max(0, canvas.width - 1)),
      y: Math.round(v * Math.max(0, canvas.height - 1)),
    };
  }

  function KeyerCenter() {
    const canvasRef = useRef(null);
    const fileRef = useRef(null);
    const engineRef = useRef(null);
    const videoRef = useRef(null);   // 隐藏 <video>，视频素材源
    const vfcRef = useRef(0);        // requestVideoFrameCallback 句柄
    const [probe, setProbe] = useState(null);
    const [pixelText, setPixelText] = useState(null);
    const [hud, setHud] = useState(null);
    const [playing, setPlaying] = useState(false);
    const [hasVideo, setHasVideo] = useState(false);
    const keyer = useKeyerSnapshot();
    useEffect(() => {
      let dead = false;
      probeWebGpu(canvasRef.current).then((result) => {
        if (dead) return;
        setProbe(result);
        if (result.ok) {
          engineRef.current = new KeyerEngine(result);
          keyerStore.attachEngine(engineRef.current);
        }
      });
      return () => {
        dead = true; keyerStore.attachEngine(null); engineRef.current = null;
        const v = videoRef.current;
        if (v) { v.pause(); if (v.src) URL.revokeObjectURL(v.src); }
      };
    }, []);
    const pumpFrames = () => {
      const v = videoRef.current, e = engineRef.current;
      if (!v || !e) return;
      let n = 0;
      const cb = () => {
        if (!videoRef.current || !engineRef.current) return;
        engineRef.current.loadImage(videoRef.current);
        engineRef.current.renderOnce();
        if (++n % 10 === 0) {  // HUD 节流：React setState 每 10 帧一次
          const st = engineRef.current.stats();
          setHud(st.fps.toFixed(1) + " fps · " + st.frameMs.toFixed(2) + " ms");
        }
        vfcRef.current = videoRef.current.requestVideoFrameCallback(cb);
      };
      vfcRef.current = v.requestVideoFrameCallback(cb);
    };
    const openMedia = () => { if (fileRef.current) fileRef.current.click(); };
    const onFile = async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = "";
      if (!file || !engineRef.current) return;
      const v = videoRef.current;
      if (v) { v.pause(); if (v.cancelVideoFrameCallback && vfcRef.current) v.cancelVideoFrameCallback(vfcRef.current); }
      if (/^video\//.test(file.type) || /\.(mp4|mov)$/i.test(file.name)) {
        if (v.src) URL.revokeObjectURL(v.src);
        v.src = URL.createObjectURL(file);
        setHasVideo(true); setPixelText(null);
        try { await v.play(); setPlaying(true); pumpFrames(); }
        catch (err) { setPixelText("视频解码失败: " + (err && err.message)); setHasVideo(false); }
        return;
      }
      setHasVideo(false); setPlaying(false);
      const bmp = await createImageBitmap(file);
      engineRef.current.loadImage(bmp);
      engineRef.current.renderOnce();
      const [r, g, b] = await engineRef.current.readbackPixel(10, 10);
      const m = await engineRef.current.readbackMatte(10, 10);
      setPixelText("src(10,10)=" + r + "," + g + "," + b + " · matte=" + m.toFixed(3));
      if (bmp.close) bmp.close();
    };
    const togglePlay = () => {
      const v = videoRef.current;
      if (!v || !hasVideo) return;
      if (v.paused) { v.play(); setPlaying(true); pumpFrames(); }
      else { v.pause(); setPlaying(false); if (v.cancelVideoFrameCallback && vfcRef.current) v.cancelVideoFrameCallback(vfcRef.current); }
    };
    const setViewMode = (mode) => keyerStore.setParam("viewMode", mode);
    const plateFileRef = useRef(null);
    const [plateState, setPlateState] = useState(0); // 0 无 / 1 已加载 / 2 已估计
    const openPlate = () => { if (plateFileRef.current) plateFileRef.current.click(); };
    const onPlateFile = async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = "";
      if (!file || !engineRef.current) return;
      const bmp = await createImageBitmap(file);
      engineRef.current.loadPlate(bmp);
      keyerStore.syncFromEngine();
      setPlateState(1);
      if (bmp.close) bmp.close();
    };
    const estimatePlate = () => {
      if (!engineRef.current) return;
      engineRef.current.estimatePlate();
      keyerStore.syncFromEngine();
      setPlateState(2);
    };
    const clearPlate = () => {
      if (!engineRef.current) return;
      engineRef.current.clearPlate();
      keyerStore.syncFromEngine();
      setPlateState(0);
    };
    const doExport = async () => {
      const engine = engineRef.current;
      if (!engine) return;
      const blob = await engine.exportPng();
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "keyer-export-" + Date.now() + ".png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    const stageRef = useRef(null);
    const onWipeDrag = (ev) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const u = clamp01((ev.clientX - rect.left) / rect.width);
      keyerStore.setParam("wipe", u);
    };
    const onCanvasClick = async (ev) => {
      const canvas = canvasRef.current;
      const engine = engineRef.current;
      if (!canvas || !engine) return;
      const p = canvasUv(ev, canvas);
      if (!p) return;
      await keyerStore.sampleAt(p.u, p.v);
      const [r, g, b] = await engine.readbackPixel(p.x, p.y);
      const m = await engine.readbackMatte(p.x, p.y);
      setPixelText("sample(" + p.x + "," + p.y + ") src=" + r + "," + g + "," + b + " · matte=" + m.toFixed(3));
    };
    return h(React.Fragment, null,
      h("input", { ref: fileRef, type: "file", accept: "image/png,image/jpeg,video/mp4,video/quicktime", style: { display: "none" }, onChange: onFile }),
      h("input", { ref: plateFileRef, type: "file", accept: "image/png,image/jpeg", style: { display: "none" }, onChange: onPlateFile }),
      h("video", { ref: videoRef, muted: true, loop: true, playsInline: true, style: { display: "none" } }),
      h("div", { className: "canvas-head" },
        h("span", { className: "t" }, "抠像实验台"),
        h("div", { className: "kl-view-seg" },
          VIEWS.map((v) => h("button", {
            key: v.mode,
            type: "button",
            className: keyer.params.viewMode === v.mode ? "on" : "",
            onClick: () => setViewMode(v.mode),
          }, v.label))),
        h("div", { className: "right" },
          plateState > 0 ? h(Tag, null, plateState === 1 ? "plate · 已加载" : "plate · 已估计") : null,
          h(Button, { variant: "secondary", size: "S", isDisabled: !probe || !probe.ok,
            onPress: openPlate }, "加载 plate"),
          h(Button, { variant: "secondary", size: "S", isDisabled: !probe || !probe.ok,
            onPress: estimatePlate }, "估计 plate"),
          plateState > 0 ? h(Button, { variant: "secondary", size: "S", onPress: clearPlate }, "清除") : null,
          hasVideo ? h(Button, { variant: "secondary", size: "S",
            icon: h(Icon, { name: playing ? "pause" : "play", size: 14 }), onPress: togglePlay }, playing ? "暂停" : "播放") : null,
          h(Button, { variant: "secondary", size: "S", isDisabled: !probe || !probe.ok,
            icon: h(Icon, { name: "folder", size: 14 }), onPress: openMedia }, "打开素材"),
          h(Button, { variant: "secondary", size: "S", isDisabled: !probe || !probe.ok,
            icon: h(Icon, { name: "download", size: 14 }), onPress: doExport }, "导出"),
          probe && probe.ok
            ? h(StatusLight, { variant: "positive" }, "WebGPU · " + probe.adapterInfo.vendor)
            : probe ? h(StatusLight, { variant: "negative" }, "WebGPU 不可用") : null)),
      h("div", { className: "canvas-stage kl-stage", ref: stageRef },
        h("canvas", { ref: canvasRef, className: "kl-canvas", width: 1280, height: 720, onClick: onCanvasClick }),
        keyer.params.viewMode === 3 ? h("div", {
          className: "kl-wipe",
          style: { left: "calc(" + (keyer.params.wipe * 100) + "% )" },
          onPointerDown: (ev) => {
            ev.currentTarget.setPointerCapture(ev.pointerId);
            const move = (e) => onWipeDrag(e);
            const up = (e) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          },
        }) : null,
        hud ? h("div", { className: "kl-hud" }, hud) : null,
        probe && probe.ok ? h("div", { className: "kl-probe" },
          pixelText || (probe.adapterInfo.vendor + " · " + probe.adapterInfo.architecture + " · " + probe.format)) : null,
        probe && !probe.ok ? h("div", { className: "kl-fail" },
          h(InlineAlert, { variant: "negative", title: "WebGPU 探测失败" }, probe.reason)) : null));
  }

  function ctx(s) {
    const cur = NAV.find((n) => n.id === s.cacheNav) || NAV[0];
    return h(React.Fragment, null,
      h(CtxTitle, { icon: "key", title: cur.label, sub: "工具 · 键控" }),
      h("div", { className: "ctx-div" }),
      h(Tag, null, "绿幕色键器 · 验证台"));
  }
  function left(s) {
    return h("div", { className: "sect" },
      h("div", { className: "sect-h" }, h("span", { className: "t" }, "键控")),
      NAV.map((n) => h("div", {
        key: n.id, className: "nav-i" + (s.cacheNav === n.id ? " on" : ""),
        onClick: () => s.setCacheNav(n.id),
      }, h("span", { className: "nav-ico" }, h(Icon, { name: n.icon, size: 16 })),
         h("span", null, n.label))));
  }
  /* ---------- 基准测试（keyer_bench）---------- */
  async function decodeAlpha(file) {   // gt.png → Float32Array(0..1)
    const bmp = await createImageBitmap(file);
    const cnv = document.createElement("canvas");
    cnv.width = bmp.width; cnv.height = bmp.height;
    const c = cnv.getContext("2d");
    c.drawImage(bmp, 0, 0);
    const d = c.getImageData(0, 0, bmp.width, bmp.height).data;
    const out = new Float32Array(bmp.width * bmp.height);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4] / 255;  // 灰度图取 R
    bmp.close && bmp.close();
    return { data: out, w: cnv.width, h: cnv.height };
  }

  function BenchCenter() {
    const canvasRef = useRef(null);
    const engineRef = useRef(null);
    const fileRef = useRef(null);
    const [probe, setProbe] = useState(null);
    const [rows, setRows] = useState([]);
    const [running, setRunning] = useState(false);
    const [report, setReport] = useState(null);
    useEffect(() => {
      let dead = false;
      probeWebGpu(canvasRef.current).then((r) => {
        if (dead) return;
        setProbe(r);
        if (r.ok) engineRef.current = new KeyerEngine(r);
      });
      return () => { dead = true; engineRef.current = null; };
    }, []);
    const runBench = async (files) => {
      const engine = engineRef.current;
      if (!engine || !files.length) return;
      setRunning(true); setRows([]); setReport(null);
      const byCase = {};
      for (const f of files) {
        const m = /^(case\d+_[a-z]+)(?:_f(\d+))?\.(input|gt|plate)\.png$/.exec(f.name);
        if (!m) continue;
        const c = (byCase[m[1]] = byCase[m[1]] || { inputs: [], gt: null, plate: null });
        if (m[3] === "gt") c.gt = f;
        else if (m[3] === "plate") c.plate = f;
        else c.inputs.push({ f, idx: m[2] ? parseInt(m[2], 10) : 0 });
      }
      const out = [];
      for (const id of Object.keys(byCase).sort()) {
        const c = byCase[id];
        if (!c.gt || !c.inputs.length) continue;
        c.inputs.sort((a, b) => a.idx - b.idx);
        const t0 = performance.now();
        engine.setParams(DEFAULTS);                     // 每 case 复位默认参数
        engine.clearPlate();
        const first = await createImageBitmap(c.inputs[0].f);
        engine.loadImage(first);                        // 先定尺寸
        if (c.plate) {
          const pb = await createImageBitmap(c.plate);
          engine.loadPlate(pb);
          pb.close && pb.close();
        }
        // 自动取样主色：左上角 (10,10) 处 3×3（全部 case 幕布覆盖该角）
        await engine.sampleKeyColor(10 / first.width, 10 / first.height);
        const frames = [first];
        for (let i = 1; i < c.inputs.length; i++) frames.push(await createImageBitmap(c.inputs[i].f));
        // 单帧 case 重复渲染 8 次让时域项收敛；多帧 case 顺序喂满（检验时域轨）
        const N = Math.max(8, frames.length);
        for (let i = 0; i < N; i++) {
          engine.loadImage(frames[Math.min(i, frames.length - 1)]);
          engine.renderOnce();
        }
        frames.forEach((b) => b.close && b.close());
        const matte = await engine.readbackMatteFull();
        const gt = await decodeAlpha(c.gt);
        const ms = performance.now() - t0;
        if (!matte || matte.w !== gt.w || matte.h !== gt.h) continue;
        const row = { id, mad: mad(matte.data, gt.data), grad: gradErr(matte.data, gt.data, gt.w, gt.h), ms };
        out.push(row);
        setRows([...out]);
      }
      const agg = {
        mad: out.reduce((s, r) => s + r.mad, 0) / Math.max(1, out.length),
        grad: out.reduce((s, r) => s + r.grad, 0) / Math.max(1, out.length),
      };
      setReport({ cases: out.map(({ id, mad: m2, grad: g2 }) => ({ id, mad: m2, grad: g2 })), aggregate: agg });
      setRunning(false);
    };
    const exportReport = () => {
      if (!report) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
      a.download = "keyer-report.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    return h(React.Fragment, null,
      h("input", { ref: fileRef, type: "file", multiple: true, accept: "image/png", style: { display: "none" },
        onChange: (ev) => { const fs = Array.from(ev.target.files || []); ev.target.value = ""; runBench(fs); } }),
      h("div", { className: "canvas-head" },
        h("span", { className: "t" }, "基准测试"),
        h("div", { className: "right" },
          h(Button, { variant: "secondary", size: "S", isDisabled: !probe || !probe.ok || running,
            onPress: () => fileRef.current && fileRef.current.click() }, running ? "运行中…" : "加载测试集"),
          h(Button, { variant: "secondary", size: "S", isDisabled: !report, onPress: exportReport }, "导出报告"))),
      h("div", { className: "canvas-stage kl-stage kl-bench" },
        h("canvas", { ref: canvasRef, className: "kl-canvas kl-bench-canvas", width: 1280, height: 720 }),
        h("div", { className: "kl-bench-table" },
          h("div", { className: "kl-bench-row kl-bench-head" },
            h("span", null, "case"), h("span", null, "MAD"), h("span", null, "grad"), h("span", null, "耗时")),
          rows.map((r) => h("div", { key: r.id, className: "kl-bench-row" },
            h("span", null, r.id), h("span", null, r.mad.toFixed(4)),
            h("span", null, r.grad.toFixed(4)), h("span", null, r.ms.toFixed(0) + " ms"))),
          report ? h("div", { className: "kl-bench-row kl-bench-agg" },
            h("span", null, "aggregate"), h("span", null, report.aggregate.mad.toFixed(4)),
            h("span", null, report.aggregate.grad.toFixed(4)), h("span", null, "—")) : null)));
  }

  function center(s) {
    if (s.cacheNav === "keyer_bench") return h(BenchCenter, { key: "bench" });
    return h(KeyerCenter, { s });
  }
  function InspectorPanel() {
    const keyer = useKeyerSnapshot();
    const params = keyer.params;
    return h("div", { className: "insp-detail kl-inspector" },
      h("div", { className: "insp-head" },
        h("div", null,
          h("div", { className: "title" }, "参数"),
          h("div", { className: "sub" }, "Keyer core v1"))),
      h("div", { className: "insp-sect" },
        h("div", { className: "lh" }, "Key Color"),
        h("div", { className: "kl-keycolor" },
          h("span", { className: "kl-swatch", style: { background: keyColorCss(params.keyColor) } }),
          h("span", { className: "kl-keyhint" }, "点击画面取样"),
          h("span", { className: "kl-keyvalue" }, params.keyColor.map((v) => v.toFixed(3)).join(" ")))),
      h("div", { className: "insp-sect" },
        h("div", { className: "lh" }, "Knobs"),
        KNOBS.map((k) => h("label", { key: k.key, className: "kl-knob" },
          h("span", { className: "kl-knob-label" }, k.label),
          h("input", {
            type: "range",
            min: k.min,
            max: k.max,
            step: k.step,
            value: params[k.key],
            onChange: (ev) => keyerStore.setParam(k.key, Number(ev.currentTarget.value)),
          }),
          h("span", { className: "kl-knob-value" }, knobValue(params[k.key], k.step))))),
      h("div", { className: "insp-sect" },
        h("div", { className: "lh" }, "Key Color · Hex"),
        h("div", { className: "kl-hexrow" },
          h("input", {
            className: "kl-hex", type: "text", placeholder: "#26a626", spellCheck: false,
            onKeyDown: (ev) => {
              if (ev.key !== "Enter") return;
              const m = /^#?([0-9a-f]{6})$/i.exec(ev.currentTarget.value.trim());
              if (!m) return;
              const n = parseInt(m[1], 16);
              const s2l = (b) => Math.pow(((b / 255) + 0.055) / 1.055, 2.4);
              keyerStore.setParam("keyColor", [s2l(n >> 16 & 255), s2l(n >> 8 & 255), s2l(n & 255)]);
            },
          }),
          h(Button, { variant: "secondary", size: "S", onPress: () => keyerStore.resetDefaults() }, "重置默认"))),
      h(PresetSection, null));
  }

  const PRESET_KEY = "volo-keyer-presets";
  function loadPresets() {
    try { return JSON.parse(localStorage.getItem(PRESET_KEY) || "{}"); } catch { return {}; }
  }
  function PresetSection() {
    const [presets, setPresets] = useState(loadPresets);
    const [name, setName] = useState("");
    const persist = (next) => { localStorage.setItem(PRESET_KEY, JSON.stringify(next)); setPresets(next); };
    return h("div", { className: "insp-sect" },
      h("div", { className: "lh" }, "Presets"),
      h("div", { className: "kl-hexrow" },
        h("input", { className: "kl-hex", type: "text", placeholder: "预设名", value: name, spellCheck: false,
          onChange: (ev) => setName(ev.currentTarget.value) }),
        h(Button, { variant: "secondary", size: "S", isDisabled: !name.trim(), onPress: () => {
          const next = { ...presets, [name.trim()]: keyerStore.snapshot().params };
          persist(next); setName("");
        } }, "保存")),
      Object.keys(presets).map((k) => h("div", { key: k, className: "kl-preset" },
        h("span", { className: "n" }, k),
        h("button", { className: "act", onClick: () => keyerStore.applyPreset(presets[k]) }, "加载"),
        h("button", { className: "act del", onClick: () => {
          const next = { ...presets }; delete next[k]; persist(next);
        } }, "删除"))));
  }
  function inspector() {
    return h(InspectorPanel, null);
  }

  window.VOLO_KEYER = { ctx, left, center, inspector };
})();
export {};
