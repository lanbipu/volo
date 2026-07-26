// @ts-nocheck
/* Volo — 校正 · 路径全自动化（屏幕定义 / 校正图案 / 输出位置）
   1:1 移植自 Claude Design handoff `src/cal2_autogen.jsx`，接真实后端：
     · useAutoGen(s)  —— 标定屏幕选择 + 三个自动状态的状态机。状态一律来自真实
                          后端调用（export_vpcal_screen + ensureScreenPatterns），
                          **不是** CD 原型里的演示 mock。CD 的「演示状态切换条」
                          DemoStrip 是设计稿评审控件，按任务纪律不移植。
     · ScreenChips    —— 标定屏幕多选列表（前置圆点 = 已选；至少保留一屏）。
     · AutoStatusRows —— 三个自动状态紧凑单卡行（色点 + 文字；失败态 title 带原文）。
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
    const [selectedIds, setSelectedIds] = useState(() => screenIds.slice());
    const screenSetSig = screenIds.join("\u0000");
    useEffect(() => {
      setSelectedIds((previous) => {
        const valid = previous.filter((id) => screenIds.includes(id));
        return valid.length ? valid : screenIds.slice();
      });
    }, [projectPath, screenSetSig]);
    const activeIds = selectedIds.filter((id) => screenIds.includes(id));
    const selectedScreens = screens.filter((screen) => activeIds.includes(screen.id));
    const screenId = activeIds[0] || null;
    const screen = selectedScreens[0] || { id: screenId, name: screenId || "—", multiSection: false };
    const multiSection = selectedScreens.some((candidate) => candidate.multiSection);
    const paths = projectPath ? lensWorkspacePaths(projectPath) : null;

    const [screenDef, setScreenDef] = useState("syncing");   /* syncing | synced | exportFail */
    const [screenDefErr, setScreenDefErr] = useState("");
    const [pattern, setPattern] = useState("generating");    /* generating | needRegen | generated | genFail | unsupported */
    const [patternErr, setPatternErr] = useState("");
    const [syncing, setSyncing] = useState(true);
    const [preparing, setPreparing] = useState(false);
    const [targets, setTargets] = useState([]);
    const runSeq = useRef(0);
    const prevSig = useRef(null);

    /* 屏幕设计签名：用于识别「屏幕设计已变更 → 需重新生成」（needRegen 真实触发） */
    const activeKey = activeIds.join("\u0000");
    const screenSig = activeIds.length
      ? JSON.stringify(activeIds.map((id) => [id, screensMap[id] || null])) : null;

    /* assignment.json 是屏幕集合级 artifact；Windows 上并发 sync/replace 会互相抢占。
       逐屏 ensure 保持写入串行，pattern renderer 本身仍由 sidecar 独立执行。 */
    const ensureSelected = async (options = {}) => {
      const results = [];
      for (const id of activeIds) {
        results.push(await ensureScreenPatterns(projectPath, id, options));
      }
      return results;
    };

    const runEnsure = async (designChanged) => {
      if (!projectPath || !activeIds.length) { setTargets([]); setSyncing(false); return; }
      const seq = ++runSeq.current;

      if (multiSection) {
        /* 折面屏（多 section）：仍导出 screen.json（便于 CLI 手动上屏），但不自动生成图案 */
        setSyncing(true); setScreenDef("syncing");
        try {
          await Promise.all(activeIds.map((id) => exportVpcalScreen(projectPath, id, null)));
          if (seq !== runSeq.current) return;
          setTargets([]);
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
        const results = await ensureSelected({
          onGenerating: () => { if (seq === runSeq.current) { setSyncing(false); setPattern("generating"); } },
        });
        if (seq !== runSeq.current) return;
        const nextTargets = results.map((result, index) => ({ id: activeIds[index], ...result }));
        setTargets(nextTargets);
        if (s.setCapScreenFile) s.setCapScreenFile(nextTargets[0].screenJson);
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
    }, [projectPath, activeKey, screenSig, multiSection]);

    const toggleScreen = (id) => {
      if (syncing || !screenIds.includes(id)) return;
      setSelectedIds((previous) => {
        const selected = previous.filter((candidate) => screenIds.includes(candidate));
        if (selected.includes(id)) {
          if (selected.length === 1) return selected;
          const next = selected.filter((candidate) => candidate !== id);
          if (s.calActiveScreen === id && s.setCalActiveScreen) s.setCalActiveScreen(next[0]);
          return next;
        }
        if (s.setCalActiveScreen) s.setCalActiveScreen(id);
        return screenIds.filter((candidate) => selected.includes(candidate) || candidate === id);
      });
      s && s.pushLog && s.pushLog({ lv: "info", cat: "lens", msg: "更新标定屏幕集合 · 同步各屏 screen.json 与校正图案…" });
    };
    const retryScreenDef = () => { void runEnsure(false); };
    const retryPattern = () => {
      if (!projectPath || !activeIds.length || multiSection) return;
      const seq = ++runSeq.current;
      setPattern("generating"); setPatternErr("");
      (async () => {
        try {
          const results = await ensureSelected({ force: true });
          if (seq !== runSeq.current) return;
          const nextTargets = results.map((result, index) => ({ id: activeIds[index], ...result }));
          setTargets(nextTargets);
          if (s.setCapScreenFile) s.setCapScreenFile(nextTargets[0].screenJson);
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
      if (pattern === "generated" && screenDef === "synced" && !syncing && targets.length === activeIds.length) { startFn(targets); return; }
      setPreparing(true);
      try {
        const results = await ensureSelected({
          onGenerating: () => setPattern("generating"),
        });
        const nextTargets = results.map((result, index) => ({ id: activeIds[index], ...result }));
        setTargets(nextTargets);
        if (s.setCapScreenFile) s.setCapScreenFile(nextTargets[0].screenJson);
        setScreenDef("synced"); setPattern("generated"); setPatternErr("");
        startFn(nextTargets);
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
      screens, selectedIds: activeIds, screenId, screen,
      screenName: activeIds.length === 1 ? screen.name : `${activeIds.length} 块屏幕`,
      multiSection, targets,
      screenDef, screenDefErr, pattern, patternErr, syncing, preparing,
      outputPath: paths ? paths.relOutput : "vpcal/captures/",
      capturesDir: paths ? paths.capturesDir : "",
      patternsDir: targets[0] ? targets[0].patternsDir : "",
      patternsDirs: Object.fromEntries(targets.map((target) => [target.id, target.patternsDir])),
      hasProject: !!projectPath,
      toggleScreen, switchScreen: toggleScreen,
      retryScreenDef, retryPattern, beginCapture, openOutput,
    };
  }

  /* ---------- 标定屏幕列表（多选 · 圆点表示已选 · 至少保留一屏） ---------- */
  function ScreenChips({ ag, disabled }) {
    if (!ag.screens.length) {
      return h("div", { className: "ag-list" },
        h("div", { className: "ag-lrow ag-lrow--empty" },
          h("span", { className: "ag-lname" }, ag.hasProject ? "项目内没有屏幕设计" : "未打开项目")));
    }
    return h("div", { className: "ag-list" + (disabled ? " is-disabled" : "") }, ag.screens.map((sc) => {
      const on = ag.selectedIds.includes(sc.id);
      return h("button", {
        key: sc.id, className: "ag-lrow" + (on ? " on" : ""),
        disabled: disabled || (ag.selectedIds.length === 1 && on),
        "aria-pressed": on,
        onClick: () => !disabled && ag.toggleScreen(sc.id),
        title: sc.multiSection ? "折面屏 / 异形（多 section）" : sc.sub,
      },
        h("span", { className: "ag-ldot" }),
        h("span", { className: "ag-lname" }, sc.name),
        h("span", { className: "ag-lsub" }, sc.multiSection ? "异形" : (sc.columns ? sc.columns + " 柜" : "平面")));
    }));
  }

  /* ---------- 紧凑状态行：标签 · 一行状态 · 可选操作 ---------- */
  const iconBtn = (icon, title, onClick) =>
    h("button", { className: "ag-iconbtn", title: title, onClick: onClick }, h(Icon, { name: icon, size: 13 }));

  function mrow(label, opts) {
    opts = opts || {};
    return h("div", { className: "ag-mrow" + (opts.tone ? " t-" + opts.tone : ""), title: opts.title || undefined },
      h("span", { className: "ag-mk" }, label),
      opts.skeleton
        ? h("span", { className: "ag-skel" })
        : h("span", { className: "ag-mv" + (opts.mono ? " mono" : "") },
            opts.tone ? h("span", { className: "ag-mdot" }) : null,
            opts.spin ? h("span", { className: "ag-spin" }, h(Icon, { name: "sync", size: 11 })) : null,
            h("span", { className: "t" }, opts.text)),
      opts.action || null,
      opts.bar ? h("span", { className: "ag-indet" }, h("span", { className: "ag-indet-bar" })) : null);
  }

  /* ---------- 三个自动状态行（紧凑单卡） ---------- */
  function AutoStatusRows({ ag }) {
    /* ① 屏幕定义 */
    const defRow = ag.syncing
      ? mrow("屏幕定义", { skeleton: true })
      : ag.screenDef === "exportFail"
        ? mrow("屏幕定义", { tone: "negative", text: "导出失败", title: ag.screenDefErr || "导出 screen.json 失败",
            action: iconBtn("sync", "重试导出", ag.retryScreenDef) })
        : mrow("屏幕定义", { tone: "positive", text: "已同步 · " + ag.screenName });

    /* ② 校正图案 */
    let patRow;
    if (ag.syncing) {
      patRow = mrow("校正图案", { skeleton: true });
    } else if (ag.screenDef === "exportFail") {
      patRow = mrow("校正图案", { tone: "notice", text: "等待屏幕定义",
        title: "屏幕定义导出失败，修复后将自动生成图案。" });
    } else if (ag.pattern === "unsupported") {
      patRow = mrow("校正图案", { tone: "notice", text: "折面屏不支持",
        title: "折面屏（多 section）图案上屏 P0 暂不支持，需 CLI 手动生成 / 上屏。" });
    } else if (ag.pattern === "generating") {
      patRow = mrow("校正图案", { tone: "notice", spin: true, bar: true,
        text: ag.preparing ? "补生成中…" : "生成中…" });
    } else if (ag.pattern === "needRegen") {
      patRow = mrow("校正图案", { tone: "notice", text: "需重新生成 · 已自动触发",
        title: "系统检测到屏幕设计已变更，已自动触发重新生成，无需手动操作。" });
    } else if (ag.pattern === "genFail") {
      patRow = mrow("校正图案", { tone: "negative", text: "生成失败", title: ag.patternErr || "校正图案生成失败",
        action: iconBtn("sync", "重试生成", ag.retryPattern) });
    } else {
      patRow = mrow("校正图案", { tone: "positive", text: "已生成 · 含灰码角标",
        title: "灰码角标已内置于图案，无需手动准备 normal / inverted 文件。" });
    }

    /* ③ 输出位置（只读 · 无失败态） */
    const outRow = mrow("输出位置", { mono: true, text: ag.outputPath, title: ag.outputPath,
      action: iconBtn("folder", "打开目录", ag.openOutput) });

    return h("div", { className: "ag-rows ag-mini" }, defRow, patRow, outRow);
  }

  window.VoloAutoGen = { useAutoGen, ScreenChips, AutoStatusRows };
})();
