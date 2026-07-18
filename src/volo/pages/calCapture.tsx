// @ts-nocheck
/* Volo — 校正 · 采集设置模态（从 ctx 栏「采集设置」打开）
   1:1 port of the Claude Design handoff `src/cal2_capture.jsx`.
   命名采集配置（Profile）列表 · 新建 / 编辑表单 · 空态。

   这是本批唯一替换的文件：旧 pages/calCapture.tsx 是接真 vpcal 的实时采集会话页
   （A1 配置 / A2 采集中 / A3 完成，真 spawnSidecarStreaming + player 窗口），新 IA
   的左栏已不再有「实时采集」步骤，ctx 栏「采集设置」按钮打开的是这里 —— 一个纯粹
   的命名配置（Profile）管理模态，本身不发起任何采集。

   Profile 瘦身：poses/settleMs/burst/inverted/graycodeSync/patternsDir/lensPath 这组
   「采集参数」已下沉到实时采集窗口（localStorage 持久化，grid/lens 入口共享，与
   Profile 身份解耦）；Profile 保留 名称 + 视频源 + 可选 focalMm / hfovDeg
   （快拍参考画幅）+ 输出目录，即信号源身份本身。

   持久化：Profile 由 Rust 写入 app data；localStorage 仅作为同步 cache，供现有同步式
   Lens 页面在同一 WebView 内立即读取。首次使用不预置假数据。 */
import * as React from "react";
import { pickDirectory } from "../api/commands";
import { listCaptureProfiles, saveCaptureProfiles } from "../api/captureProfiles";

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const { useEffect, useRef, useState } = React;
  const h = React.createElement;

  const LS_KEY = 'volo-cal-capture-profiles';
  function loadProfiles() {
    try { const v = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function saveProfiles(list) { try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch (e) {} }

  const VIDEO_BACKENDS = [
    { id: 'uvc', label: 'UVC 摄像头' },
    { id: 'ndi', label: 'NDI' },
    { id: 'decklink', label: 'DeckLink SDI' },
    { id: 'synthetic', label: '合成测试源' },
  ];
  const backendLabel = (id) => (VIDEO_BACKENDS.find((b) => b.id === id) || {}).label || id;
  const blankForm = () => ({ name: '', videoBackend: 'uvc', device: '0', trackProtocol: 'freed', trackPort: 6301,
    trackHost: '0.0.0.0', trackCameraId: null,
    fmtMode: 'auto', width: '', height: '', fps: '', transferFunction: 'sdr',
    /* 镜头标称：焦距 + 水平视场角；hfov 留空则快拍引导层隐藏 */
    focalMm: '',
    hfovDeg: '',
    outputRoot: '' });

  function CaptureModal({ s, close }) {
    const [profiles, setProfiles] = useState(() => loadProfiles());
    const [mode, setMode] = useState('loading'); /* loading | list | new | empty */
    const [form, setForm] = useState(blankForm);
    const [editId, setEditId] = useState(null);
    const [saving, setSaving] = useState(false);
    const savingRef = useRef(false);

    useEffect(() => { listCaptureProfiles().then(async (state) => {
      const legacy = loadProfiles();
      const next = !state.initialized && legacy.length ? legacy : state.profiles;
      if (!state.initialized) await saveCaptureProfiles(next);
      setProfiles(next); saveProfiles(next); setMode(next.length ? 'list' : 'empty');
    })
      .catch((e) => { const fallback = loadProfiles(); setProfiles(fallback); setMode(fallback.length ? 'list' : 'empty'); s.pushLog({ lv: 'err', cat: 'capture', msg: `读取采集配置失败 · ${e.message || e}` }); }); }, []);
    const commit = async (next) => {
      if (savingRef.current) return false;
      const previous = profiles;
      savingRef.current = true; setSaving(true); setProfiles(next); saveProfiles(next);
      try { await saveCaptureProfiles(next); return true; }
      catch (e) { setProfiles(previous); saveProfiles(previous); s.pushLog({ lv: 'err', cat: 'capture', msg: `保存采集配置失败 · ${e.message || e}` }); return false; }
      finally { savingRef.current = false; setSaving(false); }
    };
    const startNew = () => { setForm(blankForm()); setEditId(null); setMode('new'); };
    const startEdit = (p) => { setForm(Object.assign(blankForm(), p)); setEditId(p.id); setMode('new'); };
    const dup = async (p) => { const c = Object.assign({}, p, { id: 'pf_' + Math.random().toString(36).slice(2), name: p.name + ' 副本', lastUsed: '刚刚' });
      if (await commit(profiles.concat([c]))) s.pushLog({ lv: 'ok', cat: 'capture', msg: `复制采集配置 <b>${c.name}</b>` }); };
    const del = async (p) => { const nx = profiles.filter((x) => x.id !== p.id); if (await commit(nx)) { if (!nx.length) setMode('empty');
      s.pushLog({ lv: 'warn', cat: 'capture', msg: `删除采集配置 <b>${p.name}</b>` }); } };
    const save = async () => {
      const nm = form.name.trim() || '未命名配置';
      const next = editId
        ? profiles.map((x) => x.id === editId ? Object.assign({}, form, { id: editId, name: nm, lastUsed: '刚刚' }) : x)
        : profiles.concat([Object.assign({}, form, { id: 'pf_' + Math.random().toString(36).slice(2), name: nm, lastUsed: '刚刚' })]);
      if (!await commit(next)) return;
      s.pushLog({ lv: 'ok', cat: 'capture', msg: `${editId ? '保存' : '新建'}采集配置 <b>${nm}</b>` });
      setMode('list');
    };

    /* ---------- header ---------- */
    const head = h('div', { className: 'drawer-h' },
      h('span', { className: 'di info' }, h(Icon, { name: 'camera', size: 17 })),
      h('div', { style: { minWidth: 0 } },
        h('h2', null, '采集设置'),
        h('div', { className: 'sub' }, h('span', { className: 'cli-pill' }, 'capture profiles'),
          h('span', null, mode === 'new' ? (editId ? ' · 编辑配置' : ' · 新建配置') : ' · 命名采集配置'))),
      h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 })));

    if (mode === 'loading') return h('div', { className: 'drawer drawer--cal2cap' }, head,
      h('div', { className: 'drawer-b' }, h('div', { className: 'cal2-cap-empty' }, h('div', { className: 'ce-t' }, '正在读取采集配置…'))));

    /* ---------- 空态 ---------- */
    if (mode === 'empty') {
      return h('div', { className: 'drawer drawer--cal2cap' }, head,
        h('div', { className: 'drawer-b' },
          h('div', { className: 'cal2-cap-empty' },
            h('div', { className: 'ce-ico' }, h(Icon, { name: 'camera', size: 32, stroke: 1.3 })),
            h('div', { className: 'ce-t', style: { fontSize: 16 } }, '还没有采集配置'),
            h('div', { className: 'ce-d' }, '采集配置（Profile）保存视频源与输出位置，方便现场一键复用。姿位、settle、inverted 等采集参数已下沉到实时采集窗口。先建一个吧。'))),
        h('div', { className: 'drawer-f' },
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'plus', size: 15 }), onPress: startNew }, '新建第一个采集配置')));
    }

    /* ---------- 列表态 ---------- */
    if (mode === 'list') {
      return h('div', { className: 'drawer drawer--cal2cap' }, head,
        h('div', { className: 'drawer-b' },
          h('div', { className: 'cal2-pf-list' }, profiles.map((p) => h('div', { key: p.id, className: 'cal2-pf-row' },
            h('span', { className: 'cal2-pf-ic' }, h(Icon, { name: p.videoBackend === 'synthetic' ? 'grid' : 'camera', size: 15 })),
            h('div', { className: 'cal2-pf-meta' },
              h('div', { className: 'cal2-pf-n' }, p.name),
              h('div', { className: 'cal2-pf-sum' },
                h('span', { className: 'cal2-pf-tag' }, backendLabel(p.videoBackend) + ' / ' + p.device),
                h('span', { className: 'cal2-pf-tag' }, p.trackProtocol + ':' + p.trackPort),
                h('span', { className: 'cal2-pf-time' }, '最近 ' + p.lastUsed))),
            h('div', { className: 'cal2-pf-acts' },
              h('button', { className: 'iconbtn', title: '编辑', disabled: saving, onClick: () => startEdit(p) }, h(Icon, { name: 'sliders', size: 15 })),
              h('button', { className: 'iconbtn', title: '复制', disabled: saving, onClick: () => dup(p) }, h(Icon, { name: 'copy', size: 15 })),
              h('button', { className: 'iconbtn', title: '删除', disabled: saving, onClick: () => del(p) }, h(Icon, { name: 'trash', size: 15 }))))))),
        h('div', { className: 'drawer-f between' },
          h('span', { className: 'cal2-pf-count' }, profiles.length + ' 个配置'),
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'plus', size: 15 }), isDisabled: saving, onPress: startNew }, '新建配置')));
    }

    /* ---------- 新建 / 编辑表单 ---------- */
    const set = (k, v) => setForm((f) => Object.assign({}, f, { [k]: v }));

    const body = h('div', { className: 'drawer-b' },
      h('div', { className: 'cal2-cap-name' },
        h('span', { className: 'cap-lbl' }, '配置名'),
        h('input', { className: 'cap-tf', value: form.name, placeholder: '如：现场 · UVC 主机位', autoFocus: true, onChange: (e) => set('name', e.target.value) })),
      h(window.VoloVideoSource.VideoSourceCard, { form, set }),
      /* 追踪源已移至独立「追踪源信号接入」模块；采集参数已下沉到实时采集单窗口。 */
      h('div', { className: 'cap-card' },
        h('div', { className: 'cap-card-h' }, h(Icon, { name: 'sliders', size: 15 }), '镜头标称',
          h('span', { className: 'capw-opt', style: { marginLeft: 'auto' } }, '可选 · 快拍引导')),
        h('div', { className: 'cap-lens' },
          h('label', null, '焦距（mm）'),
          h('input', {
            className: 'cap-tf', type: 'number', min: 1, max: 400, step: '0.1',
            value: form.focalMm, placeholder: '如 35 · 仅展示，会话内请保持不变',
            onChange: (e) => set('focalMm', e.target.value),
          }),
          h('label', { style: { marginTop: 10 } }, '水平视场角 hfov（度）'),
          h('input', {
            className: 'cap-tf', type: 'number', min: 1, max: 180, step: '0.1',
            value: form.hfovDeg, placeholder: '如 54.4 · 留空则不用参考画幅引导',
            onChange: (e) => set('hfovDeg', e.target.value),
          }),
          h('div', { className: 'cap-tg-s', style: { marginTop: 6 } },
            '会话内请保持焦距不变。重建自标定假设全部视图共享同一内参；规划参考画幅需要 hfov。'))),
      h('div', { className: 'cap-card' },
        h('div', { className: 'cap-card-h' }, h(Icon, { name: 'folder', size: 15 }), '输出'),
        h('div', { className: 'cap-lens' },
          h('label', null, 'outputRoot（可空）'),
          h('div', { className: 'cap-lens-pick' },
            h('button', { className: 'cap-file-btn', onClick: async () => { if (form.outputRoot) set('outputRoot', ''); else { const p = await pickDirectory(); if (p) set('outputRoot', p); } } },
              h(Icon, { name: 'folder', size: 14 }), form.outputRoot || '选择目录…（留空则用默认）')))));

    return h('div', { className: 'drawer drawer--cal2cap' }, head, body,
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', isDisabled: saving, onPress: () => setMode(profiles.length ? 'list' : 'empty') }, '取消'),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), isDisabled: saving, onPress: save }, saving ? '正在保存…' : (editId ? '保存修改' : '保存配置'))));
  }

  function openCaptureModal(s) {
    s.setModal({ xwide: true, render: ({ s: st, close }) => h(CaptureModal, { s: st, close }) });
  }

  window.VOLO_CAL2 = Object.assign(window.VOLO_CAL2 || {}, { openCaptureModal, CaptureModal, loadProfiles });
})();
