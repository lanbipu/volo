// @ts-nocheck
/* Volo — skeleton pages (Pre-viz / Color / Live / Tools) — shell consistent,
   canvas placeholder. 1:1 port of the Claude Design handoff `src/page_skeletons.jsx`.
   Tools page composes the cache + diagnostics segments. */
import * as React from "react";
import "../ds";
import "./cache";
import "./toolsKeyer";

(function () {
  const { Button, InlineAlert } = window.Spectrum2DesignSystem_b6d1b3;
  const h = React.createElement;

  function makeSkeleton(cfg) {
    function ctx(s) {
      return h(React.Fragment, null,
        h(CtxTitle, { icon: cfg.icon, title: cfg.title, sub: cfg.sub }),
        h('div', { className: 'ctx-div' }),
        h(Selector, { kpre: cfg.objKpre, value: 'o1', width: 196, options: cfg.objOpts }),
        h('div', { className: 'ctx-actions' },
          cfg.actions.map((a, i) => h(Button, {
            key: i, variant: a.variant || 'secondary', size: 'S', isDisabled: true,
            icon: h(Icon, { name: a.icon, size: 15 }),
          }, a.label))));
    }
    function left(s) {
      return h(React.Fragment, null,
        h('div', { className: 'sect' },
          h('div', { className: 'sect-h' }, h('span', { className: 't' }, cfg.navTitle)),
          cfg.nav.map((n, i) => h('div', { key: i, className: 'nav-i' + (i === 0 ? ' on' : ''), style: { cursor: 'default' } },
            h('span', { className: 'nav-ico' }, h(Icon, { name: n.icon, size: 16 })),
            h('span', null, n.label),
            n.ct != null ? h('span', { className: 'ct' }, n.ct) : null))),
        h('div', { className: 'sect', style: { marginTop: 'auto' } },
          h('div', { className: 'skl-note' }, h(Icon, { name: 'tools', size: 14 }), '面板已接入外壳 — 内容待建设')));
    }
    function center(s) {
      return h(React.Fragment, null,
        h('div', { className: 'canvas-head' },
          h('span', { className: 't' }, cfg.canvasTitle),
          h('div', { className: 'right' },
            h('div', { className: 'seg' },
              h('button', { className: 'on' }, h(Icon, { name: 'eye', size: 14 })),
              h('button', null, h(Icon, { name: 'settings', size: 14 }))))),
        h('div', { className: 'canvas-stage skl-stage' },
          h('div', { className: 'skl-grid' }),
          h('div', { className: 'skl-ph' },
            h('div', { className: 'skl-ico' }, h(Icon, { name: cfg.icon, size: 40, stroke: 1.3 })),
            h('div', { className: 'skl-title' }, cfg.title),
            h('div', { className: 'skl-intent' }, cfg.intent),
            h('div', { style: { marginTop: 18, maxWidth: 420 } },
              h(InlineAlert, { variant: 'informative', title: '外壳预览' },
                '通用外壳已就绪。' + cfg.title + ' 工作区尚未建设。')))));
    }
    function inspector(s) {
      return h('div', { className: 'insp-empty' },
        h('div', { className: 'ph' }, h(Icon, { name: cfg.icon, size: 30 })),
        h('div', null,
          h('div', { style: { color: 'var(--chrome-dim)', fontWeight: 600, marginBottom: 4 } }, 'Inspector'),
          '选中对象的详情显示在此'));
    }
    return { ctx, left, center, inspector };
  }

  window.VOLO_PAGES = window.VOLO_PAGES || {};
  window.VOLO_PAGES.previz = makeSkeleton({
    id: 'previz', icon: 'previz', title: '预可视化', sub: '场景布局与机位走位',
    objKpre: '场景', objOpts: [{ id: 'o1', label: 'Helios — 沙漠外景', sub: 'v12' }, { id: 'o2', label: 'Helios — 座舱', sub: 'v04' }],
    navTitle: '场景', nav: [{ icon: 'cube', label: '布景物件', ct: 18 }, { icon: 'camera', label: '机位', ct: 3 }, { icon: 'layers', label: '图层', ct: 6 }, { icon: 'previz', label: '故事板' }],
    actions: [{ label: '导入', icon: 'download' }, { label: '添加机位', icon: 'camera' }, { label: '播放', icon: 'play', variant: 'accent' }],
    canvasTitle: '预演视口', intent: '在拍摄日前，于虚拟场景中走位机位与布景。',
  });
  window.VOLO_PAGES.color = makeSkeleton({
    id: 'color', icon: 'color', title: '调色', sub: '屏幕 LUT 与一级',
    objKpre: '目标', objOpts: [{ id: 'o1', label: 'Volume A 墙', sub: 'P3-D65' }, { id: 'o2', label: '节目输出', sub: 'Rec.709' }],
    navTitle: '管线', nav: [{ icon: 'layers', label: '屏幕 LUT', ct: 4 }, { icon: 'color', label: '一级调色' }, { icon: 'wave', label: '示波器' }, { icon: 'panel', label: '校色卡' }],
    actions: [{ label: '新建 LUT', icon: 'plus' }, { label: '对比', icon: 'eye' }, { label: '应用', icon: 'check', variant: 'accent' }],
    canvasTitle: '调色管线', intent: '将 LED 墙匹配到相机，并用 LUT 与示波器塑造现场一级。',
  });
  window.VOLO_PAGES.live = makeSkeleton({
    id: 'live', icon: 'live', title: '现场', sub: '现场回放与录制',
    objKpre: '信号源', objOpts: [{ id: 'o1', label: '节目 — 机位 A', sub: '23.976' }, { id: 'o2', label: '同步 — 全局', sub: '已锁定' }],
    navTitle: '播控', nav: [{ icon: 'camera', label: '信号源', ct: 4 }, { icon: 'film', label: '镜头', ct: 42 }, { icon: 'live', label: '录制' }, { icon: 'net', label: '同步锁相' }],
    actions: [{ label: '预备', icon: 'play' }, { label: '待命', icon: 'target' }, { label: '录制', icon: 'live', variant: 'accent' }],
    canvasTitle: '节目输出', intent: '驱动现场回放、待命镜头，并将视锥画面实时录制到磁盘。',
  });

  /* ---------- Tools page: 缓存集群管理（已并入） + 诊断工具 ---------- */
  const DIAG = [
    { id: 'diag_net',  label: '网络探针',   icon: 'net',      intent: '探测集群子网拓扑、丢包率与可用带宽。' },
    { id: 'diag_sync', label: '同步分析',   icon: 'bolt',     intent: '分析 genlock / PTP 锁相的抖动与漂移。' },
    { id: 'diag_thm',  label: '热成像图',   icon: 'thermo',   intent: '汇总各渲染节点的 GPU 温度与功耗热点。' },
    { id: 'diag_term', label: '脚本控制台', icon: 'terminal', intent: '对选定节点批量执行远程诊断脚本。' },
  ];
  const isCacheSeg = (nav) => window.VOLO_CACHE.isCacheNav(nav);
  const curDiag = (nav) => DIAG.find((d) => d.id === nav) || DIAG[0];
  const diagActions = () => h('div', { className: 'ctx-actions' },
    h(Button, { variant: 'secondary', size: 'S', isDisabled: true, icon: h(Icon, { name: 'play', size: 15 }) }, '运行'),
    h(Button, { variant: 'accent', size: 'S', isDisabled: true, icon: h(Icon, { name: 'download', size: 15 }) }, '导出'));

  /* top-level categories — shown in the context bar */
  const CATS = [
    { id: 'cache', label: '缓存', icon: 'cache' },
    { id: 'keyer', label: '键控', icon: 'key' },
    { id: 'diag',  label: '诊断', icon: 'tools' },
  ];
  const isKeyerSeg = (nav) => nav === 'keyer_lab' || nav === 'keyer_bench';
  const catOf = (nav) => isCacheSeg(nav) ? 'cache' : (isKeyerSeg(nav) ? 'keyer' : 'diag');
  const FIRST = { cache: 'home', keyer: 'keyer_lab', diag: 'diag_net' };

  function toolsCtx(s) {
    /* top mode: context bar carries only the two top-level categories */
    if (s.toolsNav === 'top') {
      const cat = catOf(s.cacheNav);
      const Tab = (c) => h('div', {
        key: c.id, className: 'ctxnav-i' + (cat === c.id ? ' on' : ''),
        title: cat === c.id ? (s.leftCollapsed ? '展开左侧导航' : '收起左侧导航') : undefined,
        onClick: () => {
          if (catOf(s.cacheNav) !== c.id) { s.setCacheNav(FIRST[c.id]); s.setLeftCollapsed(false); }
          else { s.setLeftCollapsed((v) => !v); }
        },
      },
        h('span', { className: 'ctxnav-ico' }, h(Icon, { name: c.icon, size: 16 })),
        h('span', null, c.label),
        cat === c.id ? h('span', { className: 'ctxnav-caret', style: { transform: s.leftCollapsed ? 'none' : 'rotate(180deg)' } }, h(Icon, { name: 'chevr', size: 12 })) : null);
      return h(React.Fragment, null,
        h('div', { className: 'ctxnav' }, CATS.map(Tab)),
        cat === 'cache' ? window.VOLO_CACHE.actions(s) : diagActions());
    }
    /* left mode: per-section context title + actions */
    if (isCacheSeg(s.cacheNav)) return window.VOLO_CACHE.ctx(s);
    if (isKeyerSeg(s.cacheNav)) return window.VOLO_KEYER.ctx(s);
    const t = curDiag(s.cacheNav);
    return h(React.Fragment, null,
      h(CtxTitle, { icon: t.icon, title: t.label, sub: '工具 · 诊断' }),
      h('div', { className: 'ctx-div' }),
      h('span', { className: 'toolchip' }, h(Icon, { name: 'tools', size: 14 }), '诊断工具 · 待建设'),
      diagActions());
  }

  /* diagnostic sub-list (left column) */
  function diagSection(s) {
    const diagNav = (d) => h('div', {
      key: d.id, className: 'nav-i' + (s.cacheNav === d.id ? ' on' : ''), onClick: () => s.setCacheNav(d.id),
    },
      h('span', { className: 'nav-ico' }, h(Icon, { name: d.icon, size: 16 })),
      h('span', null, d.label),
      h('span', { className: 'ct' }, 'WIP'));
    return h('div', { className: 'sect' },
      h('div', { className: 'sect-h' }, h('span', { className: 't' }, '诊断工具')),
      DIAG.map(diagNav));
  }

  function toolsLeft(s) {
    /* top mode: left column lists the sub-items of the selected category */
    if (s.toolsNav === 'top') {
      const cat = catOf(s.cacheNav);
      if (cat === 'keyer') return window.VOLO_KEYER.left(s);
      return cat === 'cache' ? window.VOLO_CACHE.left(s) : diagSection(s);
    }
    /* left mode: cache dual-layer nav + keyer + diagnostics list stacked */
    return h(React.Fragment, null,
      window.VOLO_CACHE.left(s),
      window.VOLO_KEYER.left(s),
      diagSection(s));
  }

  function diagCenter(t) {
    return h(React.Fragment, null,
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, t.label),
        h('div', { className: 'right' },
          h('div', { className: 'seg' },
            h('button', { className: 'on' }, h(Icon, { name: 'eye', size: 14 })),
            h('button', null, h(Icon, { name: 'settings', size: 14 }))))),
      h('div', { className: 'canvas-stage skl-stage' },
        h('div', { className: 'skl-grid' }),
        h('div', { className: 'skl-ph' },
          h('div', { className: 'skl-ico' }, h(Icon, { name: t.icon, size: 40, stroke: 1.3 })),
          h('div', { className: 'skl-title' }, t.label),
          h('div', { className: 'skl-intent' }, t.intent),
          h('div', { style: { marginTop: 18, maxWidth: 420 } },
            h(InlineAlert, { variant: 'informative', title: '诊断工具' },
              t.label + ' 工作区尚未建设。渲染缓存集群管理已并入本页「缓存」类别。')))));
  }

  function toolsCenter(s) {
    if (isKeyerSeg(s.cacheNav)) return window.VOLO_KEYER.center(s);
    return isCacheSeg(s.cacheNav) ? window.VOLO_CACHE.center(s) : diagCenter(curDiag(s.cacheNav));
  }

  function toolsInspector(s) {
    if (isCacheSeg(s.cacheNav)) return window.VOLO_CACHE.inspector(s);
    if (isKeyerSeg(s.cacheNav)) return window.VOLO_KEYER.inspector(s);
    const t = curDiag(s.cacheNav);
    return h('div', { className: 'insp-empty' },
      h('div', { className: 'ph' }, h(Icon, { name: t.icon, size: 30 })),
      h('div', null,
        h('div', { style: { color: 'var(--chrome-dim)', fontWeight: 600, marginBottom: 4 } }, 'Inspector'),
        '选中对象的详情显示在此'));
  }

  window.VOLO_PAGES.tools = {
    ctx: toolsCtx, left: toolsLeft, center: toolsCenter, inspector: toolsInspector,
    drawer: (s) => window.VOLO_CACHE.drawer(s),
  };
})();

export {};
