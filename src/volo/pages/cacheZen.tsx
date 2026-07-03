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
   ②+ 客户端本地 Zen 缓存目录：zen_set_local_datapath 写 UE 运行用户的 HKCU
      Epic Games\Zen\DataPath 注册表（编辑器每次启动直接读，重启编辑器即生效）＋创建目录
      ＋同步机器级 UE-ZenDataPath 环境变量兜底；生效值真实回读（zen_read_local_runcontext
      读该机 zenserver.runcontext）——配置值与生效值分开展示、不冒充。旧版只写机器级
      环境变量：SSH（session 0）写入后 WM_SETTINGCHANGE 广播跨不了会话，桌面会话里的
      Explorer / Epic Launcher 环境块不刷新，重启编辑器也读不到，注销/重启系统才生效
      ——这正是换注册表通道的原因。
   远程操作走 SSH key（cred = {} 全 None），不逐操作选凭据；真实回读来自 zen_probe。

   一级 Dashboard 的三张卡（服务器状态 / 回收策略 / 客户端指向）各自的具体配置收进二级
   xwide 弹层（DeployModal / GcModal / ClientModal）。这三个弹层都是独立的、拥有自己
   useState 的组件（与 ZenDirModal / ProjPointModal 同一模式）——而不是把已求值好的 JSX
   树塞进 `s.setModal({ render: () => <冻结的 VDOM> })`：那样 render 回调虽然会被
   ModalLayer 反复调用，但闭包捕获的表单字段/勾选状态是 ZenServer 某一次 render 的快照，
   之后 ZenServer 本地 state 再怎么变都不会回填到已经存进 s.modal 的这份闭包里——弹层内
   任何输入框/勾选框会看起来完全没反应（受控 input 每次按键后被 React 纠正回旧值）。
   拆成独立组件后，表单交互复用组件自己的 state，在 ModalLayer 反复调用同一个（其余不变）
   render 闭包时通过 React 的按类型/位置调和被保留、更新，而不是每次都是一棵新鲜出炉的死树。 */
import * as React from "react";
import "../ds";
import "./cache";
import {
  zenRegister, zenDetectBinary, zenApplyConfig, zenUpdateGcSettings, zenCreateDedicatedAccount,
  zenUrlaclAdd, zenServiceInstall, zenServiceStart, zenServiceStop, zenServiceUninstall,
  zenUnregister, zenProbe, zenStatus, zenListEndpoints, zenCacheStats, zenDiskSpace, setIniKey, readIniSection,
  refreshMachine, revealPath, zenEnableGlobal, zenReadLocalRuncontext, zenSetLocalDatapath, getMachineEnvVar,
  zenLocalPortSet, zenLocalPortClear, zenLocalPortStatus,
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
  /* 一级 Dashboard · 缓存回收策略卡的 kv 列表用：{value,unit} → "8 小时" */
  const UNIT_LABEL = { minutes: '分钟', hours: '小时', days: '天' };
  const fmtGc = (f) => f.value + ' ' + UNIT_LABEL[f.unit];

  /* 跨子页导航快照（per-mount ref）：切走再切回时先用上次数据即时绘帧，后台静默刷新。
     主要避免 pointed 回读（逐台 SSH 读 INI）在每次重挂时阻塞首帧。keep-alive 下通常不 remount；
     ref 按实例隔离，避免多挂载时模块级变量串台。 */
  /* 三通道徽标：颜色 + 图标 + 文字 */
  function ZBadge({ vis, icon, label, soft }) {
    return h('span', { className: 'zbadge zb-' + vis + (soft ? ' soft' : '') },
      icon ? h(Icon, { name: icon, size: 12 }) : h('span', { className: 'zb-dash' }, '—'), label);
  }

  /* clientProjects/runtimeUser 是纯函数（只读 window.UE_PROJECTS / 机器对象），ZenServer
     的指向回读 effect 与 ClientModal 的配置范围逻辑都要用，提到模块级避免两份实现分叉。 */
  const clientProjects = (id) => (window.UE_PROJECTS || []).filter((p) => p.machines.includes(id));
  const runtimeUser = (n) => (n && n.user && n.user !== '—') ? n.user : null;
  /* 本地 Zen 缓存目录：默认目录提示 + 路径归一比较。zdirs 状态已提升到 ZenServer
     （一级 Dashboard「已指向机器」明细也要显示各机缓存目录），这两个纯 helper 随之提到模块级。 */
  const ZEN_DEF_HINT = '%LOCALAPPDATA%\\UnrealEngine\\Common\\Zen\\Data';
  const normWinPath = (p) => String(p || '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const zenRecOf = (d, id) => d[id] || { cfg: null, eff: null, loading: true };
  /* 本地 Zen 端口：客户端本机 UE Editor 自动拉起的本地 Zen 的监听端口，默认 8558；同机
     既跑共享 ZenServer 又开 Editor 时冲突，改 [Zen.AutoLaunch] DesiredPort 挪走本地 Zen。
     zports 记录来自 zen_local_port_status 真实回读：configured=INI 配置值（null=默认 8558）、
     actual=runcontext 命令行里的 --port（Editor 重启前可能滞后）、running=本地 Zen 是否在跑。 */
  const ZEN_LOCAL_DEFAULT_PORT = 8558;
  const ZEN_SUGGEST_PORT = 8559;
  const zportRecOf = (d, id) => d[id] || { configured: null, actual: null, running: null, loading: true, fail: false };

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

  /* 三级页面：客户端本地 Zen 缓存目录的集中管理 —— 机器多选（全选/取消全选）→ 统一目录应用到
     选中 / 一键清除选中配置。二级列表不再逐台展开配置，全部目录操作集中收进这里。 */
  function ZenDirModal({ machines, recOf, onApply, onClear, close }) {
    const [path, setPath] = useState('D:\\UE_DDC\\Zen');
    const [selIds, setSelIds] = useState(machines.map((m) => m.id));
    const valid = /^[A-Za-z]:\\/.test(path.trim());
    const selN = selIds.length;
    const allSel = selN === machines.length && selN > 0;
    const toggle = (id) => setSelIds((v) => v.includes(id) ? v.filter((x) => x !== id) : v.concat(id));
    const toggleAll = () => setSelIds(allSel ? [] : machines.map((m) => m.id));
    const clearableSel = machines.filter((m) => selIds.includes(m.id) && recOf(m.id).cfg).map((m) => m.id);
    const applyNow = () => { if (!valid || !selN) return; close(); onApply(selIds.slice(), path.trim()); };
    const clearNow = () => { if (!clearableSel.length) return; close(); onClear(clearableSel.slice()); };
    return h('div', { className: 'drawer drawer--preview' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: 'folder', size: 17 })),
        h('div', { style: { minWidth: 0 } },
          h('h2', null, '客户端本地 Zen 缓存目录'),
          h('div', { className: 'sub' },
            h('span', { className: 'cli-pill' }, 'zen_set_local_datapath'),
            h('span', null, ' · 注册表 + 创建目录 · ' + machines.length + ' 台在线客户端'))),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, '1'), '目标机器',
            h('button', { type: 'button', className: 'zdm-selall', onClick: toggleAll }, allSel ? '取消全选' : '全选', h('span', { className: 'zdm-selct' }, selN + ' / ' + machines.length))),
          h('div', { className: 'zdm-list' }, machines.map((n) => {
            const rec = recOf(n.id);
            const on = selIds.includes(n.id);
            const stMeta = NODE_STATUS[n.status] || NODE_STATUS.na;
            return h('div', { key: n.id, className: 'zdm-row pick' + (on ? ' on' : ''), onClick: () => toggle(n.id) },
              h('span', { className: 'zck' + (on ? ' on' : '') }, on ? h(Icon, { name: 'check', size: 12 }) : null),
              h('span', { className: 'zdm-host' }, CX.dot(stMeta.visual), n.host),
              h('span', { className: 'zdm-cur' + (rec.cfg ? '' : ' none') }, rec.cfg ? ('当前 ' + rec.cfg) : (rec.loading ? '当前配置读取中…' : '当前未配置 · 走默认 C 盘')));
          }))),
        h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, '2'), '统一目录（Windows 绝对路径）'),
          h('div', { className: 'zdir-form' },
            h('input', { className: 'dp-input mono', value: path, autoFocus: true, spellCheck: false, placeholder: '如 D:\\UE_DDC\\Zen', onChange: (e) => setPath(e.target.value) }),
            h('button', { className: 'mini-btn accent', disabled: !valid || !selN, onClick: applyNow }, h(Icon, { name: 'check', size: 12 }), '应用到选中（' + selN + '）')),
          !valid ? h('div', { className: 'zdir-err', style: { marginTop: 6 } }, h(Icon, { name: 'alert', size: 12 }), '请输入 Windows 绝对路径（如 D:\\UE_DDC\\Zen）') : null,
          h('div', { className: 'zdir-intro', style: { marginTop: 6 } }, '渲染农场通常同盘符布局，一个路径可直接应用到所有选中机器。')),
        h('div', { className: 'dblock' },
          h('div', { className: 'dblock-h' }, h('span', { className: 'no' }, '3'), '清除配置（还原默认 C 盘）'),
          h('div', { className: 'zdm-clear-row' },
            h('div', { className: 'zdm-clear-tx' }, clearableSel.length ? ('选中机器中有 ' + clearableSel.length + ' 台已配置自定义目录，可一键清除还原默认。') : '选中机器均未配置自定义目录，无需清除。'),
            h('button', { className: 'mini-btn danger', disabled: !clearableSel.length, onClick: clearNow }, h(Icon, { name: 'trash', size: 12 }), '清除选中配置（' + clearableSel.length + '）'))),
        h('div', { className: 'cli-note' }, h(Icon, { name: 'shield', size: 13 }),
          '逐台写各机 UE 运行用户的注册表 Zen\\DataPath 并创建目录（同步机器级 UE-ZenDataPath 环境变量兜底），逐台看成败；应用后重启各机 UE 编辑器即生效，旧缓存不会自动迁移。此目录是「客户端本地 Zen 缓存」，区别于①区「服务器数据目录」（共享缓存本体）与 DDC 页「本地 DDC（文件版）」。')),
      h('div', { className: 'drawer-f' },
        h(Button, { variant: 'secondary', size: 'M', onPress: close }, '完成')));
  }

  /* 小弹窗：修改单台机器的本地 Zen 端口（写 UserEngine.ini [Zen.AutoLaunch] DesiredPort，
     zen_local_port_set / clear）。自包含（自带 useState，弹层内实时响应输入 / 进度）；
     三通道反馈成败；应用 / 清除后「返回列表」重开来源弹层（读到刷新后的持久状态——
     规避内联渲染弹层的陈旧闭包问题，见文件头注释）。打开时先 zen_local_port_status
     真实回读一轮（INI 配置值 + runcontext 实际端口），不拿行内快照冒充最新值。 */
  function ZenPortModal({ s, node, rec, suggest, onApply, onClear, close, onBack }) {
    const [cur, setCur] = useState(() => rec || null);      /* {configured, actual, running} */
    const [curLoading, setCurLoading] = useState(true);
    const [curFail, setCurFail] = useState(false);
    const [port, setPort] = useState(String((rec && rec.configured != null) ? rec.configured : suggest));
    const [phase, setPhase] = useState('idle');   /* idle | applying | done | fail */
    const [msg, setMsg] = useState('');
    useEffect(() => {
      let alive = true;
      zenLocalPortStatus(node.machineId).then(
        (st) => { if (!alive) return;
          setCur({ configured: st.configured_port, actual: st.actual_port, running: st.running });
          /* 预填跟随真实读数：有 override 用它，已被清除则回到建议端口——
             不留打开时快照里的过期端口号冒充默认新值 */
          setPort(st.configured_port != null ? String(st.configured_port) : String(suggest));
          setCurLoading(false); },
        () => { if (alive) { setCurFail(true); setCurLoading(false); } });
      return () => { alive = false; };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const overridden = !!(cur && cur.configured != null);
    const configured = overridden ? cur.configured : ZEN_LOCAL_DEFAULT_PORT;
    const running = cur && cur.running && cur.actual != null ? cur.actual : null;
    const num = parseInt(port, 10);
    const valid = /^\d+$/.test(port.trim()) && num >= 1024 && num <= 65535;
    const same = valid && overridden && num === cur.configured;
    const busy = phase === 'applying';
    const settled = phase === 'done' || phase === 'fail';
    const back = () => { if (onBack) onBack(); else close(); };
    const runOp = (kind) => {
      if (busy) return;
      setPhase('applying');
      const p = kind === 'clear' ? onClear(node.id) : onApply(node.id, num);
      p.then(
        () => {
          setMsg(kind === 'clear'
            ? '已清除 override · 重启该机 UE 编辑器后恢复默认 ' + ZEN_LOCAL_DEFAULT_PORT + ' 端口'
            : '已写入 DesiredPort=' + num + ' · 重启该机 UE 编辑器后实际生效');
          setPhase('done');
        },
        (e) => { setMsg((e && e.message) ? e.message : String(e)); setPhase('fail'); });
    };
    const CHIPS = [ZEN_SUGGEST_PORT, 8560, 8561];
    return h('div', { className: 'drawer drawer--zport' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: 'link', size: 17 })),
        h('div', { style: { minWidth: 0 } },
          h('h2', null, '修改本地 Zen 端口'),
          h('div', { className: 'sub' },
            h('span', { className: 'cli-pill' }, 'zen_local_port_set UserEngine.ini'),
            h('span', null, ' · ' + node.host))),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'zport-cur' },
          h('div', { className: 'zport-cur-col' },
            h('span', { className: 'zport-cur-k' }, '配置端口'),
            h('span', { className: 'zport-cur-v mono' + (curLoading || curFail ? ' none' : '') },
              curLoading ? '读取中…' : curFail ? '读取失败 · —' : String(configured))),
          h('span', { className: 'zport-cur-arr' }, h(Icon, { name: 'arrowr', size: 15 })),
          h('div', { className: 'zport-cur-col' },
            h('span', { className: 'zport-cur-k' }, '实际运行'),
            h('span', { className: 'zport-cur-v mono' + (curLoading || curFail || running == null ? ' none' : '') },
              curLoading ? '读取中…' : curFail ? '—' : running != null ? String(running) : '未运行 · —')),
          curLoading || curFail ? null : overridden ? h('span', { className: 'zport-tag' }, '已改端口') : h('span', { className: 'zport-tag ghost' }, '默认端口')),
        !settled ? h('div', { className: 'zport-field' },
          h('label', null, '新的本地端口'),
          h('div', { className: 'zport-input-row' },
            h('input', { className: 'dp-input mono', type: 'number', min: 1024, max: 65535, inputMode: 'numeric',
              value: port, spellCheck: false, disabled: busy, autoFocus: true, onChange: (e) => setPort(e.target.value) }),
            h('div', { className: 'zport-chips' }, CHIPS.map((c) => h('button', {
              key: c, type: 'button', className: 'zport-chip' + (String(c) === port ? ' on' : ''),
              disabled: busy, onClick: () => setPort(String(c)) }, String(c))))),
          (!valid && port.trim() !== '') ? h('div', { className: 'zport-err' }, h(Icon, { name: 'alert', size: 12 }), '端口需为 1024–65535 的整数') : null) : null,
        settled ? h('div', { className: 'zport-res zr-' + (phase === 'done' ? 'ok' : 'fail') },
          h(Icon, { name: phase === 'done' ? 'check' : 'alert', size: 15 }), h('span', null, msg)) : null,
        h('div', { className: 'cli-note' }, h(Icon, { name: 'shield', size: 13 }),
          h('span', null, '写入该机 UserEngine.ini 的 ', h('span', { className: 'mono' }, '[Zen.AutoLaunch] DesiredPort'),
            '，对该机所有 UE 工程生效；Editor 重启后生效。')),),
      h('div', { className: 'drawer-f' + (settled ? '' : ' between') },
        settled
          ? h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), onPress: back }, '返回列表')
          : h(React.Fragment, null,
              h(Button, { variant: 'secondary', size: 'M', isDisabled: busy || !overridden, onPress: () => runOp('clear') }, '清除 override（恢复 ' + ZEN_LOCAL_DEFAULT_PORT + '）'),
              h('div', { style: { display: 'flex', gap: 10 } },
                h(Button, { variant: 'secondary', size: 'M', isDisabled: busy, onPress: back }, '取消'),
                h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: busy ? 'sync' : 'check', size: 15 }), isDisabled: !valid || same || busy || curLoading, onPress: () => runOp('apply') }, busy ? '应用中…' : '应用')))));
  }

  /* 通用弹层壳：图标 + 标题 + 副标题 + 关闭按钮 / 内容体 / 底部按钮区 */
  function ModalChrome({ icon, title, sub, close, children, footer }) {
    return h('div', { className: 'drawer drawer--zconfig' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: icon, size: 17 })),
        h('div', { style: { minWidth: 0 } }, h('h2', null, title), sub ? h('div', { className: 'sub' }, sub) : null),
        h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
      h('div', { className: 'drawer-b' }, children),
      h('div', { className: 'drawer-f' }, footer || h(Button, { variant: 'secondary', size: 'M', onPress: close }, '关闭')));
  }

  /* ============ 二级弹层① 部署 / 重新部署 Zen 服务器 ============
     独立有状态组件（同 ZenDirModal 模式）：表单字段、部署步骤器全部是这个组件自己的
     useState，不依赖 ZenServer 某一次 render 的闭包快照，弹层内输入框/选择器才能正常
     响应用户操作。 */
  function DeployModal({ s, RN, deployed, deployedNode, status, close, onDeployed, zports, openPortModal, backToDeploy }) {
    const [srvId, setSrvId] = useState(null);
    const [port, setPort] = useState('8558');
    const [protocol, setProtocol] = useState('http');
    const [installDir, setInstallDir] = useState('C:\\ZenServer');
    const [dataDir, setDataDir] = useState('D:\\ZenData');
    const [configOverride, setConfigOverride] = useState(null);
    const [httpType, setHttpType] = useState('httpsys');
    const [acctKind, setAcctKind] = useState(() => (status && status.serviceAccountUsername ? 'dedicated' : 'dedicated'));
    const [dedManual, setDedManual] = useState(false);
    const [dedUser, setDedUser] = useState(() => (status && status.serviceAccountUsername) || '');
    const [dedPass, setDedPass] = useState('');
    const [dedCredAlias, setDedCredAlias] = useState(() => (status && status.serviceAccountCredAlias) || null);
    const [dedCreating, setDedCreating] = useState(false);
    const [domType, setDomType] = useState('std');
    const [domName, setDomName] = useState('VOLO');
    const [domUser, setDomUser] = useState('VOLO\\zen-svc');
    const [domPass, setDomPass] = useState('');
    const [showPass, setShowPass] = useState(false);
    const [advOpen, setAdvOpen] = useState(false);
    const [started, setStarted] = useState(false);
    const [run, setRun] = useState({});
    const [deploying, setDeploying] = useState(false);
    const epRef = useRef(null);
    const srvNode = CX.node(srvId) || deployedNode || RN.find((n) => n.roleKey !== 'shared') || RN[0];

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
      return null;
    };
    const effectiveCredAlias = () => (acctKind === 'dedicated' && !dedManual ? (dedCredAlias || null) : null);
    const acctReady = () => acctKind === 'system' || !!effectiveServiceUser();
    const acctLabel = acctKind === 'system'
      ? 'LocalSystem（系统账号）'
      : acctKind === 'dedicated'
        ? (dedManual ? (dedUser.trim() || '（未填写本地账号）') : (dedCredAlias ? dedUser + '（托管）' : 'zen-svc-xxxxxx（待创建）'))
        : (domType === 'gmsa' ? (domUser.trim() || '（未填写 gMSA 账号）') + '（gMSA）' : (domUser.trim() || '（未填写域账号）'));
    const principal = effectiveServiceUser() || 'NT AUTHORITY\\LocalService';

    const derivedConfigPath = installDir.replace(/[\\/]+$/, '') + '\\zen_config.lua';
    const configPath = configOverride == null ? derivedConfigPath : configOverride;
    const formObj = { port, protocol, dataDir, configPath, acct: acctLabel, acctKind };
    const srvOpts = RN.slice()
      .sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }))
      .map((n) => ({ id: n.id, label: n.host, sub: n.ip }));
    const httpOpts = [{ id: 'httpsys', label: 'http.sys（默认）' }, { id: 'asio', label: 'asio' }];
    const cred = {};

    const setStep = (id, st, err) => setRun((r) => Object.assign({}, r, { [id]: { st, err: err || null } }));

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
      onDeployed();
    };

    const doRefresh = () => {
      s.runCmd({ domain: 'machine', action: 'refresh', target: srvNode.host, chan: 'winrm', note: '重探 UE / GPU / Zen 程序' },
        () => refreshMachine(srvNode.machineId).then((r) => { if (r && r.error) throw new Error(r.error); return r; }),
        { okMsg: () => srvNode.host + ' 已刷新 · 重试前置检查' })
        .then(() => runFrom(STEP_IDS.indexOf('detect')), () => {});
    };

    const pickServer = (id) => { setSrvId(id); setStarted(false); setRun({}); setDeploying(false); epRef.current = null; };

    /* 部署 → 居中二级对话框（modal）确认后执行；真实 7 步进度在这个弹层内的步骤器中逐步呈现
       （liveProgress:false：确认对话框只做计划确认，确认后立即关闭，进度不在对话框内重复，
       而是回落到本弹层的步骤器 —— 与确认对话框走同一个 s.modal 单槽，会替换掉本弹层，
       确认后关闭对话框即回到空白，真实进度靠下方控制台 NDJSON 日志流可见）。 */
    const modalDeploy = () => CX.openModalPreview(s, {
      title: (deployed ? '重新部署' : '部署') + ' Zen 缓存服务器', icon: 'cube',
      cli: 'zen_register → … → zen_probe', destructive: false, channel: 'ssh', confirmLabel: deployed ? '重新部署' : '开始部署',
      liveProgress: false,
      steps: DEPLOY_STEPS.map((st) => st.label + '（' + st.cli + '）'),
      simpleScope: [{ host: srvNode.host, ip: srvNode.ip, msg: protocol + '://…:' + port + ' · ' + dataDir }],
      run: () => { epRef.current = null; runFrom(0); },
    });

    const segProto = h('div', { className: 'zseg' },
      ['http'].map((p) => h('button', { key: p, className: protocol === p ? 'on' : '', onClick: () => setProtocol(p) }, p)));
    const ACCT_TIERS = [['system', '系统账号'], ['dedicated', '专用本地账号'], ['domain', '域账号']];
    const segAcct = h('div', { className: 'zseg wide zseg-acct' },
      ACCT_TIERS.map(([k, lbl]) =>
        h('button', { key: k, className: acctKind === k ? 'on' : '', onClick: () => setAcctKind(k) },
          lbl, k === 'dedicated' ? h('span', { className: 'seg-badge' }, '推荐') : null)));

    const passField = (val, setVal, ph) => h('div', { className: 'zpass' },
      h('input', { className: 'dp-input', type: showPass ? 'text' : 'password', placeholder: ph, value: val, onChange: (e) => setVal(e.target.value) }),
      h('button', { type: 'button', className: 'zpass-eye' + (showPass ? ' on' : ''), 'aria-label': showPass ? '隐藏密码' : '显示密码', onClick: () => setShowPass((v) => !v) },
        h(Icon, { name: 'eye', size: 14 })));

    const acctBody = h('div', { className: 'zacct-body' },
      acctKind === 'system' ? h(React.Fragment, null,
        h('div', { className: 'zacct-note' }, h(Icon, { name: 'shield', size: 12 }),
          '使用 Windows 内置 LocalSystem 账号运行，权限最高、无需密码，适合快速搭建测试环境。'),
        h('div', { className: 'zacct-subhint' }, '生产环境建议改用「专用本地账号」，遵循最小权限原则。')) : null,
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

    const openPath = (p) => { revealPath(p).catch(() => {}); };
    const pathInput = (val, onChange) => h('div', { className: 'dp-path' },
      h('input', { className: 'dp-input mono', value: val, spellCheck: false, onChange }),
      h('button', { type: 'button', className: 'dp-path-open', title: '在文件资源管理器中打开该目录', tabIndex: -1, onClick: () => openPath(val) },
        h(Icon, { name: 'folder', size: 13 })));

    /* 共置告警（可操作）：目标机是 UE 工作站时，Editor 自动拉起的本地 Zen（默认 8558）与
       共享服务要占的端口相撞 → 给「把本地 Zen 改到 8559」按钮直接打开端口弹窗；已改走后
       切换为绿色「可共存」确认态。zports 是打开本弹层时的快照 —— 端口弹窗应用后经
       backToDeploy 重开本弹层，读到刷新后的状态（表单值会重置，部署前改端口影响可接受）。 */
    const zpRec = zportRecOf(zports || {}, srvNode.id);
    const zpConfigured = zpRec.configured != null ? zpRec.configured : 8558;
    const coloWarn = (srvNode.roleKey === 'workstation' && openPortModal)
      ? (String(zpConfigured) === String(port)
        ? h('div', { className: 'zcolo' },
            h('span', { className: 'zcolo-ico' }, h(Icon, { name: 'alert', size: 16 })),
            h('div', { className: 'zcolo-tx' },
              h('div', { className: 'zcolo-t' }, '与本机 UE Editor 的本地 Zen 端口冲突'),
              h('div', { className: 'zcolo-s' },
                srvNode.host + ' 同时是 UE 工作站 —— Editor 会自动拉起本地 Zen（默认 ',
                h('span', { className: 'mono' }, '8558'),
                '），与这台共享服务要占用的端口 ',
                h('span', { className: 'mono' }, String(port)),
                ' 相撞。',
                runtimeUser(srvNode)
                  ? '把本机的本地 Zen 端口改走，二者即可共存。'
                  : '该机未设置 UE 运行用户，无法定位 UserEngine.ini —— 先到集群总览点开这台机器，在「① 身份 · UE 运行用户」里填上，再来改端口。')),
            runtimeUser(srvNode)
              ? h('button', { type: 'button', className: 'zcolo-btn', onClick: () => openPortModal(srvNode.id, 8559, backToDeploy) },
                  h(Icon, { name: 'bolt', size: 13 }), '把本地 Zen 改到 8559')
              : null)
        : h('div', { className: 'zcolo ok' },
            h('span', { className: 'zcolo-ico' }, h(Icon, { name: 'check', size: 16 })),
            h('div', { className: 'zcolo-tx' },
              h('div', { className: 'zcolo-t' }, '本地 Zen 端口已改走 · 可与共享服务共存'),
              h('div', { className: 'zcolo-s' },
                srvNode.host + ' 的本地 Zen 已配置到 ',
                h('span', { className: 'mono' }, 'DesiredPort=' + zpConfigured),
                '，不再与共享服务的 ',
                h('span', { className: 'mono' }, String(port)),
                ' 冲突。')),
            h('button', { type: 'button', className: 'zcolo-btn ghost', onClick: () => openPortModal(srvNode.id, zpConfigured, backToDeploy) },
              h(Icon, { name: 'settings', size: 13 }), '调整本地端口')))
      : null;

    const deployForm = h('div', { className: 'deploy-panel' },
      h('div', { className: 'dp-h' }, h(Icon, { name: 'bolt', size: 15 }), '部署链路参数',
        h('span', { className: 'dp-h-note' }, '逐步真实执行 · 每步可单独重试')),
      coloWarn,
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

    return h(ModalChrome, {
      icon: 'cube', close,
      title: deployed ? '重新部署 Zen 服务器' : '部署 Zen 服务器',
      sub: '在集群某一台机器上立起一台共享缓存服务器 · 逐步真实执行，每步可单独重试',
    }, h(React.Fragment, null, deployForm, stepper));
  }

  /* ============ 二级弹层② 缓存回收策略 ============ */
  function GcModal({ s, deployed, status, gcApplied, setGcApplied, close, onApplied }) {
    const [gcDraft, setGcDraft] = useState(() => cloneGc(gcApplied));
    const [gcBusy, setGcBusy] = useState(false);
    const [gcJustApplied, setGcJustApplied] = useState(false);
    const gcFieldDirty = (id) => gcSeconds(gcDraft[id]) !== gcSeconds(gcApplied[id]);
    const gcDirty = GC_FIELDS.some((f) => gcFieldDirty(f.id));
    const gcNonDefault = (id) => gcSeconds(gcApplied[id]) !== gcSeconds(GC_DEFAULTS[id]);
    const gcAtDefault = GC_FIELDS.every((f) => gcSeconds(gcDraft[f.id]) === gcSeconds(GC_DEFAULTS[f.id]));
    const setGcField = (id, patch) => setGcDraft((d) => Object.assign({}, d, { [id]: Object.assign({}, d[id], patch) }));
    const resetGcDefaults = () => setGcDraft(cloneGc(GC_DEFAULTS));
    const cred = {};

    /* 应用 GC 更改 → 破坏性二次确认（重写配置后会重启服务，短暂中断所有渲染节点的命中）。
       走 CX.openPreview（写 s.drawer 检查器列），不占用 s.modal，本弹层始终保持挂载，
       确认回调里的 setGcApplied/setGcBusy 才能正确落到这个仍存活的组件实例上。 */
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
              onApplied();
            }, () => setGcBusy(false));
        },
      });
    };

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
          h(Selector, { kpre: '单位', value: draft.unit, options: f.units, width: 74, align: 'left', popMin: 88, onChange: (u) => setGcField(f.id, { unit: u }) }),
          h('span', { className: 'gc-eq mono' }, '= ' + gcSeconds(draft).toLocaleString('zh-CN') + ' 秒')),
        h('div', { className: 'gc-presets' },
          f.presets.map((p) => h('button', {
            key: p.label, className: 'gc-chip' + (Number(draft.value) === p.value && draft.unit === p.unit ? ' on' : ''),
            disabled: !deployed, onClick: () => setGcField(f.id, { value: p.value, unit: p.unit }),
          }, p.label))),
        h('div', { className: 'gc-desc' }, f.desc));
    };
    const gcPanel = h('div', { className: 'gc-panel' + (!deployed ? ' is-disabled' : '') },
      deployed && (gcDirty || gcJustApplied) ? h('div', { className: 'gc-head' },
        h('span', { className: 'gc-head-tx' }),
        gcDirty ? h('span', { className: 'gc-pending' }, h('span', { className: 'gc-pending-dot' }), '有未应用的更改') : null,
        !gcDirty && gcJustApplied ? h('span', { className: 'gc-applied-ok' }, h(Icon, { name: 'check', size: 12 }), 'GC 策略已更新') : null) : null,
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

    return h(ModalChrome, {
      icon: 'flush', close,
      title: '缓存回收策略',
      sub: '控制服务器清理过期缓存的频率与保留时长',
    }, gcPanel);
  }

  /* ============ 二级弹层③ 客户端指向管理 ============
     zdirs（各机本地 Zen 缓存目录回读）已提升到 ZenServer —— 一级 Dashboard「已指向机器」
     明细也要显示缓存目录，弹层内的应用/清除/重读通过 props 落回同一份 state，两处同步。 */
  function ClientModal({ s, clients, srvNode, status, deployed, canPoint, targetVis, pointed, setPointed, pointedLoading, zdirs, setZdirs, zdirGenRef, readZdirFor, close, zports, zpres, openPortModal, backToClient }) {
    const hasAnyProjects = (window.UE_PROJECTS || []).length > 0;
    const [sel, setSel] = useState([]);
    const [res, setRes] = useState({});
    const [cfgScope, setCfgScope] = useState(hasAnyProjects ? 'project' : 'user');
    const lastProjSelRef = useRef(null);
    useEffect(() => { setRes({}); }, [cfgScope]);
    const scopeReadyFor = (n) => cfgScope === 'project' ? clientProjects(n.id).length > 0 : !!runtimeUser(n);

    /* —— 本地 Zen 缓存目录：状态派生 + 动作（读回来的记录存 ZenServer 的 zdirs）—— */
    const [zres, setZres] = useState({});
    const zenRec = (id) => zenRecOf(zdirs, id);
    const zenSt = (n) => {
      if (n.status === 'offline' || !runtimeUser(n)) return 'blocked';
      const r = zenRec(n.id);
      if (r.loading) return 'loading';
      if (r.readFail) return 'readfail';
      if (!r.cfg) return 'unset';
      if (!r.found) return 'mismatch';
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
    /* 打开弹层时刷新一轮回读（页面挂载时 ZenServer 已读过一轮，这里拿最新值）。
       ++gen 作废旧 in-flight；不设 cleanup 作废 —— state 活在 ZenServer，弹层关闭后
       迟到的回读结果落回 Dashboard 正是想要的。 */
    useEffect(() => {
      const gen = ++zdirGenRef.current;
      (srvNode ? [srvNode].concat(clients) : clients)
        .filter((n) => n.status !== 'offline' && n.machineId && runtimeUser(n)).forEach((n) => { readZdirFor(n, gen); });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const applyZenDir = (ids, path) => {
      ids.forEach((id) => {
        const n = CX.node(id);
        if (!n || n.status === 'offline') return;
        if (!runtimeUser(n)) {
          setZres((r) => Object.assign({}, r, { [id]: { st: 'fail', msg: '该机未设置 UE 运行用户，无法定位注册表 hive，也无法回读生效值 · 到集群总览打开该机详情，在「UE 运行用户」里填上', path } }));
          log(s, 'warn', `<b>zen_set_local_datapath</b> · ${esc(n.host)} 未设 ue_runtime_user，本地 Zen 目录写入跳过`);
          return;
        }
        setZres((r) => Object.assign({}, r, { [id]: { st: 'running' } }));
        zenSetLocalDatapath(n.machineId, path).then(
          (result) => {
            const regOk = !!(result && result.registry_written);
            setZdirs((d) => Object.assign({}, d, { [id]: Object.assign({}, zenRecOf(d, id), {
              cfg: path, cfgSrc: regOk ? 'registry' : 'env', regPath: regOk ? path : zenRecOf(d, id).regPath,
              loading: false, readFail: false, cfgFail: false, readErr: null,
            }) }));
            setZres((r) => Object.assign({}, r, { [id]: { st: 'ok', msg: regOk
              ? '已写入注册表并创建目录 · 重启该机 UE 编辑器后生效；旧缓存不会自动迁移'
              : '目录与环境变量已写入，但该机 UE 运行用户未登录，注册表没写成 —— 该用户下次登录后生效', path } }));
            log(s, 'ok', `<b>zen_set_local_datapath</b> · ${esc(n.host)} Zen\\DataPath = ${esc(path)}${regOk ? '' : '（仅 env var，用户未登录）'}`);
          },
          (e) => {
            const em = e && e.message ? e.message : String(e);
            setZres((r) => Object.assign({}, r, { [id]: { st: 'fail', msg: em, path } }));
            log(s, 'err', `<b>zen_set_local_datapath</b> · ${esc(n.host)} 写入失败 · ${esc(em)}`);
          });
      });
    };
    const clearZenDir = (id) => {
      const n = CX.node(id);
      if (!n) return;
      setZres((r) => Object.assign({}, r, { [id]: { st: 'running' } }));
      zenSetLocalDatapath(n.machineId, '').then(
        () => {
          setZdirs((d) => Object.assign({}, d, { [id]: Object.assign({}, zenRecOf(d, id), { cfg: null, cfgSrc: null, regPath: null, loading: false }) }));
          setZres((r) => Object.assign({}, r, { [id]: { st: 'ok', msg: '已清除配置（注册表 + 环境变量）· 重启该机 UE 编辑器后回到默认目录（' + ZEN_DEF_HINT + '）；旧缓存不会自动迁移' } }));
          log(s, 'warn', `<b>zen_set_local_datapath</b> · ${esc(n.host)} 清除本地 Zen 目录配置（还原默认）`);
        },
        (e) => {
          const em = e && e.message ? e.message : String(e);
          setZres((r) => Object.assign({}, r, { [id]: { st: 'fail', msg: em } }));
          log(s, 'err', `<b>zen_set_local_datapath</b> · ${esc(n.host)} 清除失败 · ${esc(em)}`);
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
    /* 三级弹层「设置缓存目录」：面向全部在线机器（服务器本机也纳入，与列表分组一致，排在首位），
       机器多选（全选/取消全选）与二级列表的「指向此服务器」勾选（sel）互不影响——目录配置
       与指向是两件独立的事，不该共用一份选中态。 */
    const dirMachines = (deployed && srvNode ? [srvNode].concat(clients) : clients).filter((n) => n.status !== 'offline');
    const openZenDirModal = () => {
      if (!dirMachines.length) return;
      s.setModal({
        wide: true,
        render: ({ close: closeInner }) => h(ZenDirModal, {
          machines: dirMachines, recOf: (id) => zenRec(id),
          onApply: (ids, path) => applyZenDir(ids, path),
          onClear: (ids) => ids.forEach((id) => clearZenDir(id)),
          close: closeInner,
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

    const selBlocked = onlineSel.filter((id) => !scopeReadyFor(CX.node(id)));

    const applyTo = (ids, projIds) => {
      if (!status) return;
      const host = status.host || '';
      const scheme = status.scheme || 'http';
      const hostUri = scheme + '://' + host + ':' + status.port;
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
          setRes((r) => Object.assign({}, r, { [id]: { st: 'fail', msg: '该机未设置 UE 运行用户 · 到集群总览打开该机详情，在「UE 运行用户」里填上' } }));
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

    const runApply = (ids) => {
      const online = ids.filter((id) => { const n = CX.node(id); return n && n.status !== 'offline'; });
      if (online.length) applyTo(online);
    };

    const openProjectPicker = (ids) => {
      const online = ids.filter((id) => { const n = CX.node(id); return n && n.status !== 'offline'; });
      if (!online.length || !status) return;
      const machinesArg = online.map((id) => CX.node(id));
      const host = status.host;
      s.setModal({
        wide: true,
        render: ({ close: closeInner }) => h(ProjPointModal, {
          machines: machinesArg, host, port: status.port,
          preselect: null,
          onConfirm: (pIds) => { lastProjSelRef.current = pIds; applyTo(online, pIds); },
          close: closeInner,
        }),
      });
    };

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
      !hasAnyProjects
        ? h('div', { className: 'cli-note warn' }, h(Icon, { name: 'alert', size: 13 }),
            h('span', null, '未扫描到 UE 工程 · '),
            h('button', { type: 'button', className: 'zscope-link', onClick: () => s.setCacheNav('home') }, '去集群总览发现工程'))
        : null,
      selBlocked.length
        ? h('div', { className: 'cli-note warn' }, h(Icon, { name: 'alert', size: 13 }),
            cfgScope === 'project'
              ? selBlocked.length + ' 台选中机器未发现工程，将被跳过 · 先去集群总览发现工程'
              : selBlocked.length + ' 台选中机器未设置 UE 运行用户，将被跳过 · 到集群总览逐台打开机器详情填「UE 运行用户」')
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
    /* 只读次级状态：本地 Zen 缓存目录（指向是主状态，此为次级信息）· 降为「小圆点 + 文字」
       的安静展示（去掉填充胶囊，避免与主徽标抢视觉）· 不可点开，目录配置全部收进三级
       「设置缓存目录」弹层（见 openZenDirModal / ZenDirModal）。失败时的具体原因
       （zres[n.id].msg）与重试入口不在这里展开——如需重试请在旁边「重新读取」或重新打开
       「设置缓存目录」用同一路径重新应用；控制台 NDJSON 日志流里有每一步的完整错误信息。 */
    const zdirStatusChip = (n) => {
      const st = zenSt(n);
      const r = zres[n.id];
      let vis, label, spinning = false;
      if (r && r.st === 'running') { vis = 'informative'; label = 'Zen 目录 · 应用中'; spinning = true; }
      else if (r && r.st === 'fail') { vis = 'negative'; label = 'Zen 目录 · 写入失败'; }
      else if (r && r.st === 'ok' && st === 'mismatch') { vis = 'notice'; label = 'Zen 目录 · 待重启生效'; }
      else { const m = ZDIR_META[st]; vis = m.vis; label = 'Zen 目录 · ' + m.label; spinning = st === 'loading'; }
      const title = (r && r.st === 'fail' && r.msg)
        ? ('写入失败 · ' + r.msg)
        : '客户端本地 Zen 缓存目录（注册表 Zen\\DataPath）· 目录配置在「设置缓存目录」中集中管理';
      return h('span', { className: 'zdir-stat zd-' + vis + (st === 'blocked' ? ' soft' : ''), title },
        spinning ? h('span', { className: 'spin', style: { display: 'inline-flex' } }, h(Icon, { name: 'sync', size: 11 })) : h('span', { className: 'zdir-stat-dot' }),
        label);
    };
    /* 重新读取：图标幽灵按钮，紧贴目录状态，弱化存在感 */
    const rereadBtn = (n) => {
      const st = zenSt(n);
      const blocked = st === 'blocked';
      return h('button', { className: 'zdir-reread', disabled: blocked || st === 'loading',
        title: blocked ? '离线 / 未设运行用户，无法回读生效值' : '重新读取该机 Zen 缓存目录生效值',
        'aria-label': '重新读取', onClick: () => rereadZenDir(n.id) },
        h(Icon, { name: 'sync', size: 13 }));
    };
    /* 本地端口读出（配置 → 实际）+「已改端口」标签 + 行内持久结果 + 修改入口。
       数据来自 zports（zen_local_port_status 真实回读，活在 ZenServer）；未设运行用户 /
       离线机器读不到，如实显示「—」。修改走 ZenPortModal（替换本弹层，返回路径 backToClient）。 */
    const portIO = (n) => {
      const rec = zportRecOf(zports, n.id);
      const off = n.status === 'offline';
      const blocked = off || !runtimeUser(n);
      const overridden = rec.configured != null;
      const configured = overridden ? rec.configured : ZEN_LOCAL_DEFAULT_PORT;
      const running = !blocked && rec.running && rec.actual != null ? rec.actual : null;
      const pr = zpres[n.id];
      return h('div', { className: 'zcli-port' },
        h('span', { className: 'zcli-port-lbl' }, '本地端口'),
        h('span', { className: 'zcli-port-io mono' + (overridden ? ' ov' : '') },
          blocked ? '—' : rec.loading ? '…' : String(configured),
          h('span', { className: 'zcli-port-arr' }, '→'),
          running != null ? String(running) : '—'),
        overridden ? h('span', { className: 'zport-tag' }, '已改端口') : null,
        pr ? h('span', { className: 'zcli-port-res zb-' + (pr.st === 'ok' ? 'positive' : 'negative'), title: pr.msg || '' },
          h(Icon, { name: pr.st === 'ok' ? 'check' : 'alert', size: 11 }),
          pr.st === 'ok' ? '已应用' : '失败') : null,
        blocked ? null : h('button', { type: 'button', className: 'zcli-port-btn',
          onClick: () => openPortModal(n.id, ZEN_SUGGEST_PORT, backToClient) },
          h(Icon, { name: 'settings', size: 12 }), '修改本地端口'));
    };
    const clientRow = (n) => {
      const off = n.status === 'offline';
      const checked = sel.includes(n.id);
      const stMeta = NODE_STATUS[n.status] || NODE_STATUS.na;
      return h('div', { key: n.id, className: 'zcli-wrap' },
        h('div', { className: 'cli-row zcli' + (off ? ' off' : '') + (checked ? ' on' : '') },
          h('button', { className: 'zck' + (checked ? ' on' : '') + (off ? ' dis' : ''), onClick: () => toggleSel(n), disabled: off, title: off ? '离线机器不可选' : '选择' },
            checked ? h(Icon, { name: 'check', size: 12 }) : null),
          h('span', { className: 'zcli-state' }, CX.dot(stMeta.visual),
            h('span', { className: 'zcli-state-tx s-' + stMeta.visual }, off ? '离线' : '在线')),
          h('div', { className: 'cli-meta' },
            h('div', { className: 'cli-host mono' }, n.host),
            h('div', { className: 'cli-sub' }, n.ip + ' · ' + n.role)),
          /* 主状态徽标居上，本地端口 + Zen 目录状态降为下方次级行 —— 建立视觉层级 */
          h('div', { className: 'zcli-end' },
            clientBadge(n),
            portIO(n),
            h('div', { className: 'zcli-dir' }, zdirStatusChip(n), off ? null : rereadBtn(n)))));
    };

    /* 服务器本机行：把部署了共享 Zen Server 的那台机纳入客户端列表，单独成组、明显标识。
       能力与普通客户端一致 —— 可回环指向共享缓存 / 设本地 Zen 目录 / 改本地 Zen 端口，均复用
       行内操作与弹窗；额外：本机本地 Zen 端口与共享服务端口相同（默认都 8558）时常驻端口冲突
       告警，与部署层共置告警同语义、同视觉的紧凑形态。端口读不到（离线 / 未设运行用户 / 回读
       中 / 回读失败）时不下冲突结论 —— 不拿默认值冒充实测。 */
    const serverPointRow = () => {
      const n = srvNode;
      const off = n.status === 'offline';
      const checked = sel.includes(n.id);
      const stMeta = NODE_STATUS[n.status] || NODE_STATUS.na;
      const rec = zportRecOf(zports, n.id);
      const portReadable = !off && !!runtimeUser(n) && !rec.loading && !rec.fail;
      const localPort = rec.configured != null ? rec.configured : ZEN_LOCAL_DEFAULT_PORT;
      const conflict = portReadable && status && String(localPort) === String(status.port);
      return h('div', { key: 'srv-' + n.id, className: 'zcli-wrap is-server' },
        h('div', { className: 'cli-row zcli zcli--server' + (off ? ' off' : '') + (checked ? ' on' : '') },
          h('button', { className: 'zck' + (checked ? ' on' : '') + (off ? ' dis' : ''), onClick: () => toggleSel(n), disabled: off, title: off ? '离线机器不可选' : '选择' },
            checked ? h(Icon, { name: 'check', size: 12 }) : null),
          h('span', { className: 'zcli-state' }, CX.dot(stMeta.visual),
            h('span', { className: 'zcli-state-tx s-' + stMeta.visual }, off ? '离线' : '在线')),
          h('div', { className: 'cli-meta' },
            h('div', { className: 'zsrv-hostline' },
              h('span', { className: 'cli-host mono' }, n.host),
              h('span', { className: 'zsrv-badge' }, h(Icon, { name: 'server', size: 11 }), '服务器本机')),
            h('div', { className: 'cli-sub' }, n.ip + ' · 共享 Zen 服务所在机' + (status ? ' · 指向即本机回环（' + (status.host || n.host) + ':' + status.port + '）' : ''))),
          h('div', { className: 'zcli-end' },
            clientBadge(n),
            portIO(n),
            h('div', { className: 'zcli-dir' }, zdirStatusChip(n), off ? null : rereadBtn(n)))),
        conflict ? h('div', { className: 'zcolo compact' },
          h('span', { className: 'zcolo-ico' }, h(Icon, { name: 'alert', size: 15 })),
          h('div', { className: 'zcolo-tx' },
            h('div', { className: 'zcolo-t' }, '本地 Zen 端口与共享服务冲突'),
            h('div', { className: 'zcolo-s' },
              '本机 UE Editor 会自动拉起本地 Zen（',
              h('span', { className: 'mono' }, String(localPort)),
              '），与共享服务占用的 ',
              h('span', { className: 'mono' }, String(status.port)),
              ' 端口相撞。把本地 Zen 端口改走即可与共享服务共存。')),
          h('button', { type: 'button', className: 'zcolo-btn', onClick: () => openPortModal(n.id, ZEN_SUGGEST_PORT, backToClient) },
            h(Icon, { name: 'bolt', size: 13 }), '调整本地端口')) : null);
    };

    const srvHost = status ? status.host : null;

    return h(ModalChrome, {
      icon: 'link', close,
      title: '客户端指向管理',
      sub: clients.filter((n) => pointed.has(n.id)).length + ' / ' + clients.length + ' 已指向 · 逐台改缓存配置指向此服务器',
    },
      h('div', { className: 'cli-panel' },
        /* 顶部工具栏两层：目标上下文 chip 单独在上；操作行在下（「选中全部未指向」降为
           纯文字链接、「设置缓存目录」为低调描边次级按钮、仅「指向此服务器」保留主强调色）。 */
        h('div', { className: 'zcli-bar' },
          h('div', { className: 'cli-server-chip vis-' + targetVis },
            h('span', { className: 'csc-ico' }, h(Icon, { name: 'cube', size: 15 })),
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'csc-t' }, deployed ? ('指向目标 · ' + srvHost) : '指向目标 · 尚未部署'),
              h('div', { className: 'csc-s mono' }, deployed ? (status.ip + ' : ' + status.port) : '—'))),
          h('div', { className: 'zcli-actions' },
            h('button', { className: 'zlink-all', onClick: toggleSelectUnpointed, disabled: selectableUnpointed.length === 0 },
              allUnpointedSelected ? '取消选择' : '选中全部未指向（' + selectableUnpointed.length + '）'),
            h('div', { className: 'zcli-go' },
              h('button', { className: 'zcli-side-btn', disabled: dirMachines.length === 0, onClick: openZenDirModal },
                h(Icon, { name: 'folder', size: 14 }), '设置缓存目录'),
              h(Button, {
                variant: 'accent', size: 'M', icon: h(Icon, { name: 'link', size: 14 }), isDisabled: onlineSel.length === 0 || !canPoint,
                onPress: () => { if (cfgScope === 'project') openProjectPicker(onlineSel); else runApply(onlineSel); },
              },
                onlineSel.length ? '指向此服务器（' + onlineSel.length + '）' : '指向此服务器')))),
        deployed ? scopeBlock : null,
        !deployed
          ? h('div', { className: 'cli-note warn' }, h(Icon, { name: 'alert', size: 13 }), '尚未部署服务器，先部署一台，再把客户端指向它。')
          : !canPoint
            ? h('div', { className: 'cli-note warn' }, h(Icon, { name: 'alert', size: 13 }), '服务器已部署但当前未在运行 —— 先启动 / 探活确认运行中，再指向客户端。')
            : null,
        h('div', { className: 'cli-note' }, h(Icon, { name: 'shield', size: 13 }),
          cfgScope === 'project'
            ? '应用 = 逐台改这些机器已发现工程的 DefaultEngine.ini（写 [StorageServers] Shared，非旧版 [InstalledDerivedDataBackendGraph]）指向上方服务器；远程操作走 SSH key，逐台执行、逐台看成败。'
            : '应用 = 逐台改这些机器 UE 运行用户的 UserEngine.ini（写 [StorageServers] Shared）指向上方服务器；远程操作走 SSH key，逐台执行、逐台看成败。'),
        h('div', { className: 'cli-list' },
          deployed && srvNode ? h('div', { className: 'zcli-group-h' },
            h('span', { className: 'zcli-group-t' }, '服务器本机'),
            h('span', { className: 'zcli-group-s' }, '共享 Zen 服务所在机 · 可回环指向')) : null,
          deployed && srvNode ? serverPointRow() : null,
          h('div', { className: 'zcli-group-h' },
            h('span', { className: 'zcli-group-t' }, '客户端'),
            h('span', { className: 'zcli-group-ct mono' }, clients.length)),
          clients.map(clientRow))));
  }

  function ZenServer({ s }) {
    const snapRef = useRef({ status: null, gcApplied: null, gcSeededFor: null, pointed: null });
    /* —— 真实状态（zen_list_endpoints + zen_status + zen_cache_stats）—— */
    const [status, setStatus] = useState(() => snapRef.current.status);   /* {endpointId,machineId,host,ip,port,scheme,version,dataDir,svc,records,gc*,serviceAccount*} | null */
    const [statusLoading, setStatusLoading] = useState(() => !snapRef.current.status);
    const loadStatus = (opts) => {
      const silent = !!(opts && opts.silent);
      if (!silent) setStatusLoading(true);
      Promise.allSettled([zenListEndpoints(null), zenStatus(null)]).then(([epR, stR]) => {
        const eps = epR.status === 'fulfilled' && Array.isArray(epR.value) ? epR.value : [];
        const rows = stR.status === 'fulfilled' && Array.isArray(stR.value) ? stR.value : [];
        const ep = eps.find((e) => e.role === 'shared_upstream') || eps[0] || null;
        if (!ep) {
          setStatus(null);
          snapRef.current.status = null;
          setStatusLoading(false);
          return;
        }
        const row = rows.find((r) => r.endpoint_id === ep.id) || null;
        /* reachable 三态：true→运行中 / false→不可达 / null（从未探活）→状态未知（不冒充已停止）*/
        const svc = row ? (row.reachable === true ? 'running' : row.reachable === false ? 'unreachable' : 'unknown') : 'unknown';
        const nextStatus = {
          endpointId: ep.id, machineId: ep.machine_id,
          host: row ? row.hostname : '', ip: row ? row.ip : '',
          port: ep.declared_port, scheme: ep.scheme, dataDir: ep.data_dir,
          version: row && row.build_version ? row.build_version : '—', svc, providers: null, cacheDiskBytes: null, diskTotalBytes: null, diskFreeBytes: null,
          gcIntervalSeconds: ep.gc_interval_seconds, gcLightweightIntervalSeconds: ep.gc_lightweight_interval_seconds,
          cacheMaxDurationSeconds: ep.cache_max_duration_seconds,
          serviceAccountUsername: ep.service_account_username, serviceAccountCredAlias: ep.service_account_cred_alias,
        };
        setStatus(nextStatus);
        snapRef.current.status = nextStatus;
        setStatusLoading(false);
        zenCacheStats(ep.id, null).then((cs) => {
          const sample = cs && Array.isArray(cs.samples) && cs.samples[0] ? cs.samples[0] : null;
          const provs = sample && Array.isArray(sample.providers) ? sample.providers : null;
          const diskBytes = sample && typeof sample.cache_disk_size_bytes === 'number' ? sample.cache_disk_size_bytes : null;
          setStatus((s2) => (s2 ? Object.assign({}, s2, { providers: provs, cacheDiskBytes: diskBytes }) : s2));
        }, () => {});
        /* 数据盘总容量 + 可用容量走单独一条 SSH 通道（zen 自己的 /stats 里没有这些字段，
           见 zenDiskSpace 注释），跟上面的 HTTP 缓存用量并行取，谁先回来谁先展示，互不阻塞。 */
        zenDiskSpace(ep.id).then((rows) => {
          const rec = Array.isArray(rows) && rows[0] ? rows[0] : null;
          const totalBytes = rec && typeof rec.total_bytes === 'number' ? rec.total_bytes : null;
          const freeBytes = rec && typeof rec.free_bytes === 'number' ? rec.free_bytes : null;
          setStatus((s2) => (s2 ? Object.assign({}, s2, { diskTotalBytes: totalBytes, diskFreeBytes: freeBytes }) : s2));
        }, () => {});
      });
    };
    useEffect(() => { loadStatus({ silent: !!snapRef.current.status }); }, []);
    useEffect(() => { snapRef.current.status = status; }, [status]);

    /* —— GC 已应用值：仅保留供 Dashboard 卡二展示；草稿/应用中/破坏性确认全在 GcModal 内部。
       首次拿到真实 endpoint 数据时按其 gc_* 字段种一次（缺省=尚未配置过，视作官方默认）。 —— */
    const [gcApplied, setGcApplied] = useState(() => snapRef.current.gcApplied || cloneGc(GC_DEFAULTS));
    const gcSeededForRef = useRef(snapRef.current.gcSeededFor);
    const setGcAppliedTracked = (updater) => setGcApplied((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      snapRef.current.gcApplied = next;
      return next;
    });
    useEffect(() => {
      if (!status || gcSeededForRef.current === status.endpointId) return;
      gcSeededForRef.current = status.endpointId;
      snapRef.current.gcSeededFor = status.endpointId;
      const nextGc = {
        interval: status.gcIntervalSeconds != null ? bestVU(status.gcIntervalSeconds, GC_FIELDS[0].units) : Object.assign({}, GC_DEFAULTS.interval),
        lw: status.gcLightweightIntervalSeconds != null ? bestVU(status.gcLightweightIntervalSeconds, GC_FIELDS[1].units) : Object.assign({}, GC_DEFAULTS.lw),
        maxDur: status.cacheMaxDurationSeconds != null ? bestVU(status.cacheMaxDurationSeconds, GC_FIELDS[2].units) : Object.assign({}, GC_DEFAULTS.maxDur),
      };
      setGcAppliedTracked(nextGc);
    }, [status]);

    /* pointed 必须在任何条件 return 之前声明（Rules of Hooks）。否则首屏 RENDER_NODES 还空、
       走下面 if(!RN.length) 早返回时这些 hook 不执行；机器异步到达后 re-render 又执行，
       hook 数变化会让 React 抛「Rendered more hooks than during the previous render」并
       卸载整棵树（纯黑屏）。 */
    const [pointed, setPointed] = useState(() => (snapRef.current.pointed ? new Set(snapRef.current.pointed) : new Set()));  /* 「已指向」机器（下方 effect 真实回读 + 应用成功的乐观更新）*/
    const [pointedLoading, setPointedLoading] = useState(false); /* 指向状态回读进行中 */
    const setPointedTracked = (updater) => setPointed((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      snapRef.current.pointed = next;
      return next;
    });

    /* —— 指向状态真实回读 ——
       对在线客户端逐台真实回读 [StorageServers] Shared（用户全局读 UserEngine.ini，工程级读各工程 DefaultEngine.ini，
       与 ClientModal.applyTo 的两条写入路径一一对应），Host 主机名/IP + 端口命中当前端点即
       「已指向」。代次令牌 + 并集合并同 cacheDdc readStatus：作废过期回读、不覆盖回读期间
       「应用成功」的乐观更新（本页没有「取消指向」操作，并集不会复活已解除项）。
       回读延后到首帧之后执行，避免与导航同帧抢跑大量 SSH invoke。 */
    const pointedGenRef = useRef(0);
    const statusSig = status ? [status.endpointId, status.machineId, status.host, status.ip, status.port].join('|') : '';
    const nodesSig = (window.RENDER_NODES || []).map((n) => n.id + ':' + n.status + ':' + n.user).join(',');
    const projSig = (window.UE_PROJECTS || []).map((p) => p.id).join(',');
    useEffect(() => {
      if (!status) { setPointedLoading(false); return; }
      /* 服务器本机不排除 —— 它也能回环指向自己的共享缓存，指向状态同样真实回读 */
      const nodes = (window.RENDER_NODES || []).filter((n) =>
        n.status !== 'offline' && n.machineId);
      if (!nodes.length) { setPointedLoading(false); return; }
      const gen = ++pointedGenRef.current;
      const hasCachedPointed = snapRef.current.pointed && snapRef.current.pointed.size > 0;
      /* 延后到首帧之后：逐台 SSH 读 INI 是切换卡顿主因，不应与导航同帧抢跑。 */
      const timer = setTimeout(() => {
        if (gen !== pointedGenRef.current) return;
        /* 与 ClientModal.applyTo 的 hostUri 同源比对：Host 主机部分接受端点 hostname 或 IP，端口必须一致 */
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
        if (!hasCachedPointed) setPointedLoading(true);
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
          if (hits.length) setPointedTracked((prev) => { const np = new Set(prev); hits.forEach((id) => np.add(id)); return np; });
          setPointedLoading(false);
        });
      }, 0);
      return () => { clearTimeout(timer); pointedGenRef.current++; };
    }, [statusSig, nodesSig, projSig]);

    /* —— 各机本地 Zen 缓存目录回读（zdirs）——
       原先只活在 ClientModal 里；「已指向机器」明细现在要逐台显示缓存目录，提升到本组件。
       ClientModal 通过 props 共用这份 state：弹层内应用/清除/重读都落回这里，Dashboard 同步。
       同样必须在下方 if(!RN.length) 早返回之前声明（Rules of Hooks，见 pointed 的注释）。 */
    const [zdirs, setZdirs] = useState({});
    const zdirGenRef = useRef(0);
    const readZdirFor = (n, gen) => Promise.allSettled([
      getMachineEnvVar(n.machineId, 'UE-ZenDataPath'),
      zenReadLocalRuncontext(n.machineId),
    ]).then(([cfgR, rcR]) => {
      if (gen !== zdirGenRef.current) return;
      const rc = rcR.status === 'fulfilled' ? rcR.value : null;
      const envFail = cfgR.status === 'rejected';
      const rcFail = rcR.status === 'rejected';
      const envCfg = !envFail && cfgR.value ? cfgR.value : null;
      const regCfg = rc && rc.registry_data_path ? rc.registry_data_path : null;
      const cfgFail = envFail && !regCfg;
      const errOf = (x) => (x.reason && x.reason.message ? x.reason.message : String(x.reason));
      setZdirs((d) => Object.assign({}, d, { [n.id]: {
        cfg: regCfg || envCfg,
        cfgSrc: regCfg ? 'registry' : envCfg ? 'env' : null,
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
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [statusSig, nodesSig]);

    /* —— 本地 Zen 端口回读（zports）+ 行内持久结果（zpres）——
       zen_local_port_status 合并读该机 UserEngine.ini 的 DesiredPort（配置值）与 runcontext
       命令行 --port（实际运行值）。与 zdirs 不同：包含服务器机器本身 —— 部署弹层的共置
       告警要用它判断本机本地 Zen 是否已挪走端口。需 ue_runtime_user（同 zdirs）。 */
    const [zports, setZports] = useState({});
    const [zpres, setZpres] = useState({});      /* nodeId -> { st: 'ok'|'fail', msg } */
    const zportGenRef = useRef(0);
    /* 逐机代次：apply/clear 成功时 ++，作废该机所有在途回读——否则「另一台机器状态变化
       触发的整轮回读」里针对本机、apply 前发出的请求可能晚于写入落地，把刚应用的乐观值
       静默覆盖回旧值（全局 gen 挡不住同代次内的这种时序）。 */
    const zportIdGenRef = useRef({});
    const reopenClientRef = useRef(null);
    const reopenDeployRef = useRef(null);
    const readZportFor = (n, gen) => {
      const idGen = zportIdGenRef.current[n.id] || 0;
      const fresh = () => gen === zportGenRef.current && idGen === (zportIdGenRef.current[n.id] || 0);
      return zenLocalPortStatus(n.machineId).then(
        (st) => { if (!fresh()) return;
          setZports((d) => Object.assign({}, d, { [n.id]: {
            configured: st.configured_port, actual: st.actual_port, running: st.running,
            sharedPort: st.shared_upstream_port, loading: false, fail: false } })); },
        () => { if (!fresh()) return;
          setZports((d) => Object.assign({}, d, { [n.id]: Object.assign({}, zportRecOf(d, n.id), { loading: false, fail: true }) })); });
    };
    useEffect(() => {
      const gen = ++zportGenRef.current;
      (window.RENDER_NODES || [])
        .filter((n) => n.status !== 'offline' && n.machineId && runtimeUser(n))
        .forEach((n) => { readZportFor(n, gen); });
      return () => { zportGenRef.current++; };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodesSig]);

    const deployed = !!status;
    /* 仅当服务真正 running 才允许把客户端指向它——指向一台已停止/不可达/状态未知的服务器
       会让客户端缓存上游失效。stopped/unreachable/unknown 都不放行。 */
    const canPoint = deployed && status.svc === 'running';
    const RN = window.RENDER_NODES || [];
    /* 默认显示已部署的 ZenServer：先按 endpoint 真实主机名匹配，匹配不到（比如该机
       已从集群移除）再退到 roleKey==='shared'（集群里指定的共享缓存机位）；只在真
       有 endpoint（status 非空）时才生效。 */
    const deployedNode = status
      ? (RN.find((n) => status.host && n.host.toLowerCase() === String(status.host).toLowerCase())
          || RN.find((n) => n.roleKey === 'shared'))
      : null;

    if (!RN.length) {
      return h('div', { className: 'res ddc' }, h('div', { className: 'ddc-body' },
        h('div', { className: 'gen-empty' }, h(Icon, { name: 'node', size: 22 }),
          h('span', null, '集群里还没有机器 — 先在「集群总览」扫描添加机器，再部署 Zen 服务器'))));
    }

    const cred = {}; /* SSH key — ZenCredentialInput 全 None */

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
        .then(() => loadStatus(), () => {}),
    });

    /* ============ ② 客户端：把选中机器指向此缓存服务器 ============
       服务器本机不混进 clients —— 弹层里单独成组（serverPointRow），一级 Dashboard 的
       「已指向机器」明细仍只统计客户端。 */
    const clients = RN.filter((n) => !(status && n.machineId === status.machineId) && !(deployedNode && n.id === deployedNode.id));

    /* 一级页面直显：已指向此服务器的机器逐台明细 —— 名称 / 部署类型（工程级 or 用户全局）/
       工程级时具体指向了哪些工程。没有单独持久化「每台机器用的范围」，用该机是否有已发现
       工程作为判定依据。pointedCount 由此派生，避免同一个 filter 对 clients 重复跑两遍。
       服务器本机回环指向后也计入 —— 弹层里能指它，一级明细却不显示会看起来像指向丢了；
       行内加「服务器本机」徽标区分。 */
    const pointedClientRows = (deployedNode && pointed.has(deployedNode.id) ? [deployedNode] : [])
      .concat(clients.filter((n) => pointed.has(n.id))).map((n) => {
        const projs = clientProjects(n.id);
        return { n, isProject: projs.length > 0, projs, isServer: !!(deployedNode && n.id === deployedNode.id) };
      });
    const pointedCount = pointedClientRows.length;
    const pointableCount = clients.length + (deployedNode ? 1 : 0);

    /* ============ 渲染 ============ */
    const sMeta = SVC_STATE[(status && status.svc) || 'unknown'] || SVC_STATE.unknown;
    /* 指向目标卡片的色调：未部署 = 中性引导态；已部署但停止/不可达/状态未知 = 真失败态；其余 = 平常强调色 */
    const targetVis = !deployed ? 'neutral' : (status.svc === 'running' ? 'accent' : status.svc === 'unreachable' ? 'negative' : 'notice');
    const hero = (val, unit, label, tone, title) => h('div', { className: 'zsv-hero' + (tone ? ' t-' + tone : ''), title },
      h('div', { className: 'zsv-hero-v' }, val, unit ? h('span', { className: 'zsv-hero-u' }, unit) : null),
      h('div', { className: 'zsv-hero-l' }, label));
    const chip = (k, v, mono, title) => h('div', { className: 'zsv-chip', title }, h('span', { className: 'zsv-chip-k' }, k), h('span', { className: 'zsv-chip-v' + (mono ? ' mono' : '') }, v));
    /* zen 自身 /stats/z$ 上报的 cache.size.disk，来自 zenCacheStats 拉取的 status.cacheDiskBytes；
       未探测到（z$ 未注册 / 探测失败）时为 null，如实显示「—」而非编造。 */
    const heroBytes = (b) => b == null ? ['—', null]
      : b >= 1099511627776 ? [(b / 1099511627776).toFixed(1), 'TB']
      : b >= 1073741824 ? [(b / 1073741824).toFixed(1), 'GB']
      : b >= 1048576 ? [(b / 1048576).toFixed(0), 'MB']
      : [(b / 1024).toFixed(0), 'KB'];
    const fmtBytesStr = (b) => { const [v, u] = heroBytes(b); return u ? (v + ' ' + u) : v; };

    /* ① 服务器状态卡：仪表化展示（hero 磁贴 + chip 组）。
       URL ACL 取部署时实际下发的 urlacl 前缀（zen_urlacl_add 写入的 netsh 规则），非猜测值。 */
    const urlAclPrefix = deployed ? (status.scheme + '://*:' + status.port + '/') : null;
    const [cacheSizeVal, cacheSizeUnit] = heroBytes(status && status.cacheDiskBytes);
    /* 缓存盘容量条（分段）：缓存已用（cacheDiskBytes，zen /stats 上报）＋盘内其它
       （＝总量−缓存−可用，非缓存数据）＋可用容量（free_bytes）；总量/可用都来自
       zenDiskSpace 的 SSH 读盘。三个数齐了才画分段与算「其它」，缺任何一个都不编造，
       条子留白、图例如实显示「—」。floor 1% 是抄设计稿的做法——用量再小也留一道
       可见的色块，不会看着像空条。 */
    const cacheBytesRaw = status && status.cacheDiskBytes;
    const diskTotalBytes = status && status.diskTotalBytes;
    const diskFreeBytes = status && status.diskFreeBytes;
    const diskDataReady = diskTotalBytes != null && diskTotalBytes > 0 && cacheBytesRaw != null && diskFreeBytes != null;
    const diskOtherBytes = diskDataReady ? Math.max(0, diskTotalBytes - cacheBytesRaw - diskFreeBytes) : null;
    const diskCachePct = diskDataReady ? Math.max(1, Math.min(100, Math.round(cacheBytesRaw / diskTotalBytes * 100))) : null;
    const diskOtherPct = diskDataReady ? Math.max(0, Math.min(100 - diskCachePct, Math.round(diskOtherBytes / diskTotalBytes * 100))) : null;
    const statusCard = statusLoading
      ? h('div', { className: 'zen-empty' },
          h('span', { className: 'ze-ico' }, h('span', { className: 'zstep-spin' })),
          h('div', { className: 'ze-tx' }, h('div', { className: 'ze-t' }, '正在读取 Zen 服务器状态…')))
      : deployed
        ? h(React.Fragment, null,
            h('div', { className: 'zdc-stat' },
              h('div', { className: 'zdc-stat-top' },
                h('span', { className: 'zdc-stat-host' }, status.host || ('endpoint ' + status.endpointId)),
                h(ZBadge, { vis: sMeta.vis, icon: sMeta.icon, label: sMeta.label })),
              h('div', { className: 'zdc-stat-sub mono' }, (status.ip ? status.ip : '') + ' : ' + status.port + ' · ' + status.scheme + ' · ' + (status.version === '—' ? '版本未知' : status.version)),
              h('div', { className: 'zdc-stat-acts' },
                h('button', { className: 'mini-btn', onClick: probeServer }, h(Icon, { name: 'pulse', size: 12 }), '探活'),
                status.svc === 'running'
                  ? h('button', { className: 'mini-btn', onClick: stopServer }, h(Icon, { name: 'pause', size: 12 }), '停止')
                  : h('button', { className: 'mini-btn', onClick: startServer }, h(Icon, { name: 'play', size: 12 }), '启动'),
                h('button', { className: 'mini-btn danger', onClick: uninstallServer }, h(Icon, { name: 'trash', size: 12 }), '卸载'))),
            h('div', { className: 'zsv-heros' },
              hero(pointedCount, '台', '已连客户端', 'accent'),
              hero(cacheSizeVal, cacheSizeUnit, '缓存已用', null,
                cacheSizeVal === '—' ? 'z$ 缓存 provider 未上报磁盘用量，或本次探测失败' : null)),
            h('div', { className: 'zsv-bar', title: diskDataReady ? null : '数据盘容量读取中或读取失败（SSH · get-disk-space）' },
              h('div', { className: 'zsv-bar-top' },
                h('span', { className: 'zsv-bar-k' }, '缓存盘容量'),
                h('span', { className: 'zsv-bar-v mono' }, diskTotalBytes == null ? '—' : fmtBytesStr(diskTotalBytes))),
              h('div', { className: 'zsv-bar-track' },
                diskDataReady ? h('div', { className: 'zsv-bar-seg cache', style: { width: diskCachePct + '%' } }) : null,
                diskDataReady ? h('div', { className: 'zsv-bar-seg other', style: { left: diskCachePct + '%', width: diskOtherPct + '%' } }) : null),
              h('div', { className: 'zsv-bar-legend' },
                h('div', { className: 'zsv-leg' }, h('span', { className: 'zsv-leg-dot cache' }),
                  h('span', { className: 'zsv-leg-k' }, '缓存已用'), h('span', { className: 'zsv-leg-v mono' }, cacheBytesRaw == null ? '—' : fmtBytesStr(cacheBytesRaw))),
                h('div', { className: 'zsv-leg' }, h('span', { className: 'zsv-leg-dot other' }),
                  h('span', { className: 'zsv-leg-k' }, '盘内其它'), h('span', { className: 'zsv-leg-v mono' }, diskOtherBytes == null ? '—' : fmtBytesStr(diskOtherBytes))),
                h('div', { className: 'zsv-leg' }, h('span', { className: 'zsv-leg-dot free' }),
                  h('span', { className: 'zsv-leg-k' }, '可用容量'), h('span', { className: 'zsv-leg-v mono' }, diskFreeBytes == null ? '—' : fmtBytesStr(diskFreeBytes))))),
            h('div', { className: 'zsv-chips' },
              chip('端口', String(status.port), true),
              chip('协议', status.scheme),
              chip('URL ACL', urlAclPrefix, true, '部署时下发的 netsh http urlacl 前缀')))
        : h('div', { className: 'zen-empty' },
            h('span', { className: 'ze-ico' }, h(Icon, { name: 'cube', size: 26 })),
            h('div', { className: 'ze-tx' },
              h('div', { className: 'ze-t' }, '未部署 Zen 缓存服务器'),
              h('div', { className: 'ze-s' }, '集群里还没有共享缓存服务器。填写下方参数并部署一台，让渲染机都用上它。')),
            h(ZBadge, { vis: 'neutral', label: '未部署' }));

    /* —— 本地 Zen 端口：应用 / 清除（真实 zen_local_port_set / clear）+ 弹窗打开 ——
       返回 Promise 给 ZenPortModal 驱动三通道结果条；成功后回写 zports（乐观）+ zpres
       （行内持久状态）。返回路径走 reopen ref：s.modal 单槽，端口弹窗会替换来源弹层，
       「返回列表」时重开来源弹层读到最新 zports（规避内联渲染的陈旧闭包）。 */
    const applyZenPort = (id, portNum) => {
      const n = CX.node(id);
      return zenLocalPortSet(n.machineId, portNum).then(
        (res) => {
          zportIdGenRef.current[id] = (zportIdGenRef.current[id] || 0) + 1;
          setZports((d) => Object.assign({}, d, { [id]: Object.assign({}, zportRecOf(d, id), { configured: portNum, loading: false, fail: false }) }));
          setZpres((r) => Object.assign({}, r, { [id]: { st: 'ok', msg: '已写入 DesiredPort=' + portNum + ' · 重启该机 UE 编辑器后实际生效' } }));
          log(s, 'ok', `<b>zen_local_port_set</b> · ${esc(n.host)} UserEngine.ini [Zen.AutoLaunch] DesiredPort=${portNum}`);
          return res;
        },
        (e) => {
          const em = e && e.message ? e.message : String(e);
          setZpres((r) => Object.assign({}, r, { [id]: { st: 'fail', msg: em } }));
          log(s, 'err', `<b>zen_local_port_set</b> · ${esc(n.host)} 写 [Zen.AutoLaunch] DesiredPort 失败 · ${esc(em)}`);
          throw e;
        });
    };
    const clearZenPort = (id) => {
      const n = CX.node(id);
      return zenLocalPortClear(n.machineId).then(
        (res) => {
          zportIdGenRef.current[id] = (zportIdGenRef.current[id] || 0) + 1;
          setZports((d) => Object.assign({}, d, { [id]: Object.assign({}, zportRecOf(d, id), { configured: null, loading: false, fail: false }) }));
          setZpres((r) => Object.assign({}, r, { [id]: { st: 'ok', msg: '已清除 override · 重启该机 UE 编辑器后恢复默认 ' + ZEN_LOCAL_DEFAULT_PORT } }));
          log(s, 'warn', `<b>zen_local_port_clear</b> · ${esc(n.host)} 清除 [Zen.AutoLaunch] DesiredPort（恢复默认 ${ZEN_LOCAL_DEFAULT_PORT}）`);
          return res;
        },
        (e) => {
          const em = e && e.message ? e.message : String(e);
          setZpres((r) => Object.assign({}, r, { [id]: { st: 'fail', msg: em } }));
          log(s, 'err', `<b>zen_local_port_clear</b> · ${esc(n.host)} 清除失败 · ${esc(em)}`);
          throw e;
        });
    };
    const backToClient = () => { if (reopenClientRef.current) reopenClientRef.current(); };
    const backToDeploy = () => { if (reopenDeployRef.current) reopenDeployRef.current(); };
    const openPortModal = (id, suggest, returnTo) => {
      const n = CX.node(id);
      if (!n || !n.machineId) return;
      if (!runtimeUser(n)) {
        log(s, 'warn', `<b>zen_local_port_set</b> · ${esc(n.host)} 未设 ue_runtime_user，无法定位 UserEngine.ini · 到集群总览打开该机详情填「UE 运行用户」`);
        return;
      }
      s.setModal({
        render: ({ close }) => h(ZenPortModal, {
          s, node: n, rec: zportRecOf(zports, id), suggest: suggest || ZEN_SUGGEST_PORT,
          onApply: applyZenPort, onClear: clearZenPort,
          close, onBack: returnTo || null,
        }),
      });
    };

    const openDeployModal = () => s.setModal({
      xwide: true,
      render: ({ close }) => h(DeployModal, { s, RN, deployed, deployedNode, status, close, onDeployed: loadStatus,
        zports, openPortModal, backToDeploy }),
    });

    const openGcModal = () => s.setModal({
      xwide: true,
      render: ({ close }) => h(GcModal, { s, deployed, status, gcApplied, setGcApplied: setGcAppliedTracked, close, onApplied: loadStatus }),
    });

    const openClientModal = () => s.setModal({
      xwide: true,
      render: ({ close }) => h(ClientModal, { s, clients, srvNode: deployedNode, status, deployed, canPoint, targetVis, pointed, setPointed: setPointedTracked, pointedLoading, zdirs, setZdirs, zdirGenRef, readZdirFor, close,
        zports, zpres, openPortModal, backToClient }),
    });
    /* 每次渲染刷新 reopen 引用，指向持有最新 zports/zpres 快照的弹窗构造器 */
    reopenClientRef.current = openClientModal;
    reopenDeployRef.current = openDeployModal;

    /* ============ 一级 Dashboard：三张概览卡，仅展示状态，具体配置点「更改/部署/管理」进二级弹层 ============ */
    return h('div', { className: 'res ddc' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, 'DDC · ZenServer'),
        h('div', { className: 'right' },
          deployed
            ? h('span', { className: 'toolchip' }, h(Icon, { name: 'cube', size: 14 }), '当前后端：ZenServer · ' + (status.host || ('endpoint ' + status.endpointId)))
            : h('span', { className: 'toolchip dim' }, h(Icon, { name: 'minus', size: 14 }), '未部署共享缓存服务器'))),
      h('div', { className: 'ddc-body' },
        h('div', { className: 'zen-dash' },
          /* 左列容器：服务器卡 + 回收策略卡垂直排布，卡间距固定 16px 与列间距一致
             （不再走 grid areas —— 避免客户端卡跨行拉伸把左下卡顶出大片空白）。 */
          h('div', { className: 'zdc-col-left' },
          /* 卡片一 · 服务器状态（左上） */
          h('div', { className: 'zdc zdc--server' },
            h('div', { className: 'zdc-head' },
              h('span', { className: 'zdc-ico' }, h(Icon, { name: 'cube', size: 17 })),
              h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
                h('div', { className: 'zdc-t' }, 'Zen 缓存服务器'),
                h('div', { className: 'zdc-s' }, '在集群某一台机器上立起的共享缓存服务器')),
              h('div', { className: 'zdc-head-act' },
                h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'settings', size: 14 }), onPress: openDeployModal },
                  deployed ? '更改部署配置' : '部署服务器'))),
            statusCard),
          /* 卡片二 · 缓存回收策略（左下） */
          h('div', { className: 'zdc zdc--gc' },
            h('div', { className: 'zdc-head' },
              h('span', { className: 'zdc-ico' }, h(Icon, { name: 'flush', size: 17 })),
              h('div', null,
                h('div', { className: 'zdc-t' }, '缓存回收策略'),
                h('div', { className: 'zdc-s' }, '控制服务器清理过期缓存的频率与保留时长')),
              h('div', { className: 'zdc-head-act' },
                !deployed ? h('span', { className: 'zdc-hint' }, '先部署') : null,
                h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'settings', size: 14 }), isDisabled: !deployed, onPress: openGcModal }, '更改回收策略'))),
            h('div', { className: 'zdc-kv-list' },
              GC_FIELDS.map((f) => h('div', { className: 'zdc-kv', key: f.id },
                h('span', { className: 'k' }, f.label), h('span', { className: 'v' }, fmtGc(gcApplied[f.id]))))))),
          /* 卡片三 · 客户端指向管理（最大，右侧整列） */
          h('div', { className: 'zdc zdc--client' },
            h('div', { className: 'zdc-head' },
              h('span', { className: 'zdc-ico' }, h(Icon, { name: 'link', size: 17 })),
              h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
                h('div', { className: 'zdc-t' }, '客户端指向管理'),
                h('div', { className: 'zdc-s' }, '把渲染机的缓存配置指向这台共享服务器')),
              h('div', { className: 'zdc-head-act' },
                !deployed ? h('span', { className: 'zdc-hint' }, '先部署') : null,
                h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'settings', size: 14 }), isDisabled: !deployed, onPress: openClientModal }, '管理客户端指向'))),
            (function () {
              const projScope = pointedClientRows.filter((r) => r.isProject);
              const userScope = pointedClientRows.filter((r) => !r.isProject);
              const distinctProjs = new Set();
              projScope.forEach((r) => r.projs.forEach((p) => distinctProjs.add(p.id)));
              return h(React.Fragment, null,
                h('div', { className: 'zsv-heros' },
                  hero(pointedCount, '台', '已指向机器', 'accent'),
                  hero(distinctProjs.size, '个', '覆盖工程')),
                h('div', { className: 'zsv-chips' },
                  chip('指向覆盖', pointedCount + ' / ' + pointableCount + ' 台'),
                  chip('工程级', projScope.length + ' 台'),
                  chip('用户全局', userScope.length + ' 台')),
                h('div', { className: 'zcl-list-h' },
                  h('span', null, '已指向机器'),
                  h('span', { className: 'zcl-list-ct mono' }, pointedClientRows.length)),
                h('div', { className: 'zcl-list' },
                  pointedClientRows.length === 0
                    ? h('div', { className: 'zcl-empty' }, h(Icon, { name: 'link', size: 18 }), '暂无客户端指向此服务器')
                    : pointedClientRows.map(({ n, isProject, projs, isServer }) => {
                        /* 逐行明细：IP + 本地 Zen 缓存目录（zdirs 真实回读：自定义配置值优先，
                           其次 runcontext 生效值，未配置 = 默认 C 盘提示；读取中/不可读如实展示）；
                           工程级再逐个列出工程名 + 该机上的工程根路径（locByMachine 每机独立，
                           取不到才退 p.root），用户全局显示 UserEngine.ini 说明。 */
                        const zr = zenRecOf(zdirs, n.id);
                        const zrBlocked = n.status === 'offline' || !runtimeUser(n);
                        const cacheDir = zrBlocked ? '不可读 · 离线或未设 UE 运行用户'
                          : zr.loading ? '读取中…'
                          : zr.readFail ? '读取失败'
                          : (zr.cfg || (zr.found && zr.eff) || ZEN_DEF_HINT + '（默认）');
                        return h('div', { className: 'zcl-row', key: n.id },
                          CX.dot(NODE_STATUS[n.status].visual),
                          h('div', { className: 'zcl-row-main' },
                            h('div', { className: 'zcl-row-topline' },
                              h('span', { className: 'zcl-row-host mono' }, n.host),
                              h('span', { className: 'zcl-row-ip mono' }, n.ip),
                              isServer ? h('span', { className: 'zsrv-badge' }, h(Icon, { name: 'server', size: 11 }), '服务器本机') : null,
                              h('span', { className: 'zcl-row-badge' + (isProject ? ' proj' : ' user') }, isProject ? '工程级' : '用户全局')),
                            h('div', { className: 'zcl-meta' },
                              h('div', { className: 'zcl-meta-row' },
                                h('span', { className: 'zcl-meta-k' }, '缓存目录'),
                                h('span', { className: 'zcl-meta-v mono' }, cacheDir)),
                              (function () {
                                /* 本地端口读出（配置 → 实际）；不可读时如实「—」 */
                                const pRec = zportRecOf(zports, n.id);
                                const pOv = pRec.configured != null;
                                const pConf = pOv ? pRec.configured : ZEN_LOCAL_DEFAULT_PORT;
                                const pRun = !zrBlocked && pRec.running && pRec.actual != null ? pRec.actual : null;
                                return h('div', { className: 'zcl-meta-row' },
                                  h('span', { className: 'zcl-meta-k' }, '本地端口'),
                                  h('span', { className: 'zcl-meta-v mono' },
                                    zrBlocked ? '不可读' : pRec.loading ? '读取中…' : (pConf + ' → ' + (pRun != null ? pRun : '—'))),
                                  pOv ? h('span', { className: 'zport-tag' }, '已改端口') : null);
                              })(),
                              isProject && projs.length
                                ? h('div', { className: 'zcl-meta-row top' },
                                    h('span', { className: 'zcl-meta-k' }, '工程缓存'),
                                    h('div', { className: 'zcl-meta-projs' },
                                      projs.map((p) => h('div', { className: 'zcl-projline', key: p.id },
                                        h('span', { className: 'zcl-proj-name' }, p.name),
                                        h('span', { className: 'zcl-proj-path mono' }, (p.locByMachine && p.locByMachine[String(n.machineId)]) || p.root)))))
                                : h('div', { className: 'zcl-meta-row' },
                                    h('span', { className: 'zcl-meta-k' }, '配置'),
                                    h('span', { className: 'zcl-meta-v mono' }, '用户全局 · UserEngine.ini')))));
                      })));
            })()))));
  }

  window.VOLO_CACHE_ZEN = { view: (s) => h(ZenServer, { s }) };
})();

export {};
