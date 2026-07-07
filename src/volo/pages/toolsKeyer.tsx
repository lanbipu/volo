// @ts-nocheck
/* Volo — Tools · 键控 Keyer Lab（grill 共识五件套之验证台）。
   算法核心在 src/volo/keyer/（typed TS + WGSL），本文件只做 UI 编排。 */
import * as React from "react";
import "../ds";
import { probeWebGpu } from "../keyer/gpu";
import { KeyerEngine } from "../keyer/engine";

(function () {
  const { Button, InlineAlert, StatusLight, Tag } = window.Spectrum2DesignSystem_b6d1b3;
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;

  const NAV = [
    { id: "keyer_lab",   label: "抠像实验台", icon: "key" },
    { id: "keyer_bench", label: "基准测试",   icon: "target" },
  ];

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
    useEffect(() => {
      let dead = false;
      probeWebGpu(canvasRef.current).then((result) => {
        if (dead) return;
        setProbe(result);
        if (result.ok) engineRef.current = new KeyerEngine(result);
      });
      return () => {
        dead = true; engineRef.current = null;
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
      setPixelText("src(10,10)=" + r + "," + g + "," + b);
      if (bmp.close) bmp.close();
    };
    const togglePlay = () => {
      const v = videoRef.current;
      if (!v || !hasVideo) return;
      if (v.paused) { v.play(); setPlaying(true); pumpFrames(); }
      else { v.pause(); setPlaying(false); if (v.cancelVideoFrameCallback && vfcRef.current) v.cancelVideoFrameCallback(vfcRef.current); }
    };
    return h(React.Fragment, null,
      h("input", { ref: fileRef, type: "file", accept: "image/png,image/jpeg,video/mp4,video/quicktime", style: { display: "none" }, onChange: onFile }),
      h("video", { ref: videoRef, muted: true, loop: true, playsInline: true, style: { display: "none" } }),
      h("div", { className: "canvas-head" },
        h("span", { className: "t" }, "抠像实验台"),
        h("div", { className: "right" },
          hasVideo ? h(Button, { variant: "secondary", size: "S",
            icon: h(Icon, { name: playing ? "pause" : "play", size: 14 }), onPress: togglePlay }, playing ? "暂停" : "播放") : null,
          h(Button, { variant: "secondary", size: "S", isDisabled: !probe || !probe.ok,
            icon: h(Icon, { name: "folder", size: 14 }), onPress: openMedia }, "打开素材"),
          probe && probe.ok
            ? h(StatusLight, { variant: "positive" }, "WebGPU · " + probe.adapterInfo.vendor)
            : probe ? h(StatusLight, { variant: "negative" }, "WebGPU 不可用") : null)),
      h("div", { className: "canvas-stage kl-stage" },
        h("canvas", { ref: canvasRef, className: "kl-canvas", width: 1280, height: 720 }),
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
  function inspector() {
    return h("div", { className: "insp-empty" },
      h("div", { className: "ph" }, h(Icon, { name: "key", size: 30 })),
      h("div", null, h("div", { style: { color: "var(--chrome-dim)", fontWeight: 600, marginBottom: 4 } }, "参数"),
        "旋钮面板随 Task 4+ 建设"));
  }

  window.VOLO_KEYER = { ctx, left, center, inspector };
})();
export {};
