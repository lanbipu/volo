// @ts-nocheck
/* Volo — Cache · DDC 管理 (§6) — 折叠子菜单分视图：ZenServer / 文件系统 DDC / DDC PAK / PSO.
   1:1 port of the Claude Design handoff `src/cache_ddc.jsx`（检查器重构版），接真实后端。

   ZenServer / 文件系统 DDC 仍是整页视图；DDC PAK 与 PSO 缓存改为
   「主视图(选工程) + 右侧检查器(操作)」的细节显示模式：
   - 主视图(center)只负责发现 / 选择工程（PAK 多选、PSO 单选），选择提到 shell（s.pakSel / s.psoSel）；
   - 选中工程、生成 / 校验 / 收集 / 分发等操作，全部在右侧检查器(inspector)里就地展开，不再弹滑窗。
   center 走 ddc(s)，inspector 走 detail(s)；两栏读同一份 shell 选择状态。 */
import * as React from "react";
import "../ds";
import "./cache";
import { deleteShare as deleteShareCmd, teardownShare, discoverProjects, createShare,
  generateDdcPak, startPsoCollection, verifyPakOutput, listPsoCacheFiles,
  distributeDdcPak, distributePsoCache,
  setMachineEnvVar, getMachineEnvVar, createLocalCache,
  prepareManagedShareClients, unprepareManagedShareClients,
  prepareOpenShareClients, unprepareOpenShareClients,
  setMachineBackendField, setProjectCacheBackend } from "../api/commands";

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect, useRef } = React;
  const h = React.createElement;
  const CX = window.VOLO_CX;
  const Selector = window.Selector;

  /* 选生成/校验/收集的源机：检查器无源机选择器（按设计自动选源）。优先工程 primary，但 primary
     可能离线 → 回退到该工程任一在线机；都不可用返回 null（调用方据此给可见反馈）。 */
  const pickSrc = (p) => {
    if (!p) return null;
    const prim = CX.node(p.primary);
    if (prim && prim.status !== 'offline') return prim;
    return RENDER_NODES.find((n) => (p.machines || []).includes(n.id) && n.status !== 'offline') || prim || null;
  };
  /* 无可用源机时，派一个立即失败的任务给可见反馈，而不是静默 return（按钮点了像没反应）。 */
  const noSrcFail = (s, domain, action, p) =>
    s.runCmd({ domain, action, target: p.name, chan: 'winrm', note: domain + ' ' + action + ' · ' + p.name },
      () => Promise.reject(new Error('该工程没有可用的在线源机器')), {}).catch(() => {});

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
     被吞（best-effort）；任务成败由 completed 的 exit_code 决定，用户可另点检查器「校验产物」。 */
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

  /* =================== 共享选项构造 =================== */
  const onlineNodes = () => RENDER_NODES.filter((n) => n.status !== 'offline');
  const scopeOpts = () => [{ id: 'all', label: '全部在线机' }]
    .concat(onlineNodes().map((n) => ({ id: n.id, label: n.host, sub: n.ip })));
  const backendOpts = [{ id: 'zen', label: 'ZenServer 后端' }, { id: 'legacy', label: '文件系统后端' }];
  const resOpts = [{ id: '1920×1080', label: '1920 × 1080' }, { id: '2560×1440', label: '2560 × 1440' }, { id: '3840×2160', label: '3840 × 2160' }];
  const maxOpts = [{ id: '10', label: '10 分钟' }, { id: '20', label: '20 分钟' }, { id: '30', label: '30 分钟' }];

  /* three-channel gate (色+图标+文字)：DDC 视图都建立在真实机器 id 上，后端读取路径
     未就绪时不渲染 mock 形状的 body（与 Overview gate 一致）。仅用于 master(center) 视图。 */
  function gate(s) {
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
    return null;
  }

  /* =================== 真实动作（模块级，接 s）=================== */
  /* discover_projects：远程扫各机 .uproject（只发现不写盘）。命令只收单台 machineId，
     scope='all' 时对全部在线机 fan-out（allSettled 容部分失败）；rootsStr 分号串 split；
     发现写库后 reloadCache 刷新 window.UE_PROJECTS。 */
  const runDiscover = (s, scope, rootsStr) => {
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

  /* generate_ddc_pak（流式）：源机取工程 primary（检查器无 src 选择器）；invoke 的
     BackendChoice='remote' 是执行位置；storageBackend（zen/legacy）写入 project_cache_backend
     供后端路由（zen → 跳过 PAK 生成）；ue_version null；ue-runner-progress 'completed' 即终止。 */
  const genPak = (s, p, storageBackend) => {
    const src = pickSrc(p);
    if (!src) { noSrcFail(s, 'ddc', 'generate', p); return; } /* 无可用在线源机：可见失败而非静默 */
    const cacheBackend = storageBackend === 'zen' ? 'zen' : 'legacy_pak';
    s.runStreamingCmd(
      { domain: 'ddc', action: 'generate', target: p.name, chan: 'winrm', note: '生成 DDC PAK · ' + p.name + '（' + (storageBackend === 'zen' ? 'ZenServer' : '文件系统') + ' · 长任务）· 源 ' + src.host },
      () => setProjectCacheBackend(Number(p.id), src.machineId, cacheBackend)
        .then(() => generateDdcPak('remote', Number(p.id), src.machineId, null, null, null, null)),
      { mode: 'event', events: ['ue-runner-progress', 'pak-verified'], jobIdOf: (r) => r.job_id, reduce: genReduce, timeoutMs: 45 * 60 * 1000 });
  };

  /* verify_pak_output：返回 PakOutput{path,size_bytes}，产物不存在=后端抛 OperationFailed
     → .then(ok, fail) 把成功/失败映射成 {found,...}。源机取工程 primary。 */
  const verifyPak = (s, p) => {
    const src = pickSrc(p);
    if (!src) return Promise.resolve({ found: false });
    return s.runCmd({ domain: 'ddc', action: 'verify', target: p.name, chan: 'ssh', note: '校验 DDC PAK 产物 · ' + p.name },
      () => verifyPakOutput(src.machineId, Number(p.id), null),
      { okMsg: (r) => '产物存在 · ' + r.path + ' · ' + humanBytes(r.size_bytes) })
      .then(
        (r) => ({ found: true, path: r.path, size: humanBytes(r.size_bytes), name: 'DDC_' + p.name, srcId: src.machineId }),
        () => ({ found: false }));
  };

  /* start_pso_collection（流式）：psoRes '1920×1080' 用 U+00D7 分隔需 split；max parseInt；
     windowed 固定 true；ue_version null；真终止是 pso-collect-finalized；完成后 onDone 重载列表。 */
  const collectPso = (s, p, srcId, resStr, maxStr, onDone) => {
    const chosen = CX.node(srcId);
    const src = (chosen && chosen.status !== 'offline') ? chosen : pickSrc(p); /* 不把收集派给离线机 */
    if (!src) { noSrcFail(s, 'pso', 'collect', p); return; }
    const parts = String(resStr).split('×');
    const rw = Number(parts[0]) || 1920, rh = Number(parts[1]) || 1080;
    const mm = parseInt(maxStr, 10) || 20;
    s.runStreamingCmd(
      { domain: 'pso', action: 'collect', target: p.name, chan: 'winrm', note: '收集 PSO 缓存 · ' + p.name + '（长任务 · NDJSON）' },
      () => startPsoCollection(src.machineId, Number(p.id), rw, rh, true, mm, null, null),
      { mode: 'event', events: ['ue-runner-progress', 'pso-collect-finalized'], jobIdOf: (r) => r.job_id, reduce: psoReduce,
        timeoutMs: (mm + 5) * 60 * 1000, onDone: () => { if (onDone) onDone(); } }) /* 真·完成才重载，不在 kickoff resolve 时重载空列表 */
      .catch(() => {}); /* kickoff 失败已在内部标失败，吞掉 rejection */
  };

  /* 真实分发（流式）：PAK 用 art.srcId(源机 machineId)+art.projId；PSO 用 art.id(file_id)。
     目标机来自确认门里编辑后的选择（排除源机、转 numeric machineId）。PSO 默认
     force_gpu_mismatch=false：目标 GPU 不匹配后端会同步拒绝 → 任务标失败并显示原因。 */
  const distribute = (s, art) => {
    const isPso = art.kind === 'PSO';
    const srcId = art.srcId;
    if (isPso && art.id == null) return; /* 没有 file_id 不能分发 PSO */
    if (!isPso && (srcId == null || art.projId == null)) return;
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
            : distributeDdcPak(srcId, Number(art.projId), targets, null, null, null),
          { mode: 'event', events: [evName], jobIdOf: (r) => r.job_id, total: (r) => (r.plan || []).length, reduce: batchReduce,
            timeoutMs: 30 * 60 * 1000 });  /* 空闲超时兜底：单台拷贝间隔超 30 分钟无任何 batch 事件才判超时 */
      },
    });
  };

  /* =================== 主视图共用工程行（master list）=================== */
  function projRow(p, selected, onClick) {
    return h('div', { key: p.id, className: 'proj-row' + (selected ? ' on' : ''), onClick: () => onClick(p) },
      h('span', { className: 'proj-mck' + (selected ? ' on' : '') }, selected ? h(Icon, { name: 'check', size: 12 }) : null),
      h('span', { className: 'proj-ico' }, h(Icon, { name: 'film', size: 17 })),
      h('div', { className: 'proj-main' },
        h('div', { className: 'proj-name' }, p.name),
        h('div', { className: 'proj-sub' }, p.root + '\\' + p.uproject)),
      h('div', { className: 'proj-tags' },
        h('span', { className: 'proj-tag ue' }, 'UE ' + p.ue),
        h('span', { className: 'proj-tag' }, p.size),
        h('span', { className: 'proj-tag' }, (p.machines || []).length + ' 台'),
        p.hasPak ? h('span', { className: 'proj-tag pak' }, h(Icon, { name: 'check', size: 10 }), '已有 PAK') : null,
        p.warn ? h('span', { className: 'proj-tag warn', title: p.warn }, h(Icon, { name: 'alert', size: 10 }), '版本不一致') : null));
  }

  /* =================== DDC PAK — master (center) =================== */
  function PakMaster({ s }) {
    const [scope, setScope] = useState('all');
    const [roots, setRoots] = useState('D:\\Projects;E:\\UEProjects');
    const g = gate(s); if (g) return g;
    /* 只算「仍存在于当前工程列表」的已选项：reloadCache 后被剔除的工程 id 不计入，与检查器(PakDetail
       同样 filter)计数一致；toggle 基于该剪枝后的数组写回 → 顺带把陈旧 id 清理掉。 */
    const sel = (s.pakSel || []).filter((id) => UE_PROJECTS.some((p) => p.id === id));
    const toggle = (p) => s.setPakSel(sel.includes(p.id) ? sel.filter((x) => x !== p.id) : sel.concat(p.id));

    return h('div', { className: 'res ddc' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, 'DDC · DDC PAK'),
        h('div', { className: 'right' },
          h('span', { className: 'toolchip' }, h(Icon, { name: 'film', size: 14 }), '已选 ' + sel.length + ' 个工程'))),
      h('div', { className: 'ddc-body' },
        h('div', { className: 'ddc-sec-h' }, h('span', null, '扫描 UE 工程'), h('span', { className: 'dim' }, 'discover_projects · 远程扫 .uproject，只发现不写盘')),
        h('div', { className: 'pak-scan' },
          h('div', { className: 'pak-scan-fields' },
            h('div', { className: 'dp-field' }, h('label', null, '扫描范围'),
              h(Selector, { kpre: '范围', value: scope, options: scopeOpts(), width: 178, onChange: setScope })),
            h('div', { className: 'dp-field grow' }, h('label', null, '搜索根目录'),
              h('input', { className: 'dp-input mono', value: roots, spellCheck: false, onChange: (e) => setRoots(e.target.value) })),
            h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'search', size: 14 }), onPress: () => runDiscover(s, scope, roots) }, '扫描')),
          h('div', { className: 'pak-scan-meta' }, h(Icon, { name: 'check', size: 12 }), '已发现 ' + UE_PROJECTS.length + ' 个工程位置 · 远程扫 .uproject 只发现不写盘')),

        h('div', { className: 'ddc-sec-h' }, h('span', null, '选择工程'),
          h('span', { className: 'dim' }, sel.length ? ('已选 ' + sel.length + ' 个 · 在右侧检查器生成 / 校验') : '勾选要处理的工程，操作在右侧检查器中进行')),
        h('div', { className: 'proj-list' }, UE_PROJECTS.map((p) => projRow(p, sel.includes(p.id), toggle))),
        UE_PROJECTS.length === 0 ? h('div', { className: 'gen-empty' }, h(Icon, { name: 'film', size: 22 }), h('span', null, '尚未发现工程，先在上方扫描 UE 工程')) : null));
  }

  /* =================== DDC PAK — detail (inspector) =================== */
  function PakDetail({ s }) {
    const [backend, setBackend] = useState('zen');
    const verify = s.pakVerify || {};   /* projId -> info（提到 shell：分发开 preview drawer 会卸载 PakDetail，本地态会丢）*/
    const sel = (s.pakSel || []).map((id) => UE_PROJECTS.find((p) => p.id === id)).filter(Boolean);
    const remove = (id) => s.setPakSel((s.pakSel || []).filter((x) => x !== id));
    const doVerify = (p) => verifyPak(s, p).then((info) => s.setPakVerify((m) => Object.assign({}, m, { [p.id]: info })));

    const projCard = (p) => {
      const v = verify[p.id];
      const src = pickSrc(p);
      return h('div', { key: p.id, className: 'id-proj' },
        h('div', { className: 'id-proj-top' },
          h('span', { className: 'id-proj-ico' }, h(Icon, { name: 'film', size: 16 })),
          h('div', { className: 'id-proj-meta' },
            h('div', { className: 'id-proj-name' }, p.name, h('span', { className: 'ue' }, 'UE ' + p.ue)),
            h('div', { className: 'id-proj-path' }, p.root + '\\' + p.uproject)),
          h('button', { className: 'id-proj-x', title: '从选择中移除', onClick: () => remove(p.id) }, h(Icon, { name: 'x', size: 14 }))),
        h('div', { className: 'id-proj-tags' },
          h('span', { className: 't' }, p.size),
          h('span', { className: 't' }, '源 · ' + ((src || {}).host || '—')),
          p.hasPak ? h('span', { className: 't pak' }, '已有 PAK') : null,
          p.warn ? h('span', { className: 't warn', title: p.warn }, '版本不一致') : null),
        v ? h('div', { className: 'id-verify' + (v.found ? ' ok' : ' miss') },
          h('div', { className: 'id-verify-h' },
            h('span', { className: 's-' + (v.found ? 'positive' : 'notice') }, h(Icon, { name: v.found ? 'check' : 'alert', size: 13 })),
            v.found ? '产物存在' : '未找到产物'),
          v.found ? h('div', { className: 'id-verify-kv' }, h('span', null, '路径'), h('span', { className: 'v' }, v.path)) : null,
          v.found ? h('div', { className: 'id-verify-kv' }, h('span', null, '大小'), h('span', { className: 'v' }, v.size)) : null,
          v.found
            ? h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'download', size: 13 }), onPress: () => distribute(s, { kind: 'DDC pak', name: v.name, srcId: v.srcId, projId: p.id }) }, '分发到渲染机')
            : h('div', { className: 'id-note' }, h(Icon, { name: 'eye', size: 12 }), '该工程在源机上尚无 PAK 产物，先在下方生成。')) : null,
        h('div', { className: 'id-proj-acts' },
          h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'search', size: 13 }), onPress: () => doVerify(p) }, v ? '重新校验产物' : '校验产物')));
    };

    const body = sel.length === 0
      ? h('div', { className: 'id-empty' }, h('div', { className: 'ph' }, h(Icon, { name: 'film', size: 24 })),
          h('div', null, '在主视图勾选一个或多个工程'), h('div', { style: { fontSize: 11 } }, '选中的工程会列在这里，可生成 / 校验其 DDC PAK 产物'))
      : h(React.Fragment, null,
          h('div', { className: 'id-sec-h' }, '已选工程', h('span', { className: 'ct' }, sel.length + ' 个')),
          sel.map(projCard),
          h('div', { className: 'id-note' }, h(Icon, { name: 'eye', size: 12 }),
            '校验 = verify_pak_output 检查该工程在源机上的 PAK 是否存在（路径 / 大小 / 是否存在），不列举全部产物。'));

    return h('div', { className: 'insp-detail' },
      h('div', { className: 'insp-head' },
        h('span', { className: 'ico' }, h(Icon, { name: 'cache', size: 15 })),
        h('div', { style: { minWidth: 0 } }, h('div', { className: 'tt' }, '检查器 · DDC PAK'),
          h('div', { className: 'sub' }, 'generate_ddc_pak / verify_pak_output'))),
      h('div', { className: 'id-body' }, body),
      sel.length ? h('div', { className: 'id-foot' },
        h('div', { className: 'id-field' }, h('label', null, '生成后端'),
          h(Selector, { kpre: '后端', value: backend, options: backendOpts, width: 200, onChange: setBackend })),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }),
          onPress: () => sel.forEach((p) => genPak(s, p, backend)) },
          '生成 DDC Pack（' + sel.length + '）')) : null);
  }

  /* =================== PSO 缓存 — master (center) =================== */
  function PsoMaster({ s }) {
    const g = gate(s); if (g) return g;
    const selId = s.psoSel;
    const selProj = UE_PROJECTS.find((p) => p.id === selId) || null; /* 选中工程被 reloadCache 剔除时回退「未选工程」，与检查器空态一致 */
    const pick = (p) => s.setPsoSel(selId === p.id ? null : p.id);
    return h('div', { className: 'res ddc' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, 'DDC · PSO 缓存'),
        h('div', { className: 'right' },
          h('span', { className: 'toolchip' }, h(Icon, { name: 'layers', size: 14 }), selProj ? ('已选 · ' + selProj.name) : '未选工程'))),
      h('div', { className: 'ddc-body' },
        h('div', { className: 'ddc-sec-h' }, h('span', null, '选择工程'),
          h('span', { className: 'dim' }, '选中一个工程，扫描 / 收集 / 现有产物都在右侧检查器中进行')),
        h('div', { className: 'pak-scan-meta', style: { margin: '0 0 12px' } }, h(Icon, { name: 'check', size: 12 }), '已发现 ' + UE_PROJECTS.length + ' 个工程位置'),
        h('div', { className: 'proj-list' }, UE_PROJECTS.map((p) => projRow(p, selId === p.id, pick))),
        UE_PROJECTS.length === 0 ? h('div', { className: 'gen-empty' }, h(Icon, { name: 'film', size: 22 }), h('span', null, '尚未发现工程，先在右侧检查器扫描')) : null));
  }

  /* =================== PSO 缓存 — detail (inspector) =================== */
  function PsoDetail({ s }) {
    const [scope, setScope] = useState('all');
    const [roots, setRoots] = useState('D:\\Projects;E:\\UEProjects');
    const [src, setSrc] = useState(null);
    const [res, setRes] = useState('1920×1080');
    const [max, setMax] = useState('20');
    const [psoFiles, setPsoFiles] = useState([]);
    const projId = s.psoSel;
    const projRef = useRef(projId); projRef.current = projId; /* 给 onDone 用：按最新选中工程判定，避免长任务回填覆盖已切走的列表 */
    /* 已收集的 PSO 缓存（list_pso_cache_files，随选中工程加载，收集完成后也重载）。 */
    const loadPsoFor = (pid) => {
      if (pid == null) { setPsoFiles([]); return; }
      listPsoCacheFiles(Number(pid), null, null).then(
        (fs) => setPsoFiles(Array.isArray(fs) ? fs : []),
        () => setPsoFiles([]));
    };
    /* 切工程：重置「收集源机器」选择（否则上个工程选的源机被带进新工程的收集请求）+ 重载产物列表。 */
    useEffect(() => { setSrc(null); loadPsoFor(projId); /* eslint-disable-line */ }, [projId]);

    const p = UE_PROJECTS.find((x) => x.id === projId) || null;
    /* 真实 PSO 缓存文件 → artRow 形状；PsoCacheFile 无 verified 字段，统一显示「已收集」。 */
    const psoArts = psoFiles.map((f) => ({ id: f.id, kind: 'PSO', name: f.file_name,
      size: humanBytes(f.size_bytes), built: f.collected_at || '—', verified: true, srcId: f.source_machine_id }));
    const machines = p ? RENDER_NODES.filter((n) => (p.machines || []).includes(n.id) && n.status !== 'offline') : [];
    const srcOpts = machines.map((n) => ({ id: n.id, label: n.host, sub: n.gpu }));
    /* 源机：用户选过且仍属当前工程在线机 → 用它；否则 primary（若在在线机列表里）；再否则首台在线机。
       这样 Selector 显示值 = 实际下发值，且不会把收集派给离线 primary 或别的工程的机器。 */
    const srcId = (src && srcOpts.some((o) => o.id === src)) ? src
      : (srcOpts.some((o) => o.id === (p && p.primary)) ? p.primary
      : (srcOpts[0] ? srcOpts[0].id : (p && p.primary) || null));
    const srcNode = p ? CX.node(srcId) : null;

    const artRow = (a) => h('div', { key: a.id, className: 'art-row' },
      h('span', { className: 'art-dot s-positive' }, h(Icon, { name: 'check', size: 12 })),
      h('div', { className: 'art-meta' }, h('div', { className: 'art-name mono' }, a.name), h('div', { className: 'art-sub' }, a.size + ' · ' + a.built + ' · 已收集')),
      h('button', { className: 'mini-btn', onClick: () => distribute(s, a) }, h(Icon, { name: 'download', size: 12 }), '分发'));

    return h('div', { className: 'insp-detail' },
      h('div', { className: 'insp-head' },
        h('span', { className: 'ico' }, h(Icon, { name: 'layers', size: 15 })),
        h('div', { style: { minWidth: 0 } }, h('div', { className: 'tt' }, '检查器 · PSO 缓存'),
          h('div', { className: 'sub' }, 'discover_projects / start_pso_collection'))),
      h('div', { className: 'id-body' },
        /* 扫描 */
        h('div', { className: 'id-scan' },
          h('div', { className: 'id-sec-h' }, '扫描 UE 工程'),
          h('div', { className: 'id-field' }, h('label', null, '扫描范围'),
            h(Selector, { kpre: '范围', value: scope, options: scopeOpts(), width: 200, onChange: setScope })),
          h('div', { className: 'id-field' }, h('label', null, '搜索根目录'),
            h('input', { className: 'dp-input mono', value: roots, spellCheck: false, onChange: (e) => setRoots(e.target.value) })),
          h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'search', size: 14 }), onPress: () => runDiscover(s, scope, roots) }, '扫描工程'),
          h('div', { className: 'id-scan-meta' }, h(Icon, { name: 'check', size: 12 }), '已发现 ' + UE_PROJECTS.length + ' 个工程')),

        /* 收集（需选工程）*/
        h('div', { className: 'id-sec-h', style: { marginTop: 4 } }, '收集 PSO 缓存',
          p ? h('span', { className: 'ct' }, p.name) : null),
        p ? h(React.Fragment, null,
          h('div', { className: 'id-proj' },
            h('div', { className: 'id-proj-top' },
              h('span', { className: 'id-proj-ico' }, h(Icon, { name: 'film', size: 16 })),
              h('div', { className: 'id-proj-meta' },
                h('div', { className: 'id-proj-name' }, p.name, h('span', { className: 'ue' }, 'UE ' + p.ue)),
                h('div', { className: 'id-proj-path' }, p.root + '\\' + p.uproject))),
            srcNode ? h('div', { className: 'id-gpu' }, h(Icon, { name: 'eye', size: 13 }),
              h('span', null, 'PSO 与 GPU 绑定，仅对相同 GPU 签名命中 · 当前源机 GPU ', h('b', null, srcNode.gpu + '（' + srcNode.vendor + '）'))) : null,
            h('div', { className: 'id-form' },
              h('div', { className: 'id-field' }, h('label', null, '收集源机器'),
                h(Selector, { kpre: '机器', value: srcId, options: srcOpts, width: 220, onChange: setSrc })),
              h('div', { className: 'id-field' }, h('label', null, '渲染分辨率'),
                h(Selector, { kpre: '分辨率', value: res, options: resOpts, width: 180, onChange: setRes })),
              h('div', { className: 'id-field' }, h('label', null, '最长时长'),
                h(Selector, { kpre: '时长', value: max, options: maxOpts, width: 150, onChange: setMax }))),
            h('div', { className: 'id-note' }, h(Icon, { name: 'terminal', size: 12 }),
              'UE -game 窗口化跑指定分辨率收集 PSO · 长任务，NDJSON 实时流进检查器。'),
            h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), onPress: () => collectPso(s, p, srcId, res, max, () => { if (projRef.current === p.id) loadPsoFor(p.id); }) }, '收集 PSO 缓存')))
          : h('div', { className: 'id-empty' }, h('div', { className: 'ph' }, h(Icon, { name: 'layers', size: 22 })),
              h('div', null, '在主视图选择一个工程'), h('div', { style: { fontSize: 11 } }, '选中后在这里配置并收集对应的 PSO 缓存')),

        /* 现有产物 */
        h('div', { className: 'id-sec-h', style: { marginTop: 4 } }, '已收集的 PSO 缓存', h('span', { className: 'ct' }, psoArts.length + ' 个')),
        psoArts.length
          ? h('div', { className: 'art-list' }, psoArts.map(artRow))
          : h('div', { className: 'id-note' }, h(Icon, { name: 'eye', size: 12 }), p ? '该工程尚无已收集的 PSO 缓存产物。' : '选中工程后这里会列出它的 PSO 缓存产物。')));
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

    /* resolve the chosen server to a real node — persisted `srv` may be a stale mock id
       now that machines come from the backend; fall back to the first non-shared node. */
    const sharedNode = CX.node(srv) || RENDER_NODES.find((n) => n.roleKey !== 'shared') || RENDER_NODES[0];
    const srvOpts = RENDER_NODES.map((n) => ({ id: n.id, label: n.host, sub: n.ip }));
    const onlineLocalTargets = RENDER_NODES.filter((n) => n.status !== 'offline');
    const badge = (cls, icon, txt) => h('span', { className: 'cli-badge ' + cls }, h(Icon, { name: icon, size: 11 }), txt);

    /* ===== ① 共享 DDC（SMB）服务器：创建 / 解除纳管 / 拆除部署（破坏性，走确认门）===== */
    /* 真实 create_share：host=sharedNode.machineId，mode 序列化 'open'|'managed'；
       operator_credential_alias 传 null（SSH key 鉴权）；Mode B 的 svc_username 留空 → 后端默认 'ddc-svc'。 */
    const deploySMB = () => CX.openPreview(s, {
      title: '创建共享 DDC（SMB）', icon: 'folder', cli: 'create_share', destructive: false, channel: 'ssh', confirmLabel: '创建共享',
      steps: ['在 ' + sharedNode.host + ' 上新建共享缓存文件夹 ' + shareLocal,
        '共享名 ' + shareName + (shareMode === 'managed' ? '（Mode B · 专用账号 ddc-svc）' : '（Mode A · 开放）'),
        '集群缓存指向该共享，其余机器再到「② 其他服务器加入共享 DDC」逐台加入'],
      simpleScope: [{ host: sharedNode.host, ip: sharedNode.ip, msg: shareLocal }],
      onConfirm: () => {
        if (!sharedNode || !shareName.trim() || !shareLocal.trim()) return;
        s.runCmd({ domain: 'share', action: 'create', target: sharedNode.host, chan: 'ssh', note: 'SMB 共享 DDC（' + shareMode + '）' },
          () => createShare(sharedNode.machineId, shareMode, shareName.trim(), shareLocal.trim(), null, null),
          { okMsg: (r) => '共享已创建 · ' + r.unc_path })
          .then(() => s.reloadCache(), () => {});
      },
    });
    /* 解除共享 DDC 纳管：仅从 Volo 解除纳管，不删远端共享文件夹（后端暂不支持 also_remove_remote）*/
    const deleteShare = (sh) => CX.openPreview(s, {
      title: '解除共享纳管 · ' + sh.path, icon: 'trash', cli: 'delete_share', destructive: true, channel: 'ssh', confirmLabel: '解除纳管',
      steps: ['从 Volo 解除对该共享的纳管（不再分发 / 不再注入客户端）', '不会删除远端共享文件夹本身（后端暂不支持远端删共享）'],
      simpleScope: [{ host: sh.path, ip: sh.clients + ' 客户端', msg: '仅解除纳管' }],
      onConfirm: () => {
        if (!sh.shareConfigId) return;
        s.runCmd({ domain: 'share', action: 'delete', target: sh.path, chan: 'ssh', note: '解除共享纳管（远端保留）' },
          () => deleteShareCmd(sh.shareConfigId, false), { okMsg: () => sh.path + ' 已解除纳管 · 远端文件夹保留' })
          .then(() => s.reloadCache(), () => {});
      },
    });
    /* 该服务器机器当前是否已部署共享（hostId = String(host_machine_id) 与 sharedNode.id 对齐）。 */
    const srvShare = (SHARES || []).find((x) => x.hostId === sharedNode.id);
    /* 取消该服务器部署（teardown_share）：停止 SMB 共享（Remove-SmbShare）+（Mode B）注销 ddc-svc，
       保留远端文件夹与缓存（keep_files=true）。删 SQLite 行后 reloadCache 把它从列表移除。
       区别于 deleteShare（仅解除纳管，不动远端共享服务）。 */
    const undeploySMB = (sh) => CX.openPreview(s, {
      title: '取消该服务器部署 · ' + (sh.host && sh.host !== '—' ? sh.host : sh.path), icon: 'trash', cli: 'teardown_share', destructive: true, channel: 'ssh', confirmLabel: '取消部署',
      steps: ['停止并移除该机上的 SMB 共享' + (/Mode B/.test(sh.mode || '') ? '（含注销专用账号 ddc-svc）' : '') + ' —— ' + sh.path,
        '从集群缓存图中摘除该上游，客户端回退到本地 / 其他上游',
        '保留远端共享文件夹与已有缓存文件，不做删除'],
      simpleScope: [{ host: sh.host && sh.host !== '—' ? sh.host : sh.path, ip: sh.clients + ' 客户端', msg: sh.path + ' · 保留文件夹' }],
      onConfirm: () => {
        if (!sh.shareConfigId) return;
        s.runCmd({ domain: 'share', action: 'teardown', target: sh.host && sh.host !== '—' ? sh.host : sh.path, chan: 'ssh', note: '取消共享 DDC 服务器部署（文件夹保留）' },
          () => teardownShare(sh.shareConfigId, true),
          { okMsg: (r) => (r.host || sh.path) + ' 共享 DDC 部署已取消 · 文件夹保留' })
          .then(() => s.reloadCache(), () => {});
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
            h('input', { className: 'dp-input mono', value: shareLocal, spellCheck: false, onChange: (e) => setShareLocal(e.target.value) })),
          h('div', { className: 'dp-field' }, h('label', null, '模式'),
            h(Selector, { kpre: '模式', value: shareMode, width: 200, onChange: setShareMode,
              options: [{ id: 'open', label: 'Mode A · 开放' }, { id: 'managed', label: 'Mode B · 专用账号' }] })),
          h('div', { className: 'dp-go' },
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
          // #region agent log
          fetch('http://127.0.0.1:7278/ingest/ba6b3c44-cc27-40da-8bf6-deca990c38bf',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'9b0675'},body:JSON.stringify({sessionId:'9b0675',hypothesisId:'H5',location:'cacheDdc.tsx:joinShareToMachines',message:'managed_prep_start',data:{shareConfigId:sh.shareConfigId,okMachineIds,unc},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
          return prepareManagedShareClients(sh.shareConfigId, okMachineIds).then((prep) => {
            const prepFail = (prep || []).filter((r) => !r.ok);
            // #region agent log
            fetch('http://127.0.0.1:7278/ingest/ba6b3c44-cc27-40da-8bf6-deca990c38bf',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'9b0675'},body:JSON.stringify({sessionId:'9b0675',hypothesisId:'H5',location:'cacheDdc.tsx:joinShareToMachines',message:'managed_prep_done',data:{failCount:prepFail.length,results:prep},timestamp:Date.now()})}).catch(()=>{});
            // #endregion
            if (prepFail.length) {
              prepFail.forEach((r) => errs.push('机器 ' + r.client_machine_id + ' Mode B 预连接：' + (r.message || '失败')));
              throw new Error('Mode B 共享预连接失败 · ' + prepFail.length + ' 台' + (errs.length ? ' · ' + errs.join('；') : ''));
            }
            const managedWarn = prep.some((r) => r.message && r.message.indexOf('deferred') >= 0)
              ? '交互用户预连接将在下次登录时由计划任务重试'
              : null;
            return { envOk, iniProjOk, fail, okMachineIds, managed, managedWarn };
          }, (e) => {
            // #region agent log
            fetch('http://127.0.0.1:7278/ingest/ba6b3c44-cc27-40da-8bf6-deca990c38bf',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'9b0675'},body:JSON.stringify({sessionId:'9b0675',hypothesisId:'H5',location:'cacheDdc.tsx:joinShareToMachines',message:'managed_prep_error',data:{error:e&&e.message?e.message:String(e)},timestamp:Date.now()})}).catch(()=>{});
            // #endregion
            throw e;
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
    const joinShareOne = (n, sh) => {
      if (!sh || joinPending[n.id]) return;
      setJP(n.id, 'join');
      s.runCmd({ domain: 'share', action: 'join', target: n.host, chan: 'ssh', note: '加入共享 DDC · ' + sh.path },
        () => joinShareToMachines([n.machineId], sh.path, sh),
        { okMsg: (r) => n.host + ' 已加入 · 设系统环境变量' + (r.managed ? '，已预连接 Mode B 共享（交互用户+SYSTEM）' + (r.managedWarn ? '（' + r.managedWarn + '）' : '') : (r.guestPrep ? '，已预连接 Guest 共享（免凭据框）' : (r.guestWarn ? '，但 ' + r.guestWarn : ''))) })
        .then(() => { setShareJoined((m) => Object.assign({}, m, { [n.id]: sh.path })); clrJP(n.id); }, () => clrJP(n.id));
    };
    const leaveShareOne = (n) => {
      if (joinPending[n.id]) return;
      setJP(n.id, 'leave');
      const joinedPath = shareJoined[n.id];
      const sh = (SHARES || []).find((x) => x.path === joinedPath) || null;
      const isOpen = !!(sh && sh.shareMode === 'open' && sh.shareConfigId);
      const isManaged = !!(sh && sh.shareMode === 'managed' && sh.shareConfigId);
      s.runCmd({ domain: 'share', action: 'leave', target: n.host, chan: 'ssh', note: '退出共享 DDC' },
        () => setMachineEnvVar(n.machineId, ENV_KEY, '').then(() =>
          isOpen ? unprepareOpenShareClients(sh.shareConfigId, [n.machineId]).then(() => {}, () => {}) :
          isManaged ? unprepareManagedShareClients(sh.shareConfigId, [n.machineId]).then(() => {}, () => {}) :
          undefined),
        { okMsg: () => n.host + ' 已退出 · 清空环境变量' + (isOpen ? '，已移除 Guest 自动重连' : (isManaged ? '，已移除 Mode B 自动重连' : '')) })
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
      const cur = shareJoined[n.id];
      const onThis = joinTargetShare && cur === joinTargetShare.path;
      return h('div', { key: n.id, className: 'cli-row join' + (onThis ? ' on' : '') },
        CX.dot(NODE_STATUS[n.status].visual),
        h('div', { className: 'cli-meta' },
          h('div', { className: 'cli-host mono' }, n.host),
          h('div', { className: 'cli-sub' }, n.ip + ' · ' + n.role)),
        h('div', { className: 'cli-envvar mono' },
          h('span', { className: 'ev-k' }, ENV_KEY),
          h('span', { className: 'ev-eq' }, '='),
          h('span', { className: 'ev-v' + (cur ? '' : ' none') }, cur || (statusLoading ? '读取中…' : '未设置'))),
        h('div', { className: 'local-act' },
          pend === 'join' ? badge('pend', 'sync', '加入中…')
            : pend === 'leave' ? badge('pend', 'sync', '退出中…')
            : onThis ? badge('ok', 'check', '已加入')
            : cur ? badge('alt', 'link', '加入其他')
            : statusLoading ? badge('none', 'sync', '读取中…')
            : badge('none', 'minus', '未加入'),
          pend ? h('button', { className: 'mini-btn', disabled: true }, h(Icon, { name: 'sync', size: 12 }), '执行中')
            : onThis ? h('button', { className: 'mini-btn danger', onClick: () => leaveShareOne(n) }, h(Icon, { name: 'x', size: 12 }), '退出')
            : h('button', { className: 'mini-btn', onClick: () => joinShareOne(n, joinTargetShare) }, h(Icon, { name: 'link', size: 12 }), '加入')));
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
    /* 统一路径一键：把全部在线机的本地路径设成 commonLocalDir，再批量部署。 */
    const applyCommonLocal = () => {
      const path = commonLocalDir.trim();
      const todo = onlineLocalTargets.filter((n) => !localPending[n.id]);
      if (!path || !todo.length) return;
      const ids = todo.map((n) => n.id);
      setLocalDirs((m) => { const x = Object.assign({}, m); ids.forEach((id) => { x[id] = path; }); return x; });
      markLP(ids, 'deploy');
      s.runCmd({ domain: 'local-cache', action: 'create', target: todo.length + ' 台', chan: 'ssh', note: '统一本地 DDC 路径并部署（' + todo.length + ' 台）· ' + path },
        () => Promise.allSettled(todo.map((n) => deployLocalExec(n.machineId, path))).then((rs) => { const ok = rs.filter((r) => r.status === 'fulfilled').length; if (!ok) throw new Error('全部目标部署失败'); return { ok, fail: rs.length - ok }; }),
        { okMsg: (r) => r.ok + ' 台已统一部署 · ' + path + (r.fail ? ('，' + r.fail + ' 台失败') : '') })
        .then(() => { setLocalDeployed((d) => Array.from(new Set(d.concat(ids)))); clrLP(ids); setSelLocal([]); }, () => clrLP(ids));
    };
    const onlineIds = onlineLocalTargets.map((n) => n.id);
    const allSel = onlineIds.length > 0 && onlineIds.every((id) => selLocal.includes(id));
    const someSel = selLocal.length > 0;
    const toggleLocalSel = (id) => setSelLocal((sl) => sl.includes(id) ? sl.filter((x) => x !== id) : sl.concat(id));
    const toggleAllLocal = () => setSelLocal(allSel ? [] : onlineIds.slice());
    const selNodes = onlineLocalTargets.filter((n) => selLocal.includes(n.id));
    const selDeployedNodes = selNodes.filter((n) => localDeployed.includes(n.id));
    const selUndeployedNodes = selNodes.filter((n) => !localDeployed.includes(n.id));

    const localRow = (n) => {
      const dep = localDeployed.includes(n.id);
      const off = n.status === 'offline';
      const isSel = selLocal.includes(n.id);
      const pend = localPending[n.id];
      return h('div', { key: n.id, className: 'cli-row local' + (off ? ' off' : '') + (isSel ? ' sel' : (dep ? ' on' : '')) },
        off ? h('span', { className: 'lcheck dis' }, h('span', { className: 'proj-mck dis' }))
          : h('button', { className: 'lcheck', title: isSel ? '取消选择' : '选择', onClick: () => toggleLocalSel(n.id) },
              h('span', { className: 'proj-mck' + (isSel ? ' on' : '') }, isSel ? h(Icon, { name: 'check', size: 12 }) : null)),
        CX.dot(NODE_STATUS[n.status].visual),
        h('div', { className: 'cli-meta' },
          h('div', { className: 'cli-host mono' }, n.host),
          h('div', { className: 'cli-sub' }, n.ip + ' · ' + n.role)),
        h('input', { className: 'cli-pathin mono', value: localDirOf(n), disabled: off,
          spellCheck: false, onChange: (e) => setLocalDir(n.id, e.target.value) }),
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
              : h('button', { className: 'mini-btn', onClick: () => deployLocalOne(n) }, h(Icon, { name: 'bolt', size: 12 }), '部署')));
    };

    return h('div', { className: 'res ddc' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, 'DDC · 文件系统 DDC'),
        h('div', { className: 'right' },
          h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'sync', size: 14 }), isDisabled: statusLoading, onPress: readStatus }, statusLoading ? '读取中…' : '刷新状态'))),
      h('div', { className: 'ddc-body' },
        h('div', { className: 'zen-2col' },
          /* 左列：① 共享 DDC 服务器部署 + 已纳管共享 + ② 其他服务器加入 */
          h('div', { className: 'zen-col' },
            h('div', { className: 'ddc-sec-h' }, h('span', null, '① 共享 DDC（SMB）'), h('span', { className: 'dim' }, '先立一台机器为共享 DDC 服务器 · 创建网络共享映射路径，其余机器再加入')),
            smbPanel,
            SHARES.length ? h(React.Fragment, null,
              h('div', { className: 'ddc-sec-h' }, h('span', null, '已纳管的共享服务器'), h('span', { className: 'dim' }, SHARES.length + ' 台 · 每台共享 DDC 服务器都可单独取消 · 取消不删除远端文件夹')),
              h('div', { className: 'art-list' }, SHARES.map(shareRow))) : null,
            SHARES.length ? h(React.Fragment, null,
              h('div', { className: 'ddc-sec-h' },
                h('span', null, '② 其他服务器加入共享 DDC'),
                h('span', { className: 'dim' }, joinCandidates.filter((n) => joinTargetShare && shareJoined[n.id] === joinTargetShare.path).length + ' / ' + joinCandidates.length + ' 已加入 · 写环境变量 ' + ENV_KEY + ' 指向共享路径')),
              h('div', { className: 'cli-panel' },
                h('div', { className: 'cli-top' },
                  h('div', { className: 'cli-server-chip' },
                    h('span', { className: 'csc-ico' }, h(Icon, { name: 'folder', size: 15 })),
                    h('div', { style: { minWidth: 0 } },
                      h('div', { className: 'csc-t' }, '加入目标 · ' + (joinTargetShare ? joinTargetShare.host : '—')),
                      h('div', { className: 'csc-s mono' }, joinTargetShare ? joinTargetShare.path : '—'))),
                  SHARES.length > 1 ? h('div', { className: 'dp-field' }, h('label', null, '共享服务器'),
                    h(Selector, { kpre: '共享', value: joinTargetShare ? joinTargetShare.id : null, options: shareSelOpts, width: 240, onChange: setJoinTarget })) : null,
                  h('div', { className: 'cli-go' },
                    h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'link', size: 14 }), isDisabled: unjoinedCandidates.length === 0, onPress: joinShareAll },
                      '全部加入（' + unjoinedCandidates.length + '）'))),
                h('div', { className: 'cli-note' }, h(Icon, { name: 'shield', size: 13 }),
                  '加入 = 在该机设机器级系统环境变量 ' + ENV_KEY + ' 指向共享路径；Mode A 会预存 Guest 空密码会话（cmdkey + net use，资源管理器直接输入 UNC 不再弹框）；Mode B 会为计算机名与 IP 注入 ddc-svc 凭据；运行中的 UE 需重启生效。退出仅清除变量（不撤销已预连接会话）。'),
                h('div', { className: 'cli-list' }, joinCandidates.map(joinRow)))) : null),
          /* 右列：③ 本地 DDC */
          h('div', { className: 'zen-col' },
            h('div', { className: 'ddc-sec-h' },
              h('span', null, '③ 本地 DDC'),
              h('span', { className: 'dim' }, localDeployed.length + ' / ' + RENDER_NODES.length + ' 已部署 · 可逐台设置，或用上方统一路径一键应用到全部')),
            h('div', { className: 'cli-panel' },
              h('div', { className: 'cli-top' },
                h('div', { className: 'local-hint' }, h(Icon, { name: 'server', size: 15 }), '逐台本地缓存回退层 · 命中链路兜底'),
                h('div', { className: 'cli-unify' },
                  h('label', null, '统一路径'),
                  h('input', { className: 'dp-input mono', value: commonLocalDir, spellCheck: false, onChange: (e) => setCommonLocalDir(e.target.value), style: { width: 188 } }),
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
              h('div', { className: 'cli-list' }, RENDER_NODES.map(localRow)))))));
  }

  /* =================== center router =================== */
  function ddc(s) {
    const view = /^ddc_/.test(s.cacheNav) ? s.cacheNav : 'ddc_zen';
    if (view === 'ddc_zen') return window.VOLO_CACHE_ZEN.view(s);
    if (view === 'ddc_legacy') return h(LegacyView, { s });
    if (view === 'ddc_pak') return h(PakMaster, { s });
    return h(PsoMaster, { s });
  }

  /* =================== inspector router (right column) =================== */
  function detail(s) {
    if (s.cacheNav === 'ddc_pak') return h(PakDetail, { s });
    if (s.cacheNav === 'ddc_pso') return h(PsoDetail, { s });
    return null;
  }

  window.VOLO_CACHE_DDC = { ddc, detail };
})();

export {};
