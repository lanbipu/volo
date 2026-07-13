// @ts-nocheck
/* Volo — 网格校正 · 概览页（gridOverview.tsx）
   1:1 port of the Claude Design handoff `src/grid_overview.jsx`。
   空态（打开/新建项目 + 最近项目列表）+ 已打开态（项目状态表，单击行切换并进入工作区）。
   数据源沿用 pages/calOverview.tsx 已验证的「真实 list_recent_projects + 逐项目
   load_project_yaml/list_runs 聚合」手法（useProjectSummaries），无新 mock；镜头状态
   同样没有持久化信号，如实标「未跟踪」，不编造。 */
import * as React from "react";
import { loadProjectYaml, listRuns, removeRecentProject } from "../api/meshCommands";

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect, useMemo, useRef } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2;

  function timeAgo(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '';
    const diff = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
    return diff < 1 ? '刚刚' : diff < 60 ? diff + ' 分钟前' : diff < 1440 ? Math.round(diff / 60) + ' 小时前' : Math.round(diff / 1440) + ' 天前';
  }

  /* 逐项目 load_project_yaml + 逐屏幕 list_runs 聚合出「最近一次重建」；没有专门的
     「多项目状态汇总」后端命令，同 calOverview.tsx 的既定手法。 */
  function useProjectSummaries(recent) {
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(false);
    useEffect(() => {
      let cancelled = false;
      if (!recent || !recent.length) { setRows([]); return undefined; }
      setLoading(true);
      Promise.all(recent.map(async (r) => {
        try {
          const config = await loadProjectYaml(r.abs_path);
          const screenIds = Object.keys(config.screens);
          let best = null;
          for (const sid of screenIds) {
            const runs = await listRuns(r.abs_path, sid);
            if (runs.length && (!best || runs[0].created_at > best.run.created_at)) best = { screenId: sid, run: runs[0] };
          }
          const gridStatus = best ? (best.run.output_obj_path ? 'exported' : 'rebuilt') : 'none';
          return {
            id: r.id, name: (config.project && config.project.name) || r.display_name, path: r.abs_path,
            screenCount: screenIds.length, screenId: best ? best.screenId : (screenIds[0] || null), last_opened_at: r.last_opened_at,
            gridStatus, rms: best ? best.run.estimated_rms_mm : null, vertices: best ? best.run.vertex_count : null,
            done: gridStatus === 'rebuilt' || gridStatus === 'exported',
          };
        } catch (e) {
          return { id: r.id, name: r.display_name, path: r.abs_path, screenCount: 0, screenId: null, last_opened_at: r.last_opened_at, gridStatus: 'none', rms: null, vertices: null, done: false, loadError: true };
        }
      })).then((next) => { if (!cancelled) { setRows(next); setLoading(false); } });
      return () => { cancelled = true; };
    }, [recent]);
    return { rows, loading };
  }

  function gridStatePill(status) {
    const map = {
      none: { label: '未重建', tone: 'neutral', icon: 'minus' },
      measured: { label: '未重建', tone: 'neutral', icon: 'minus' },
      rebuilt: { label: '已重建', tone: 'positive', icon: 'cube' },
      exported: { label: '已导出', tone: 'positive', icon: 'check' },
    };
    const m = map[status] || map.none;
    return h('span', { className: 'spill spill--' + m.tone }, m.icon === 'minus' ? h('span', { style: { fontWeight: 700 } }, '—') : h(Icon, { name: m.icon, size: 12 }), m.label);
  }

  /* ---------- 「切换项目」下拉（已打开态页头，Claude Design grid_overview Drop/ProjDrop） ---------- */
  function Drop({ btn, children, width }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => { if (!open) return undefined; const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener('mousedown', fn); return () => document.removeEventListener('mousedown', fn); }, [open]);
    return h('div', { ref, style: { position: 'relative' } },
      h('button', { className: 'gw-projbtn', onClick: () => setOpen((v) => !v) }, btn, h(Icon, { name: 'chevd', size: 14 })),
      open ? h('div', { className: 'popover', style: { left: 0, top: 'calc(100% + 6px)', minWidth: width || 300 } }, children(() => setOpen(false))) : null);
  }
  function ProjDrop({ s, proj, close }) {
    const recent = proj.recent || [];
    const switchTo = (r) => {
      close();
      if (r.abs_path === proj.path) return;
      CX.openProjectPath(r.abs_path, s)
        .then(() => s.pushLog({ lv: 'ok', cat: 'project', msg: '切换项目 <b>' + r.display_name + '</b>' }))
        .catch((e) => CX.projStore.patch({ error: e && e.message ? e.message : String(e) }));
    };
    return h('div', null,
      h('div', { className: 'cpp-h' }, '最近项目'),
      recent.length ? recent.map((r) => h('div', { key: r.id, className: 'pop-i' + (r.abs_path === proj.path ? ' on' : ''), onClick: () => switchTo(r) },
        h('div', { style: { display: 'flex', flexDirection: 'column', lineHeight: 1.4, minWidth: 0 } },
          h('span', { className: 'pop-l' }, r.display_name), h('span', { className: 'pop-s' }, r.abs_path)),
        r.abs_path === proj.path ? h('span', { style: { marginLeft: 'auto', color: 'var(--volo-500)', display: 'flex' } }, h(Icon, { name: 'check', size: 15 })) : null))
        : h('div', { className: 'pop-i', style: { opacity: .6 } }, h('span', { className: 'pop-l' }, '暂无最近项目')));
  }

  function enterWorkspace(s, absPath) {
    const go = () => {
      s.setCalSection('rebuild');
      s.setLeftCollapsed(false);
      s.setCalDraftScreen(null);
      const proj = CX.projStore.get();
      const firstScreen = proj.config ? Object.keys(proj.config.screens)[0] : null;
      if (firstScreen) s.setCalActiveScreen(firstScreen);
      s.setCalSel({ type: 'screen' });
      s.pushLog({ lv: 'info', cat: 'calibrate', msg: '进入网格重建工作区' });
    };
    if (absPath && absPath !== CX.projStore.get().path) {
      CX.openProjectPath(absPath, s).then(go).catch((e) => CX.projStore.patch({ error: e && e.message ? e.message : String(e) }));
    } else go();
  }

  /* ---------- 空态 ---------- */
  function Empty({ s, proj }) {
    const recentTop5 = useMemo(() => (proj.recent || []).slice(0, 5), [proj.recent]);
    const { rows } = useProjectSummaries(recentTop5);
    return h('div', { className: 'dash' },
      h('div', { className: 'cluster-empty' },
        h('div', { className: 'ce-ico' }, h(Icon, { name: 'grid', size: 36, stroke: 1.3 })),
        h('div', { className: 'ce-t' }, proj.error ? '加载项目失败' : '网格校正'),
        h('div', { className: 'ce-d' }, proj.error || '先在软件里建立 LED 屏的理想三维模型，再采集真实数据重建实测网格。打开或新建一个项目开始。'),
        h('div', { className: 'ce-acts' },
          h(Button, { variant: 'accent', size: 'L', icon: h(Icon, { name: 'folder', size: 16 }), onPress: () => CX.pickAndOpenProject(s) }, '打开项目'),
          h(Button, { variant: 'secondary', size: 'L', icon: h(Icon, { name: 'plus', size: 16 }), onPress: () => CX.pickAndSeedExample(s, 'curved-flat') }, '新建项目')),
        h('div', { className: 'ce-recent' },
          h('div', { className: 'ce-recent-h' }, h(Icon, { name: 'folder', size: 13 }), '最近的项目'),
          !proj.recent || !proj.recent.length
            ? h('div', { style: { fontSize: 12.5, color: 'var(--chrome-faint)', padding: '18px 0' } }, '暂无最近项目 · 打开或新建一个项目即可开始')
            : h('div', { className: 'ce-recent-list' }, rows.map((p) => h('div', { key: p.id, className: 'ce-recent-i', onClick: () => enterWorkspace(s, p.path) },
                h('span', { className: 'ce-recent-ico' + (p.done ? ' done' : '') }, h(Icon, { name: p.done ? 'check' : 'folder', size: 16 })),
                h('div', { className: 'ce-recent-main' },
                  h('div', { className: 'ce-recent-name' }, p.name),
                  h('div', { className: 'ce-recent-path' }, p.path + (p.screenId ? ' · ' + p.screenId : '') + (p.done ? ' · 已重建 RMS ' + (p.rms == null ? 'n/a' : p.rms.toFixed(2) + ' mm') : ' · 进行中'))),
                h('span', { className: 'ce-recent-meta' }, timeAgo(p.last_opened_at)),
                h('button', { className: 'gw-tinline', style: { marginLeft: 8 }, title: '从最近列表移除（不删除磁盘文件）', onClick: (e) => {
                  e.stopPropagation();
                  removeRecentProject(p.id)
                    .then(() => CX.projStore.patch({ recent: (CX.projStore.get().recent || []).filter((r) => r.id !== p.id) }))
                    .catch((err) => s.pushLog({ lv: 'err', cat: 'project', msg: '移除最近项目失败 · ' + (err && err.message ? err.message : err) }));
                } }, h(Icon, { name: 'x', size: 12 }), '移除')))))));
  }

  /* ---------- 已打开态 ---------- */
  function Opened({ s, proj }) {
    const { rows, loading } = useProjectSummaries(proj.recent);
    const name = (proj.config && proj.config.project && proj.config.project.name) || (proj.recent.find((r) => r.abs_path === proj.path) || {}).display_name || proj.path;
    return h('div', { className: 'dash' },
      h('div', { className: 'cal2-projhdr' },
        h('div', { className: 'cal2-projhdr-l' },
          h('span', { className: 'cal2-projhdr-ic' }, h(Icon, { name: 'folder', size: 18 })),
          h('div', null,
            h('div', { className: 'cal2-projhdr-t' }, name),
            h('div', { className: 'cal2-projhdr-s' }, proj.path))),
        h('div', { className: 'cal2-projhdr-acts', style: { alignItems: 'center' } },
          h(Drop, { btn: h('span', { className: 'col' }, h('span', { className: 'k' }, '切换项目'), h('span', { className: 'v' }, name)), children: (close) => h(ProjDrop, { s, proj, close }) }),
          h(Button, { variant: 'secondary', size: 'M', onPress: () => { CX.closeProject(); s.pushLog({ lv: 'info', cat: 'project', msg: '关闭项目' }); } }, '关闭项目'),
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'arrowr', size: 15 }), onPress: () => enterWorkspace(s, proj.path) }, '进入工作区'))),
      h('div', { className: 'dash-card' },
        h('div', { className: 'dc-h' }, h('span', { className: 't' }, h(Icon, { name: 'list', size: 14 }), '项目'), h('span', { className: 'dc-n' }, (loading ? '加载中…' : rows.length + ' 个'))),
        h('div', { className: 'cal2-ovtable' },
          h('div', { className: 'cal2-ov-head' }, h('span', null, '项目'), h('span', null, '屏幕数'), h('span', null, '网格状态'), h('span', null, '镜头'), h('span', null, '最近活动')),
          rows.map((p) => h('div', { key: p.id, className: 'cal2-ov-row' + (p.path === proj.path ? ' active' : ''), style: { cursor: 'pointer' }, onClick: () => enterWorkspace(s, p.path) },
            h('span', { className: 'cal2-ov-n' }, h('span', { className: 'sdot bg-' + (p.path === proj.path ? 'positive' : 'neutral') }), h('b', null, p.name), p.path === proj.path ? h('span', { className: 'cal2-cur' }, '当前') : null),
            h('span', { className: 'mono' }, p.screenCount || '—'),
            h('span', null, gridStatePill(p.gridStatus)),
            h('span', null, CX.statusPill(CAL_LENS_STATUS, 'unknown')),
            h('span', { className: 'cal2-ov-step' }, h(Icon, { name: 'arrowr', size: 12 }), p.done ? '已重建 · ' + timeAgo(p.last_opened_at) : (p.gridStatus === 'measured' ? '已导入测量 · 待重建' : '进行中') + ' · ' + timeAgo(p.last_opened_at)))))),
        h('div', { style: { fontSize: 11.5, color: 'var(--chrome-faint)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 } },
          h(Icon, { name: 'info', size: 13 }), '单击任意行即切换到该项目并进入工作区'));
  }

  function Overview({ s }) {
    const proj = CX.useProj();
    if (proj.loading) return h('div', { className: 'dash' }, h('div', { style: { padding: 20, fontSize: 12, color: 'var(--chrome-faint)' } }, '加载中…'));
    return proj.path ? h(Opened, { s, proj }) : h(Empty, { s, proj });
  }

  window.VOLO_GRID = Object.assign(window.VOLO_GRID || {}, { Overview, enterWorkspace });
})();
