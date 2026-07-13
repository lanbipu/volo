// @ts-nocheck
import { probeVideoSource } from "../api/captureProfiles";
/* Volo — 视频源卡片（重设计）
   采集设置 → Profile 新建/编辑表单中的「视频源」模块。
   Device→Line/Source 枚举选择 + 选中即预览验证 + 格式从信号自动读取。
   字段以真实后端为准：backend / device(uvc=index|url · ndi=源名 · decklink=card:line)
   / width / height / fps / transfer_function(sdr|log) / pixel_format(后端提示)。
   演示数据 mock，控件结构不引入这些字段之外的配置项。 */
(function () {
  const { useState, useRef, useEffect } = React;
  const h = React.createElement;

  /* ---------- backend 段（保留四选一） ---------- */
  const BACKENDS = [
    { id: 'uvc',       label: 'UVC 摄像头',  sub: '即插即用',      icon: 'usb' },
    { id: 'ndi',       label: 'NDI',          sub: '网络视频源',    icon: 'net' },
    { id: 'decklink',  label: 'DeckLink SDI', sub: '采集卡',        icon: 'cpu' },
    { id: 'synthetic', label: '合成测试源',   sub: '内置图案',      icon: 'grid' },
  ];

  /* ---------- mock 枚举数据 ---------- */
  const UVC_DEVS = [
    { id: '0', name: 'AJA U-TAP HDMI',            fmt: { w: 1920, h: 1080, fps: '29.97', pix: 'UYVY 8-bit', tf: 'SDR' } },
    { id: '1', name: 'Blackmagic UltraStudio Mini', fmt: { w: 1920, h: 1080, fps: '25.00', pix: 'UYVY 8-bit', tf: 'SDR' } },
    { id: '2', name: 'Elgato Cam Link 4K',        fmt: { w: 3840, h: 2160, fps: '29.97', pix: 'NV12 8-bit',  tf: 'SDR' } },
  ];
  const NDI_SRCS = [
    { id: 'ndi0', name: 'STAGE-CAM-01 (VIZ-A)',    hx: false, fmt: { w: 1920, h: 1080, fps: '29.97', pix: 'UYVY 8-bit', tf: 'SDR' } },
    { id: 'ndi1', name: 'STAGE-CAM-02 (VIZ-B)',    hx: false, fmt: { w: 1920, h: 1080, fps: '50.00', pix: 'UYVY 8-bit', tf: 'SDR' } },
    { id: 'ndi2', name: 'PTZ-DOME (NDI|HX Camera)', hx: true,  fmt: { w: 1920, h: 1080, fps: '25.00', pix: 'H.264 长GOP', tf: 'SDR' } },
  ];
  const DL_CARDS = [
    { id: 'dl0', name: 'DeckLink Quad HDMI Recorder', lines: [
      { id: 'in1', name: 'HDMI 1', fmt: { w: 1920, h: 1080, fps: '29.97', pix: 'v210 10-bit', tf: 'SDR' } },
      { id: 'in2', name: 'HDMI 2', fmt: { w: 1920, h: 1080, fps: '29.97', pix: 'v210 10-bit', tf: 'SDR' } },
      { id: 'in3', name: 'HDMI 3', fmt: { w: 3840, h: 2160, fps: '23.98', pix: 'v210 10-bit', tf: 'Log' } },
      { id: 'in4', name: 'HDMI 4', fmt: { w: 1920, h: 1080, fps: '59.94', pix: 'v210 10-bit', tf: 'SDR' } },
    ] },
    { id: 'dl1', name: 'DeckLink Duo 2', lines: [
      { id: 'sdi1', name: 'SDI 1', fmt: { w: 1920, h: 1080, fps: '25.00', pix: 'v210 10-bit', tf: 'SDR' } },
      { id: 'sdi2', name: 'SDI 2', fmt: { w: 1920, h: 1080, fps: '25.00', pix: 'v210 10-bit', tf: 'SDR' } },
    ] },
  ];

  /* ---------- 信号状态 · 三通道（颜色 + 图标 + 文字） ---------- */
  const SIGNAL = {
    ok:       { tone: 'positive',    icon: 'check', text: '信号正常' },
    waiting:  { tone: 'neutral',     icon: 'sync',  text: '等待信号…' },
    nosignal: { tone: 'negative',    icon: 'alert', text: '无信号' },
    frozen:   { tone: 'notice',      icon: 'alert', text: '画面疑似冻结' },
    hx:       { tone: 'notice',      icon: 'alert', text: 'NDI|HX — 仅可预览，不可标定' },
  };

  /* ---------- 通用内联 popover ---------- */
  function Pop({ children, render }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
      if (!open) return undefined;
      const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
      document.addEventListener('mousedown', onDown);
      return () => document.removeEventListener('mousedown', onDown);
    }, [open]);
    return h('div', { className: 'vs-pop-wrap', ref },
      children({ open, toggle: () => setOpen((v) => !v) }),
      open ? render(() => setOpen(false)) : null);
  }

  /* ---------- 测试图案预览帧 ---------- */
  function Frame({ state }) {
    const bars = ['#c9ccd2', '#c9c930', '#30c9c9', '#30c930', '#c930c9', '#c93030', '#3030c9'];
    const dim = state === 'frozen' ? 0.62 : 1;
    if (state === 'nosignal') {
      return h('svg', { className: 'vs-frame', viewBox: '0 0 160 90', preserveAspectRatio: 'none' },
        h('rect', { width: 160, height: 90, fill: '#08090c' }));
    }
    if (state === 'waiting') {
      return h('svg', { className: 'vs-frame', viewBox: '0 0 160 90', preserveAspectRatio: 'none' },
        h('rect', { width: 160, height: 90, fill: '#0b0c10' }));
    }
    return h('svg', { className: 'vs-frame', viewBox: '0 0 160 90', preserveAspectRatio: 'none', style: { opacity: dim } },
      bars.map((c, i) => h('rect', { key: i, x: i * (160 / 7), y: 0, width: 160 / 7 + 0.6, height: 64, fill: c })),
      h('rect', { x: 0, y: 64, width: 160, height: 12, fill: '#1c2733' }),
      h('rect', { x: 0, y: 76, width: 160, height: 14, fill: '#0f141b' }),
      /* 中央十字 + 圆，模拟对焦标记 */
      h('circle', { cx: 80, cy: 32, r: 15, fill: 'none', stroke: 'rgba(255,255,255,.32)', strokeWidth: 0.8 }),
      h('path', { d: 'M80 20v24M68 32h24', stroke: 'rgba(255,255,255,.32)', strokeWidth: 0.8 }));
  }

  function StatusPill({ st, lg }) {
    const m = SIGNAL[st];
    return h('span', { className: 'cap-pill cap-pill--' + m.tone + (lg ? ' is-lg' : '') },
      st === 'waiting'
        ? h('span', { className: 'vs-icbtn spin', style: { width: 12, height: 12, border: 0, background: 'none' } }, h(Icon, { name: 'sync', size: 12 }))
        : h(Icon, { name: m.icon, size: lg ? 13 : 12 }),
      m.text);
  }

  /* ============================================================
     视频源卡片主组件
     props: form（当前表单）, set（写回字段）
     ============================================================ */
  function VideoSourceCard({ form, set }) {
    const backend = form.videoBackend || 'uvc';

    /* 演示控制（非配置项）：sdk 可用性 / 枚举态 / 信号态 */
    const [sdkAll, setSdkAll] = useState(false);       /* false = 仅 UVC（真实默认） */
    const [enumSt, setEnumSt] = useState('ready');      /* ready | loading | empty */
    const [sig, setSig] = useState('waiting');           /* ok | waiting | nosignal | frozen */
    const [previewUrl, setPreviewUrl] = useState(null);

    /* 选择态 */
    const [uvcSel, setUvcSel] = useState('0');
    const [ndiSel, setNdiSel] = useState(null);
    const [dlCard, setDlCard] = useState(null);
    const [dlLine, setDlLine] = useState(null);
    const [manual, setManual] = useState(false);
    const [advOpen, setAdvOpen] = useState(false);

    const [uvcOpen, setUvcOpen] = useState(false);
    const [ndiOpen, setNdiOpen] = useState(false);
    const [dlCardOpen, setDlCardOpen] = useState(false);
    const [dlLineOpen, setDlLineOpen] = useState(false);

    const fmtMode = form.fmtMode || 'auto';
    const tf = form.transferFunction || 'sdr';

    const avail = (id) => id === 'uvc' || id === 'synthetic' || sdkAll;
    const refresh = async (deviceOverride) => {
      if (backend === 'synthetic') return;
      setEnumSt('loading'); setSig('waiting');
      try {
        const manualFmt = fmtMode === 'manual';
        const r = await probeVideoSource({ backend, device: typeof deviceOverride === 'string' ? deviceOverride : (form.device || '0'),
          width: manualFmt && form.width ? Number(form.width) : null,
          height: manualFmt && form.height ? Number(form.height) : null,
          fps: manualFmt && form.fps ? Number(form.fps) : null,
          transferFunction: form.transferFunction || 'sdr' });
        setPreviewUrl(r.preview_data_url || null); setEnumSt('ready'); setSig(r.frames > 0 ? 'ok' : 'nosignal');
      } catch (e) { setPreviewUrl(null); setEnumSt('ready'); setSig('nosignal'); }
    };

    /* 当前选中设备的 fmt（信号信息条来源） */
    const curFmt = (() => {
      if (backend === 'uvc') { const d = UVC_DEVS.find((x) => x.id === uvcSel); return d && d.fmt; }
      if (backend === 'ndi') { const d = NDI_SRCS.find((x) => x.id === ndiSel); return d && d.fmt; }
      if (backend === 'decklink') { const c = DL_CARDS.find((x) => x.id === dlCard); const l = c && c.lines.find((x) => x.id === dlLine); return l && l.fmt; }
      return null;
    })();
    const ndiIsHx = backend === 'ndi' && (NDI_SRCS.find((x) => x.id === ndiSel) || {}).hx;
    const effSig = ndiIsHx ? 'hx' : sig;
    const hasDevice = backend === 'uvc' ? true /* 默认已选 */
      : backend === 'ndi' ? !!ndiSel
      : backend === 'decklink' ? (!!dlCard && !!dlLine)
      : false;
    const showPreview = enumSt === 'ready' && hasDevice && backend !== 'synthetic';

    /* ------- backend 段选择 ------- */
    const backendGrid = h('div', { className: 'vs-backends' }, BACKENDS.map((b) => {
      const on = b.id === backend;
      const off = !avail(b.id);
      return h('div', {
        key: b.id, className: 'vs-be' + (on ? ' on' : '') + (off ? ' off' : ''),
        onClick: () => { if (!off) { set('videoBackend', b.id); setManual(false); } },
      },
        h('span', { className: 'vs-be-ic' }, h(Icon, { name: b.icon, size: 15 })),
        h('span', { className: 'vs-be-tx' }, h('b', null, b.label), h('span', null, b.sub)),
        off ? h(SdkPop, { backend: b.id, onUseUvc: () => { setSdkAll(false); set('videoBackend', 'uvc'); } }) : null);
    }));

    /* ------- 设备选择器 ------- */
    let selector = null;
    if (backend !== 'synthetic') {
      if (enumSt === 'loading') {
        selector = h('div', { className: 'vs-enum-state' },
          h('span', { className: 'vs-enum-ic spin' }, h(Icon, { name: 'sync', size: 15 })),
          h('div', { className: 'vs-enum-tx' }, h('div', { className: 'vs-enum-t' }, '正在扫描设备…'),
            h('div', { className: 'vs-enum-d' }, backend === 'ndi' ? '在本地网络发现 NDI 源' : '枚举本机采集设备')));
      } else if (enumSt === 'empty') {
        selector = h('div', { className: 'vs-enum-state' },
          h('span', { className: 'vs-enum-ic' }, h(Icon, { name: 'alert', size: 15 })),
          h('div', { className: 'vs-enum-tx' }, h('div', { className: 'vs-enum-t' }, '未发现设备'),
            h('div', { className: 'vs-enum-d' }, backend === 'ndi' ? '本网络内没有可见的 NDI 源' : '没有枚举到采集设备，检查连线后刷新')),
          h('div', { className: 'vs-enum-acts' },
            h('button', { className: 'vs-icbtn', title: '刷新', onClick: refresh }, h(Icon, { name: 'sync', size: 15 })),
            h('button', { className: 'vs-icbtn', style: { width: 'auto', padding: '0 10px', fontSize: 11.5, fontWeight: 700, gap: 6 }, onClick: () => setManual(true) },
              h(Icon, { name: 'sliders', size: 13 }), '手动输入')));
      } else if (backend === 'decklink') {
        const card = DL_CARDS.find((x) => x.id === dlCard);
        selector = h('div', { className: 'vs-two' },
          h('div', { className: 'vs-two-col' },
            h('div', { className: 'vs-two-lbl' }, '① 采集卡'),
            h(Select, {
              open: dlCardOpen, setOpen: setDlCardOpen, icon: 'cpu', placeholder: '选择采集卡…',
              value: card ? h('span', { className: 'nm' }, card.name) : null,
              options: DL_CARDS.map((c) => ({ id: c.id, node: h('div', { className: 'vs-opt-meta' },
                h('div', { className: 'vs-opt-n' }, c.name), h('div', { className: 'vs-opt-s' }, c.lines.length + ' 路输入')) })),
              selId: dlCard, onPick: (id) => { setDlCard(id); setDlLine(null); },
            })),
          h('div', { className: 'vs-two-col' },
            h('div', { className: 'vs-two-lbl' }, '② 输入口 (line)'),
            h(Select, {
              open: dlLineOpen, setOpen: setDlLineOpen, icon: 'arrowr', placeholder: card ? '选择输入口…' : '先选采集卡',
              disabled: !card,
              value: (() => { const l = card && card.lines.find((x) => x.id === dlLine); return l ? h('span', { className: 'nm' }, l.name) : null; })(),
              options: (card ? card.lines : []).map((l) => ({ id: l.id, node: h('div', { className: 'vs-opt-meta' },
                h('div', { className: 'vs-opt-n' }, l.name), h('div', { className: 'vs-opt-s' }, l.fmt.w + '×' + l.fmt.h + ' · ' + l.fmt.fps + 'fps')) })),
              selId: dlLine, onPick: (id) => { const dev = dlCard + ':' + id; setDlLine(id); set('device', dev); refresh(dev); },
            })));
      } else if (backend === 'uvc') {
        const d = UVC_DEVS.find((x) => x.id === uvcSel);
        selector = h('div', { className: 'vs-devrow' },
          h(Select, {
            open: uvcOpen, setOpen: setUvcOpen, icon: 'camera', placeholder: '选择摄像头…', grow: true,
            value: d ? h(React.Fragment, null, h('span', { className: 'nm' }, d.name), h('span', { className: 'idx' }, '#' + d.id)) : null,
            options: UVC_DEVS.map((x) => ({ id: x.id, node: h('div', { className: 'vs-opt-meta' },
              h('div', { className: 'vs-opt-n' }, x.name, h('span', { className: 'idx' }, '#' + x.id)),
              h('div', { className: 'vs-opt-s' }, x.fmt.w + '×' + x.fmt.h + ' · ' + x.fmt.pix)) })),
            selId: uvcSel, onPick: (id) => { setUvcSel(id); set('device', id); refresh(id); },
            manualLabel: '手动输入索引 / URL / 路径…', onManual: () => setManual(true),
          }),
          h('button', { className: 'vs-icbtn', title: '刷新设备列表', onClick: refresh }, h(Icon, { name: 'sync', size: 15 })));
      } else { /* ndi */
        const d = NDI_SRCS.find((x) => x.id === ndiSel);
        selector = h('div', { className: 'vs-devrow' },
          h(Select, {
            open: ndiOpen, setOpen: setNdiOpen, icon: 'net', placeholder: '选择 NDI 源…', grow: true,
            value: d ? h(React.Fragment, null, h('span', { className: 'nm' }, d.name), d.hx ? h('span', { className: 'vs-opt-warn' }, h(Icon, { name: 'alert', size: 10 }), 'HX') : null) : null,
            options: NDI_SRCS.map((x) => ({ id: x.id, warn: x.hx, node: h('div', { className: 'vs-opt-meta' },
              h('div', { className: 'vs-opt-n' }, x.name), h('div', { className: 'vs-opt-s' }, x.fmt.w + '×' + x.fmt.h + ' · ' + x.fmt.fps + 'fps')),
              warnNode: x.hx ? h('span', { className: 'vs-opt-warn' }, h(Icon, { name: 'alert', size: 10 }), '仅可预览 · 不可标定') : null })),
            selId: ndiSel, onPick: (id) => { const name = (NDI_SRCS.find((x) => x.id === id) || {}).name || ''; setNdiSel(id); set('device', name); refresh(name); },
            manualLabel: '手动输入 NDI 源名…', onManual: () => setManual(true),
          }),
          h('button', { className: 'vs-icbtn', title: '重新发现', onClick: refresh }, h(Icon, { name: 'sync', size: 15 })));
      }
    }

    const manualRow = manual && backend !== 'synthetic' && enumSt !== 'loading' ? h('div', { className: 'vs-manual' },
      h('input', { className: 'cap-tf', autoFocus: true, placeholder: backend === 'ndi' ? '机器名 (源名)' : backend === 'decklink' ? 'card:line' : '设备索引 / URL / 路径',
        value: form.device || '', onChange: (e) => set('device', e.target.value) }),
      h('button', { className: 'vs-manual-x', title: '取消手动输入', onClick: () => setManual(false) }, h(Icon, { name: 'x', size: 14 }))) : null;

    /* ------- 信号预览区 ------- */
    let preview = null;
    if (backend === 'synthetic') {
      preview = h('div', { className: 'vs-synth' },
        h('span', { className: 'vs-synth-ic' }, h(Icon, { name: 'grid', size: 18 })),
        h('div', null, h('div', { className: 'vs-synth-t' }, '内置合成图案 · 无需硬件'),
          h('div', { className: 'vs-synth-d' }, '生成移动棋盘/条纹测试帧，无设备与预览。用于无相机时验证标定流程。')));
    } else if (showPreview) {
      const f = curFmt;
      preview = h('div', null,
        h('div', { className: 'vs-preview state-' + effSig },
          h('div', { className: 'vs-badge' }, h(StatusPill, { st: effSig })),
          (effSig === 'ok' || effSig === 'hx') ? h('span', { className: 'vs-livedot' }, h('i', null), 'LIVE') : null,
          previewUrl ? h('img', { className: 'vs-frame', src: previewUrl, alt: '视频源实际探测帧' }) : h(Frame, { state: effSig === 'hx' ? 'ok' : effSig }),
          effSig === 'waiting' ? h('div', { className: 'vs-preview-mid' }, h('span', { className: 'ring' }), h('span', { className: 'msg' }, '等待首帧…')) : null,
          effSig === 'nosignal' ? h('div', { className: 'vs-preview-mid' }, h(Icon, { name: 'alert', size: 26, style: { color: 'color-mix(in srgb, var(--negative-visual) 80%, #fff)' } }), h('span', { className: 'msg neg' }, '设备无法打开 / 断流')) : null,
          effSig === 'frozen' ? h('span', { className: 'vs-frozen-tag' }, '最后一帧 · 已 4.2s 未更新') : null),
        /* 信号信息条（自动读取，不手输） */
        (effSig !== 'nosignal' && f) ? h('div', { className: 'vs-sigbar' },
          h('div', { className: 'vs-sig-read' },
            h('span', null, f.w + '×' + f.h), h('span', { className: 'sep' }, '·'),
            h('span', null, f.fps + 'fps'), h('span', { className: 'sep' }, '·'),
            h('span', { className: 'dim' }, f.pix), h('span', { className: 'sep' }, '·'),
            h('span', { className: 'dim' }, f.tf)),
          h('span', { className: 'vs-sig-auto' }, h(Icon, { name: 'check', size: 12 }), '自动读取')) : null,
        /* HX / 冻结 警示条 */
        effSig === 'hx' ? h('div', { className: 'vs-warnstrip notice' }, h(Icon, { name: 'alert', size: 15 }),
          h('div', null, h('b', null, 'NDI|HX — 仅可预览，不可标定。'), ' HX 为长 GOP 压缩传输，后端会拒绝用于标定。请改用完整 NDI 源或走 SDI/UVC。')) : null,
        effSig === 'frozen' ? h('div', { className: 'vs-warnstrip notice' }, h(Icon, { name: 'alert', size: 15 }),
          h('div', null, h('b', null, '画面疑似冻结。'), ' 连续多帧无变化，可能是信号线松动或源端暂停。检查连线或点刷新重连。')) : null,
        effSig === 'nosignal' ? h('div', { className: 'vs-warnstrip negative' }, h(Icon, { name: 'alert', size: 15 }),
          h('div', null, h('b', null, '无信号。'), ' 设备打不开或已断流。确认设备未被其他程序占用，检查连线后刷新。')) : null);
    }

    /* ------- 高级折叠区 ------- */
    const advBody = advOpen ? h('div', { className: 'vs-adv-body' },
      /* 格式覆盖 */
      h('div', null,
        h('div', { className: 'vs-fmt-head' },
          h('span', { className: 'vs-fmt-lbl' }, '分辨率 / 帧率', h('span', { className: 'n' }, 'width / height / fps')),
          h('div', { className: 'cap-seg' }, [['auto', 'Auto（跟随信号）'], ['manual', '手动指定']].map(([k, l]) =>
            h('button', { key: k, className: fmtMode === k ? 'on' : '', onClick: () => set('fmtMode', k) }, l)))),
        fmtMode === 'manual' ? h('div', { className: 'vs-fmt-inputs' },
          h('span', { className: 'vs-fmt-num' }, h('label', null, 'W'), h('input', { value: form.width || '', placeholder: '1920', onChange: (e) => set('width', e.target.value) })),
          h('span', { className: 'vs-fmt-x' }, '×'),
          h('span', { className: 'vs-fmt-num' }, h('label', null, 'H'), h('input', { value: form.height || '', placeholder: '1080', onChange: (e) => set('height', e.target.value) })),
          h('span', { className: 'vs-fmt-num' }, h('label', null, 'FPS'), h('input', { value: form.fps || '', placeholder: '29.97', onChange: (e) => set('fps', e.target.value) })))
          : h('div', { className: 'vs-tf-note' }, '默认与信号协商，分辨率不手输。仅在设备协商异常时用手动指定排障。')),
      /* transfer function */
      h('div', null,
        h('div', { className: 'vs-fmt-head' },
          h('span', { className: 'vs-fmt-lbl' }, 'Transfer function', h('span', { className: 'n' }, 'transfer_function')),
          h('div', { className: 'cap-seg' }, [['sdr', 'SDR'], ['log', 'Log']].map(([k, l]) =>
            h('button', { key: k, className: tf === k ? 'on' : '', onClick: () => set('transferFunction', k) }, l)))),
        h('div', { className: 'vs-tf-note' }, '声明制：仅标记信号是否为 Log 曲线，后端不做色彩转换。')))
      : null;

    /* ------- 演示控制条 ------- */
    const demo = h('div', { className: 'vs-demo' },
      h('div', { className: 'vs-demo-h' }, h(Icon, { name: 'sliders', size: 12 }), '演示状态切换 · 非配置项'),
      h('div', { className: 'vs-demo-row' },
        h('span', { className: 'vs-demo-k' }, 'SDK'),
        h('div', { className: 'vs-demo-seg' }, [['uvc', '仅 UVC（默认）'], ['all', '全部可用']].map(([k, l]) =>
          h('button', { key: k, className: (sdkAll ? 'all' : 'uvc') === k ? 'on' : '', onClick: () => setSdkAll(k === 'all') }, l)))),
      h('div', { className: 'vs-demo-row' },
        h('span', { className: 'vs-demo-k' }, '枚举'),
        h('div', { className: 'vs-demo-seg' }, [['ready', '就绪'], ['loading', '扫描中'], ['empty', '空']].map(([k, l]) =>
          h('button', { key: k, className: enumSt === k ? 'on' : '', onClick: () => setEnumSt(k) }, l)))),
      backend !== 'synthetic' ? h('div', { className: 'vs-demo-row' },
        h('span', { className: 'vs-demo-k' }, '信号'),
        h('div', { className: 'vs-demo-seg' }, [['ok', 'positive'], ['waiting', 'neutral'], ['nosignal', 'negative'], ['frozen', 'notice']].map(([k, tone]) =>
          h('button', { key: k, className: sig === k ? 'on' : '', onClick: () => setSig(k), disabled: ndiIsHx },
            h('span', { className: 'dot bg-' + tone }), SIGNAL[k].text.replace('…', '').replace('画面疑似', '')))),
        ndiIsHx ? h('span', { style: { fontSize: 10.5, color: 'var(--chrome-faint)' } }, 'HX 源锁定为「仅可预览」') : null) : null);

    /* ------- 卡片 ------- */
    return h('div', { className: 'cap-card' },
      h('div', { className: 'cap-card-h' }, h(Icon, { name: 'camera', size: 15 }), '视频源',
        h('span', { style: { marginLeft: 'auto', fontSize: 10.5, fontWeight: 500, color: 'var(--chrome-faint)', fontFamily: 'var(--font-code)' } }, 'backend')),
      backendGrid,
      /* 设备选择器 */
      backend !== 'synthetic' ? h(React.Fragment, null,
        h('div', { className: 'vs-sub' }, backend === 'decklink' ? '设备（两级选择）' : '设备',
          enumSt === 'ready' ? h('span', { className: 'u' }, backend === 'ndi' ? '网络发现' : '本机枚举') : null),
        selector, manualRow) : null,
      /* 预览 / 合成提示 */
      preview,
      /* 高级折叠区 */
      h('div', { className: 'vs-adv' },
        h('button', { className: 'cap-adv-h', style: { width: '100%' }, onClick: () => setAdvOpen((v) => !v) },
          h(Icon, { name: 'chevr', size: 13, style: { transform: advOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' } }),
          '高级 · 格式覆盖', h('span', { className: 'cap-adv-tag' }, 'width / height / fps · transfer_function')),
        advBody),
      /* 常驻提示行 */
      h('div', { className: 'vs-hint' }, h(Icon, { name: 'info', size: 15 }),
        h('div', null, h('b', null, '标定必须使用相机原始信号'), '（未经去畸变 / 裁切 / 缩放 / 合成）。信号处理会破坏几何一致性，导致内外参估计不可靠。')),
      null);
  }

  /* ---------- 通用下拉选择器 ---------- */
  function Select({ open, setOpen, icon, placeholder, value, options, selId, onPick, disabled, manualLabel, onManual, grow }) {
    const ref = useRef(null);
    useEffect(() => {
      if (!open) return undefined;
      const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
      document.addEventListener('mousedown', onDown);
      return () => document.removeEventListener('mousedown', onDown);
    }, [open]);
    return h('div', { className: 'vs-select-wrap', ref, style: grow ? { flex: 1 } : null },
      h('button', { className: 'vs-select' + (open ? ' open' : '') + (value ? '' : ' placeholder'), disabled,
        onClick: () => !disabled && setOpen((v) => !v) },
        h('span', { className: 'vs-sel-ic' }, h(Icon, { name: icon, size: 15 })),
        h('span', { className: 'vs-sel-main' }, value || placeholder),
        h('span', { className: 'vs-sel-chev' }, h(Icon, { name: 'chevd', size: 14 }))),
      open ? h('div', { className: 'vs-menu' },
        options.length ? options.map((o) => h('div', { key: o.id, className: 'vs-opt' + (o.id === selId ? ' on' : ''),
          onClick: () => { onPick(o.id); setOpen(false); } },
          h('span', { className: 'vs-opt-ic' }, h(Icon, { name: icon, size: 14 })),
          o.node,
          o.warnNode || null,
          o.id === selId ? h('span', { className: 'vs-opt-check' }, h(Icon, { name: 'check', size: 14 })) : null))
          : h('div', { className: 'vs-opt', style: { color: 'var(--chrome-faint)', cursor: 'default' } }, '无可选项'),
        onManual ? h('div', { className: 'vs-menu-foot' },
          h('button', { className: 'vs-menu-manual', onClick: () => { onManual(); setOpen(false); } },
            h(Icon, { name: 'sliders', size: 14 }), manualLabel)) : null) : null);
  }

  /* ---------- 不可用 backend 的 "需 SDK" 说明浮层 ---------- */
  function SdkPop({ backend, onUseUvc }) {
    const meta = backend === 'ndi'
      ? { title: 'NDI 后端不可用', need: h(React.Fragment, null, '缺少 ', h('code', null, 'cyndilib'), ' 与本机 ', h('code', null, 'NDI SDK / Runtime'), '。'),
          how: '安装 NewTek NDI Runtime（或 SDK），并让 Volo 后端能加载到动态库后重启。' }
      : { title: 'DeckLink 后端不可用', need: h(React.Fragment, null, '需要本地 ', h('code', null, 'DeckLink SDK'), ' 编译的采集后端（Desktop Video 运行时）。'),
          how: '安装 Blackmagic Desktop Video，并用本地 DeckLink SDK 编译对应后端后重启。' };
    return h('span', { className: 'vs-sdk' },
      h(Pop, {
        children: ({ toggle }) => h('button', { className: 'vs-sdk-btn', onClick: (e) => { e.stopPropagation(); toggle(); } },
          h(Icon, { name: 'info', size: 11 }), '需 SDK'),
        render: () => h('div', { className: 'vs-pop', onClick: (e) => e.stopPropagation() },
          h('div', { className: 'vs-pop-h' }, h(Icon, { name: 'alert', size: 14 }), meta.title),
          h('div', { className: 'vs-pop-sec' }, h('div', { className: 'vs-pop-k' }, '缺什么'), h('div', { className: 'vs-pop-v' }, meta.need)),
          h('div', { className: 'vs-pop-sec' }, h('div', { className: 'vs-pop-k' }, '怎么装'), h('div', { className: 'vs-pop-v' }, meta.how)),
          h('div', { className: 'vs-pop-alt' }, h(Icon, { name: 'check', size: 14 }),
            h('div', { className: 'vs-pop-alt-t' }, h('b', null, '替代出路：'), ' 用 SDI/HDMI→USB3 转换器走 ',
              h('a', { href: '#', onClick: (e) => { e.preventDefault(); onUseUvc(); } }, 'UVC 后端'), '，免驱即插即用，可直接标定。')))
      }));
  }

  window.VoloVideoSource = { VideoSourceCard };
})();
