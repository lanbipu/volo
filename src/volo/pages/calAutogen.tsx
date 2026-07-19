// @ts-nocheck
/* Volo — 校正 · 路径全自动化（屏幕定义 / 校正图案 / 输出位置）
   1:1 移植自 Claude Design handoff `src/cal2_autogen.jsx`，接真实后端：
     · useAutoGen(s)  —— 标定屏幕选择 + 三个自动状态的状态机。状态一律来自真实
                          后端调用（export_vpcal_screen + ensureScreenPatterns），
                          **不是** CD 原型里的演示 mock。CD 的「演示状态切换条」
                          DemoStrip 是设计稿评审控件，按任务纪律不移植。
     · ScreenChips    —— 标定屏幕横向单选 chip（复用摄影机 chip 样式语言）。
     · AutoStatusRows —— 三个自动状态行（状态三通道：色 + 图标 + 文字）。
   屏幕来源 = VOLO_CAL2.useProj() 的 project.config.screens；路径推导走
   api/lensWorkspace（唯一入口）。 */
import * as React from "react";
import { revealPath } from "../api/commands";
import { exportVpcalScreen } from "../api/meshCommands";
import { ensureScreenPatterns, lensWorkspacePaths } from "../api/lensWorkspace";

(function () {
  const { useState, useRef, useEffect } = React;
  const h = React.createElement;

  const errMsg = (e) => (e && e.message ? e.message : String(e));
  const SHAPE_SUB = {
    flat: "平面 · 单 section",
    folded: "折线 · 单平面 section",
    curved: "曲面 · 多 section",
    arc: "弧面 · 多 section",
    l_shape: "L 形 · 多 section",
    u_shape: "U 形 · 多 section",
    custom_segments: "自定义分段 · 多 section",
  };
  /* 与 mesh_export::vpcal_sections 对齐：Flat / Folded → 单 plane section（支持）；
     其余 shape_prior → 逐列多 section（P0 不支持自动上屏，见 spec D6）。 */
  const isMultiSection = (sc) => {
    const t = (sc && sc.shape_prior && sc.shape_prior.type) || "flat";
    return t !== "flat" && t !== "folded";
  };

  /* 三通道徽章 */
  function pill(tone, icon, text, spin) {
    return h("span", { className: "cap-pill cap-pill--" + tone },
      spin ? h("span", { className: "ag-spin" }, h(Icon, { name: "sync", size: 12 })) : h(Icon, { name: icon, size: 12 }),
      text);
  }

  /* ---------- 状态机（真实后端） ---------- */
  function useAutoGen(s) {
    const proj = (window.VOLO_CAL2 && window.VOLO_CAL2.useProj) ? window.VOLO_CAL2.useProj() : {};
    const projectPath = proj && proj.path ? proj.path : null;
    const screensMap = (proj && proj.config && proj.config.screens) || {};
    const screenIds = Object.keys(screensMap).sort();
    const screens = screenIds.map((id) => {
      const sc = screensMap[id] || {};
      const multi = isMultiSection(sc);
      return {
        id, name: id,
        sub: SHAPE_SUB[(sc.shape_prior && sc.shape_prior.type) || "flat"] || "平面",
        columns: (sc.cabinet_count || [0])[0] || 0,
        multiSection: multi,
      };
    });
    const screenId = (s.calActiveScreen && screenIds.indexOf(s.calActiveScreen) >= 0)
      ? s.calActiveScreen : (screenIds[0] || null);
    const screen = screens.find((x) => x.id === screenId) || { id: screenId, name: screenId || "—", multiSection: false };
    const multiSection = !!screen.multiSection;
    const paths = projectPath ? lensWorkspacePaths(projectPath) : null;

    const [screenDef, setScreenDef] = useState("syncing");   /* syncing | synced | exportFail */
    const [screenDefErr, setScreenDefErr] = useState("");
    const [pattern, setPattern] = useState("generating");    /* generating | needRegen | generated | genFail | unsupported */
    const [patternErr, setPatternErr] = useState("");
    const [syncing, setSyncing] = useState(true);
    const [preparing, setPreparing] = useState(false);
    const runSeq = useRef(0);
    const prevSig = useRef(null);

    /* 屏幕设计签名：用于识别「屏幕设计已变更 → 需重新生成」（needRegen 真实触发） */
    const screenSig = screenId ? JSON.stringify(screensMap[screenId] || null) : null;

    const runEnsure = async (designChanged) => {
      if (!projectPath || !screenId) { setSyncing(false); return; }
      const seq = ++runSeq.current;

      if (multiSection) {
        /* 折面屏（多 section）：仍导出 screen.json（便于 CLI 手动上屏），但不自动生成图案 */
        setSyncing(true); setScreenDef("syncing");
        try {
          const exp = await exportVpcalScreen(projectPath, screenId, null);
          if (seq !== runSeq.current) return;
          if (s.setCapScreenFile) s.setCapScreenFile(exp.path);
          setScreenDef("synced"); setScreenDefErr("");
        } catch (e) {
          if (seq !== runSeq.current) return;
          setScreenDef("exportFail"); setScreenDefErr(errMsg(e));
        } finally {
          if (seq === runSeq.current) setSyncing(false);
        }
        setPattern("unsupported"); setPatternErr("");
        return;
      }

      setSyncing(true); setScreenDef("syncing");
      if (designChanged) setPattern("needRegen");
      try {
        const res = await ensureScreenPatterns(projectPath, screenId, {
          onGenerating: () => { if (seq === runSeq.current) { setSyncing(false); setPattern("generating"); } },
        });
        if (seq !== runSeq.current) return;
        if (s.setCapScreenFile) s.setCapScreenFile(res.screenJson);
        setScreenDef("synced"); setScreenDefErr("");
        setPattern("generated"); setPatternErr("");
      } catch (e) {
        if (seq !== runSeq.current) return;
        const m = errMsg(e);
        if (e && e.stage === "pattern") { setScreenDef("synced"); setPattern("genFail"); setPatternErr(m); }
        else { setScreenDef("exportFail"); setScreenDefErr(m); }
      } finally {
        if (seq === runSeq.current) setSyncing(false);
      }
    };

    /* 进入采集页 / 切换标定屏幕 / 屏幕设计变更 → 后台自动 ensure（预热一次） */
    useEffect(() => {
      const changed = prevSig.current !== null && prevSig.current !== screenSig;
      prevSig.current = screenSig;
      void runEnsure(changed);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectPath, screenId, screenSig, multiSection]);

    const switchScreen = (id) => {
      if (id === screenId || syncing) return;
      if (s.setCalActiveScreen) s.setCalActiveScreen(id);
      s && s.pushLog && s.pushLog({ lv: "info", cat: "lens", msg: "切换标定屏幕 · 同步 screen.json 与校正图案…" });
    };
    const retryScreenDef = () => { void runEnsure(false); };
    const retryPattern = () => {
      if (!projectPath || !screenId || multiSection) return;
      const seq = ++runSeq.current;
      setPattern("generating"); setPatternErr("");
      (async () => {
        try {
          const res = await ensureScreenPatterns(projectPath, screenId, { force: true });
          if (seq !== runSeq.current) return;
          if (s.setCapScreenFile) s.setCapScreenFile(res.screenJson);
          setScreenDef("synced"); setPattern("generated"); setPatternErr("");
        } catch (e) {
          if (seq !== runSeq.current) return;
          const m = errMsg(e);
          if (e && e.stage === "pattern") { setPattern("genFail"); setPatternErr(m); }
          else { setScreenDef("exportFail"); setScreenDefErr(m); }
        }
      })();
    };

    /* 开始采集：图案未新鲜时先补生成（过渡态「生成图案中…」），完成后再真正开始 */
    const beginCapture = async (startFn) => {
      if (multiSection || screenDef === "exportFail") return;
      if (pattern === "generated" && screenDef === "synced" && !syncing) { startFn(); return; }
      setPreparing(true);
      try {
        const res = await ensureScreenPatterns(projectPath, screenId, {
          onGenerating: () => setPattern("generating"),
        });
        if (s.setCapScreenFile) s.setCapScreenFile(res.screenJson);
        setScreenDef("synced"); setPattern("generated"); setPatternErr("");
        startFn();
      } catch (e) {
        const m = errMsg(e);
        if (e && e.stage === "pattern") { setPattern("genFail"); setPatternErr(m); }
        else { setScreenDef("exportFail"); setScreenDefErr(m); }
      } finally {
        setPreparing(false);
      }
    };

    const openOutput = () => {
      if (!paths) return;
      revealPath(paths.capturesDir, null).catch((e) => {
        s && s.pushLog && s.pushLog({ lv: "err", cat: "lens", msg: "打开采集目录失败 · " + errMsg(e) });
      });
    };

    return {
      screens, screenId, screen, screenName: screen.name, multiSection,
      screenDef, screenDefErr, pattern, patternErr, syncing, preparing,
      outputPath: paths ? paths.relOutput : "vpcal/captures/",
      capturesDir: paths ? paths.capturesDir : "",
      patternsDir: (paths && screenId) ? paths.patternsDir(screenId) : "",
      hasProject: !!projectPath,
      switchScreen, retryScreenDef, retryPattern, beginCapture, openOutput,
    };
  }

  /* ---------- 标定屏幕 chips（单选 · 复用相机 chip 样式语言） ---------- */
  function ScreenChips({ ag, disabled }) {
    if (!ag.screens.length) {
      return h("div", { className: "ag-chips ag-chips-empty" }, ag.hasProject ? "项目内没有屏幕设计" : "未打开项目");
    }
    return h("div", { className: "lc-camchips ag-chips" }, ag.screens.map((sc) =>
      h("button", {
        key: sc.id, className: "lc-camchip" + (sc.id === ag.screenId ? " on" : ""),
        disabled: disabled, onClick: () => !disabled && ag.switchScreen(sc.id),
        title: sc.multiSection ? "折面屏 / 异形（多 section）" : sc.sub,
      },
        h("span", { className: "ag-chip-ic" }, h(Icon, { name: "panel", size: 13 })),
        sc.name)));
  }

  /* ---------- 单个自动状态行 ---------- */
  function row(label, opts) {
    opts = opts || {};
    return h("div", { className: "ag-row" + (opts.pending ? " is-pending" : "") },
      h("div", { className: "ag-row-top" },
        h("span", { className: "ag-row-lb" }, label),
        h("span", { className: "ag-sp" }),
        opts.skeleton ? h("span", { className: "ag-skel" }) : opts.badge,
        opts.action || null),
      opts.bar || null,
      opts.note ? h("div", { className: "ag-row-note" }, opts.note) : null,
      opts.error ? h("div", { className: "ag-row-err" }, h(Icon, { name: "alert", size: 12 }), h("span", null, opts.error)) : null,
      opts.pathNode || null);
  }

  const iconBtn = (icon, title, onClick) =>
    h("button", { className: "ag-iconbtn", title: title, onClick: onClick }, h(Icon, { name: icon, size: 14 }));

  /* ---------- 三个自动状态行 ---------- */
  function AutoStatusRows({ ag }) {
    /* ① 屏幕定义 */
    const defRow = ag.syncing
      ? row("屏幕定义", { skeleton: true })
      : ag.screenDef === "exportFail"
        ? row("屏幕定义", {
            badge: pill("negative", "x", "导出失败"),
            action: iconBtn("sync", "重试导出", ag.retryScreenDef), error: ag.screenDefErr, pending: true,
          })
        : row("屏幕定义", { badge: pill("positive", "check", "已同步 · " + ag.screenName) });

    /* ② 校正图案 */
    let patRow;
    if (ag.syncing) {
      patRow = row("校正图案", { skeleton: true });
    } else if (ag.screenDef === "exportFail") {
      /* 导出失败时生成链路被卡在前置，不能显示「已自动触发重新生成」 */
      patRow = row("校正图案", {
        badge: pill("neutral", "minus", "等待屏幕定义"),
        note: "屏幕定义导出失败，修复后将自动生成图案。",
      });
    } else if (ag.pattern === "unsupported") {
      patRow = row("校正图案", {
        badge: pill("notice", "alert", "折面屏不支持"),
        note: "折面屏（多 section）图案上屏 P0 暂不支持，需 CLI 手动生成 / 上屏。",
      });
    } else if (ag.pattern === "generating") {
      patRow = row("校正图案", {
        badge: pill("notice", "sync", ag.preparing ? "补生成中" : "生成中", true),
        bar: h("div", { className: "ag-indet" }, h("span", { className: "ag-indet-bar" })),
      });
    } else if (ag.pattern === "needRegen") {
      patRow = row("校正图案", {
        badge: pill("notice", "alert", "需重新生成"),
        note: "系统检测到屏幕设计已变更，已自动触发重新生成，无需手动操作。",
      });
    } else if (ag.pattern === "genFail") {
      patRow = row("校正图案", {
        badge: pill("negative", "x", "生成失败"),
        action: iconBtn("sync", "重试生成", ag.retryPattern), error: ag.patternErr, pending: true,
      });
    } else {
      patRow = row("校正图案", {
        badge: pill("positive", "check", "已生成"),
        note: "灰码角标已内置于图案，无需手动准备 normal / inverted 文件。",
      });
    }

    /* ③ 输出位置（只读 · 无失败态） */
    const outRow = row("输出位置", {
      badge: h("span", { className: "ag-auto-tag" }, h(Icon, { name: "check", size: 11 }), "自动"),
      action: iconBtn("folder", "打开目录", ag.openOutput),
      pathNode: h("div", { className: "ag-path" }, h(Icon, { name: "folder", size: 13 }), h("span", { className: "mono" }, ag.outputPath)),
    });

    return h("div", { className: "ag-rows" }, defRow, patRow, outRow);
  }

  window.VoloAutoGen = { useAutoGen, ScreenChips, AutoStatusRows };
})();
