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
import { listDeployedDdcPaks, deleteDdcPak, distributeDdcPak, getProjectThumbnail, deleteProject, listRemoteDirectories } from "../api/commands";

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useRef, useEffect } = React;
  const h = React.createElement;
  const CX = window.VOLO_CX;
  const Selector = window.Selector;
  const DDC = window.VOLO_CACHE_DDC;

  const VIEW_OPTS = [
    { id: 'flat', label: '列表', icon: 'list', hint: '平铺矩形模块' },
    { id: 'grouped', label: '文件夹', icon: 'folder', hint: '按父目录分组' },
    { id: 'machine', label: '按机器', icon: 'server', hint: '按每台机器持有的工程分组' },
  ];
  const SORT_OPTS = [{ id: 'updated', label: '更新时间' }, { id: 'name', label: '名称' }, { id: 'path', label: '路径' }, { id: 'time', label: '发现时间' }];
  /* get_project_thumbnail 只回传策略 key，人话文案留在前端（PROBE_DICT/PROBE_NARRATIVE 同款分工）。 */
  const THUMB_FROM_LABEL = {
    uproject_same_name: 'uproject 同名缩略图',
    saved_auto_screenshot: 'Saved 编辑器自动截图（无同名图）',
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

  /* 逐级路径提示：把地址栏当前文本拆成"要列哪个目录的子项"（parentPath，null = 列盘符）
     + "已输入到的最后一段"（typed，本地前缀过滤用，不触发新请求）。与 confirmSeg 配对：
     确认某一级后文本变成 base + 该项 + '\\'，下一轮解析自然把 typed 清空、parentPath 落到刚选的目录。 */
  const splitRootPath = (text) => {
    const t = text || '';
    if (t.indexOf('\\') === -1) return { parentPath: null, typed: t.trim() };
    const segs = t.split('\\');
    const typed = segs.pop();
    return { parentPath: segs.join('\\'), typed: typed.trim() };
  };

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

  /* 完整路径悬浮提示 —— 自绘浮层（挂到 body，避开卡片 overflow:hidden 裁剪），
     近乎即时显示（120ms），替代原生 title 的 ~2s 延迟 */
  let _pathTipEl = null, _pathTipTimer = null;
  function ensurePathTip() {
    if (!_pathTipEl) { _pathTipEl = document.createElement('div'); _pathTipEl.className = 'proj-path-tip'; document.body.appendChild(_pathTipEl); }
    return _pathTipEl;
  }
  function showPathTip(el, text) {
    if (!el || !el.isConnected) return;
    const tip = ensurePathTip();
    tip.textContent = text;
    tip.style.display = 'block';
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - tip.offsetWidth - 8));
    let top = r.top - tip.offsetHeight - 6;
    if (top < 8) top = r.bottom + 6;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function schedulePathTip(e, text) {
    const el = e.currentTarget;
    clearTimeout(_pathTipTimer);
    _pathTipTimer = setTimeout(() => showPathTip(el, text), 120);
  }
  function hidePathTip() {
    clearTimeout(_pathTipTimer);
    if (_pathTipEl) _pathTipEl.style.display = 'none';
  }

  /* 工程平铺矩形小模块（紧凑网格 · 勾选）—— 只在本页用，不进 window.VOLO_CACHE_DDC 共享
     （projRow 才是跨页共享的行形态，见 cacheDdc.tsx）。路径解析 / 打开文件夹与 projRow 同一套
     既有约定：pickSrc 选中的源机可能不是该工程第一条 location，必须按 locByMachine 取该源机
     自己的路径，不能落回 p.root——否则显示路径与实际点开的文件夹对不上（此前修过的坑）。 */
  function projTile(p, selected, onClick, s) {
    const src = s ? DDC.pickSrc(p) : null;
    const path = (src && p.locByMachine && p.locByMachine[String(src.machineId)]) || p.root;
    const full = path + '\\' + p.uproject;
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
        h('div', { className: 'proj-tile-name' }, p.name),
        h('div', { className: 'proj-tile-nrow' },
          h('div', { className: 'proj-tile-sub' }, 'UE ' + p.ue + ' · ' + p.size),
          h('button', { type: 'button', className: 'proj-tile-open', 'aria-label': '在文件资源管理器中打开：' + full,
              onMouseEnter: (e) => schedulePathTip(e, full),
              onMouseLeave: hidePathTip,
              onClick: (e) => { e.stopPropagation(); hidePathTip(); s && DDC.openFolder(s, path, p.name, src); } },
            h(Icon, { name: 'folder', size: 14 })))));
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
    /* 「仅已生成/未生成 PAK」筛选与右栏 PAK 徽章的真实数据源：ProjectVM.hasPak 在共享 adapter 里
       是全局 stub（恒 false，adapters.ts 明写 TODO 后端无源），但本页已经真实扫过
       listDeployedDdcPaks 算出 `deployed`，用它反推准确的 hasPak，不用碰共享 adapter。 */
    const deployedProjectIds = new Set(deployed.map((dp) => dp.project.id));
    /* 工程级 hasPak 只回答"这个工程在哪台机器上都行有没有 PAK"；「按机器」视图需要更细的粒度——
       同一工程可能只在源机生成、只分发到部分机器，不能让每台机器的分组行都套同一个工程级布尔值
       （否则没拿到 PAK 的机器也会被打上"已有 PAK"绿标，误导用户跳过该机的分发）。 */
    const deployedHoldersByProject = new Map(deployed.map((dp) =>
      [dp.project.id, new Set([dp.source.machine_id].concat(dp.distributedTo).map(String))]));

    /* ---------- 右栏 · 工程扫描与生成 ---------- */
    const [scope, setScope] = useState('all');
    const ridRef = useRef(0);
    const [roots, setRoots] = useState(() => [{ id: ++ridRef.current, val: 'D:\\Unreal Projects' }]);
    const [rootDraft, setRootDraft] = useState('');
    /* 逐级路径提示：当前展开的字段（'add' 或某行 id）+ 高亮项 + 真实查询到的目录项（按
       machineId+parentPath 缓存，避免同一目录反复发起 SSH 往返） */
    const [acOpen, setAcOpen] = useState(false);
    const [acHi, setAcHi] = useState(0);
    const [acField, setAcField] = useState(null);
    const acCacheRef = useRef(new Map()); /* `${machineId}|${path}` -> string[]（本会话内有效） */
    /* 常用地址（收藏的搜索根目录）· 持久化到 localStorage */
    const [favs, setFavs] = useState(() => {
      try { return JSON.parse(localStorage.getItem('volo.pakFavRoots') || '[]'); } catch (e) { return []; }
    });
    useEffect(() => {
      try { localStorage.setItem('volo.pakFavRoots', JSON.stringify(favs)); } catch (e) { /* ignore */ }
    }, [favs]);
    const [query, setQuery] = useState('');
    const [view, setView] = useState('flat');
    const [sort, setSort] = useState('updated');
    const [sel, setSel] = useState([]);
    const [tileScale, setTileScale] = useState(150); /* 平铺矩形模块显示比例（列宽 px）*/
    /* 列表工具条（显示 / 排序 / 筛选）合并进一个 sliders 图标按钮，默认收起 */
    const [toolsOpen, setToolsOpen] = useState(false); /* 工具组是否展开 */
    const [openMenu, setOpenMenu] = useState(null);    /* 当前展开的二级菜单：view | sort | filter | null */
    const [filters, setFilters] = useState({ machine: null, pak: null, warnOnly: false }); /* 筛选策略 */
    const toolsRef = useRef(null);
    /* 点击工具组以外区域：收起工具组与二级菜单 */
    useEffect(() => {
      if (!toolsOpen && !openMenu) return;
      const onDown = (e) => { if (toolsRef.current && !toolsRef.current.contains(e.target)) { setToolsOpen(false); setOpenMenu(null); } };
      document.addEventListener('mousedown', onDown);
      return () => document.removeEventListener('mousedown', onDown);
    }, [toolsOpen, openMenu]);
    /* 清空已发现工程（真删除：delete_project 逐个移除 DB 记录，级联 project_locations；
       不动磁盘上的工程文件）+ 二次确认门。cleared 只做删除落地前的即时清屏。 */
    const [cleared, setCleared] = useState(false);
    const [confirmClear, setConfirmClear] = useState(false);

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
          (probe) => {
            if (!alive) return;
            thumbTriedRef.current.add(p.id);
            const t = probe && probe.thumbnail;
            const patch = {};
            if (t) Object.assign(patch, {
              thumb: 'data:image/png;base64,' + t.base64,
              thumbSrc: t.path,
              thumbFrom: THUMB_FROM_LABEL[t.from] || t.from,
              mtime: t.mtime || '',
            });
            if (probe && probe.size_bytes != null) patch.size = DDC.humanBytes(probe.size_bytes);
            if (Object.keys(patch).length) setThumbs((m) => Object.assign({}, m, { [p.id]: patch }));
            pump();
          },
          () => { if (alive) pump(); });
      };
      for (let i = 0; i < THUMB_CONCURRENCY; i++) pump();
      return () => { alive = false; };
    }, [UE_PROJECTS.length, thumbGen]);
    const withThumb = (p) => Object.assign({}, p, thumbs[p.id], { hasPak: deployedProjectIds.has(p.id) });

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
      /* 目标设备可选：默认全选，支持全选 / 逐台多选具体分发到哪几台（selectableScope，见 cache.tsx
         PreviewPanel/ModalPreview）；只对勾选设备执行，日志与完成提示按实际勾选数量。 */
      CX.openModalPreview(s, {
        title: '分发 DDC PAK · ' + dp.project.name, icon: 'download', cli: 'ddc distribute', destructive: false, channel: 'ssh',
        confirmLabelFn: (n) => '分发到 ' + n + ' 台',
        /* dispatchDone：对话框只负责下发——invoke 返回（preflight 通过、后台任务已启动）
           即翻「OK · 已开始分发」，用户随即可关闭去做别的；真实执行进度由右下角
           「运行中」任务进度条独家承担，两处不再重复显示。 */
        dispatchDone: true,
        doneTitle: 'OK · 已开始分发',
        doneMsg: (_r, picked) => '已开始把 ' + dp.project.name + ' 的 DDC PAK 分发到 ' + ((picked && picked.length) || targetIds.length) + ' 台渲染机 —— 后台任务已启动',
        steps: [
          '把该 PAK 从源机 ' + srcHost + ' 经 SSH 推送到所选机器',
          '目标机已有相同大小的 PAK 时自动跳过，不重复传输',
          '传输后校验大小并原子落位 DDC.ddp'],
        selectableScope: cand.map((n) => ({ id: n.machineId, host: n.host, ip: n.ip, msg: n.gpu })),
        run: (picked) => {
          const targets = (picked && picked.length) ? picked : targetIds;
          /* promise 在 invoke 返回（任务已启动）时落定 → dispatchDone 完成态；分发真正
             跑完（事件流终态）后由 onDone 刷新已部署列表。 */
          return s.runStreamingCmd(
            { domain: 'ddc', action: 'distribute', target: dp.project.name + ' · ' + targets.length + ' 台', chan: 'ssh', note: '分发 · ' + dp.project.name, quiet: true },
            () => distributeDdcPak(dp.source.machine_id, Number(dp.project.id), targets, null, null, null),
            { mode: 'event', events: ['pak-distribute-progress'], jobIdOf: (r) => r.job_id, total: (r) => (r.plan || []).length, reduce: DDC.batchReduce, timeoutMs: 30 * 60 * 1000,
              onDone: () => loadDeployed(true) });
        },
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

    /* ---------- 搜索根目录：可编辑行 + 一次添加多个 + 常用地址 ---------- */
    const rootVals = roots.map((r) => r.val.trim()).filter(Boolean);
    const rootsStr = rootVals.join(';');
    const addRoots = (str) => {
      const parts = String(str || '').split(/[;\n]+/).map((x) => x.trim()).filter(Boolean);
      if (!parts.length) return;
      setRoots((rs) => rs.concat(parts.filter((p) => !rs.some((r) => r.val === p)).map((p) => ({ id: ++ridRef.current, val: p }))));
    };
    const addRoot = (v) => addRoots(v);
    const updateRoot = (id, v) => setRoots((rs) => rs.map((r) => r.id === id ? { id, val: v } : r));
    const removeRoot = (id) => setRoots((rs) => rs.filter((r) => r.id !== id));
    const commitDraft = () => { addRoots(rootDraft.replace(/\\+$/, '')); setRootDraft(''); setAcOpen(false); };
    /* 常用地址：设为 / 取消常用、移除、判断（与磁盘上是否真实存在无关，纯本地收藏） */
    const normRoot = (v) => String(v || '').replace(/\\+$/, '').trim();
    const isFav = (v) => favs.includes(normRoot(v));
    const toggleFav = (v) => { const val = normRoot(v); if (!val) return; setFavs((f) => f.includes(val) ? f.filter((x) => x !== val) : f.concat(val)); };
    const removeFav = (v) => setFavs((f) => f.filter((x) => x !== v));

    /* ---------- 地址栏逐级路径提示：真实查询所选机器的盘符 / 子目录，而不是猜的目录名。
       scope 指定单台机器时只查那台；scope=全部在线机时对所有在线机并发查询后取并集去重——
       "全部在线机"是给"扫描范围"用的选择，不能悄悄退化成只查其中一台。 */
    const acNodes = scope !== 'all' ? [CX.node(scope)].filter(Boolean) : RENDER_NODES.filter((n) => n.status !== 'offline');
    const acMachineIds = acNodes.map((n) => n.machineId);
    const acMachineKey = acMachineIds.slice().sort((a, b) => a - b).join(',');
    const acScopeLabel = scope !== 'all' ? (acNodes[0] ? acNodes[0].host : null) : (acNodes.length ? ('跨 ' + acNodes.length + ' 台在线机') : null);
    const acText = acField === 'add' ? rootDraft : ((roots.find((r) => r.id === acField) || {}).val || '');
    const { parentPath, typed } = splitRootPath(acText);
    const openAc = (field) => { setAcField(field); setAcOpen(true); setAcHi(0); };
    /* 绝对根路径（如 "D:"）单独查询时须补回尾部反斜杠，否则 PowerShell 把 "D:" 解成
       "该进程在 D 盘的当前工作目录"而非盘符根——一个经典坑，SSH 起的全新进程虽通常仍落在
       根目录，但不该依赖这个不保证的隐式行为。 */
    const toSshPath = (p) => (/^[A-Za-z]:$/.test(p) ? p + '\\' : p);
    /* 并发查询所有目标机器，取并集去重——只要有一台查到就展示；全军覆没才算失败
       （partial success 不当失败处理，避免"全部在线机"里一台掉线就让整个提示报错）。 */
    const fetchDirs = (machineIds, path) => {
      const normPath = path == null ? null : toSshPath(path);
      const idKey = machineIds.slice().sort((a, b) => a - b).join(',');
      const key = idKey + '|' + (normPath || '');
      if (acCacheRef.current.has(key)) return Promise.resolve(acCacheRef.current.get(key));
      return Promise.allSettled(machineIds.map((id) => listRemoteDirectories(id, normPath))).then((results) => {
        const ok = results.filter((r) => r.status === 'fulfilled');
        if (!ok.length) throw new Error('all machines failed to list directories');
        const merged = Array.from(new Set(ok.flatMap((r) => r.value))).sort((a, b) => a.localeCompare(b));
        /* 只缓存"全员应答成功"的结果——若这次是部分失败（某台掉线/超时）拼出来的并集，
           不写入缓存，下次同一 (机器集, 路径) 会重新全员查询，不会把这次的残缺并集
           永久当作最终结果（那台机器哪怕之后恢复在线也不会再被查）。 */
        if (ok.length === machineIds.length) acCacheRef.current.set(key, merged);
        return merged;
      });
    };
    const [siblings, setSiblings] = useState([]);
    const [siblingsLoading, setSiblingsLoading] = useState(false);
    const [siblingsFailed, setSiblingsFailed] = useState(false);
    /* 第一层：parentPath 下的子项（parentPath=null → 盘符）。只在跨目录边界时才变化，
       同一段内继续打字不会重新发起请求——过滤靠下面的本地 startsWith，不占网络往返。 */
    useEffect(() => {
      if (!acOpen || !acMachineIds.length) return undefined;
      let cancelled = false;
      setSiblingsLoading(true); setSiblingsFailed(false);
      fetchDirs(acMachineIds, parentPath).then((entries) => {
        if (cancelled) return;
        setSiblings(entries); setSiblingsLoading(false);
      }).catch(() => { if (!cancelled) { setSiblings([]); setSiblingsLoading(false); setSiblingsFailed(true); } });
      return () => { cancelled = true; };
    }, [acOpen, acMachineKey, parentPath]);
    /* 已输入到的最后一段若精确命中（大小写不敏感）某个真实子目录名，立即下钻显示它的
       子项——覆盖"已设好的路径行左键点击也会下钻"，含只有一级路径的情况。 */
    const exactName = typed ? (siblings.find((x) => x.toLowerCase() === typed.toLowerCase()) || null) : null;
    const deeperPath = exactName ? (parentPath == null ? exactName : parentPath + '\\' + exactName) : null;
    const [deeperEntries, setDeeperEntries] = useState([]);
    const [deeperLoading, setDeeperLoading] = useState(false);
    const [deeperFailed, setDeeperFailed] = useState(false);
    useEffect(() => {
      if (!acOpen || !acMachineIds.length || deeperPath == null) return undefined;
      let cancelled = false;
      setDeeperLoading(true); setDeeperFailed(false);
      fetchDirs(acMachineIds, deeperPath).then((entries) => {
        if (cancelled) return;
        setDeeperEntries(entries); setDeeperLoading(false);
      }).catch(() => { if (!cancelled) { setDeeperEntries([]); setDeeperLoading(false); setDeeperFailed(true); } });
      return () => { cancelled = true; };
    }, [acOpen, acMachineKey, deeperPath]);
    const acDrilled = !!deeperPath;
    const acBase = acDrilled ? (deeperPath + '\\') : (parentPath == null ? '' : parentPath + '\\');
    const acLoading = acDrilled ? deeperLoading : siblingsLoading;
    const acFailed = acDrilled ? deeperFailed : siblingsFailed;
    const acOpts = acDrilled ? deeperEntries : siblings.filter((c) => !typed || c.toLowerCase().startsWith(typed.toLowerCase()));
    /* 确认使用某一层（左键点击 / Tab）：拼上该项 + 反斜杠，自动弹出它的下一级 */
    const confirmSeg = (opt) => {
      const next = acBase + opt + '\\';
      if (acField === 'add') setRootDraft(next); else updateRoot(acField, next);
      setAcHi(0); setAcOpen(true);
    };
    const makeAcKey = (field) => (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!acOpen) openAc(field); else setAcHi((hI) => acOpts.length ? (hI + 1) % acOpts.length : 0); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (!acOpen) openAc(field); else setAcHi((hI) => acOpts.length ? (hI - 1 + acOpts.length) % acOpts.length : 0); }
      else if (e.key === 'Tab') { if (acOpen && acOpts.length) { e.preventDefault(); confirmSeg(acOpts[Math.max(0, acHi)]); } }
      else if (e.key === 'Enter') { e.preventDefault(); if (field === 'add') commitDraft(); else setAcOpen(false); }
      else if (e.key === 'Escape') { setAcOpen(false); }
    };
    const renderAc = () => h('div', { className: 'root-ac' },
      h('div', { className: 'root-ac-h' }, !acMachineIds.length ? '选择根目录' : ('在 ' + acScopeLabel + (parentPath == null ? ' 选择盘符' : (' 的 ' + acBase + ' 下选择文件夹')))),
      !acMachineIds.length
        ? h('div', { className: 'root-ac-empty' }, '当前无在线机器可浏览 · 可直接输入完整路径')
        : acLoading
          ? h('div', { className: 'root-ac-empty' }, h(Icon, { name: 'sync', size: 12 }), ' 查询中…')
          : acFailed
            ? h('div', { className: 'root-ac-empty' }, '无法连接 ' + acScopeLabel + ' · 可直接输入完整路径')
            : acOpts.length
              ? h('div', { className: 'root-ac-list' }, acOpts.map((opt, i) => h('button', {
                  key: opt, type: 'button', className: 'root-ac-opt' + (i === acHi ? ' hi' : ''),
                  onMouseEnter: () => setAcHi(i),
                  onMouseDown: (e) => e.preventDefault(),
                  onClick: () => confirmSeg(opt) },
                  h('span', { className: 'root-ac-ic' }, h(Icon, { name: parentPath == null ? 'server' : 'folder', size: 13 })),
                  h('span', { className: 'root-ac-tx' }, opt),
                  h('span', { className: 'root-ac-kbd' }, i === acHi ? 'Tab 使用' : ''))))
              : h('div', { className: 'root-ac-empty' }, acText.replace(/\\+$/, '').trim() ? '已到末级 · 无更多子文件夹' : '无匹配项'),
      h('div', { className: 'root-ac-foot' }, '↑↓ 选择 · Tab / 单击 确认使用 · 回车确认'));
    /* 点击提示以外区域：收起下拉 */
    useEffect(() => {
      if (!acOpen) return undefined;
      const onDown = (e) => { if (!e.target.closest('.root-add') && !e.target.closest('.root-row')) setAcOpen(false); };
      document.addEventListener('mousedown', onDown);
      return () => document.removeEventListener('mousedown', onDown);
    }, [acOpen]);

    /* gate 必须在【全部】Hooks 之后才能条件 return——这里是本组件最后一个 Hook 之后的
       第一行。此前 gate 放在中段（地址栏自动补全的一串 useState/useEffect 之前），
       reloadCache 让 s.cacheLoading 翻转时两次渲染的 Hook 数量不一致，React 抛
       "Rendered fewer hooks than expected" 崩掉整个面板。 */
    const g = DDC.gate(s); if (g) return g;
    const doScan = () => {
      setCleared(false); setConfirmClear(false);
      const scanned = DDC.runDiscover(s, scope, rootsStr);
      if (scanned) scanned.then(() => { thumbTriedRef.current = new Set(); setThumbGen((g) => g + 1); });
    };
    /* 清空已发现工程 —— 从 Volo 数据库删除全部工程记录（级联各机位置），不删磁盘文件。
       此前只 setCleared 清屏不删库，重扫后旧记录（DB 里仍在）原样回来，等于没清 —— 现在
       真删 + reloadCache，重扫只按当前搜索根目录重新发现。已部署列表引用这些 project_id，
       删完顺带静默刷新，让左栏丢弃陈旧分组。 */
    const clearList = () => {
      setCleared(true); setSel([]); setConfirmClear(false);
      const ids = UE_PROJECTS.map((p) => Number(p.id));
      if (!ids.length) return;
      s.runCmd(
        { domain: 'project', action: 'clear', target: ids.length + ' 个工程', chan: 'local', note: '清空已发现工程记录', quiet: true },
        () => Promise.allSettled(ids.map((id) => deleteProject(id))).then((rs) => {
          const ok = rs.filter((r) => r.status === 'fulfilled').length;
          if (!ok) throw new Error('全部删除失败');
          return { ok, failed: ids.length - ok };
        }),
        { okMsg: (r) => '已清空 ' + r.ok + ' 个工程记录' + (r.failed ? ('（' + r.failed + ' 个失败）') : '') + ' · 磁盘文件未动' })
        .then(() => { s.reloadCache(); loadDeployed(true); }, () => {});
    };

    /* ---------- 过滤 / 排序 / 分组 ---------- */
    const q = query.trim().toLowerCase();
    /* 筛选策略：按机器 / PAK 状态（真实 deployedProjectIds）/ 版本不一致（真实 warn，见后端
       027_project_locations_ue_version 迁移）—— 与搜索叠加生效 */
    const activeFilterCount = (filters.machine ? 1 : 0) + (filters.pak ? 1 : 0) + (filters.warnOnly ? 1 : 0);
    const passFilters = (p) => {
      if (filters.machine && !p.machines.includes(filters.machine)) return false;
      /* deployedRaw == null：已部署列表首次扫描还没回来，deployedProjectIds 此刻恒为空集——
         这时候拿它筛选会把真正已有 PAK 的工程也误判成"无匹配"，等真扫完再让这条筛选生效。 */
      if (deployedRaw != null) {
        if (filters.pak === 'has' && !deployedProjectIds.has(p.id)) return false;
        if (filters.pak === 'none' && deployedProjectIds.has(p.id)) return false;
      }
      if (filters.warnOnly && !p.warn) return false;
      return true;
    };
    const clearFilters = () => setFilters({ machine: null, pak: null, warnOnly: false });
    const matched = cleared ? [] : UE_PROJECTS.filter((p) => (!q
      || p.name.toLowerCase().includes(q) || (p.root + '\\' + p.uproject).toLowerCase().includes(q)) && passFilters(p));
    /* 有已发现工程的机器（供「按机器」显示 / 「按机器筛选」策略使用） */
    const projMachines = RENDER_NODES.filter((n) => UE_PROJECTS.some((p) => p.machines.includes(n.id)));
    const machineProjCount = (id) => (cleared ? [] : UE_PROJECTS).filter((p) => p.machines.includes(id)).length;
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
    /* forMachineId 只在「按机器」视图传入：该分组行的 hasPak 徽章按这台机器实际是否持有 PAK
       重算，而不是沿用 withThumb 给的工程级 hasPak（源机持有≠这台机器也持有）。「文件夹」
       分组视图不传，沿用工程级语义（与「列表」平铺视图一致）。 */
    const groupBlock = (key, icon, title, items, forMachineId) => h('div', { key, className: 'pak-group' },
      h('div', { className: 'pak-group-h' }, h(Icon, { name: icon, size: 13 }),
        h('span', { className: 'mono' }, title), h('span', { className: 'ct' }, items.length + ' 个')),
      h('div', { className: 'proj-list' }, items.map((p) => {
        const vm = withThumb(p);
        const row = forMachineId
          ? Object.assign({}, vm, { hasPak: (deployedHoldersByProject.get(p.id) || new Set()).has(forMachineId) })
          : vm;
        return DDC.projRow(row, sel.includes(p.id), toggleSel, s);
      })));
    const listBody = sorted.length === 0
      ? h('div', { className: 'pak-list-empty' }, h(Icon, { name: 'search', size: 22 }),
          h('span', null, q ? ('无匹配「' + query + '」的工程')
            : activeFilterCount ? '当前筛选无匹配工程 · 调整或清除筛选'
            : cleared ? '已清空列表 · 点上方「扫描」重新发现工程' : '尚未发现工程，点上方「扫描」'))
      : view === 'grouped'
        ? (() => {
            const groups = [];
            sorted.forEach((p) => {
              const dir = parentDir(p);
              let grp = groups.find((x) => x.dir === dir);
              if (!grp) { grp = { dir, items: [] }; groups.push(grp); }
              grp.items.push(p);
            });
            return h(React.Fragment, null, groups.map((grp) => groupBlock(grp.dir, 'folder', grp.dir, grp.items)));
          })()
        : view === 'machine'
          ? (() => {
              /* 每台机器一组，列出它持有的工程（工程可跨多台机器出现） */
              const rows = projMachines.map((n) => ({ n, items: sorted.filter((p) => p.machines.includes(n.id)) }))
                .filter((g) => g.items.length);
              return rows.length === 0
                ? h('div', { className: 'pak-list-empty' }, h(Icon, { name: 'server', size: 22 }), h('span', null, '当前筛选下没有机器持有工程'))
                : h(React.Fragment, null, rows.map((g) => groupBlock(g.n.id, 'server', g.n.host, g.items, g.n.id)));
            })()
          : h('div', { className: 'proj-grid', style: tileStyle }, sorted.map((p) => projTile(withThumb(p), sel.includes(p.id), toggleSel, s)));

    /* 列表工具条 · 全选（左）+ 合并的「显示 / 排序 / 筛选」图标组（右） */
    /* 二级菜单：点击图标弹出，纯图标触发、菜单内做详细设置 */
    const viewMenu = h('div', { className: 'pak-tool-menu' },
      h('div', { className: 'ptm-h' }, '显示方式'),
      VIEW_OPTS.map((o) => h('button', { key: o.id, type: 'button', className: 'ptm-i' + (view === o.id ? ' on' : ''), onClick: () => setView(o.id) },
        h('span', { className: 'ptm-ic' }, h(Icon, { name: o.icon, size: 14 })),
        h('div', { className: 'ptm-mm' }, h('span', { className: 'ptm-l' }, o.label), h('span', { className: 'ptm-s' }, o.hint)),
        view === o.id ? h(Icon, { name: 'check', size: 14, style: { marginLeft: 'auto', color: 'var(--volo-400)' } }) : null)));
    const sortMenu = h('div', { className: 'pak-tool-menu' },
      h('div', { className: 'ptm-h' }, '排序方式'),
      SORT_OPTS.map((o) => h('button', { key: o.id, type: 'button', className: 'ptm-i' + (sort === o.id ? ' on' : ''), onClick: () => setSort(o.id) },
        h('span', { className: 'ptm-l' }, o.label),
        sort === o.id ? h(Icon, { name: 'check', size: 14, style: { marginLeft: 'auto', color: 'var(--volo-400)' } }) : null)));
    const setPak = (v) => setFilters((f) => Object.assign({}, f, { pak: f.pak === v ? null : v }));
    const filterMenu = h('div', { className: 'pak-tool-menu pak-filter-menu' },
      h('div', { className: 'ptm-h' }, '筛选策略',
        activeFilterCount ? h('button', { type: 'button', className: 'ptm-clear', onClick: clearFilters }, '清除 ' + activeFilterCount) : null),
      h('div', { className: 'ptm-group' },
        h('div', { className: 'ptm-group-h' }, h(Icon, { name: 'server', size: 12 }), '按机器筛选',
          h('span', { className: 'ptm-group-s' }, '只显示相关工程')),
        projMachines.map((n) => h('button', { key: n.id, type: 'button', className: 'ptm-i' + (filters.machine === n.id ? ' on' : ''),
            onClick: () => setFilters((f) => Object.assign({}, f, { machine: f.machine === n.id ? null : n.id })) },
          h('span', { className: 'ptm-dot', style: { background: n.status === 'offline' ? 'var(--chrome-faint)' : 'var(--positive-visual)' } }),
          h('div', { className: 'ptm-mm' }, h('span', { className: 'ptm-l mono' }, n.host), h('span', { className: 'ptm-s' }, machineProjCount(n.id) + ' 个工程')),
          filters.machine === n.id ? h(Icon, { name: 'check', size: 14, style: { marginLeft: 'auto', color: 'var(--volo-400)' } }) : null))),
      h('div', { className: 'ptm-group' },
        h('div', { className: 'ptm-group-h' }, h(Icon, { name: 'filter', size: 12 }), '常用策略'),
        h('button', { type: 'button', className: 'ptm-i' + (filters.pak === 'has' ? ' on' : ''), onClick: () => setPak('has') },
          h('span', { className: 'ptm-l' }, '仅已生成 PAK'), filters.pak === 'has' ? h(Icon, { name: 'check', size: 14, style: { marginLeft: 'auto', color: 'var(--volo-400)' } }) : null),
        h('button', { type: 'button', className: 'ptm-i' + (filters.pak === 'none' ? ' on' : ''), onClick: () => setPak('none') },
          h('span', { className: 'ptm-l' }, '仅未生成 PAK'), filters.pak === 'none' ? h(Icon, { name: 'check', size: 14, style: { marginLeft: 'auto', color: 'var(--volo-400)' } }) : null),
        h('button', { type: 'button', className: 'ptm-i' + (filters.warnOnly ? ' on' : ''), onClick: () => setFilters((f) => Object.assign({}, f, { warnOnly: !f.warnOnly })) },
          h('span', { className: 'ptm-l' }, '仅版本不一致'), filters.warnOnly ? h(Icon, { name: 'check', size: 14, style: { marginLeft: 'auto', color: 'var(--volo-400)' } }) : null)));

    const toolBtn = (id, label, iconName, menu, badge) => h('div', { className: 'pak-tool', key: id },
      h('button', { type: 'button', className: 'pak-tool-ic' + (openMenu === id ? ' on' : ''), 'data-tip': label, 'aria-label': label,
          onClick: () => setOpenMenu((m) => (m === id ? null : id)) },
        h(Icon, { name: iconName, size: 15 }),
        badge ? h('span', { className: 'pak-tool-badge' }, badge) : null),
      openMenu === id ? menu : null);

    const listBar = sorted.length === 0 && !activeFilterCount ? null
      : h('div', { className: 'pak-list-bar' },
          h('button', { type: 'button',
              className: 'pak-selall' + (allSelected ? ' on' : someSelected ? ' part' : ''),
              onClick: toggleAll,
              title: allSelected ? '取消全选' : '选择全部可见工程' },
            h('span', { className: 'pak-selall-box' },
              allSelected ? h(Icon, { name: 'check', size: 12 }) : someSelected ? h(Icon, { name: 'minus', size: 12 }) : null),
            h('span', { className: 'pak-selall-tx' }, allSelected ? '取消全选' : '全选'),
            h('span', { className: 'pak-selall-ct' }, visibleSelectedCount ? (visibleSelectedCount + ' / ' + sorted.length) : (sorted.length + ' 个工程'))),
          h('div', { className: 'pak-list-tools' + (toolsOpen ? ' open' : ''), ref: toolsRef },
            toolsOpen ? h(React.Fragment, null,
              toolBtn('view', '显示方式', VIEW_OPTS.find((o) => o.id === view).icon, viewMenu),
              toolBtn('sort', '排序方式', 'sort', sortMenu),
              toolBtn('filter', '筛选策略', 'filter', filterMenu, activeFilterCount || null)) : null,
            h('button', { type: 'button', className: 'pak-tools-toggle' + (toolsOpen ? ' on' : '') + (activeFilterCount ? ' has-filter' : ''),
                'data-tip': toolsOpen ? '收起' : '显示 · 排序 · 筛选', 'aria-label': toolsOpen ? '收起工具' : '显示 · 排序 · 筛选',
                onClick: () => { setToolsOpen((v) => !v); setOpenMenu(null); } },
              h(Icon, { name: toolsOpen ? 'x' : 'sliders', size: 16 }),
              !toolsOpen && activeFilterCount ? h('span', { className: 'pak-tools-badge' }, activeFilterCount) : null)),
          view === 'flat'
            ? h('div', { className: 'pak-zoom pak-zoom--bar' },
                h('span', { className: 'pak-zoom-ic sm' }, h(Icon, { name: 'grid', size: 12 })),
                h('input', { type: 'range', className: 'pak-zoom-range', min: 118, max: 220, step: 1,
                  value: tileScale, 'aria-label': '显示比例', onChange: (e) => setTileScale(+e.target.value) }),
                h('span', { className: 'pak-zoom-ic lg' }, h(Icon, { name: 'grid', size: 17 })))
            : null);

    return h('div', { className: 'res ddc pak-page' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, 'DDC · DDC PAK'),
        h('div', { className: 'right' },
          h('span', { className: 'toolchip' }, h(Icon, { name: 'cache', size: 14 }), '已部署 ' + deployed.length + ' 个'),
          h('span', { className: 'toolchip' }, h(Icon, { name: 'film', size: 14 }), '发现 ' + (cleared ? 0 : UE_PROJECTS.length) + ' 工程'))),
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
              h('div', { className: 'pak-ctl scan' }, h('label', null, '扫描范围'),
                /* popover min-width(210) 比按钮(168)宽：默认右对齐会向左溢出栏边界，
                   被 .pak2-col overflow:hidden 裁切 → 必须左对齐向栏内展开 */
                h(Selector, { kpre: '范围', value: scope, options: DDC.scopeOpts(), width: 168, align: 'left', onChange: setScope })),
              h('div', { className: 'pak-ctl' }, h('label', { style: { visibility: 'hidden' } }, '扫描'),
                h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'search', size: 14 }), onPress: doScan }, '扫描'))),
            h('div', { className: 'pak-roots' },
              h('div', { className: 'pak-roots-h' }, h('span', { className: 't' }, '搜索根目录'),
                h('span', { className: 'dim' }, '可多个 · 点击地址栏逐级选择盘符 / 文件夹 · 生成时以分号拼接')),
              h('div', { className: 'pak-root-rows' },
                roots.map((r) => h('div', { key: r.id, className: 'root-row' + (acOpen && acField === r.id ? ' ac-active' : '') },
                  h('span', { className: 'root-row-ic' }, h(Icon, { name: 'folder', size: 13 })),
                  h('input', { className: 'root-in', value: r.val, spellCheck: false, autoComplete: 'off', placeholder: '输入工程根目录…',
                    onChange: (e) => { updateRoot(r.id, e.target.value); openAc(r.id); },
                    onFocus: () => openAc(r.id),
                    onClick: () => openAc(r.id),
                    onKeyDown: makeAcKey(r.id) }),
                  h('button', { className: 'root-row-fav' + (isFav(r.val) ? ' on' : ''), type: 'button',
                    title: isFav(r.val) ? '已设为常用 · 点击取消' : '设为常用',
                    disabled: !normRoot(r.val), onClick: () => toggleFav(r.val) }, h(Icon, { name: 'star', size: 13 })),
                  h('button', { className: 'root-row-x', title: '移除', onClick: () => removeRoot(r.id) }, h(Icon, { name: 'x', size: 13 })),
                  acOpen && acField === r.id ? renderAc() : null))),
              h('div', { className: 'root-add' + (acOpen && acField === 'add' ? ' open' : '') },
                h(Icon, { name: 'plus', size: 13 }),
                h('input', { value: rootDraft, spellCheck: false, autoComplete: 'off',
                  placeholder: '点击选择盘符，或直接输入根目录…',
                  onChange: (e) => { setRootDraft(e.target.value); openAc('add'); },
                  onFocus: () => openAc('add'),
                  onClick: () => openAc('add'),
                  onKeyDown: makeAcKey('add') }),
                h('button', { className: 'root-add-btn', disabled: !rootDraft.trim(), onClick: commitDraft }, '添加'),
                acOpen && acField === 'add' ? renderAc() : null),
              favs.length ? h('div', { className: 'pak-favs' },
                h('span', { className: 'pf-label' }, h(Icon, { name: 'star', size: 12 }), '常用地址'),
                h('div', { className: 'pf-chips' }, favs.map((f) => h('div', { key: f, className: 'pf-chip' + (rootVals.includes(f) ? ' added' : '') },
                  h('button', { className: 'pf-chip-use', type: 'button', disabled: rootVals.includes(f),
                    title: rootVals.includes(f) ? '已在搜索根目录中' : '点击加入搜索根目录',
                    onClick: () => addRoot(f) },
                    h(Icon, { name: rootVals.includes(f) ? 'check' : 'folder', size: 11 }), f),
                  h('button', { className: 'pf-chip-x', type: 'button', title: '从常用中移除', onClick: () => removeFav(f) }, h(Icon, { name: 'x', size: 11 })))))) : null),
            h('div', { className: 'pak-scan-meta' }, h(Icon, { name: 'check', size: 12 }), '已发现 ' + UE_PROJECTS.length + ' 个工程位置 · 远程扫 .uproject 只发现不写盘'),
            listBar,
            listBody),
          h('div', { className: 'pak2-foot' + (confirmClear ? ' confirming' : '') },
            confirmClear
              ? h(React.Fragment, null,
                  h('span', { className: 'pak-genbar-info' }, h(Icon, { name: 'alert', size: 13 }),
                    h('span', null, '确认清空已发现工程？将从 Volo 移除全部工程记录（不删除磁盘上的工程文件），之后可按新的搜索根目录重新扫描。')),
                  h('span', { className: 'pak-genbar-spacer' }),
                  h(Button, { variant: 'secondary', size: 'M', onPress: () => setConfirmClear(false) }, '取消'),
                  h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'x', size: 14 }), onPress: clearList }, '确认清空'))
              : h(React.Fragment, null,
                  h('span', { className: 'pak-genbar-info' }, h(Icon, { name: 'info', size: 12 }),
                    sel.length ? h(React.Fragment, null, '已选 ', h('b', null, sel.length), ' 个工程 · 仅工程级 Pak（DDC.ddp）') : '勾选工程后生成 DDC PAK'),
                  h('span', { className: 'pak-genbar-spacer' }),
                  h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'x', size: 14 }), isDisabled: sorted.length === 0, onPress: () => setConfirmClear(true) }, '清空'),
                  h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), isDisabled: sel.length === 0, onPress: generateSelected },
                    '生成 DDC PAK' + (sel.length ? '（' + sel.length + '）' : '')))))));
  }

  window.VOLO_CACHE_DDC_PAK = { page: (s) => h(PakPage, { s }) };
})();

export {};
