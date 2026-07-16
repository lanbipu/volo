// @ts-nocheck
import { listNetInterfaces } from "../api/lensCommands";
import { spawnSidecarStreaming, useSidecarStream } from "../api/sidecarStream";
/* Volo — 追踪源卡片（重设计）+ 独立「追踪源信号接入」二级界面
   采集设置 → Profile 追踪源模块。与「视频源」卡片对偶：
   选协议 → 定端口/绑定 → 监听验证数据（监听测试区 ↔ 信号预览区）。
   字段以真实后端为准：protocol(freed|opentrackio) / port(UDP) / host(绑定地址,默认0.0.0.0)
   / trackCameraId(FreeD 专属过滤,新增)。实时读出值：position(mm) / pan·tilt·roll(度)
   / zoom_raw·focus_raw(FreeD 24-bit 原始编码器计数)。不引入这些之外的配置项。 */
(function () {
  const { useState, useRef, useEffect } = React;
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const h = React.createElement;

  /* 协议 + 其数据完备性声明 */
  const PROTOCOLS = [
    { id: 'freed',       label: 'FreeD',       sub: '位姿 + 镜头编码器', icon: 'net',  caps: ['pos', 'rot', 'zoom', 'focus'] },
    { id: 'opentrackio', label: 'OpenTrackIO', sub: '位姿 · 镜头可选',   icon: 'live', caps: ['pos', 'rot'] /* 本样本缺镜头 */ },
  ];
  const CAP_LABEL = { pos: '位置', rot: '旋转', zoom: 'Zoom', focus: 'Focus' };

  /* 接收状态 · 三通道 */
  const RECV = {
    normal: { tone: 'positive', icon: 'check', text: '数据正常' },
    nodata: { tone: 'neutral',  icon: 'sync',  text: '监听中，暂无数据' },
    fail:   { tone: 'negative', icon: 'alert', text: '解码失败' },
    frozen: { tone: 'notice',   icon: 'alert', text: '数值冻结' },
  };

  function RecvPill({ st }) {
    const m = RECV[st];
    return h('span', { className: 'cap-pill cap-pill--' + m.tone },
      st === 'nodata'
        ? h('span', { className: 'vs-icbtn spin', style: { width: 12, height: 12, border: 0, background: 'none' } }, h(Icon, { name: 'sync', size: 12 }))
        : h(Icon, { name: m.icon, size: 12 }),
      m.text);
  }

  /* ============================================================
     追踪源卡片主组件  props: form, set
     ============================================================ */
  function TrackingSourceCard({ form, set, onVerified }) {
    const protocol = form.trackProtocol || 'freed';
    const proto = PROTOCOLS.find((p) => p.id === protocol) || PROTOCOLS[0];

    const [listening, setListening] = useState(false);
    const [advOpen, setAdvOpen] = useState(false);
    const [sig, setSig] = useState('nodata');
    const [taskId, setTaskId] = useState(null);
    const [probeError, setProbeError] = useState(null);
    const [bindAddrs, setBindAddrs] = useState([{ id: '0.0.0.0', label: '0.0.0.0 · 全部网卡' }]);
    const [manualBind, setManualBind] = useState(false);
    const stream = useSidecarStream(taskId);

    const monitors = stream.state.lines.map((l) => l.parsed).filter((p) => p && p.type === 'monitor');
    const latest = monitors[monitors.length - 1] || null;
    const pose = (latest && latest.pose) || {};
    const pos = pose.position || pose.translation || [0, 0, 0];
    const rot = (pose.rotation && pose.rotation.values) || pose.rotation || pose.euler_deg || [0, 0, 0];
    const vals = { x: Number(pos[0] || 0), y: Number(pos[1] || 0), z: Number(pos[2] || 0),
      pan: Number(rot[0] || 0), tilt: Number(rot[1] || 0), roll: Number(rot[2] || 0),
      zoom: pose.zoom_raw ?? latest?.zoom_raw ?? null, focus: pose.focus_raw ?? latest?.focus_raw ?? null };
    const tick = latest ? latest.total : 0;
    const live = !!latest;
    const dataPresent = listening && !!latest;

    useEffect(() => {
      listNetInterfaces().then((rows) => setBindAddrs([{ id: '0.0.0.0', label: '0.0.0.0 · 全部网卡' }].concat(
        (rows || []).map((r) => ({ id: r.ipv4, label: r.ipv4 + ' · ' + r.name }))
      ))).catch(() => {});
    }, []);

    useEffect(() => {
      if (!listening) return;
      if (latest) { setSig('normal'); onVerified && onVerified(true); }
      else setSig('nodata');
    }, [latest && latest.total, listening]);

    useEffect(() => {
      const exit = stream.state.exit;
      if (!exit || exit.cancelled) return;
      if (exit.fatal) { setSig('fail'); setProbeError(exit.stderr_tail || ('exit ' + exit.exit_code)); onVerified && onVerified(false); }
      setListening(false); setTaskId(null);
    }, [stream.state.exit]);
    useEffect(() => () => { if (taskId) void stream.cancel(); }, [taskId]);

    const startProbe = async () => {
      setListening(true); setSig('nodata'); setProbeError(null);
      try {
        const r = await spawnSidecarStreaming('vpcal', ['capture', 'track', '--monitor', '--protocol', protocol,
          '--host', form.trackHost || '0.0.0.0', '--port', String(form.trackPort), '--output', 'ndjson']);
        setTaskId(r.task_id);
      } catch (e) { setSig('fail'); onVerified && onVerified(false); setProbeError(e && e.message ? e.message : String(e)); }
    };
    const stopProbe = async () => {
      await stream.cancel(); setTaskId(null); setListening(false); setSig('nodata'); onVerified && onVerified(false);
    };

    /* camera id（FreeD 且有数据时） */
    const camIds = proto.id === 'freed' && dataPresent ? (latest.camera_ids || []) : [];
    const needPick = camIds.length > 1;
    const camSel = form.trackCameraId;
    /* 单机位时自动选中，供 Profile 存储 */
    useEffect(() => {
      if (camIds.length === 1 && camSel !== camIds[0]) set('trackCameraId', camIds[0]);
      if (proto.id !== 'freed' && camSel != null) set('trackCameraId', null);
    }); // eslint-disable-line

    const hasCap = (c) => proto.caps.indexOf(c) >= 0;
    const missingLens = dataPresent && (vals.zoom == null || vals.focus == null);

    /* ---------- 协议段（2 卡格，对偶 backend 段） ---------- */
    const protoGrid = h('div', { className: 'vs-backends' }, PROTOCOLS.map((p) => {
      const on = p.id === protocol;
      return h('div', { key: p.id, className: 'vs-be' + (on ? ' on' : ''),
        onClick: () => { set('trackProtocol', p.id); onVerified && onVerified(false); } },
        h('span', { className: 'vs-be-ic' }, h(Icon, { name: p.icon, size: 15 })),
        h('span', { className: 'vs-be-tx' }, h('b', null, p.label), h('span', null, p.sub)));
    }));

    /* ---------- 数值单元 ---------- */
    const numSpan = (raw) => live
      ? h('span', { key: tick, className: 'ts-num flash' }, raw)
      : h('span', { className: 'ts-num' }, raw);
    const Val = (k, label, raw, opts) => {
      const dead = opts && opts.dead;
      const cls = 'ts-val' + (dead ? ' dead' : (sig === 'frozen' ? ' frozen' : (live ? ' live' : '')))
        + (opts && opts.lens ? ' ts-val-lens' : '');
      return h('div', { key: k, className: cls },
        h('div', { className: 'ts-val-k' }, h('span', { className: 'ts-actdot' }), label),
        h('div', { className: 'ts-val-v' }, dead ? '—' : numSpan(raw),
          (opts && opts.raw && !dead) ? h('span', { className: 'raw' }, 'raw') : null));
    };

    /* ---------- 监听测试区 ---------- */
    let listenArea;
    if (!listening) {
      listenArea = h('div', { className: 'ts-idle' },
        h('span', { className: 'ts-idle-ic' }, h(Icon, { name: 'pulse', size: 18 })),
        h('div', { className: 'ts-idle-tx' },
          h('div', { className: 'ts-idle-t' }, '点「开始监听」验证追踪数据链路'),
          h('div', { className: 'ts-idle-d' }, '绑定 ' + (form.trackHost || '0.0.0.0') + ':' + (form.trackPort || '—') + ' 接收 ' + proto.label + ' 包，实时确认位姿/编码器值——保存前先确保值在更新。')),
        h('button', { className: 'ts-listen-btn start', onClick: startProbe },
          h(Icon, { name: 'play', size: 14 }), '开始监听'));
    } else {
      /* 指标 */
      const pkt = sig === 'nodata' ? '0' : String(latest && latest.pkt_s != null ? Number(latest.pkt_s).toFixed(1) : '—');
      const metrics = h('div', { className: 'ts-metrics' },
        h('div', { className: 'ts-metric' }, h('span', { className: 'v' + (sig === 'nodata' ? ' dim' : '') }, pkt), h('span', { className: 'k' }, 'pkt/s')),
        h('div', { className: 'ts-metric' }, h('span', { className: 'k' }, '解码'),
          h('span', { className: 'v ' + (sig === 'fail' ? 'neg' : sig === 'nodata' ? 'dim' : 'pos') }, sig === 'nodata' ? '—' : sig === 'fail' ? '0%' : '100%')));

      let body;
      if (sig === 'nodata') {
        body = h('div', { className: 'ts-nodata' }, h('div', { className: 'ring' }),
          h('div', { className: 'msg' }, '端口已绑定，未收到包'),
          h('div', { className: 'sub' }, '检查发送端 IP / 端口（当前 :' + (form.trackPort || '—') + '）与防火墙是否放行 UDP。'));
      } else if (sig === 'fail') {
        const other = protocol === 'freed' ? 'opentrackio' : 'freed';
        const otherLabel = protocol === 'freed' ? 'OpenTrackIO' : 'FreeD';
        body = h('div', { className: 'ts-nodata' },
          h('div', { className: 'msg neg' }, '收到包，但按 ' + proto.label + ' 解不出来'),
          h('div', { className: 'sub' }, probeError || ('对方发送的可能不是 ' + proto.label + '。这是现场高频错误——')),
          h('button', { className: 'ts-listen-btn stop', style: { marginTop: 11 }, onClick: () => set('trackProtocol', other) },
            h(Icon, { name: 'sync', size: 13 }), '试试切换为 ' + otherLabel));
      } else {
        body = h('div', { className: 'ts-vals' },
          h('div', { className: 'ts-grp' },
            h('div', { className: 'ts-grp-h' }, '位置', h('span', { className: 'unit' }, 'mm')),
            h('div', { className: 'ts-row3' }, Val('x', 'X', vals.x.toFixed(1)), Val('y', 'Y', vals.y.toFixed(1)), Val('z', 'Z', vals.z.toFixed(1)))),
          h('div', { className: 'ts-grp' },
            h('div', { className: 'ts-grp-h' }, '姿态', h('span', { className: 'unit' }, 'deg')),
            h('div', { className: 'ts-row3' }, Val('pan', 'Pan', vals.pan.toFixed(2)), Val('tilt', 'Tilt', vals.tilt.toFixed(2)), Val('roll', 'Roll', vals.roll.toFixed(2)))),
          h('div', { className: 'ts-grp ts-grp-lens' },
            Val('zoom', 'Zoom', String(vals.zoom ?? '—'), { raw: true, lens: true, dead: vals.zoom == null }),
            Val('focus', 'Focus', String(vals.focus ?? '—'), { raw: true, lens: true, dead: vals.focus == null })));
      }

      const camRow = proto.id === 'freed' && dataPresent ? h('div', { className: 'ts-cams' },
        h('span', { className: 'ts-cams-k' }, h(Icon, { name: 'camera', size: 12 }), 'Camera ID'),
        h('div', { className: 'ts-cam-list' }, camIds.map((id) => h('button', {
          key: id, className: 'ts-cam' + ((needPick ? camSel === id : true) ? ' on' : ''),
          onClick: () => set('trackCameraId', id) },
          '#' + id, (needPick ? camSel === id : true) ? h('span', { className: 'chk' }, h(Icon, { name: 'check', size: 12 })) : null))),
        needPick && camSel == null ? h('span', { className: 'ts-cam-prompt' }, h(Icon, { name: 'alert', size: 12 }), '监听到多个机位，请选择要用哪个')
          : needPick ? h('span', { style: { fontSize: 10.5, color: 'rgba(255,255,255,.4)', fontFamily: 'var(--font-code)' } }, '过滤 #' + camSel + ' 存入配置') : null) : null;

      listenArea = h('div', { className: 'ts-panel' },
        h('div', { className: 'ts-panel-top' }, h(RecvPill, { st: sig }), metrics),
        body, camRow,
        h('div', { className: 'ts-panel-foot' },
          h('button', { className: 'ts-listen-btn stop', onClick: stopProbe }, h(Icon, { name: 'power', size: 13 }), '停止监听'),
          h('span', { className: 'ts-panel-note' }, '监听仅验证链路，不产生采集数据')));
    }

    /* ---------- 数据完备性行 ---------- */
    const compBadge = (c) => {
      const present = c === 'zoom' ? vals.zoom != null : c === 'focus' ? vals.focus != null : hasCap(c);
      const state = !dataPresent ? 'unknown' : (present ? 'on' : 'absent');
      return h('span', { key: c, className: 'ts-cap' + (state === 'on' ? ' on' : state === 'absent' ? ' absent' : '') },
        h(Icon, { name: state === 'on' ? 'check' : state === 'absent' ? 'x' : 'more', size: 12 }),
        CAP_LABEL[c], state === 'absent' ? h('span', { className: 'miss' }, '· 此源未提供') : null);
    };

    /* ---------- 高级折叠 ---------- */
    const bindControl = manualBind
      ? h('input', { className: 'cap-tf', value: form.trackHost || '', placeholder: 'IPv4 bind address', onChange: (e) => { set('trackHost', e.target.value); onVerified && onVerified(false); } })
      : h('select', { className: 'ar-select', value: form.trackHost || '0.0.0.0', onChange: (e) => { if (e.target.value === '__manual') setManualBind(true); else { set('trackHost', e.target.value); onVerified && onVerified(false); } } },
          bindAddrs.map((a) => h('option', { key: a.id, value: a.id }, a.label)),
          h('option', { value: '__manual' }, '手动输入…'));
    const advBody = advOpen ? h('div', { className: 'vs-adv-body' },
      h('div', { className: 'cap-field', style: { marginBottom: 0 } },
        h('span', { className: 'cap-lbl' }, '绑定地址'),
        bindControl,
        manualBind ? h('button', { className: 'vs-icbtn', onClick: () => setManualBind(false), title: '返回网卡列表' }, h(Icon, { name: 'list', size: 14 })) : null),
      h('div', { className: 'vs-tf-note' }, '默认监听全部网卡。多网卡机器上，绑定到追踪系统所在网段可避免串扰。')) : null;

    /* ---------- 卡片 ---------- */
    return h('div', { className: 'cap-card' },
      h('div', { className: 'cap-card-h' }, h(Icon, { name: 'net', size: 15 }), '追踪源',
        h('span', { style: { marginLeft: 'auto', fontSize: 10.5, fontWeight: 500, color: 'var(--chrome-faint)', fontFamily: 'var(--font-code)' } }, 'protocol')),
      protoGrid,
      /* 连接参数 */
      h('div', { className: 'vs-sub' }, '连接参数'),
      h('div', { className: 'cap-field', style: { marginBottom: 0 } },
        h('span', { className: 'cap-lbl' }, 'UDP 端口'),
        h('input', { className: 'cap-tf', type: 'number', style: { maxWidth: 140, flex: '0 0 auto' }, value: form.trackPort, onChange: (e) => { set('trackPort', e.target.value); onVerified && onVerified(false); } }),
        h('span', { style: { fontSize: 10.5, color: 'var(--chrome-faint)' } }, '必填 · 与追踪系统输出一致')),
      h('div', { className: 'vs-adv' },
        h('button', { className: 'cap-adv-h', style: { width: '100%' }, onClick: () => setAdvOpen((v) => !v) },
          h(Icon, { name: 'chevr', size: 13, style: { transform: advOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' } }),
          '高级 · 绑定地址 / 网卡', h('span', { className: 'cap-adv-tag' }, 'host · 默认 0.0.0.0 全部网卡')),
        advBody),
      /* 监听测试区 */
      h('div', { className: 'vs-sub' }, '监听测试 · 保存前验证', h('span', { className: 'u' }, listening ? proto.label + ' @ ' + (form.trackHost || '0.0.0.0') + ':' + (form.trackPort || '—') : '未监听')),
      listenArea,
      /* 数据完备性 */
      h('div', { className: 'vs-sub' }, '数据完备性', h('span', { className: 'u' }, dataPresent ? '按实际收到内容' : '监听后点亮')),
      h('div', { className: 'ts-comp' }, ['pos', 'rot', 'zoom', 'focus'].map(compBadge)),
      missingLens ? h('div', { className: 'ts-lens-note' }, h(Icon, { name: 'info', size: 15 }),
        h('div', null, h('b', null, '本源无镜头编码器数据。'), ' 镜头标定需要 zoom/focus 时，需另接来源或使用固定值。')) : null,
      /* 常驻提示 */
      h('div', { className: 'vs-hint' }, h(Icon, { name: 'info', size: 15 }),
        h('div', null, h('b', null, '值不更新就不要开始采集。'), ' 端口填错 / 防火墙拦截 / 协议选错都会让追踪静默失败，务必先在上方监听区确认位姿在实时变化。')),
      null);
  }

  /* ============================================================
     独立二级界面：追踪源信号接入（ctx 栏图标打开，聚焦接入与验证）
     ============================================================ */
  function TrackingModal({ s, close }) {
    const [form, setForm] = useState({ trackProtocol: 'freed', trackPort: 6301, trackHost: '0.0.0.0', trackCameraId: null });
    const [verified, setVerified] = useState(false);
    const set = (k, v) => setForm((f) => Object.assign({}, f, { [k]: v }));
    return h('div', { className: 'drawer drawer--cal2cap' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: 'net', size: 17 })),
        h('div', { style: { minWidth: 0 } },
          h('h2', null, '追踪源信号接入'),
          h('div', { className: 'sub' }, h('span', { className: 'cli-pill' }, 'tracking ingest'), h('span', null, ' · 接入并验证追踪数据'))),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b' }, h(TrackingSourceCard, { form, set, onVerified: setVerified })),
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, '关闭'),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), isDisabled: !verified,
          onPress: () => { s.pushLog && s.pushLog({ lv: 'ok', cat: 'capture', msg: '追踪源已验证 · <b>' + (form.trackProtocol === 'freed' ? 'FreeD' : 'OpenTrackIO') + ' :' + form.trackPort + '</b>' }); close(); } }, '用于采集配置')));
  }

  function openTrackingModal(s) {
    s.setModal({ xwide: true, render: ({ s: st, close }) => h(TrackingModal, { s: st, close }) });
  }

  window.VoloTrackingSource = { TrackingSourceCard };
  window.VOLO_CAL2 = Object.assign(window.VOLO_CAL2 || {}, { openTrackingModal });
})();
