// @ts-nocheck
/* Volo — Cache · DDC PAK 子页（双栏重设计）
   1:1 port of the Claude Design handoff `src/cache_ddc_pak.jsx`，接真实后端。

   左右双栏：
     · 左栏「已部署 DDC PAK」—— 真实扇出扫描 UE_PROJECTS 的每个已知位置（list_deployed_ddc_paks），
       按工程聚合展示；行内操作重新生成 / 分发到其他机器 / 删除 PAK（删除为危险操作，卡片内
       就地展开红色确认门）。
     · 右栏「工程扫描与生成」—— 沿用 cacheDdc.tsx 已验证过的 discover_projects / generate_ddc_pak
       归约逻辑（经 window.VOLO_CACHE_DDC 共享），只是把选工程 + 生成收进本页，不再借道检查器。

   与 mock 设计稿的关键差异（见 auto-memory volo-cache-design-sync）：
     · 已部署列表来自真实扫描，不种 DEPLOYED_PAKS 假数据；PAK 文件名固定是
       DerivedDataCache\DDC.ddp（后端唯一命名，非按工程各自命名）。
     · 生成进度对话框由真实 runStreamingCmd 的 pct 驱动分桶阶段标签，不是 mock 的 setTimeout
       假进度表；无法确定的阶段（尚未收到任何真实事件）才展示不确定态动画。 */
import * as React from "react";
import "../ds";
import "./cacheDdc";
import { listDeployedDdcPaks, deleteDdcPak, distributeDdcPak, getProjectThumbnail } from "../api/commands";

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useRef, useEffect } = React;
  const h = React.createElement;
  const CX = window.VOLO_CX;
  const Selector = window.Selector;
  const DDC = window.VOLO_CACHE_DDC;

  const VIEW_OPTS = [{ id: 'flat', label: '平铺列表', icon: 'list' }, { id: 'grouped', label: '按文件夹层级', icon: 'folder' }];
  const SORT_OPTS = [{ id: 'updated', label: '按最近更新时间' }, { id: 'name', label: '按名称' }, { id: 'path', label: '按路径' }, { id: 'time', label: '按发现时间' }];
  const ROOT_PRESETS = ['D:\\Unreal Projects', 'D:\\UE_Projects', 'D:\\Projects', 'E:\\UEProjects'];
  /* get_project_thumbnail 只回传策略 key，人话文案留在前端（PROBE_DICT/PROBE_NARRATIVE 同款分工）。 */
  const THUMB_FROM_LABEL = {
    uproject_same_name: 'uproject 同名缩略图',
    saved_autosequence: 'Saved 回退缩略图（无同名图）',
  };

  const fmtMtime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const p = (x) => String(x).padStart(2, '0');
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  const fmtScanTime = (d) => {
    if (!d) return '尚未刷新';
    const p = (x) => String(x).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes());
  };
  const hostOf = (machineId) => { const n = CX.node(String(machineId)); return n ? n.host : ('机器 ' + machineId); };

  /* =========================================================================
     生成 DDC PAK 进度对话框 —— 真实 runStreamingCmd 进度驱动
     ========================================================================= */
  const GEN_STAGES = [
    { key: 'boot', label: '拉起 UE' },
    { key: 'fill', label: 'Filling DDC' },
    { key: 'save', label: 'Saving pak' },
    { key: 'verify', label: '校验产物' },
  ];
  /* 把真实 pct（ueProgressReduce：8→spawned，<=96→progress，100→finalize）分桶成阶段标签。
     pct<=4 = 还没收到任何真实事件（runStreamingCmd 的初始占位值）→ 不确定态，不假装有进度。 */
  const stageOf = (pct) => {
    if (pct == null || pct <= 4) return { key: 'boot', indet: true };
    if (pct < 90) return { key: 'fill', indet: false };
    if (pct < 100) return { key: 'save', indet: false };
    return { key: 'verify', indet: false };
  };

  function GenerateDialog({ s, close, projects, onAllDone }) {
    const [idx, setIdx] = useState(0);
    const [phase, setPhase] = useState('run'); /* run | done */
    const [results, setResults] = useState([]);
    const startedRef = useRef(false);
    const p = projects[idx];

    useEffect(() => {
      if (startedRef.current) return;
      startedRef.current = true;
      let alive = true;
      (async () => {
        for (let i = 0; i < projects.length; i++) {
          if (!alive) return;
          setIdx(i);
          const proj = projects[i];
          try {
            await DDC.genPak(s, proj);
            if (!alive) return;
            setResults((r) => r.concat({ name: proj.name, ok: true }));
          } catch (e) {
            if (!alive) return;
            setResults((r) => r.concat({ name: proj.name, ok: false, err: e && e.message ? e.message : String(e) }));
          }
        }
        if (!alive) return;
        if (onAllDone) { try { onAllDone(); } catch (e) {} }
        setPhase('done');
      })();
      return () => { alive = false; };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const liveTask = p ? (s.tasks || []).find((t) => t.state === 'running' && t.domain === 'ddc' && t.action === 'generate' && t.target === p.name) : null;
    const pct = liveTask ? liveTask.pct : 4;
    const stageKey = stageOf(pct);
    const stageIdx = GEN_STAGES.findIndex((x) => x.key === stageKey.key);
    const multi = projects.length > 1;

    if (phase === 'done') {
      const okCt = results.filter((r) => r.ok).length;
      const allOk = okCt === results.length;
      return h('div', { className: 'drawer drawer--preview' },
        h('div', { className: 'drawer-h' },
          h('span', { className: 'di ' + (allOk ? 'ok' : 'err') }, h(Icon, { name: allOk ? 'check' : 'alert', size: 17 })),
          h('div', { style: { minWidth: 0 } },
            h('h2', null, 'DDC PAK 生成完成'),
            h('div', { className: 'sub' }, h('span', { className: 'cli-pill' }, 'generate_ddc_pak'), h('span', null, ' · ' + okCt + '/' + results.length + ' 成功'))),
          h('button', { className: 'iconbtn x', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
        h('div', { className: 'drawer-b' },
          h('div', { className: 'pakgen' },
            h('div', { className: 'pakgen-done-head' },
              h('span', { className: 'pakgen-done-ico' }, h(Icon, { name: allOk ? 'check' : 'alert', size: 22 })),
              h('div', null,
                h('div', { className: 'pakgen-done-t' }, okCt + ' / ' + results.length + ' 个工程已生成 DDC PAK'),
                h('div', { className: 'pakgen-done-d' }, okCt ? '产物已加入左栏「已部署 DDC PAK」' : '生成均未成功，请查看下方错误详情'))),
            h('div', { className: 'pakgen-result-list' }, results.map((r, i) => h('div', { key: i, className: 'pakgen-result' },
              h('span', { className: 'r-ico', style: { color: r.ok ? 'var(--positive-visual)' : 'var(--negative-visual)' } }, h(Icon, { name: r.ok ? 'check' : 'x', size: 16 })),
              h('div', { style: { minWidth: 0 } }, h('div', { className: 'r-name' }, r.name),
                h('div', { className: 'r-file' }, r.ok ? 'DerivedDataCache\\DDC.ddp' : (r.err || '生成失败')))))),
            okCt ? h('div', { className: 'pakgen-done-note' }, h(Icon, { name: 'info', size: 12 }),
              '新生成的 PAK 尚未分发。到左栏卡片用「分发到其他机器」把它复制到渲染机。') : null)),
        h('div', { className: 'drawer-f' },
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'check', size: 15 }), onPress: close }, 'OK')));
    }

    const src = p ? DDC.pickSrc(p) : null;
    const pctLabel = stageKey.indet
      ? h('span', { className: 'pakgen-pct indet' }, h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 13 })), '进行中')
      : h('span', { className: 'pakgen-pct' + (pct >= 100 ? ' done' : '') }, Math.round(pct) + '%');
    const stepState = (j) => j < stageIdx ? 'done' : j === stageIdx ? 'active' : 'pending';
    const curLabel = (GEN_STAGES[stageIdx] || GEN_STAGES[0]).label;

    return h('div', { className: 'drawer drawer--preview' },
      h('div', { className: 'drawer-h' },
        h('span', { className: 'di info' }, h(Icon, { name: 'bolt', size: 17 })),
        h('div', { style: { minWidth: 0 } },
          h('h2', null, '生成 DDC PAK' + (multi ? '（' + (idx + 1) + '/' + projects.length + '）' : '')),
          h('div', { className: 'sub' },
            h('span', { className: 'cli-pill' }, 'generate_ddc_pak'),
            h('span', { className: 'pakgen-target' }, ' · ' + (p ? p.name : '') + (src ? (' · 源 ' + src.host) : '')))),
        null),
      h('div', { className: 'drawer-b' },
        h('div', { className: 'pakgen' },
          h('div', { className: 'pakgen-headline' },
            h('span', { className: 'pakgen-stage-name' }, curLabel),
            pctLabel),
          h('div', { className: 'pakgen-bar' + (stageKey.indet ? ' indet' : '') },
            stageKey.indet
              ? h('span', { className: 'pakgen-indet' })
              : h('span', { className: 'pakgen-fill' + (pct >= 100 ? ' done' : ''), style: { width: pct + '%' } })),
          h('div', { className: 'pakgen-subnote' },
            stageKey.indet ? h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 12 })) : null,
            '进度来自 UE 运行日志的稀疏标记 · 阶段间可能长时间无更新'),
          h('div', { className: 'pakgen-stages' }, GEN_STAGES.map((seg, j) => {
            const st = stepState(j);
            return h('div', { key: seg.key, className: 'pakgen-step ' + st },
              h('span', { className: 'sn' }, st === 'done' ? h(Icon, { name: 'check', size: 12 }) : (j + 1)),
              h('span', { className: 'slabel' }, seg.label),
              h('span', { className: 'sstate' },
                st === 'done' ? '完成'
                  : st === 'active'
                    ? (stageKey.indet ? h('span', { className: 'sdots' }, h('i', null), h('i', null), h('i', null)) : Math.round(pct) + '%')
                    : '等待'));
          })))),
      h('div', { className: 'drawer-f', style: { justifyContent: 'space-between' } },
        h('span', { className: 'pakgen-foot-note' }, h(Icon, { name: 'terminal', size: 13 }),
          '长任务 · 进度与日志同时写入控制台 NDJSON 流'),
        h(Button, { variant: 'secondary', size: 'M', isDisabled: true }, '生成中…')));
  }

  /* 已部署列表会话缓存：切顶层页（Cache↔校正等）会 remount PakPage，但不能因此重跑扫描。
     raw===undefined 表示本会话尚未扫过；[]=已扫且空；非空数组=已扫有结果。 */
  const DEPLOYED_CACHE = { raw: undefined, scannedAt: null };

  /* 工程平铺矩形小模块（紧凑网格 · 勾选）—— 只在本页用，不进 window.VOLO_CACHE_DDC 共享
     （projRow 才是跨页共享的行形态，见 cacheDdc.tsx）。路径解析 / 打开文件夹与 projRow 同一套
     既有约定：pickSrc 选中的源机可能不是该工程第一条 location，必须按 locByMachine 取该源机
     自己的路径，不能落回 p.root——否则显示路径与实际点开的文件夹对不上（此前修过的坑）。 */
  function projTile(p, selected, onClick, s) {
    const src = s ? DDC.pickSrc(p) : null;
    const path = (src && p.locByMachine && p.locByMachine[String(src.machineId)]) || p.root;
    const full = path + '\\' + p.uproject;
    const cut = full.lastIndexOf('\\');
    const head = cut >= 0 ? full.slice(0, cut + 1) : full;
    const tail = cut >= 0 ? full.slice(cut + 1) : '';
    return h('div', { key: p.id, className: 'proj-tile' + (selected ? ' on' : ''),
        title: p.name + '  ·  ' + full, onClick: () => onClick(p) },
      h('span', { className: 'proj-tile-mck' + (selected ? ' on' : '') }, selected ? h(Icon, { name: 'check', size: 11 }) : null),
      h('div', { className: 'proj-tile-media' + (p.thumb ? ' has-thumb' : '') },
        p.thumb
          ? h('img', { className: 'proj-tile-thumb', src: p.thumb, alt: '', draggable: false })
          : h(Icon, { name: 'film', size: 22 }),
        h('div', { className: 'proj-tile-badges' },
          p.hasPak ? h('span', { className: 'proj-tile-badge pak', title: '已有 DDC PAK' }, h(Icon, { name: 'check', size: 10 }), 'PAK') : null,
          p.warn ? h('span', { className: 'proj-tile-badge warn', title: p.warn }, h(Icon, { name: 'alert', size: 10 })) : null)),
      h('div', { className: 'proj-tile-info' },
        h('div', { className: 'proj-tile-nrow' },
          h('div', { className: 'proj-tile-name' }, p.name),
          h('button', { type: 'button', className: 'proj-tile-open', title: '在文件资源管理器中打开工程文件夹',
              onClick: (e) => { e.stopPropagation(); s && DDC.openFolder(s, path, p.name, src); } },
            h(Icon, { name: 'folder', size: 12 }))),
        h('div', { className: 'proj-tile-meta' },
          h('span', { className: 'proj-tile-tag ue' }, 'UE ' + p.ue),
          h('span', { className: 'proj-tile-tag' }, p.size)),
        h('button', { type: 'button', className: 'proj-tile-path mono', title: '在文件资源管理器中打开：' + full,
            onClick: (e) => { e.stopPropagation(); s && DDC.openFolder(s, path, p.name, src); } },
          h('span', { className: 'ptp-head' }, head),
          tail ? h('span', { className: 'ptp-tail' }, tail) : null)));
  }

  /* =========================================================================
     DDC PAK 主页 · 左右双栏
     ========================================================================= */
  function PakPage({ s }) {
    /* ---------- 左栏 · 已部署 DDC PAK（真实扫描） ---------- */
    const [deployedRaw, setDeployedRaw] = useState(() => (DEPLOYED_CACHE.raw === undefined ? null : DEPLOYED_CACHE.raw));
    const [depScan, setDepScan] = useState(() => DEPLOYED_CACHE.scannedAt);
    const [confirmId, setConfirmId] = useState(null);

    const loadDeployed = (opts) => {
      const quiet = opts === true || !!(opts && opts.quiet);
      const noLogOpen = !!(opts && opts.noLogOpen);
      return s.runCmd(
      { domain: 'ddc', action: 'scan-deployed', target: '已部署 DDC PAK', chan: 'ssh', note: '扫描已部署 DDC PAK', quiet, noLogOpen },
      () => listDeployedDdcPaks(),
      { okMsg: (rows) => '已刷新 · ' + rows.length + ' 条已部署位置' })
      .then((rows) => {
        DEPLOYED_CACHE.raw = rows;
        DEPLOYED_CACHE.scannedAt = new Date();
        setDeployedRaw(rows);
        setDepScan(DEPLOYED_CACHE.scannedAt);
      }, () => {});
    };
    /* 仅本会话首次进入且尚无缓存时静默扫一次；从其他顶层页切回时走 useState 初始值复用缓存 */
    useEffect(() => {
      if (DEPLOYED_CACHE.raw !== undefined) return;
      loadDeployed(true);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    /* 按工程聚合：source = 该工程 primary 机（若也在已发现列表里），否则第一条命中；
       distributedTo = 其余持有该 pak 的机器。陈旧 project_id（工程已被移出列表）静默丢弃。 */
    const deployed = (() => {
      const groups = [];
      (deployedRaw || []).forEach((row) => {
        let grp = groups.find((x) => x.projectId === row.project_id);
        if (!grp) { grp = { projectId: row.project_id, entries: [] }; groups.push(grp); }
        grp.entries.push(row);
      });
      return groups.map((grp) => {
        const proj = UE_PROJECTS.find((p) => p.id === grp.projectId);
        if (!proj) return null;
        const src = grp.entries.find((e) => String(e.machine_id) === proj.primary) || grp.entries[0];
        const distributedTo = grp.entries.filter((e) => e !== src).map((e) => e.machine_id);
        return { project: proj, source: src, distributedTo };
      }).filter(Boolean).sort((a, b) => a.project.name.localeCompare(b.project.name));
    })();

    /* ---------- 右栏 · 工程扫描与生成 ---------- */
    const [scope, setScope] = useState('all');
    const ridRef = useRef(0);
    const [roots, setRoots] = useState(() => [{ id: ++ridRef.current, val: 'D:\\Projects' }]);
    const [rootDraft, setRootDraft] = useState('');
    const [query, setQuery] = useState('');
    const [view, setView] = useState('flat');
    const [sort, setSort] = useState('updated');
    const [sel, setSel] = useState([]);
    const [tileScale, setTileScale] = useState(150); /* 平铺矩形模块显示比例（列宽 px）*/

    /* ---------- 缩略图（懒加载，只在本页 merge 进 project 对象，不写回全局 UE_PROJECTS） ----------
       每个工程用 DDC.pickSrc 选源机（与生成/校验同一套「哪台机代表这个工程」的既有约定）。
       THUMB_CONCURRENCY 个 worker 从队列里拉取，而不是对全部 UE_PROJECTS 一次性并发发起
       ——工程一多，无限并发会同时起一堆 ssh 子进程（每条请求最多 8MB base64），既打满
       WebView 又可能把源机 SSH 撑爆。thumbTriedRef 只在 promise 真正 resolve（拿到「有/无
       缩略图」这个确定结果）后才标记，reject（如源机瞬时离线、SSH 抖动）不标记——否则一次
       瞬时失败会让该工程在这个常驻页面的整个生命周期里都拿不到缩略图，直到 project count
       变化触发下一次 effect。machine 暂不在线（pickSrc 返回 null）同样不标记，原地跳过换
       下一个候选，让 worker 不因为一个工程卡住。 */
    const [thumbs, setThumbs] = useState({});
    const thumbTriedRef = useRef(new Set());
    const THUMB_CONCURRENCY = 8; // 对齐后端 batch::DEFAULT_MAX_CONCURRENCY 的既有并发约定
    /* thumbGen：工程扫描（doScan）完成后打一次点，强制已探测过的工程重新探测一轮——
       否则「按最近更新时间」排序会一直用首次挂载时探测到的旧 mtime，直到本组件真正卸载重挂
       （sort 键依赖同一份缩略图探测）。只挂在 doScan 上，不挂在通用 reloadCache 上：机器/凭据
       等无关操作也会触发 reloadCache，若跟着清空 thumbTriedRef 会让所有工程重新探测一遍，
       白白打一堆 SSH（这正是本页缩略图并发池设计要避免的“探测风暴”）。 */
    const [thumbGen, setThumbGen] = useState(0);
    useEffect(() => {
      let alive = true;
      const queue = UE_PROJECTS.filter((p) => !thumbTriedRef.current.has(p.id));
      let next = 0;
      const pump = () => {
        if (!alive || next >= queue.length) return;
        const p = queue[next++];
        const src = DDC.pickSrc(p);
        if (!src) { pump(); return; }
        getProjectThumbnail(Number(p.id), src.machineId).then(
          (t) => {
            if (!alive) return;
            thumbTriedRef.current.add(p.id);
            if (t) setThumbs((m) => Object.assign({}, m, { [p.id]: {
              thumb: 'data:image/png;base64,' + t.base64,
              thumbSrc: t.path,
              thumbFrom: THUMB_FROM_LABEL[t.from] || t.from,
              mtime: t.mtime || '',
            } }));
            pump();
          },
          () => { if (alive) pump(); });
      };
      for (let i = 0; i < THUMB_CONCURRENCY; i++) pump();
      return () => { alive = false; };
    }, [UE_PROJECTS.length, thumbGen]);
    const withThumb = (p) => { const t = thumbs[p.id]; return t ? Object.assign({}, p, t) : p; };

    /* gate 必须在全部 Hooks 之后才能条件 return：否则加载态(仅走 gate 分支、零 Hook)
       与加载完成态(走到这里、调用一串 useState/useEffect)之间 Hook 调用数量不一致，
       React 会抛 "Rendered more hooks than during the previous render"。 */
    const g = DDC.gate(s); if (g) return g;

    const openGenerate = (projs) => {
      if (!projs.length) return;
      s.setModal({ kind: 'pakgen', render: ({ s: st, close }) =>
        h(GenerateDialog, { s: st, close, projects: projs, onAllDone: () => loadDeployed(true) }) });
    };
    const generateSelected = () => {
      const projs = sel.map((id) => UE_PROJECTS.find((p) => p.id === id)).filter(Boolean);
      openGenerate(projs);
      setSel([]);
    };
    const regenerate = (dp) => openGenerate([dp.project]);

    /* ---------- 分发到其他机器（固定候选列表 + 居中确认对话框） ---------- */
    /* 候选必须同时满足①在线 render 机 ②该工程已在这台机上发现过位置——后端 pak_distribute::plan
       对 target_machine_ids 里任意一台缺 ProjectLocation 都会让整个 plan() 报 InvalidInput、
       整批分发全部失败，不是"跳过那一台"，故这里不能只看在线/角色，必须按 dp.project.machines
       （= 该工程的 project_locations）过滤，否则一台未发现该工程的在线机就会拖垮整批分发。 */
    const distributePak = (dp) => {
      const srcHost = hostOf(dp.source.machine_id);
      const cand = RENDER_NODES.filter((n) => n.status !== 'offline' && n.roleKey === 'render'
        && n.machineId !== dp.source.machine_id && !dp.distributedTo.includes(n.machineId)
        && dp.project.machines.includes(String(n.machineId)));
      if (!cand.length) {
        /* 已全部持有：无需弹确认对话框走一遍假进度，留一条可见的信息级记录即可 */
        s.runCmd(
          { domain: 'ddc', action: 'distribute', target: dp.project.name, chan: 'ssh', note: '分发 DDC PAK', quiet: true },
          () => Promise.resolve(),
          { okMsg: () => dp.project.name + ' 的 DDC PAK 已分发到全部在线渲染机，无需重复分发' });
        return;
      }
      const targetIds = cand.map((n) => n.machineId);
      CX.openModalPreview(s, {
        title: '分发 DDC PAK · ' + dp.project.name, icon: 'download', cli: 'ddc distribute', destructive: false, channel: 'ssh',
        confirmLabel: '分发到 ' + cand.length + ' 台',
        doneTitle: '分发完成', doneMsg: dp.project.name + ' 已分发到 ' + cand.length + ' 台渲染机',
        steps: [
          '把该 PAK 从源机 ' + srcHost + ' 增量分发到下列机器',
          '已有的分块自动跳过，只传缺失部分',
          '分发后回读校验各机 DDC.ddp 是否就位'],
        simpleScope: cand.map((n) => ({ host: n.host, ip: n.ip, msg: n.gpu })),
        run: () => s.runStreamingCmd(
          { domain: 'ddc', action: 'distribute', target: dp.project.name + ' · ' + cand.length + ' 台', chan: 'ssh', note: '分发 · ' + dp.project.name, quiet: true },
          () => distributeDdcPak(dp.source.machine_id, Number(dp.project.id), targetIds, null, null, null),
          { mode: 'event', events: ['pak-distribute-progress'], jobIdOf: (r) => r.job_id, total: (r) => (r.plan || []).length, reduce: DDC.batchReduce, timeoutMs: 30 * 60 * 1000 })
          .then(() => loadDeployed(true)),
      });
    };

    /* ---------- 删除 PAK（危险操作 · 卡片内就地红色确认门） ---------- */
    const doDelete = (dp) => {
      setConfirmId(null);
      const srcHost = hostOf(dp.source.machine_id);
      s.runCmd(
        { domain: 'ddc', action: 'delete-pak', target: dp.project.name, chan: 'ssh', note: '删除 DDC PAK · ' + dp.project.name, quiet: true },
        () => deleteDdcPak(dp.source.machine_id, Number(dp.project.id)),
        { okMsg: () => 'DDC.ddp 已从 ' + srcHost + ' 移除 · 已分发的副本不受影响' })
        .then(() => loadDeployed(true), () => {});
    };

    /* ---------- 搜索根目录：可编辑行 + 一次添加多个 + 常用预设 ---------- */
    const rootVals = roots.map((r) => r.val.trim()).filter(Boolean);
    const rootsStr = rootVals.join(';');
    const addRoots = (str) => {
      const parts = String(str || '').split(/[;\n]+/).map((x) => x.trim()).filter(Boolean);
      if (!parts.length) return;
      setRoots((rs) => rs.concat(parts.filter((p) => !rs.some((r) => r.val === p)).map((p) => ({ id: ++ridRef.current, val: p }))));
    };
    const updateRoot = (id, v) => setRoots((rs) => rs.map((r) => r.id === id ? { id, val: v } : r));
    const removeRoot = (id) => setRoots((rs) => rs.filter((r) => r.id !== id));
    const commitDraft = () => { addRoots(rootDraft); setRootDraft(''); };
    const doScan = () => {
      const scanned = DDC.runDiscover(s, scope, rootsStr);
      if (scanned) scanned.then(() => { thumbTriedRef.current = new Set(); setThumbGen((g) => g + 1); });
    };

    /* ---------- 过滤 / 排序 / 分组 ---------- */
    const q = query.trim().toLowerCase();
    const matched = UE_PROJECTS.filter((p) => !q
      || p.name.toLowerCase().includes(q) || (p.root + '\\' + p.uproject).toLowerCase().includes(q));
    /* 「按最近更新时间」用探测到的缩略图/autosequence 截图的文件 mtime 排序——它反映工程
       内容实际变动（编辑器里工作时才会更新截图），不是 discovered_at 那种"上次被 Volo
       扫描到"的时间（同一次扫描全部会让一批工程的 discovered_at 几乎相同，排序没有区分度）。
       缩略图是懒加载的，暂未探测到 / 确认没有缩略图的工程一律排到最后（空字符串排序键）。 */
    const mtimeOf = (p) => (thumbs[p.id] && thumbs[p.id].mtime) || '';
    const sorters = {
      updated: (a, b) => mtimeOf(b).localeCompare(mtimeOf(a)),
      name: (a, b) => a.name.localeCompare(b.name),
      path: (a, b) => (a.root + '\\' + a.uproject).localeCompare(b.root + '\\' + b.uproject),
      time: (a, b) => String(b.last).localeCompare(String(a.last)),
    };
    const sorted = matched.slice().sort(sorters[sort]);
    const parentDir = (p) => { const parts = p.root.split('\\'); parts.pop(); return parts.join('\\') || p.root; };
    const toggleSel = (p) => setSel((v) => v.includes(p.id) ? v.filter((x) => x !== p.id) : v.concat(p.id));

    /* ---------- 全选（只作用于当前可见 / 过滤后的工程） ----------
       状态与计数都必须按 sel 与 visibleIds 的交集算，不能直接用 sel.length——否则搜索把
       已选工程过滤掉一部分时，这里会显示类似「3 / 1」的错误计数；toggleAll 也只增删可见
       ID，不整体覆盖 sel，避免清空搜索框之外那些不可见但仍处于选中状态的工程。 */
    const visibleIds = sorted.map((p) => p.id);
    const visibleSelectedCount = visibleIds.filter((id) => sel.includes(id)).length;
    const allSelected = visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;
    const someSelected = visibleSelectedCount > 0 && !allSelected;
    const toggleAll = () => setSel((v) => allSelected
      ? v.filter((id) => !visibleIds.includes(id))
      : Array.from(new Set(v.concat(visibleIds))));
    const tileStyle = { '--tile-w': tileScale + 'px' };

    /* ---------- 左栏 · 已部署卡片 ---------- */
    const deployedCard = (dp) => {
      const srcHost = hostOf(dp.source.machine_id);
      const srcNode = CX.node(String(dp.source.machine_id));
      const srcPath = (dp.project.locByMachine && dp.project.locByMachine[String(dp.source.machine_id)]) || dp.project.root;
      const distHosts = dp.distributedTo.map(hostOf).join('、');
      const confirming = confirmId === dp.project.id;
      return h('div', { key: dp.project.id, className: 'dpak-card' + (confirming ? ' confirming' : '') },
        h('div', { className: 'dpak-top' },
          h('span', { className: 'dpak-ico' }, h(Icon, { name: 'cache', size: 16 })),
          h('div', { className: 'dpak-meta' },
            h('div', { className: 'dpak-name' }, dp.project.name,
              dp.project.ue !== '—' ? h('span', { className: 'dpak-tag ue' }, 'UE ' + dp.project.ue) : null),
            h('button', { type: 'button', className: 'dpak-path dpak-path-open', title: '在文件资源管理器中打开工程文件夹',
                onClick: (e) => { e.stopPropagation(); DDC.openFolder(s, srcPath, dp.project.name, srcNode); } },
              h('span', { className: 'proj-sub-tx' }, srcPath),
              h('span', { className: 'proj-sub-ico' }, h(Icon, { name: 'folder', size: 12 })))),
          h('span', { className: 'spill spill--positive' }, h(Icon, { name: 'check', size: 12 }), '就绪')),
        h('div', { className: 'dpak-grid' },
          h('div', { className: 'dpak-kv' }, h('span', { className: 'k' }, 'PAK 文件大小'), h('span', { className: 'v' }, DDC.humanBytes(dp.source.size_bytes))),
          h('div', { className: 'dpak-kv' }, h('span', { className: 'k' }, '生成时间'), h('span', { className: 'v' }, fmtMtime(dp.source.modified_at))),
          h('div', { className: 'dpak-kv' }, h('span', { className: 'k' }, '源机器'), h('span', { className: 'v mono' }, srcHost)),
          h('div', { className: 'dpak-kv' }, h('span', { className: 'k' }, 'PAK 文件'), h('span', { className: 'v mono', title: dp.source.pak_path }, 'DerivedDataCache\\DDC.ddp'))),
        dp.distributedTo.length
          ? h('div', { className: 'dpak-dist' },
              h('span', { className: 'spill spill--positive' }, h(Icon, { name: 'download', size: 12 }), '已分发到 ' + dp.distributedTo.length + ' 台'),
              h('span', { className: 'dist-hosts', title: distHosts }, distHosts))
          : h('div', { className: 'dpak-dist' },
              h('span', { className: 'spill spill--neutral' }, h(Icon, { name: 'minus', size: 12 }), '未分发'),
              h('span', { className: 'dist-hosts' }, '仅存于源机 ' + srcHost)),
        confirming
          ? h('div', { className: 'dpak-confirm' },
              h('div', { className: 'dpak-confirm-msg' }, h(Icon, { name: 'alert', size: 15 }),
                h('span', null, '删除后该工程的 DDC PAK 产物将从源机 ', h('b', null, srcHost),
                  ' 移除，需要时须重新生成；已分发到其他机器的副本不受影响。确认删除？')),
              h('div', { className: 'dpak-confirm-acts' },
                h('button', { className: 'mini-btn', onClick: () => setConfirmId(null) }, '取消'),
                h('button', { className: 'mini-btn danger', onClick: () => doDelete(dp) }, h(Icon, { name: 'trash', size: 12 }), '确认删除 PAK')))
          : h('div', { className: 'dpak-acts' },
              h('button', { className: 'mini-btn', onClick: () => regenerate(dp) }, h(Icon, { name: 'sync', size: 12 }), '重新生成'),
              h('button', { className: 'mini-btn', onClick: () => distributePak(dp) }, h(Icon, { name: 'download', size: 12 }), '分发到其他机器'),
              h('button', { className: 'mini-btn danger grow', onClick: () => setConfirmId(dp.project.id) }, h(Icon, { name: 'trash', size: 12 }), '删除 PAK')));
    };

    const leftBody = deployedRaw == null
      ? h('div', { className: 'gen-empty' },
          h('span', { className: 's-informative', style: { display: 'flex' } }, h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 18 }))),
          h('span', null, '正在扫描已部署 DDC PAK…'))
      : deployed.length === 0
        ? h('div', { className: 'dpak-empty' },
            h('div', { className: 'dpak-empty-ico' }, h(Icon, { name: 'cache', size: 26 })),
            h('div', { className: 'dpak-empty-t' }, '尚无已部署的 DDC PAK'),
            h('div', { className: 'dpak-empty-d' }, '扫描 UE 工程目录后，已生成 / 部署过 DDC Pak 的工程会自动出现在这里。先到右栏扫描并生成。'),
            h('div', { className: 'dpak-empty-hint' }, h(Icon, { name: 'arrowr', size: 13 }), '右栏「工程扫描与生成」'))
        : h(React.Fragment, null, deployed.map(deployedCard));

    /* ---------- 右栏 · 工程列表 ---------- */
    const listBody = sorted.length === 0
      ? h('div', { className: 'pak-list-empty' }, h(Icon, { name: 'search', size: 22 }),
          h('span', null, q ? ('无匹配「' + query + '」的工程') : '尚未发现工程，点上方「扫描」'))
      : view === 'grouped'
        ? (() => {
            const groups = [];
            sorted.forEach((p) => {
              const dir = parentDir(p);
              let grp = groups.find((x) => x.dir === dir);
              if (!grp) { grp = { dir, items: [] }; groups.push(grp); }
              grp.items.push(p);
            });
            return h(React.Fragment, null, groups.map((grp) => h('div', { key: grp.dir, className: 'pak-group' },
              h('div', { className: 'pak-group-h' }, h(Icon, { name: 'folder', size: 13 }),
                h('span', { className: 'mono' }, grp.dir), h('span', { className: 'ct' }, grp.items.length + ' 个')),
              h('div', { className: 'proj-list' }, grp.items.map((p) => DDC.projRow(withThumb(p), sel.includes(p.id), toggleSel, s))))));
          })()
        : h('div', { className: 'proj-grid', style: tileStyle }, sorted.map((p) => projTile(withThumb(p), sel.includes(p.id), toggleSel, s)));

    /* 列表工具条 · 全选（左）+ 显示比例滑块（右上角，仅平铺视图） */
    const listBar = sorted.length === 0 ? null
      : h('div', { className: 'pak-list-bar' },
          h('button', { type: 'button',
              className: 'pak-selall' + (allSelected ? ' on' : someSelected ? ' part' : ''),
              onClick: toggleAll,
              title: allSelected ? '取消全选' : '选择全部可见工程' },
            h('span', { className: 'pak-selall-box' },
              allSelected ? h(Icon, { name: 'check', size: 12 }) : someSelected ? h(Icon, { name: 'minus', size: 12 }) : null),
            h('span', { className: 'pak-selall-tx' }, allSelected ? '取消全选' : '全选'),
            h('span', { className: 'pak-selall-ct' }, visibleSelectedCount ? (visibleSelectedCount + ' / ' + sorted.length) : (sorted.length + ' 个工程'))),
          view === 'flat' ? h('div', { className: 'pak-zoom', title: '调节矩形模块的显示比例' },
            h('span', { className: 'pak-zoom-ic sm' }, h(Icon, { name: 'grid', size: 12 })),
            h('input', { type: 'range', className: 'pak-zoom-range', min: 118, max: 220, step: 1,
              value: tileScale, 'aria-label': '显示比例',
              onChange: (e) => setTileScale(+e.target.value) }),
            h('span', { className: 'pak-zoom-ic lg' }, h(Icon, { name: 'grid', size: 17 }))) : null);

    return h('div', { className: 'res ddc pak-page' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, 'DDC · DDC PAK'),
        h('div', { className: 'right' },
          h('span', { className: 'toolchip' }, h(Icon, { name: 'cache', size: 14 }), '已部署 ' + deployed.length + ' 个'),
          h('span', { className: 'toolchip' }, h(Icon, { name: 'film', size: 14 }), '发现 ' + UE_PROJECTS.length + ' 工程'))),
      h('div', { className: 'pak2' },
        /* ============ 左栏 · 已部署 DDC PAK ============ */
        h('section', { className: 'pak2-col pak2-left' },
          h('div', { className: 'pak2-h' },
            h('span', { className: 'pak2-ico' }, h(Icon, { name: 'cache', size: 15 })),
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'pak2-tt' }, '已部署 DDC PAK'),
              h('div', { className: 'pak2-sub' }, '扫描工程目录自动发现 · 已生成 / 部署过 Pak 的工程')),
            h('div', { className: 'right' },
              h('span', { className: 'pak2-scan' }, h(Icon, { name: 'check', size: 11 }), '刷新于 ' + fmtScanTime(depScan)),
              h('button', { className: 'mini-btn', title: '扫描工程目录，刷新已部署 DDC PAK 的最新情况', onClick: () => loadDeployed({ noLogOpen: true }) },
                h(Icon, { name: 'sync', size: 12 }), '刷新'))),
          h('div', { className: 'pak2-b' }, leftBody)),
        /* ============ 右栏 · 工程扫描与生成 ============ */
        h('section', { className: 'pak2-col pak2-right' },
          h('div', { className: 'pak2-h' },
            h('span', { className: 'pak2-ico' }, h(Icon, { name: 'search', size: 15 })),
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'pak2-tt' }, '工程扫描与生成'),
              h('div', { className: 'pak2-sub' }, 'discover_projects · 远程扫 .uproject，只发现不写盘')),
            h('div', { className: 'right' },
              sel.length ? h('span', { className: 'toolchip' }, h(Icon, { name: 'check', size: 14 }), '已选 ' + sel.length) : null)),
          h('div', { className: 'pak2-b' },
            h('div', { className: 'pak-search' },
              h(Icon, { name: 'search', size: 14 }),
              h('input', { value: query, placeholder: '按工程名 / 路径过滤…', spellCheck: false, onChange: (e) => setQuery(e.target.value) }),
              q ? h('span', { className: 'pak-search-ct' }, '匹配 ' + matched.length + ' / ' + UE_PROJECTS.length) : null,
              q ? h('button', { className: 'pak-search-clear', title: '清除搜索', onClick: () => setQuery('') }, h(Icon, { name: 'x', size: 13 })) : null),
            h('div', { className: 'pak-controls' },
              h('div', { className: 'pak-ctl' }, h('label', null, '显示'),
                h('div', { className: 'seg' }, VIEW_OPTS.map((o) => h('button', { key: o.id, className: view === o.id ? 'on' : '', onClick: () => setView(o.id) },
                  h(Icon, { name: o.icon, size: 13 }), o.label)))),
              h('div', { className: 'pak-ctl' }, h('label', null, '排序'),
                h(Selector, { kpre: '排序', value: sort, options: SORT_OPTS, width: 188, align: 'left', onChange: setSort })),
              h('div', { className: 'pak-ctl scan' }, h('label', null, '扫描范围'),
                h(Selector, { kpre: '范围', value: scope, options: DDC.scopeOpts(), width: 168, onChange: setScope })),
              h('div', { className: 'pak-ctl' }, h('label', { style: { visibility: 'hidden' } }, '扫描'),
                h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'search', size: 14 }), onPress: doScan }, '扫描'))),
            h('div', { className: 'pak-roots' },
              h('div', { className: 'pak-roots-h' }, h('span', { className: 't' }, '搜索根目录'),
                h('span', { className: 'dim' }, '可多个 · 可直接编辑路径 · 生成时以分号拼接')),
              h('div', { className: 'pak-root-rows' },
                roots.map((r) => h('div', { key: r.id, className: 'root-row' },
                  h('span', { className: 'root-row-ic' }, h(Icon, { name: 'folder', size: 13 })),
                  h('input', { className: 'root-in', value: r.val, spellCheck: false, placeholder: '输入工程根目录…',
                    onChange: (e) => updateRoot(r.id, e.target.value) }),
                  h('button', { className: 'root-row-x', title: '移除', onClick: () => removeRoot(r.id) }, h(Icon, { name: 'x', size: 13 }))))),
              h('div', { className: 'root-add' }, h(Icon, { name: 'plus', size: 13 }),
                h('input', { value: rootDraft, placeholder: '添加根目录，多个用分号 ; 分隔，回车确认', spellCheck: false,
                  onChange: (e) => setRootDraft(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') commitDraft(); } }),
                h('button', { className: 'root-add-btn', disabled: !rootDraft.trim(), onClick: commitDraft }, '添加')),
              h('div', { className: 'pak-presets' },
                h('span', { className: 'pp-label' }, '常用预设'),
                ROOT_PRESETS.map((r) => { const added = rootVals.includes(r);
                  return h('button', { key: r, className: 'pp-chip' + (added ? ' added' : ''), disabled: added, onClick: () => addRoots(r) },
                    added ? h(Icon, { name: 'check', size: 11 }) : h(Icon, { name: 'plus', size: 11 }), r); }))),
            h('div', { className: 'pak-scan-meta' }, h(Icon, { name: 'check', size: 12 }), '已发现 ' + UE_PROJECTS.length + ' 个工程位置 · 远程扫 .uproject 只发现不写盘'),
            listBar,
            listBody),
          h('div', { className: 'pak2-foot' },
            h('span', { className: 'pak-genbar-info' }, h(Icon, { name: 'info', size: 12 }),
              sel.length ? h(React.Fragment, null, '已选 ', h('b', null, sel.length), ' 个工程 · 仅工程级 Pak（DDC.ddp）') : '勾选工程后生成 DDC PAK'),
            h('span', { className: 'pak-genbar-spacer' }),
            h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), isDisabled: sel.length === 0, onPress: generateSelected },
              '生成 DDC PAK' + (sel.length ? '（' + sel.length + '）' : ''))))));
  }

  window.VOLO_CACHE_DDC_PAK = { page: (s) => h(PakPage, { s }) };
})();

export {};
