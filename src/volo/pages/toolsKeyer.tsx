// @ts-nocheck
/* Volo — Tools · 键控 Keyer Lab（grill 共识五件套之验证台）。
   算法核心在 src/volo/keyer/（typed TS + WGSL），本文件只做 UI 编排。 */
import * as React from "react";
import "../ds";
import { probeWebGpu } from "../keyer/gpu";

(function () {
  const { InlineAlert, StatusLight, Tag } = window.Spectrum2DesignSystem_b6d1b3;
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;

  const NAV = [
    { id: "keyer_lab",   label: "抠像实验台", icon: "key" },
    { id: "keyer_bench", label: "基准测试",   icon: "target" },
  ];

  function KeyerCenter() {
    const canvasRef = useRef(null);
    const [probe, setProbe] = useState(null);
    useEffect(() => { probeWebGpu(canvasRef.current).then(setProbe); }, []);
    return h(React.Fragment, null,
      h("div", { className: "canvas-head" },
        h("span", { className: "t" }, "抠像实验台"),
        h("div", { className: "right" },
          probe && probe.ok
            ? h(StatusLight, { variant: "positive" }, "WebGPU · " + probe.adapterInfo.vendor)
            : probe ? h(StatusLight, { variant: "negative" }, "WebGPU 不可用") : null)),
      h("div", { className: "canvas-stage kl-stage" },
        h("canvas", { ref: canvasRef, className: "kl-canvas", width: 1280, height: 720 }),
        probe && probe.ok ? h("div", { className: "kl-probe" },
          probe.adapterInfo.vendor + " · " + probe.adapterInfo.architecture + " · " + probe.format) : null,
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
