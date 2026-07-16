// @ts-nocheck
import {
  enumerateVideoSources,
  parseSidecarError,
} from "../api/captureProfiles";
import {
  cancelSidecarTask,
  cancelSidecarTasksByProgram,
  spawnSidecar,
  spawnSidecarStreaming,
  useSidecarStream,
} from "../api/sidecarStream";
/* Volo — 视频源卡片（重设计）
   采集设置 → Profile 新建/编辑表单中的「视频源」模块。
   Device→Line/Source 枚举选择 + 选中即预览验证 + 格式从信号自动读取。
   字段以真实后端为准：backend / device(uvc=index|url · ndi=源名 · decklink=card:line)
   / width / height / fps / transfer_function(sdr|log) / pixel_format(后端提示)。
   NDI / DeckLink 通过 vpcal 真实发现/探测；UVC 使用 list-devices 真探测。 */
(function () {
  const { useState, useRef, useEffect } = React;
  const h = React.createElement;

  /* 孤儿清扫：页面（重）加载后，上一世代残留的 vpcal 采集任务已无人持有句柄，
     却仍独占采集设备（DeckLink 单开）——模块加载时统一取消一次。 */
  void cancelSidecarTasksByProgram('vpcal').catch(() => {});

  /* ---------- backend 段（保留四选一） ---------- */
  const BACKENDS = [
    { id: 'uvc',       label: 'UVC 摄像头',  sub: '即插即用',      icon: 'usb' },
    { id: 'ndi',       label: 'NDI',          sub: '网络视频源',    icon: 'net' },
    { id: 'decklink',  label: 'DeckLink SDI', sub: '采集卡',        icon: 'cpu' },
    { id: 'synthetic', label: '合成测试源',   sub: '内置图案',      icon: 'grid' },
  ];

  function parseEnvelope(stdout) {
    const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const v = JSON.parse(lines[i]); if (v && typeof v === 'object') return v; } catch (e) {}
    }
    return null;
  }
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
        h('rect', { width: 160, height: 90, fill: '#08090c' }),
        h('text', { x: 80, y: 48, textAnchor: 'middle', fill: '#737884', fontSize: 8 }, '无信号'));
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
      h('path', { d: 'M80 20v24M68 32h24', stroke: 'rgba(255,255,255,.32)', strokeWidth: 0.8 }),
      h('rect', { x: 43, y: 72, width: 74, height: 12, rx: 2, fill: 'rgba(0,0,0,.72)' }),
      h('text', { x: 80, y: 80.5, textAnchor: 'middle', fill: '#c6cad2', fontSize: 7 }, '示意图（无真实预览）'));
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
    const [enumSt, setEnumSt] = useState('ready');      /* ready | loading | empty */
    const [sig, setSig] = useState('waiting');           /* ok | waiting | nosignal | frozen */
    const [sigErr, setSigErr] = useState(null);          /* 无信号时的真实后端报错文案 */
    const [liveTask, setLiveTask] = useState(null);      /* 常驻监看流 task_id */
    const [liveUrl, setLiveUrl] = useState(null);        /* MJPEG 流地址（preview_ready） */
    const [ndiSrcs, setNdiSrcs] = useState([]);
    const [ndiAvail, setNdiAvail] = useState('unknown'); /* unknown | ok | missing */
    const [ndiError, setNdiError] = useState(null);
    const [ndiFmt, setNdiFmt] = useState(null);
    const [uvcDevs, setUvcDevs] = useState([]);
    const [uvcError, setUvcError] = useState(null);

    /* DeckLink 真实枚举态（镜像 NDI） */
    const [dlDevs, setDlDevs] = useState([]);            /* [{index,name,connectors:[{id,name}]}] */
    const [dlAvail, setDlAvail] = useState('unknown');   /* unknown | ok | missing */
    const [dlError, setDlError] = useState(null);
    const [dlFmt, setDlFmt] = useState(null);            /* 探测返回的真实格式 */

    /* 选择态 */
    const [uvcSel, setUvcSel] = useState('0');
    const [ndiSel, setNdiSel] = useState(backend === 'ndi' ? (form.device || null) : null);
    /* dlCard = 卡 index（字符串）; dlLine = connector id（sdi/hdmi/…） */
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

    const avail = (id) => id === 'uvc' || id === 'synthetic'
      || (id === 'ndi' ? ndiAvail !== 'missing'
        : id === 'decklink' ? dlAvail !== 'missing'
        : false);

    /* ---------- 常驻监看流（连续 MJPEG 预览） ---------- */
    const liveStream = useSidecarStream(liveTask);
    const liveTaskRef = useRef(liveTask);
    liveTaskRef.current = liveTask;

    /* 选中源即起 `vpcal capture video --preview-port 0 --duration 0` 常驻进程，
       <img> 直接消费其 localhost MJPEG 流。切源/切 backend/卸载时取消旧任务。 */
    const startMonitor = async (device) => {
      if (liveTaskRef.current) void cancelSidecarTask(liveTaskRef.current);
      setSig('waiting'); setLiveUrl(null); setNdiFmt(null); setDlFmt(null); setSigErr(null);
      const manualFmt = fmtMode === 'manual';
      const args = ['capture', 'video', '--backend', backend, '--device', device,
        '--allow-hx', '--preview-port', '0', '--duration', '0', '--output', 'json'];
      if (manualFmt && form.width) args.push('--width', String(form.width));
      if (manualFmt && form.height) args.push('--height', String(form.height));
      if (manualFmt && form.fps) args.push('--fps', String(form.fps));
      args.push('--transfer-function', form.transferFunction || 'sdr');
      try {
        const resp = await spawnSidecarStreaming('vpcal', args);
        setLiveTask(resp.task_id);
      } catch (error) {
        const parsed = parseSidecarError(error);
        if (backend === 'ndi' && parsed.details && parsed.details.missing) {
          setNdiAvail('missing'); setNdiError(parsed);
        }
        if (parsed.message) setSigErr(parsed.message);
        setSig('nosignal'); setLiveUrl(null);
      }
    };

    /* 流事件消费：preview_ready → 流地址；source_info → 格式信息条 + 信号态 */
    useEffect(() => {
      const parsed = liveStream.state.lines
        .map((l) => l.parsed)
        .filter((p) => p && typeof p.type === 'string');
      const preview = [...parsed].reverse().find((p) => p.type === 'preview_ready');
      if (preview && preview.mjpeg_url) setLiveUrl(preview.mjpeg_url);
      const info = [...parsed].reverse().find((p) => p.type === 'source_info');
      if (info) {
        const tf = (info.transfer_function || form.transferFunction || 'sdr').toUpperCase();
        const fps = info.fps == null ? '—' : Number(info.fps).toFixed(2);
        if (backend === 'decklink') {
          const pf = info.pixel_format;
          setDlFmt({
            w: info.width, h: info.height, fps,
            pix: pf === 'v210' ? 'v210 10-bit' : pf === 'uyvy' ? 'UYVY 8-bit'
              : pf ? pf : (info.bit_depth + '-bit'),
            tf,
          });
        } else {
          setNdiFmt({
            w: info.width, h: info.height, fps,
            pix: (info.fourcc || 'Unknown') + ' ' + info.bit_depth + '-bit',
            tf,
            is_hx: !!info.is_hx,
          });
        }
        setSig(info.is_hx ? 'hx' : 'ok');
      }
    }, [liveStream.state.lines, backend]);

    /* 进程退出：cancel 触发的静默；fatal 时从流里取最后一条 error 事件报错。
       其余情况（断流终止、设备暂时打不开）在设备仍选中时 3s 后自动重连监看流。 */
    useEffect(() => {
      const exit = liveStream.state.exit;
      if (!exit || exit.cancelled) return;
      let missing = false;
      if (exit.fatal) {
        const errLine = [...liveStream.state.lines].reverse()
          .map((l) => l.parsed)
          .find((p) => p && p.type === 'error' && p.error);
        const err = errLine && errLine.error;
        missing = !!(err && err.details && err.details.missing);
        if (missing) {
          const parsed = { code: err.code, message: err.message, details: err.details };
          if (backend === 'decklink') { setDlAvail('missing'); setDlError(parsed); }
          else { setNdiAvail('missing'); setNdiError(parsed); }
        }
        if (err && err.message) setSigErr(err.message);
        setSig('nosignal'); setLiveUrl(null);
      } else {
        /* 正常结束（如断流后源终止）：回到等待态，交给自动重连 */
        setSig('waiting'); setLiveUrl(null);
      }
      if (missing) return;                 /* SDK/模块缺失：重试无意义 */
      const dev = form.device;
      if (!dev) return;
      const t = setTimeout(() => { void startMonitor(dev); }, 3000);
      return () => clearTimeout(t);
    }, [liveStream.state.exit]);

    /* backend 切换：拆掉当前监看流。卸载时同样取消（读 ref 避免 stale）。 */
    useEffect(() => {
      if (liveTaskRef.current) { void cancelSidecarTask(liveTaskRef.current); setLiveTask(null); }
      setLiveUrl(null); setSigErr(null);
    }, [backend]);
    useEffect(() => () => { if (liveTaskRef.current) void cancelSidecarTask(liveTaskRef.current); }, []);

    /* enumerate 在途中用户可能改选源——「已选源是否消失」须读最新值，不能用闭包里的 ndiSel */
    const ndiSelRef = useRef(ndiSel);
    ndiSelRef.current = ndiSel;
    const discoverNdi = async () => {
      setEnumSt('loading'); setNdiError(null);
      try {
        const result = await enumerateVideoSources('ndi', 3);
        const sources = result.sources || [];
        setNdiSrcs(sources); setNdiAvail('ok');
        setEnumSt(sources.length ? 'ready' : 'empty');
        const selected = ndiSelRef.current;
        if (selected && !sources.some((source) => source.name === selected)) {
          setNdiSel(null); setNdiFmt(null); setLiveUrl(null);
          if (liveTaskRef.current) { void cancelSidecarTask(liveTaskRef.current); setLiveTask(null); }
        }
      } catch (error) {
        const parsed = parseSidecarError(error);
        setNdiError(parsed);
        if (parsed.details && parsed.details.missing) setNdiAvail('missing');
        else setNdiAvail('ok');
        setNdiSrcs([]); setEnumSt('empty'); setLiveUrl(null);
      }
    };

    const discoverUvc = async () => {
      setEnumSt('loading'); setUvcError(null);
      try {
        const out = await spawnSidecar('vpcal', ['capture', 'list-devices', '--backend', 'uvc', '--output', 'json']);
        const env = parseEnvelope(out.stdout);
        if (out.exit_code !== 0 || (env && env.status === 'error')) throw new Error((env && env.error && env.error.message) || out.stderr || ('exit ' + out.exit_code));
        const data = env && env.data != null ? env.data : env;
        const rows = Array.isArray(data) ? data : ((data && (data.devices || data.sources)) || []);
        const devs = rows.filter((d) => d && d.available !== false).map((d) => ({
          id: String(d.index), index: d.index, width: d.width, height: d.height, fps: d.fps,
        }));
        setUvcDevs(devs); setEnumSt(devs.length ? 'ready' : 'empty');
        if (devs.length && !devs.some((d) => d.id === String(form.device))) {
          setUvcSel(devs[0].id); set('device', devs[0].id);
        }
      } catch (e) {
        setUvcDevs([]); setEnumSt('empty'); setUvcError(e && e.message ? e.message : String(e));
      }
    };

    /* 已选卡/口在途重枚举后可能消失——读最新值判断 */
    const dlSelRef = useRef({ card: dlCard, line: dlLine });
    dlSelRef.current = { card: dlCard, line: dlLine };
    const discoverDecklink = async () => {
      setEnumSt('loading'); setDlError(null);
      try {
        const result = await enumerateVideoSources('decklink');
        const devs = result.sources || [];
        setDlDevs(devs); setDlAvail('ok');
        setEnumSt(devs.length ? 'ready' : 'empty');
        const sel = dlSelRef.current;
        const card = sel.card != null ? devs.find((d) => String(d.index) === sel.card) : null;
        if (sel.card != null && !card) {
          setDlCard(null); setDlLine(null); setDlFmt(null);
        }
      } catch (error) {
        const parsed = parseSidecarError(error);
        setDlError(parsed);
        if (parsed.details && parsed.details.missing) setDlAvail('missing');
        else setDlAvail('ok');
        setDlDevs([]); setEnumSt('empty');
      }
    };

    useEffect(() => {
      if (backend === 'uvc' && !uvcDevs.length && !uvcError) void discoverUvc();
      if (backend === 'ndi' && ndiAvail === 'unknown') void discoverNdi();
      if (backend === 'decklink' && dlAvail === 'unknown') void discoverDecklink();
    }, [backend, ndiAvail, dlAvail]);

    /* 当前选中设备的 fmt（信号信息条来源） */
    const curFmt = (() => {
      if (backend === 'uvc') return ndiFmt;
      if (backend === 'ndi') return ndiFmt;
      if (backend === 'decklink') return dlFmt;
      return null;
    })();
    const ndiIsHx = backend === 'ndi' && !!(ndiFmt && ndiFmt.is_hx);
    const effSig = ndiIsHx ? 'hx' : sig;
    const hasDevice = backend === 'uvc' ? !!String(form.device || '')
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
        off ? h(SdkPop, { backend: b.id, message: b.id === 'ndi' && ndiError ? ndiError.message : b.id === 'decklink' && dlError ? dlError.message : null,
          onUseUvc: () => { setSdkAll(false); set('videoBackend', 'uvc'); } }) : null);
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
        /* decklink 枚举真的报错（驱动/COM 失败，非「未装模块」）时，dlAvail 仍是
           'ok'（tile 不 off，SdkPop 不渲染），得在这里把真实错误露出来，否则用户
           只看到笼统的「未发现设备」而错过真正原因。 */
        const dlErrored = backend === 'decklink' && dlAvail === 'ok' && dlError && dlError.message;
        const enumError = backend === 'uvc' ? uvcError : dlErrored ? dlError.message : null;
        selector = h('div', { className: 'vs-enum-state' },
          h('span', { className: 'vs-enum-ic' }, h(Icon, { name: 'alert', size: 15 })),
          h('div', { className: 'vs-enum-tx' }, h('div', { className: 'vs-enum-t' }, enumError ? '枚举失败' : '未发现设备'),
            h('div', { className: 'vs-enum-d' }, enumError || (backend === 'ndi' ? '本网络内没有可见的 NDI 源' : '没有探测到可打开的采集设备；可刷新或手动输入 index'))),
          h('div', { className: 'vs-enum-acts' },
            h('button', { className: 'vs-icbtn', title: '刷新', onClick: backend === 'ndi' ? discoverNdi : backend === 'decklink' ? discoverDecklink : discoverUvc }, h(Icon, { name: 'sync', size: 15 })),
            h('button', { className: 'vs-icbtn', style: { width: 'auto', padding: '0 10px', fontSize: 11.5, fontWeight: 700, gap: 6 }, onClick: () => setManual(true) },
              h(Icon, { name: 'sliders', size: 13 }), '手动输入')));
      } else if (backend === 'decklink') {
        const card = dlDevs.find((x) => String(x.index) === dlCard);
        const conns = (card && card.connectors) || [];
        /* 选卡：单口自动选中并直接探测；多口留待用户选 */
        const pickCard = (id) => {
          const dev = dlDevs.find((x) => String(x.index) === id);
          const cs = (dev && dev.connectors) || [];
          setDlCard(id); setDlFmt(null);
          if (cs.length === 1) {
            const only = cs[0].id; const d = id + ':' + only;
            setDlLine(only); set('device', d); void startMonitor(d);
          } else {
            setDlLine(null);
            /* 无 connector 信息（少见）：仍可仅按 index 起监看 */
            if (cs.length === 0) { set('device', id); void startMonitor(id); }
          }
        };
        selector = h('div', { className: 'vs-two' },
          h('div', { className: 'vs-two-col' },
            h('div', { className: 'vs-two-lbl' }, '① 采集卡'),
            h(Select, {
              open: dlCardOpen, setOpen: setDlCardOpen, icon: 'cpu', placeholder: '选择采集卡…',
              value: card ? h(React.Fragment, null, h('span', { className: 'nm' }, card.name), h('span', { className: 'idx' }, '#' + card.index)) : null,
              options: dlDevs.map((c) => ({ id: String(c.index), node: h('div', { className: 'vs-opt-meta' },
                h('div', { className: 'vs-opt-n' }, c.name, h('span', { className: 'idx' }, '#' + c.index)),
                h('div', { className: 'vs-opt-s' }, ((c.connectors && c.connectors.length) || 0) + ' 路输入')) })),
              selId: dlCard, onPick: pickCard,
            })),
          h('div', { className: 'vs-two-col' },
            h('div', { className: 'vs-two-lbl' }, '② 输入口 (connector)'),
            h(Select, {
              open: dlLineOpen, setOpen: setDlLineOpen, icon: 'arrowr', placeholder: card ? (conns.length ? '选择输入口…' : '该卡无可选输入口') : '先选采集卡',
              disabled: !card || conns.length === 0,
              value: (() => { const l = conns.find((x) => x.id === dlLine); return l ? h('span', { className: 'nm' }, l.name) : null; })(),
              options: conns.map((l) => ({ id: l.id, node: h('div', { className: 'vs-opt-meta' },
                h('div', { className: 'vs-opt-n' }, l.name), h('div', { className: 'vs-opt-s' }, l.id)) })),
              selId: dlLine, onPick: (id) => { const dev = dlCard + ':' + id; setDlLine(id); setDlFmt(null); set('device', dev); void startMonitor(dev); },
            })));
      } else if (backend === 'uvc') {
        const d = uvcDevs.find((x) => x.id === uvcSel);
        selector = h('div', { className: 'vs-devrow' },
          h(Select, {
            open: uvcOpen, setOpen: setUvcOpen, icon: 'camera', placeholder: '选择摄像头…', grow: true,
            value: d ? h(React.Fragment, null, h('span', { className: 'nm' }, '设备名不可用（探测模式）'), h('span', { className: 'idx' }, '#' + d.id)) : null,
            options: uvcDevs.map((x) => ({ id: x.id, node: h('div', { className: 'vs-opt-meta' },
              h('div', { className: 'vs-opt-n' }, '设备名不可用（探测模式）', h('span', { className: 'idx' }, '#' + x.id)),
              h('div', { className: 'vs-opt-s' }, (x.width || '—') + '×' + (x.height || '—') + ' · ' + (x.fps == null ? 'fps n/a' : Number(x.fps).toFixed(2) + ' fps'))) })),
            selId: uvcSel, onPick: (id) => { setUvcSel(id); set('device', id); void startMonitor(id); },
            manualLabel: '手动输入索引 / URL / 路径…', onManual: () => setManual(true),
          }),
          h('button', { className: 'vs-icbtn', title: '重新真探测', onClick: discoverUvc }, h(Icon, { name: 'sync', size: 15 })));
      } else { /* ndi */
        const d = ndiSrcs.find((x) => x.name === ndiSel);
        selector = h('div', { className: 'vs-devrow' },
          h(Select, {
            open: ndiOpen, setOpen: setNdiOpen, icon: 'net', placeholder: '选择 NDI 源…', grow: true,
            value: d ? h(React.Fragment, null, h('span', { className: 'nm' }, d.name), ndiIsHx ? h('span', { className: 'vs-opt-warn' }, h(Icon, { name: 'alert', size: 10 }), 'HX') : null) : null,
            options: ndiSrcs.map((x) => ({ id: x.name, node: h('div', { className: 'vs-opt-meta' },
              h('div', { className: 'vs-opt-n' }, x.name), h('div', { className: 'vs-opt-s' }, '通过 NDI SDK 网络发现')) })),
            selId: ndiSel, onPick: (name) => { setNdiSel(name); setNdiFmt(null); set('device', name); void startMonitor(name); },
            manualLabel: '手动输入 NDI 源名…', onManual: () => setManual(true),
          }),
          h('button', { className: 'vs-icbtn', title: '重新发现', onClick: discoverNdi }, h(Icon, { name: 'sync', size: 15 })));
      }
    }

    const manualRow = manual && backend !== 'synthetic' && enumSt !== 'loading' ? h('div', { className: 'vs-manual' },
      h('input', { className: 'cap-tf', autoFocus: true, placeholder: backend === 'ndi' ? '机器名 (源名)' : backend === 'decklink' ? 'index[:connector] 如 0:sdi' : '设备索引 / URL / 路径',
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
          liveUrl ? h('img', { className: 'vs-frame', src: liveUrl, alt: '视频源实时监看帧' }) : h(Frame, { state: effSig === 'hx' ? 'ok' : effSig }),
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
          h('div', null, h('b', null, '无信号。'), ' 设备打不开或已断流。确认设备未被其他程序占用，检查连线后刷新。',
            sigErr ? h('div', { style: { marginTop: 4, fontFamily: 'var(--font-code)', fontSize: 11, opacity: 0.85, wordBreak: 'break-all' } }, sigErr) : null)) : null);
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
  function SdkPop({ backend, message, onUseUvc }) {
    const meta = backend === 'ndi'
      ? { title: 'NDI 后端不可用', need: message || h(React.Fragment, null, 'vpcal sidecar 缺少 ', h('code', null, 'cyndilib / NDI Runtime'), '。'),
          how: '重新安装包含 vpcal[ndi] 的 Volo sidecar 后重启。cyndilib 的受支持 wheel 已内置 NDI Runtime。' }
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
