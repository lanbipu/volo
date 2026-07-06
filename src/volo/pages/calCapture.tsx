// @ts-nocheck
/* Volo — 校正 · 采集设置模态（从 ctx 栏「采集设置」打开）
   1:1 port of the Claude Design handoff `src/cal2_capture.jsx`.
   命名采集配置（Profile）列表 · 新建 / 编辑表单 · 空态。

   这是本批唯一替换的文件：旧 pages/calCapture.tsx 是接真 vpcal 的实时采集会话页
   （A1 配置 / A2 采集中 / A3 完成，真 spawnSidecarStreaming + player 窗口），新 IA
   的左栏已不再有「实时采集」步骤，ctx 栏「采集设置」按钮打开的是这里 —— 一个纯粹
   的命名配置（Profile）管理模态，本身不发起任何采集。

   持久化：设计稿的 Profile 列表是纯 React state（刷新页面就清空，连设计稿自己都
   没接任何保存动作）。真实 app 里让「保存」按钮完全没有持久效果会显得功能是坏的，
   所以这里用 localStorage 落盘（与 shell.tsx 里 leftW/rightW 等轻量 UI 状态同类做法）；
   没有为一个尚无消费方的功能新建 sqlite 表 —— 等未来批次真正接上「用某个 Profile
   启动采集」的流程时，再按那时的真实需要决定是否升级到后端持久化。
   首次使用默认空列表（不预置假示例数据），如实展示「还没有采集配置」空态。 */
import * as React from "react";

(function () {
  const { Button, Switch } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState } = React;
  const h = React.createElement;

  const LS_KEY = 'volo-cal-capture-profiles';
  function loadProfiles() {
    try { const v = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function saveProfiles(list) { try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch (e) {} }

  const VIDEO_BACKENDS = [
    { id: 'uvc', label: 'UVC 摄像头', avail: true, note: '即插即用' },
    { id: 'ndi', label: 'NDI', avail: false, note: '需 NDI SDK' },
    { id: 'decklink', label: 'DeckLink SDI', avail: false, note: '需 DeckLink SDK' },
    { id: 'synthetic', label: '合成测试源', avail: true, note: '内置图案，无需硬件' },
  ];
  const backendLabel = (id) => (VIDEO_BACKENDS.find((b) => b.id === id) || {}).label || id;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const blankForm = () => ({ name: '', videoBackend: 'uvc', device: '设备0', trackProtocol: 'freed', trackPort: 6301,
    poses: 8, settleMs: 300, burst: 5, inverted: true, graycodeSync: true, lensPath: '', outputRoot: '' });

  function CaptureModal({ s, close }) {
    const [profiles, setProfiles] = useState(() => loadProfiles());
    const [mode, setMode] = useState(() => (loadProfiles().length ? 'list' : 'empty')); /* list | new | empty */
    const [form, setForm] = useState(blankForm);
    const [advOpen, setAdvOpen] = useState(false);
    const [editId, setEditId] = useState(null);

    const commit = (next) => { setProfiles(next); saveProfiles(next); };
    const startNew = () => { setForm(blankForm()); setEditId(null); setAdvOpen(false); setMode('new'); };
    const startEdit = (p) => { setForm(Object.assign(blankForm(), p)); setEditId(p.id); setAdvOpen(true); setMode('new'); };
    const dup = (p) => { const c = Object.assign({}, p, { id: 'pf_' + Math.random().toString(36).slice(2), name: p.name + ' 副本', lastUsed: '刚刚' });
      commit(profiles.concat([c])); s.pushLog({ lv: 'ok', cat: 'capture', msg: `复制采集配置 <b>${c.name}</b>` }); };
    const del = (p) => { const nx = profiles.filter((x) => x.id !== p.id); commit(nx); if (!nx.length) setMode('empty');
      s.pushLog({ lv: 'warn', cat: 'capture', msg: `删除采集配置 <b>${p.name}</b>` }); };
    const save = () => {
      const nm = form.name.trim() || '未命名配置';
      if (editId) { commit(profiles.map((x) => x.id === editId ? Object.assign({}, form, { id: editId, name: nm, lastUsed: '刚刚' }) : x)); s.pushLog({ lv: 'ok', cat: 'capture', msg: `保存采集配置 <b>${nm}</b>` }); }
      else { commit(profiles.concat([Object.assign({}, form, { id: 'pf_' + Math.random().toString(36).slice(2), name: nm, lastUsed: '刚刚' })])); s.pushLog({ lv: 'ok', cat: 'capture', msg: `新建采集配置 <b>${nm}</b>` }); }
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

    /* ---------- 空态 ---------- */
    if (mode === 'empty') {
      return h('div', { className: 'drawer drawer--cal2cap' }, head,
        h('div', { className: 'drawer-b' },
          h('div', { className: 'cal2-cap-empty' },
            h('div', { className: 'ce-ico' }, h(Icon, { name: 'camera', size: 32, stroke: 1.3 })),
            h('div', { className: 'ce-t', style: { fontSize: 16 } }, '还没有采集配置'),
            h('div', { className: 'ce-d' }, '采集配置（Profile）保存视频源、追踪源与采集参数，方便现场一键复用。先建一个吧。'))),
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
              h('button', { className: 'iconbtn', title: '编辑', onClick: () => startEdit(p) }, h(Icon, { name: 'sliders', size: 15 })),
              h('button', { className: 'iconbtn', title: '复制', onClick: () => dup(p) }, h(Icon, { name: 'copy', size: 15 })),
              h('button', { className: 'iconbtn', title: '删除', onClick: () => del(p) }, h(Icon, { name: 'trash', size: 15 }))))))),
        h('div', { className: 'drawer-f between' },
          h('span', { className: 'cal2-pf-count' }, profiles.length + ' 个配置'),
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'plus', size: 15 }), onPress: startNew }, '新建配置')));
    }

    /* ---------- 新建 / 编辑表单 ---------- */
    const set = (k, v) => setForm((f) => Object.assign({}, f, { [k]: v }));
    const NumField = (label, key, unit, min, max) => h('div', { className: 'cap-num' },
      h('label', null, label),
      h('div', { className: 'cap-num-in' },
        h('input', { type: 'number', value: form[key], min, max, onChange: (e) => set(key, e.target.value) }),
        unit ? h('span', { className: 'u' }, unit) : null));

    const body = h('div', { className: 'drawer-b' },
      h('div', { className: 'cal2-cap-name' },
        h('span', { className: 'cap-lbl' }, '配置名'),
        h('input', { className: 'cap-tf', value: form.name, placeholder: '如：现场 · UVC 主机位', autoFocus: true, onChange: (e) => set('name', e.target.value) })),
      h('div', { className: 'cap-card' },
        h('div', { className: 'cap-card-h' }, h(Icon, { name: 'camera', size: 15 }), '视频源'),
        h('div', { className: 'cap-backend-list' }, VIDEO_BACKENDS.map((b) => h('div', {
          key: b.id, className: 'cap-be' + (b.avail ? '' : ' off') + (b.id === form.videoBackend ? ' on' : ''),
          onClick: () => b.avail && set('videoBackend', b.id) },
          h('span', { className: 'sdot bg-' + (b.avail ? (b.id === form.videoBackend ? 'positive' : 'neutral') : 'neutral') }),
          b.label, b.avail ? null : h('span', { className: 'cap-be-x' }, '需 SDK')))),
        h('div', { className: 'cap-field', style: { marginTop: 10 } },
          h('span', { className: 'cap-lbl' }, 'device'),
          h('input', { className: 'cap-tf', value: form.device, onChange: (e) => set('device', e.target.value) }))),
      h('div', { className: 'cap-card' },
        h('div', { className: 'cap-card-h' }, h(Icon, { name: 'net', size: 15 }), '追踪源'),
        h('div', { className: 'cap-field' },
          h('span', { className: 'cap-lbl' }, 'protocol'),
          h('div', { className: 'cap-seg' }, [['freed', 'FreeD'], ['opentrackio', 'OpenTrackIO']].map(([k, l]) =>
            h('button', { key: k, className: form.trackProtocol === k ? 'on' : '', onClick: () => set('trackProtocol', k) }, l)))),
        h('div', { className: 'cap-field' },
          h('span', { className: 'cap-lbl' }, 'trackPort'),
          h('input', { className: 'cap-tf', type: 'number', value: form.trackPort, onChange: (e) => set('trackPort', e.target.value) }))),
      h('div', { className: 'cap-card' },
        h('button', { className: 'cap-adv-h', style: { width: '100%' }, onClick: () => setAdvOpen((v) => !v) },
          h(Icon, { name: 'chevr', size: 13, style: { transform: advOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' } }),
          '采集参数', h('span', { className: 'cap-adv-tag' }, 'poses / settle / burst / inverted / graycode / lens')),
        advOpen ? h('div', { style: { marginTop: 13 } },
          h('div', { className: 'cap-param-grid' },
            h('div', { className: 'cap-num' },
              h('label', null, 'poses（3–24）'),
              h('div', { className: 'cap-stepper' },
                h('button', { onClick: () => set('poses', clamp(+form.poses - 1, 3, 24)) }, '−'),
                h('span', null, form.poses),
                h('button', { onClick: () => set('poses', clamp(+form.poses + 1, 3, 24)) }, '+'))),
            NumField('settleMs', 'settleMs', 'ms', 100, 2000),
            NumField('burst', 'burst', '帧', 1, 12)),
          h('div', { className: 'cal2-toggles' },
            h('div', { className: 'cap-toggle-row' },
              h('div', null, h('div', { className: 'cap-tg-t' }, 'inverted'), h('div', { className: 'cap-tg-s' }, '正/反图案各拍一帧做差分')),
              h(Switch, { isSelected: !!form.inverted, onChange: (v) => set('inverted', v) })),
            h('div', { className: 'cap-toggle-row' },
              h('div', null, h('div', { className: 'cap-tg-t' }, 'graycodeSync'), h('div', { className: 'cap-tg-s' }, '用 Gray code 确认图案序号')),
              h(Switch, { isSelected: !!form.graycodeSync, onChange: (v) => set('graycodeSync', v) }))),
          h('div', { className: 'cap-lens', style: { marginTop: 12 } },
            h('label', null, 'lensPath'),
            h('div', { className: 'cap-lens-pick' },
              h('button', { className: 'cap-file-btn', onClick: () => set('lensPath', form.lensPath ? '' : 'lens_master_35mm.json') },
                h(Icon, { name: 'folder', size: 14 }), form.lensPath || '选择文件…'),
              form.lensPath ? h('span', { className: 'cap-pill cap-pill--positive' }, h(Icon, { name: 'check', size: 12 }), '已选') : null))) : null),
      h('div', { className: 'cap-card' },
        h('div', { className: 'cap-card-h' }, h(Icon, { name: 'folder', size: 15 }), '输出'),
        h('div', { className: 'cap-lens' },
          h('label', null, 'outputRoot（可空）'),
          h('div', { className: 'cap-lens-pick' },
            h('button', { className: 'cap-file-btn', onClick: () => set('outputRoot', form.outputRoot ? '' : 'D:\\Volo\\sessions') },
              h(Icon, { name: 'folder', size: 14 }), form.outputRoot || '选择目录…（留空则用默认）')))));

    return h('div', { className: 'drawer drawer--cal2cap' }, head, body,
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', onPress: () => setMode(profiles.length ? 'list' : 'empty') }, '取消'),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), onPress: save }, editId ? '保存修改' : '保存配置')));
  }

  function openCaptureModal(s) {
    s.setModal({ xwide: true, render: ({ s: st, close }) => h(CaptureModal, { s: st, close }) });
  }

  window.VOLO_CAL2 = Object.assign(window.VOLO_CAL2 || {}, { openCaptureModal, CaptureModal });
})();
