// @ts-nocheck
/* Volo — 网格校正 · 页面装配（gridPages.tsx）
   覆盖 window.VOLO_PAGES.calibrate；屏幕设计 / 测试图 / 上屏部署 / 重建 / 校正共用同一三维
   Center（切换 section 不卸载），仅右侧检查器不同。 */
import * as React from "react";

(function () {
  const h = React.createElement;
  const G = window.VOLO_GRID;
  const CX = window.VOLO_CAL2;

  /* 扁平页面导航（无层级）—— 与 handoff grid_pages.jsx NAV 1:1。
     测试图不是独立导航项：经场景树/选择器 setCalSel({type:'pattern'}) 进入检查器。 */
  const NAV = [
    { id: 'overview', label: '概览', icon: 'grid' },
    { id: 'screen',   label: '屏幕设计', icon: 'panel' },
    { id: 'deploy',   label: '上屏部署', icon: 'external' },
    { id: 'rebuild',  label: '重建', icon: 'cube3' },
    { id: 'lens',     label: '校正', icon: 'camera' },
  ];
  function go(s, id) {
    s.setCalSection(id);
    s.setCalFlow(null);
    s.setCalDraftScreen(null);
    s.setLeftCollapsed(false);
    if (id !== 'lens') {
      if (s.setLensFlow) s.setLensFlow(null);
      if (s.setCapDetail) s.setCapDetail(null);
      if (s.setCapState) s.setCapState('idle');
    }
    if (id === 'overview') { s.setCalSel(null); }
    else if (id === 'deploy') { s.setCalSel({ type: 'screen' }); s.setLeftCollapsed(false); }
    else if (id === 'rebuild' || id === 'screen') { s.setCalSel({ type: 'screen' }); s.setLeftCollapsed(false); }
    else { s.setCalSel(null); s.setLeftCollapsed(false); }
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

  /* ---------- ctx 工具栏 ----------
     镜头校正 / 屏幕设计 / 测试图 / 上屏部署 仅保留 StageSeg。 */
  function ctx(s) {
    const seg = h(StageSeg, { s });
    if (s.calStageType === 'ar') return h('div', { className: 'gw-tb' }, seg, h('div', { className: 'gw-tb-group is-fill' }));
    if (s.calSection === 'overview') return h('div', { className: 'gw-tb' }, seg);
    if (s.calSection === 'deploy' || s.calSection === 'lens' || s.calSection === 'screen')
      return h('div', { className: 'gw-tb' }, seg);
    /* 重建页：追踪源 + 采集设置（与 handoff ctx 一致） */
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
    /* 重建页左栏保持扁平导航，仅当测量导入流程进行中（calFlow 非空）才切到流程面板。 */
    if (s.calSection === 'rebuild' && s.calFlow) return G.left(s);
    return h(NavList, { s });
  }

  /* ---------- center ----------
     概览以外全部复用 G.Center：切换 screen/pattern/deploy/rebuild/lens 时三维主视图不卸载。 */
  function center(s) {
    /* CalController 挂载于此（不随 calSection 切换卸载）：首次自动打开最近项目 + 刷新 runs。 */
    const controller = h(CX.CalController, { s });
    if (s.calStageType === 'ar') return h(React.Fragment, null, controller, window.VOLO_CAL_AR.center(s));
    if (s.calSection === 'overview') return h(React.Fragment, null, controller, h(G.Overview, { s }));
    return h(React.Fragment, null, controller, h(G.Center, { s }));
  }

  /* ---------- inspector ----------
     CX.useLensLive() 同理无条件调用：calSection 在 lens⇄其它 之间切换不改变 hook 次序。 */
  function inspector(s) {
    const arWs = window.VOLO_CAL_AR.useArWorkspace();
    const lensLive = CX.useLensLive();
    if (s.calStageType === 'ar') return window.VOLO_CAL_AR.inspector(s, arWs);
    if (s.calSection === 'deploy') return (window.VOLO_DEPLOY && window.VOLO_DEPLOY.deployInspector) ? window.VOLO_DEPLOY.deployInspector(s) : null;
    if (s.calSection === 'lens') return (window.VOLO_CALFLOW && window.VOLO_CALFLOW.lensInspector) ? window.VOLO_CALFLOW.lensInspector(s) : CX.lensPageInspector(s, lensLive);
    if (s.calSection === 'overview') return CX.inspEmpty ? CX.inspEmpty('概览页无检查器') : null;
    if (s.calSection === 'screen') return G.screenInspector ? G.screenInspector(s) : G.inspector(s);
    /* pattern 经 calSel.type，由 G.inspector 分发（非独立 section） */
    return G.inspector(s);
  }

  window.VOLO_PAGES = window.VOLO_PAGES || {};
  window.VOLO_PAGES.calibrate = { ctx, left, center, inspector };
})();
