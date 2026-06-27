// @ts-nocheck
/* Volo — Cache · DDC 管理 (§6) — 折叠子菜单分视图：ZenServer / 传统 DDC(本地+共享) / DDC PAK / PSO.
   1:1 port of the Claude Design handoff `src/cache_ddc.jsx`. */
import * as React from "react";
import "../ds";
import "./cache";
import { deleteShare as deleteShareCmd, discoverProjects, createShare,
  generateDdcPak, startPsoCollection, verifyPakOutput, listPsoCacheFiles,
  distributeDdcPak, distributePsoCache } from "../api/commands";

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect } = React;
  const h = React.createElement;
  const CX = window.VOLO_CX;

  const TITLE = { ddc_zen: 'ZenServer', ddc_legacy: '文件系统 DDC', ddc_pak: 'DDC PAK', ddc_pso: 'PSO 缓存' };

  const humanBytes = (b) => b == null ? '—'
    : b >= 1e9 ? (b / 1073741824).toFixed(1) + ' GB'
    : b >= 1e6 ? (b / 1048576).toFixed(0) + ' MB'
    : (b / 1024).toFixed(0) + ' KB';

  /* UeRunnerEvent reduce（generate_ddc_pak / start_pso_collection 共用进度流）.
     payload = {job_id, source_machine_id, project_id, event:UeRunnerEvent}，
     event 是 tag='kind' 的联合。pct 量纲不定（0..1 或 0..100），<=1 视为比例 *100。 */
  const ueLineLv = (pk) => pk && /error/i.test(pk) ? 'err' : pk && /warn/i.test(pk) ? 'warn' : 'info';
  const ueProgressReduce = (p, terminalOnCompleted) => {
    const e = p && p.event ? p.event : {};
    switch (e.kind) {
      case 'spawned':   return { pct: 8, log: { lv: 'info', msg: '已启动 · pid ' + e.pid } };
      case 'log_line':  return { log: { lv: ueLineLv(e.parsed_kind), msg: e.text } };
      case 'progress': {
        const pct = e.pct == null ? null : (e.pct <= 1 ? e.pct * 100 : e.pct);
        return { pct: terminalOnCompleted ? pct : (pct == null ? null : Math.min(96, pct)), log: e.label ? { lv: 'info', msg: e.label } : null };
      }
      case 'completed':
        return terminalOnCompleted
          ? { done: true, ok: e.exit_code === 0, exit: e.exit_code, log: { lv: e.exit_code === 0 ? 'ok' : 'err', msg: '退出码 ' + e.exit_code } }
          : { pct: 96, log: { lv: 'info', msg: 'UE 进程结束（退出码 ' + e.exit_code + '）· 汇总缓存…' } };
      case 'cancelled': return { done: true, ok: false, log: { lv: 'warn', msg: '已取消' } };
      case 'error':     return { done: true, ok: false, exit: 2, log: { lv: 'err', msg: e.message } };
      default:          return {};
    }
  };
  /* generate：ue-runner 'completed' 即终止；pak-verified 是次级校验事件（非终止）。
     注：pak-verified 在 completed 后才发，finalize 已同步 unlisten → 这行校验日志可能
     被吞（best-effort）；任务成败由 completed 的 exit_code 决定，用户可另点④校验产物。 */
  const genReduce = (ev, p) => ev === 'pak-verified'
    ? { log: { lv: p.verified ? 'ok' : 'warn', msg: '产物校验 ' + (p.verified ? '通过' : '未通过') + (p.output && p.output.path ? (' · ' + p.output.path) : '') } }
    : ueProgressReduce(p, true);
  /* pso collect：真终止是 pso-collect-finalized；ue-runner 'completed' 仅推进到 96%。 */
  const psoReduce = (ev, p) => ev === 'pso-collect-finalized'
    ? (p.error_message
        ? { done: true, ok: false, exit: 2, log: { lv: 'err', msg: p.error_message } }
        : { done: true, ok: true, log: { lv: 'ok', msg: '已收集 ' + (p.files_collected == null ? '?' : p.files_collected) + ' 个 PSO 缓存' } })
    : ueProgressReduce(p, false);

  /* 分发流（pak / pso-distribute-progress）共用：payload {…, event:BatchEvent}，
     BatchEvent {machine_id, status:'running'|'ok'|'err', message}。无「全部完成」哨兵事件
     → 数到 st.total（=plan 长度）个终态(ok|err)即收尾，期间任一 err 则整体失败。 */
  const batchReduce = (ev, p, st) => {
    const e = p && p.event ? p.event : {};
    st.terminal = st.terminal || new Set();
    const mid = e.machine_id;
    if (e.status === 'running') return { log: { lv: 'info', msg: '分发中 · 机器 ' + mid } };
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

  function DDC({ s }) {
    /* srv：SMB 共享创建的宿主机选择（sharedNode 由它派生）。ZenServer 相关 state
       （dataDir/zenReadback/clientDir/joined）随旧 zenBody 一并删除。 */
    const [srv, setSrv] = useState('rn0');
    /* 文件系统 DDC · 本地 DDC：每台机器独立路径 + 独立/一键部署 */
    const [localDirs, setLocalDirs] = useState(() => {
      const m = {};
      RENDER_NODES.forEach((n) => { const drv = /^([A-Za-z]):/.test(n.uePath) ? n.uePath[0].toUpperCase() : 'D'; m[n.id] = drv + ':\\UE_DDC\\Local'; });
      return m;
    });
    const [localDeployed, setLocalDeployed] = useState(() => RENDER_NODES.filter((n) => n.status !== 'offline').map((n) => n.id));
    /* DDC PAK：扫工程 → 选工程 → 生成 */
    const [pakProj, setPakProj] = useState(null);
    const [pakSrc, setPakSrc] = useState(null);
    const [pakBackend, setPakBackend] = useState('zen');
    const [pakRoots, setPakRoots] = useState('D:\\Projects;E:\\UEProjects');
    const [pakScope, setPakScope] = useState('all');
    const [pakVerify, setPakVerify] = useState({}); /* projId -> verify_pak_output 结果 */
    const [shareCred, setShareCred] = useState('c1'); /* 共享 DDC 创建/接入的运维凭据 */
    /* 文件系统 DDC · 共享创建（create_share）表单：share_name + local_path + mode。 */
    const [shareName, setShareName] = useState('Volo_DDC');
    const [shareLocal, setShareLocal] = useState('D:\\Volo\\DDC');
    const [shareMode, setShareMode] = useState('open'); /* 'open'(Mode A) | 'managed'(Mode B) */
    /* PSO：按机器搜工程 → 选工程 → 收集（PSO 按 GPU 签名生成） */
    const [psoProj, setPsoProj] = useState(null);
    const [psoSrc, setPsoSrc] = useState(null);
    const [psoRes, setPsoRes] = useState('1920×1080');
    const [psoMax, setPsoMax] = useState('20');
    const [psoScope, setPsoScope] = useState('all');
    const [psoRoots, setPsoRoots] = useState('D:\\Projects;E:\\UEProjects');
    /* 已收集的 PSO 缓存（list_pso_cache_files，按选中工程加载，替代 ARTIFACTS mock）。 */
    const [psoFiles, setPsoFiles] = useState([]);

    /* PSO 列表随选中工程变化重载；收集完成后也手动调一次（见 collectPso）。 */
    const loadPsoFor = (projId) => {
      if (projId == null) { setPsoFiles([]); return; }
      listPsoCacheFiles(Number(projId), null, null).then(
        (fs) => setPsoFiles(Array.isArray(fs) ? fs : []),
        () => setPsoFiles([]));
    };
    useEffect(() => { loadPsoFor(psoProj); /* eslint-disable-line */ }, [psoProj]);

    const view = /^ddc_/.test(s.cacheNav) ? s.cacheNav : 'ddc_zen';

    /* ZenServer 视图已拆分到独立组件 cacheZen.tsx（真实分步部署 + 客户端指向）。
       它自带状态/空态处理，故在此处早返回，不走下面的 gate / sharedNode 等。 */
    if (view === 'ddc_zen') return window.VOLO_CACHE_ZEN.view(s);

    /* three-channel gate (色+图标+文字) — the DDC views are built against real
       machine ids (srv / sharedNode / selectors); don't render the mock-shaped
       body until the backend read-path has machines (mirrors the Overview gate). */
    if (s.cacheError) return h('div', { className: 'res ddc' }, h('div', { className: 'ddc-body' },
      h('div', { className: 'gen-empty' },
        h('span', { className: 's-negative', style: { display: 'flex' } }, h(Icon, { name: 'alert', size: 22 })),
        h('span', null, '加载集群数据失败 · ' + s.cacheError),
        h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'sync', size: 14 }), onPress: s.reloadCache }, '重试'))));
    if (s.cacheLoading) return h('div', { className: 'res ddc' }, h('div', { className: 'ddc-body' },
      h('div', { className: 'gen-empty' },
        h('span', { className: 's-informative', style: { display: 'flex' } }, h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 20 }))),
        h('span', null, '正在加载集群数据…'))));
    if (!RENDER_NODES.length) return h('div', { className: 'res ddc' }, h('div', { className: 'ddc-body' },
      h('div', { className: 'gen-empty' }, h(Icon, { name: 'node', size: 22 }),
        h('span', null, '集群里还没有机器 — 先在「集群总览」扫描添加机器，再配置 DDC'))));

    /* resolve the chosen server to a real node — persisted `srv` may be a stale
       mock id ('rn0') now that machines come from the backend; fall back to the
       first non-shared (else first) node so sharedNode is never undefined. */
    const sharedNode = CX.node(srv) || RENDER_NODES.find((n) => n.roleKey !== 'shared') || RENDER_NODES[0];
    /* 真实 PSO 缓存文件（list_pso_cache_files）→ artRow 形状；PsoCacheFile 无
       verified 字段，统一显示「已收集」；size_bytes 数字 → humanBytes。 */
    const psos = psoFiles.map((f) => ({ id: f.id, kind: 'PSO', name: f.file_name,
      size: humanBytes(f.size_bytes), built: f.collected_at || '—', verified: true,
      gpuSig: f.gpu_signature, srcId: f.source_machine_id }));
    const srvOpts = RENDER_NODES.map((n) => ({ id: n.id, label: n.host, sub: n.ip }));
    const credList = s.creds || CREDS;
    const credOpts = credList.map((c) => ({ id: c.id, label: c.name, sub: c.kind }));
    const credName = (id) => (credList.find((c) => c.id === id) || credList[0] || { name: '—' }).name;

    /* ---- deploy flows ----（ZenServer 部署「假一条龙」已删，真实分步部署在 cacheZen.tsx）*/
    /* 真实 create_share：host=sharedNode.machineId，mode 序列化为 'open'|'managed'
       （非显示串），share_name + local_path 来自表单；operator_credential_alias 废弃
       传 null（SSH key 鉴权）；Mode B 的 svc_username 留空 → 后端默认 'ddc-svc'。 */
    const deploySMB = () => CX.openPreview(s, {
      title: '创建共享 DDC（SMB）', icon: 'folder', cli: 'create_share', destructive: false, channel: 'ssh', confirmLabel: '创建共享',
      steps: ['在 ' + sharedNode.host + ' 上新建共享缓存文件夹 ' + shareLocal,
        '共享名 ' + shareName + (shareMode === 'managed' ? '（Mode B · 专用账号 ddc-svc）' : '（Mode A · 开放）'),
        '集群缓存指向该共享，客户端自动接入'],
      simpleScope: [{ host: sharedNode.host, ip: sharedNode.ip, msg: shareLocal }],
      onConfirm: () => {
        if (!sharedNode || !shareName.trim() || !shareLocal.trim()) return;
        s.runCmd({ domain: 'share', action: 'create', target: sharedNode.host, chan: 'ssh', note: 'SMB 共享 DDC（' + shareMode + '）' },
          () => createShare(sharedNode.machineId, shareMode, shareName.trim(), shareLocal.trim(), null, null),
          { okMsg: (r) => '共享已创建 · ' + r.unc_path })
          .then(() => s.reloadCache(), () => {});
      },
    });
    /* 删除共享 DDC：仅从 Volo 解除纳管，不删远端共享文件夹（后端暂不支持 also_remove_remote）*/
    const deleteShare = (sh) => CX.openPreview(s, {
      title: '解除共享纳管 · ' + sh.path, icon: 'trash', cli: 'delete_share', destructive: true, channel: 'ssh', confirmLabel: '解除纳管',
      steps: ['从 Volo 解除对该共享的纳管（不再分发 / 不再注入客户端）', '不会删除远端共享文件夹本身（后端暂不支持远端删共享）'],
      simpleScope: [{ host: sh.path, ip: sh.clients + ' 客户端', msg: '仅解除纳管' }],
      /* 真实 delete_share：仅删 DB 行（also_remove_remote=false，后端忽略）；用 numeric
         shareConfigId（0 跳过，否则 delete(db,0) 静默 no-op）；成功后 reloadCache。 */
      onConfirm: () => {
        if (!sh.shareConfigId) return;
        s.runCmd({ domain: 'share', action: 'delete', target: sh.path, chan: 'ssh', note: '解除共享纳管（远端保留）' },
          () => deleteShareCmd(sh.shareConfigId, false), { okMsg: () => sh.path + ' 已解除纳管 · 远端文件夹保留' })
          .then(() => s.reloadCache(), () => {});
      },
    });
    const deployLocal = () => CX.openPreview(s, {
      title: '开启本地 DDC', icon: 'server', cli: 'local-cache create', destructive: false, channel: 'winrm', confirmLabel: '开启',
      steps: ['在这台机器本地新建一个缓存目录', '作为找不到共享缓存时的本地兜底'],
      simpleScope: [{ host: sharedNode.host, ip: sharedNode.ip, msg: '本地缓存目录' }],
      task: { domain: 'local-cache', action: 'create', target: sharedNode.host, chan: 'winrm', note: '本地 DDC 已开启', lines: [{ msg: 'local-cache create D:\\UE_DDC\\Local' }, { lv: 'ok', msg: '本地缓存层已就绪' }] },
    });

    /* ---- cache content ---- */
    /* discover_projects：远程扫各机 .uproject（只发现不写盘） */
    /* 真实 discover_projects：命令只收单台 machineId，scope='all' 时前端对全部在线机
       fan-out（allSettled 容部分失败）；rootsStr 分号串 split 成 search_roots[]；
       发现写库后 reloadCache 刷新 window.UE_PROJECTS（loadProjects 重跑）。 */
    const runDiscover = (scope, rootsStr) => {
      const roots = (rootsStr || '').split(';').map((r) => r.trim()).filter(Boolean);
      if (!roots.length) return;
      const targets = scope === 'all'
        ? RENDER_NODES.filter((n) => n.status !== 'offline').map((n) => n.machineId)
        : [CX.node(scope) ? CX.node(scope).machineId : null].filter((x) => x != null);
      if (!targets.length) return;
      const tgtLabel = scope === 'all' ? targets.length + ' 台在线机' : (CX.node(scope) || {}).host;
      s.runCmd({ domain: 'project', action: 'discover', target: tgtLabel, chan: 'winrm', note: '远程扫描 UE 工程（.uproject）' },
        () => Promise.allSettled(targets.map((mid) => discoverProjects(mid, roots, null))).then((rs) => {
          const ok = rs.filter((r) => r.status === 'fulfilled');
          if (!ok.length) throw new Error('全部目标扫描失败');
          const found = ok.reduce((a, r) => a + (Array.isArray(r.value) ? r.value.length : 0), 0);
          return { found, failed: rs.length - ok.length };
        }),
        { okMsg: (r) => '发现 ' + r.found + ' 个工程位置' + (r.failed ? ('（' + r.failed + ' 台失败）') : '') })
        .then(() => s.reloadCache(), () => {});
    };
    const scanProjects = () => runDiscover(pakScope, pakRoots);
    const scanPso = () => runDiscover(psoScope, psoRoots);
    /* generate_ddc_pak：针对选定工程 + 源机器 + 后端，编 shader 生成 PAK（长任务） */
    /* 真实 generate_ddc_pak（流式）：backend 固定 'remote'（BackendChoice 是执行位置，
       与 UI 的 pakBackend 'zen'/'legacy' 存储后端无关）；ue_version 传 null（后端取
       primary 安装）；ue-runner-progress 'completed' 即终止，pak-verified 是次级校验。 */
    const genPak = () => {
      const p = UE_PROJECTS.find((x) => x.id === pakProj);
      if (!p) return;
      const src = CX.node(pakSrc) || CX.node(p.primary);
      if (!src) return; /* 工程无 location（机器列表为空）时跳过 */
      s.runStreamingCmd(
        { domain: 'ddc', action: 'generate', target: p.name, chan: 'winrm', note: '生成 DDC PAK · ' + p.name + '（长任务）' },
        () => generateDdcPak('remote', Number(p.id), src.machineId, null, null, null, null),
        { mode: 'event', events: ['ue-runner-progress', 'pak-verified'], jobIdOf: (r) => r.job_id, reduce: genReduce, timeoutMs: 45 * 60 * 1000 });
    };
    /* 真实 start_pso_collection（流式）：psoRes '1920×1080' 用 U+00D7 分隔需 split；
       psoMax 字符串 parseInt；windowed 固定 true；ue_version null；真终止是
       pso-collect-finalized；完成后重载 PSO 列表。 */
    const collectPso = () => {
      const p = UE_PROJECTS.find((x) => x.id === psoProj);
      if (!p) return;
      const src = CX.node(psoSrc) || CX.node(p.primary);
      if (!src) return;
      const parts = String(psoRes).split('×');
      const rw = Number(parts[0]) || 1920, rh = Number(parts[1]) || 1080;
      const mm = parseInt(psoMax, 10) || 20;
      s.runStreamingCmd(
        { domain: 'pso', action: 'collect', target: p.name, chan: 'winrm', note: '收集 PSO 缓存 · ' + p.name + '（长任务 · NDJSON）' },
        () => startPsoCollection(src.machineId, Number(p.id), rw, rh, true, mm, null, null),
        { mode: 'event', events: ['ue-runner-progress', 'pso-collect-finalized'], jobIdOf: (r) => r.job_id, reduce: psoReduce, timeoutMs: (mm + 5) * 60 * 1000 })
        .then(() => loadPsoFor(p.id), () => loadPsoFor(p.id));
    };
    /* 真实分发（流式）：PAK 用 source(pakSrc/工程 primary)+project；PSO 用 file_id(art.id)。
       目标机来自确认门里编辑后的选择（排除源机、转 numeric machineId）。PSO 默认
       force_gpu_mismatch=false：目标 GPU 不匹配后端会同步拒绝 → 任务标失败并显示原因。 */
    const distribute = (art) => {
      const isPso = art.kind === 'PSO';
      const proj = isPso ? null : UE_PROJECTS.find((x) => x.id === pakProj);
      const srcNode = isPso ? null : (CX.node(pakSrc) || (proj ? CX.node(proj.primary) : null));
      const srcId = isPso ? art.srcId : (srcNode ? srcNode.machineId : null);
      if (isPso && art.id == null) return; /* 没有 file_id 不能分发 PSO */
      if (!isPso && (srcId == null || pakProj == null)) return;
      const scopeIds = RENDER_NODES.filter((n) => n.status !== 'offline' && n.roleKey === 'render').map((n) => n.id);
      CX.openPreview(s, {
        title: '分发 · ' + art.name, icon: 'download', cli: (isPso ? 'pso' : 'ddc') + ' distribute', destructive: false, channel: 'winrm',
        steps: ['把这份缓存包复制分发到选中的渲染机',
          isPso ? 'PSO 与 GPU 绑定：目标机 GPU 签名不匹配时后端会拒绝' : '只传缺少的部分，已有的自动跳过',
          '逐台显示成功 / 失败'],
        scope: scopeIds,
        onConfirm: (sel) => {
          const targets = (sel || []).map((id) => (CX.node(id) || {}).machineId).filter((x) => x != null && x !== srcId);
          if (!targets.length) return;
          const evName = isPso ? 'pso-distribute-progress' : 'pak-distribute-progress';
          s.runStreamingCmd(
            { domain: isPso ? 'pso' : 'ddc', action: 'distribute', target: art.name, chan: 'winrm', note: '分发 · ' + art.name + ' → ' + targets.length + ' 台' },
            () => isPso
              ? distributePsoCache({ file_id: art.id, target_machine_ids: targets, named_share_unc: null, operator_credential_alias: null, source_smb_credential_alias: null, force_gpu_mismatch: false })
              : distributeDdcPak(srcId, Number(pakProj), targets, null, null, null),
            { mode: 'event', events: [evName], jobIdOf: (r) => r.job_id, total: (r) => (r.plan || []).length, reduce: batchReduce });
        },
      });
    };

    const artRow = (a) => h('div', { key: a.id, className: 'art-row' },
      h('span', { className: 'art-dot s-' + (a.verified ? 'positive' : 'notice') }, h(Icon, { name: a.verified ? 'check' : 'alert', size: 12 })),
      h('div', { className: 'art-meta' }, h('div', { className: 'art-name mono' }, a.name), h('div', { className: 'art-sub' }, a.size + ' · ' + a.built + (a.verified ? ' · 已校验' : ' · 未校验'))),
      h('button', { className: 'mini-btn', onClick: () => distribute(a) }, h(Icon, { name: 'download', size: 12 }), '分发'));

    const shareRow = (sh) => h('div', { key: sh.id, className: 'art-row' },
      h('span', { className: 'art-dot s-' + (sh.status === 'healthy' ? 'positive' : 'notice') }, h(Icon, { name: 'folder', size: 12 })),
      h('div', { className: 'art-meta' }, h('div', { className: 'art-name mono' }, sh.path), h('div', { className: 'art-sub' }, sh.mode + ' · ' + sh.clients + ' 客户端 · ' + sh.size)),
      h('button', { className: 'mini-btn danger', onClick: () => deleteShare(sh) }, h(Icon, { name: 'trash', size: 12 }), '解除纳管'));

    /* 单个后端面板（介绍卡 + 部署表单）— 仅 SMB / 本地（ZenServer 拆到 cacheZen.tsx）。 */
    const backendPanel = (beId) => {
      const b = DDC_BACKENDS.find((x) => x.id === beId) || DDC_BACKENDS[0];
      const doDeploy = beId === 'smb' ? deploySMB : deployLocal;
      return h('div', { className: 'be-block', key: beId },
        h('div', { className: 'deploy-panel' },
          h('div', { className: 'dp-h' }, h(Icon, { name: b.icon, size: 15 }), '部署 ' + b.label,
            b.current ? h('span', { className: 'dp-cur' }, h(Icon, { name: 'check', size: 11 }), '已部署') : null),
          h('div', { className: 'dp-form' },
            h('div', { className: 'dp-field' }, h('label', null, '服务器机器'),
              h(Selector, { kpre: '机器', value: sharedNode.id, options: srvOpts, width: 240, onChange: setSrv })),
            beId === 'smb' ? h(React.Fragment, null,
              h('div', { className: 'dp-field' }, h('label', null, '共享名'),
                h('input', { className: 'dp-input mono', value: shareName, spellCheck: false, onChange: (e) => setShareName(e.target.value) })),
              h('div', { className: 'dp-field' }, h('label', null, '本地路径'),
                h('input', { className: 'dp-input mono', value: shareLocal, spellCheck: false, onChange: (e) => setShareLocal(e.target.value) })),
              h('div', { className: 'dp-field' }, h('label', null, '模式'),
                h(Selector, { kpre: '模式', value: shareMode, width: 200, onChange: setShareMode,
                  options: [{ id: 'open', label: 'Mode A · 开放' }, { id: 'managed', label: 'Mode B · 专用账号' }] }))) : null,
            h('div', { className: 'dp-go' }, h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), onPress: doDeploy }, b.current ? '重新部署' : '部署 ' + b.label))),
          h('div', { className: 'dp-note' }, h(Icon, { name: 'shield', size: 13 }), '链路在后台逐步执行（进度进任务抽屉）；凭据 / urlacl / 服务安装全部自动处理。')));
    };

    /* ZenServer ①服务器 + ②客户端 已拆分到独立组件 cacheZen.tsx（真实分步部署 + 客户端指向）；
       旧 zenBody / joinClient / joinAll / clientRow（假的「加入共享」+ 写死回读）已删除。 */

    /* 文件系统 DDC = 共享 DDC（上）+ 本地 DDC（下，逐台列表）*/
    const onlineLocalTargets = RENDER_NODES.filter((n) => n.status !== 'offline');
    const setLocalDir = (id, v) => setLocalDirs((m) => Object.assign({}, m, { [id]: v }));
    const deployLocalOne = (n) => CX.openPreview(s, {
      title: '部署本地 DDC · ' + n.host, icon: 'server', cli: 'local-cache create', destructive: false, channel: 'winrm', confirmLabel: '部署',
      steps: ['在这台机器本地新建缓存目录 ' + localDirs[n.id], '作为找不到共享缓存时的本地兜底，配置后自动复核'],
      simpleScope: [{ host: n.host, ip: n.ip, msg: localDirs[n.id] }],
      task: { domain: 'local-cache', action: 'create', target: n.host, chan: 'winrm', note: '本地 DDC 已部署 · ' + localDirs[n.id],
        lines: [{ msg: 'local-cache create ' + localDirs[n.id] }, { lv: 'ok', msg: n.host + ' 本地缓存层已就绪' }] },
      onConfirm: () => setLocalDeployed((d) => d.includes(n.id) ? d : d.concat(n.id)),
    });
    const deployLocalAll = () => CX.openPreview(s, {
      title: '一键部署本地 DDC', icon: 'bolt', cli: 'local-cache create', destructive: false, channel: 'winrm', confirmLabel: '部署 ' + onlineLocalTargets.length + ' 台',
      steps: ['为这些机器逐台在本地新建缓存目录', '作为找不到共享缓存时的本地兜底，配置后自动复核'],
      simpleScope: onlineLocalTargets.map((n) => ({ host: n.host, ip: n.ip, msg: localDirs[n.id] })),
      task: { domain: 'local-cache', action: 'create', target: onlineLocalTargets.length + ' 台', chan: 'winrm', note: '一键部署本地 DDC（' + onlineLocalTargets.length + ' 台）',
        lines: [{ msg: 'local-cache create ×' + onlineLocalTargets.length }, { lv: 'ok', msg: onlineLocalTargets.length + ' 台本地缓存层已就绪' }] },
      onConfirm: () => setLocalDeployed((d) => Array.from(new Set(d.concat(onlineLocalTargets.map((n) => n.id))))),
    });
    const localRow = (n) => {
      const dep = localDeployed.includes(n.id);
      const off = n.status === 'offline';
      return h('div', { key: n.id, className: 'cli-row local' + (off ? ' off' : '') + (dep ? ' on' : '') },
        CX.dot(NODE_STATUS[n.status].visual),
        h('div', { className: 'cli-meta' },
          h('div', { className: 'cli-host mono' }, n.host),
          h('div', { className: 'cli-sub' }, n.ip + ' · ' + n.role)),
        h('input', { className: 'cli-pathin mono', value: localDirs[n.id], disabled: off,
          spellCheck: false, onChange: (e) => setLocalDir(n.id, e.target.value) }),
        h('div', { className: 'local-act' },
          off ? h('span', { className: 'cli-badge off' }, h(Icon, { name: 'power', size: 11 }), '离线')
            : dep ? h('span', { className: 'cli-badge ok' }, h(Icon, { name: 'check', size: 11 }), '已部署')
            : h('span', { className: 'cli-badge none' }, h(Icon, { name: 'minus', size: 11 }), '未部署'),
          off ? null
            : h('button', { className: 'mini-btn', onClick: () => deployLocalOne(n) },
                h(Icon, { name: dep ? 'sync' : 'bolt', size: 12 }), dep ? '重新部署' : '部署')));
    };

    const legacyBody = h(React.Fragment, null,
      h('div', { className: 'ddc-sec-h' }, h('span', null, '① 共享 DDC（SMB）'), h('span', { className: 'dim' }, '局域网共享缓存盘 · 无独立服务器的小集群')),
      backendPanel('smb'),
      SHARES.length ? h(React.Fragment, null,
        h('div', { className: 'ddc-sec-h' }, h('span', null, '已纳管的共享'), h('span', { className: 'dim' }, SHARES.length + ' 个 · 解除纳管不删除远端文件夹')),
        h('div', { className: 'art-list' }, SHARES.map(shareRow))) : null,
      h('div', { className: 'ddc-sec-h' },
        h('span', null, '② 本地 DDC'),
        h('span', { className: 'dim' }, localDeployed.length + ' / ' + RENDER_NODES.length + ' 已部署 · 每台可单独设置 data-dir')),
      h('div', { className: 'cli-panel' },
        h('div', { className: 'cli-top' },
          h('div', { className: 'local-hint' }, h(Icon, { name: 'server', size: 15 }), '逐台开启本地缓存回退层 · 每台独立 data-dir，可单独部署'),
          h('div', { className: 'cli-go' },
            h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), isDisabled: onlineLocalTargets.length === 0, onPress: deployLocalAll },
              '一键部署（' + onlineLocalTargets.length + '）'))),
        h('div', { className: 'cli-note' }, h(Icon, { name: 'shield', size: 13 }),
          '本地 DDC 作为命中链路的回退层；部署链路在后台逐步执行，写入后自动回读校验。'),
        h('div', { className: 'cli-list' }, RENDER_NODES.map(localRow))));

    /* ---- DDC PAK：① 扫工程 → ② 选工程 → ③ 生成 ---- */
    const selProj = UE_PROJECTS.find((x) => x.id === pakProj) || null;
    const projMachines = selProj ? RENDER_NODES.filter((n) => selProj.machines.includes(n.id) && n.status !== 'offline') : [];
    const srcOpts = projMachines.map((n) => ({ id: n.id, label: n.host, sub: n.ip }));
    const backendOpts = [{ id: 'zen', label: 'ZenServer 后端' }, { id: 'legacy', label: '文件系统后端' }];
    const scopeOpts = [{ id: 'all', label: '全部在线机' }].concat(RENDER_NODES.filter((n) => n.status !== 'offline').map((n) => ({ id: n.id, label: n.host, sub: n.ip })));
    const projRow = (p, selId, onSel) => {
      const on = p.id === selId;
      return h('div', { key: p.id, className: 'proj-row' + (on ? ' on' : ''), onClick: () => onSel(p) },
        h('span', { className: 'proj-mck' + (on ? ' on' : '') }, on ? h(Icon, { name: 'check', size: 12 }) : null),
        h('span', { className: 'proj-ico' }, h(Icon, { name: 'film', size: 17 })),
        h('div', { className: 'proj-main' },
          h('div', { className: 'proj-name' }, p.name),
          h('div', { className: 'proj-sub' }, p.root + '\\' + p.uproject)),
        h('div', { className: 'proj-tags' },
          h('span', { className: 'proj-tag ue' }, 'UE ' + p.ue),
          h('span', { className: 'proj-tag' }, p.size),
          h('span', { className: 'proj-tag' }, p.machines.length + ' 台'),
          p.hasPak ? h('span', { className: 'proj-tag pak' }, h(Icon, { name: 'check', size: 10 }), '已有 PAK') : null,
          p.warn ? h('span', { className: 'proj-tag warn', title: p.warn }, h(Icon, { name: 'alert', size: 10 }), '版本不一致') : null));
    };
    const selectPak = (p) => { setPakProj(p.id); setPakSrc(p.primary); };

    /* 真实 verify_pak_output：返回 PakOutput{path,size_bytes}，产物不存在=后端抛
       OperationFailed（不是 exists:false 的成功态）→ found 由成功/失败分支决定。 */
    const verifyPak = (p) => {
      const src = CX.node(pakSrc) || CX.node(p.primary);
      if (!src) return;
      s.runCmd({ domain: 'ddc', action: 'verify', target: p.name, chan: 'ssh', note: '校验 DDC PAK 产物 · ' + p.name },
        () => verifyPakOutput(src.machineId, Number(p.id), null),
        { okMsg: (r) => '产物存在 · ' + r.path + ' · ' + humanBytes(r.size_bytes) })
        .then(
          (r) => setPakVerify((m) => Object.assign({}, m, { [p.id]: { found: true, path: r.path, sizeBytes: r.size_bytes } })),
          () => setPakVerify((m) => Object.assign({}, m, { [p.id]: { found: false } })));
    };
    const pakStatusCard = (p) => {
      const v = pakVerify[p.id];
      const src = CX.node(pakSrc) || CX.node(p.primary);
      return h('div', { className: 'gen-panel' },
        h('div', { className: 'gen-summary' },
          h('span', { className: 'gen-ico' }, h(Icon, { name: 'cache', size: 17 })),
          h('div', { className: 'gen-sum-txt' },
            h('div', { className: 'gen-sum-t' }, h('span', { className: 'gen-sum-name' }, p.name), h('span', { className: 'gen-sum-ue' }, 'UE ' + p.ue)),
            h('div', { className: 'gen-sum-d mono' }, '校验源 · ' + ((src || {}).host || '—'))),
          h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'search', size: 14 }), onPress: () => verifyPak(p) }, v ? '重新校验' : '校验产物')),
        v
          ? h('div', { className: 'pak-verify' + (v.found ? ' ok' : ' miss') },
              h('div', { className: 'pak-verify-h' },
                h('span', { className: 'pv-ico s-' + (v.found ? 'positive' : 'notice') }, h(Icon, { name: v.found ? 'check' : 'alert', size: 14 })),
                h('span', { className: 'pv-state' }, v.found ? '产物存在' : '未找到产物')),
              v.found
                ? h(React.Fragment, null,
                    h('div', { className: 'pak-verify-kv' },
                      h('div', { className: 'pvk' }, h('span', { className: 'k' }, '路径'), h('span', { className: 'v mono' }, v.path)),
                      h('div', { className: 'pvk' }, h('span', { className: 'k' }, '大小'), h('span', { className: 'v' }, humanBytes(v.sizeBytes)))),
                    h('div', { className: 'pak-verify-act' }, h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'download', size: 14 }), onPress: () => distribute({ kind: 'DDC pak', name: 'DDC_' + p.name }) }, '分发到渲染机')))
                : h('div', { className: 'pak-verify-note' }, h(Icon, { name: 'eye', size: 12 }), '该工程在源机上尚无 PAK 产物，先在上方③生成。'))
          : h('div', { className: 'pak-verify-hint' }, h(Icon, { name: 'eye', size: 13 }), '点「校验产物」检查该工程在源机上的 PAK 是否存在（路径 / 大小）。'));
    };

    const pakBody = h(React.Fragment, null,
      h('div', { className: 'ddc-sec-h' }, h('span', null, '① 扫描 UE 工程'), h('span', { className: 'dim' }, 'discover_projects · 远程扫 .uproject，只发现不写盘')),
      h('div', { className: 'pak-scan' },
        h('div', { className: 'pak-scan-fields' },
          h('div', { className: 'dp-field' }, h('label', null, '扫描范围'),
            h(Selector, { kpre: '范围', value: pakScope, options: scopeOpts, width: 178, onChange: setPakScope })),
          h('div', { className: 'dp-field grow' }, h('label', null, '搜索根目录'),
            h('input', { className: 'dp-input mono', value: pakRoots, spellCheck: false, onChange: (e) => setPakRoots(e.target.value) })),
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'search', size: 14 }), onPress: scanProjects }, '扫描')),
        h('div', { className: 'pak-scan-meta' }, h(Icon, { name: 'check', size: 12 }), '上次扫描 今天 13:32 · 发现 3 个工程 / 6 台机器')),

      h('div', { className: 'ddc-sec-h' }, h('span', null, '② 选择工程'), h('span', { className: 'dim' }, selProj ? '已选 · ' + selProj.name : '选中后针对该工程生成 DDC PAK')),
      h('div', { className: 'proj-list' }, UE_PROJECTS.map((p) => projRow(p, pakProj, selectPak))),

      h('div', { className: 'ddc-sec-h' }, h('span', null, '③ 生成 DDC PAK'), h('span', { className: 'dim' }, 'generate_ddc_pak · GPU 不匹配 preflight 后台自动比对')),
      selProj
        ? h('div', { className: 'gen-panel' },
            h('div', { className: 'gen-summary' },
              h('span', { className: 'gen-ico' }, h(Icon, { name: 'cache', size: 17 })),
              h('div', { className: 'gen-sum-txt' },
                h('div', { className: 'gen-sum-t' }, h('span', { className: 'gen-sum-name' }, selProj.name), h('span', { className: 'gen-sum-ue' }, 'UE ' + selProj.ue)),
                h('div', { className: 'gen-sum-d mono' }, selProj.root + '\\' + selProj.uproject)),
              h('span', { className: 'gen-sum-size' }, selProj.size)),
            selProj.warn ? h('div', { className: 'gen-warn' }, h(Icon, { name: 'alert', size: 13 }), selProj.warn + ' · 生成前请确认引擎版本') : null,
            h('div', { className: 'gen-form' },
              h('div', { className: 'dp-field' }, h('label', null, '生成源机器'),
                h(Selector, { kpre: '机器', value: pakSrc || selProj.primary, options: srcOpts, width: 220, onChange: setPakSrc })),
              h('div', { className: 'dp-field' }, h('label', null, '后端'),
                h(Selector, { kpre: '后端', value: pakBackend, options: backendOpts, width: 178, onChange: setPakBackend }))),
            h('div', { className: 'gen-foot' },
              h('div', { className: 'gen-foot-note' }, h(Icon, { name: 'shield', size: 13 }), '在源机器上载入 .uproject 编译 shader 生成 PAK · 长任务，进度进任务抽屉；Zen 可达时同时灌入共享上游。'),
              h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), onPress: genPak }, '生成 DDC PAK')))
        : h('div', { className: 'gen-empty' }, h(Icon, { name: 'film', size: 22 }), h('span', null, '先在上方选择一个工程，再生成对应的 DDC PAK')),

      h('div', { className: 'ddc-sec-h', style: { marginTop: 22 } }, h('span', null, '④ 校验该工程产物'), h('span', { className: 'dim' }, 'verify_pak_output · 校验选中工程的单个产物，不列举全部')),
      selProj ? pakStatusCard(selProj) : h('div', { className: 'gen-empty' }, h(Icon, { name: 'cache', size: 22 }), h('span', null, '先在上方选择一个工程，再校验它的 PAK 产物')));

    const selPso = UE_PROJECTS.find((x) => x.id === psoProj) || null;
    const psoMachines = selPso ? RENDER_NODES.filter((n) => selPso.machines.includes(n.id) && n.status !== 'offline') : [];
    const psoSrcOpts = psoMachines.map((n) => ({ id: n.id, label: n.host, sub: n.gpu }));
    const psoSrcNode = selPso ? (CX.node(psoSrc) || CX.node(selPso.primary)) : null;
    const resOpts = [{ id: '1920×1080', label: '1920 × 1080' }, { id: '2560×1440', label: '2560 × 1440' }, { id: '3840×2160', label: '3840 × 2160' }];
    const maxOpts = [{ id: '10', label: '10 分钟' }, { id: '20', label: '20 分钟' }, { id: '30', label: '30 分钟' }];
    const selectPso = (p) => { setPsoProj(p.id); setPsoSrc(p.primary); };

    const psoBody = h(React.Fragment, null,
      h('div', { className: 'ddc-sec-h' }, h('span', null, '① 扫描 UE 工程'), h('span', { className: 'dim' }, 'discover_projects · 可按单台机器搜索 .uproject')),
      h('div', { className: 'pak-scan' },
        h('div', { className: 'pak-scan-fields' },
          h('div', { className: 'dp-field' }, h('label', null, '扫描范围'),
            h(Selector, { kpre: '范围', value: psoScope, options: scopeOpts, width: 178, onChange: setPsoScope })),
          h('div', { className: 'dp-field grow' }, h('label', null, '搜索根目录'),
            h('input', { className: 'dp-input mono', value: psoRoots, spellCheck: false, onChange: (e) => setPsoRoots(e.target.value) })),
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'search', size: 14 }), onPress: scanPso }, '扫描')),
        h('div', { className: 'pak-scan-meta' }, h(Icon, { name: 'check', size: 12 }), '上次扫描 今天 13:32 · 发现 3 个工程 / 6 台机器')),

      h('div', { className: 'ddc-sec-h' }, h('span', null, '② 选择工程'), h('span', { className: 'dim' }, selPso ? '已选 · ' + selPso.name : '选中后针对该工程收集 PSO 缓存')),
      h('div', { className: 'proj-list' }, UE_PROJECTS.map((p) => projRow(p, psoProj, selectPso))),

      h('div', { className: 'ddc-sec-h' }, h('span', null, '③ 收集 PSO 缓存'), h('span', { className: 'dim' }, 'start_pso_collection · 按源机 GPU 签名生成')),
      selPso
        ? h('div', { className: 'gen-panel' },
            h('div', { className: 'gen-summary' },
              h('span', { className: 'gen-ico' }, h(Icon, { name: 'layers', size: 17 })),
              h('div', { className: 'gen-sum-txt' },
                h('div', { className: 'gen-sum-t' }, h('span', { className: 'gen-sum-name' }, selPso.name), h('span', { className: 'gen-sum-ue' }, 'UE ' + selPso.ue)),
                h('div', { className: 'gen-sum-d mono' }, selPso.root + '\\' + selPso.uproject)),
              h('span', { className: 'gen-sum-size' }, selPso.size)),
            psoSrcNode ? h('div', { className: 'gen-gpu' }, h(Icon, { name: 'eye', size: 13 }), 'PSO 与 GPU 绑定，仅对相同 GPU 签名命中 · 当前源机 GPU ', h('b', null, psoSrcNode.gpu + '（' + psoSrcNode.vendor + '）')) : null,
            h('div', { className: 'gen-form' },
              h('div', { className: 'dp-field' }, h('label', null, '收集源机器'),
                h(Selector, { kpre: '机器', value: psoSrc || selPso.primary, options: psoSrcOpts, width: 208, onChange: setPsoSrc })),
              h('div', { className: 'dp-field' }, h('label', null, '渲染分辨率'),
                h(Selector, { kpre: '分辨率', value: psoRes, options: resOpts, width: 168, onChange: setPsoRes })),
              h('div', { className: 'dp-field' }, h('label', null, '最长时长'),
                h(Selector, { kpre: '时长', value: psoMax, options: maxOpts, width: 138, onChange: setPsoMax }))),
            h('div', { className: 'gen-foot' },
              h('div', { className: 'gen-foot-note' }, h(Icon, { name: 'terminal', size: 13 }), 'UE -game 窗口化跑指定分辨率收集 PSO · 长任务，NDJSON 实时流进任务抽屉。'),
              h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), onPress: collectPso }, '收集 PSO 缓存')))
        : h('div', { className: 'gen-empty' }, h(Icon, { name: 'film', size: 22 }), h('span', null, '先在上方选择一个工程，再收集对应的 PSO 缓存')),

      h('div', { className: 'ddc-sec-h', style: { marginTop: 22 } }, h('span', null, '已收集的 PSO 缓存'), h('span', { className: 'dim' }, psos.length + ' 个产物 · 可分发到同 GPU 机器')),
      h('div', { className: 'art-list' }, psos.map(artRow)));

    const headRight = view === 'ddc_zen'
      ? h('span', { className: 'toolchip' }, h(Icon, { name: 'cube', size: 14 }), '当前后端：ZenServer · render-zen-01')
      : null;

    return h('div', { className: 'res ddc' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, 'DDC · ' + TITLE[view]),
        h('div', { className: 'right' }, headRight)),
      h('div', { className: 'ddc-body' },
        view === 'ddc_legacy' ? legacyBody : view === 'ddc_pak' ? pakBody : psoBody));
  }

  window.VOLO_CACHE_DDC = { ddc: (s) => h(DDC, { s }) };
})();

export {};
