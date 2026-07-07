// @ts-nocheck
/* Volo — Tools · 键控 Keyer Lab（grill 共识五件套之验证台）。
   算法核心在 src/volo/keyer/（typed TS + WGSL），本文件只做 UI 编排。 */
import * as React from "react";
import "../ds";
import { probeWebGpu } from "../keyer/gpu";
import { KeyerEngine } from "../keyer/engine";
import { DEFAULTS, KNOBS } from "../keyer/params";

(function () {
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
      const cb = () => {
        if (!videoRef.current || !engineRef.current) return;
        engineRef.current.loadImage(videoRef.current);
        engineRef.current.renderOnce();
        const st = engineRef.current.stats();
        setHud(st.fps.toFixed(1) + " fps · " + st.frameMs.toFixed(2) + " ms");
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
          probe && probe.ok
            ? h(StatusLight, { variant: "positive" }, "WebGPU · " + probe.adapterInfo.vendor)
            : probe ? h(StatusLight, { variant: "negative" }, "WebGPU 不可用") : null)),
      h("div", { className: "canvas-stage kl-stage" },
        h("canvas", { ref: canvasRef, className: "kl-canvas", width: 1280, height: 720, onClick: onCanvasClick }),
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
  function center(s) {
    if (s.cacheNav === "keyer_bench") return h("div", { className: "canvas-stage skl-stage" },
      h("div", { className: "skl-ph" }, h("div", { className: "skl-title" }, "基准测试"),
        h("div", { className: "skl-intent" }, "GT 测试集指标回归 — Task 9 建设")));
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
        h("div", { className: "lh" }, "Primary Matte"),
        KNOBS.slice(0, 6).map((k) => h("label", { key: k.key, className: "kl-knob" },
          h("span", { className: "kl-knob-label" }, k.label),
          h("input", {
            type: "range",
            min: k.min,
            max: k.max,
            step: k.step,
            value: params[k.key],
            onChange: (ev) => keyerStore.setParam(k.key, Number(ev.currentTarget.value)),
          }),
          h("span", { className: "kl-knob-value" }, knobValue(params[k.key], k.step))))));
  }
  function inspector() {
    return h(InspectorPanel, null);
  }

  window.VOLO_KEYER = { ctx, left, center, inspector };
})();
export {};
