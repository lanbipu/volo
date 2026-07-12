// @ts-nocheck
/* Volo — Cache · 集群 UE 工程扫描（中立共享）
   ------------------------------------------------------------------
   discover_projects / 打开工程文件夹 / 源机选取等与业务页无关的集群工程清单能力。
   DDC PAK 与 PSO 各自独立入口与收藏根目录，均 ES import 本模块（禁止经 VOLO_CACHE_DDC 间接调用）。

   工程清单仍是集群级共享资源（window.UE_PROJECTS / SQLite projects）：任一页扫成功都会刷新同一份清单。 */
import {
  discoverProjects, revealPath, isLoopbackMachine, revealRemotePath, ensureOpenDirShare,
} from "../api/commands";

const CX = window.VOLO_CX;
const nodes = () => window.RENDER_NODES || [];
const DISCOVER_NOTE = '远程扫描 UE 工程（.uproject）';

export const humanBytes = (b) => b == null ? '—'
  : b >= 1e9 ? (b / 1073741824).toFixed(1) + ' GB'
  : b >= 1e6 ? (b / 1048576).toFixed(0) + ' MB'
  : (b / 1024).toFixed(0) + ' KB';

/* 优先工程 primary，离线则回退任一在线机。 */
export const pickSrc = (p) => {
  if (!p) return null;
  const prim = CX.node(p.primary);
  if (prim && prim.status !== 'offline') return prim;
  return nodes().find((n) => (p.machines || []).includes(n.id) && n.status !== 'offline') || prim || null;
};

export const scopeOpts = () => {
  const online = nodes().filter((n) => n.status !== 'offline');
  return [{ id: 'all', label: '全部在线机' }]
    .concat(online.map((n) => ({ id: n.id, label: n.host, sub: n.ip })));
};

/* 派可见失败任务（避免按钮像没反应）。返回 undefined，调用方用 falsy 跳过成功路径。 */
const failDiscover = (s, err) => {
  s.runCmd({ domain: 'project', action: 'discover', target: '—', chan: 'ssh', note: DISCOVER_NOTE },
    () => Promise.reject(err instanceof Error ? err : new Error(String(err))), {})
    .catch(() => {});
};

/* scope='all' 时对全部在线机 fan-out；无根目录 / 无在线机时 failDiscover 后 return（不返回 promise）。 */
export const runDiscover = (s, scope, rootsStr) => {
  const roots = (rootsStr || '').split(';').map((r) => r.trim()).filter(Boolean);
  if (!roots.length) { failDiscover(s, new Error('请先添加搜索根目录')); return; }
  const scopeNode = scope === 'all' ? null : CX.node(scope);
  const targets = scope === 'all'
    ? nodes().filter((n) => n.status !== 'offline').map((n) => n.machineId)
    : [scopeNode ? scopeNode.machineId : null].filter((x) => x != null);
  if (!targets.length) { failDiscover(s, new Error('没有在线机器可扫描')); return; }
  const tgtLabel = scope === 'all' ? targets.length + ' 台在线机' : (scopeNode || {}).host;
  return s.runCmd({ domain: 'project', action: 'discover', target: tgtLabel, chan: 'ssh', note: DISCOVER_NOTE },
    () => Promise.allSettled(targets.map((mid) => discoverProjects(mid, roots, null))).then((rs) => {
      const ok = rs.filter((r) => r.status === 'fulfilled');
      if (!ok.length) throw new Error('全部目标扫描失败');
      const found = ok.reduce((a, r) => a + (Array.isArray(r.value) ? r.value.length : 0), 0);
      return { found, failed: rs.length - ok.length };
    }),
    { okMsg: (r) => (r.found
      ? ('发现 ' + r.found + ' 个工程位置' + (r.failed ? ('（' + r.failed + ' 台失败）') : ''))
      : ('扫描完成，未发现 .uproject' + (r.failed ? ('（' + r.failed + ' 台失败）') : '') + ' · 请检查搜索根目录')) })
    .then(() => s.reloadCache());
};

/* 打开工程文件夹（本机 reveal / 远程 UNC·smb + 按需开放共享）。 */
const shareDirFor = (path) => {
  const norm = String(path).replace(/\//g, '\\').replace(/\\+$/, '');
  const parts = norm.split('\\').filter(Boolean);
  if (parts.length <= 2) return norm;
  return parts.slice(0, -1).join('\\');
};
const shareNameFor = (dir) => 'volo-dir-' + dir.toLowerCase().replace(/:/g, '')
  .replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
let selfIdPromise = null;
const selfMachineId = () => {
  if (!selfIdPromise) selfIdPromise = (async () => {
    for (const n of nodes()) {
      try { if (await isLoopbackMachine(n.ip)) return Number(n.machineId); } catch (e) { /* ignore */ }
    }
    return null;
  })();
  return selfIdPromise;
};
export const openFolder = (s, path, label, machine, logCat = 'project') => {
  const fail = (e) => s.pushLog({ lv: 'err', cat: logCat, ch: 'ssh',
    msg: '打开文件夹失败 · ' + label + ' · ' + (e && e.message ? e.message : e) });
  if (!machine) { fail(new Error('找不到该工程所在的机器')); return; }
  const logOk = () => s.pushLog({ lv: 'info', cat: logCat, ch: 'ssh',
    msg: '<b>explorer</b> · 在文件资源管理器中打开' + (label ? '（' + label + '）' : '') + ' ' + path });
  const logInfo = (msg) => s.pushLog({ lv: 'info', cat: logCat, ch: 'ssh', msg });
  isLoopbackMachine(machine.ip).then(
    (loopback) => {
      if (loopback) return revealPath(path).then(logOk, fail);
      return revealRemotePath(machine.ip, path).then(logOk, () => {
        const dir = shareDirFor(path);
        logInfo('<b>share</b> · 该路径不在任何共享内，正在把 ' + dir + ' 开放为共享…');
        return selfMachineId()
          .then((selfId) => ensureOpenDirShare(
            Number(machine.machineId), shareNameFor(dir), dir,
            selfId != null && selfId !== Number(machine.machineId) ? [selfId] : []))
          .then((r) => {
            logInfo('<b>share</b> · ' + (r.created ? '已开放共享 ' : '共享已存在 ') + r.unc_path + ' · 重试打开');
            return revealRemotePath(machine.ip, path).then(logOk, fail);
          }, fail);
      });
    },
    fail);
};

/* 集群数据未就绪 gate。emptyHint 按调用页定制。 */
export const clusterGate = (s, emptyHint) => {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const h = window.React.createElement;
  const Icon = window.Icon;
  if (s.cacheError) return h('div', { className: 'res ddc' }, h('div', { className: 'ddc-body' },
    h('div', { className: 'gen-empty' },
      h('span', { className: 's-negative', style: { display: 'flex' } }, h(Icon, { name: 'alert', size: 22 })),
      h('span', null, '加载集群数据失败 · ' + s.cacheError),
      h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'sync', size: 14 }), onPress: s.reloadCache }, '重试'))));
  if (s.cacheLoading) return h('div', { className: 'res ddc' }, h('div', { className: 'ddc-body' },
    h('div', { className: 'gen-empty' },
      h('span', { className: 's-informative', style: { display: 'flex' } }, h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 20 }))),
      h('span', null, '正在加载集群数据…'))));
  if (!nodes().length) return h('div', { className: 'res ddc' }, h('div', { className: 'ddc-body' },
    h('div', { className: 'gen-empty' }, h(Icon, { name: 'node', size: 22 }),
      h('span', null, emptyHint || '集群里还没有机器 — 先在「集群总览」扫描添加机器'))));
  return null;
};

export {};
