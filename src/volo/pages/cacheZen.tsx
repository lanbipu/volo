// @ts-nocheck
/* Volo — Cache · DDC · ZenServer 子页（重做版，接真实后端）.
   1:1 port of the Claude Design handoff `src/cache_zen.jsx`, with the simulated
   deploy chain / client-pointing replaced by real invoke() calls.

   ① 架设 / 管理一台 Zen 共享缓存服务器：
      - 顶部状态卡读真实状态（zen_list_endpoints + zen_status + zen_cache_stats）；
      - 部署 = 7 步真实远程链路，逐步执行、三态、某步失败可单独重试，endpoint_id 从
        zen_register 串到后续步骤；detect 失败给「刷新这台机器」(refresh_machine) 后自动重试；
      - 已部署可启停 / 卸载 / 探活（停止 / 卸载是破坏性 → preview → 二次确认）；
      - 缓存回收策略（GC）：三个时长参数独立编辑，统一「应用更改」；应用 = 重写
        zen_config.lua + 重启服务生效（Zen 不热重载），走破坏性二次确认（会短暂中断）。
   ② 让客户端机器用上这台缓存：多选客户端 → 逐台 set_ini_key 写 [StorageServers] Shared
      指向此服务器 → 逐机成败、可重试。
   远程操作走 SSH key（cred = {} 全 None），不逐操作选凭据；真实回读来自 zen_probe。 */
import * as React from "react";
import "../ds";
import "./cache";
import {
  zenRegister, zenDetectBinary, zenApplyConfig, zenUpdateGcSettings, zenCreateDedicatedAccount,
  zenUrlaclAdd, zenServiceInstall, zenServiceStart, zenServiceStop, zenServiceUninstall,
  zenUnregister, zenProbe, zenStatus, zenListEndpoints, zenCacheStats, setIniKey, refreshMachine,
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
      desc: (f) => `写入 ${f.configPath}（zen_config.lua，落地后回读 SHA256 校验；安装目录与探测位置不同时先拷贝 zen.exe 过去）` },
    { id: 'urlacl',   label: '开放网络访问权限',       cli: 'zen_urlacl_add',
      desc: (f) => `netsh http add urlacl url=${f.protocol}://+:${f.port}/ · 账号 ${f.acct}` },
    { id: 'service',  label: '安装为 Windows 服务',     cli: 'zen_service_install',
      desc: (f) => `sc create VoloZenServer · 启动 auto · 服务账号 ${f.acct}` },
    { id: 'start',    label: '启动服务',               cli: 'zen_service_start',
      desc: () => `sc start VoloZenServer` },
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

  /* ---- GC 缓存回收策略：三个独立时长参数，均为「编辑→待应用→统一应用」---- */
  const GC_UNIT_SEC = { minutes: 60, hours: 3600, days: 86400 };
  const GC_DEFAULTS = { interval: { value: 8, unit: 'hours' }, lw: { value: 1, unit: 'hours' }, maxDur: { value: 10, unit: 'days' } };
  const GC_FIELDS = [
    { id: 'interval', label: '完整回收间隔',
      desc: '完整 GC 扫描的执行频率，遍历所有缓存数据并清理过期内容。',
      tip: '完整 GC 扫描的执行频率。系统会遍历所有缓存数据，清理已过期、不再被引用的内容以释放磁盘空间。间隔越短，磁盘释放越及时，但会消耗更多服务器资源。',
      units: [{ id: 'minutes', label: '分钟' }, { id: 'hours', label: '小时' }, { id: 'days', label: '天' }],
      presets: [{ value: 1, unit: 'hours', label: '1 小时' }, { value: 6, unit: 'hours', label: '6 小时' },
        { value: 8, unit: 'hours', label: '8 小时（默认）' }, { value: 12, unit: 'hours', label: '12 小时' }, { value: 24, unit: 'hours', label: '24 小时' }] },
    { id: 'lw', label: '轻量回收间隔',
      desc: '轻量级维护扫描的执行频率，只做小范围清理，不做全量扫描。',
      tip: '轻量级维护扫描的执行频率，成本较低，用于更新访问记录等小范围清理，不做全量扫描。',
      units: [{ id: 'minutes', label: '分钟' }, { id: 'hours', label: '小时' }],
      presets: [{ value: 30, unit: 'minutes', label: '30 分钟' }, { value: 1, unit: 'hours', label: '1 小时（默认）' },
        { value: 2, unit: 'hours', label: '2 小时' }, { value: 6, unit: 'hours', label: '6 小时' }] },
    { id: 'maxDur', label: '缓存最大保留时长',
      desc: '超过此时长未被访问的缓存，会在下一次完整回收时被清理。',
      tip: '一条缓存数据如果超过这个时长没有被访问，会在下一次完整回收时被清理。设置过短可能导致低频使用的分支/项目缓存频繁失效，需要重新生成数据；设置过长会占用更多磁盘空间。',
      units: [{ id: 'hours', label: '小时' }, { id: 'days', label: '天' }],
      presets: [{ value: 3, unit: 'days', label: '3 天' }, { value: 7, unit: 'days', label: '7 天' },
        { value: 10, unit: 'days', label: '10 天（默认）' }, { value: 14, unit: 'days', label: '14 天' }, { value: 30, unit: 'days', label: '30 天' }] },
  ];
  const gcSeconds = (f) => Math.max(0, Math.round(Number(f.value) || 0)) * GC_UNIT_SEC[f.unit];
  const cloneGc = (v) => ({ interval: Object.assign({}, v.interval), lw: Object.assign({}, v.lw), maxDur: Object.assign({}, v.maxDur) });
  /* 秒数 → {value,unit}：挑一个能整除的最大单位，选不到就退到最小单位四舍五入 */
  const bestVU = (totalSec, units) => {
    for (let i = units.length - 1; i >= 0; i--) {
      const per = GC_UNIT_SEC[units[i].id];
      if (totalSec % per === 0) return { value: totalSec / per, unit: units[i].id };
    }
    const u0 = units[0].id;
    return { value: Math.round(totalSec / GC_UNIT_SEC[u0]), unit: u0 };
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
    const [port, setPort] = useState('8558');  /* UE ZenServer 真实默认端口 */
    const [protocol, setProtocol] = useState('http');  /* HTTPS 未实现（lua_config 尚无 TLS key，见后端 T2.2 doc），表单只保留 http */
    const [installDir, setInstallDir] = useState('C:\\ZenServer');
    const [dataDir, setDataDir] = useState('D:\\ZenData');
    const [configOverride, setConfigOverride] = useState(null);  /* null = 跟随安装目录自动生成 */
    const [httpType, setHttpType] = useState('httpsys');   /* asio | httpsys（后端合法值）*/
    /* 服务运行账号：system（SYSTEM，无密码）| dedicated（专用本地账号，最小权限，生产默认）| domain（域账号，含 gMSA）*/
    const [acctKind, setAcctKind] = useState('dedicated');
    const [dedManual, setDedManual] = useState(false);   /* false=一键创建托管账号；true=手动指定已有本地账号 */
    const [dedUser, setDedUser] = useState('');
    const [dedPass, setDedPass] = useState('');
    const [dedCredAlias, setDedCredAlias] = useState(null);  /* 托管账号的 SecretStore 别名，前端不持有密码 */
    const [dedCreating, setDedCreating] = useState(false);
    const [domType, setDomType] = useState('std');   /* std=普通域账号 | gmsa=组托管服务账号 */
    const [domName, setDomName] = useState('VOLO');
    const [domUser, setDomUser] = useState('VOLO\\zen-svc');
    const [domPass, setDomPass] = useState('');
    const [showPass, setShowPass] = useState(false);
    const [advOpen, setAdvOpen] = useState(false);

    /* —— 真实状态（zen_list_endpoints + zen_status + zen_cache_stats）—— */
    const [status, setStatus] = useState(null);   /* {endpointId,machineId,host,ip,port,scheme,version,dataDir,svc,records,gc*,serviceAccount*} | null */
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
          gcIntervalSeconds: ep.gc_interval_seconds, gcLightweightIntervalSeconds: ep.gc_lightweight_interval_seconds,
          cacheMaxDurationSeconds: ep.cache_max_duration_seconds,
          serviceAccountUsername: ep.service_account_username, serviceAccountCredAlias: ep.service_account_cred_alias,
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

    /* —— GC 缓存回收策略：草稿值独立于已应用值，统一「应用更改」提交；首次拿到真实
       endpoint 数据时按其 gc_* 字段种一次（缺省=尚未配置过，视作官方默认），之后不再
       被 loadStatus() 的刷新覆盖，避免打断用户正在编辑的草稿。 —— */
    const [gcApplied, setGcApplied] = useState(() => cloneGc(GC_DEFAULTS));
    const [gcDraft, setGcDraft] = useState(() => cloneGc(GC_DEFAULTS));
    const [gcBusy, setGcBusy] = useState(false);
    const [gcJustApplied, setGcJustApplied] = useState(false);
    const gcSeededForRef = useRef(null);
    useEffect(() => {
      if (!status || gcSeededForRef.current === status.endpointId) return;
      gcSeededForRef.current = status.endpointId;
      const seeded = {
        interval: status.gcIntervalSeconds != null ? bestVU(status.gcIntervalSeconds, GC_FIELDS[0].units) : Object.assign({}, GC_DEFAULTS.interval),
        lw: status.gcLightweightIntervalSeconds != null ? bestVU(status.gcLightweightIntervalSeconds, GC_FIELDS[1].units) : Object.assign({}, GC_DEFAULTS.lw),
        maxDur: status.cacheMaxDurationSeconds != null ? bestVU(status.cacheMaxDurationSeconds, GC_FIELDS[2].units) : Object.assign({}, GC_DEFAULTS.maxDur),
      };
      setGcApplied(seeded);
      setGcDraft(cloneGc(seeded));
      /* 同时恢复已创建的托管专用账号（若有），让用户刷新页面后还能看到「已创建」而不是被要求重新建一个 */
      if (status.serviceAccountUsername && status.serviceAccountCredAlias) {
        setAcctKind('dedicated'); setDedManual(false);
        setDedUser(status.serviceAccountUsername); setDedCredAlias(status.serviceAccountCredAlias);
      }
    }, [status]);
    const gcFieldDirty = (id) => gcSeconds(gcDraft[id]) !== gcSeconds(gcApplied[id]);
    const gcDirty = GC_FIELDS.some((f) => gcFieldDirty(f.id));
    const gcNonDefault = (id) => gcSeconds(gcApplied[id]) !== gcSeconds(GC_DEFAULTS[id]);
    const gcAtDefault = GC_FIELDS.every((f) => gcSeconds(gcDraft[f.id]) === gcSeconds(GC_DEFAULTS[f.id]));
    const setGcField = (id, patch) => setGcDraft((d) => Object.assign({}, d, { [id]: Object.assign({}, d[id], patch) }));
    const resetGcDefaults = () => setGcDraft(cloneGc(GC_DEFAULTS));

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

    const createDedicated = () => {
      setDedCreating(true);
      zenCreateDedicatedAccount(srvNode.machineId).then(
        (r) => {
          setDedUser(r.username); setDedCredAlias(r.cred_alias); setDedCreating(false);
          log(s, 'ok', `<b>zen_create_dedicated_account</b> · ${esc(srvNode.host)} → ${esc(r.username)}`);
        },
        (e) => {
          setDedCreating(false);
          log(s, 'err', `<b>zen_create_dedicated_account</b> 失败 · ${esc((e && e.message) || String(e))}`);
        },
      );
    };
    const dedCreated = !dedManual && !!dedCredAlias;

    /* 服务运行账号：按当前档位算出真正传给后端的 serviceUser / servicePass / serviceCredAlias。
       专用本地账号的托管密码从不进前端——只带 alias，由后端从 SecretStore 解出来。 */
    const effectiveServiceUser = () => {
      if (acctKind === 'system') return 'LocalSystem';
      if (acctKind === 'dedicated') return dedUser.trim() || null;
      const raw = domUser.trim();
      if (!raw) return null;
      return domType === 'gmsa' && !raw.endsWith('$') ? raw + '$' : raw;
    };
    const effectiveServicePass = () => {
      if (acctKind === 'dedicated' && dedManual) return dedPass || null;
      if (acctKind === 'domain' && domType === 'std') return domPass || null;
      return null;  /* system / gMSA / 托管专用账号（走 cred alias）*/
    };
    const effectiveCredAlias = () => (acctKind === 'dedicated' && !dedManual ? (dedCredAlias || null) : null);
    /* system 档不需要账号名（zen.exe 落到内置 LocalService 默认）；dedicated / domain
       两档若 effectiveServiceUser() 算不出账号名（未创建托管账号 / 未填手动账号名），
       部署会静默落到 LocalService 而不是操作员选中的账号——部署前必须拦住这种情况，
       而不是等它在后台悄悄发生。 */
    const acctReady = () => acctKind === 'system' || !!effectiveServiceUser();
    const acctLabel = acctKind === 'system'
      ? 'LocalSystem（系统账号）'
      : acctKind === 'dedicated'
        ? (dedManual ? (dedUser.trim() || '（未填写本地账号）') : (dedCredAlias ? dedUser + '（托管）' : 'zen-svc-xxxxxx（待创建）'))
        : (domType === 'gmsa' ? (domUser.trim() || '（未填写 gMSA 账号）') + '（gMSA）' : (domUser.trim() || '（未填写域账号）'));
    const principal = effectiveServiceUser() || 'NT AUTHORITY\\LocalService';

    /* 配置文件落地路径：默认跟随安装目录自动生成 {安装目录}\zen_config.lua，可手动覆写 */
    const derivedConfigPath = installDir.replace(/[\\/]+$/, '') + '\\zen_config.lua';
    const configPath = configOverride == null ? derivedConfigPath : configOverride;
    const formObj = { port, protocol, dataDir, configPath, acct: acctLabel };
    const srvOpts = RN.map((n) => ({ id: n.id, label: n.host, sub: n.ip }));
    const httpOpts = [{ id: 'httpsys', label: 'http.sys（默认）' }, { id: 'asio', label: 'asio' }];
    const cred = {}; /* SSH key — ZenCredentialInput 全 None */

    const setStep = (id, st, err) => setRun((r) => Object.assign({}, r, { [id]: { st, err: err || null } }));

    /* 单步真实执行：成功 resolve，失败 throw（message 即步骤错误）*/
    const runStep = async (id) => {
      const mid = srvNode.machineId;
      if (id === 'register') {
        const o = await zenRegister({
          machine_id: mid, declared_port: Number(port) || 8558, scheme: protocol,
          role: 'shared_upstream', data_dir: dataDir, httpserverclass: httpType, lifecycle: 'installed_service',
          install_dir: installDir, config_path_override: configOverride,
        });
        epRef.current = o && o.endpoint_id != null ? o.endpoint_id : epRef.current;
        if (epRef.current == null) throw new Error('登记未返回 endpoint_id');
        /* 幂等冲突路径（同 machine + port 已登记过）：register() 静默保留原有 install_dir /
           config_path_override，本次表单里改过的值不会生效。o 里的值是「实际生效」的值——
           跟本次请求的值一对比，不一致就当场报错，而不是让后续步骤悄悄用旧目录继续跑。 */
        if (o && o.inserted === false) {
          const wantInstallDir = installDir.trim();
          const wantConfigOverride = configOverride == null ? null : configOverride.trim();
          const gotInstallDir = o.install_dir || '';
          const gotConfigOverride = o.config_path_override || null;
          if (gotInstallDir !== wantInstallDir || gotConfigOverride !== wantConfigOverride) {
            throw new Error(
              '该服务器（机器 + 端口）此前已登记过，安装目录 / 配置文件落地路径的修改这次不会生效——' +
              '当前实际生效值：安装目录 ' + (gotInstallDir || '（跟随探测）') +
              (gotConfigOverride ? '，配置路径覆盖 ' + gotConfigOverride : '') +
              '。如需变更，先「卸载」现有服务器再重新部署。'
            );
          }
        }
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
      if (id === 'config')  { await zenApplyConfig(epRef.current, true, false, cred); return; }
      if (id === 'urlacl')  { await zenUrlaclAdd(epRef.current, principal, true, false, cred); return; }
      if (id === 'service') {
        await zenServiceInstall(epRef.current, true, false, cred, effectiveServiceUser(), effectiveServicePass(), effectiveCredAlias());
        return;
      }
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

    /* 部署 → 居中二级对话框（modal）确认后执行；真实 7 步进度在页面下方步骤器中逐步呈现
       （liveProgress:false：对话框只做计划确认，进度不在对话框内重复）。 */
    const modalDeploy = () => CX.openModalPreview(s, {
      title: (deployed ? '重新部署' : '部署') + ' Zen 缓存服务器', icon: 'cube',
      cli: 'zen_register → … → zen_probe', destructive: false, channel: 'ssh', confirmLabel: deployed ? '重新部署' : '开始部署',
      liveProgress: false,
      steps: DEPLOY_STEPS.map((st) => st.label + '（' + st.cli + '）'),
      simpleScope: [{ host: srvNode.host, ip: srvNode.ip, msg: protocol + '://…:' + port + ' · ' + dataDir }],
      run: () => { epRef.current = null; runFrom(0); },
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
      simpleScope: [{ host: status.host, ip: status.ip, msg: 'sc stop VoloZenServer' }],
      onConfirm: () => s.runCmd({ domain: 'zen', action: 'stop', target: status.host, chan: 'ssh', note: '停止服务' },
        () => zenServiceStop(status.endpointId, true, false, cred), { okMsg: () => status.host + ' 服务已停止' })
        .then(() => loadStatus(), () => {}),
    });
    const uninstallServer = () => status && CX.openPreview(s, {
      title: '卸载 ZenServer', icon: 'trash', cli: 'zen_service_uninstall + zen_unregister', destructive: true, channel: 'ssh', confirmLabel: '卸载服务器',
      steps: ['停止并卸载 ' + status.host + ' 上的 Windows 服务 VoloZenServer', '从 Volo 注销该 endpoint（不删除 data-dir 数据目录）', '客户端的指向配置需在下方②另行撤除'],
      simpleScope: [{ host: status.host, ip: status.ip, msg: 'uninstall + unregister' }],
      onConfirm: () => s.runCmd({ domain: 'zen', action: 'uninstall', target: status.host, chan: 'ssh', note: '卸载并注销' },
        () => zenServiceUninstall(status.endpointId, true, false, cred).then(() => zenUnregister(status.endpointId, true, false)),
        { okMsg: () => status.host + ' 已卸载 · data-dir 保留' })
        .then(() => { setStarted(false); setRun({}); epRef.current = null; loadStatus(); }, () => {}),
    });

    /* 应用 GC 更改 → 破坏性二次确认（重写配置后会重启服务，短暂中断所有渲染节点的命中）*/
    const applyGc = () => {
      const changed = GC_FIELDS.filter((f) => gcFieldDirty(f.id));
      if (!changed.length || !status) return;
      CX.openPreview(s, {
        title: '应用缓存回收策略更改', icon: 'flush', cli: 'zen_update_gc_settings', destructive: true, channel: 'ssh', confirmLabel: '应用并重启服务',
        steps: [
          ...changed.map((f) => f.label + '：' + gcSeconds(gcApplied[f.id]).toLocaleString('zh-CN') + ' 秒 → ' + gcSeconds(gcDraft[f.id]).toLocaleString('zh-CN') + ' 秒'),
          '重写 zen_config.lua 后将重启 ZenServer 服务以生效（Zen 不会热重载配置文件）',
          '重启期间（预计数秒）所有渲染节点暂时无法命中此共享缓存',
        ],
        simpleScope: [{ host: status.host, ip: status.ip, msg: '重写配置 + 重启服务' }],
        onConfirm: () => {
          setGcBusy(true);
          s.runCmd({ domain: 'zen', action: 'gc-apply', target: status.host, chan: 'ssh', note: 'zen_update_gc_settings（重写配置 + 重启服务）' },
            () => zenUpdateGcSettings(
              status.endpointId, gcSeconds(gcDraft.interval), gcSeconds(gcDraft.lw), gcSeconds(gcDraft.maxDur), true, false, cred,
            ),
            { okMsg: () => 'GC 回收策略已更新 · 服务已重启' })
            .then(() => {
              setGcApplied(cloneGc(gcDraft));
              setGcBusy(false);
              setGcJustApplied(true);
              setTimeout(() => setGcJustApplied(false), 2600);
              loadStatus();
            }, () => setGcBusy(false));
        },
      });
    };

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
    /* 指向目标卡片的色调：未部署 = 中性引导态；已部署但停止/不可达/状态未知 = 真失败态；其余 = 平常强调色 */
    const targetVis = !deployed ? 'neutral' : (status.svc === 'running' ? 'accent' : status.svc === 'unreachable' ? 'negative' : 'notice');

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

    /* GC 缓存回收策略 —— 独立模块：三个时长参数各自可编辑，统一「应用更改」提交 */
    const gcFieldRow = (f) => {
      const draft = gcDraft[f.id];
      const dirty = gcFieldDirty(f.id);
      const nonDefault = gcNonDefault(f.id);
      return h('div', { className: 'gc-field' + (dirty ? ' dirty' : ''), key: f.id },
        h('div', { className: 'gc-field-head' },
          h('label', null, f.label,
            h('span', { className: 'gc-info', tabIndex: 0 },
              h(Icon, { name: 'info', size: 13 }),
              h('span', { className: 'gc-tip' }, f.tip))),
          nonDefault ? h('span', { className: 'gc-tag', title: '当前值与官方默认不同' }, '≠ 默认') : null,
          dirty ? h('span', { className: 'gc-dot', title: '尚未应用' }) : null),
        h('div', { className: 'gc-field-row' },
          h('div', { className: 'gc-stepper' + (!deployed ? ' is-disabled' : '') },
            h('input', {
              type: 'number', min: 0, inputMode: 'numeric', className: 'dp-input mono gc-num', value: draft.value,
              disabled: !deployed,
              onChange: (e) => setGcField(f.id, { value: e.target.value === '' ? '' : Math.max(0, Number(e.target.value)) }),
            }),
            h('div', { className: 'gc-spin' },
              h('button', {
                type: 'button', className: 'gc-spin-btn', tabIndex: -1, disabled: !deployed, 'aria-label': '增加',
                onClick: () => setGcField(f.id, { value: Math.max(0, (Number(draft.value) || 0) + 1) }),
              }, h(Icon, { name: 'chevu', size: 12 })),
              h('button', {
                type: 'button', className: 'gc-spin-btn', tabIndex: -1, disabled: !deployed, 'aria-label': '减少',
                onClick: () => setGcField(f.id, { value: Math.max(0, (Number(draft.value) || 0) - 1) }),
              }, h(Icon, { name: 'chevd', size: 12 })))),
          h(Selector, { kpre: '单位', value: draft.unit, options: f.units, width: 74, align: 'left', onChange: (u) => setGcField(f.id, { unit: u }) }),
          h('span', { className: 'gc-eq mono' }, '= ' + gcSeconds(draft).toLocaleString('zh-CN') + ' 秒')),
        h('div', { className: 'gc-presets' },
          f.presets.map((p) => h('button', {
            key: p.label, className: 'gc-chip' + (Number(draft.value) === p.value && draft.unit === p.unit ? ' on' : ''),
            disabled: !deployed, onClick: () => setGcField(f.id, { value: p.value, unit: p.unit }),
          }, p.label))),
        h('div', { className: 'gc-desc' }, f.desc));
    };
    const gcPanel = h('div', { className: 'gc-panel' + (!deployed ? ' is-disabled' : '') },
      h('div', { className: 'gc-head' },
        h('span', { className: 'gc-head-ico' }, h(Icon, { name: 'flush', size: 17 })),
        h('div', { className: 'gc-head-tx' },
          h('div', { className: 'gc-head-t' }, '缓存回收策略（GC）'),
          h('div', { className: 'gc-head-s' }, '控制服务器清理过期缓存的频率与保留时长')),
        deployed && gcDirty ? h('span', { className: 'gc-pending' }, h('span', { className: 'gc-pending-dot' }), '有未应用的更改') : null,
        deployed && !gcDirty && gcJustApplied ? h('span', { className: 'gc-applied-ok' }, h(Icon, { name: 'check', size: 12 }), 'GC 策略已更新') : null),
      !deployed ? h('div', { className: 'cli-note warn' }, h(Icon, { name: 'alert', size: 13 }), '请先部署 Zen 服务器后再配置回收策略。') : null,
      h('div', { className: 'gc-panel-body' },
        h('div', { className: 'gc-fields' }, GC_FIELDS.map(gcFieldRow)),
        h('div', { className: 'gc-actions' },
          h('button', { className: 'mini-btn', disabled: !deployed || gcBusy || gcAtDefault, onClick: resetGcDefaults },
            h(Icon, { name: 'restart', size: 12 }), '重置为默认值'),
          h(Button, {
            variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 14 }),
            isDisabled: !deployed || !gcDirty || gcBusy, onPress: applyGc,
          }, gcBusy ? '应用中…' : '应用更改'))));

    /* 部署表单 */
    const segProto = h('div', { className: 'zseg' },
      ['http'].map((p) => h('button', { key: p, className: protocol === p ? 'on' : '', onClick: () => setProtocol(p) }, p)));
    const ACCT_TIERS = [['system', '系统账号'], ['dedicated', '专用本地账号'], ['domain', '域账号']];
    const segAcct = h('div', { className: 'zseg wide zseg-acct' },
      ACCT_TIERS.map(([k, lbl]) =>
        h('button', { key: k, className: acctKind === k ? 'on' : '', onClick: () => setAcctKind(k) },
          lbl, k === 'dedicated' ? h('span', { className: 'seg-badge' }, '推荐') : null)));

    /* 密码输入 + 显示/隐藏切换 */
    const passField = (val, setVal, ph) => h('div', { className: 'zpass' },
      h('input', { className: 'dp-input', type: showPass ? 'text' : 'password', placeholder: ph, value: val, onChange: (e) => setVal(e.target.value) }),
      h('button', { type: 'button', className: 'zpass-eye' + (showPass ? ' on' : ''), 'aria-label': showPass ? '隐藏密码' : '显示密码', onClick: () => setShowPass((v) => !v) },
        h(Icon, { name: 'eye', size: 14 })));

    const acctBody = h('div', { className: 'zacct-body' },
      /* 档位一：系统账号 */
      acctKind === 'system' ? h(React.Fragment, null,
        h('div', { className: 'zacct-note' }, h(Icon, { name: 'shield', size: 12 }),
          '使用 Windows 内置 LocalSystem 账号运行，权限最高、无需密码，适合快速搭建测试环境。'),
        h('div', { className: 'zacct-subhint' }, '生产环境建议改用「专用本地账号」，遵循最小权限原则。')) : null,
      /* 档位二：专用本地账号 */
      acctKind === 'dedicated' ? h(React.Fragment, null,
        h('div', { className: 'zacct-desc' }, '官方建议的安全实践：为 ZenServer 单独创建一个非管理员本地账号，仅授予运行所需的最小权限——推荐作为生产环境默认。'),
        !dedManual ? h(React.Fragment, null,
          !dedCreated
            ? h('div', { className: 'zacct-row' },
                h('button', { className: 'mini-btn accent', disabled: dedCreating, onClick: createDedicated },
                  h(Icon, { name: 'plus', size: 12 }), dedCreating ? '创建中…' : '创建专用账号'),
                h('span', { className: 'zacct-subhint' }, '工具自动生成账号名与高强度随机密码，密码由凭据管理器托管、不显示、不落地。'))
            : h('div', { className: 'zcred-chip' },
                h(Icon, { name: 'check', size: 13 }),
                h('span', { className: 'mono' }, dedUser),
                h('span', { className: 'zcred-sub' }, '密码由凭据管理器托管（不显示）'),
                h('button', { type: 'button', className: 'ztext-btn', disabled: dedCreating, onClick: createDedicated }, '重新生成')),
          h('button', { type: 'button', className: 'ztext-btn', onClick: () => { setDedManual(true); setDedUser(''); setDedCredAlias(null); } }, '手动指定已有本地账号')) : h(React.Fragment, null,
          h('div', { className: 'zacct' },
            h('input', { className: 'dp-input mono', placeholder: '本地账号（如 zen-svc）', value: dedUser, spellCheck: false, onChange: (e) => setDedUser(e.target.value) }),
            passField(dedPass, setDedPass, '密码')),
          h('div', { className: 'zperm' }, h(Icon, { name: 'info', size: 12 }),
            h('span', null, '该账号需预先具备：', h('b', null, '登录为服务'), ' 权限 · ',
              h('span', { className: 'mono' }, '{ZenInstall}'), ' 读权限 · ',
              h('span', { className: 'mono' }, '{ZenData}'), ' 读写权限 · 端口 8558 的 http.sys urlacl 授权。部署前置检查会校验这些权限。')),
          h('button', { type: 'button', className: 'ztext-btn', onClick: () => { setDedManual(false); setDedUser(''); setDedCredAlias(null); } }, '改用自动创建'))) : null,
      /* 档位三：域账号 */
      acctKind === 'domain' ? h(React.Fragment, null,
        h('div', { className: 'zseg zseg-sm' },
          [['std', '普通域账号'], ['gmsa', '组托管服务账号（gMSA）']].map(([k, lbl]) =>
            h('button', { key: k, className: domType === k ? 'on' : '', onClick: () => setDomType(k) }, lbl))),
        h('div', { className: 'zdom-grid' },
          h('div', { className: 'dp-field' }, h('label', null, '域名'),
            h('input', { className: 'dp-input mono', placeholder: '如 VOLO 或 corp.company.com', value: domName, spellCheck: false, onChange: (e) => setDomName(e.target.value) })),
          h('div', { className: 'dp-field' }, h('label', null, '用户名'),
            h('input', { className: 'dp-input mono', placeholder: '如 VOLO\\zen-svc', value: domUser, spellCheck: false, onChange: (e) => setDomUser(e.target.value) })),
          domType === 'std'
            ? h('div', { className: 'dp-field' }, h('label', null, '密码'), passField(domPass, setDomPass, '域账号密码'))
            : h('div', { className: 'dp-field' }, h('label', null, '密码'),
                h('div', { className: 'zacct-note' }, h(Icon, { name: 'shield', size: 12 }), 'gMSA 密码由域控自动管理，无需手动输入'))),
        h('div', { className: 'zform-tip' }, h(Icon, { name: 'alert', size: 12 }),
          'ZenServer 对外为无认证服务——域账号只决定服务以谁的身份运行、能否读写本机目录，不会给客户端访问 Zen 数据加上认证。'),
        h('div', { className: 'zacct-subhint' }, '需域管理员预先为该账号授予「登录为服务」权限；推荐优先使用 gMSA 以避免手动管理密码带来的风险。')) : null);

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
        h('div', { className: 'dp-field grow' }, h('label', null, '安装目录 · ZenInstall'),
          h('input', { className: 'dp-input mono', value: installDir, spellCheck: false, onChange: (e) => setInstallDir(e.target.value) })),
        h('div', { className: 'dp-field grow' }, h('label', null, '数据目录 · data-dir'),
          h('input', { className: 'dp-input mono', value: dataDir, spellCheck: false, onChange: (e) => setDataDir(e.target.value) })),
        h('div', { className: 'dp-field grow' },
          h('label', null, '配置文件落地路径',
            configOverride == null
              ? h('span', { className: 'dp-hint' }, '跟随安装目录')
              : h('button', { type: 'button', className: 'dp-hint dp-hint-btn', onClick: () => setConfigOverride(null) }, '恢复跟随安装目录')),
          h('input', { className: 'dp-input mono', value: configPath, spellCheck: false, onChange: (e) => setConfigOverride(e.target.value) })),
        h('div', { className: 'dp-field grow zacct-field' }, h('label', null, '服务运行账号 · 用于开放网络访问 + 安装服务'),
          segAcct, acctBody)),
      h('div', { className: 'zadv' },
        h('button', { className: 'zadv-tgl', onClick: () => setAdvOpen((v) => !v) },
          h(Icon, { name: 'chevr', size: 13, style: { transform: advOpen ? 'rotate(90deg)' : 'none' } }), '高级'),
        advOpen ? h('div', { className: 'zadv-body' },
          h('div', { className: 'dp-field' }, h('label', null, 'HTTP 服务类型'),
            h(Selector, { kpre: '类型', value: httpType, options: httpOpts, width: 200, onChange: setHttpType }))) : null),
      h('div', { className: 'zform-actions' },
        !acctReady() ? h('div', { className: 'cli-note warn' }, h(Icon, { name: 'alert', size: 13 }),
          '请先完成服务运行账号设置（创建专用账号，或填写账号用户名）再部署，否则服务将回退到默认账号运行。') : null,
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), isDisabled: deploying || !acctReady(), onPress: modalDeploy }, deploying ? '部署中…' : (deployed ? '重新部署' : '部署'))));

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
        /* 左右两列：左 ① 架设 / 管理，右 ② 客户端指向。两列顶部对齐（.zen-col 内
           .ddc-sec-h:first-child / .cli-panel 的 margin-top 已在 CSS 清零）；窄屏 <1180px 回退单列。 */
        h('div', { className: 'zen-2col' },
        /* 左列 · ① 架设 / 管理 Zen 缓存服务器 */
        h('div', { className: 'zen-col' },
        h('div', { className: 'ddc-sec-h' },
          h('span', null, '① 架设 / 管理 Zen 缓存服务器'),
          h('span', { className: 'dim' }, '在集群某一台机器上立起一台共享缓存服务器')),
        statusCard,
        deployForm,
        stepper,
        gcPanel),
        /* 右列 · ② 让客户端机器用上这台缓存 */
        h('div', { className: 'zen-col' },
        h('div', { className: 'ddc-sec-h' },
          h('span', null, '② 让客户端机器用上这台缓存'),
          h('span', { className: 'dim' }, pointedCount + ' / ' + clients.length + ' 已指向 · 逐台改缓存配置指向此服务器')),
        h('div', { className: 'cli-panel' },
          h('div', { className: 'zcli-bar' },
            h('div', { className: 'cli-server-chip vis-' + targetVis },
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
            '应用 = 改这些机器的缓存配置（写 [StorageServers] Shared，非旧版 [InstalledDerivedDataBackendGraph]）指向上方服务器；远程操作走 SSH key，逐台执行、逐台看成败。'),
          h('div', { className: 'cli-list' }, clients.map(clientRow)))))));
  }

  window.VOLO_CACHE_ZEN = { view: (s) => h(ZenServer, { s }) };
})();

export {};
