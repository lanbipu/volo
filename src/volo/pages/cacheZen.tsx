// @ts-nocheck
/* Volo — Cache · DDC · ZenServer 子页（重做版，接真实后端）.
   1:1 port of the Claude Design handoff `src/cache_zen.jsx`, with the simulated
   deploy chain / client-pointing replaced by real invoke() calls.

   ① 架设 / 管理一台 Zen 共享缓存服务器：
      - 顶部状态卡读真实状态（zen_list_endpoints + zen_status + zen_cache_stats）；
      - 部署 = 7 步真实远程链路，逐步执行、三态、某步失败可单独重试，endpoint_id 从
        zen_register 串到后续步骤；detect 失败给「刷新这台机器」(refresh_machine) 后自动重试；
      - 已部署可启停 / 卸载 / 探活（停止 / 卸载是破坏性 → preview → 二次确认）。
   ② 让客户端机器用上这台缓存：多选客户端 → 逐台 set_ini_key 写 [StorageServers] Shared
      指向此服务器 → 逐机成败、可重试。
   远程操作走 SSH key（cred = {} 全 None），不逐操作选凭据；真实回读来自 zen_probe。 */
import * as React from "react";
import "../ds";
import "./cache";
import {
  zenRegister, zenDetectBinary, zenApplyConfig, zenUrlaclAdd, zenServiceInstall,
  zenServiceStart, zenServiceStop, zenServiceUninstall, zenUnregister, zenProbe,
  zenStatus, zenListEndpoints, zenCacheStats, setIniKey, refreshMachine,
} from "../api/commands";

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useRef, useEffect } = React;
  const h = React.createElement;
  const CX = window.VOLO_CX;
  const Selector = window.Selector;

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
  const log = (s, lv, msg) => s.pushLog({ lv, cat: 'zen', ch: 'ssh', task: null, msg });

  /* 部署链路 7 步（cli 为后端真实命令；desc 由当前表单值动态生成）*/
  const DEPLOY_STEPS = [
    { id: 'register', label: '登记服务器',          cli: 'zen_register',
      desc: (f, host) => `${f.protocol}://${host}:${f.port} · role shared_upstream · data-dir ${f.dataDir}` },
    { id: 'detect',   label: '前置检查 · 定位 Zen 程序', cli: 'zen_detect_binary', gate: true,
      desc: (f, host) => `在 ${host} 上查找 ZenServer.exe（找不到需先刷新这台机器）` },
    { id: 'config',   label: '下发配置文件到服务器',   cli: 'zen_apply_config',
      desc: (f) => `写入 ${f.configPath}（zen.lua），落地后回读 SHA256 校验` },
    { id: 'urlacl',   label: '开放网络访问权限',       cli: 'zen_urlacl_add',
      desc: (f) => `netsh http add urlacl url=${f.protocol}://+:${f.port}/ · 账号 ${f.acct}` },
    { id: 'service',  label: '安装为 Windows 服务',     cli: 'zen_service_install',
      desc: (f) => `sc create ZenServer · 启动 auto · 服务账号 ${f.acct}` },
    { id: 'start',    label: '启动服务',               cli: 'zen_service_start',
      desc: () => `sc start ZenServer` },
    { id: 'probe',    label: '探活确认',               cli: 'zen_probe',
      desc: (f, host) => `GET ${f.protocol}://${host}:${f.port}/health → 期望 HTTP 200，读取版本号` },
  ];
  const STEP_IDS = DEPLOY_STEPS.map((x) => x.id);

  const SVC_STATE = {
    running:     { vis: 'positive', icon: 'check', label: '运行中' },
    stopped:     { vis: 'notice',   icon: 'pause', label: '已停止' },
    unreachable: { vis: 'negative', icon: 'alert', label: '不可达' },
    unknown:     { vis: 'neutral',  icon: 'minus', label: '状态未知' },  /* reachable=null：探活尚未跑过 */
  };
  const RUN_STATE = {
    idle:    { vis: 'neutral',     icon: null,   label: '待执行' },
    running: { vis: 'informative', icon: 'sync', label: '进行中' },
    ok:      { vis: 'positive',    icon: 'check', label: '成功' },
    fail:    { vis: 'negative',    icon: 'alert', label: '失败' },
  };

  /* 三通道徽标：颜色 + 图标 + 文字 */
  function ZBadge({ vis, icon, label, soft }) {
    return h('span', { className: 'zbadge zb-' + vis + (soft ? ' soft' : '') },
      icon ? h(Icon, { name: icon, size: 12 }) : h('span', { className: 'zb-dash' }, '—'), label);
  }

  function ZenServer({ s }) {
    /* —— 服务器表单状态 —— */
    const firstServer = () => { const ns = window.RENDER_NODES || []; return (ns.find((n) => n.roleKey !== 'shared') || ns[0] || {}).id || null; };
    const [srvId, setSrvId] = useState(firstServer);
    const [port, setPort] = useState('1337');
    const [protocol, setProtocol] = useState('http');
    const [dataDir, setDataDir] = useState('D:\\ZenData');
    const [configPath, setConfigPath] = useState('D:\\ZenData\\config\\zen.lua');
    const [httpType, setHttpType] = useState('httpsys');   /* asio | httpsys（后端合法值）*/
    const [acctKind, setAcctKind] = useState('local');     /* local | domain */
    const [domUser, setDomUser] = useState('VOLO\\zen-svc');
    const [domPass, setDomPass] = useState('');
    const [advOpen, setAdvOpen] = useState(false);

    /* —— 真实状态（zen_list_endpoints + zen_status + zen_cache_stats）—— */
    const [status, setStatus] = useState(null);   /* {endpointId,machineId,host,ip,port,scheme,version,dataDir,svc,records} | null */
    const [statusLoading, setStatusLoading] = useState(true);
    const loadStatus = () => {
      setStatusLoading(true);
      Promise.allSettled([zenListEndpoints(null), zenStatus(null)]).then(([epR, stR]) => {
        const eps = epR.status === 'fulfilled' && Array.isArray(epR.value) ? epR.value : [];
        const rows = stR.status === 'fulfilled' && Array.isArray(stR.value) ? stR.value : [];
        const ep = eps.find((e) => e.role === 'shared_upstream') || eps[0] || null;
        if (!ep) { setStatus(null); setStatusLoading(false); return; }
        const row = rows.find((r) => r.endpoint_id === ep.id) || null;
        /* reachable 三态：true→运行中 / false→不可达 / null（从未探活）→状态未知（不冒充已停止）*/
        const svc = row ? (row.reachable === true ? 'running' : row.reachable === false ? 'unreachable' : 'unknown') : 'unknown';
        setStatus({
          endpointId: ep.id, machineId: ep.machine_id,
          host: row ? row.hostname : '', ip: row ? row.ip : '',
          port: ep.declared_port, scheme: ep.scheme, dataDir: ep.data_dir,
          version: row && row.build_version ? row.build_version : '—', svc, providers: null,
        });
        setStatusLoading(false);
        zenCacheStats(ep.id, null).then((cs) => {
          const sample = cs && Array.isArray(cs.samples) && cs.samples[0] ? cs.samples[0] : null;
          const provs = sample && Array.isArray(sample.providers) ? sample.providers : null;
          setStatus((s2) => (s2 ? Object.assign({}, s2, { providers: provs }) : s2));
        }, () => {});
      });
    };
    useEffect(() => { loadStatus(); }, []);

    /* —— 部署执行状态 —— */
    const epRef = useRef(null);                  /* zen_register 返回的 endpoint_id，串到后续步骤 */
    const [started, setStarted] = useState(false);
    const [run, setRun] = useState({});           /* stepId -> { st, err } */
    const [deploying, setDeploying] = useState(false);
    /* pointed/sel/res 必须在任何条件 return 之前声明（Rules of Hooks）。否则首屏 RENDER_NODES 还空、
       走下面 if(!srvNode) 早返回时这 3 个 hook 不执行；机器异步到达后 re-render 又执行，hook 数变化会让
       React 抛「Rendered more hooks than during the previous render」并卸载整棵树（纯黑屏）。 */
    const [pointed, setPointed] = useState(() => new Set());  /* 本地跟踪「已成功指向」的机器（后端无逐机查询）*/
    const [sel, setSel] = useState([]);
    const [res, setRes] = useState({});   /* clientId -> { st, msg } */

    const deployed = !!status;
    /* 仅当服务真正 running 才允许把客户端指向它——指向一台已停止/不可达/状态未知的服务器
       会让客户端缓存上游失效。stopped/unreachable/unknown 都不放行。 */
    const canPoint = deployed && status.svc === 'running';
    const RN = window.RENDER_NODES || [];
    const srvNode = CX.node(srvId) || RN.find((n) => n.roleKey !== 'shared') || RN[0];

    if (!srvNode) {
      return h('div', { className: 'res ddc' }, h('div', { className: 'ddc-body' },
        h('div', { className: 'gen-empty' }, h(Icon, { name: 'node', size: 22 }),
          h('span', null, '集群里还没有机器 — 先在「集群总览」扫描添加机器，再部署 Zen 服务器'))));
    }

    const acct = acctKind === 'local' ? 'NT SERVICE\\ZenServer（本地服务账号）' : (domUser.trim() || '（未填写域账号）');
    const principal = acctKind === 'domain' ? (domUser.trim() || 'NT AUTHORITY\\LocalService') : 'NT AUTHORITY\\LocalService';
    const formObj = { port, protocol, dataDir, configPath, acct };
    const srvOpts = RN.map((n) => ({ id: n.id, label: n.host, sub: n.ip }));
    const httpOpts = [{ id: 'httpsys', label: 'http.sys（默认）' }, { id: 'asio', label: 'asio' }];
    const cred = {}; /* SSH key — ZenCredentialInput 全 None */

    const setStep = (id, st, err) => setRun((r) => Object.assign({}, r, { [id]: { st, err: err || null } }));

    /* 单步真实执行：成功 resolve，失败 throw（message 即步骤错误）*/
    const runStep = async (id) => {
      const mid = srvNode.machineId;
      const svcUser = acctKind === 'domain' ? (domUser.trim() || null) : null;
      const svcPass = acctKind === 'domain' ? (domPass || null) : null;
      if (id === 'register') {
        const o = await zenRegister({ machine_id: mid, declared_port: Number(port) || 1337, scheme: protocol,
          role: 'shared_upstream', data_dir: dataDir, httpserverclass: httpType, lifecycle: 'installed_service' });
        epRef.current = o && o.endpoint_id != null ? o.endpoint_id : epRef.current;
        if (epRef.current == null) throw new Error('登记未返回 endpoint_id');
        return;
      }
      if (id === 'detect') {
        const r = await zenDetectBinary(mid, null);
        const res0 = r && Array.isArray(r.results) ? r.results[0] : null;
        const ok = r && (r.ok > 0 || (res0 && res0.ok));
        if (!ok) throw new Error(((res0 && res0.error_message) || '未找到 ZenServer.exe') + ' — 这台机器上没有检出 Zen 程序。先刷新这台机器，确认它已安装 Zen，再重试这一步。');
        return;
      }
      if (epRef.current == null) throw new Error('缺少 endpoint — 先成功完成「登记服务器」这一步');
      if (id === 'config')  { await zenApplyConfig(epRef.current, configPath, true, false, cred); return; }
      if (id === 'urlacl')  { await zenUrlaclAdd(epRef.current, principal, true, false, cred); return; }
      if (id === 'service') { await zenServiceInstall(epRef.current, true, false, cred, svcUser, svcPass); return; }
      if (id === 'start')   { await zenServiceStart(epRef.current, cred); return; }
      if (id === 'probe') {
        const r = await zenProbe(mid, null, null);
        const rec = r && Array.isArray(r.probes) ? r.probes[0] : null;
        if (rec && rec.reachable === false) throw new Error((rec.error_message) || '探活失败 · 服务未响应 /health');
        return;
      }
    };

    /* runner：从 startIdx 起逐步真实执行；遇 fail 停下，留给「重试这一步」 */
    const runFrom = async (startIdx) => {
      setStarted(true); setDeploying(true);
      setRun((r) => { const n = Object.assign({}, r); for (let k = startIdx; k < STEP_IDS.length; k++) n[STEP_IDS[k]] = { st: 'idle' }; return n; });
      for (let i = startIdx; i < STEP_IDS.length; i++) {
        const def = DEPLOY_STEPS[i];
        setStep(def.id, 'running');
        try {
          /* eslint-disable-next-line no-await-in-loop */
          await runStep(def.id);
          setStep(def.id, 'ok');
          log(s, 'ok', `<b>${def.cli}</b> · ${esc(srvNode.host)} → 成功`);
        } catch (e) {
          const em = e && e.message ? e.message : String(e);
          setStep(def.id, 'fail', em);
          log(s, 'err', `<b>${def.cli}</b> · ${esc(srvNode.host)} 失败 · ${esc(em)}`);
          setDeploying(false);
          return;
        }
      }
      setDeploying(false);
      log(s, 'ok', `<b>zen probe</b> · ${esc(srvNode.host)} → 上线`);
      loadStatus();
    };

    /* 刷新这台机器（detect 失败时）→ 刷新后自动从 detect 重试 */
    const doRefresh = () => {
      s.runCmd({ domain: 'machine', action: 'refresh', target: srvNode.host, chan: 'winrm', note: '重探 UE / GPU / Zen 程序' },
        () => refreshMachine(srvNode.machineId).then((r) => { if (r && r.error) throw new Error(r.error); return r; }),
        { okMsg: () => srvNode.host + ' 已刷新 · 重试前置检查' })
        .then(() => runFrom(STEP_IDS.indexOf('detect')), () => {});
    };

    const pickServer = (id) => { setSrvId(id); setStarted(false); setRun({}); setDeploying(false); epRef.current = null; };

    /* 预览部署计划（展示解析后的 7 步）→ 确认 → 跑 runner（DeployPlan 是通用 DDC 部署、
       不适配 zen 链路，故不调 deploy_ddc_plan_preview；预览即解析后的步骤清单）*/
    const previewDeploy = () => CX.openPreview(s, {
      title: (deployed ? '重新部署' : '部署') + ' Zen 缓存服务器', icon: 'cube',
      cli: 'zen_register → … → zen_probe', destructive: false, channel: 'ssh', confirmLabel: deployed ? '重新部署' : '开始部署',
      steps: DEPLOY_STEPS.map((st) => st.label + '（' + st.cli + '）'),
      simpleScope: [{ host: srvNode.host, ip: srvNode.ip, msg: protocol + '://…:' + port + ' · ' + dataDir }],
      onConfirm: () => { epRef.current = null; runFrom(0); },
    });

    /* —— 管理动作（已部署）—— */
    const probeServer = () => {
      if (!status) return;
      s.runCmd({ domain: 'zen', action: 'probe', target: status.host || ('endpoint ' + status.endpointId), chan: 'ssh', note: '探活 · zen_probe' },
        () => zenProbe(status.machineId, null, null).then((r) => { const rec = r && r.probes && r.probes[0]; if (rec && rec.reachable === false) throw new Error(rec.error_message || '不可达'); return r; }),
        { okMsg: (r) => { const rec = r && r.probes && r.probes[0]; return 'HTTP 200 · 版本 ' + ((rec && rec.build_version) || '—'); } })
        .then(() => loadStatus(), () => loadStatus());
    };
    const startServer = () => {
      if (!status) return;
      s.runCmd({ domain: 'zen', action: 'start', target: status.host, chan: 'ssh', note: 'zen_service_start' },
        () => zenServiceStart(status.endpointId, cred), { okMsg: () => status.host + ' 服务已启动' })
        .then(() => loadStatus(), () => {});
    };
    const stopServer = () => status && CX.openPreview(s, {
      title: '停止 ZenServer 服务', icon: 'pause', cli: 'zen_service_stop', destructive: true, channel: 'ssh', confirmLabel: '停止服务',
      steps: ['停止 ' + status.host + ' 上的 ZenServer 服务', '停止后所有客户端将无法命中此共享缓存，回退到各自本地缓存'],
      simpleScope: [{ host: status.host, ip: status.ip, msg: 'sc stop ZenServer' }],
      onConfirm: () => s.runCmd({ domain: 'zen', action: 'stop', target: status.host, chan: 'ssh', note: '停止服务' },
        () => zenServiceStop(status.endpointId, true, false, cred), { okMsg: () => status.host + ' 服务已停止' })
        .then(() => loadStatus(), () => {}),
    });
    const uninstallServer = () => status && CX.openPreview(s, {
      title: '卸载 ZenServer', icon: 'trash', cli: 'zen_service_uninstall + zen_unregister', destructive: true, channel: 'ssh', confirmLabel: '卸载服务器',
      steps: ['停止并卸载 ' + status.host + ' 上的 Windows 服务 ZenServer', '从 Volo 注销该 endpoint（不删除 data-dir 数据目录）', '客户端的指向配置需在下方②另行撤除'],
      simpleScope: [{ host: status.host, ip: status.ip, msg: 'uninstall + unregister' }],
      onConfirm: () => s.runCmd({ domain: 'zen', action: 'uninstall', target: status.host, chan: 'ssh', note: '卸载并注销' },
        () => zenServiceUninstall(status.endpointId, true, false, cred).then(() => zenUnregister(status.endpointId, true, false)),
        { okMsg: () => status.host + ' 已卸载 · data-dir 保留' })
        .then(() => { setStarted(false); setRun({}); epRef.current = null; loadStatus(); }, () => {}),
    });

    /* ============ ② 客户端：把选中机器指向此缓存服务器 ============ */
    /* 同时排除「表单选中的服务器机器」和「已部署 endpoint 的实际机器」——两者可能不同台
       （部署后切了表单 srvId 也不能把真正的服务器自己当客户端指向自己）。 */
    const clients = RN.filter((n) => n.id !== srvNode.id && !(status && n.machineId === status.machineId));
    const pointedCount = clients.filter((n) => pointed.has(n.id)).length;

    const toggleSel = (n) => { if (n.status === 'offline') return; setSel((v) => v.includes(n.id) ? v.filter((x) => x !== n.id) : v.concat(n.id)); };
    const onlineSel = sel.filter((id) => { const n = CX.node(id); return n && n.status !== 'offline'; });
    const selectableUnpointed = clients.filter((n) => n.status !== 'offline' && !pointed.has(n.id));
    const allUnpointedSelected = selectableUnpointed.length > 0 && selectableUnpointed.every((n) => sel.includes(n.id));
    const toggleSelectUnpointed = () => {
      if (allUnpointedSelected) setSel((v) => v.filter((id) => !selectableUnpointed.some((n) => n.id === id)));
      else setSel((v) => Array.from(new Set(v.concat(selectableUnpointed.map((n) => n.id)))));
    };

    /* 推导某客户端的 DefaultEngine.ini 路径：必须取「这台机自己」的工程目录（locByMachine[mid]），
       不能用 proj.root（那是首个 location 的路径，可能属于别的机器）。 */
    const iniPathFor = (mid) => {
      const key = String(mid);
      const proj = (window.UE_PROJECTS || []).find((p) => p.locByMachine && p.locByMachine[key]);
      return proj ? (proj.locByMachine[key] + '\\Config\\DefaultEngine.ini') : null;
    };

    /* 逐机真实写配置：set_ini_key 写 [StorageServers] Shared 指向此服务器；部分失败是常态 */
    const applyTo = (ids) => {
      if (!status) return;
      const host = status.host || (srvNode && srvNode.host) || '';
      const scheme = status.scheme || protocol || 'http';
      const hostUri = scheme + '://' + host + ':' + status.port;
      /* UE [StorageServers] Shared 的值必须是结构化条目：Host 为完整 URI（含端口），
         附 Namespace / 环境与命令行覆盖键 / DeactivateAt——单写 Host=..;Port=.. UE 不识别。 */
      const value = '(Host="' + hostUri + '", Namespace="ue.ddc", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)';
      ids.filter((id) => { const n = CX.node(id); return n && n.status !== 'offline'; }).forEach((id) => {
        const n = CX.node(id);
        const iniPath = iniPathFor(n.machineId);
        if (!iniPath) { setRes((r) => Object.assign({}, r, { [id]: { st: 'fail', msg: '该机未发现 UE 工程 — 先在「集群总览」对这台机扫描发现工程，才知道往哪个 DefaultEngine.ini 写' } })); return; }
        setRes((r) => Object.assign({}, r, { [id]: { st: 'running' } }));
        setIniKey(n.machineId, iniPath, 'StorageServers', 'Shared', value).then(
          () => {
            setRes((r) => Object.assign({}, r, { [id]: { st: 'ok', msg: '已指向 ' + hostUri } }));
            setPointed((p) => { const np = new Set(p); np.add(id); return np; });
            log(s, 'ok', `<b>set_ini_key</b> · ${esc(n.host)} → ${esc(hostUri)}`);
          },
          (e) => {
            const em = e && e.message ? e.message : String(e);
            setRes((r) => Object.assign({}, r, { [id]: { st: 'fail', msg: em } }));
            log(s, 'err', `<b>set_ini_key</b> · ${esc(n.host)} 写 [StorageServers] Shared 失败`);
          });
      });
    };

    const previewApply = (ids) => {
      const online = ids.filter((id) => { const n = CX.node(id); return n && n.status !== 'offline'; });
      if (!online.length || !status) return;
      const host = status.host || srvNode.host;
      const hostUri = (status.scheme || protocol || 'http') + '://' + host + ':' + status.port;
      CX.openPreview(s, {
        title: '把客户端指向此缓存服务器', icon: 'link', cli: 'set_ini_key [StorageServers] Shared',
        destructive: false, channel: 'ssh', confirmLabel: '应用到 ' + online.length + ' 台',
        steps: [
          '在每台选中机器写入 [StorageServers] Shared → Host=' + hostUri,
          '逐台远程改缓存配置（远程操作，部分失败是常态，可单独重试）',
          '写入后该机即把缓存上游指向此共享服务器',
        ],
        simpleScope: online.map((id) => { const n = CX.node(id); return { host: n.host, ip: n.ip, msg: '写 [StorageServers] Shared' }; }),
        onConfirm: () => applyTo(online),
      });
    };

    /* ============ 渲染 ============ */
    const kv = (k, v, mono) => h('div', { className: 'zs-kv' }, h('span', { className: 'zs-k' }, k), h('span', { className: 'zs-v' + (mono ? ' mono' : '') }, v));
    const sMeta = SVC_STATE[(status && status.svc) || 'unknown'] || SVC_STATE.unknown;

    /* ① 状态卡 / 未部署空态 */
    const statusCard = statusLoading
      ? h('div', { className: 'zen-empty' },
          h('span', { className: 'ze-ico' }, h('span', { className: 'zstep-spin' })),
          h('div', { className: 'ze-tx' }, h('div', { className: 'ze-t' }, '正在读取 Zen 服务器状态…')))
      : deployed
        ? h('div', { className: 'zen-status' },
            h('div', { className: 'zs-head' },
              h('span', { className: 'zs-ico' }, h(Icon, { name: 'cube', size: 20 })),
              h('div', { className: 'zs-id' },
                h('div', { className: 'zs-title' }, status.host || ('endpoint ' + status.endpointId),
                  h('span', { className: 'zs-host' }, status.ip ? (status.ip + ' : ' + status.port) : (':' + status.port))),
                h('div', { className: 'zs-sub' }, status.scheme + ' · ' + (status.version === '—' ? '版本未知' : status.version))),
              h(ZBadge, { vis: sMeta.vis, icon: sMeta.icon, label: sMeta.label }),
              h('div', { className: 'zs-actions' },
                h('button', { className: 'mini-btn', onClick: probeServer }, h(Icon, { name: 'pulse', size: 12 }), '探活'),
                status.svc === 'running'
                  ? h('button', { className: 'mini-btn', onClick: stopServer }, h(Icon, { name: 'pause', size: 12 }), '停止')
                  : h('button', { className: 'mini-btn', onClick: startServer }, h(Icon, { name: 'play', size: 12 }), '启动'),
                h('button', { className: 'mini-btn danger', onClick: uninstallServer }, h(Icon, { name: 'trash', size: 12 }), '卸载'))),
            h('div', { className: 'zs-grid' },
              kv('版本', status.version),
              kv('端口', String(status.port), true),
              kv('协议', status.scheme),
              kv('数据目录', status.dataDir, true),
              kv('缓存 provider', status.providers && status.providers.length ? status.providers.join(' · ') : '—', true),
              kv('已指向客户端', pointedCount + ' 台')))
        : h('div', { className: 'zen-empty' },
            h('span', { className: 'ze-ico' }, h(Icon, { name: 'cube', size: 26 })),
            h('div', { className: 'ze-tx' },
              h('div', { className: 'ze-t' }, '未部署 Zen 缓存服务器'),
              h('div', { className: 'ze-s' }, '集群里还没有共享缓存服务器。填写下方参数并部署一台，让渲染机都用上它。')),
            h(ZBadge, { vis: 'neutral', label: '未部署' }));

    /* 部署表单 */
    const segProto = h('div', { className: 'zseg' },
      ['http', 'https'].map((p) => h('button', { key: p, className: protocol === p ? 'on' : '', onClick: () => setProtocol(p) }, p)));
    const segAcct = h('div', { className: 'zseg wide' },
      [['local', '本地服务账号'], ['domain', '域账号']].map(([k, lbl]) =>
        h('button', { key: k, className: acctKind === k ? 'on' : '', onClick: () => setAcctKind(k) }, lbl)));

    const deployForm = h('div', { className: 'deploy-panel' },
      h('div', { className: 'dp-h' }, h(Icon, { name: 'cube', size: 15 }), deployed ? '重新部署 Zen 服务器' : '部署 Zen 服务器',
        h('span', { className: 'dp-h-note' }, '逐步真实执行 · 每步可单独重试')),
      h('div', { className: 'zform-grid' },
        h('div', { className: 'dp-field grow' }, h('label', null, '服务器机器'),
          h(Selector, { kpre: '机器', value: srvNode.id, options: srvOpts, width: 280, onChange: pickServer })),
        h('div', { className: 'dp-field grow' }, h('label', null, '服务端点 · 协议 / 主机 / 端口'),
          h('div', { className: 'zendpoint' },
            segProto,
            h('span', { className: 'zep-sep mono' }, '://'),
            h('span', { className: 'zep-host mono' }, srvNode.host),
            h('span', { className: 'zep-sep mono' }, ':'),
            h('input', { className: 'dp-input mono zep-port', value: port, spellCheck: false, 'aria-label': '端口', onChange: (e) => setPort(e.target.value) }))),
        h('div', { className: 'dp-field grow' }, h('label', null, '数据目录 · data-dir'),
          h('input', { className: 'dp-input mono', value: dataDir, spellCheck: false, onChange: (e) => setDataDir(e.target.value) })),
        h('div', { className: 'dp-field grow' }, h('label', null, '配置文件落地路径'),
          h('input', { className: 'dp-input mono', value: configPath, spellCheck: false, onChange: (e) => setConfigPath(e.target.value) })),
        h('div', { className: 'dp-field grow' }, h('label', null, '服务运行账号 · 用于开放网络访问 + 安装服务'),
          h('div', { className: 'zacct' }, segAcct,
            acctKind === 'domain'
              ? h(React.Fragment, null,
                  h('input', { className: 'dp-input mono', placeholder: '域账号（如 VOLO\\zen-svc）', value: domUser, spellCheck: false, onChange: (e) => setDomUser(e.target.value) }),
                  h('input', { className: 'dp-input', type: 'password', placeholder: '密码', value: domPass, onChange: (e) => setDomPass(e.target.value) }))
              : h('span', { className: 'zacct-note' }, h(Icon, { name: 'shield', size: 12 }), '默认本地服务账号，无需密码')))),
      acctKind === 'domain' ? h('div', { className: 'zform-tip' }, h(Icon, { name: 'eye', size: 12 }),
        '安装服务用的账号需与「开放网络访问权限」用的账号一致——两步都用上面这个域账号。') : null,
      h('div', { className: 'zadv' },
        h('button', { className: 'zadv-tgl', onClick: () => setAdvOpen((v) => !v) },
          h(Icon, { name: 'chevr', size: 13, style: { transform: advOpen ? 'rotate(90deg)' : 'none' } }), '高级'),
        advOpen ? h('div', { className: 'zadv-body' },
          h('div', { className: 'dp-field' }, h('label', null, 'HTTP 服务类型'),
            h(Selector, { kpre: '类型', value: httpType, options: httpOpts, width: 200, onChange: setHttpType }))) : null),
      h('div', { className: 'zform-actions' },
        h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'eye', size: 14 }), isDisabled: deploying, onPress: previewDeploy }, '预览计划'),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), isDisabled: deploying, onPress: previewDeploy }, deploying ? '部署中…' : (deployed ? '重新部署' : '部署'))));

    /* 步骤列表 */
    const stepIco = (st, i) => {
      if (st === 'running') return h('span', { className: 'zstep-spin' });
      if (st === 'ok') return h(Icon, { name: 'check', size: 14 });
      if (st === 'fail') return h(Icon, { name: 'alert', size: 14 });
      return h('span', { className: 'zstep-n' }, i + 1);
    };
    const stepper = started ? h('div', { className: 'zsteps' },
      DEPLOY_STEPS.map((st, i) => {
        const r = run[st.id] || { st: 'idle' };
        const rm = RUN_STATE[r.st];
        return h('div', { key: st.id, className: 'zstep is-' + r.st },
          h('span', { className: 'zstep-ico' }, stepIco(r.st, i)),
          h('div', { className: 'zstep-main' },
            h('div', { className: 'zstep-top' },
              h('span', { className: 'zstep-label' }, st.label),
              h('span', { className: 'zstep-cli mono' }, st.cli)),
            h('div', { className: 'zstep-desc' }, st.desc(formObj, srvNode.host)),
            r.st === 'fail' && r.err ? h('div', { className: 'zstep-err' }, h(Icon, { name: 'alert', size: 13 }), r.err) : null,
            r.st === 'fail' ? h('div', { className: 'zstep-acts' },
              st.gate ? h('button', { className: 'mini-btn', onClick: doRefresh }, h(Icon, { name: 'sync', size: 12 }), '刷新这台机器') : null,
              h('button', { className: 'mini-btn', onClick: () => runFrom(i) }, h(Icon, { name: 'restart', size: 12 }), '重试这一步')) : null),
          h(ZBadge, { vis: rm.vis, icon: rm.icon, label: rm.label, soft: true }));
      })) : null;

    /* ② 客户端列表 */
    const clientBadge = (n) => {
      const r = res[n.id];
      if (r) {
        const m = RUN_STATE[r.st];
        return h('div', { className: 'zcli-right' },
          h(ZBadge, { vis: m.vis, icon: m.icon, label: r.st === 'running' ? '应用中' : r.st === 'ok' ? '已应用' : '失败', soft: true }),
          r.msg ? h('span', { className: 'zcli-msg s-' + m.vis }, r.msg) : null,
          r.st === 'fail' ? h('button', { className: 'mini-btn', onClick: () => applyTo([n.id]) }, h(Icon, { name: 'restart', size: 12 }), '重试') : null);
      }
      if (n.status === 'offline') return h(ZBadge, { vis: 'neutral', icon: 'power', label: '离线 · 跳过' });
      if (pointed.has(n.id)) return h(ZBadge, { vis: 'positive', icon: 'check', label: '已指向此服务器', soft: true });
      return h(ZBadge, { vis: 'notice', icon: 'minus', label: '未指向', soft: true });
    };
    const clientRow = (n) => {
      const off = n.status === 'offline';
      const checked = sel.includes(n.id);
      const stMeta = NODE_STATUS[n.status] || NODE_STATUS.na;
      return h('div', { key: n.id, className: 'cli-row zcli' + (off ? ' off' : '') + (checked ? ' on' : '') },
        h('button', { className: 'zck' + (checked ? ' on' : '') + (off ? ' dis' : ''), onClick: () => toggleSel(n), disabled: off, title: off ? '离线机器不可选' : '选择' },
          checked ? h(Icon, { name: 'check', size: 12 }) : null),
        h('span', { className: 'zcli-state' }, CX.dot(stMeta.visual),
          h('span', { className: 'zcli-state-tx s-' + stMeta.visual }, off ? '离线' : '在线')),
        h('div', { className: 'cli-meta' },
          h('div', { className: 'cli-host mono' }, n.host),
          h('div', { className: 'cli-sub' }, n.ip + ' · ' + n.role)),
        h('div', { className: 'zcli-end' }, clientBadge(n)));
    };

    return h('div', { className: 'res ddc' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, 'DDC · ZenServer'),
        h('div', { className: 'right' },
          deployed
            ? h('span', { className: 'toolchip' }, h(Icon, { name: 'cube', size: 14 }), '当前后端：ZenServer · ' + (status.host || ('endpoint ' + status.endpointId)))
            : h('span', { className: 'toolchip dim' }, h(Icon, { name: 'minus', size: 14 }), '未部署共享缓存服务器'))),
      h('div', { className: 'ddc-body' },
        h('div', { className: 'ddc-sec-h' },
          h('span', null, '① 架设 / 管理 Zen 缓存服务器'),
          h('span', { className: 'dim' }, '在集群某一台机器上立起一台共享缓存服务器')),
        statusCard,
        deployForm,
        stepper,
        h('div', { className: 'ddc-sec-h', style: { marginTop: 24 } },
          h('span', null, '② 让客户端机器用上这台缓存'),
          h('span', { className: 'dim' }, pointedCount + ' / ' + clients.length + ' 已指向 · 逐台改缓存配置指向此服务器')),
        h('div', { className: 'cli-panel' },
          h('div', { className: 'zcli-bar' },
            h('div', { className: 'cli-server-chip' },
              h('span', { className: 'csc-ico' }, h(Icon, { name: 'cube', size: 15 })),
              h('div', { style: { minWidth: 0 } },
                h('div', { className: 'csc-t' }, '指向目标 · ' + (status ? (status.host || srvNode.host) : srvNode.host)),
                h('div', { className: 'csc-s mono' }, (status ? (status.ip || srvNode.ip) : srvNode.ip) + ' : ' + (status ? status.port : port)))),
            h('button', { className: 'zlink-all', onClick: toggleSelectUnpointed, disabled: selectableUnpointed.length === 0 },
              allUnpointedSelected ? '取消选择' : '选中全部未指向（' + selectableUnpointed.length + '）'),
            h('div', { className: 'zcli-go' },
              h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'link', size: 14 }), isDisabled: onlineSel.length === 0 || !canPoint, onPress: () => previewApply(sel) },
                onlineSel.length ? '指向此服务器（' + onlineSel.length + '）' : '指向此服务器'))),
          !deployed
            ? h('div', { className: 'cli-note warn' }, h(Icon, { name: 'alert', size: 13 }), '尚未部署服务器，先在上方①部署一台，再把客户端指向它。')
            : !canPoint
              ? h('div', { className: 'cli-note warn' }, h(Icon, { name: 'alert', size: 13 }), '服务器已部署但当前未在运行（' + sMeta.label + '）—— 先在上方①启动 / 探活确认运行中，再指向客户端。')
              : null,
          h('div', { className: 'cli-note' }, h(Icon, { name: 'shield', size: 13 }),
            '应用 = 改这些机器的缓存配置（写 [StorageServers] Shared）指向上方服务器；远程操作走 SSH key，逐台执行、逐台看成败。'),
          h('div', { className: 'cli-list' }, clients.map(clientRow)))));
  }

  window.VOLO_CACHE_ZEN = { view: (s) => h(ZenServer, { s }) };
})();

export {};
