// @ts-nocheck
/* Volo — 网格校正 · 页面装配（gridPages.tsx）
   1:1 port of the Claude Design handoff `src/grid_pages.jsx`（含随之核对的死代码剔除：
   原型里的 StageActions/ProjSwitch/ScreenSel/ResultsBtn/ViewControls/DisplayMenu 几个
   组件定义了但从未被 ctx/left/center/inspector 实际调用——「阶段动作从顶栏移入检查器」
   本就是这次改动说明原文，工具栏因此保持精简，不搬这些死代码）。
   覆盖 window.VOLO_PAGES.calibrate，在 index.tsx 里排在 calibrate.tsx 之后加载，
   借其 window.VOLO_CAL2 共享基础设施（projStore / rebuildMesh / …）；lens/AR 分支
   委托现状不变（calLens.tsx / calAr*.tsx，本次改动范围之外）。 */
import * as React from "react";

(function () {
  const { useState, useRef, useEffect } = React;
  const h = React.createElement;
  const G = window.VOLO_GRID;
  const CX = window.VOLO_CAL2;

  const NAV = [
    { id: 'overview', label: '概览', icon: 'grid' },
    { id: 'rebuild', label: '重建', icon: 'cube3' },
    { id: 'lens', label: '校正', icon: 'camera' },
  ];
  function go(s, id) {
    s.setCalSection(id);
    s.setCalFlow(null);
    s.setCalDraftScreen(null);
    s.setLeftCollapsed(false);
    if (id === 'overview') s.setCalSel(null);
    else if (id === 'rebuild') s.setCalSel({ type: 'screen' });
    else s.setCalSel(null);
  }
  function NavList({ s }) {
    const sec = s.calSection;
    return h('div', { className: 'gw-nav' },
      h('div', { className: 'sect' },
        h('div', { className: 'sect-h' }, h('span', { className: 't' }, 'LED · 网格校正')),
        NAV.map((n) => h('div', { key: n.id, className: 'nav-i nav-mod' + (sec === n.id ? ' on' : ''), onClick: () => go(s, n.id) },
          h('span', { className: 'nav-ico' }, h(Icon, { name: n.icon, size: 17 })),
          h('span', { className: 'nav-lbl' }, n.label)))));
  }

  /* LED / AR 段控 */
  function StageSeg({ s }) {
    const ar = s.calStageType === 'ar';
    const tabs = [{ id: 'led', label: 'LED', icon: 'panel' }, { id: 'ar', label: 'AR', icon: 'cube' }];
    return h('div', { className: 'ctxnav cal2-stageseg', style: { flex: '0 0 auto' } },
      tabs.map((c) => {
        const on = (ar ? 'ar' : 'led') === c.id;
        return h('div', { key: c.id, className: 'ctxnav-i' + (on ? ' on' : ''),
          onClick: () => { if (!on) { s.setCalStageType(c.id); s.setLeftCollapsed(false); } } },
          h('span', { className: 'ctxnav-ico' }, h(Icon, { name: c.icon, size: 16 })),
          h('span', null, c.label),
          c.id === 'ar' ? h('span', { className: 'cal2-stageseg-wip' }, 'WIP') : null);
      }));
  }

  /* ---------- ctx 工具栏 ---------- */
  function ctx(s) {
    const seg = h(StageSeg, { s });
    if (s.calStageType === 'ar') return h('div', { className: 'gw-tb' }, seg, h('div', { className: 'gw-tb-group is-fill' }));
    if (s.calSection === 'overview') return h('div', { className: 'gw-tb' }, seg);
    if (s.calSection === 'lens') return h('div', { className: 'gw-tb' }, seg, h('div', { className: 'gw-tb-div' }),
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--chrome-text)' } },
        h(Icon, { name: 'camera', size: 15, style: { color: 'var(--volo-500)' } }), '镜头校正'));
    return h('div', { className: 'gw-tb' },
      seg,
      h('div', { className: 'gw-tb-group is-fill' }),
      h('button', { className: 'gw-icbtn', title: '追踪源信号接入…', onClick: () => CX.openTrackingModal(s) }, h(Icon, { name: 'net', size: 16 })),
      h('button', { className: 'gw-icbtn', title: '采集设置 · 管理采集配置…', onClick: () => CX.openCaptureModal(s) }, h(Icon, { name: 'camera', size: 16 })));
  }

  /* ---------- 左栏 ----------
     window.VOLO_CAL_AR.useArWorkspace() 必须在任何分支判断之前无条件调用一次
     （同 pages/calibrate.tsx 旧版的既定手法）：left/center/inspector 是 shell.tsx
     Slot 里稳定挂载的同一个 fiber，若只在 calStageType==='ar' 时才调用这个 hook，
     LED⇄AR 来回切换会改变同一 fiber 的 hook 调用次序，违反 Rules of Hooks。 */
  function left(s) {
    const arWs = window.VOLO_CAL_AR.useArWorkspace();
    const proj = CX.useProj();
    if (s.calStageType === 'ar') return window.VOLO_CAL_AR.left(s, arWs);
    if (!proj.path) return null;
    if (s.calSection === 'rebuild') return G.left(s);
    return h(NavList, { s });
  }

  /* ---------- center ---------- */
  function LensPage({ s }) {
    useEffect(() => { s.setLeftCollapsed(false); }, []);
    return CX.Lens ? h(CX.Lens, { s }) : h('div', { className: 'insp-empty' }, '镜头校正');
  }
  function center(s) {
    /* CalController 挂载于此（不随 calSection 切换卸载/重挂）：首次自动打开最近
       项目 + 项目/屏幕变化时刷新 runs 列表与多屏视口摘要。同旧 pages/calibrate.tsx
       的既定挂载点，只是路由从这里的 center() 接管。 */
    const controller = h(CX.CalController, { s });
    if (s.calStageType === 'ar') return h(React.Fragment, null, controller, window.VOLO_CAL_AR.center(s));
    if (s.calSection === 'overview') return h(React.Fragment, null, controller, h(G.Overview, { s }));
    if (s.calSection === 'lens') return h(React.Fragment, null, controller, h(LensPage, { s }));
    return h(React.Fragment, null, controller, h(G.Center, { s }));
  }

  /* ---------- inspector ----------
     CX.useLensLive() 同理无条件调用：calSection 在 lens⇄其它 之间切换不改变这个
     Slot fiber 的 hook 调用次序。 */
  function inspector(s) {
    const arWs = window.VOLO_CAL_AR.useArWorkspace();
    const lensLive = CX.useLensLive();
    if (s.calStageType === 'ar') return window.VOLO_CAL_AR.inspector(s, arWs);
    if (s.calSection === 'lens') return CX.lensInspector ? CX.lensInspector(s, lensLive) : (CX.inspEmpty ? CX.inspEmpty('镜头校正细节在页内查看') : null);
    if (s.calSection === 'overview') return CX.inspEmpty ? CX.inspEmpty('概览页无检查器') : null;
    return G.inspector(s);
  }

  window.VOLO_PAGES = window.VOLO_PAGES || {};
  window.VOLO_PAGES.calibrate = { ctx, left, center, inspector };
})();
