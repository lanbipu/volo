// @ts-nocheck
/* Volo — Stage 级 nDisplay 输出拓扑对话框（gridNdisplay.tsx）
   1:1 移植 Claude Design handoff `grid_ndisplay.jsx` 的拓扑对话框：复合像素画布、
   节点 crop/window/Primary、校验与「每屏一节点」。持久化写入 project.output_topology。 */
import * as React from "react";
import { loadProjectYaml, saveProjectYaml } from "../api/meshCommands";
import { listMachines } from "../api/commands";

(function () {
  const { Button, Switch } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect, useRef } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2;
  const NCOLORS = ['#2f6fed', '#e0762a', '#12a67a', '#a24bd8', '#d8462f', '#0f9bd8'];
  const ncolor = (i) => NCOLORS[i % NCOLORS.length];

  function NumField({ label, value, onChange, min }) {
    return h('label', { className: 'nd-numf' }, h('span', { className: 'k' }, label),
      h('input', { className: 'nd-num', type: 'number', value: value, min: min != null ? min : 0,
        onChange: (e) => onChange(e.target.value === '' ? 0 : parseInt(e.target.value, 10) || 0) }));
  }

  function MachineSelect({ value, onChange, machines }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
      if (!open) return undefined;
      const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
      document.addEventListener('mousedown', fn);
      return () => document.removeEventListener('mousedown', fn);
    }, [open]);
    const cur = machines.find((m) =>
      (value.hostname && (m.hostname || '').toLowerCase() === value.hostname.toLowerCase()) ||
      (value.ip && (m.ip || '') === value.ip));
    const label = value.hostname || value.ip || '选择机器…';
    const dot = (st) => h('span', { className: 'nd-onl nd-onl--' + (st === 'offline' ? 'off' : st === 'healthy' || st === 'online' ? 'on' : 'warn') });
    return h('div', { ref, className: 'nd-msel' },
      h('button', { className: 'nd-msel-btn', type: 'button', onClick: () => setOpen((v) => !v) },
        cur ? dot(cur.status) : null,
        h('span', { className: 'nd-msel-lbl' }, cur ? (cur.hostname || cur.ip) : label),
        cur && cur.ip ? h('span', { className: 'nd-msel-ip' }, cur.ip) : null,
        h(Icon, { name: 'chevd', size: 13 })),
      open ? h('div', { className: 'popover nd-msel-pop' },
        machines.length === 0
          ? h('div', { className: 'nd-msel-empty' }, h(Icon, { name: 'alert', size: 14 }), '暂无纳管机器，请去「工具 · 缓存」扫描添加')
          : machines.map((m) => h('div', { key: m.id || m.hostname || m.ip, className: 'pop-i' + ((cur && cur.id === m.id) ? ' on' : ''),
              onClick: () => { onChange({ hostname: m.hostname || '', ip: m.ip || '' }); setOpen(false); } },
              dot(m.status),
              h('div', { style: { display: 'flex', flexDirection: 'column', lineHeight: 1.25, minWidth: 0 } },
                h('span', { className: 'pop-l' }, m.hostname || m.ip),
                h('span', { className: 'pop-s' }, (m.ip || '') + (m.status ? ' · ' + m.status : '')))))
      ) : null);
  }

  function validateStageTopo(nodes, comp) {
    const cw = comp.canvas.w, ch = comp.canvas.h;
    const errs = [], warns = [];
    const nodeFlags = {};
    const masters = nodes.filter((n) => n.primary);
    if (masters.length === 0) errs.push({ msg: '缺少 Primary 节点 —— 必须恰好指定一个。' });
    else if (masters.length > 1) errs.push({ msg: 'Primary 节点不唯一 —— 当前有 ' + masters.length + ' 个，需恰好一个。' });
    const ids = new Set();
    nodes.forEach((n) => {
      const f = { err: false, warn: false, msgs: [] };
      const [x, y, w, height] = n.viewport_rect_px;
      if (!n.node_id || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(n.node_id)) {
        f.err = true; f.msgs.push('节点 ID 非法'); errs.push({ nodeId: n.node_id, msg: (n.node_id || '（空）') + '：ID 只能包含字母、数字、_、-' });
      }
      if (ids.has(n.node_id)) { f.err = true; f.msgs.push('ID 重复'); errs.push({ nodeId: n.node_id, msg: '节点 ID 重复：' + n.node_id }); }
      ids.add(n.node_id);
      if (!(n.machine && (n.machine.hostname || n.machine.ip))) {
        f.err = true; f.msgs.push('未选择机器'); errs.push({ nodeId: n.node_id, msg: n.node_id + '：未选择机器。' });
      }
      if (w <= 0 || height <= 0) { f.err = true; f.msgs.push('裁切尺寸'); errs.push({ nodeId: n.node_id, msg: n.node_id + '：裁切宽高必须大于 0。' }); }
      else if (x < 0 || y < 0 || x + w > cw || y + height > ch) {
        f.err = true; f.msgs.push('裁切越界'); errs.push({ nodeId: n.node_id, msg: n.node_id + '：裁切矩形越出复合画布边界。' });
      }
      if (n.window_px[0] !== w || n.window_px[1] !== height) {
        f.err = true; f.msgs.push('窗口与裁切不等');
        errs.push({ nodeId: n.node_id, msg: n.node_id + '：输出窗口（' + n.window_px[0] + '×' + n.window_px[1] + '）与裁切尺寸（' + w + '×' + height + '）需像素 1:1 相等。' });
      }
      nodeFlags[n.node_id] = f;
    });
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i].viewport_rect_px, b = nodes[j].viewport_rect_px;
      const ov = a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
      if (ov) {
        nodeFlags[nodes[i].node_id].err = true; nodeFlags[nodes[j].node_id].err = true;
        errs.push({ nodeId: nodes[i].node_id, msg: nodes[i].node_id + ' 与 ' + nodes[j].node_id + ' 的裁切矩形重叠。' });
      }
    }
    const area = nodes.reduce((s, n) => s + Math.max(0, n.viewport_rect_px[2]) * Math.max(0, n.viewport_rect_px[3]), 0);
    if (area < (comp.area || cw * ch)) warns.push({ msg: '复合画布未被完整覆盖 —— 部分屏幕像素区域没有节点驱动。' });
    return { errs, warns, nodeFlags };
  }

  function TopologyDialog({ s, close }) {
    const proj = CX.useProj();
    const screens = (proj.config && proj.config.screens) || {};
    const screenCount = Object.keys(screens).length;
    const comp = window.buildStageComposite(screens);
    const cw = comp.canvas.w, ch = comp.canvas.h;
    const existing = window.resolveProjectTopology(proj.config);
    const [nodes, setNodes] = useState(() => {
      const seed = existing && existing.nodes && existing.nodes.length
        ? JSON.parse(JSON.stringify(existing.nodes))
        : window.buildStageNdisplayTopo(screens).nodes;
      return seed.map((n) => Object.assign({}, n, {
        fullscreen: false,
        window_origin_px: n.window_origin_px || [40, 40],
        window_px: n.window_px || [n.viewport_rect_px[2], n.viewport_rect_px[3]],
      }));
    });
    const [machines, setMachines] = useState([]);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState('');
    useEffect(() => { listMachines().then(setMachines).catch(() => setMachines([])); }, []);
    const { errs, warns, nodeFlags } = validateStageTopo(nodes, comp);
    const setNode = (index, patch) => setNodes((list) => list.map((n, i) => i === index ? Object.assign({}, n, patch) : n));
    const setPrimary = (index) => setNodes((list) => list.map((n, i) => Object.assign({}, n, { primary: i === index })));
    const del = (index) => setNodes((list) => list.filter((_, i) => i !== index));
    const add = () => setNodes((list) => {
      const i = list.length;
      const w = Math.min(cw, Math.round(cw / (i + 1)));
      return list.concat([{
        node_id: 'Node' + Date.now(),
        machine: { hostname: '', ip: '' },
        viewport_rect_px: [0, 0, w, ch],
        window_px: [w, ch],
        window_origin_px: [40, 40],
        fullscreen: false,
        primary: list.length === 0,
      }]);
    });
    const perScreen = () => setNodes((list) => {
      const fresh = window.buildStageNdisplayTopo(screens).nodes;
      return fresh.map((n, i) => {
        const prev = list[i];
        return Object.assign({}, n, {
          node_id: (prev && prev.node_id) || n.node_id,
          machine: (prev && prev.machine) || n.machine,
          window_origin_px: (prev && prev.window_origin_px) || n.window_origin_px || [40, 40],
          fullscreen: false,
        });
      });
    });
    const save = async () => {
      if (errs.length || saving || !proj.path) return;
      setSaving(true); setSaveError('');
      try {
        const latest = await loadProjectYaml(proj.path);
        const windowed = nodes.map((n) => Object.assign({}, n, { fullscreen: false }));
        /* 清掉各屏遗留拓扑，统一落到 Stage 级 project.output_topology */
        const nextScreens = {};
        Object.keys(latest.screens || {}).forEach((id) => {
          const sc = Object.assign({}, latest.screens[id]);
          delete sc.output_topology;
          nextScreens[id] = sc;
        });
        const next = Object.assign({}, latest, {
          screens: nextScreens,
          output_topology: Object.assign(
            {},
            latest.output_topology || {},
            { nodes: windowed },
          ),
        });
        await saveProjectYaml(proj.path, next);
        await CX.openProjectPath(proj.path, s);
        s.setCalReceipt({ tone: 'ok', text: '已保存 Stage 输出拓扑 · ' + nodes.length + ' 节点' });
        s.pushLog && s.pushLog({ lv: 'ok', cat: 'ndisplay', msg: '保存 Stage 输出拓扑 · <b>' + nodes.length + '</b> 个节点 · 复合画布 ' + cw + '×' + ch + ' · ' + screenCount + ' 屏' });
        close();
      } catch (e) { setSaveError(e && e.message ? e.message : String(e)); }
      finally { setSaving(false); }
    };

    const PW = 460;
    const scale = PW / Math.max(1, cw);
    const managedEmpty = machines.length === 0;

    return h('div', { className: 'drawer drawer--ndtopo' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: 'net', size: 17 })),
        h('div', { style: { minWidth: 0, flex: 1 } }, h('h2', null, 'nDisplay 输出拓扑 · Stage 级'),
          h('div', { className: 'sub' }, screenCount + ' 块屏 · 复合像素画布 ' + cw + ' × ' + ch)),
        h('button', { className: 'iconbtn x', style: { width: 26, height: 26 }, onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'nd-topo-body' },
        h('div', { className: 'nd-canvas-col' },
          h('div', { className: 'nd-canvas-h' }, h(Icon, { name: 'grid', size: 14 }), '复合画布 · 屏幕排布 + 节点裁切'),
          h('div', { className: 'nd-canvas-wrap' },
            h('div', { className: 'nd-canvas', style: { width: PW, height: Math.max(40, ch * scale) } },
              comp.screens.map((r, i) => h('div', { key: r.id, className: 'nd-screen' + (i % 2 ? ' alt' : ''),
                style: { left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale } },
                h('span', { className: 'nd-screen-lb' }, r.id),
                h('span', { className: 'nd-screen-res' }, r.w + '×' + r.h))),
              nodes.map((n, i) => {
                const f = nodeFlags[n.node_id] || {};
                const [x, y, w, height] = n.viewport_rect_px;
                const oob = x < 0 || y < 0 || x + w > cw || y + height > ch;
                const dw = Math.max(6, w * scale), dh = Math.max(6, height * scale);
                return h('div', { key: n.node_id + i, className: 'nd-vp' + (f.err ? ' is-err' : f.warn ? ' is-warn' : ''),
                  style: { left: x * scale, top: y * scale, width: dw, height: dh,
                    background: 'color-mix(in srgb,' + ncolor(i) + ' 22%, transparent)',
                    borderColor: f.err ? 'var(--negative-visual)' : f.warn ? 'var(--notice-visual)' : ncolor(i) } },
                  h('span', { className: 'nd-vp-tag', style: { background: ncolor(i) } }, n.primary ? '★ ' : '', n.node_id),
                  h('span', { className: 'nd-vp-res' }, w + '×' + height),
                  oob ? h('span', { className: 'nd-vp-flag' }, h(Icon, { name: 'alert', size: 12 })) : null);
              }))),
          h('div', { className: 'nd-canvas-legend' },
            h('span', null, h('i', { className: 'lg lg--screen' }), '屏幕边界'),
            h('span', null, h('i', { className: 'lg lg--err' }), '错误：越界 / 重叠 / 窗口≠裁切'),
            h('span', null, h('i', { className: 'lg lg--warn' }), '警告：未完整覆盖'))),
        h('div', { className: 'nd-nodes-col' },
          h('div', { className: 'nd-nodes-h' }, h('span', null, '渲染节点 ', h('b', null, nodes.length)),
            h('span', { className: 'nd-nodes-hint' }, 'Primary 单选 · 恰好一个')),
          managedEmpty ? h('div', { className: 'nd-empty-guide' }, h(Icon, { name: 'alert', size: 15 }),
            h('div', null, h('b', null, '暂无纳管机器'), h('div', { className: 'd' }, '机器列表来自「工具 · 缓存」板块，请先扫描并添加渲染机器。'),
              h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'search', size: 13 }), onPress: () => { close(); s.setPage('tools'); s.setCacheNav && s.setCacheNav('home'); } }, '前往缓存扫描'))) : null,
          h('div', { className: 'nd-nodes-list' }, nodes.map((n, index) => {
            const f = nodeFlags[n.node_id] || {};
            const [cx, cy, cw0, ch0] = n.viewport_rect_px;
            const [ox, oy] = n.window_origin_px || [40, 40];
            return h('div', { key: n.node_id + index, className: 'nd-node-row' + (f.err ? ' is-err' : f.warn ? ' is-warn' : '') },
              h('div', { className: 'nd-node-top' },
                h('span', { className: 'nd-mk' }, '节点 ID'),
                h('input', { className: 'nd-name', value: n.node_id, onChange: (e) => setNode(index, { node_id: e.target.value }) }),
                h('button', { className: 'nd-node-del', title: '删除节点', onClick: () => del(index) }, h(Icon, { name: 'trash', size: 14 }))),
              h('div', { className: 'nd-node-mrow' }, h('span', { className: 'nd-mk' }, '机器'),
                h(MachineSelect, { value: n.machine || { hostname: '', ip: '' }, machines, onChange: (machine) => setNode(index, { machine }) })),
              h('div', { className: 'nd-sub' }, '裁切区域 · 复合画布坐标'),
              h('div', { className: 'nd-grid4' },
                h(NumField, { label: 'Crop X', value: cx, onChange: (v) => setNode(index, { viewport_rect_px: [v, cy, cw0, ch0] }) }),
                h(NumField, { label: 'Crop Y', value: cy, onChange: (v) => setNode(index, { viewport_rect_px: [cx, v, cw0, ch0] }) }),
                h(NumField, { label: 'Crop 宽', value: cw0, min: 1, onChange: (v) => setNode(index, { viewport_rect_px: [cx, cy, v, ch0] }) }),
                h(NumField, { label: 'Crop 高', value: ch0, min: 1, onChange: (v) => setNode(index, { viewport_rect_px: [cx, cy, cw0, v] }) })),
              h('div', { className: 'nd-node-out' },
                h('span', { className: 'nd-mk' }, '窗口尺寸'),
                h('input', { className: 'nd-num nd-num--wide', type: 'number', value: n.window_px[0], onChange: (e) => setNode(index, { window_px: [parseInt(e.target.value, 10) || 0, n.window_px[1]] }) }),
                h('span', { className: 'nd-x' }, '×'),
                h('input', { className: 'nd-num nd-num--wide', type: 'number', value: n.window_px[1], onChange: (e) => setNode(index, { window_px: [n.window_px[0], parseInt(e.target.value, 10) || 0] }) }),
                h('button', { className: 'nd-mini', title: '窗口尺寸对齐裁切（1:1）', onClick: () => setNode(index, { window_px: [cw0, ch0] }) }, h(Icon, { name: 'link', size: 12 }), '=裁切')),
              h('div', { className: 'nd-node-out' },
                h('span', { className: 'nd-mk' }, '窗口位置'),
                h('input', { className: 'nd-num nd-num--wide', type: 'number', value: ox, onChange: (e) => setNode(index, { window_origin_px: [parseInt(e.target.value, 10) || 0, oy] }) }),
                h('span', { className: 'nd-x' }, ','),
                h('input', { className: 'nd-num nd-num--wide', type: 'number', value: oy, onChange: (e) => setNode(index, { window_origin_px: [ox, parseInt(e.target.value, 10) || 0] }) }),
                h('span', { className: 'nd-mk', style: { marginLeft: 2, fontWeight: 500 } }, '节点机虚拟桌面')),
              h('div', { className: 'nd-node-tog' },
                h('label', { className: 'nd-tg is-off', title: '一期仅窗口模式输出，全屏暂不开放' },
                  h(Switch, { isSelected: false, isDisabled: true }), '全屏', h('span', { className: 'nd-wip' }, '一期禁用')),
                h('button', { className: 'nd-master' + (n.primary ? ' on' : ''), onClick: () => setPrimary(index) },
                  h('span', { className: 'nd-radio' + (n.primary ? ' on' : '') }), 'Primary'),
                f.err ? h('span', { className: 'spill spill--negative' }, h(Icon, { name: 'alert', size: 12 }), f.msgs[0])
                  : f.warn ? h('span', { className: 'spill spill--notice' }, h(Icon, { name: 'alert', size: 12 }), f.msgs[0]) : null));
          })),
          h('div', { className: 'nd-nodes-foot' },
            h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'plus', size: 13 }), onPress: add }, '添加节点'),
            h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'panel', size: 13 }), onPress: perScreen }, '每屏一节点')))),
      h('div', { className: 'nd-topo-foot' },
        h('div', { className: 'nd-valid' },
          errs.length ? h('div', { className: 'nd-valid-grp nd-valid-grp--err' },
            h('div', { className: 'nd-valid-h' }, h(Icon, { name: 'alert', size: 13 }), errs.length + ' 项错误 · 阻止保存'),
            errs.slice(0, 4).map((e, i) => h('div', { key: i, className: 'nd-valid-line' }, e.msg))) : null,
          warns.length ? h('div', { className: 'nd-valid-grp nd-valid-grp--warn' },
            h('div', { className: 'nd-valid-h' }, h(Icon, { name: 'alert', size: 13 }), warns.length + ' 项警告 · 不阻止保存'),
            warns.slice(0, 3).map((e, i) => h('div', { key: i, className: 'nd-valid-line' }, e.msg))) : null,
          (!errs.length && !warns.length) ? h('div', { className: 'nd-valid-grp nd-valid-grp--ok' }, h(Icon, { name: 'check', size: 13 }), '校验通过 · 复合画布完全覆盖，窗口与裁切 1:1') : null,
          saveError ? h('div', { className: 'nd-valid-grp nd-valid-grp--err' }, h('div', { className: 'nd-valid-line' }, saveError)) : null),
        h('div', { className: 'nd-topo-actions' },
          h(Button, { variant: 'secondary', size: 'M', onPress: close }, '取消'),
          h(Button, { variant: 'accent', size: 'M', isDisabled: errs.length > 0 || saving, icon: h(Icon, { name: 'check', size: 15 }), onPress: save }, saving ? '保存中…' : '保存拓扑'))));
  }

  window.VOLO_NDISPLAY = {
    TopologyDialog,
    validateStageTopo,
    openTopology: (s, close) => h(TopologyDialog, { s, close }),
  };
})();
