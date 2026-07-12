// @ts-nocheck
/* Volo — Cache · DDC 管理 (§6) — 折叠子菜单分视图：ZenServer / 文件系统 DDC / DDC PAK / PSO.
   1:1 port of the Claude Design handoff `src/cache_ddc.jsx`（检查器重构版），接真实后端。

   ZenServer / 文件系统 DDC 仍是整页视图；DDC PAK 改为「主视图(选工程) + 右侧检查器(操作)」
   的细节显示模式：
   - 主视图(center)只负责发现 / 选择工程（PAK 多选），选择提到 shell（s.pakSel）；
   - 选中工程、生成 / 校验 / 收集 / 分发等操作，全部在右侧检查器(inspector)里就地展开，不再弹滑窗。
   center 走 ddc(s)，inspector 走 detail(s)；两栏读同一份 shell 选择状态。
   PSO 缓存已改为「上场就绪保障」Dashboard（矩阵 + 驱动缓存 + 历史 + 告警 + 巡检）与设置两个
   子视图，逻辑与 window.VOLO_CACHE_PSO_DASH 导出全部迁至 cachePsoDash.tsx；s.psoSel 语义也随之
   改为绿灯矩阵选中的单元格 {proj,node}（不再是单选工程 id），见该文件顶部注释。 */
import * as React from "react";
import "../ds";
import "./cache";
import { deleteShare as deleteShareCmd, teardownShare, createShare,
  generateDdcPak,
  setMachineEnvVar, getMachineEnvVar, createLocalCache,
  prepareManagedShareClients, unprepareManagedShareClients,
  prepareOpenShareClients, unprepareOpenShareClients,
  setMachineBackendField, removeMachineBackendField,
  revealPath } from "../api/commands";
import {
  pickSrc, openFolder as openFolderShared, clusterGate,
} from "./cacheProjectScan";

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect, useRef } = React;
  const h = React.createElement;
  const CX = window.VOLO_CX;
  const Selector = window.Selector;

  /* 无可用源机时，派一个立即失败的任务给可见反馈，而不是静默 return（按钮点了像没反应）。 */
  const noSrcFail = (s, domain, action, p) =>
    s.runCmd({ domain, action, target: p.name, chan: 'ssh', note: domain + ' ' + action + ' · ' + p.name },
      () => Promise.reject(new Error('该工程没有可用的在线源机器')), {}).catch(() => {});

  /* DDC 页打开文件夹时日志 cat 仍标 ddc（控制台过滤习惯）。 */
  const openFolder = (s, path, label, machine) => openFolderShared(s, path, label, machine, 'ddc');

  /* UeRunnerEvent reduce（generate_ddc_pak 进度流）.
     payload = {job_id, source_machine_id, project_id, event:UeRunnerEvent}，
     event 是 tag='kind' 的联合。pct 量纲不定（0..1 或 0..100），<=1 视为比例 *100。 */
  const ueLineLv = (pk) => pk && /error/i.test(pk) ? 'err' : pk && /warn/i.test(pk) ? 'warn' : 'info';
  const ueProgressReduce = (p, terminalOnCompleted) => {
    const e = p && p.event ? p.event : {};
    switch (e.kind) {
      case 'spawned':   return { pct: 8, log: { lv: 'info', msg: '已启动 · pid ' + e.pid } };
      case 'log_line':  return e.parsed_kind
        ? { log: { lv: ueLineLv(e.parsed_kind), msg: e.text } }
        : {}; /* 只转发有 parsed_kind 的行：DDC fill 全量 UE 日志逐行进控制台会把
                 WebView 主线程打满（每行一次 setLogs + LogPanel 全量重渲染），App 卡死 */
      case 'progress': {
        const pct = e.pct == null ? null : (e.pct <= 1 ? e.pct * 100 : e.pct);
        return { pct: terminalOnCompleted ? pct : (pct == null ? null : Math.min(96, pct)), log: e.label ? { lv: 'info', msg: e.label } : null };
      }
      case 'completed':
        return terminalOnCompleted
          ? { done: true, ok: e.exit_code === 0, exit: e.exit_code, log: { lv: e.exit_code === 0 ? 'ok' : 'err', msg: '退出码 ' + e.exit_code } }
          : { pct: 96, log: { lv: 'info', msg: 'UE 进程结束（退出码 ' + e.exit_code + '）· 汇总缓存…' } };
      case 'cancelled': return { done: true, ok: false, canceled: true, log: { lv: 'warn', msg: '已取消' } };
      case 'error':     return { done: true, ok: false, exit: 2, log: { lv: 'err', msg: e.message } };
      default:          return {};
    }
  };
  /* generate：exit_code 只说明 UE 进程退出，不代表 pak 真的写出——以 pak-verified 的真实
     校验结果收尾（后端 completed 之后总会紧跟着发一条 pak-verified，即便 exit_code≠0 也会
     发 verified:false，故这里必收得到）。旧版以 completed 的 exit_code 收尾、校验只是
     best-effort 日志，靠检查器手动「校验产物」兜底 exit=0 但 DDC.ddp 缺失的情况；该按钮
     已随双栏重构下线，故改为直接等 pak-verified 才是终态，避免误报成功。cancelled/error
     仍在 completed 之前就终止（ueProgressReduce 对它们恒返回 done，不受下面这个 false 影响）。 */
  const genReduce = (ev, p) => ev === 'pak-verified'
    ? { done: true, ok: !!p.verified, exit: p.verified ? 0 : 2,
        log: { lv: p.verified ? 'ok' : 'err', msg: '产物校验 ' + (p.verified ? '通过' : '未通过') + (p.output && p.output.path ? (' · ' + p.output.path) : '') } }
    : ueProgressReduce(p, false);
  /* 分发流（pak / pso-distribute-progress）共用：payload {…, event:BatchEvent}，
     BatchEvent {machine_id, status:'running'|'ok'|'err', message}。无「全部完成」哨兵事件
     → 数到 st.total（=plan 长度）个终态(ok|err)即收尾，期间任一 err 则整体失败。 */
  const batchReduce = (ev, p, st) => {
    const e = p && p.event ? p.event : {};
    st.terminal = st.terminal || new Set();
    st.frac = st.frac || {}; /* machine_id -> 0..1 字节进度（push 传输轮询事件 "bytes:cur/total"）*/
    const mid = e.machine_id;
    if (e.status === 'running') {
      /* push 传输的字节进度：message = "bytes:<cur>/<total>"。整体 pct =
         (终态机器数 + 传输中机器的字节占比之和) / 总机器数 → 右下角进度条真实推进。 */
      const m = /^bytes:(\d+)\/(\d+)$/.exec(e.message || '');
      if (m && st.total) {
        const frac = Number(m[2]) > 0 ? Math.min(1, Number(m[1]) / Number(m[2])) : 0;
        st.frac[mid] = Math.max(st.frac[mid] || 0, frac);
        let sum = st.terminal.size;
        Object.keys(st.frac).forEach((k) => { if (!st.terminal.has(Number(k))) sum += st.frac[k]; });
        return { pct: sum / st.total * 100 };
      }
      return { log: { lv: 'info', msg: '分发中 · 机器 ' + mid } };
    }
    if (e.status === 'ok' || e.status === 'err') {
      st.terminal.add(mid);
      if (e.status === 'err') st.anyErr = true;
      const done = st.total != null && st.terminal.size >= st.total;
      const pct = st.total ? (st.terminal.size / st.total * 100) : null;
      return {
        pct, done,
        ok: done ? !st.anyErr : undefined,
        exit: done && st.anyErr ? 2 : 0,
        log: e.status === 'ok'
          ? { lv: 'ok', msg: '机器 ' + mid + ' 完成' }
          : { lv: 'err', msg: '机器 ' + mid + ' 失败 · ' + (e.message || '') },
      };
    }
    return {};
  };

  /* =================== 共享选项构造 =================== */

  /* three-channel gate：DDC 视图建立在真实机器 id 上，未就绪时不渲染 body。 */
  function gate(s) {
    return clusterGate(s, '集群里还没有机器 — 先在「集群总览」扫描添加机器，再配置 DDC');
  }

  /* generate_ddc_pak（流式）：源机取工程 primary（检查器无 src 选择器）；invoke 的
     ExecutionLocation='remote' 是执行位置（远端源机 vs 操作员本机），与工程的缓存路由（zen/legacy_pak）
     无关——任意路由都直接生成 PAK，不再需要先切工程后端；ue_version null；
     真正终态是 pak-verified（见 genReduce），不是 completed。 */
  /* 返回值等待真实终态，不是 kickoff 落地就 resolve——runStreamingCmd 的 promise 只在
     kickoff 成功后立刻 resolve（沿用 launchWarmup 的既定语义：kickoff 落地即返回，真正
     完成走 wiring.onDone），这里包一层 Promise 让 onDone 驱动 resolve/reject，
     cacheDdcPak.tsx 的生成对话框才能真正串行等每个工程完成再推进下一个。kickoff 阶段
     失败（IPC/网络错误）由 runStreamingCmd 自身 reject，直接转发。无源机走 noSrcFail
     留痕后仍需 reject，调用方才能把该工程记为失败而非误判成功。 */
  const genPak = (s, p) => {
    const src = pickSrc(p);
    if (!src) return noSrcFail(s, 'ddc', 'generate', p).then(() => { throw new Error('该工程没有可用的在线源机器'); });
    return new Promise((resolve, reject) => {
      s.runStreamingCmd(
        { domain: 'ddc', action: 'generate', target: p.name, chan: 'ssh', note: '生成 DDC PAK · ' + p.name + '（长任务）· 源 ' + src.host, quiet: true },
        () => generateDdcPak('remote', Number(p.id), src.machineId, null, null, null, null),
        { mode: 'event', events: ['ue-runner-progress', 'pak-verified'], jobIdOf: (r) => r.job_id, reduce: genReduce, timeoutMs: 45 * 60 * 1000,
          onDone: (ok) => { if (ok) resolve(); else reject(new Error('DDC PAK 生成失败，详见控制台日志')); } })
        .catch(reject);
    });
  };

  /* =================== 主视图共用工程行（master list）=================== */
  /* p.thumb/thumbFrom/thumbSrc（若有）由调用方按需懒加载后 merge 进传入的 project 对象
     （见 cacheDdcPak.tsx）——projRow 本身不发起任何缩略图请求。s 缺省时（PSO 主视图那处
     调用）跳过「打开文件夹」：既不取源机、也不渲染缩略图态，行为与改动前一致。 */
  function projRow(p, selected, onClick, s) {
    const src = s ? pickSrc(p) : null;
    const path = (src && p.locByMachine && p.locByMachine[String(src.machineId)]) || p.root;
    return h('div', { key: p.id, className: 'proj-row' + (selected ? ' on' : ''), onClick: () => onClick(p) },
      h('span', { className: 'proj-mck' + (selected ? ' on' : '') }, selected ? h(Icon, { name: 'check', size: 12 }) : null),
      h('span', { className: 'proj-ico' + (p.thumb ? ' has-thumb' : ''),
          title: p.thumb ? ('缩略图来源 · ' + (p.thumbFrom || '') + '\n' + (p.thumbSrc || '')) : null },
        p.thumb
          ? h('img', { className: 'proj-thumb', src: p.thumb, alt: '', draggable: false })
          : h(Icon, { name: 'film', size: 17 })),
      h('div', { className: 'proj-main' },
        h('div', { className: 'proj-name' }, p.name),
        h('button', { type: 'button', className: 'proj-sub proj-sub-open mono', title: '在文件资源管理器中打开工程文件夹',
            onClick: (e) => { e.stopPropagation(); s && openFolder(s, path, p.name, src); } },
          h('span', { className: 'proj-sub-tx' }, path + '\\' + p.uproject),
          h('span', { className: 'proj-sub-ico' }, h(Icon, { name: 'folder', size: 12 })))),
      h('div', { className: 'proj-tags' },
        h('span', { className: 'proj-tag ue' }, 'UE ' + p.ue),
        h('span', { className: 'proj-tag' }, p.size),
        h('span', { className: 'proj-tag' }, (p.machines || []).length + ' 台'),
        p.hasPak ? h('span', { className: 'proj-tag pak' }, h(Icon, { name: 'check', size: 10 }), '已有 PAK') : null,
        p.warn ? h('span', { className: 'proj-tag warn', title: p.warn }, h(Icon, { name: 'alert', size: 10 }), '版本不一致') : null));
  }

  /* =================== 搜索根目录 · 快捷选择 + 路径栏 =================== */
  const DRIVE_OPTS = [
    { v: 'C:', label: 'C 盘' }, { v: 'D:', label: 'D 盘' },
    { v: 'E:', label: 'E 盘' }, { v: 'F:', label: 'F 盘' },
  ];
  const LVL_PRESETS = [
    ['UEProject', 'Projects', 'Work'],
    ['Unreal Project', 'UE Project', 'Client'],
    ['Project', 'Content', 'Build'],
  ];

  /* 单个下拉段：预设列表 + 「自定义…」→ 就地输入 */
  function PathSeg({ kpre, value, custom, opts, placeholder, onPick, width = 168 }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
      if (!open) return;
      const f = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
      document.addEventListener('mousedown', f);
      return () => document.removeEventListener('mousedown', f);
    }, [open]);
    const norm = opts.map((o) => (typeof o === 'string' ? { v: o, label: o } : o));
    const match = norm.find((o) => o.v === value);
    const disp = value ? (match ? match.label : value) : '';
    return h('div', { className: 'pathb-seg', ref, style: { width } },
      custom
        ? h('div', { className: 'pathb-cwrap' },
            h('input', { className: 'dp-input mono pathb-cin', value, placeholder: placeholder || '手动输入', spellCheck: false, autoFocus: true,
              onChange: (e) => onPick(e.target.value, true) }),
            h('button', { className: 'pathb-cchev' + (open ? ' on' : ''), type: 'button', title: '选择预设', onClick: () => setOpen((v) => !v) },
              h(Icon, { name: 'chevd', size: 14 })))
        : h('div', { className: 'obj-sel pathb-sel', onClick: () => setOpen((v) => !v) },
            h('div', { className: 'col' }, h('span', { className: 'k' }, kpre),
              h('span', { className: 'v' + (disp ? '' : ' ph') }, disp || placeholder)),
            h('span', { className: 'chev', style: { marginLeft: 'auto', display: 'flex' } }, h(Icon, { name: 'chevd', size: 14 }))),
      open ? h('div', { className: 'popover pathb-pop', style: { left: 0, right: 'auto' } },
        norm.map((o) => h('div', { key: o.v, className: 'pop-i' + (!custom && o.v === value ? ' on' : ''),
          onClick: () => { onPick(o.v, false); setOpen(false); } },
          h('span', { className: 'pop-l' }, o.label),
          !custom && o.v === value ? h('span', { style: { marginLeft: 'auto', color: 'var(--volo-500)', display: 'flex' } }, h(Icon, { name: 'check', size: 14 })) : null)),
        h('div', { className: 'pop-i pathb-customopt' + (custom ? ' on' : ''), onClick: () => { onPick(value || '', true); setOpen(false); } },
          h('span', { className: 'pop-l' }, '自定义…'),
          custom ? h('span', { style: { marginLeft: 'auto', color: 'var(--volo-500)', display: 'flex' } }, h(Icon, { name: 'check', size: 14 })) : null)) : null);
  }

  /* 搜索根目录构建器：上=快捷选择，下=实时路径栏（可手动改）*/
  function PathBuilder({ onChange, initDrive = 'D:', initLvls = ['UEProject', '', ''], onRemove }) {
    const [drive, setDrive] = useState(initDrive);
    const [driveCustom, setDriveCustom] = useState(false);
    const [lvls, setLvls] = useState(initLvls);
    const [lvlCustom, setLvlCustom] = useState([false, false, false]);
    const [manual, setManual] = useState(null);   /* null → 跟随快捷选择 */

    const compose = (d, ls) => {
      const parts = ls.filter((x) => x && x.trim());
      return (d || '') + (parts.length ? '\\' + parts.join('\\') : '\\');
    };
    const composed = compose(drive, lvls);
    const shown = manual == null ? composed : manual;
    useEffect(() => { onChange(shown); }, [shown]);

    const pickDrive = (v, c) => { setManual(null); setDrive(v); setDriveCustom(c); };
    const pickLvl = (i, v, c) => {
      setManual(null);
      setLvls((a) => a.map((x, j) => (j === i ? v : x)));
      setLvlCustom((a) => a.map((x, j) => (j === i ? c : x)));
    };

    return h('div', { className: 'pathb' },
      h('div', { className: 'pathb-quick' },
        h(PathSeg, { kpre: '盘符', value: drive, custom: driveCustom, opts: DRIVE_OPTS, placeholder: '盘符', width: 118, onPick: pickDrive }),
        [0, 1, 2].map((i) => h(React.Fragment, { key: i },
          h('span', { className: 'pathb-sep' }, '\\'),
          h(PathSeg, { kpre: (i + 1) + ' 级文件夹', value: lvls[i], custom: lvlCustom[i], opts: LVL_PRESETS[i],
            placeholder: i === 0 ? '选择文件夹' : '（可选）', width: 176, onPick: (v, c) => pickLvl(i, v, c) })))),
      h('div', { className: 'pathb-bar' },
        h('span', { className: 'pathb-bar-ic' }, h(Icon, { name: 'folder', size: 15 })),
        h('input', { className: 'dp-input mono pathb-bar-in' + (onRemove ? ' has-rm' : ''), value: shown, spellCheck: false,
          onChange: (e) => setManual(e.target.value) }),
        manual != null
          ? h('button', { className: 'pathb-reset', title: '恢复跟随快捷选择', onClick: () => setManual(null) }, h(Icon, { name: 'rotate', size: 13 }))
          : h('span', { className: 'pathb-live' }, h('span', { className: 'pathb-live-dot' }), '实时'),
        onRemove ? h('button', { className: 'pathb-rm', title: '移除此地址', onClick: onRemove }, h(Icon, { name: 'x', size: 14 })) : null));
  }

  /* 多地址：可添加 / 移除多条搜索根目录，最终以 ; 拼接 */
  let PATHB_UID = 0;
  function PathBuilderList({ onChange }) {
    const [rows, setRows] = useState(() => [{ id: ++PATHB_UID, initDrive: 'D:', initLvls: ['UEProject', '', ''] }]);
    const vals = useRef({});
    const emit = () => onChange(rows.map((r) => vals.current[r.id]).filter((x) => x && x.trim()).join(';'));
    useEffect(() => { emit(); }, [rows]);
    const setVal = (id, v) => { vals.current[id] = v; emit(); };
    const add = () => setRows((rs) => rs.concat({ id: ++PATHB_UID, initDrive: 'D:', initLvls: ['', '', ''] }));
    const remove = (id) => setRows((rs) => { delete vals.current[id]; return rs.filter((r) => r.id !== id); });
    return h('div', { className: 'pathb-list' },
      rows.map((r, i) => h('div', { className: 'pathb-rowwrap', key: r.id },
        rows.length > 1 ? h('span', { className: 'pathb-idx mono' }, i + 1) : null,
        h(PathBuilder, { onChange: (v) => setVal(r.id, v), initDrive: r.initDrive, initLvls: r.initLvls,
          onRemove: rows.length > 1 ? () => remove(r.id) : null }))),
      h('button', { className: 'pathb-add', type: 'button', onClick: add },
        h(Icon, { name: 'plus', size: 14 }), '添加地址'));
  }

  /* =================== 文件系统 DDC（本地 + 共享）— 双列视图，接真实后端 ===================
     左列：① 共享 DDC（SMB）服务器部署 + 已纳管共享 + ② 其他服务器加入共享 DDC（写环境变量 + 工程 INI）。
     右列：③ 本地 DDC（统一路径一键 + 逐台 + 多选批量）。
     部署 / 加入类动作「直接执行」：点击即跑真实命令，期间显示「部署中…/加入中…」徽标，任务真正落地
     （promise resolve）后才翻状态——不再走 openPreview 确认门。① 服务器创建（create_share）/ 拆除
     （teardown_share）/ 解除纳管（delete_share）仍走确认门（破坏性、影响整集群）。
     localDeployed / shareJoined 无 NodeVM 字段，挂载时对在线机 fan-out 读 UE-Local/SharedDataCachePath
     得真实状态（statusLoading 期间徽标显示「读取中…」，不假报「未部署」）。 */
  function LegacyView({ s }) {
    const [srv, setSrv] = useState('rn0');
    const [localDirs, setLocalDirs] = useState(() => {
      const m = {};
      RENDER_NODES.forEach((n) => { const drv = /^([A-Za-z]):/.test(n.uePath) ? n.uePath[0].toUpperCase() : 'D'; m[n.id] = drv + ':\\UE_DDC\\Local'; });
      return m;
    });
    const [localDeployed, setLocalDeployed] = useState([]);   /* 节点 id：本地 DDC 已部署（真实 env 读得）*/
    const [shareJoined, setShareJoined] = useState({});       /* 节点 id -> 当前已指向的共享路径（真实 env 读得）*/
    const [statusLoading, setStatusLoading] = useState(true); /* 初始 env-var 状态读取中 */
    const [selLocal, setSelLocal] = useState([]);             /* 多选批量部署 / 取消部署的勾选集 */
    const [localPending, setLocalPending] = useState({});     /* 节点 id -> 'deploy' | 'undeploy' */
    const [joinPending, setJoinPending] = useState({});       /* 节点 id -> 'join' | 'leave' */
    const [joinTarget, setJoinTarget] = useState(null);       /* 选中要加入哪个共享服务器（share id）*/
    const [commonLocalDir, setCommonLocalDir] = useState('D:\\UE_DDC\\Local');
    /* ③ 本地 DDC · 每台机器的「DDC 配置通道详情」（ini/命令行/注册表/环境变量四条通道）
       + 展开 / 刷新态。chanData：节点 id -> channelsFor() 结果（键不存在=从未拉取过；
       null=离线或拉取失败；否则为四通道数据）。chanLoadingIds 是「首次展开自动拉取」的
       单机 loading 态（未刷新过就展开也该显示 skeleton，而不是误报「离线」）；
       chanRefreshing 是模块头部「刷新状态」批量刷新的全局 loading 态，两者在 ChanPanel
       里合并成一个 loading 布尔。 */
    const CHAN = window.VOLO_DDC_CHAN;
    const [chanExpanded, setChanExpanded] = useState(() => new Set());
    const [chanData, setChanData] = useState({});
    const [chanLoadingIds, setChanLoadingIds] = useState(() => new Set());
    const [chanRefreshing, setChanRefreshing] = useState(false);
    /* 节点 id -> 代次令牌：每次为该节点起一次读（单机首展开 / 批量刷新）或成功提交一次
       编辑都会 bump；读取 resolve 时若代次已被更晚的读或编辑抢先，直接丢弃（同 readStatus
       的 readGenRef 手法，按节点粒度）——否则「刷新状态」批量读的旧快照可能在编辑提交
       之后才 resolve，把刚保存的值覆盖回旧值。 */
    const chanGenRef = useRef({});
    const bumpChanGen = (id) => { chanGenRef.current[id] = (chanGenRef.current[id] || 0) + 1; return chanGenRef.current[id]; };
    const fetchChanOne = (n) => {
      const gen = bumpChanGen(n.id);
      setChanLoadingIds((prev) => { const s = new Set(prev); s.add(n.id); return s; });
      return CHAN.channelsFor(n)
        .then((ch) => ch, () => null)
        .then((ch) => {
          if (chanGenRef.current[n.id] === gen) setChanData((prev) => Object.assign({}, prev, { [n.id]: ch }));
          setChanLoadingIds((prev) => { const s = new Set(prev); s.delete(n.id); return s; });
        });
    };
    const toggleChan = (n) => {
      setChanExpanded((prev) => { const s = new Set(prev); s.has(n.id) ? s.delete(n.id) : s.add(n.id); return s; });
      if (!chanExpanded.has(n.id) && !(n.id in chanData) && !chanLoadingIds.has(n.id)) fetchChanOne(n);
    };
    /* ② 其他服务器加入共享 DDC · 每台机器的「共享 DDC 配置通道详情」+ 展开态。同 CHAN 一样
       懒加载（首次展开 / 模块「刷新状态」批量刷新才拉取）——不在挂载时对全部机器 eager
       fetch（四路通道 × 每台机每个工程一次 SSH，N 台放大后开销不小）；schanGenRef 独立于
       chanGenRef（两套数据各自的代次令牌，互不干扰）。 */
    const SCHAN = window.VOLO_DDC_SCHAN;
    const [schanExpanded, setSchanExpanded] = useState(() => new Set());
    const [schanData, setSchanData] = useState({});
    const [schanLoadingIds, setSchanLoadingIds] = useState(() => new Set());
    const schanGenRef = useRef({});
    const bumpSchanGen = (id) => { schanGenRef.current[id] = (schanGenRef.current[id] || 0) + 1; return schanGenRef.current[id]; };
    const fetchSchanOne = (n) => {
      const gen = bumpSchanGen(n.id);
      setSchanLoadingIds((prev) => { const s = new Set(prev); s.add(n.id); return s; });
      return SCHAN.channelsForShared(n)
        .then((ch) => ch, () => null)
        .then((ch) => {
          if (schanGenRef.current[n.id] === gen) setSchanData((prev) => Object.assign({}, prev, { [n.id]: ch }));
          setSchanLoadingIds((prev) => { const s = new Set(prev); s.delete(n.id); return s; });
        });
    };
    const toggleSchan = (n) => {
      setSchanExpanded((prev) => { const s = new Set(prev); s.has(n.id) ? s.delete(n.id) : s.add(n.id); return s; });
      if (!schanExpanded.has(n.id) && !(n.id in schanData) && !schanLoadingIds.has(n.id)) fetchSchanOne(n);
    };
    const [schanSel, setSchanSel] = useState([]);   /* ② 无纳管共享形态下批量清除的所选机器 */
    /* 共享创建（create_share）表单：share_name + local_path + mode。 */
    const [shareName, setShareName] = useState('Volo_DDC');
    const [shareLocal, setShareLocal] = useState('D:\\Volo\\DDC');
    const [shareMode, setShareMode] = useState('open'); /* 'open'(Mode A) | 'managed'(Mode B) */
    /* 给 env-read 回填用：lpRef/jpRef 取最新 pending（对「取消部署/退出」进行中的机器跳过旧快照复活）；
       readGenRef 作代次令牌——只应用最新一次读取，丢弃被取代的旧读取（也兼作卸载守卫）。 */
    const lpRef = useRef(localPending); lpRef.current = localPending;
    const jpRef = useRef(joinPending); jpRef.current = joinPending;
    const readGenRef = useRef(0);

    /* 真实状态读取：对在线机 fan-out 读两个 env var → 已部署 / 已加入（NodeVM 不带这两个字段，
       adapter 注释：客户端是否已接入靠 get_machine_env_var 读 UE-SharedDataCachePath）。
       readStatus 同时被「挂载 / 机器集合变化」的 effect 与「刷新状态」按钮调用。 */
    const readStatus = () => {
      const online = RENDER_NODES.filter((n) => n.status !== 'offline' && n.machineId != null && n.machineId !== 0);
      /* online 为空（机器没加载到 / 全部离线）：仅落定 loading，不覆盖式清空——否则抹掉乐观更新；
         陈旧 id 不在 RENDER_NODES 里自然不渲染，无害。 */
      if (!online.length) { setStatusLoading(false); return; }
      const gen = ++readGenRef.current;
      setStatusLoading(true);
      Promise.allSettled(online.map((n) =>
        Promise.allSettled([
          getMachineEnvVar(n.machineId, 'UE-LocalDataCachePath'),
          getMachineEnvVar(n.machineId, 'UE-SharedDataCachePath'),
        ]).then((rs) => ({ id: n.id,
          local: rs[0].status === 'fulfilled' ? rs[0].value : null,
          shared: rs[1].status === 'fulfilled' ? rs[1].value : null }))
      )).then((rs) => {
        if (gen !== readGenRef.current) return; /* 被更新的读取取代（或已卸载）→ 丢弃 */
        const dep = []; const joined = {};
        rs.forEach((r) => { if (r.status === 'fulfilled') { const v = r.value; if (v.local) dep.push(v.id); if (v.shared) joined[v.id] = v.shared; } });
        /* 与乐观更新合并而非覆盖：保留读取期间用户「部署/加入」的乐观结果（prev），不被旧快照刷回；
           同时对「取消部署/退出」进行中的机器，剔除本次旧快照可能复活的项——对称保护两个方向。 */
        const lp = lpRef.current, jp = jpRef.current;
        setLocalDeployed((prev) => {
          const next = new Set(prev.concat(dep));
          Object.keys(lp).forEach((id) => { if (lp[id] === 'undeploy') next.delete(id); });
          return Array.from(next);
        });
        setShareJoined((prev) => {
          const next = Object.assign({}, joined, prev);
          Object.keys(jp).forEach((id) => { if (jp[id] === 'leave') delete next[id]; });
          return next;
        });
        setStatusLoading(false);
      });
    };
    /* 挂载 / 机器集合或在线态变化时自动重读；卸载或重跑时 bump 代次令牌作废在途读取。 */
    const midSig = RENDER_NODES.map((n) => n.id + ':' + n.status).join(',');
    useEffect(() => { readStatus(); return () => { readGenRef.current++; }; /* eslint-disable-line react-hooks/exhaustive-deps */ }, [midSig]);

    const g = gate(s); if (g) return g;

    /* IP 升序：按点分十进制数值比较（非字符串字典序），机器选择器 / 加入列表 / 本地 DDC 列表统一用此序。
       IP 缺失/不合法时排到末尾（Infinity），不与合法的 0.0.0.0 混为一谈排到最前。 */
    const ipVal = (ip) => {
      const octs = String(ip || '').split('.');
      if (octs.length !== 4 || octs.some((o) => o === '' || isNaN(o))) return Infinity;
      return octs.reduce((acc, o) => acc * 256 + parseInt(o, 10), 0);
    };
    const IP_SORTED_NODES = RENDER_NODES.slice().sort((a, b) => ipVal(a.ip) - ipVal(b.ip));

    /* resolve the chosen server to a real node — persisted `srv` may be a stale mock id
       now that machines come from the backend; fall back to an already-deployed shared
       server first（默认展示已部署的服务器，n.share 即 adapters.ts 用同一份 shares 算出的
       托管 unc_path，与「已纳管共享」判定同源），否则退到第一台非共享角色机器。 */
    const deployedNode = IP_SORTED_NODES.find((n) => n.share);
    const sharedNode = CX.node(srv) || deployedNode || IP_SORTED_NODES.find((n) => n.roleKey !== 'shared') || IP_SORTED_NODES[0];
    const srvOpts = IP_SORTED_NODES.map((n) => ({ id: n.id, label: n.host, sub: n.ip }));
    const onlineLocalTargets = IP_SORTED_NODES.filter((n) => n.status !== 'offline');
    const badge = (cls, icon, txt) => h('span', { className: 'cli-badge ' + cls }, h(Icon, { name: icon, size: 11 }), txt);

    /* 路径栏内嵌「在资源管理器中打开」图标按钮（本页四处路径统一复用）：machine 给定时按
       openFolder 同款语义（本机直开 / 远程转 UNC-SMB，跨平台安全）；machine 缺省——「本地 DDC
       统一路径」不对应单台具体机器，只是套用到全部在线机的路径模板——则直接 reveal Volo 自身
       所在机器的路径，不做远程判定。 */
    const openLocalPath = (path, label) => {
      const fail = (e) => s.pushLog({ lv: 'err', cat: 'ddc', ch: 'ssh',
        msg: '打开文件夹失败 · ' + (label || '') + ' · ' + (e && e.message ? e.message : e) });
      const logOk = () => s.pushLog({ lv: 'info', cat: 'ddc', ch: 'ssh',
        msg: '<b>explorer</b> · 在文件资源管理器中打开' + (label ? '（' + label + '）' : '') + ' ' + path });
      revealPath(path).then(logOk, fail);
    };
    const pathOpenBtn = (path, opts) => {
      const o = opts || {};
      return h('button', { type: 'button', className: 'pathio-open' + (o.standalone ? ' standalone' : ''), tabIndex: -1,
        title: '在资源管理器中打开该文件夹', disabled: !!o.disabled || !String(path || '').trim(),
        onClick: () => ('machine' in o ? openFolder(s, path, o.label, o.machine) : openLocalPath(path, o.label)) },
        h(Icon, { name: 'folder', size: 13 }));
    };

    /* ===== ① 共享 DDC（SMB）服务器：创建 / 解除纳管 / 拆除部署（破坏性，走确认门）===== */
    /* 真实 create_share：host=sharedNode.machineId，mode 序列化 'open'|'managed'；
       operator_credential_alias 传 null（SSH key 鉴权）；Mode B 的 svc_username 留空 → 后端默认 'ddc-svc'。 */
    const deploySMB = () => CX.openModalPreview(s, {
      title: '创建共享 DDC（SMB）', icon: 'folder', cli: 'create_share', destructive: false, channel: 'ssh', confirmLabel: '创建共享',
      doneTitle: '已成功部署', doneMsg: sharedNode.host + ' 已设为共享 DDC 服务器 · ' + shareLocal,
      steps: ['在 ' + sharedNode.host + ' 上新建共享缓存文件夹 ' + shareLocal,
        '共享名 ' + shareName + (shareMode === 'managed' ? '（Mode B · 专用账号 ddc-svc）' : '（Mode A · 开放）'),
        '集群缓存指向该共享，其余机器再到「② 其他服务器加入共享 DDC」逐台加入'],
      simpleScope: [{ host: sharedNode.host, ip: sharedNode.ip, msg: shareLocal }],
      run: () => {
        if (!sharedNode || !shareName.trim() || !shareLocal.trim()) return Promise.reject(new Error('缺少服务器机器 / 共享名 / 本地路径'));
        return s.runCmd({ domain: 'share', action: 'create', target: sharedNode.host, chan: 'ssh', note: 'SMB 共享 DDC（' + shareMode + '）' },
          () => createShare(sharedNode.machineId, shareMode, shareName.trim(), shareLocal.trim(), null, null),
          { okMsg: (r) => '共享已创建 · ' + r.unc_path })
          .then((r) => { s.reloadCache(); return r; });
      },
    });
    /* 解除共享 DDC 纳管：仅从 Volo 解除纳管，不删远端共享文件夹（后端暂不支持 also_remove_remote）*/
    const deleteShare = (sh) => CX.openModalPreview(s, {
      title: '解除共享纳管 · ' + sh.path, icon: 'trash', cli: 'delete_share', destructive: true, channel: 'ssh', confirmLabel: '解除纳管',
      doneTitle: '已解除纳管', doneMsg: sh.path + ' 已解除纳管 · 远端文件夹保留',
      steps: ['从 Volo 解除对该共享的纳管（不再分发 / 不再注入客户端）', '不会删除远端共享文件夹本身（后端暂不支持远端删共享）'],
      simpleScope: [{ host: sh.path, ip: sh.clients + ' 客户端', msg: '仅解除纳管' }],
      run: () => {
        if (!sh.shareConfigId) return Promise.reject(new Error('缺少 shareConfigId'));
        return s.runCmd({ domain: 'share', action: 'delete', target: sh.path, chan: 'ssh', note: '解除共享纳管（远端保留）' },
          () => deleteShareCmd(sh.shareConfigId, false), { okMsg: () => sh.path + ' 已解除纳管 · 远端文件夹保留' })
          .then((r) => { s.reloadCache(); return r; });
      },
    });
    /* 该服务器机器当前是否已部署共享（hostId = String(host_machine_id) 与 sharedNode.id 对齐）。 */
    const srvShare = (SHARES || []).find((x) => x.hostId === sharedNode.id);
    /* sharedNode 可能因「默认选已部署服务器」落在一台当前离线的机器上——三通道提示，避免用户在
       不知情时对不可达主机发起 SSH 操作（create_share / teardown_share 会直接失败）。 */
    const sharedOffline = sharedNode.status === 'offline';
    /* 取消该服务器部署（teardown_share）：停止 SMB 共享（Remove-SmbShare）+（Mode B）注销 ddc-svc，
       保留远端文件夹与缓存（keep_files=true）。删 SQLite 行后 reloadCache 把它从列表移除。
       区别于 deleteShare（仅解除纳管，不动远端共享服务）。 */
    const undeploySMB = (sh) => CX.openModalPreview(s, {
      title: '取消该服务器部署 · ' + (sh.host && sh.host !== '—' ? sh.host : sh.path), icon: 'trash', cli: 'teardown_share', destructive: true, channel: 'ssh', confirmLabel: '取消部署',
      doneTitle: '已取消部署', doneMsg: (sh.host && sh.host !== '—' ? sh.host : sh.path) + ' 共享 DDC 部署已取消 · 文件夹保留',
      steps: ['停止并移除该机上的 SMB 共享' + (/Mode B/.test(sh.mode || '') ? '（含注销专用账号 ddc-svc）' : '') + ' —— ' + sh.path,
        '从集群缓存图中摘除该上游，客户端回退到本地 / 其他上游',
        '保留远端共享文件夹与已有缓存文件，不做删除'],
      simpleScope: [{ host: sh.host && sh.host !== '—' ? sh.host : sh.path, ip: sh.clients + ' 客户端', msg: sh.path + ' · 保留文件夹' }],
      run: () => {
        if (!sh.shareConfigId) return Promise.reject(new Error('缺少 shareConfigId'));
        return s.runCmd({ domain: 'share', action: 'teardown', target: sh.host && sh.host !== '—' ? sh.host : sh.path, chan: 'ssh', note: '取消共享 DDC 服务器部署（文件夹保留）' },
          () => teardownShare(sh.shareConfigId, true),
          { okMsg: (r) => (r.host || sh.path) + ' 共享 DDC 部署已取消 · 文件夹保留' })
          .then((r) => { s.reloadCache(); return r; });
      },
    });

    const shareRow = (sh) => h('div', { key: sh.id, className: 'art-row' },
      h('span', { className: 'art-dot s-' + (sh.status === 'healthy' ? 'positive' : 'notice') }, h(Icon, { name: 'folder', size: 12 })),
      h('div', { className: 'art-meta' },
        h('div', { className: 'art-name mono' }, sh.path,
          sh.host && sh.host !== '—' ? h('span', { className: 'share-host' }, h(Icon, { name: 'server', size: 11 }), sh.host) : null),
        h('div', { className: 'art-sub' }, sh.mode + ' · ' + sh.clients + ' 客户端 · ' + sh.size)),
      h('button', { className: 'mini-btn danger', onClick: () => deleteShare(sh) }, h(Icon, { name: 'trash', size: 12 }), '取消服务器'));

    const smbPanel = h('div', { className: 'be-block' },
      h('div', { className: 'deploy-panel' },
        h('div', { className: 'dp-h' }, h(Icon, { name: 'folder', size: 15 }), '部署 共享 DDC（SMB）'),
        h('div', { className: 'dp-form' },
          h('div', { className: 'dp-field' }, h('label', null, '服务器机器'),
            h(Selector, { kpre: '机器', value: sharedNode.id, options: srvOpts, width: 240, onChange: setSrv })),
          h('div', { className: 'dp-field' }, h('label', null, '共享名'),
            h('input', { className: 'dp-input mono', value: shareName, spellCheck: false, onChange: (e) => setShareName(e.target.value) })),
          h('div', { className: 'dp-field' }, h('label', null, '本地路径'),
            h('div', { className: 'pathio' },
              h('input', { className: 'dp-input mono', value: shareLocal, spellCheck: false, onChange: (e) => setShareLocal(e.target.value) }),
              pathOpenBtn(shareLocal, { machine: sharedNode, label: sharedNode.host }))),
          h('div', { className: 'dp-field' }, h('label', null, '模式'),
            h(Selector, { kpre: '模式', value: shareMode, width: 200, onChange: setShareMode,
              options: [{ id: 'open', label: 'Mode A · 开放' }, { id: 'managed', label: 'Mode B · 专用账号' }] })),
          h('div', { className: 'dp-go' },
            sharedOffline ? h('span', { className: 'dp-deployed', style: { color: 'var(--negative-visual)' } }, h(Icon, { name: 'power', size: 13 }), '离线') : null,
            srvShare ? h('span', { className: 'dp-deployed' }, h(Icon, { name: 'check', size: 13 }), '已部署于本机') : null,
            srvShare ? h(Button, { variant: 'negative', size: 'M', icon: h(Icon, { name: 'trash', size: 14 }), onPress: () => undeploySMB(srvShare) }, '取消该服务器部署') : null,
            h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), onPress: deploySMB }, srvShare ? '重新部署' : '部署 共享 DDC'))),
        h('div', { className: 'dp-note' }, h(Icon, { name: 'shield', size: 13 }), srvShare
          ? ('该机器已作为共享 DDC 服务器 · ' + srvShare.path + '；可随时取消部署，取消后保留远端文件夹与缓存。')
          : '链路在后台逐步执行（进度进任务抽屉）；凭据 / urlacl / 服务安装全部自动处理。')));

    /* ===== ② 其他服务器加入共享 DDC（直接执行，真实 env + 工程 INI 写入）===== */
    const ENV_KEY = 'UE-SharedDataCachePath';
    /* 接入：对每台设环境变量 UE-SharedDataCachePath，并对该机已扫描到的工程写
       [DerivedDataBackendGraph] Shared 的 Path + EnvPathOverride（没有 EnvPathOverride 时 UE 会忽略环境变量）。 */
    const joinShareToMachines = (targets, unc, sh) => {
      let envOk = 0, iniProjOk = 0, iniProjExpected = 0, fail = 0;
      const okMachineIds = [];
      const errs = []; /* 收集每台机的真实错误——不再吞掉，否则只剩笼统的「全部目标设置失败」无从排查。 */
      return Promise.allSettled(targets.map((mid) =>
        setMachineEnvVar(mid, ENV_KEY, unc).then(() => {
          envOk++;
          const projs = (UE_PROJECTS || []).filter((p) => (p.machines || []).includes(String(mid)));
          iniProjExpected += projs.length;
          return Promise.allSettled(projs.map((p) => {
            const base = (p.locByMachine && p.locByMachine[String(mid)]) || p.root;
            const ini = String(base).replace(/\\+$/, '') + '\\Config\\DefaultEngine.ini';
            return Promise.all([
              setMachineBackendField(mid, ini, 'DerivedDataBackendGraph', 'Shared', 'Path', unc),
              setMachineBackendField(mid, ini, 'DerivedDataBackendGraph', 'Shared', 'EnvPathOverride', ENV_KEY),
            ]);
          })).then((rs) => {
            const okN = rs.filter((r) => r.status === 'fulfilled').length;
            iniProjOk += okN;
            /* 只有 env 变量 + 该机所有工程 INI 都写成功，才算这台「完整加入」、可做 guest 预连接 /
               凭据注入。否则 UE 没写上 EnvPathOverride，根本不会用共享 DDC，对它预连接是假成功。 */
            if (okN === projs.length) okMachineIds.push(mid);
            else errs.push('机器 ' + mid + '：工程 INI 部分写入失败（' + okN + '/' + projs.length + '）');
          });
        }, (e) => { fail++; errs.push('机器 ' + mid + '：' + (e && e.message ? e.message : String(e))); })
      )).then(() => {
        if (envOk === 0) throw new Error('全部目标设置失败' + (errs.length ? ' · ' + errs.join('；') : ''));
        if (iniProjExpected > 0 && iniProjOk === 0) {
          throw new Error('环境变量已设置，但工程 INI 写入全部失败' + (errs.length ? ' · ' + errs.join('；') : ''));
        }
        let managed = false;
        if (sh && sh.shareConfigId && sh.shareMode === 'managed' && okMachineIds.length) {
          managed = true;
          return prepareManagedShareClients(sh.shareConfigId, okMachineIds).then((prep) => {
            const prepFail = (prep || []).filter((r) => !r.ok);
            if (prepFail.length) {
              prepFail.forEach((r) => errs.push('机器 ' + r.client_machine_id + ' Mode B 预连接：' + (r.message || '失败')));
              throw new Error('Mode B 共享预连接失败 · ' + prepFail.length + ' 台' + (errs.length ? ' · ' + errs.join('；') : ''));
            }
            const managedWarn = prep.some((r) => r.message && r.message.indexOf('deferred') >= 0)
              ? '交互用户预连接将在下次登录时由计划任务重试'
              : null;
            return { envOk, iniProjOk, fail, okMachineIds, managed, managedWarn };
          });
        }
        if (sh && sh.shareMode === 'open' && sh.shareConfigId && okMachineIds.length) {
          /* Guest 预连接是「附加」步骤：env 变量 + 工程 INI 已写好（真正的「加入」已完成）。
             预连接失败（headless 节点 / MS 账号 / 主机慢）绝不能把已成功的 env/INI 当失败扔掉，
             只作为警告返回，不抛错。 */
          return prepareOpenShareClients(sh.shareConfigId, okMachineIds).then((prep) => {
            const prepFail = (prep || []).filter((r) => !r.ok);
            const guestWarn = prepFail.length
              ? 'Guest 预连接未即时确认 · ' + prepFail.length + '/' + (prep || []).length + ' 台（' + prepFail.map((r) => r.message || '失败').join('；') + '）'
              : null;
            return { envOk, iniProjOk, fail, okMachineIds, managed, guestPrep: !prepFail.length, guestWarn };
          }, (e) => ({ envOk, iniProjOk, fail, okMachineIds, managed, guestPrep: false, guestWarn: 'Guest 预连接调用失败（已设环境变量，登录时由计划任务重试）：' + (e && e.message ? e.message : String(e)) }));
        }
        return { envOk, iniProjOk, fail, okMachineIds, managed };
      });
    };
    const setJP = (id, kind) => setJoinPending((m) => Object.assign({}, m, { [id]: kind }));
    const clrJP = (id) => setJoinPending((m) => { const x = Object.assign({}, m); delete x[id]; return x; });
    const shareHostIds = (SHARES || []).map((sh) => sh.hostId);
    const shareSelOpts = (SHARES || []).map((sh) => ({ id: sh.id, label: sh.path, sub: sh.host }));
    const joinTargetShare = (SHARES || []).find((sh) => sh.id === joinTarget) || (SHARES || [])[0] || null;
    const joinCandidates = onlineLocalTargets.filter((n) => !shareHostIds.includes(n.id));
    const unjoinedCandidates = joinTargetShare
      ? joinCandidates.filter((n) => shareJoined[n.id] !== joinTargetShare.path && !joinPending[n.id]) : [];
    /* 有无已纳管共享服务器：门控②的两种形态（加入表单 vs 信息提示条 + 逐机核对/清理）。 */
    const hasShares = (SHARES || []).length > 0;
    /* 批量清除所选机 / 模块级「一键清空所有配置」：可选 = 已核对（schanData 懒加载，未展开/
       未刷新过的机器不计入——不能对没查过的机器妄称「有配置」）、确有「可写」通道可清（用
       clearableEntries 而不是 hasAnySharedConfig——后者把只读的命令行通道也算作「有配置」，
       若一台机器仅有命令行命中会导致勾选/清除操作对着 0 个可写条目空转），且不是当前正确
       指向某个已纳管共享的机器（env 值命中任一 SHARES.path 视为「正在正常使用」，不当残留
       死配置处理——否则模块级「一键清空所有配置」会连健康的加入配置一并清掉）。 */
    const clearableSchanNodes = joinCandidates.filter((n) => {
      if (hasShares && (SHARES || []).some((sh) => sh.path === shareJoined[n.id])) return false;
      return (n.id in schanData) && SCHAN.clearableEntries(schanData[n.id]).length > 0;
    });
    const clearableSchanIds = clearableSchanNodes.map((n) => n.id);
    const schanSelValid = schanSel.filter((id) => clearableSchanIds.includes(id));
    const allSchanSel = clearableSchanIds.length > 0 && clearableSchanIds.every((id) => schanSel.includes(id));
    const someSchanSel = schanSelValid.length > 0;
    const toggleSchanSel = (id) => setSchanSel((sl) => sl.includes(id) ? sl.filter((x) => x !== id) : sl.concat(id));
    const toggleAllSchanSel = () => setSchanSel(allSchanSel ? [] : clearableSchanIds.slice());
    const selSchanNodes = clearableSchanNodes.filter((n) => schanSel.includes(n.id));
    const selSchanDeadCount = selSchanNodes.filter((n) => SCHAN.hasDeadShared(schanData[n.id])).length;
    const joinShareOne = (n, sh) => {
      if (!sh || joinPending[n.id]) return;
      setJP(n.id, 'join');
      s.runCmd({ domain: 'share', action: 'join', target: n.host, chan: 'ssh', note: '加入共享 DDC · ' + sh.path },
        () => joinShareToMachines([n.machineId], sh.path, sh),
        { okMsg: (r) => n.host + ' 已加入 · 设系统环境变量' + (r.managed ? '，已预连接 Mode B 共享（交互用户+SYSTEM）' + (r.managedWarn ? '（' + r.managedWarn + '）' : '') : (r.guestPrep ? '，已预连接 Guest 共享（免凭据框）' : (r.guestWarn ? '，但 ' + r.guestWarn : ''))) })
        .then(() => { setShareJoined((m) => Object.assign({}, m, { [n.id]: sh.path })); clrJP(n.id); }, () => clrJP(n.id));
    };
    /* 退出时回滚加入写入的工程 INI——joinShareToMachines 对每台机每个工程写了
       Shared 的 Path + EnvPathOverride，退出 best-effort 移除这两个 key，避免 env 清空后
       INI 残留 dormant 共享配置。无加入前快照只能 remove（不恢复旧值）；远端 remove 是
       idempotent（缺字段/缺文件也成功）。单步失败用 allSettled 不阻断 env 清空，但返回失败
       计数供提示如实反映（不无条件宣称已回滚）。仅回滚当前 UE_PROJECTS 列出的工程——加入后被
       移出列表的工程不会被回滚（与 join 同一局限，无持久化的 join 工程快照）。 */
    const rollbackShareIni = (mid) => {
      const projs = (UE_PROJECTS || []).filter((p) => (p.machines || []).includes(String(mid)));
      /* 先删 Path 再删 EnvPathOverride：命令在 Tauri 主线程串行执行，若 Path 删成而 Override
         删败，残留「有 Override 无 Path」对 UE 安全（env 已空 → 回退本地）；反序则可能残留
         「有 Path 无 Override」，UE 会按字面 Path 继续读写共享缓存——与退出意图相反。 */
      return Promise.allSettled(projs.flatMap((p) => {
        const base = (p.locByMachine && p.locByMachine[String(mid)]) || p.root;
        const ini = String(base).replace(/\\+$/, '') + '\\Config\\DefaultEngine.ini';
        return [
          removeMachineBackendField(mid, ini, 'DerivedDataBackendGraph', 'Shared', 'Path'),
          removeMachineBackendField(mid, ini, 'DerivedDataBackendGraph', 'Shared', 'EnvPathOverride'),
        ];
      })).then((rs) => rs.filter((r) => r.status === 'rejected').length);
    };
    const leaveShareOne = (n) => {
      if (joinPending[n.id]) return;
      setJP(n.id, 'leave');
      const joinedPath = shareJoined[n.id];
      const sh = (SHARES || []).find((x) => x.path === joinedPath) || null;
      const isOpen = !!(sh && sh.shareMode === 'open' && sh.shareConfigId);
      const isManaged = !!(sh && sh.shareMode === 'managed' && sh.shareConfigId);
      s.runCmd({ domain: 'share', action: 'leave', target: n.host, chan: 'ssh', note: '退出共享 DDC' },
        /* 顺序：清 env（关键，UE 即刻回退本地）→ 回滚工程 INI（best-effort）→ 解除自动重连 +
           交互用户/SYSTEM 凭据清理（best-effort）。后两步失败不阻断「已退出」，但其真实结果会
           反映进提示，绝不无条件宣称已清理（清不掉时如实告警，避免用户误以为已彻底退出）。 */
        () => setMachineEnvVar(n.machineId, ENV_KEY, '')
          .then(() => rollbackShareIni(n.machineId))
          .then((iniFail) => {
            const unprep = isOpen ? unprepareOpenShareClients(sh.shareConfigId, [n.machineId])
              : isManaged ? unprepareManagedShareClients(sh.shareConfigId, [n.machineId])
              : Promise.resolve(null);
            return unprep.then((prep) => ({ iniFail, prep }), (e) => ({ iniFail, prepErr: e && e.message ? e.message : String(e) }));
          }),
        { okMsg: (r) => {
            let msg = n.host + ' 已退出 · 清空环境变量';
            msg += (r && r.iniFail) ? '（工程 INI 回滚 ' + r.iniFail + ' 项失败，需手动检查）' : ' · 已回滚工程 INI 接线';
            if (isManaged || isOpen) {
              const label = isManaged ? 'Mode B 凭据与自动重连' : 'Guest 自动重连';
              /* 计划任务已移除（自动重连必断），但交互用户当前会话的清理是 best-effort：
                 transport 失败 → 告警；Mode B 无交互会话时 cmdkey 残留 vault（脚本回 deferred /
                 manual cleanup），如实提示需手动清，不谎称已移除。 */
              const arr = r && Array.isArray(r.prep) ? r.prep : [];
              const failed = (r && r.prepErr) || arr.some((x) => x && !x.ok);
              const deferred = arr.some((x) => x && x.message && (x.message.indexOf('deferred') >= 0 || x.message.indexOf('manual cleanup') >= 0));
              msg += failed ? '；' + label + ' 清理未确认（best-effort，需手动检查）'
                : deferred ? '；自动重连已移除，但交互用户凭据未即时清理（无活动会话，需手动 cmdkey /delete）'
                : ' · 已移除 ' + label;
            }
            return msg;
          } })
        .then(() => { setShareJoined((m) => { const x = Object.assign({}, m); delete x[n.id]; return x; }); clrJP(n.id); }, () => clrJP(n.id));
    };
    const joinShareAll = () => {
      const sh = joinTargetShare;
      if (!sh || !unjoinedCandidates.length) return;
      const todo = unjoinedCandidates;
      const ids = todo.map((n) => n.id);
      ids.forEach((id) => setJP(id, 'join'));
      s.runCmd({ domain: 'share', action: 'join', target: ids.length + ' 台', chan: 'ssh', note: '批量加入共享 DDC · ' + sh.path },
        () => joinShareToMachines(todo.map((n) => n.machineId), sh.path, sh),
        { okMsg: (r) => '已加入 · ' + r.envOk + ' 台设环境变量' + (r.iniProjOk ? ('，写 ' + r.iniProjOk + ' 个工程 INI') : '') + (r.managed ? '，已预连接 Mode B 共享' : (r.guestPrep ? '，已预连接 Guest 共享（免凭据框）' : '')) + (r.fail ? ('，' + r.fail + ' 台失败') : '') })
        .then((r) => {
          const okSet = new Set(r.okMachineIds || []);
          setShareJoined((m) => { const x = Object.assign({}, m); todo.forEach((n) => { if (okSet.has(n.machineId)) x[n.id] = sh.path; }); return x; });
          ids.forEach(clrJP);
        }, () => ids.forEach(clrJP));
    };
    const joinRow = (n) => {
      const pend = joinPending[n.id];
      const cur = shareJoined[n.id];               /* 真实 env-var 快照（readStatus 挂载时已 eager 拉取）*/
      const onThis = joinTargetShare && cur === joinTargetShare.path;
      const sc = schanData[n.id];                   /* 懒加载的四通道详情：undefined=未核对 / null=离线 / 对象=数据 */
      const schanChecked = n.id in schanData;
      const hasCfg = schanChecked && SCHAN.hasAnySharedConfig(sc);           /* 徽章用：含只读命令行命中 */
      const canClear = schanChecked && SCHAN.clearableEntries(sc).length > 0; /* 勾选/清除按钮用：只算可写通道 */
      /* env KV 的「路径失效」着色：只有在 schanData 恰好已加载、且它读到的 env 值与
         eager shareJoined 快照一致时才采信（避免用一份可能过期的懒加载数据误判刚加入的机器）。 */
      const envDead = schanChecked && sc && sc.env && sc.env.st === 'dead' && sc.env.v === cur;
      const dead = schanChecked && SCHAN.hasDeadShared(sc);
      const open = schanExpanded.has(n.id);
      /* 无纳管共享形态下：有配置机可勾选参与批量清除；未核对 / 无配置机勾选框禁用。 */
      const isSel = schanSel.includes(n.id);
      const checkbox = !hasShares
        ? (canClear
            ? h('button', { className: 'lcheck', title: isSel ? '取消选择' : '选择', onClick: () => toggleSchanSel(n.id) },
                h('span', { className: 'proj-mck' + (isSel ? ' on' : '') }, isSel ? h(Icon, { name: 'check', size: 12 }) : null))
            : h('span', { className: 'lcheck dis', title: !schanChecked ? '尚未核对 · 展开或点「刷新状态」' : (hasCfg ? '仅命令行只读命中，无可清除项' : '无配置') }, h('span', { className: 'proj-mck dis' })))
        : null;
      const envKV = h('div', { className: 'cli-envvar mono' },
        h('span', { className: 'ev-k' }, ENV_KEY),
        h('span', { className: 'ev-eq' }, '='),
        envDead
          ? h('span', { className: 'ev-v dead', title: cur }, cur)
          : h('span', { className: 'ev-v' + (cur ? '' : ' none') }, cur || (statusLoading ? '读取中…' : '未设置')));
      let badgeEl;
      if (pend === 'join') badgeEl = badge('pend', 'sync', '加入中…');
      else if (pend === 'leave') badgeEl = badge('pend', 'sync', '退出中…');
      else if (envDead || (!hasShares && dead)) badgeEl = badge('dead', 'alert', '路径失效');
      else if (hasShares) badgeEl = onThis ? badge('ok', 'check', '已加入')
        : cur ? badge('alt', 'link', '加入其他')
        : statusLoading ? badge('none', 'sync', '读取中…')
        : badge('none', 'minus', '未加入');
      else badgeEl = !schanChecked ? badge('none', 'minus', '待核对')
        : hasCfg ? badge('info2', 'layers', '有配置')
        : badge('none', 'minus', '无配置');
      let actBtn = null;
      if (pend) actBtn = h('button', { className: 'mini-btn', disabled: true }, h(Icon, { name: 'sync', size: 12 }), '执行中');
      else if (hasShares) actBtn = onThis
        ? h('button', { className: 'mini-btn danger', onClick: () => leaveShareOne(n) }, h(Icon, { name: 'x', size: 12 }), '退出')
        : h('button', { className: 'mini-btn', onClick: () => joinShareOne(n, joinTargetShare) }, h(Icon, { name: 'link', size: 12 }), '加入');
      else if (canClear) actBtn = h('button', { className: 'mini-btn danger', onClick: () => clearAllShared(n) }, h(Icon, { name: 'trash', size: 12 }), '清除配置');
      const row = h('div', { className: 'cli-row join' + (isSel ? ' sel' : (onThis ? ' on' : '')) + (envDead || (!hasShares && dead) ? ' dead' : '') },
        checkbox,
        CX.dot(NODE_STATUS[n.status].visual),
        h('div', { className: 'cli-meta clk', title: open ? '收起配置通道' : '展开配置通道', onClick: () => toggleSchan(n) },
          h('div', { className: 'cli-host mono' }, n.host),
          h('div', { className: 'cli-sub' }, n.ip + ' · ' + n.role)),
        envKV,
        h('div', { className: 'local-act' },
          badgeEl,
          actBtn,
          h('button', { className: 'lrow-chev' + (open ? ' on' : ''), title: open ? '收起配置通道' : '展开配置通道',
            'aria-expanded': open, onClick: () => toggleSchan(n) }, h(Icon, { name: 'chevd', size: 16 }))));
      return h('div', { key: n.id, className: 'lcli' + (open ? ' open' : '') },
        row,
        open ? h(SCHAN.ChanPanelShared, { node: n, ch: sc, loading: chanRefreshing || schanLoadingIds.has(n.id), onSet: onSetSchan, onClear: onClearSchan }) : null);
    };

    /* ===== ③ 本地 DDC（直接执行，真实 create_local_cache + 设 UE-LocalDataCachePath）===== */
    const setLocalDir = (id, v) => setLocalDirs((m) => Object.assign({}, m, { [id]: v }));
    /* localDirs 初值在 mount 时算（那会儿 RENDER_NODES 可能为空），机器异步到达后不会回填 →
       按机器盘符给默认值兜底，用户改过的覆盖优先。 */
    const localDirOf = (n) => localDirs[n.id] || ((/^([A-Za-z]):/.test(n.uePath || '') ? n.uePath[0].toUpperCase() : 'D') + ':\\UE_DDC\\Local');
    /* 真实本地 DDC：create_local_cache 远端建目录 + 设 ACL，再 set UE-LocalDataCachePath（Local backend
       默认带 EnvPathOverride，不必改工程 INI）；取消部署（keep_files）= 仅清空 env var，保留磁盘缓存。 */
    const deployLocalExec = (machineId, dir) =>
      createLocalCache(machineId, dir).then(() => setMachineEnvVar(machineId, 'UE-LocalDataCachePath', dir));
    const undeployLocalExec = (machineId) => setMachineEnvVar(machineId, 'UE-LocalDataCachePath', '');
    const markLP = (ids, kind) => setLocalPending((m) => { const x = Object.assign({}, m); ids.forEach((id) => { x[id] = kind; }); return x; });
    const clrLP = (ids) => setLocalPending((m) => { const x = Object.assign({}, m); ids.forEach((id) => { delete x[id]; }); return x; });
    const deployLocalOne = (n) => {
      if (localPending[n.id]) return;
      const dir = localDirOf(n);
      markLP([n.id], 'deploy');
      s.runCmd({ domain: 'local-cache', action: 'create', target: n.host, chan: 'ssh', note: '本地 DDC · ' + dir },
        () => deployLocalExec(n.machineId, dir)
          .then(() => getMachineEnvVar(n.machineId, 'UE-LocalDataCachePath').catch(() => null))
          .then((v) => ({ dir, verified: v === dir })),
        { okMsg: (r) => n.host + ' 本地 DDC 已部署 · ' + r.dir + (r.verified ? ' · 已回读校验' : '') })
        .then(() => { setLocalDeployed((d) => d.includes(n.id) ? d : d.concat(n.id)); clrLP([n.id]); }, () => clrLP([n.id]));
    };
    const undeployLocalOne = (n) => {
      if (localPending[n.id]) return;
      markLP([n.id], 'undeploy');
      s.runCmd({ domain: 'local-cache', action: 'remove', target: n.host, chan: 'ssh', note: '取消本地 DDC（缓存文件保留）· ' + n.host },
        () => undeployLocalExec(n.machineId)
          .then(() => getMachineEnvVar(n.machineId, 'UE-LocalDataCachePath').catch(() => null))
          .then((v) => ({ cleared: !v })),
        { okMsg: () => n.host + ' 本地 DDC 已取消部署 · 缓存文件保留' })
        .then(() => { setLocalDeployed((d) => d.filter((x) => x !== n.id)); clrLP([n.id]); }, () => clrLP([n.id]));
    };
    /* 多选批量（直接执行）：allSettled 容部分失败；全程 pending，落地后翻状态并清空选择。 */
    const runLocalBatch = (nodes, kind, note) => {
      const todo = nodes.filter((n) => !localPending[n.id]);
      if (!todo.length) return;
      const ids = todo.map((n) => n.id);
      markLP(ids, kind);
      const exec = kind === 'deploy'
        ? () => Promise.allSettled(todo.map((n) => deployLocalExec(n.machineId, localDirOf(n))))
        : () => Promise.allSettled(todo.map((n) => undeployLocalExec(n.machineId)));
      s.runCmd({ domain: 'local-cache', action: kind === 'deploy' ? 'create' : 'remove', target: todo.length + ' 台', chan: 'ssh', note },
        () => exec().then((rs) => { const ok = rs.filter((r) => r.status === 'fulfilled').length; if (!ok) throw new Error('全部目标失败'); return { ok, fail: rs.length - ok }; }),
        { okMsg: (r) => (kind === 'deploy' ? (r.ok + ' 台本地 DDC 已部署') : (r.ok + ' 台已取消部署 · 缓存文件保留')) + (r.fail ? ('，' + r.fail + ' 台失败') : '') })
        .then(() => { setLocalDeployed((d) => kind === 'deploy' ? Array.from(new Set(d.concat(ids))) : d.filter((x) => !ids.includes(x))); clrLP(ids); setSelLocal([]); },
              () => clrLP(ids));
    };
    /* 统一路径一键：弹居中 modal 确认 → 把全部在线机的本地路径设成 commonLocalDir，再批量部署。 */
    const applyCommonLocal = () => {
      const path = commonLocalDir.trim();
      const todo = onlineLocalTargets.filter((n) => !localPending[n.id]);
      if (!path || !todo.length) return;
      const ids = todo.map((n) => n.id);
      CX.openModalPreview(s, {
        title: '全选并统一部署本地 DDC · ' + todo.length + ' 台', icon: 'bolt', cli: 'create_local_cache --all-online', destructive: false, channel: 'ssh',
        confirmLabel: '统一部署 ' + todo.length + ' 台',
        /* run() resolve 出 {ok,fail}：部分失败也 resolve（非全挂不抛），据它如实显示，不把部分失败误报全绿 */
        doneTitle: '已部署', doneMsg: (r) => (r && r.ok != null) ? (r.ok + ' 台已统一部署 · ' + path + (r.fail ? ('，' + r.fail + ' 台失败') : '')) : (todo.length + ' 台已统一设置并部署 · ' + path),
        steps: ['把 ' + todo.length + ' 台在线机的本地 DDC 路径统一设为 ' + path, '在每台机器上创建本地缓存层（create_local_cache）', '写入后自动回读校验命中链路'],
        simpleScope: todo.map((n) => ({ host: n.host, ip: n.ip, msg: path })),
        run: () => {
          setLocalDirs((m) => { const x = Object.assign({}, m); ids.forEach((id) => { x[id] = path; }); return x; });
          markLP(ids, 'deploy');
          return s.runCmd({ domain: 'local-cache', action: 'create', target: todo.length + ' 台', chan: 'ssh', note: '统一本地 DDC 路径并部署（' + todo.length + ' 台）· ' + path },
            () => Promise.allSettled(todo.map((n) => deployLocalExec(n.machineId, path))).then((rs) => { const ok = rs.filter((r) => r.status === 'fulfilled').length; if (!ok) throw new Error('全部目标部署失败'); return { ok, fail: rs.length - ok }; }),
            { okMsg: (r) => r.ok + ' 台已统一部署 · ' + path + (r.fail ? ('，' + r.fail + ' 台失败') : '') })
            .then((r) => { setLocalDeployed((d) => Array.from(new Set(d.concat(ids)))); clrLP(ids); setSelLocal([]); return r; }, (e) => { clrLP(ids); throw e; });
        },
      });
    };
    const onlineIds = onlineLocalTargets.map((n) => n.id);
    const allSel = onlineIds.length > 0 && onlineIds.every((id) => selLocal.includes(id));
    const someSel = selLocal.length > 0;
    const toggleLocalSel = (id) => setSelLocal((sl) => sl.includes(id) ? sl.filter((x) => x !== id) : sl.concat(id));
    const toggleAllLocal = () => setSelLocal(allSel ? [] : onlineIds.slice());
    const selNodes = onlineLocalTargets.filter((n) => selLocal.includes(n.id));
    const selDeployedNodes = selNodes.filter((n) => localDeployed.includes(n.id));
    const selUndeployedNodes = selNodes.filter((n) => !localDeployed.includes(n.id));

    /* 刷新状态（模块头部按钮）：readStatus 已有的「已部署/已加入」env-var fan-out 之外，
       并发拉取全部机器的四条配置通道详情。两个 fan-out 各自失败互不影响；chanRefreshing
       驱动按钮「读取中…」禁用态和已展开面板的 skeleton。 */
    const refreshChanAll = () => {
      if (chanRefreshing) return;
      setChanRefreshing(true);
      readStatus();
      const gens = {};
      const sgens = {};
      IP_SORTED_NODES.forEach((n) => { gens[n.id] = bumpChanGen(n.id); sgens[n.id] = bumpSchanGen(n.id); });
      Promise.allSettled([
        Promise.allSettled(IP_SORTED_NODES.map((n) =>
          CHAN.channelsFor(n).then((ch) => ({ id: n.id, ch }), () => ({ id: n.id, ch: null }))))
          .then((rs) => setChanData((prev) => {
            const next = Object.assign({}, prev);
            rs.forEach((r) => {
              if (r.status === 'fulfilled' && chanGenRef.current[r.value.id] === gens[r.value.id]) next[r.value.id] = r.value.ch;
            });
            return next;
          })),
        Promise.allSettled(IP_SORTED_NODES.map((n) =>
          SCHAN.channelsForShared(n).then((ch) => ({ id: n.id, ch }), () => ({ id: n.id, ch: null }))))
          .then((rs) => setSchanData((prev) => {
            const next = Object.assign({}, prev);
            rs.forEach((r) => {
              if (r.status === 'fulfilled' && schanGenRef.current[r.value.id] === sgens[r.value.id]) next[r.value.id] = r.value.ch;
            });
            return next;
          })),
      ]).then(() => setChanRefreshing(false));
    };
    /* 通道就地编辑「保存/清除」→ 真实写入对应后端（env var / 注册表 / ini），成功后
       乐观更新本地 chanData（不必整台机器重新拉取四路）、并 bump 该节点代次令牌
       （让任何更早起、更晚 resolve 的批量刷新读丢弃自己的旧快照，不覆盖回刚保存的值）。
       返回 Promise 供 ChanPanel 展示 commit 中 / 失败态。value === '' 视为清除——「保存」
       和「清除」走的是同一个函数，空值统一按清除处理，不做「保存空框=什么都不做」的
       特例（那会让用户以为清空生效了，实际值原封不动）。 */
    const applyChanEdit = (n, key, sub, value) => CHAN.writeChannel(n, key, sub, value).then(() => {
      bumpChanGen(n.id);
      setChanData((prev) => {
        const nd = Object.assign({}, prev[n.id]);
        const field = value ? { v: value, st: 'set' } : { v: null, st: 'unset' };
        if (key === 'ini') { nd.ini = Object.assign({}, nd.ini, { [sub]: field }); } else { nd[key] = field; }
        return Object.assign({}, prev, { [n.id]: nd });
      });
    });
    const onSetChan = (n, key, sub, val) => applyChanEdit(n, key, sub, val);
    const onClearChan = (n, key, sub) => applyChanEdit(n, key, sub, '');

    /* ② 共享 DDC 通道就地编辑「保存/清除」→ 同 applyChanEdit，但 ini 子字段按
       "<projectId>#path" | "<projectId>#envOverride" 定位到具体工程的具体字段
       （sub 里的 projectId 是字符串比较，UE_PROJECTS.id 类型不定）。 */
    const applySchanEdit = (n, key, sub, value) => SCHAN.writeChannel(n, key, sub, value).then(() => {
      bumpSchanGen(n.id);
      setSchanData((prev) => {
        const cur = prev[n.id];
        if (!cur) return prev;
        const field = value ? { v: value, st: 'set' } : { v: null, st: 'unset' };
        let nd;
        if (key === 'ini') {
          const [projId, sf] = String(sub).split('#');
          const subKey = sf === 'envOverride' ? 'envOverride' : 'path';
          nd = Object.assign({}, cur, { ini: { projects: (cur.ini.projects || []).map((p) =>
            String(p.projectId) === projId ? Object.assign({}, p, { [subKey]: field }) : p) } });
        } else {
          nd = Object.assign({}, cur, { [key]: field });
        }
        return Object.assign({}, prev, { [n.id]: nd });
      });
    });
    const onSetSchan = (n, key, sub, val) => applySchanEdit(n, key, sub, val);
    const onClearSchan = (n, key, sub) => applySchanEdit(n, key, sub, '');

    /* ② 行级「清除配置」（无纳管共享形态）：清空该机全部可写共享 DDC 配置通道，
       含确认弹层逐条列出通道名 + 值；清除后重新拉取该机通道详情做真实回读校验。 */
    const clearAllShared = (n) => {
      const entries = SCHAN.clearableEntries(schanData[n.id] || {});
      if (entries.length === 0) return;
      CX.openModalPreview(s, {
        title: '清除共享 DDC 残留配置 · ' + n.host, icon: 'trash', cli: 'ddc.clear_shared_channels', destructive: true, channel: 'ssh', confirmLabel: '清除这些配置',
        doneTitle: '已清除残留配置', doneMsg: n.host + ' 的 ' + entries.length + ' 项共享 DDC 配置已清除（不动命令行只读项与远端共享文件夹）',
        steps: ['清空 ' + n.host + ' 上全部可写的共享 DDC 配置通道 —— 环境变量 ' + ENV_KEY + ' + 注册表共享值 + 工程 INI 的 Shared Path / EnvPathOverride',
          '命令行参数为只读扫描项，不在清理范围；不删除任何远端共享文件夹',
          '清除后自动回读校验，该机不再指向任何共享 DDC 上游'],
        simpleScope: entries.map((e) => ({ host: e.chan, ip: '', msg: e.val })),
        run: () => s.runCmd({ domain: 'share', action: 'clear', target: n.host + ' · ' + entries.length + ' 项', chan: 'ssh', note: '清除全部共享 DDC 残留配置（' + entries.length + ' 项）' },
          () => SCHAN.writeEntriesSafely(entries.map((e) => ({ node: n, key: e.key, sub: e.sub, value: '' }))).then((rs) => {
            const fail = rs.filter((r) => r.status === 'rejected').length;
            if (rs.length > 0 && fail === rs.length) throw new Error('全部清除失败');
            return { ok: rs.length - fail, fail };
          }),
          { okMsg: (r) => n.host + ' 已清除 ' + r.ok + ' 项' + (r.fail ? ('，' + r.fail + ' 项失败') : '') })
          .then((r) => {
            fetchSchanOne(n);
            /* schanData 是懒加载的独立快照，env 通道的清除还得同步进 eager 的 shareJoined
               （readStatus 挂载时拉的那份）——否则行首「加入目标」表单切回 hasShares 形态时，
               或未来重新展开前，env KV 行内展示的仍是清除前的旧值（本次真机验证时抓到）。 */
            if (entries.some((e) => e.key === 'env')) {
              setShareJoined((m) => { if (!(n.id in m)) return m; const x = Object.assign({}, m); delete x[n.id]; return x; });
            }
            return r;
          }),
      });
    };
    /* ② 批量清除（模块级「一键清空所有配置」+ 批量选中「清除所选」共用）：清空传入这批
       机器上全部可写共享 DDC 配置通道，确认弹层列出全部机器 + 条目；成功后逐台重新拉取
       通道详情做真实回读校验，并清空批量选择。 */
    const clearAllSharedMany = (nodes) => {
      /* clearableEntries（不是 hasAnySharedConfig）——只读的命令行命中不提供任何可清除通道，
       * 用 hasAnySharedConfig 筛选会把「全部配置都来自命令行」的机器也纳入 targets，
       * 导致下面 writeEntriesSafely([]) 结果为空数组，误判成功/失败都说不通。 */
      const targets = (nodes || []).filter((n) => SCHAN.clearableEntries(schanData[n.id]).length > 0);
      if (targets.length === 0) return;
      const scopeRows = [];
      const envClearedIds = [];
      targets.forEach((n) => {
        const entries = SCHAN.clearableEntries(schanData[n.id]);
        entries.forEach((e) => scopeRows.push({ host: n.host, ip: e.chan, msg: e.val }));
        if (entries.some((e) => e.key === 'env')) envClearedIds.push(n.id);
      });
      const totalItems = scopeRows.length;
      CX.openModalPreview(s, {
        title: '批量清除共享 DDC 残留配置 · ' + targets.length + ' 台', icon: 'trash', cli: 'ddc.clear_shared_channels --hosts', destructive: true, channel: 'ssh',
        confirmLabel: '清除这些配置',
        doneTitle: '已批量清除', doneMsg: targets.length + ' 台机器共 ' + totalItems + ' 项共享 DDC 配置已清除（不动命令行只读项与远端共享文件夹）',
        steps: ['在 ' + targets.length + ' 台机器上清空全部可写的共享 DDC 配置通道 —— 环境变量 ' + ENV_KEY + ' + 注册表共享值 + 工程 INI 的 Shared Path / EnvPathOverride',
          '命令行参数为只读扫描项，不在清理范围；不删除任何远端共享文件夹',
          '清除后自动回读校验，这些机器不再指向任何共享 DDC 上游'],
        simpleScope: scopeRows,
        run: () => s.runCmd({ domain: 'share', action: 'clear', target: targets.length + ' 台 · ' + totalItems + ' 项', chan: 'ssh', note: '批量清除共享 DDC 残留配置（' + targets.length + ' 台 / ' + totalItems + ' 项）' },
          () => SCHAN.writeEntriesSafely(targets.flatMap((n) => SCHAN.clearableEntries(schanData[n.id]).map((e) => ({ node: n, key: e.key, sub: e.sub, value: '' })))).then((rs) => {
            const fail = rs.filter((r) => r.status === 'rejected').length;
            if (rs.length > 0 && fail === rs.length) throw new Error('全部清除失败');
            return { ok: rs.length - fail, fail };
          }),
          { okMsg: (r) => '已清除 ' + r.ok + ' 项' + (r.fail ? ('，' + r.fail + ' 项失败') : '') })
          .then((r) => {
            targets.forEach(fetchSchanOne);
            setSchanSel([]);
            /* 同 clearAllShared：把本批次清了 env 通道的机器同步从 eager 的 shareJoined 里摘掉。 */
            if (envClearedIds.length) {
              setShareJoined((m) => { const x = Object.assign({}, m); envClearedIds.forEach((id) => { delete x[id]; }); return x; });
            }
            return r;
          }),
      });
    };
    /* ③ 模块级「一键清空所有配置」：清空当前列表全部（有配置）机器的可写本地 DDC 配置
       通道，确认弹层列出全部机器 + 条目；成功后逐台重新拉取通道详情做真实回读校验。 */
    const clearAllLocalMany = (nodes) => {
      const targets = (nodes || []).filter((n) => CHAN.hasAnyLocalConfig(chanData[n.id]));
      if (targets.length === 0) return;
      const ids = targets.map((n) => n.id);
      const scopeRows = [];
      targets.forEach((n) => CHAN.clearableLocalEntries(chanData[n.id]).forEach((e) => scopeRows.push({ host: n.host, ip: e.chan, msg: e.val })));
      const totalItems = scopeRows.length;
      CX.openModalPreview(s, {
        title: '一键清空本地 DDC 配置 · ' + targets.length + ' 台', icon: 'trash', cli: 'ddc.clear_local_channels --hosts', destructive: true, channel: 'ssh',
        confirmLabel: '清除这些配置',
        doneTitle: '已一键清空', doneMsg: targets.length + ' 台机器共 ' + totalItems + ' 项本地 DDC 配置已清除（命令行只读项与本地缓存文件保留）',
        steps: ['在当前列表 ' + targets.length + ' 台有配置的机器上清空全部可写本地 DDC 配置通道 —— EditorSettings ini（本地 + 共享上游）+ 注册表 + 环境变量 UE-LocalDataCachePath',
          '命令行参数为只读扫描项，不在清理范围；不删除本地缓存文件夹与已有缓存',
          '清除后自动回读校验，这些机器本地 DDC 路径回到未设置状态'],
        simpleScope: scopeRows,
        run: () => s.runCmd({ domain: 'local-cache', action: 'clear', target: targets.length + ' 台 · ' + totalItems + ' 项', chan: 'ssh', note: '一键清空全部机器本地 DDC 配置（' + targets.length + ' 台 / ' + totalItems + ' 项）' },
          () => Promise.allSettled(targets.flatMap((n) => CHAN.clearableLocalEntries(chanData[n.id]).map((e) => CHAN.writeChannel(n, e.key, e.sub, '')))).then((rs) => {
            const fail = rs.filter((r) => r.status === 'rejected').length;
            if (fail === rs.length) throw new Error('全部清除失败');
            return { ok: rs.length - fail, fail };
          }),
          { okMsg: (r) => '已清除 ' + r.ok + ' 项' + (r.fail ? ('，' + r.fail + ' 项失败') : '') })
          .then((r) => {
            targets.forEach(fetchChanOne);
            /* 清空了 env/reg/ini 通道后，「已部署」徽章（localDeployed，readStatus 挂载时
               eager 拉取的那份，不是这里刷新的懒加载 chanData）必须同步摘除，否则该机会永久
               卡在「已部署」——readStatus 的合并逻辑只在 localPending[id]==='undeploy' 时才
               剔除，而这条清空路径从不设置 localPending。 */
            setLocalDeployed((d) => d.filter((x) => !ids.includes(x)));
            return r;
          }),
      });
    };
    /* 模块头部「一键清空所有配置」按钮（② / ③ 共用外观，各自传入清空回调 + disabled 态）。 */
    const wipeBtn = (onClick, disabled) => h('button', { className: 'chan-wipe', disabled, onClick,
      title: '清空当前列表全部机器的配置' }, h(Icon, { name: 'trash', size: 12 }), '一键清空所有配置');

    const localRow = (n) => {
      const dep = localDeployed.includes(n.id);
      const off = n.status === 'offline';
      const isSel = selLocal.includes(n.id);
      const pend = localPending[n.id];
      const open = chanExpanded.has(n.id);
      const row = h('div', { className: 'cli-row local' + (off ? ' off' : '') + (isSel ? ' sel' : (dep ? ' on' : '')) },
        off ? h('span', { className: 'lcheck dis' }, h('span', { className: 'proj-mck dis' }))
          : h('button', { className: 'lcheck', title: isSel ? '取消选择' : '选择', onClick: () => toggleLocalSel(n.id) },
              h('span', { className: 'proj-mck' + (isSel ? ' on' : '') }, isSel ? h(Icon, { name: 'check', size: 12 }) : null)),
        CX.dot(NODE_STATUS[n.status].visual),
        h('div', { className: 'cli-meta clk', title: open ? '收起配置通道' : '展开配置通道', onClick: () => toggleChan(n) },
          h('div', { className: 'cli-host mono' }, n.host),
          h('div', { className: 'cli-sub' }, n.ip + ' · ' + n.role)),
        h('div', { className: 'pathio cli-pathio' },
          h('input', { className: 'cli-pathin mono', value: localDirOf(n), disabled: off,
            spellCheck: false, onChange: (e) => setLocalDir(n.id, e.target.value) }),
          pathOpenBtn(localDirOf(n), { machine: n, label: n.host, disabled: off })),
        h('div', { className: 'local-act' },
          off ? badge('off', 'power', '离线')
            : pend === 'deploy' ? badge('pend', 'sync', '部署中…')
            : pend === 'undeploy' ? badge('pend', 'sync', '取消中…')
            : statusLoading ? badge('none', 'sync', '读取中…')
            : dep ? badge('ok', 'check', '已部署')
            : badge('none', 'minus', '未部署'),
          off ? null
            : pend ? h('button', { className: 'mini-btn', disabled: true }, h(Icon, { name: 'sync', size: 12 }), '执行中')
            : dep ? h(React.Fragment, null,
                h('button', { className: 'mini-btn', onClick: () => deployLocalOne(n) }, h(Icon, { name: 'sync', size: 12 }), '重新部署'),
                h('button', { className: 'mini-btn danger', onClick: () => undeployLocalOne(n) }, h(Icon, { name: 'trash', size: 12 }), '取消部署'))
              : h('button', { className: 'mini-btn', onClick: () => deployLocalOne(n) }, h(Icon, { name: 'bolt', size: 12 }), '部署'),
          h('button', { className: 'lrow-chev' + (open ? ' on' : ''), title: open ? '收起配置通道' : '展开配置通道',
            'aria-expanded': open, onClick: () => toggleChan(n) }, h(Icon, { name: 'chevd', size: 16 }))));
      return h('div', { key: n.id, className: 'lcli' + (open ? ' open' : '') },
        row,
        open ? h(CHAN.ChanPanel, { node: n, ch: chanData[n.id], loading: chanRefreshing || chanLoadingIds.has(n.id), onSet: onSetChan, onClear: onClearChan }) : null);
    };
    /* ③ 模块头部「一键清空所有配置」按钮的范围/disabled 态：同②一样只算已核对
       （chanData 懒加载，未展开/未刷新过的机器不计入）且确有可清理配置的机器。 */
    const localClearable = IP_SORTED_NODES.filter((n) => (n.id in chanData) && CHAN.hasAnyLocalConfig(chanData[n.id]));

    return h('div', { className: 'res ddc' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, 'DDC · 文件系统 DDC'),
        h('div', { className: 'right' })),
      h('div', { className: 'ddc-body' },
        h('div', { className: 'zen-2col' },
          /* 左列：① 共享 DDC 服务器部署 + 已纳管共享 + ② 其他服务器加入 */
          h('div', { className: 'zen-col' },
            h('div', { className: 'ddc-sec-h' }, h('span', null, '① 共享 DDC（SMB）'), h('span', { className: 'dim' }, '先立一台机器为共享 DDC 服务器 · 创建网络共享映射路径，其余机器再加入')),
            smbPanel,
            SHARES.length ? h(React.Fragment, null,
              h('div', { className: 'ddc-sec-h' }, h('span', null, '已纳管的共享服务器'), h('span', { className: 'dim' }, SHARES.length + ' 台 · 每台共享 DDC 服务器都可单独取消 · 取消不删除远端文件夹')),
              h('div', { className: 'art-list' }, SHARES.map(shareRow))) : null,
            /* ② 永远渲染：有已纳管共享服务器时保留加入表单；否则顶部换成信息提示条，
               下方仍逐机展示 / 核对 / 清理已有共享 DDC 配置（此处「加入候选」= 全部在线且
               非共享服务器本机的机器，与是否已纳管共享无关）。 */
            h('div', { className: 'ddc-sec-h chan-sech ddc-schan-head' },
              h('span', null, '② 其他服务器加入共享 DDC'),
              h('div', { className: 'chan-sech-r' },
                h('span', { className: 'dim' }, hasShares
                  ? (joinCandidates.filter((n) => joinTargetShare && shareJoined[n.id] === joinTargetShare.path).length + ' / ' + joinCandidates.length + ' 已加入 · 写环境变量 ' + ENV_KEY + ' 指向共享路径')
                  : '未纳管共享 · 展开每台机器可核对 / 清理已有共享 DDC 配置'),
                wipeBtn(() => clearAllSharedMany(clearableSchanNodes), clearableSchanIds.length === 0))),
            h('div', { className: 'cli-panel ddc-schan-panel' },
              hasShares
                ? h('div', { className: 'cli-top' },
                    h('div', { className: 'cli-server-chip' },
                      h('span', { className: 'csc-ico' }, h(Icon, { name: 'folder', size: 15 })),
                      h('div', { style: { minWidth: 0 } },
                        h('div', { className: 'csc-t' }, '加入目标 · ' + (joinTargetShare ? joinTargetShare.host : '—')),
                        h('div', { className: 'csc-s mono' }, joinTargetShare ? joinTargetShare.path : '—'))),
                    SHARES.length > 1 ? h('div', { className: 'dp-field' }, h('label', null, '共享服务器'),
                      h('div', { className: 'sel-with-open' },
                        h(Selector, { kpre: '共享', value: joinTargetShare ? joinTargetShare.id : null, options: shareSelOpts, width: 240, onChange: setJoinTarget }),
                        pathOpenBtn(joinTargetShare ? joinTargetShare.path : '',
                          { machine: joinTargetShare ? CX.node(joinTargetShare.hostId) : null, label: joinTargetShare ? joinTargetShare.host : '', standalone: true }))) : null,
                    h('div', { className: 'cli-go' },
                      h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'link', size: 14 }), isDisabled: unjoinedCandidates.length === 0, onPress: joinShareAll },
                        '全部加入（' + unjoinedCandidates.length + '）')))
                : h('div', { className: 'schan-infobar' },
                    h('span', { className: 'sib-ic' }, h(Icon, { name: 'info', size: 16 })),
                    h('div', { className: 'sib-tx' },
                      '尚未纳管共享 DDC 服务器 —— 可先在①部署；下方仍会显示各机器已有的共享 DDC 配置，便于核对与清理。')),
              hasShares
                ? h('div', { className: 'cli-note' }, h(Icon, { name: 'shield', size: 13 }),
                    '加入 = 在该机设机器级系统环境变量 ' + ENV_KEY + ' 指向共享路径；Mode A 会预存 Guest 空密码会话（cmdkey + net use，资源管理器直接输入 UNC 不再弹框）；Mode B 会为计算机名与 IP 注入 ddc-svc 凭据；运行中的 UE 需重启生效。退出仅清除变量（不撤销已预连接会话）。')
                : h('div', { className: 'cli-note warn' }, h(Icon, { name: 'alert', size: 13 }),
                    '标「路径失效」的是死配置（UNC 共享当前不可达）；行尾「清除配置」可一次性清空该机的环境变量 / 注册表 / 工程 INI 共享键；展开或点「刷新状态」后才能核对某台机器是否真的无配置。'),
              !hasShares ? h('div', { className: 'local-selbar schan-selbar' + (someSchanSel ? ' on' : '') },
                h('button', { className: 'lsb-all', disabled: clearableSchanIds.length === 0, onClick: toggleAllSchanSel },
                  h('span', { className: 'proj-mck' + (allSchanSel ? ' on' : (someSchanSel ? ' part' : '')) },
                    allSchanSel ? h(Icon, { name: 'check', size: 12 }) : (someSchanSel ? h(Icon, { name: 'minus', size: 12 }) : null)),
                  allSchanSel ? '取消全选' : '全选有配置机'),
                h('span', { className: 'lsb-ct' }, someSchanSel
                  ? ('已选 ' + schanSelValid.length + ' 台' + (selSchanDeadCount ? (' · 其中 ' + selSchanDeadCount + ' 台路径失效') : ''))
                  : (clearableSchanIds.length ? ('勾选机器后可批量清除残留配置 · ' + clearableSchanIds.length + ' 台有配置') : '当前没有已核对到残留共享 DDC 配置的机器')),
                h('div', { className: 'lsb-acts' },
                  h(Button, { variant: 'negative', size: 'S', icon: h(Icon, { name: 'trash', size: 13 }), isDisabled: schanSelValid.length === 0, onPress: () => clearAllSharedMany(selSchanNodes) },
                    '批量清除所选（' + schanSelValid.length + '）'))) : null,
              h('div', { className: 'cli-list' }, joinCandidates.map(joinRow)))),
          /* 右列：③ 本地 DDC */
          h('div', { className: 'zen-col' },
            h('div', { className: 'ddc-sec-h chan-sech' },
              h('span', null, '③ 本地 DDC'),
              h('div', { className: 'chan-sech-r' },
                h('span', { className: 'dim' }, localDeployed.length + ' / ' + RENDER_NODES.length + ' 已部署 · 可逐台设置，或用上方统一路径一键应用到全部'),
                h('button', { className: 'chan-refresh', disabled: chanRefreshing, onClick: refreshChanAll,
                  title: '回读②共享 + ③本地两板块的部署状态与四条配置通道详情' },
                  h(Icon, { name: 'sync', size: 12 }), chanRefreshing ? '读取中…' : '刷新状态'),
                wipeBtn(() => clearAllLocalMany(localClearable), localClearable.length === 0))),
            h('div', { className: 'cli-panel ddc-local-panel' },
              h('div', { className: 'cli-top' },
                h('div', { className: 'local-hint' }, h(Icon, { name: 'server', size: 15 }), '逐台本地缓存回退层 · 命中链路兜底'),
                h('div', { className: 'cli-unify' },
                  h('label', null, '统一路径'),
                  h('div', { className: 'pathio cli-unify-io' },
                    h('input', { className: 'dp-input mono', value: commonLocalDir, spellCheck: false, onChange: (e) => setCommonLocalDir(e.target.value) }),
                    pathOpenBtn(commonLocalDir, { label: '本地 DDC 统一路径' })),
                  h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), isDisabled: !commonLocalDir.trim() || onlineLocalTargets.filter((n) => !localPending[n.id]).length === 0, onPress: applyCommonLocal },
                    '全选并统一部署（' + onlineLocalTargets.length + '）'))),
              h('div', { className: 'cli-note' }, h(Icon, { name: 'shield', size: 13 }),
                '本地 DDC 作为命中链路的回退层；部署链路在后台逐步执行，写入后自动回读校验。'),
              h('div', { className: 'local-selbar' + (someSel ? ' on' : '') },
                h('button', { className: 'lsb-all', onClick: toggleAllLocal },
                  h('span', { className: 'proj-mck' + (allSel ? ' on' : (someSel ? ' part' : '')) },
                    allSel ? h(Icon, { name: 'check', size: 12 }) : (someSel ? h(Icon, { name: 'minus', size: 12 }) : null)),
                  allSel ? '取消全选' : '全选在线机'),
                h('span', { className: 'lsb-ct' }, someSel
                  ? ('已选 ' + selLocal.length + ' 台 · ' + selDeployedNodes.length + ' 已部署 / ' + selUndeployedNodes.length + ' 未部署')
                  : '勾选机器后可批量部署或一键取消部署'),
                h('div', { className: 'lsb-acts' },
                  h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'bolt', size: 13 }), isDisabled: selUndeployedNodes.length === 0, onPress: () => runLocalBatch(selUndeployedNodes, 'deploy', '批量部署本地 DDC（' + selUndeployedNodes.length + ' 台）') }, '部署所选（' + selUndeployedNodes.length + '）'),
                  h(Button, { variant: 'negative', size: 'S', icon: h(Icon, { name: 'trash', size: 13 }), isDisabled: selDeployedNodes.length === 0, onPress: () => runLocalBatch(selDeployedNodes, 'undeploy', '批量取消本地 DDC（' + selDeployedNodes.length + ' 台）') }, '取消部署所选（' + selDeployedNodes.length + '）'))),
              h('div', { className: 'cli-list' }, IP_SORTED_NODES.map(localRow)))))));
  }

  /* =================== center router ===================
     keep-alive：各 DDC 子视图在首次访问后常驻挂载，display 切换——ZenServer ↔ 文件系统 DDC
     不再每次卸载重挂、重跑挂载期状态读取。 */
  const ddcViewShell = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' };
  const DDC_VIEWS = [
    ['ddc_zen', (s) => window.VOLO_CACHE_ZEN.view(s)],
    ['ddc_legacy', (s) => h(LegacyView, { s })],
    /* DDC PAK 子页已重设计为左右双栏（已部署 PAK | 扫描与生成），见 cacheDdcPak.tsx */
    ['ddc_pak', (s) => window.VOLO_CACHE_DDC_PAK.page(s)],
    /* PSO 缓存改为「上场就绪保障」Dashboard 子视图（Dashboard + 设置），见 cachePsoDash.tsx */
    ['ddc_pso', (s) => window.VOLO_CACHE_PSO_DASH.center(s)],
  ];
  function ddc(s) {
    const view = /^ddc_/.test(s.cacheNav) ? s.cacheNav : 'ddc_zen';
    const seen = s.ddcViewsSeen || {};
    return h('div', { className: 'ddc-views', style: ddcViewShell },
      DDC_VIEWS.map(([id, render]) => (seen[id]
        ? h('div', { key: id, className: 'ddc-view', style: Object.assign({}, ddcViewShell, { display: view === id ? 'flex' : 'none' }) }, render(s))
        : null)));
  }

  /* =================== inspector router (right column) =================== */
  function detail(s) {
    /* DDC PAK 的操作全部整合进主视图双栏，检查器不再承载 PAK；给出说明性空态 */
    if (s.cacheNav === 'ddc_pak') return h('div', { className: 'insp-empty' },
      h('div', { className: 'ph' }, h(Icon, { name: 'panel', size: 30 })),
      h('div', null,
        h('div', { style: { color: 'var(--chrome-dim)', fontWeight: 600, marginBottom: 4 } }, 'DDC PAK 已整合到主视图'),
        '扫描、生成、已部署与分发都在左右双栏中就地完成，无需检查器'));
    if (s.cacheNav === 'ddc_pso') return window.VOLO_CACHE_PSO_DASH.inspector(s);
    return null;
  }

  /* DDC 域导出：生成/分发/行组件。扫描类 helper 由各页直引 cacheProjectScan。 */
  window.VOLO_CACHE_DDC = { ddc, detail, projRow, genPak, batchReduce };
})();

export {};
