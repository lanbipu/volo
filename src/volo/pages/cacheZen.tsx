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
   ②+ 客户端本地 Zen 缓存目录：机器级环境变量 UE-ZenDataPath（set_machine_env_var）＋
      生效值真实回读（zen_read_local_runcontext 读该机 zenserver.runcontext）——注册表等
      更高优先级配置源可能压过环境变量，配置值与生效值分开展示、不冒充。
   远程操作走 SSH key（cred = {} 全 None），不逐操作选凭据；真实回读来自 zen_probe。 */
import * as React from "react";
import "../ds";
import "./cache";
import {
  zenRegister, zenDetectBinary, zenApplyConfig, zenUpdateGcSettings, zenCreateDedicatedAccount,
  zenUrlaclAdd, zenServiceInstall, zenServiceStart, zenServiceStop, zenServiceUninstall,
  zenUnregister, zenProbe, zenStatus, zenListEndpoints, zenCacheStats, setIniKey, readIniSection,
  refreshMachine, revealPath, zenEnableGlobal, zenReadLocalRuncontext, setMachineEnvVar, getMachineEnvVar,
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
      desc: (f) => `netsh http add urlacl url=${f.protocol}://*:${f.port}/ · 账号 ${f.acct}${f.acctKind === 'system' ? '（系统账号跳过）' : ''}` },
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

  /* 工程级指向的二级菜单：列出选中机器上已发现的 UE 工程，选择后再指向。
     每台机器只写入其本机存在的所选工程的 DefaultEngine.ini。UE 版本/体积/版本不一致
     标记（p.ue / p.size / p.warn）后端暂无源，随 ProjectVM 固定为 "—" / null（见
     adapters.ts toProjectVM）——按现有诚实占位惯例照常显示，不在此处臆造。 */
  function ProjPointModal({ machines, host, port, preselect, onConfirm, close }) {
    const projects = window.UE_PROJECTS || [];
    const relevant = projects.filter((p) => machines.some((m) => p.machines.includes(m.id)));
    const relIds = relevant.map((p) => p.id);
    const [selP, setSelP] = useState(() => {
      const base = (preselect && preselect.length) ? preselect.filter((id) => relIds.includes(id)) : relIds;
      return base.length ? base : relIds.slice();
    });
    const toggle = (id) => setSelP((v) => v.includes(id) ? v.filter((x) => x !== id) : v.concat(id));
    const allOn = relIds.length > 0 && relIds.every((id) => selP.includes(id));
    const toggleAll = () => setSelP(allOn ? [] : relIds.slice());
    const machinesFor = (p) => machines.filter((m) => p.machines.includes(m.id));
    const noProjMachines = machines.filter((m) => !relevant.some((p) => p.machines.includes(m.id)));
    const confirm = () => { if (!selP.length) return; close(); onConfirm(selP); };
    return h('div', { className: 'drawer drawer--preview' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: 'film', size: 17 })),
        h('div', { style: { minWidth: 0 } },
          h('h2', null, '选择要指向的 UE 工程'),
          h('div', { className: 'sub' },
            h('span', { className: 'cli-pill' }, 'set_ini_key DefaultEngine.ini'),
            h('span', null, ' · 工程级 · ' + machines.length + ' 台客户端'))),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, '1'), '在这些工程写入指向',
            h('span', { className: 'aff-sum' }, selP.length + ' / ' + relevant.length + ' 已选'),
            relIds.length ? h('button', { type: 'button', className: 'ppick-all', onClick: toggleAll }, allOn ? '取消全选' : '全选') : null),
          relevant.length
            ? h('div', { className: 'ppick-list' }, relevant.map((p) => {
                const on = selP.includes(p.id);
                const ms = machinesFor(p);
                /* 同一工程在不同机器上的实际落地路径可能不同（locByMachine 每机独立），
                   不能不加分辨地拿 p.root（首个 location 的路径，未必属于这批机器）当
                   通用展示——只在这批机器路径一致时才显示单一路径，不一致时如实标注。 */
                const msPaths = Array.from(new Set(ms.map((m) => p.locByMachine && p.locByMachine[String(m.machineId)]).filter(Boolean)));
                const pathLine = msPaths.length === 1
                  ? msPaths[0] + '\\Config\\DefaultEngine.ini'
                  : msPaths.length > 1
                    ? '路径因机器而异（' + msPaths.length + ' 种）'
                    : p.root + '\\Config\\DefaultEngine.ini';
                return h('button', { key: p.id, type: 'button', className: 'ppick-row' + (on ? ' on' : ''), onClick: () => toggle(p.id) },
                  h('span', { className: 'zck' + (on ? ' on' : '') }, on ? h(Icon, { name: 'check', size: 12 }) : null),
                  h('div', { className: 'ppick-meta' },
                    h('div', { className: 'ppick-name' }, p.name,
                      h('span', { className: 'ppick-tag mono' }, 'UE ' + p.ue + ' · ' + p.size),
                      p.warn ? h('span', { className: 'ppick-warn', title: p.warn }, h(Icon, { name: 'alert', size: 11 }), '版本不一致') : null),
                    h('div', { className: 'ppick-sub mono' }, pathLine)),
                  h('div', { className: 'ppick-on' },
                    h('span', { className: 'ppick-ct' }, ms.length + ' 台'),
                    h('span', { className: 'ppick-hosts mono' }, ms.map((m) => m.host).join(' · '))));
              }))
            : h('div', { className: 'cli-note warn' }, h(Icon, { name: 'alert', size: 13 }), '选中的机器上没有已发现的 UE 工程 · 先去集群总览发现工程')),
        noProjMachines.length
          ? h('div', { className: 'cli-note warn' }, h(Icon, { name: 'alert', size: 13 }),
              noProjMachines.length + ' 台机器未发现工程，将被跳过：' + noProjMachines.map((m) => m.host).join('、'))
          : null,
        h('div', { className: 'cli-note' }, h(Icon, { name: 'shield', size: 13 }),
          '每台机器只写入其本机存在的所选工程的 DefaultEngine.ini（[StorageServers] Shared → Host=' + host + '；Port=' + port + '）；远程走 SSH key，逐台看成败。')),
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, '取消'),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'link', size: 15 }), isDisabled: !selP.length, onPress: confirm },
          '指向此服务器（' + selP.length + ' 个工程）')));
  }

  /* 批量设置客户端本地 Zen 缓存目录：一个路径应用到多台（渲染农场同盘符布局是常态）*/
  function ZenDirModal({ machines, recOf, onConfirm, close }) {
    const [path, setPath] = useState('D:\\UE_DDC\\Zen');
    const valid = /^[A-Za-z]:\\/.test(path.trim());
    const confirm = () => { if (!valid) return; close(); onConfirm(path.trim()); };
    return h('div', { className: 'drawer drawer--preview' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: 'folder', size: 17 })),
        h('div', { style: { minWidth: 0 } },
          h('h2', null, '批量设置本地 Zen 缓存目录'),
          h('div', { className: 'sub' },
            h('span', { className: 'cli-pill' }, 'set_machine_env_var UE-ZenDataPath'),
            h('span', null, ' · 机器级环境变量 · ' + machines.length + ' 台客户端'))),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, '1'), '统一目录（Windows 绝对路径）'),
          h('div', { className: 'zdir-form' },
            h('input', { className: 'dp-input mono', value: path, autoFocus: true, spellCheck: false, placeholder: '如 D:\\UE_DDC\\Zen', onChange: (e) => setPath(e.target.value) })),
          !valid ? h('div', { className: 'zdir-err', style: { marginTop: 6 } }, h(Icon, { name: 'alert', size: 12 }), '请输入 Windows 绝对路径（如 D:\\UE_DDC\\Zen）') : null,
          h('div', { className: 'zdir-intro', style: { marginTop: 6 } }, '渲染农场通常同盘符布局，一个路径可直接应用到所有选中机器。')),
        h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, '2'), '目标机器', h('span', { className: 'aff-sum' }, machines.length + ' 台')),
          h('div', { className: 'zdm-list' }, machines.map((n) => {
            const rec = recOf(n.id);
            const stMeta = NODE_STATUS[n.status] || NODE_STATUS.na;
            return h('div', { key: n.id, className: 'zdm-row' },
              h('span', { className: 'zdm-host' }, CX.dot(stMeta.visual), n.host),
              h('span', { className: 'zdm-cur' + (rec.cfg ? '' : ' none') }, rec.cfg ? ('当前 ' + rec.cfg) : (rec.loading ? '当前配置读取中…' : '当前未配置 · 走默认 C 盘')),
              h('span', { className: 'zdm-arrow' }, h(Icon, { name: 'arrowr', size: 11 }), path.trim() || '—'));
          }))),
        h('div', { className: 'cli-note' }, h(Icon, { name: 'shield', size: 13 }),
          '写机器级环境变量 UE-ZenDataPath，逐台执行、逐台看成败；应用后需重启各机 UE 编辑器才生效，旧缓存不会自动迁移。此目录是「客户端本地 Zen 缓存」，区别于①区「服务器数据目录」（共享缓存本体）与 DDC 页「本地 DDC（文件版）」。')),
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, '取消'),
        h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), isDisabled: !valid, onPress: confirm },
          '应用到 ' + machines.length + ' 台')));
  }

  function ZenServer({ s }) {
    /* —— 服务器表单状态 —— */
    /* srvId 为 null 表示用户尚未显式选择过服务器机器；默认显示哪台机器完全交给下面
       的 srvNode 派生值决定（已部署的 ZenServer 优先），不用 effect 异步纠正它——
       避免和用户手动切换、以及 RENDER_NODES / 真实部署状态谁先到达产生竞态。 */
    const [srvId, setSrvId] = useState(null);
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
    /* pointed/sel/res/cfgScope/lastProjSelRef 必须在任何条件 return 之前声明（Rules of Hooks）。
       否则首屏 RENDER_NODES 还空、走下面 if(!srvNode) 早返回时这些 hook 不执行；机器异步到达后
       re-render 又执行，hook 数变化会让 React 抛「Rendered more hooks than during the previous
       render」并卸载整棵树（纯黑屏）。 */
    const [pointed, setPointed] = useState(() => new Set());  /* 「已指向」机器（下方 effect 真实回读 + 应用成功的乐观更新）*/
    const [pointedLoading, setPointedLoading] = useState(false); /* 指向状态回读进行中 */
    const [sel, setSel] = useState([]);
    const [res, setRes] = useState({});   /* clientId -> { st, msg } */
    /* —— 配置范围（写哪个 ini）——
       project = 工程级：写该机已发现 UE 工程的 DefaultEngine.ini [StorageServers] Shared；需先扫描到工程。
       user    = 用户全局：写 %LOCALAPPDATA%\Unreal Engine\Engine\Config\UserEngine.ini；不依赖工程扫描，
                 但需知道该机 UE 运行 Windows 用户 ue_runtime_user（取自机器 user 字段，来自 machine
                 set-ue-user；未设置时引导先配置）。 */
    const hasAnyProjects = (window.UE_PROJECTS || []).length > 0;
    const [cfgScope, setCfgScope] = useState(hasAnyProjects ? 'project' : 'user');
    const lastProjSelRef = useRef(null);   /* 上次工程级选中的工程 id（供单机重试复用）*/
    /* 切换配置范围时清掉逐机运行状态：不清的话，上一档留下的「已应用/失败」徽标和「重试」
       按钮会带着旧档的语境继续显示在新档下——重试按钮又是直接调 applyTo 读当前 cfgScope，
       不清空的话点它会用新档静默重写成另一份 ini，而界面上显示的还是旧档的失败原因。 */
    useEffect(() => { setRes({}); }, [cfgScope]);
    const clientProjects = (id) => (window.UE_PROJECTS || []).filter((p) => p.machines.includes(id));
    const runtimeUser = (n) => (n && n.user && n.user !== '—') ? n.user : null;
    /* 该机在当前范围下是否可写（工程级需有已发现工程；用户全局需有运行用户）*/
    const scopeReadyFor = (n) => cfgScope === 'project' ? clientProjects(n.id).length > 0 : !!runtimeUser(n);

    /* —— 指向状态真实回读 ——
       pointed 只活在本组件挂载周期里：切去集群总览（比如跑巡检）再切回来会整组件重挂，
       全部退回「未指向」，而机器上的 ini 其实原封没动。这里对在线客户端逐台真实回读
       [StorageServers] Shared（用户全局读 UserEngine.ini，工程级读各工程 DefaultEngine.ini，
       与 applyTo 的两条写入路径一一对应），Host 主机名/IP + 端口命中当前端点即「已指向」。
       代次令牌 + 并集合并同 cacheDdc readStatus：作废过期回读、不覆盖回读期间「应用成功」
       的乐观更新（本页没有「取消指向」操作，并集不会复活已解除项）。 */
    const pointedGenRef = useRef(0);
    const statusSig = status ? [status.endpointId, status.machineId, status.host, status.ip, status.port].join('|') : '';
    const nodesSig = (window.RENDER_NODES || []).map((n) => n.id + ':' + n.status + ':' + n.user).join(',');
    const projSig = (window.UE_PROJECTS || []).map((p) => p.id).join(',');
    useEffect(() => {
      const gen = ++pointedGenRef.current;
      if (!status) { setPointedLoading(false); return; }
      const nodes = (window.RENDER_NODES || []).filter((n) =>
        n.status !== 'offline' && n.machineId && n.machineId !== status.machineId);
      if (!nodes.length) { setPointedLoading(false); return; }
      /* 与 applyTo 的 hostUri 同源比对：Host 主机部分接受端点 hostname 或 IP，端口必须一致 */
      const serverNode = (window.RENDER_NODES || []).find((n) => n.machineId === status.machineId);
      const hostCands = [status.host, status.ip, serverNode && serverNode.host, serverNode && serverNode.ip]
        .filter(Boolean).map((x) => String(x).toLowerCase());
      const hitsServer = (keys) => (Array.isArray(keys) ? keys : []).some((k) => {
        if (!k || String(k.name || '').toLowerCase() !== 'shared') return false;
        const m = /Host\s*=\s*"([^"]+)"/i.exec(String(k.value || ''));
        if (!m) return false;
        try {
          const u = new URL(m[1]);
          return String(u.port) === String(status.port) && hostCands.includes(u.hostname.toLowerCase());
        } catch { return false; }
      });
      setPointedLoading(true);
      Promise.allSettled(nodes.map((n) => {
        const reads = [];
        const user = runtimeUser(n);
        if (user) reads.push(readIniSection(n.machineId, 'C:\\Users\\' + user + '\\AppData\\Local\\Unreal Engine\\Engine\\Config\\UserEngine.ini', 'StorageServers'));
        clientProjects(n.id).forEach((p) => {
          const loc = p.locByMachine && p.locByMachine[String(n.machineId)];
          if (loc) reads.push(readIniSection(n.machineId, loc + '\\Config\\DefaultEngine.ini', 'StorageServers'));
        });
        if (!reads.length) return Promise.resolve({ id: n.id, hit: false });
        /* 文件不存在 / 机器读不到 → rejected → 不算命中；任一份 ini 命中即已指向 */
        return Promise.allSettled(reads).then((rs) => ({
          id: n.id,
          hit: rs.some((r) => r.status === 'fulfilled' && hitsServer(r.value)),
        }));
      })).then((rs) => {
        if (gen !== pointedGenRef.current) return; /* 被更新的回读取代 / 已卸载 → 丢弃 */
        const hits = rs.filter((r) => r.status === 'fulfilled' && r.value.hit).map((r) => r.value.id);
        if (hits.length) setPointed((prev) => { const np = new Set(prev); hits.forEach((id) => np.add(id)); return np; });
        setPointedLoading(false);
      });
      return () => { pointedGenRef.current++; };
    }, [statusSig, nodesSig, projSig]);

    /* ============ ②+ 客户端本地 Zen 缓存目录（机器级环境变量 UE-ZenDataPath）============
       每台客户端上，UE 编辑器会自动拉起本地 Zen 进程做本地缓存，默认目录在 C 盘 %LOCALAPPDATA%。
       Volo 写机器级环境变量集中配置；但 UE 端存在优先级更高的配置源（编辑器内手动迁移写下的
       HKCU Zen\DataPath 注册表键）可能压过它 —— 所以同时展示「配置值」（getMachineEnvVar 读回的
       环境变量）与「实际生效值」（zen_read_local_runcontext 从该机 zenserver.runcontext 回读的
       上次实际使用路径），两者可能不一致。三个目录互不相同：①区「服务器数据目录」= 共享缓存
       本体；本功能 = 客户端本地 Zen 缓存；DDC 页「本地 DDC（文件版）」= 又一个独立目录。 */
    const [zdirs, setZdirs] = useState({});         /* nodeId -> { cfg, eff, found, regPath, loading, readFail, readErr } */
    const [zres, setZres] = useState({});           /* nodeId -> { st, msg, path } —— 逐台成败 */
    const [zdraft, setZdraft] = useState({});       /* nodeId -> 面板输入草稿 */
    const [zdirOpen, setZdirOpen] = useState(null); /* 展开配置面板的机器 id */
    const zdirGenRef = useRef(0);
    /* 单机读取：配置值（env var）+ 生效值（runcontext）并行拉。任一失败都算
       readFail——runcontext 单独失败时不能把 found=false 冒充成「编辑器从未启动过
       本地 Zen」，env var 单独失败时也不能把 cfg=null 冒充成「未设置」；面板对
       失败的那半各自如实标注（cfgFail 单独记录，配置值格显示读取失败）。 */
    const readZdirFor = (n, gen) => Promise.allSettled([
      getMachineEnvVar(n.machineId, 'UE-ZenDataPath'),
      zenReadLocalRuncontext(n.machineId),
    ]).then(([cfgR, rcR]) => {
      if (gen !== zdirGenRef.current) return;
      const rc = rcR.status === 'fulfilled' ? rcR.value : null;
      const cfgFail = cfgR.status === 'rejected';
      const rcFail = rcR.status === 'rejected';
      const errOf = (x) => (x.reason && x.reason.message ? x.reason.message : String(x.reason));
      setZdirs((d) => Object.assign({}, d, { [n.id]: {
        cfg: !cfgFail && cfgR.value ? cfgR.value : null,
        eff: rc && rc.found ? rc.data_path : null,
        found: !!(rc && rc.found),
        regPath: rc ? rc.registry_data_path : null,
        loading: false,
        cfgFail,
        readFail: cfgFail || rcFail,
        readErr: rcFail ? errOf(rcR) : cfgFail ? errOf(cfgR) : null,
      } }));
    });
    useEffect(() => {
      const gen = ++zdirGenRef.current;
      (window.RENDER_NODES || [])
        .filter((n) => n.status !== 'offline' && n.machineId && runtimeUser(n))
        .forEach((n) => { readZdirFor(n, gen); });
      return () => { zdirGenRef.current++; };
    }, [nodesSig]);

    const deployed = !!status;
    /* 仅当服务真正 running 才允许把客户端指向它——指向一台已停止/不可达/状态未知的服务器
       会让客户端缓存上游失效。stopped/unreachable/unknown 都不放行。 */
    const canPoint = deployed && status.svc === 'running';
    const RN = window.RENDER_NODES || [];
    /* 默认显示已部署的 ZenServer：先按 endpoint 真实主机名匹配，匹配不到（比如该机
       已从集群移除）再退到 roleKey==='shared'（集群里指定的共享缓存机位）；只在真
       有 endpoint（status 非空）时才生效。这是每次渲染都重新算的派生值——不会有
       「RENDER_NODES 和 status 谁先到达」的时序问题，也不会覆盖用户已经手动选过的
       机器（CX.node(srvId) 永远最先命中），同 cacheDdc.tsx 的 sharedNode 派生模式。 */
    const deployedNode = status
      ? (RN.find((n) => status.host && n.host.toLowerCase() === String(status.host).toLowerCase())
          || RN.find((n) => n.roleKey === 'shared'))
      : null;
    const srvNode = CX.node(srvId) || deployedNode || RN.find((n) => n.roleKey !== 'shared') || RN[0];

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
    const formObj = { port, protocol, dataDir, configPath, acct: acctLabel, acctKind };
    /* 机器列表按主机名自然排序：数字小的在前、大的在后（RNODE-07 不再落到 WS-ART-01 之后）*/
    const srvOpts = RN.slice()
      .sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }))
      .map((n) => ({ id: n.id, label: n.host, sub: n.ip }));
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

    /* —— 本地 Zen 缓存目录：状态派生 + 动作 —— */
    const ZEN_DEF_HINT = '%LOCALAPPDATA%\\UnrealEngine\\Common\\Zen\\Data';
    /* runcontext 的 DataPath 是正斜杠（D:/…），env var 是反斜杠——比较前归一化 */
    const normWinPath = (p) => String(p || '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    const zenRecOf = (d, id) => d[id] || { cfg: null, eff: null, loading: true };
    const zenRec = (id) => zenRecOf(zdirs, id);
    const zenSt = (n) => {
      if (n.status === 'offline' || !runtimeUser(n)) return 'blocked';
      const r = zenRec(n.id);
      if (r.loading) return 'loading';
      if (r.readFail) return 'readfail';
      if (!r.cfg) return 'unset';
      if (!r.found) return 'mismatch';   /* 已配置但该机编辑器从未启动过本地 Zen —— 尚未生效 */
      return normWinPath(r.eff) === normWinPath(r.cfg) ? 'match' : 'mismatch';
    };
    const ZDIR_META = {
      unset:    { vis: 'neutral',     icon: 'folder', label: '默认 C 盘' },
      match:    { vis: 'positive',    icon: 'check',  label: '已生效' },
      mismatch: { vis: 'notice',      icon: 'alert',  label: '未生效' },
      loading:  { vis: 'informative', icon: 'sync',   label: '读取中' },
      blocked:  { vis: 'neutral',     icon: 'minus',  label: '不可读' },
      readfail: { vis: 'negative',    icon: 'alert',  label: '读取失败' },
    };
    const zenMismatchWhy = (rec) => {
      if (rec.regPath && normWinPath(rec.regPath) !== normWinPath(rec.cfg))
        return '该机在编辑器内手动迁移过缓存，注册表配置（' + rec.regPath + '）优先级更高，压过了环境变量 —— 生效目录以注册表为准';
      if (!rec.found)
        return '已写入环境变量，但该机编辑器还没启动过本地 Zen —— 下次启动 UE 编辑器时生效';
      return '已写入环境变量，但尚未重启该机 UE 编辑器 —— 生效值仍是旧目录';
    };
    /* 应用：逐台执行、逐台成败（与「指向此服务器」的行内模式一致）。写的是机器级
       环境变量（HKLM），但前置仍要求 ue_runtime_user——没有它读不了生效值，写下去
       也验证不了，与面板 blocked 拦截保持同一条件；被拦的逐台引导而非静默跳过。 */
    const applyZenDir = (ids, path) => {
      ids.forEach((id) => {
        const n = CX.node(id);
        if (!n || n.status === 'offline') return;
        if (!runtimeUser(n)) {
          setZres((r) => Object.assign({}, r, { [id]: { st: 'fail', msg: '该机未设置 UE 运行用户，无法回读生效值 · 先配置 ue_runtime_user（machine set-ue-user）', path } }));
          log(s, 'warn', `<b>set_machine_env_var</b> · ${esc(n.host)} 未设 ue_runtime_user，本地 Zen 目录写入跳过`);
          return;
        }
        setZres((r) => Object.assign({}, r, { [id]: { st: 'running' } }));
        setMachineEnvVar(n.machineId, 'UE-ZenDataPath', path).then(
          () => {
            /* setx-machine.ps1 写后回读校验过，cfg=path 是已验证事实；eff 要等编辑器重启 */
            setZdirs((d) => Object.assign({}, d, { [id]: Object.assign({}, zenRecOf(d, id), { cfg: path, loading: false, readFail: false, readErr: null }) }));
            setZres((r) => Object.assign({}, r, { [id]: { st: 'ok', msg: '已写入 · 重启该机 UE 编辑器后生效；旧缓存不会自动迁移', path } }));
            log(s, 'ok', `<b>set_machine_env_var</b> · ${esc(n.host)} UE-ZenDataPath = ${esc(path)}`);
          },
          (e) => {
            const em = e && e.message ? e.message : String(e);
            setZres((r) => Object.assign({}, r, { [id]: { st: 'fail', msg: em, path } }));
            log(s, 'err', `<b>set_machine_env_var</b> · ${esc(n.host)} UE-ZenDataPath 写入失败 · ${esc(em)}`);
          });
      });
    };
    /* 清除配置：写空值 = 删除该机器级变量（setx-machine.ps1 对 Value="" 的删除语义已验证）*/
    const clearZenDir = (id) => {
      const n = CX.node(id);
      if (!n) return;
      setZres((r) => Object.assign({}, r, { [id]: { st: 'running' } }));
      setMachineEnvVar(n.machineId, 'UE-ZenDataPath', '').then(
        () => {
          setZdirs((d) => Object.assign({}, d, { [id]: Object.assign({}, zenRecOf(d, id), { cfg: null, loading: false }) }));
          setZres((r) => Object.assign({}, r, { [id]: { st: 'ok', msg: '已清除配置 · 重启该机 UE 编辑器后回到默认目录（' + ZEN_DEF_HINT + '）；旧缓存不会自动迁移' } }));
          log(s, 'warn', `<b>set_machine_env_var</b> · ${esc(n.host)} 清除 UE-ZenDataPath（还原默认）`);
        },
        (e) => {
          const em = e && e.message ? e.message : String(e);
          setZres((r) => Object.assign({}, r, { [id]: { st: 'fail', msg: em } }));
          log(s, 'err', `<b>set_machine_env_var</b> · ${esc(n.host)} 清除 UE-ZenDataPath 失败 · ${esc(em)}`);
        });
    };
    const rereadZenDir = (id) => {
      const n = CX.node(id);
      if (!n) return;
      setZres((r) => { const x = Object.assign({}, r); delete x[id]; return x; });
      setZdirs((d) => Object.assign({}, d, { [id]: Object.assign({}, zenRecOf(d, id), { loading: true, readFail: false, readErr: null }) }));
      log(s, 'info', `<b>zen_read_local_runcontext</b> · ${esc(n.host)} 回读 zenserver.runcontext`);
      readZdirFor(n, zdirGenRef.current);
    };
    const openZenDirModal = (ids) => {
      const machinesArg = ids.map((id) => CX.node(id)).filter((n) => n && n.status !== 'offline');
      if (!machinesArg.length) return;
      s.setModal({
        wide: true,
        render: ({ close }) => h(ZenDirModal, {
          machines: machinesArg, recOf: (id) => zenRec(id),
          onConfirm: (path) => applyZenDir(machinesArg.map((m) => m.id), path),
          close,
        }),
      });
    };

    const toggleSel = (n) => { if (n.status === 'offline') return; setSel((v) => v.includes(n.id) ? v.filter((x) => x !== n.id) : v.concat(n.id)); };
    const onlineSel = sel.filter((id) => { const n = CX.node(id); return n && n.status !== 'offline'; });
    const selectableUnpointed = clients.filter((n) => n.status !== 'offline' && !pointed.has(n.id));
    const allUnpointedSelected = selectableUnpointed.length > 0 && selectableUnpointed.every((n) => sel.includes(n.id));
    const toggleSelectUnpointed = () => {
      if (allUnpointedSelected) setSel((v) => v.filter((id) => !selectableUnpointed.some((n) => n.id === id)));
      else setSel((v) => Array.from(new Set(v.concat(selectableUnpointed.map((n) => n.id)))));
    };

    /* 当前范围下，选中的在线机器中需先引导的有多少台（信息性提示，不拦按钮）*/
    const selBlocked = onlineSel.filter((id) => !scopeReadyFor(CX.node(id)));

    /* 逐机真实写配置：部分失败是常态。projIds 仅工程级使用——限定只写入这些选中的 UE
       工程（二级菜单选择的结果），缺省 = 该机所有已发现工程。 */
    const applyTo = (ids, projIds) => {
      if (!status) return;
      const host = status.host || (srvNode && srvNode.host) || '';
      const scheme = status.scheme || protocol || 'http';
      const hostUri = scheme + '://' + host + ':' + status.port;
      /* UE [StorageServers] Shared 的值必须是结构化条目：Host 为完整 URI（含端口），
         附 Namespace / 环境与命令行覆盖键 / DeactivateAt——单写 Host=..;Port=.. UE 不识别。 */
      const value = '(Host="' + hostUri + '", Namespace="ue.ddc", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)';
      ids.filter((id) => { const n = CX.node(id); return n && n.status !== 'offline'; }).forEach((id) => {
        const n = CX.node(id);
        setRes((r) => Object.assign({}, r, { [id]: { st: 'running' } }));
        if (cfgScope === 'project') {
          let ps = clientProjects(id);
          if (projIds) ps = ps.filter((p) => projIds.includes(p.id));
          if (!ps.length) {
            const noAny = clientProjects(id).length === 0;
            setRes((r) => Object.assign({}, r, { [id]: { st: 'fail', msg: noAny ? '该机未发现 UE 工程 · 先去集群总览发现工程后重试' : '本机无所选工程 · 本次跳过' } }));
            log(s, 'warn', `<b>set_ini_key</b> · ${esc(n.host)} 无所选工程，工程级写入跳过`);
            return;
          }
          /* allSettled，不用 all——每个 setIniKey 是独立的远程写、互不回滚；all 遇到某个
             工程失败会整体 reject，把已成功落盘的其它工程也一并汇报成「失败」，UI 与磁盘
             实际状态就对不上了。这里逐个工程收集结果，部分失败时列出到底哪几个成功/失败。 */
          Promise.allSettled(ps.map((p) => setIniKey(n.machineId, p.locByMachine[String(n.machineId)] + '\\Config\\DefaultEngine.ini', 'StorageServers', 'Shared', value))).then(
            (results) => {
              const failed = ps.map((p, i) => ({ p, err: results[i] })).filter((x) => x.err.status === 'rejected');
              if (!failed.length) {
                const okMsg = '已写 ' + ps.length + ' 个工程 DefaultEngine.ini（' + ps.map((p) => p.name).join('、') + '）→ ' + hostUri;
                setRes((r) => Object.assign({}, r, { [id]: { st: 'ok', msg: okMsg } }));
                setPointed((p) => { const np = new Set(p); np.add(id); return np; });
                log(s, 'ok', `<b>set_ini_key</b> · ${esc(n.host)} DefaultEngine.ini ×${ps.length} → ${esc(hostUri)}`);
                return;
              }
              const okCount = ps.length - failed.length;
              const firstErr = failed[0].err.reason;
              const em = firstErr && firstErr.message ? firstErr.message : String(firstErr);
              const msg = okCount
                ? okCount + '/' + ps.length + ' 个工程已写入，' + failed.length + ' 个失败（' + failed.map((x) => x.p.name).join('、') + '）· ' + em
                : em;
              setRes((r) => Object.assign({}, r, { [id]: { st: 'fail', msg } }));
              log(s, 'err', `<b>set_ini_key</b> · ${esc(n.host)} 写 [StorageServers] Shared 失败（${failed.length}/${ps.length} 个工程）`);
            });
          return;
        }
        if (!runtimeUser(n)) {
          setRes((r) => Object.assign({}, r, { [id]: { st: 'fail', msg: '该机未设置 UE 运行用户 · 先配置 ue_runtime_user（machine set-ue-user）' } }));
          log(s, 'warn', `<b>zen_enable_global</b> · ${esc(n.host)} 未设 ue_runtime_user，用户全局写入跳过`);
          return;
        }
        zenEnableGlobal(n.machineId, status.endpointId).then(
          (out) => {
            const okMsg = 'UserEngine.ini（用户 ' + runtimeUser(n) + '）→ ' + hostUri;
            setRes((r) => Object.assign({}, r, { [id]: { st: 'ok', msg: okMsg } }));
            setPointed((p) => { const np = new Set(p); np.add(id); return np; });
            log(s, 'ok', `<b>zen_enable_global</b> · ${esc(n.host)} ${esc(out.ini_file)} → ${esc(hostUri)}`);
          },
          (e) => {
            const em = e && e.message ? e.message : String(e);
            setRes((r) => Object.assign({}, r, { [id]: { st: 'fail', msg: em } }));
            log(s, 'err', `<b>zen_enable_global</b> · ${esc(n.host)} 写 UserEngine.ini 失败`);
          });
      });
    };

    /* 直接执行（用户全局）：不弹二级菜单，按下即跑命令，进展看各机行内状态 + 控制台 */
    const runApply = (ids) => {
      const online = ids.filter((id) => { const n = CX.node(id); return n && n.status !== 'offline'; });
      if (online.length) applyTo(online);
    };

    /* 工程级：弹出居中二级菜单，列出 UE 工程供选择，确认后再指向。默认全选（preselect
       不传 lastProjSelRef——那是单机重试专用的「复用上次选择」，选中机器集合变化时
       用它预选会与新集合取交集，可能把新出现的相关工程漏选而不自知）。 */
    const openProjectPicker = (ids) => {
      const online = ids.filter((id) => { const n = CX.node(id); return n && n.status !== 'offline'; });
      if (!online.length || !status) return;
      const machinesArg = online.map((id) => CX.node(id));
      const host = status.host || srvNode.host;
      s.setModal({
        wide: true,
        render: ({ close }) => h(ProjPointModal, {
          machines: machinesArg, host, port: status.port,
          preselect: null,
          onConfirm: (pIds) => { lastProjSelRef.current = pIds; applyTo(online, pIds); },
          close,
        }),
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

    /* 地址栏 + 悬停浮现的「打开文件夹」按钮：真实在本机文件资源管理器中打开该路径（revealPath，
       同 USB 导出抽屉「在文件夹中显示」）。这三个路径描述的是部署目标机器（srvNode，常是远程
       渲染节点）上的目录——只有部署目标恰好是本机时才会打开真实目录，跨机器时是已知限制。 */
    const openPath = (p) => { revealPath(p).catch(() => {}); };
    const pathInput = (val, onChange) => h('div', { className: 'dp-path' },
      h('input', { className: 'dp-input mono', value: val, spellCheck: false, onChange }),
      h('button', { type: 'button', className: 'dp-path-open', title: '在文件资源管理器中打开该目录', tabIndex: -1, onClick: () => openPath(val) },
        h(Icon, { name: 'folder', size: 13 })));

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
          pathInput(installDir, (e) => setInstallDir(e.target.value))),
        h('div', { className: 'dp-field grow' }, h('label', null, '数据目录 · data-dir'),
          pathInput(dataDir, (e) => setDataDir(e.target.value))),
        h('div', { className: 'dp-field grow' },
          h('label', null, '配置文件落地路径',
            configOverride == null
              ? h('span', { className: 'dp-hint' }, '跟随安装目录')
              : h('button', { type: 'button', className: 'dp-hint dp-hint-btn', onClick: () => setConfigOverride(null) }, '恢复跟随安装目录')),
          pathInput(configPath, (e) => setConfigOverride(e.target.value))),
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
    /* 配置范围选择器：工程级 / 用户全局；目标路径 / 前置说明 / 底部安全说明随选项切换 */
    const SCOPE_OPTS = [
      { id: 'project', label: '工程级', sub: '写工程 DefaultEngine.ini', disabled: !hasAnyProjects },
      { id: 'user', label: '用户全局', sub: '写 UserEngine.ini' },
    ];
    const scopeBlock = h('div', { className: 'zscope' },
      h('div', { className: 'zscope-head' },
        h('span', { className: 'zscope-h-lbl' }, '配置范围'),
        h('span', { className: 'zscope-h-sub' }, '决定把指向写进哪一份 UE 配置 · 每台机器独立应用')),
      h('div', { className: 'zscope-seg' },
        SCOPE_OPTS.map((o) => h('button', {
          key: o.id, type: 'button',
          className: 'zscope-opt' + (cfgScope === o.id ? ' on' : '') + (o.disabled ? ' dis' : ''),
          disabled: o.disabled, title: o.disabled ? '未扫描到 UE 工程，先去集群总览发现工程' : undefined,
          onClick: () => { if (!o.disabled) setCfgScope(o.id); },
        },
          h('span', { className: 'zscope-lbl' }, o.label),
          h('span', { className: 'zscope-sub' }, o.sub)))),
      cfgScope === 'project'
        ? h('div', { className: 'zscope-detail' },
            h('div', { className: 'zscope-path mono' }, h(Icon, { name: 'film', size: 12 }), '{工程根}\\Config\\DefaultEngine.ini  →  [StorageServers] Shared'),
            h('div', { className: 'zscope-tx' }, '逐台写入该机已发现的 UE 工程；只对这些工程生效，需先扫描到工程。'))
        : h('div', { className: 'zscope-detail' },
            h('div', { className: 'zscope-path mono' }, h(Icon, { name: 'doc', size: 12 }), '%LOCALAPPDATA%\\Unreal Engine\\Engine\\Config\\UserEngine.ini  →  [StorageServers] Shared'),
            h('div', { className: 'zscope-tx' }, '写入该机 UE 运行用户（ue_runtime_user）的全局配置，对该用户下所有工程生效，不依赖工程扫描。')),
      /* 不按 cfgScope 门控——全集群零工程时「工程级」选项本身被禁用，用户切不到那一档，
         这条提示得在「用户全局」档下也看得见，否则「工程级」永远打不开、这条 hint 是死代码。 */
      !hasAnyProjects
        ? h('div', { className: 'cli-note warn' }, h(Icon, { name: 'alert', size: 13 }),
            h('span', null, '未扫描到 UE 工程 · '),
            h('button', { type: 'button', className: 'zscope-link', onClick: () => s.setCacheNav('home') }, '去集群总览发现工程'))
        : null,
      selBlocked.length
        ? h('div', { className: 'cli-note warn' }, h(Icon, { name: 'alert', size: 13 }),
            cfgScope === 'project'
              ? selBlocked.length + ' 台选中机器未发现工程，将被跳过 · 先去集群总览发现工程'
              : selBlocked.length + ' 台选中机器未设置 ue_runtime_user，将被跳过 · 先配置运行用户')
        : null);

    const clientBadge = (n) => {
      const r = res[n.id];
      if (r) {
        const m = RUN_STATE[r.st];
        return h('div', { className: 'zcli-right' },
          h(ZBadge, { vis: m.vis, icon: m.icon, label: r.st === 'running' ? '应用中' : r.st === 'ok' ? '已应用' : '失败', soft: true }),
          r.msg ? h('span', { className: 'zcli-msg s-' + m.vis }, r.msg) : null,
          r.st === 'fail' ? h('button', { className: 'mini-btn', onClick: () => applyTo([n.id], cfgScope === 'project' ? lastProjSelRef.current : null) }, h(Icon, { name: 'restart', size: 12 }), '重试') : null);
      }
      if (n.status === 'offline') return h(ZBadge, { vis: 'neutral', icon: 'power', label: '离线 · 跳过' });
      if (pointed.has(n.id)) return h(ZBadge, { vis: 'positive', icon: 'check', label: '已指向此服务器', soft: true });
      if (pointedLoading) return h(ZBadge, { vis: 'neutral', icon: 'sync', label: '读取指向状态…', soft: true });
      return h(ZBadge, { vis: 'notice', icon: 'minus', label: '未指向', soft: true });
    };
    /* 行内次级徽标：本地 Zen 缓存目录状态（指向是主状态，此为次级信息）· 点击展开配置 */
    const zdirChip = (n) => {
      const st = zenSt(n);
      const r = zres[n.id];
      const open = zdirOpen === n.id;
      let vis, icon, label, spinning = false;
      if (r && r.st === 'running') { vis = 'informative'; icon = 'sync'; label = 'Zen 目录 · 应用中'; spinning = true; }
      else if (r && r.st === 'fail') { vis = 'negative'; icon = 'alert'; label = 'Zen 目录 · 写入失败'; }
      else if (r && r.st === 'ok' && st === 'mismatch') { vis = 'notice'; icon = 'alert'; label = 'Zen 目录 · 待重启生效'; }
      else { const m = ZDIR_META[st]; vis = m.vis; icon = m.icon; label = 'Zen 目录 · ' + m.label; spinning = st === 'loading'; }
      return h('button', { className: 'zdir-chip zd-' + vis + (open ? ' on' : '') + (st === 'blocked' ? ' soft' : ''),
        title: '客户端本地 Zen 缓存目录（UE-ZenDataPath）· 点击展开配置', onClick: () => setZdirOpen(open ? null : n.id) },
        spinning ? h('span', { className: 'spin', style: { display: 'inline-flex' } }, h(Icon, { name: 'sync', size: 11 })) : h(Icon, { name: icon, size: 11 }),
        label,
        h(Icon, { name: 'chevd', size: 10, style: { transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .13s' } }));
    };
    /* 行内展开：配置值 vs 实际生效值 + 单机应用 / 清除 / 重新读取 */
    const zdirPanel = (n) => {
      const rec = zenRec(n.id);
      const st = zenSt(n);
      const m = ZDIR_META[st];
      const blocked = st === 'blocked';
      const draft = zdraft[n.id] != null ? zdraft[n.id] : (rec.cfg || 'D:\\UE_DDC\\Zen');
      const valid = /^[A-Za-z]:\\/.test(draft.trim());
      const r = zres[n.id];
      const rm = r ? RUN_STATE[r.st] : null;
      const effCell = blocked
        ? h('span', { className: 'v none' }, '无法读取')
        : st === 'loading'
          ? h('span', { className: 'v loading' }, h('span', { className: 'spin', style: { display: 'inline-flex' } }, h(Icon, { name: 'sync', size: 11 })), '正在从该机回读…')
          : st === 'readfail'
            ? h('span', { className: 'v none' }, '回读失败' + (rec.readErr ? ' · ' + rec.readErr : ''))
            : rec.found
              ? h('span', { className: 'v mono' }, rec.eff || '—')
              : h('span', { className: 'v none' }, '尚无记录 · 该机编辑器从未启动过本地 Zen');
      return h('div', { className: 'zdir-panel' },
        h('div', { className: 'zdir-h' },
          h(Icon, { name: 'folder', size: 13 }),
          h('span', { className: 't' }, '客户端本地 Zen 缓存目录'),
          h('code', { className: 'zdir-env' }, 'UE-ZenDataPath'),
          h(ZBadge, { vis: m.vis, icon: st === 'loading' ? 'sync' : m.icon, soft: true,
            label: st === 'unset' ? '未配置 · 走默认 C 盘' : st === 'match' ? '已配置 · 生效一致' : st === 'mismatch' ? '已配置 · 未生效' : st === 'loading' ? '生效值读取中' : st === 'readfail' ? '回读失败' : '离线 / 未设运行用户' })),
        h('div', { className: 'zdir-intro' },
          '该机 UE 编辑器会自动拉起一个本地 Zen 进程做本地缓存，默认目录在系统盘用户目录，项目大了会塞满 C 盘。注意区分：①区「服务器数据目录」是共享缓存本体，DDC 页「本地 DDC（文件版）」是又一个目录 —— 三者互不相同。'),
        blocked ? h('div', { className: 'cli-note warn' }, h(Icon, { name: 'alert', size: 13 }),
          n.status === 'offline'
            ? '机器离线，读不了生效值，也无法远程写入 · 恢复在线后再配置'
            : '该机未设置 UE 运行用户，读不了生效值 · 与「用户全局指向」同一前置条件：先配置 ue_runtime_user（machine set-ue-user）') : null,
        h('div', { className: 'zdir-kv' },
          h('span', { className: 'k' }, '配置值 · 环境变量'),
          h('span', { className: 'v' + (rec.cfg ? ' mono' : ' none') },
            rec.cfg || (rec.cfgFail ? '读取失败' : '未设置 · 默认 ' + ZEN_DEF_HINT)),
          h('span', null)),
        h('div', { className: 'zdir-kv' },
          h('span', { className: 'k' }, '实际生效值 · runcontext'),
          effCell,
          !blocked ? h('button', { className: 'mini-btn', disabled: st === 'loading', onClick: () => rereadZenDir(n.id) }, h(Icon, { name: 'sync', size: 12 }), '重新读取') : null),
        st === 'mismatch' ? h('div', { className: 'zdir-why' }, h(Icon, { name: 'alert', size: 12 }), zenMismatchWhy(rec)) : null,
        !blocked ? h('div', { className: 'zdir-form' },
          h('input', { className: 'dp-input mono', value: draft, spellCheck: false, placeholder: '如 D:\\UE_DDC\\Zen',
            onChange: (e) => setZdraft((v) => Object.assign({}, v, { [n.id]: e.target.value })) }),
          h('button', { className: 'mini-btn accent', disabled: !valid || (r && r.st === 'running'), onClick: () => applyZenDir([n.id], draft.trim()) }, h(Icon, { name: 'check', size: 12 }), '应用'),
          h('button', { className: 'mini-btn danger', disabled: !rec.cfg || (r && r.st === 'running'), onClick: () => clearZenDir(n.id) }, h(Icon, { name: 'trash', size: 12 }), '清除配置（还原默认）')) : null,
        !blocked && !valid ? h('div', { className: 'zdir-err' }, h(Icon, { name: 'alert', size: 12 }), '请输入 Windows 绝对路径（如 D:\\UE_DDC\\Zen）') : null,
        r ? h('div', { className: 'zdir-res' },
          h(ZBadge, { vis: rm.vis, icon: rm.icon, label: r.st === 'running' ? '应用中' : r.st === 'ok' ? '成功' : '失败', soft: true }),
          r.msg ? h('span', { className: 'zdir-res-msg s-' + rm.vis }, r.msg) : null,
          r.st === 'fail' ? h('button', { className: 'mini-btn', onClick: () => applyZenDir([n.id], (r.path || draft).trim()) }, h(Icon, { name: 'restart', size: 12 }), '重试') : null) : null);
    };
    const clientRow = (n) => {
      const off = n.status === 'offline';
      const checked = sel.includes(n.id);
      const stMeta = NODE_STATUS[n.status] || NODE_STATUS.na;
      return h('div', { key: n.id, className: 'zcli-wrap' + (zdirOpen === n.id ? ' open' : '') },
        h('div', { className: 'cli-row zcli' + (off ? ' off' : '') + (checked ? ' on' : '') },
          h('button', { className: 'zck' + (checked ? ' on' : '') + (off ? ' dis' : ''), onClick: () => toggleSel(n), disabled: off, title: off ? '离线机器不可选' : '选择' },
            checked ? h(Icon, { name: 'check', size: 12 }) : null),
          h('span', { className: 'zcli-state' }, CX.dot(stMeta.visual),
            h('span', { className: 'zcli-state-tx s-' + stMeta.visual }, off ? '离线' : '在线')),
          h('div', { className: 'cli-meta' },
            h('div', { className: 'cli-host mono' }, n.host),
            h('div', { className: 'cli-sub' }, n.ip + ' · ' + n.role)),
          h('div', { className: 'zcli-end' }, zdirChip(n), clientBadge(n))),
        zdirOpen === n.id ? zdirPanel(n) : null);
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
              h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'folder', size: 14 }), isDisabled: onlineSel.length === 0,
                onPress: () => openZenDirModal(onlineSel) },
                onlineSel.length ? '设置缓存目录（' + onlineSel.length + '）' : '设置缓存目录'),
              h(Button, {
                variant: 'accent', size: 'M', icon: h(Icon, { name: 'link', size: 14 }), isDisabled: onlineSel.length === 0 || !canPoint,
                onPress: () => { if (cfgScope === 'project') openProjectPicker(onlineSel); else runApply(onlineSel); },
              },
                onlineSel.length ? '指向此服务器（' + onlineSel.length + '）' : '指向此服务器'))),
          deployed ? scopeBlock : null,
          !deployed
            ? h('div', { className: 'cli-note warn' }, h(Icon, { name: 'alert', size: 13 }), '尚未部署服务器，先在上方①部署一台，再把客户端指向它。')
            : !canPoint
              ? h('div', { className: 'cli-note warn' }, h(Icon, { name: 'alert', size: 13 }), '服务器已部署但当前未在运行（' + sMeta.label + '）—— 先在上方①启动 / 探活确认运行中，再指向客户端。')
              : null,
          h('div', { className: 'cli-note' }, h(Icon, { name: 'shield', size: 13 }),
            cfgScope === 'project'
              ? '应用 = 逐台改这些机器已发现工程的 DefaultEngine.ini（写 [StorageServers] Shared，非旧版 [InstalledDerivedDataBackendGraph]）指向上方服务器；远程操作走 SSH key，逐台执行、逐台看成败。'
              : '应用 = 逐台改这些机器 UE 运行用户的 UserEngine.ini（写 [StorageServers] Shared）指向上方服务器；远程操作走 SSH key，逐台执行、逐台看成败。'),
          h('div', { className: 'cli-list' }, clients.map(clientRow)))))));
  }

  window.VOLO_CACHE_ZEN = { view: (s) => h(ZenServer, { s }) };
})();

export {};
