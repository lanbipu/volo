// @ts-nocheck
/* Volo — Cache · 文件系统 DDC · ③ 本地 DDC · 每台机器「DDC 配置通道详情」
   1:1 port of the Claude Design handoff `src/cache_ddc_chan.jsx`，接真实后端。

   四条配置通道按优先级从高到低解析本地 DDC 路径（真实生效顺序见
   FFileSystemCacheStoreParams::Parse，Engine/Source/Developer/DerivedDataCache/
   Private/FileSystemCacheStore.cpp——越后检查的越高优先级）：
     1 EditorSettings ini 键（最高，getDdcIniOverrides）
     2 命令行参数（只读 · 仅展示扫描发现的宿主，scanCommandLineArgs）
     3 注册表 HKCU\Epic Games\GlobalDataCachePath（getDdcRegistryOverrides）
     4 环境变量 UE-LocalDataCachePath（机器级，getMachineEnvVar）
   状态遵循「色 + 图标 + 文字」三通道；暗/亮主题沿用 data-theme token。

   与设计稿的差异（mock → 真实后端后必须补的部分，非视觉改动）：
   - channelsFor 从同步 mock 换成异步并发拉取四路真实数据（Promise.allSettled，
     单路失败不拖垮其它三路，映射进「未核对 · 原因」而不是笼统报错）。
   - ChanPanel 新增单字段 commit 态（committing/commitErr）：mock 版 onSet/onClear
     是同步 void 回调，真实网络往返需要「保存中…」按钮态 + 失败原因兜底，否则用户
     点「保存」后数秒内界面像没反应。 */
import * as React from "react";
import {
  getMachineEnvVar, setMachineEnvVar,
  getDdcRegistryOverrides, setDdcRegistryLocalPath,
  getDdcIniOverrides, setDdcIniPath,
  scanCommandLineArgs,
} from "../api/commands";

(function () {
  const { useState } = React;
  const h = React.createElement;

  /* 通道定义（prio 1 = 最高优先级） */
  const CHAN_DEFS = [
    { key: 'ini', prio: 1, name: 'EditorSettings ini 键', writable: true, split: true,
      srcZh: '来源', srcMono: 'EditorSettings.ini · LocalDerivedDataCache' },
    { key: 'cmd', prio: 2, name: '命令行参数', writable: false,
      srcZh: '来源 · 快捷方式 / bat / 服务', srcMono: '-LocalDataCachePath' },
    { key: 'reg', prio: 3, name: '注册表', writable: true,
      srcZh: '来源', srcMono: 'HKCU\\Epic Games\\GlobalDataCachePath' },
    { key: 'env', prio: 4, name: '环境变量', writable: true,
      srcZh: '来源', srcMono: 'UE-LocalDataCachePath', srcZh2: '（机器级）' },
  ];

  const errMsg = (e) => (e && e.message) ? e.message : String(e == null ? '未知错误' : e);
  /* 命令行扫描来源 → 中文标签（CmdLineHit.source，见 command_line_scanner.rs）*/
  const CMD_SRC_LABEL = { shortcut: '启动快捷方式', bat: 'bat 脚本', service: '服务' };

  /* 单个探测源失败时的「未核对」原因文案：优先复用 machineDetail⑤ 已有的两条先例
     （缺 UE 运行用户 / 该用户未登录），其余原样透传后端错误信息。 */
  const unverifiedReason = (msg) => {
    if (/ue_runtime_user/i.test(msg)) return '未核对（先在①填「UE 运行用户」）';
    if (/not logged on/i.test(msg)) return '未核对（该用户未登录，读不到其注册表）';
    if (/未发现 UE 引擎安装/.test(msg)) return '未核对（未发现 UE 引擎安装）';
    return '未核对（' + msg + '）';
  };

  /* 真实拉取：并发读四路通道，单路失败独立映射「未核对」，不拖垮其余三路。
     node 需要真实 machineId（离线 / 尚未对齐真实机器 → 返回 null，展开区走「离线」占位，
     与 LegacyView 其余处「machineId == null → 视为未就绪」的判断一致）。 */
  async function channelsFor(node) {
    if (node.status === 'offline' || node.machineId == null || node.machineId === 0) return null;
    const mid = node.machineId;
    const [envR, regR, iniR, cmdR] = await Promise.allSettled([
      getMachineEnvVar(mid, 'UE-LocalDataCachePath'),
      getDdcRegistryOverrides(mid),
      getDdcIniOverrides(mid),
      scanCommandLineArgs(mid),
    ]);

    const env = envR.status === 'fulfilled'
      ? (envR.value ? { v: envR.value, st: 'set' } : { v: null, st: 'unset' })
      : { v: null, st: 'error', reason: unverifiedReason(errMsg(envR.reason)) };

    const reg = regR.status === 'fulfilled'
      ? (regR.value.local_path ? { v: regR.value.local_path, st: 'set' } : { v: null, st: 'unset' })
      : { v: null, st: 'error', reason: unverifiedReason(errMsg(regR.reason)) };

    let iniLocal, iniShared;
    if (iniR.status === 'fulfilled') {
      iniLocal = iniR.value.local_path ? { v: iniR.value.local_path, st: 'set' } : { v: null, st: 'unset' };
      iniShared = iniR.value.shared_path ? { v: iniR.value.shared_path, st: 'set' } : { v: null, st: 'unset' };
    } else {
      const reason = unverifiedReason(errMsg(iniR.reason));
      iniLocal = { v: null, st: 'error', reason };
      iniShared = { v: null, st: 'error', reason };
    }

    let cmd;
    if (cmdR.status === 'fulfilled') {
      const hit = cmdR.value.find((x) => x.matches && x.matches.local);
      cmd = hit
        ? { v: hit.matches.local, st: 'set',
            host: (CMD_SRC_LABEL[hit.source] || hit.source) + ' · ' + (hit.name || String(hit.path || '').split(/[\\/]/).pop()) }
        : { v: null, st: 'unset' };
    } else {
      cmd = { v: null, st: 'error', reason: unverifiedReason(errMsg(cmdR.reason)) };
    }

    return { ini: { local: iniLocal, shared: iniShared }, cmd, reg, env };
  }

  /* 竞争本地路径的取值（ini 取 local 子字段） */
  const competing = (ch) => ({ ini: ch.ini.local, cmd: ch.cmd, reg: ch.reg, env: ch.env });
  const effectiveKey = (ch) => {
    const c = competing(ch);
    for (const d of CHAN_DEFS) if (c[d.key] && c[d.key].st === 'set') return d.key;
    return null;
  };

  /* 可清除的本地通道条目（命令行只读，不纳入）—— 供模块头部「一键清空所有配置」用 */
  const LOCAL_ENTRY_LABEL = { 'ini.local': '本地 · LocalDerivedDataCache', 'ini.shared': '共享上游 · SharedDerivedDataCache',
    reg: '注册表 · GlobalDataCachePath', env: '环境变量 · UE-LocalDataCachePath' };
  function clearableLocalEntries(ch) {
    if (!ch) return [];
    const out = [];
    if (ch.ini.local && ch.ini.local.st === 'set') out.push({ chan: LOCAL_ENTRY_LABEL['ini.local'], val: ch.ini.local.v, key: 'ini', sub: 'local' });
    if (ch.ini.shared && ch.ini.shared.st === 'set') out.push({ chan: LOCAL_ENTRY_LABEL['ini.shared'], val: ch.ini.shared.v, key: 'ini', sub: 'shared' });
    if (ch.reg && ch.reg.st === 'set') out.push({ chan: LOCAL_ENTRY_LABEL.reg, val: ch.reg.v, key: 'reg', sub: null });
    if (ch.env && ch.env.st === 'set') out.push({ chan: LOCAL_ENTRY_LABEL.env, val: ch.env.v, key: 'env', sub: null });
    return out;
  }
  const hasAnyLocalConfig = (ch) => clearableLocalEntries(ch).length > 0;

  /* 真实写入路由：ChanPanel 只认 (key, sub) 语义，实际 API 选择交给调用方
     （LegacyView 的 onSetChan/onClearChan），这里只是把 (key,sub,value) 映射到对应
     真实 invoke，返回 Promise 供 ChanPanel 展示 commit 中 / 失败态。 */
  const writeChannel = (node, key, sub, value) => {
    const mid = node.machineId;
    if (key === 'env') return setMachineEnvVar(mid, 'UE-LocalDataCachePath', value);
    if (key === 'reg') return setDdcRegistryLocalPath(mid, value);
    if (key === 'ini') return setDdcIniPath(mid, sub, value);
    return Promise.reject(new Error('通道 ' + key + ' 不可写'));
  };

  /* =================== ChanPanel — 展开后的四通道区 =================== */
  function ChanPanel({ node, ch, loading, onSet, onClear }) {
    const [edit, setEdit] = useState(null);    /* 'ini.local' | 'reg' | 'env' … */
    const [draft, setDraft] = useState('');
    const [committing, setCommitting] = useState(null); /* ek 正在提交（保存/清除中）*/
    const [commitErr, setCommitErr] = useState(null);    /* { ek, msg } */

    /* 离线 / 拉取失败：统一占位——但仅在「确定不是还在加载」时才判定，否则展开一台
       从未刷新过的在线机器会在数据到达前的一瞬间被误判成「离线」（chanData 还没这台
       机器的 key，ch 是 undefined，跟真离线的 null 长得一样）。 */
    if (!ch && !loading) return h('div', { className: 'chan-panel' },
      h('div', { className: 'chan-offline' }, h(Icon, { name: 'power', size: 16 }), '离线，无法读取配置通道'));
    /* loading 期间 ch 可能还是 undefined（首次展开）——喂一个占位形状给下面的字段渲染，
       避免 ch.ini.local 之类访问在数据到达前抛错；skeleton 完全由 loading 驱动，不看值。 */
    const EMPTY_FIELD = { v: null, st: 'unset' };
    const safeCh = ch || { ini: { local: EMPTY_FIELD, shared: EMPTY_FIELD }, cmd: EMPTY_FIELD, reg: EMPTY_FIELD, env: EMPTY_FIELD };
    const effKey = loading ? null : effectiveKey(safeCh);
    const startEdit = (ek, cur) => { setDraft(cur || ''); setEdit(ek); setCommitErr(null); };
    /* 取消编辑：连同 commitErr 一起清（不止 edit）——否则上一次保存失败留下的
       「未核对/保存失败」提示会在编辑框收起后一直悬挂在字段下方，直到用户重新点
       「修改/设置」才被 startEdit 清掉，即便当前显示值本身完全正常。 */
    const closeEdit = () => { setEdit(null); setCommitErr(null); };
    const commit = (ek) => {
      const p = ek.split('.');
      setCommitting(ek); setCommitErr(null);
      Promise.resolve(onSet(node, p[0], p[1] || null, draft.trim()))
        .then(() => { setEdit(null); setCommitting(null); },
              (e) => { setCommitting(null); setCommitErr({ ek, msg: errMsg(e) }); });
    };
    const doClear = (ek) => {
      setCommitting(ek); setCommitErr(null);
      Promise.resolve(onClear(node, ek.split('.')[0], ek.split('.')[1] || null))
        .then(() => setCommitting(null),
              (e) => { setCommitting(null); setCommitErr({ ek, msg: errMsg(e) }); });
    };

    /* 三通道状态徽章（色 + 图标 + 文字） */
    const badge = (key, val) => {
      if (loading) return h('span', { className: 'chan-badge load' }, h(Icon, { name: 'sync', size: 11 }), '读取中');
      if (val.st === 'error') return h('span', { className: 'chan-badge err' }, h(Icon, { name: 'alert', size: 11 }), '未核对');
      if (val.st === 'unset') return h('span', { className: 'chan-badge unset' }, h(Icon, { name: 'minus', size: 11 }), '未设');
      if (key === effKey) return h('span', { className: 'chan-badge eff' }, h(Icon, { name: 'check', size: 11 }), '当前生效');
      return h('span', { className: 'chan-badge over' }, h(Icon, { name: 'layers', size: 11 }), '被覆盖');
    };

    /* 值显示（skeleton / 编辑态 / 未核对 / 未设 / 路径） */
    const valView = (val, ek) => {
      if (loading) return h('div', { className: 'chan-sk' });
      if (edit === ek) {
        const busy = committing === ek;
        return h('div', { className: 'chan-edit' },
          h('input', { value: draft, autoFocus: true, spellCheck: false, disabled: busy, placeholder: '输入本地 DDC 路径',
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') commit(ek); if (e.key === 'Escape') closeEdit(); } }),
          h('button', { className: 'mini-btn accent', disabled: busy, onClick: () => commit(ek) },
            busy ? h(Icon, { name: 'sync', size: 12 }) : h(Icon, { name: 'check', size: 12 }), busy ? '保存中…' : '保存'),
          h('button', { className: 'mini-btn', disabled: busy, onClick: closeEdit }, '取消'));
      }
      if (val.st === 'error') return h('div', { className: 'chan-val err' }, h(Icon, { name: 'alert', size: 12 }), '未核对');
      if (val.st === 'unset') return h('div', { className: 'chan-val unset' }, '未设');
      return h('div', { className: 'chan-val', title: val.v }, val.v);
    };

    /* 可写字段操作按钮组 */
    const acts = (val, ek) => {
      if (loading || edit === ek) return null;
      const busy = committing === ek;
      if (val.st === 'unset' || val.st === 'error') return h('div', { className: 'fa' },
        h('button', { className: 'mini-btn', disabled: busy, onClick: () => startEdit(ek, '') }, h(Icon, { name: 'plus', size: 12 }), '设置'));
      return h('div', { className: 'fa' },
        h('button', { className: 'mini-btn', disabled: busy, onClick: () => startEdit(ek, val.v) }, h(Icon, { name: 'settings', size: 12 }), '修改'),
        h('button', { className: 'mini-btn danger', disabled: busy, onClick: () => doClear(ek) },
          busy ? h(Icon, { name: 'sync', size: 12 }) : h(Icon, { name: 'trash', size: 12 }), busy ? '清除中…' : '清除'));
    };

    /* 单个可写字段：label + 值 + 操作 + 失败原因（探测失败原因 / 本次提交失败原因） */
    const field = (label, val, ek, writable) => h('div', { className: 'chan-field' },
      h('span', { className: 'fl' }, label),
      h('div', { className: 'fv' }, valView(val, ek)),
      writable ? acts(val, ek) : null,
      (!loading && val.st === 'error' && val.reason)
        ? h('div', { className: 'chan-err-reason' }, h(Icon, { name: 'alert', size: 11 }), val.reason) : null,
      (commitErr && commitErr.ek === ek)
        ? h('div', { className: 'chan-err-reason' }, h(Icon, { name: 'alert', size: 11 }), commitErr.msg) : null);

    const srcLine = (d) => h('div', { className: 'chan-src' },
      h('span', { className: 'zh' }, d.srcZh), h('span', { className: 'mono' }, d.srcMono),
      d.srcZh2 ? h('span', { className: 'zh' }, d.srcZh2) : null);

    const chanRow = (d) => {
      const val = competing(safeCh)[d.key];
      const isEff = !loading && d.key === effKey;
      let body;
      if (d.split) {          /* ini：本地 + 共享上游 两个并排字段 */
        body = h('div', { className: 'chan-fields' },
          field('本地 · LocalDerivedDataCache', safeCh.ini.local, 'ini.local', true),
          field('共享上游 · SharedDerivedDataCache', safeCh.ini.shared, 'ini.shared', true));
      } else if (!d.writable) {   /* 命令行：只读，展示扫描发现的宿主 */
        body = h('div', { className: 'chan-fields' },
          h('div', { className: 'chan-field' },
            h('span', { className: 'fl' }, '启动参数值'),
            h('div', { className: 'fv' }, valView(val, 'cmd')),
            h('span', { className: 'chan-ro' }, h(Icon, { name: 'eye', size: 11 }), '只读'),
            (!loading && val.st === 'error' && val.reason)
              ? h('div', { className: 'chan-err-reason' }, h(Icon, { name: 'alert', size: 11 }), val.reason) : null),
          (!loading && val.st === 'set' && val.host)
            ? h('div', { className: 'chan-hosthint' }, h(Icon, { name: 'search', size: 11 }), '扫描发现宿主 · ' + val.host) : null);
      } else {
        body = h('div', { className: 'chan-fields' }, field('路径值', val, d.key, true));
      }
      return h('div', { className: 'chan-row' + (isEff ? ' eff' : ''), key: d.key },
        h('div', { className: 'chan-top' },
          h('span', { className: 'chan-prio', title: '优先级 ' + d.prio + '（1 最高）' }, d.prio),
          h('span', { className: 'chan-name' }, d.name),
          h('span', { className: 'chan-badge-wrap' }, badge(d.key, val))),
        srcLine(d),
        body);
    };

    return h('div', { className: 'chan-panel' },
      CHAN_DEFS.map(chanRow),
      h('div', { className: 'chan-note' }, h(Icon, { name: 'info', size: 13 }),
        '按优先级顺序解析，高优先级通道非空时覆盖低优先级；实际生效以引擎启动日志为准。'));
  }

  window.VOLO_DDC_CHAN = { CHAN_DEFS, channelsFor, effectiveKey, writeChannel, clearableLocalEntries, hasAnyLocalConfig, ChanPanel };
})();
