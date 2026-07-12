// @ts-nocheck
/* Volo — Cache · 文件系统 DDC · ② 其他服务器加入共享 DDC · 每台机器「共享 DDC 配置通道详情」
   1:1 port of the Claude Design handoff `src/cache_ddc_schan.jsx`，接真实后端。

   与 ③ 本地 DDC 通道详情同一套视觉语言（折叠展开 / 优先级排序 / 徽章体系）。四条通道：
     1 工程 INI（DefaultEngine.ini · [DerivedDataBackendGraph] Shared 节点的 Path / EnvPathOverride，
       每台机器上可能有多个 UE 工程，逐工程读出——真实拆两个字段展示，而不是设计稿 mock 里
       每个工程只挑一个字段：Path 是真正的 UNC 目标，EnvPathOverride 决定环境变量通道是否生效
       （不写它 UE 会忽略同名环境变量），两者独立可写，混在一起会丢诊断信息）
     2 命令行参数 -SharedDataCachePath（只读 · 仅展示扫描发现的宿主）
     3 注册表 HKCU\Epic Games\GlobalDataCachePath · UE-SharedDataCachePath
     4 环境变量 UE-SharedDataCachePath（机器级）
   值状态：set / unset / error（未核对）/ dead（路径失效——配置的 UNC 共享当前不可达）。
   优先级数字沿用与 ③ 本地 DDC 相同的 1(最高)–4 展示顺序，只影响「当前生效/被覆盖」徽章的
   呈现，不改变 UE 引擎真实解析行为（cacheDdc.tsx 的 join/leave 已经在按这套通道语义读写）。

   与设计稿的差异（mock → 真实后端后必须补的部分，非视觉改动）：
   - channelsForShared 从同步 mock 换成异步并发拉取（Promise.allSettled）：env / 注册表 / 命令行
     各一路 + 该机每个工程各一路 get_machine_backend_field；单路失败独立映射「未核对」。
   - 新增「路径失效」探测：对全部 st==='set' 的路径类字段（env / reg / cmd / 每个工程的 Path，
     EnvPathOverride 不是路径值不探测）去重后并发 test_path_reachable，命中不可达的降级为 'dead'。
   - ChanPanelShared 新增单字段 commit 态（committing/commitErr），同 cacheDdcChan 的真实网络往返
     处理。 */
import * as React from "react";
import {
  getMachineEnvVar, setMachineEnvVar,
  getDdcRegistryOverrides, setDdcRegistrySharedPath,
  getMachineBackendField, setMachineBackendField, removeMachineBackendField,
  scanCommandLineArgs, testPathReachable,
} from "../api/commands";

(function () {
  const { useState } = React;
  const h = React.createElement;

  const ENV_KEY = 'UE-SharedDataCachePath';
  const BACKEND_SECTION = 'DerivedDataBackendGraph';
  const BACKEND_NODE = 'Shared';

  /* 通道定义（prio 1 = 最高优先级，展示顺序沿用与 ③ 本地 DDC 相同的语言） */
  const SCHAN_DEFS = [
    { key: 'ini', prio: 1, name: '工程 INI', writable: true, perProject: true,
      srcZh: '来源', srcMono: 'DefaultEngine.ini · [DerivedDataBackendGraph] Shared Path / EnvPathOverride' },
    { key: 'cmd', prio: 2, name: '命令行参数', writable: false,
      srcZh: '来源 · 快捷方式 / bat / 服务', srcMono: '-SharedDataCachePath' },
    { key: 'reg', prio: 3, name: '注册表', writable: true,
      srcZh: '来源', srcMono: 'HKCU\\Epic Games\\GlobalDataCachePath · ' + ENV_KEY },
    { key: 'env', prio: 4, name: '环境变量', writable: true,
      srcZh: '来源', srcMono: ENV_KEY, srcZh2: '（机器级）' },
  ];

  const errMsg = (e) => (e && e.message) ? e.message : String(e == null ? '未知错误' : e);
  /* 命令行扫描来源 → 中文标签（CmdLineHit.source，见 command_line_scanner.rs），与
     cacheDdcChan 同一份映射。 */
  const CMD_SRC_LABEL = { shortcut: '启动快捷方式', bat: 'bat 脚本', service: '服务' };
  const unverifiedReason = (msg) => {
    if (/ue_runtime_user/i.test(msg)) return '未核对（先在①填「UE 运行用户」）';
    if (/not logged on/i.test(msg)) return '未核对（该用户未登录，读不到其注册表）';
    if (/未发现 UE 引擎安装/.test(msg)) return '未核对（未发现 UE 引擎安装）';
    return '未核对（' + msg + '）';
  };

  const iniPathFor = (p, mid) => {
    const base = (p.locByMachine && p.locByMachine[String(mid)]) || p.root;
    return String(base).replace(/\\+$/, '') + '\\Config\\DefaultEngine.ini';
  };

  /* get_machine_backend_field 保留字段名原始大小写不做归一化（同一份 fields map 里
     get_field/upsert_field/remove_field 全走大小写不敏感匹配——手改过 ini 或历史工具写出
     的 path=/envpathoverride= 键都合法）；这里必须用同一套大小写不敏感的查找，否则手改
     大小写的现网配置会被误判成「未设」。 */
  const fieldCI = (fields, name) => {
    if (!fields) return undefined;
    if (fields[name] !== undefined) return fields[name];
    const key = Object.keys(fields).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? fields[key] : undefined;
  };

  /* 真实拉取：并发读三路机器级通道 + 该机每个工程各一路 ini 通道，单路失败独立映射
     「未核对」，不拖垮其余通道；再对全部「已设」的路径类字段去重后并发探测可达性，
     命中不可达的一律降级为 'dead'（路径失效）。node 需要真实 machineId（离线/尚未对齐
     真实机器 → 返回 null，展开区走「离线」占位，同 cacheDdcChan.channelsFor 的判断）。 */
  async function channelsForShared(node) {
    if (node.status === 'offline' || node.machineId == null || node.machineId === 0) return null;
    const mid = node.machineId;
    const projs = (UE_PROJECTS || []).filter((p) => (p.machines || []).includes(String(mid)));

    const [envR, regR, cmdR, ...iniResults] = await Promise.allSettled([
      getMachineEnvVar(mid, ENV_KEY),
      getDdcRegistryOverrides(mid),
      scanCommandLineArgs(mid),
      ...projs.map((p) => getMachineBackendField(mid, iniPathFor(p, mid), BACKEND_SECTION, BACKEND_NODE)),
    ]);

    const env = envR.status === 'fulfilled'
      ? (envR.value ? { v: envR.value, st: 'set' } : { v: null, st: 'unset' })
      : { v: null, st: 'error', reason: unverifiedReason(errMsg(envR.reason)) };

    const reg = regR.status === 'fulfilled'
      ? (regR.value.shared_path ? { v: regR.value.shared_path, st: 'set' } : { v: null, st: 'unset' })
      : { v: null, st: 'error', reason: unverifiedReason(errMsg(regR.reason)) };

    let cmd;
    if (cmdR.status === 'fulfilled') {
      const hit = cmdR.value.find((x) => x.matches && x.matches.shared);
      cmd = hit
        ? { v: hit.matches.shared, st: 'set',
            host: (CMD_SRC_LABEL[hit.source] || hit.source) + ' · ' + (hit.name || String(hit.path || '').split(/[\\/]/).pop()) }
        : { v: null, st: 'unset' };
    } else {
      cmd = { v: null, st: 'error', reason: unverifiedReason(errMsg(cmdR.reason)) };
    }

    const projects = projs.map((p, i) => {
      const r = iniResults[i];
      if (r.status !== 'fulfilled') {
        const reason = unverifiedReason(errMsg(r.reason));
        return { projectId: p.id, projectName: p.name,
          path: { v: null, st: 'error', reason }, envOverride: { v: null, st: 'error', reason } };
      }
      const f = r.value.fields || {};
      const path = fieldCI(f, 'Path');
      const envOverride = fieldCI(f, 'EnvPathOverride');
      return {
        projectId: p.id, projectName: p.name,
        path: path ? { v: path, st: 'set' } : { v: null, st: 'unset' },
        envOverride: envOverride ? { v: envOverride, st: 'set' } : { v: null, st: 'unset' },
      };
    });

    /* 路径失效探测：EnvPathOverride 不是路径值（只是「哪个 env var 生效」的开关名字），
       不参与探测——只测 env / reg / cmd / 每个工程的 Path。同值去重，命中结果原地回写
       进同一批引用对象（这些 field 对象本身就是下面 return 结构里的实例）。 */
    const candidates = [env, reg, cmd].filter((c) => c.st === 'set');
    projects.forEach((p) => { if (p.path.st === 'set') candidates.push(p.path); });
    const uniquePaths = Array.from(new Set(candidates.map((c) => c.v)));
    if (uniquePaths.length) {
      const results = await Promise.allSettled(uniquePaths.map((path) => testPathReachable(mid, path)));
      const dead = new Set(uniquePaths.filter((_, i) => results[i].status === 'fulfilled' && results[i].value === false));
      candidates.forEach((c) => { if (dead.has(c.v)) c.st = 'dead'; });
    }

    return { ini: { projects }, cmd, reg, env };
  }

  /* ini 竞争值 = 该机全部工程 Path 字段里第一条已设/已失效的（EnvPathOverride 只是开关，
     不是路径本身，不参与跨通道竞争）。 */
  const iniLead = (ch) => {
    const paths = (ch.ini.projects || []).map((p) => p.path);
    return paths.find((v) => v.st === 'set' || v.st === 'dead') || paths[0] || { v: null, st: 'unset' };
  };
  const isPresent = (val) => !!val && (val.st === 'set' || val.st === 'dead');
  const competing = (ch) => ({ ini: iniLead(ch), cmd: ch.cmd, reg: ch.reg, env: ch.env });
  const effectiveKeyShared = (ch) => {
    const c = competing(ch);
    for (const d of SCHAN_DEFS) if (isPresent(c[d.key])) return d.key;
    return null;
  };
  /* 该机是否存在任何共享 DDC 配置（error/未核对 不计为可清理配置） */
  const hasAnySharedConfig = (ch) => {
    if (!ch) return false;
    if ((ch.ini.projects || []).some((p) => isPresent(p.path) || isPresent(p.envOverride))) return true;
    return isPresent(ch.cmd) || isPresent(ch.reg) || isPresent(ch.env);
  };
  const hasDeadShared = (ch) => {
    if (!ch) return false;
    if ((ch.ini.projects || []).some((p) => p.path.st === 'dead')) return true;
    return [ch.cmd, ch.reg, ch.env].some((v) => v && v.st === 'dead');
  };
  /* 清理时列出的具体条目（通道名 + 当前值）—— 命令行只读，不纳入清理；供行级「清除配置」
     与模块级「一键清空所有配置」共用。 */
  function clearableEntries(ch) {
    if (!ch) return [];
    const out = [];
    (ch.ini.projects || []).forEach((p) => {
      if (isPresent(p.path)) out.push({ chan: '工程 INI · ' + p.projectName + ' · Path', val: p.path.v, key: 'ini', sub: p.projectId + '#path' });
      if (isPresent(p.envOverride)) out.push({ chan: '工程 INI · ' + p.projectName + ' · EnvPathOverride', val: p.envOverride.v, key: 'ini', sub: p.projectId + '#envOverride' });
    });
    if (isPresent(ch.reg)) out.push({ chan: '注册表 · GlobalDataCachePath', val: ch.reg.v, key: 'reg', sub: null });
    if (isPresent(ch.env)) out.push({ chan: '环境变量 · ' + ENV_KEY, val: ch.env.v, key: 'env', sub: null });
    return out;
  }

  /* 真实写入路由：(node, key, sub, value) → 对应真实 invoke。ini 的 sub 编码为
     "<projectId>#path" | "<projectId>#envOverride"（用 # 而不是 . 分隔，避免和
     ChanPanelShared 就地编辑用的 edit-key `key + '.' + sub` 拆分冲突——sub 本身
     不能再含 '.'）。value === '' 走清除（remove_machine_backend_field），非空走
     设置（set_machine_backend_field），与本地 ini 通道一致。 */
  const writeChannel = (node, key, sub, value) => {
    const mid = node.machineId;
    if (key === 'env') return setMachineEnvVar(mid, ENV_KEY, value);
    if (key === 'reg') return setDdcRegistrySharedPath(mid, value);
    if (key === 'ini') {
      const [projId, field] = String(sub).split('#');
      const p = (UE_PROJECTS || []).find((x) => String(x.id) === String(projId));
      if (!p) return Promise.reject(new Error('工程不存在或已被移除'));
      const ini = iniPathFor(p, mid);
      const backendField = field === 'envOverride' ? 'EnvPathOverride' : 'Path';
      return value
        ? setMachineBackendField(mid, ini, BACKEND_SECTION, BACKEND_NODE, backendField, value)
        : removeMachineBackendField(mid, ini, BACKEND_SECTION, BACKEND_NODE, backendField);
    }
    return Promise.reject(new Error('通道 ' + key + ' 不可写'));
  };

  /* 批量安全写入（供②行级「清除配置」/ 模块级「一键清空 / 批量清除所选」用）：同一工程的
     Path 与 EnvPathOverride 落在同一份 DefaultEngine.ini 文件里，底层 set/remove-backend-
     field.ps1 是无锁整文件读改写——并发写同一文件会互相覆盖丢失其中一次修改。按
     「机器 + 目标文件」分组串行执行，不同文件 / 不同机器之间仍然并行；返回形状对齐
     Promise.allSettled，调用方原有的 rs.filter(r => r.status==='rejected') 逻辑不用改。
     entries 项：{ node, key, sub, value }。 */
  async function writeEntriesSafely(entries) {
    const groups = new Map();
    entries.forEach((e) => {
      const gk = e.node.id + '|' + (e.key === 'ini' ? 'ini:' + String(e.sub).split('#')[0] : e.key + ':' + (e.sub || ''));
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(e);
    });
    const perGroup = await Promise.all(Array.from(groups.values()).map(async (group) => {
      const results = [];
      for (const e of group) {
        try { results.push({ status: 'fulfilled', value: await writeChannel(e.node, e.key, e.sub, e.value) }); }
        catch (err) { results.push({ status: 'rejected', reason: err }); }
      }
      return results;
    }));
    return perGroup.flat();
  }

  /* =================== ChanPanelShared — 展开后的四通道区 =================== */
  function ChanPanelShared({ node, ch, loading, onSet, onClear }) {
    const [edit, setEdit] = useState(null);    /* 'ini.<projId>#path' | 'reg' | 'env' … */
    const [draft, setDraft] = useState('');
    const [committing, setCommitting] = useState(null); /* ek 正在提交（保存/清除中）*/
    const [commitErr, setCommitErr] = useState(null);    /* { ek, msg } */

    /* 离线/拉取失败：统一占位——仅在「确定不是还在加载」时才判定，同 cacheDdcChan
       的理由（避免刚展开、数据还没到达的一瞬间被误判成离线）。 */
    if (!ch && !loading) return h('div', { className: 'chan-panel' },
      h('div', { className: 'chan-offline' }, h(Icon, { name: 'power', size: 16 }), '离线，无法读取配置通道'));
    const safeCh = ch || { ini: { projects: [] }, cmd: { v: null, st: 'unset' }, reg: { v: null, st: 'unset' }, env: { v: null, st: 'unset' } };
    const effKey = loading ? null : effectiveKeyShared(safeCh);
    const startEdit = (ek, cur) => { setDraft(cur || ''); setEdit(ek); setCommitErr(null); };
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

    /* 三通道状态徽章（色 + 图标 + 文字）—— 含「路径失效」状态 */
    const badge = (key, val) => {
      if (loading) return h('span', { className: 'chan-badge load' }, h(Icon, { name: 'sync', size: 11 }), '读取中');
      if (val.st === 'error') return h('span', { className: 'chan-badge err' }, h(Icon, { name: 'alert', size: 11 }), '未核对');
      if (val.st === 'unset') return h('span', { className: 'chan-badge unset' }, h(Icon, { name: 'minus', size: 11 }), '未设');
      if (val.st === 'dead') return h('span', { className: 'chan-badge dead' }, h(Icon, { name: 'alert', size: 11 }), '路径失效');
      if (key === effKey) return h('span', { className: 'chan-badge eff' }, h(Icon, { name: 'check', size: 11 }), '当前生效');
      return h('span', { className: 'chan-badge over' }, h(Icon, { name: 'layers', size: 11 }), '被覆盖');
    };

    const valView = (val, ek) => {
      if (loading) return h('div', { className: 'chan-sk' });
      if (edit === ek) {
        const busy = committing === ek;
        return h('div', { className: 'chan-edit' },
          h('input', { value: draft, autoFocus: true, spellCheck: false, disabled: busy, placeholder: '输入共享 DDC 路径（UNC）',
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') commit(ek); if (e.key === 'Escape') closeEdit(); } }),
          h('button', { className: 'mini-btn accent', disabled: busy, onClick: () => commit(ek) },
            busy ? h(Icon, { name: 'sync', size: 12 }) : h(Icon, { name: 'check', size: 12 }), busy ? '保存中…' : '保存'),
          h('button', { className: 'mini-btn', disabled: busy, onClick: closeEdit }, '取消'));
      }
      if (val.st === 'error') return h('div', { className: 'chan-val err' }, h(Icon, { name: 'alert', size: 12 }), '未核对');
      if (val.st === 'unset') return h('div', { className: 'chan-val unset' }, '未设');
      if (val.st === 'dead') return h('div', { className: 'chan-val dead', title: val.v },
        h(Icon, { name: 'alert', size: 12 }), h('span', { className: 'dv' }, val.v), h('span', { className: 'dtag' }, '共享不可达'));
      return h('div', { className: 'chan-val', title: val.v }, val.v);
    };

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

    const field = (label, val, ek, writable) => h('div', { className: 'chan-field', key: ek },
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
      const isEff = !loading && d.key === effKey && val.st !== 'dead';
      let body;
      if (d.perProject) {          /* 工程 INI：按工程逐条，每条工程拆 Path + EnvPathOverride 两个字段 */
        const projects = safeCh.ini.projects || [];
        body = h('div', { className: 'chan-fields' },
          projects.length ? projects.map((p) => h(React.Fragment, { key: p.projectId },
            field(p.projectName + ' · Path', p.path, 'ini.' + p.projectId + '#path', true),
            field(p.projectName + ' · EnvPathOverride', p.envOverride, 'ini.' + p.projectId + '#envOverride', true)))
            : h('div', { className: 'chan-noproj' }, '该机器暂无已扫描到的 UE 工程'));
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
      SCHAN_DEFS.map(chanRow),
      h('div', { className: 'chan-note' }, h(Icon, { name: 'info', size: 13 }),
        '按优先级顺序解析，高优先级通道非空时覆盖低优先级；标「路径失效」表示配置的 UNC 共享当前不可达，多为历史部署 / 手工残留的死配置，建议清理。'));
  }

  window.VOLO_DDC_SCHAN = {
    ENV_KEY, SCHAN_DEFS, channelsForShared, effectiveKeyShared, hasAnySharedConfig, hasDeadShared,
    clearableEntries, isPresent, writeChannel, writeEntriesSafely, ChanPanelShared,
  };
})();

export {};
