// @ts-nocheck
/* Volo — Cache · DDC 管理 (§6) — 折叠子菜单分视图：ZenServer / 传统 DDC(本地+共享) / DDC PAK / PSO.
   1:1 port of the Claude Design handoff `src/cache_ddc.jsx`. */
import * as React from "react";
import "../ds";
import "./cache";

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState } = React;
  const h = React.createElement;
  const CX = window.VOLO_CX;

  const TITLE = { ddc_zen: 'ZenServer', ddc_legacy: '文件系统 DDC', ddc_pak: 'DDC PAK', ddc_pso: 'PSO 缓存' };

  function DDC({ s }) {
    const [dataDir, setDataDir] = useState('D:\\ZenData');
    const [srv, setSrv] = useState('rn0');
    const [zenReadback, setZenReadback] = useState(true); /* render-zen-01 已部署 */
    const [clientDir, setClientDir] = useState('D:\\ZenData\\Local'); /* 客户端本地 data 路径 */
    const [joined, setJoined] = useState(() => RENDER_NODES.filter((n) => n.roleKey !== 'shared' && n.zen === 'render-zen-01').map((n) => n.id));
    /* 文件系统 DDC · 本地 DDC：每台机器独立路径 + 独立/一键部署 */
    const [localDirs, setLocalDirs] = useState(() => {
      const m = {};
      RENDER_NODES.forEach((n) => { const drv = /^([A-Za-z]):/.test(n.uePath) ? n.uePath[0].toUpperCase() : 'D'; m[n.id] = drv + ':\\UE_DDC\\Local'; });
      return m;
    });
    const [localDeployed, setLocalDeployed] = useState(() => RENDER_NODES.filter((n) => n.status !== 'offline').map((n) => n.id));
    /* DDC PAK：扫工程 → 选工程 → 生成 */
    const [pakProj, setPakProj] = useState(null);
    const [pakSrc, setPakSrc] = useState(null);
    const [pakBackend, setPakBackend] = useState('zen');
    const [pakRoots, setPakRoots] = useState('D:\\Projects;E:\\UEProjects');
    const [pakScope, setPakScope] = useState('all');
    const [pakVerify, setPakVerify] = useState({}); /* projId -> verify_pak_output 结果 */
    const [shareCred, setShareCred] = useState('c1'); /* 共享 DDC 创建/接入的运维凭据 */
    /* PSO：按机器搜工程 → 选工程 → 收集（PSO 按 GPU 签名生成） */
    const [psoProj, setPsoProj] = useState(null);
    const [psoSrc, setPsoSrc] = useState(null);
    const [psoRes, setPsoRes] = useState('1920×1080');
    const [psoMax, setPsoMax] = useState('20');
    const [psoScope, setPsoScope] = useState('all');
    const [psoRoots, setPsoRoots] = useState('D:\\Projects;E:\\UEProjects');

    const view = /^ddc_/.test(s.cacheNav) ? s.cacheNav : 'ddc_zen';
    const zen = ZEN_ENDPOINTS[0];
    const ddcPaks = ARTIFACTS.filter((a) => a.kind === 'DDC pak');
    const psos = ARTIFACTS.filter((a) => a.kind === 'PSO');
    const srvOpts = RENDER_NODES.map((n) => ({ id: n.id, label: n.host, sub: n.ip }));
    const credList = s.creds || CREDS;
    const credOpts = credList.map((c) => ({ id: c.id, label: c.name, sub: c.kind }));
    const credName = (id) => (credList.find((c) => c.id === id) || credList[0] || { name: '—' }).name;

    /* ---- deploy flows ---- */
    const deployZen = () => CX.openPreview(s, {
      title: '部署 ZenServer', icon: 'cube', cli: 'zen register → … → enable', destructive: false, channel: 'winrm', confirmLabel: '部署',
      steps: ['在这台机器上安装并登记 ZenServer 缓存服务', '后台自动配置访问权限并启动服务（凭据等无需你手动处理）', '确认服务正常后，把它设为全集群共用的缓存上游，并自动复核配置是否写对'],
      simpleScope: [{ host: CX.node(srv).host, ip: CX.node(srv).ip, msg: 'data-dir ' + dataDir }],
      readback: { key: '[StorageServers] Shared', expected: 'Host=render-zen-01;Port=1337' },
      task: { domain: 'zen', action: 'deploy', target: CX.node(srv).host, chan: 'winrm', note: 'ZenServer 部署链路（后台逐步执行）',
        lines: ['zen register render-zen-01 :1337', 'zen apply-config → zen.lua（SHA256 a91f…7c2d）', 'urlacl add + service install + start（提权 SSH 自动处理）', 'zen probe → HTTP 200 /health', 'zen enable → 写 [StorageServers] Shared'].map((m, i, a) => ({ lv: i === a.length - 1 ? 'ok' : 'info', msg: m })) },
      onConfirm: () => setZenReadback(true),
    });
    const deploySMB = () => CX.openPreview(s, {
      title: '创建共享 DDC（SMB）', icon: 'folder', cli: 'create_share', destructive: false, channel: 'ssh', confirmLabel: '创建共享',
      steps: ['使用运维凭据 ' + credName(shareCred) + ' 在这台机器上新建一个共享缓存文件夹', '自动把集群的缓存指向这个共享文件夹', '其他机器会自动连接并开始使用这个共享缓存'],
      simpleScope: [{ host: CX.node(srv).host, ip: CX.node(srv).ip, msg: '共享盘宿主' }],
      task: { domain: 'share', action: 'create', target: CX.node(srv).host, chan: 'ssh', note: 'SMB 共享 DDC 已创建（凭据 ' + credName(shareCred) + '）', lines: [{ msg: 'create_share \\\\ddc01\\Volo\\DDC --cred ' + credName(shareCred) }, { lv: 'ok', msg: '共享创建完成，backend-graph 已写入' }] },
    });
    /* 删除共享 DDC：仅从 Volo 解除纳管，不删远端共享文件夹（后端暂不支持 also_remove_remote）*/
    const deleteShare = (sh) => CX.openPreview(s, {
      title: '解除共享纳管 · ' + sh.path, icon: 'trash', cli: 'delete_share', destructive: true, channel: 'ssh', confirmLabel: '解除纳管',
      steps: ['从 Volo 解除对该共享的纳管（不再分发 / 不再注入客户端）', '不会删除远端共享文件夹本身（后端暂不支持远端删共享）'],
      simpleScope: [{ host: sh.path, ip: sh.clients + ' 客户端', msg: '仅解除纳管' }],
      task: { domain: 'share', action: 'delete', target: sh.path, chan: 'ssh', note: '已解除共享纳管（远端文件夹保留）', lines: [{ lv: 'warn', msg: 'delete_share ' + sh.path + ' (also_remove_remote=false)' }, { lv: 'ok', msg: '已从 Volo 解除纳管 · 远端共享文件夹保留' }] },
    });
    const deployLocal = () => CX.openPreview(s, {
      title: '开启本地 DDC', icon: 'server', cli: 'local-cache create', destructive: false, channel: 'winrm', confirmLabel: '开启',
      steps: ['在这台机器本地新建一个缓存目录', '作为找不到共享缓存时的本地兜底'],
      simpleScope: [{ host: CX.node(srv).host, ip: CX.node(srv).ip, msg: '本地缓存目录' }],
      task: { domain: 'local-cache', action: 'create', target: CX.node(srv).host, chan: 'winrm', note: '本地 DDC 已开启', lines: [{ msg: 'local-cache create D:\\UE_DDC\\Local' }, { lv: 'ok', msg: '本地缓存层已就绪' }] },
    });

    /* ---- cache content ---- */
    /* discover_projects：远程扫各机 .uproject（只发现不写盘） */
    const scanProjects = () => s.runTask({ domain: 'project', action: 'discover', target: pakScope === 'all' ? '全部在线机' : CX.node(pakScope).host, chan: 'winrm', note: '远程扫描 UE 工程（.uproject）',
      lines: [
        { msg: 'discover_projects --scope ' + (pakScope === 'all' ? 'online' : CX.node(pakScope).host) + ' --roots "' + pakRoots + '"' },
        { msg: 'RNODE-01 → D:\\Projects\\Helios\\Helios.uproject（UE 5.4.4）' },
        { msg: 'WS-ART-01 → D:\\Projects\\Aurora\\Aurora.uproject（UE 5.4.4）' },
        { msg: 'RNODE-05 → E:\\UEProjects\\Nomad\\Nomad.uproject（UE 5.4.3）' },
        { lv: 'ok', msg: '发现 3 个工程 / 6 台机器，已对齐项目身份' },
      ] });
    /* PSO 也走 discover_projects（同一份工程库），可按单台机器搜索 */
    const scanPso = () => s.runTask({ domain: 'project', action: 'discover', target: psoScope === 'all' ? '全部在线机' : CX.node(psoScope).host, chan: 'winrm', note: '远程扫描 UE 工程（.uproject）',
      lines: [
        { msg: 'discover_projects --scope ' + (psoScope === 'all' ? 'online' : CX.node(psoScope).host) + ' --roots "' + psoRoots + '"' },
        { msg: 'RNODE-01 → Helios.uproject · WS-ART-01 → Aurora.uproject · RNODE-05 → Nomad.uproject' },
        { lv: 'ok', msg: '发现 3 个工程 / 6 台机器，已对齐项目身份' },
      ] });
    /* generate_ddc_pak：针对选定工程 + 源机器 + 后端，编 shader 生成 PAK（长任务） */
    const genPak = () => {
      const p = UE_PROJECTS.find((x) => x.id === pakProj);
      if (!p) return;
      const src = CX.node(pakSrc) || CX.node(p.primary);
      s.runTask({ domain: 'ddc', action: 'generate', target: p.name + ' ' + p.ue, chan: 'winrm', note: '生成 DDC PAK · ' + p.name + '（长任务）',
        lines: [
          { msg: 'generate_ddc_pak --project ' + p.name + ' --src ' + src.host + ' --backend ' + pakBackend + ' --ue ' + p.ue },
          { msg: '载入 ' + p.root + '\\' + p.uproject },
          { msg: '编译 shader 1/6650 …' },
          { msg: '编译 shader 4128/6650 …' },
          { lv: 'ok', msg: 'DDC PAK 生成完成 · DDC_' + p.name + '_' + p.ue + '_' + pakBackend },
        ] });
    };
    /* start_pso_collection：针对选定工程 + 源机器收集 PSO（按该机 GPU 签名；长任务 · NDJSON） */
    const collectPso = () => {
      const p = UE_PROJECTS.find((x) => x.id === psoProj);
      if (!p) return;
      const src = CX.node(psoSrc) || CX.node(p.primary);
      s.runTask({ domain: 'pso', action: 'collect', target: p.name + ' ' + p.ue, chan: 'winrm', note: '收集 PSO 缓存 · ' + p.name + '（长任务 · NDJSON）',
        lines: [
          { msg: 'start_pso_collection --project ' + p.name + ' --src ' + src.host + ' --res ' + psoRes + ' --max ' + psoMax + 'min' },
          { msg: 'GPU 签名：' + src.gpu + '（' + src.vendor + '）· -game 窗口化收集' },
          { msg: '{"event":"pso","created":128}' },
          { msg: '{"event":"pso","created":402}' },
          { lv: 'ok', msg: 'PSO 收集完成 · PSO_' + p.name + '_' + p.ue },
        ] });
    };
    const distribute = (art) => {
      const isPso = art.kind === 'PSO';
      CX.openPreview(s, {
        title: '分发 · ' + art.name, icon: 'download', cli: (isPso ? 'pso' : 'ddc') + ' distribute', destructive: false, channel: 'winrm',
        steps: ['把这份缓存包复制分发到各台渲染机', isPso ? '分发前自动比对各机显卡是否匹配，不用你手动核对' : '只传缺少的部分，已经有的自动跳过', '只有真的不匹配时才会弹出提醒'],
        scope: RENDER_NODES.filter((n) => n.status !== 'offline' && n.roleKey === 'render').map((n) => n.id),
        task: { domain: isPso ? 'pso' : 'ddc', action: 'distribute', target: art.name, chan: 'winrm', note: '分发完成',
          lines: [{ msg: (isPso ? 'pso' : 'ddc') + ' distribute ' + art.name }, isPso ? { msg: 'GPU preflight：全部匹配，无警告' } : { msg: 'Robocopy 增量同步 …' }, { lv: 'ok', msg: '分发完成至目标机' }] },
      });
    };

    const artRow = (a) => h('div', { key: a.id, className: 'art-row' },
      h('span', { className: 'art-dot s-' + (a.verified ? 'positive' : 'notice') }, h(Icon, { name: a.verified ? 'check' : 'alert', size: 12 })),
      h('div', { className: 'art-meta' }, h('div', { className: 'art-name mono' }, a.name), h('div', { className: 'art-sub' }, a.size + ' · ' + a.built + (a.verified ? ' · 已校验' : ' · 未校验'))),
      h('button', { className: 'mini-btn', onClick: () => distribute(a) }, h(Icon, { name: 'download', size: 12 }), '分发'));

    const shareRow = (sh) => h('div', { key: sh.id, className: 'art-row' },
      h('span', { className: 'art-dot s-' + (sh.status === 'healthy' ? 'positive' : 'notice') }, h(Icon, { name: 'folder', size: 12 })),
      h('div', { className: 'art-meta' }, h('div', { className: 'art-name mono' }, sh.path), h('div', { className: 'art-sub' }, sh.mode + ' · ' + sh.clients + ' 客户端 · ' + sh.size)),
      h('button', { className: 'mini-btn danger', onClick: () => deleteShare(sh) }, h(Icon, { name: 'trash', size: 12 }), '解除纳管'));

    const readbackEl = h('div', { className: 'readback ok' },
      h('div', { className: 'rb-h' }, h(Icon, { name: 'check', size: 13 }), '写配置后自动回读校验 · 期望 vs 实际'),
      h('div', { className: 'rb-cmp' },
        h('div', { className: 'rb-col' }, h('span', { className: 'rl' }, 'expected'), h('code', null, 'Host=render-zen-01;Port=1337')),
        h('div', { className: 'rb-col' }, h('span', { className: 'rl' }, 'actual'), h('code', { className: 'good' }, 'Host=render-zen-01;Port=1337'))));

    /* 单个后端面板（介绍卡 + 部署表单），按 backend id 渲染 */
    const backendPanel = (beId) => {
      const b = DDC_BACKENDS.find((x) => x.id === beId) || DDC_BACKENDS[0];
      const doDeploy = beId === 'zen' ? deployZen : beId === 'smb' ? deploySMB : deployLocal;
      return h('div', { className: 'be-block', key: beId },
        h('div', { className: 'deploy-panel' },
          h('div', { className: 'dp-h' }, h(Icon, { name: b.icon, size: 15 }), '部署 ' + b.label,
            b.current ? h('span', { className: 'dp-cur' }, h(Icon, { name: 'check', size: 11 }), '已部署') : null),
          h('div', { className: 'dp-form' },
            h('div', { className: 'dp-field' }, h('label', null, '服务器机器'),
              h(Selector, { kpre: '机器', value: srv, options: srvOpts, width: 240, onChange: setSrv })),
            beId === 'zen' ? h('div', { className: 'dp-field' }, h('label', null, 'data-dir'),
              h('input', { className: 'dp-input mono', value: dataDir, onChange: (e) => setDataDir(e.target.value) }))
              : beId === 'smb' ? h(React.Fragment, null,
                h('div', { className: 'dp-field' }, h('label', null, '共享路径'),
                  h('input', { className: 'dp-input mono', defaultValue: '\\\\ddc01\\Volo\\DDC' })),
                h('div', { className: 'dp-field' }, h('label', null, '运维凭据'),
                  h(Selector, { kpre: '凭据', value: shareCred, options: credOpts, width: 200, onChange: setShareCred })))
              : null,
            h('div', { className: 'dp-go' }, h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), onPress: doDeploy }, b.current ? '重新部署' : '部署 ' + b.label))),
          h('div', { className: 'dp-note' }, h(Icon, { name: 'shield', size: 13 }), '链路在后台逐步执行（进度进任务抽屉）；凭据 / urlacl / 服务安装全部自动处理。'),
          beId === 'zen' && zenReadback ? readbackEl : null));
    };

    /* ---- ZenServer：① 共享 DDC 服务器（单台角色）· ② 客户端机器（加入共享服务器）---- */
    const sharedNode = CX.node(srv);
    const clients = RENDER_NODES.filter((n) => n.id !== srv);
    const joinedCt = clients.filter((n) => joined.includes(n.id)).length;
    const onlineUnjoined = clients.filter((n) => n.status !== 'offline' && !joined.includes(n.id));

    const joinClient = (n) => CX.openPreview(s, {
      title: '加入共享 DDC · ' + n.host, icon: 'link', cli: 'zen client-join', destructive: false, channel: 'winrm', confirmLabel: '加入',
      steps: [
        '用运维凭据 ' + credName(shareCred) + ' 注入共享访问',
        '让这台机器连接到共享缓存服务器 ' + sharedNode.host,
        '把它的缓存来源指向该共享服务器',
        '在本地目录 ' + clientDir + ' 留一份缓存，配置写好后自动复核',
      ],
      simpleScope: [{ host: n.host, ip: n.ip, msg: '本地 data-dir ' + clientDir }],
      readback: { key: '[StorageServers] Shared', expected: 'Host=render-zen-01;Port=1337' },
      task: { domain: 'zen', action: 'client-join', target: n.host, chan: 'winrm', note: '加入共享 DDC（' + sharedNode.host + '）',
        lines: [
          { msg: 'zen client-join --server render-zen-01:1337' },
          { msg: 'ini set [StorageServers] Shared → Host=render-zen-01;Port=1337' },
          { msg: 'local data-dir ' + clientDir },
          { lv: 'ok', msg: n.host + ' 已加入共享 DDC · 回读校验通过' },
        ] },
      onConfirm: () => setJoined((j) => j.includes(n.id) ? j : j.concat(n.id)),
    });
    const joinAll = () => CX.openPreview(s, {
      title: '批量加入共享 DDC', icon: 'link', cli: 'zen client-join', destructive: false, channel: 'winrm', confirmLabel: '加入 ' + onlineUnjoined.length + ' 台',
      steps: [
        '用运维凭据 ' + credName(shareCred) + ' 逐台注入共享访问',
        '让这些机器逐台连接到共享缓存服务器 ' + sharedNode.host,
        '把每台的缓存来源都指向该共享服务器',
        '各机在本地目录 ' + clientDir + ' 留一份缓存，并自动复核',
      ],
      simpleScope: onlineUnjoined.map((n) => ({ host: n.host, ip: n.ip, msg: '本地 data-dir ' + clientDir })),
      readback: { key: '[StorageServers] Shared', expected: 'Host=render-zen-01;Port=1337' },
      task: { domain: 'zen', action: 'client-join', target: onlineUnjoined.length + ' 台客户端', chan: 'winrm', note: '批量加入共享 DDC（' + sharedNode.host + '）',
        lines: [
          { msg: 'zen client-join --server render-zen-01:1337 ×' + onlineUnjoined.length },
          { msg: 'ini set [StorageServers] Shared → 逐台写入' },
          { lv: 'ok', msg: onlineUnjoined.length + ' 台已加入共享 DDC · 回读校验通过' },
        ] },
      onConfirm: () => setJoined((j) => Array.from(new Set(j.concat(onlineUnjoined.map((n) => n.id))))),
    });

    const clientRow = (n) => {
      const isJoined = joined.includes(n.id);
      const off = n.status === 'offline';
      return h('div', { key: n.id, className: 'cli-row' + (off ? ' off' : '') + (isJoined ? ' on' : '') },
        CX.dot(NODE_STATUS[n.status].visual),
        h('div', { className: 'cli-meta' },
          h('div', { className: 'cli-host mono' }, n.host),
          h('div', { className: 'cli-sub' }, n.ip + ' · ' + n.role)),
        isJoined
          ? h('div', { className: 'cli-joined' },
              h('span', { className: 'cli-path mono' }, h(Icon, { name: 'folder', size: 11 }), clientDir),
              h('span', { className: 'cli-badge ok' }, h(Icon, { name: 'check', size: 11 }), '已加入'))
          : off
            ? h('span', { className: 'cli-badge off' }, h(Icon, { name: 'power', size: 11 }), '离线 · 跳过')
            : h('button', { className: 'mini-btn join', onClick: () => joinClient(n) }, h(Icon, { name: 'link', size: 12 }), '加入'));
    };

    /* ---- per-view bodies ---- */
    const zenBody = h(React.Fragment, null,
      h('div', { className: 'ddc-sec-h' },
        h('span', null, '① ZenServer 共享 DDC 服务器'),
        h('span', { className: 'dim' }, '只能选取一台服务器作为该角色 · 设置共享 Data 路径')),
      backendPanel('zen'),
      h('div', { className: 'ddc-sec-h' },
        h('span', null, '② 客户端机器'),
        h('span', { className: 'dim' }, joinedCt + ' / ' + clients.length + ' 已加入 · 各自设置本地 Data 路径')),
      h('div', { className: 'cli-panel' },
        h('div', { className: 'cli-top' },
          h('div', { className: 'cli-server-chip' },
            h('span', { className: 'csc-ico' }, h(Icon, { name: 'cube', size: 15 })),
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'csc-t' }, '加入目标 · ' + sharedNode.host),
              h('div', { className: 'csc-s mono' }, sharedNode.ip + ' :1337'))),
          h('div', { className: 'dp-field' }, h('label', null, '本地 data-dir'),
            h('input', { className: 'dp-input mono', value: clientDir, onChange: (e) => setClientDir(e.target.value) })),
          h('div', { className: 'dp-field' }, h('label', null, '运维凭据'),
            h(Selector, { kpre: '凭据', value: shareCred, options: credOpts, width: 180, onChange: setShareCred })),
          h('div', { className: 'cli-go' },
            h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'link', size: 14 }), isDisabled: onlineUnjoined.length === 0, onPress: joinAll },
              onlineUnjoined.length ? '全部加入（' + onlineUnjoined.length + '）' : '全部已加入'))),
        h('div', { className: 'cli-note' }, h(Icon, { name: 'shield', size: 13 }),
          '加入会写客户端 [StorageServers] Shared 指向上方共享服务器，并在本地 data-dir 落地缓存；凭据 / 回读校验后台自动处理。'),
        h('div', { className: 'cli-list' }, clients.map(clientRow))));

    /* 文件系统 DDC = 共享 DDC（上）+ 本地 DDC（下，逐台列表）*/
    const onlineLocalTargets = RENDER_NODES.filter((n) => n.status !== 'offline');
    const setLocalDir = (id, v) => setLocalDirs((m) => Object.assign({}, m, { [id]: v }));
    const deployLocalOne = (n) => CX.openPreview(s, {
      title: '部署本地 DDC · ' + n.host, icon: 'server', cli: 'local-cache create', destructive: false, channel: 'winrm', confirmLabel: '部署',
      steps: ['在这台机器本地新建缓存目录 ' + localDirs[n.id], '作为找不到共享缓存时的本地兜底，配置后自动复核'],
      simpleScope: [{ host: n.host, ip: n.ip, msg: localDirs[n.id] }],
      task: { domain: 'local-cache', action: 'create', target: n.host, chan: 'winrm', note: '本地 DDC 已部署 · ' + localDirs[n.id],
        lines: [{ msg: 'local-cache create ' + localDirs[n.id] }, { lv: 'ok', msg: n.host + ' 本地缓存层已就绪' }] },
      onConfirm: () => setLocalDeployed((d) => d.includes(n.id) ? d : d.concat(n.id)),
    });
    const deployLocalAll = () => CX.openPreview(s, {
      title: '一键部署本地 DDC', icon: 'bolt', cli: 'local-cache create', destructive: false, channel: 'winrm', confirmLabel: '部署 ' + onlineLocalTargets.length + ' 台',
      steps: ['为这些机器逐台在本地新建缓存目录', '作为找不到共享缓存时的本地兜底，配置后自动复核'],
      simpleScope: onlineLocalTargets.map((n) => ({ host: n.host, ip: n.ip, msg: localDirs[n.id] })),
      task: { domain: 'local-cache', action: 'create', target: onlineLocalTargets.length + ' 台', chan: 'winrm', note: '一键部署本地 DDC（' + onlineLocalTargets.length + ' 台）',
        lines: [{ msg: 'local-cache create ×' + onlineLocalTargets.length }, { lv: 'ok', msg: onlineLocalTargets.length + ' 台本地缓存层已就绪' }] },
      onConfirm: () => setLocalDeployed((d) => Array.from(new Set(d.concat(onlineLocalTargets.map((n) => n.id))))),
    });
    const localRow = (n) => {
      const dep = localDeployed.includes(n.id);
      const off = n.status === 'offline';
      return h('div', { key: n.id, className: 'cli-row local' + (off ? ' off' : '') + (dep ? ' on' : '') },
        CX.dot(NODE_STATUS[n.status].visual),
        h('div', { className: 'cli-meta' },
          h('div', { className: 'cli-host mono' }, n.host),
          h('div', { className: 'cli-sub' }, n.ip + ' · ' + n.role)),
        h('input', { className: 'cli-pathin mono', value: localDirs[n.id], disabled: off,
          spellCheck: false, onChange: (e) => setLocalDir(n.id, e.target.value) }),
        h('div', { className: 'local-act' },
          off ? h('span', { className: 'cli-badge off' }, h(Icon, { name: 'power', size: 11 }), '离线')
            : h(React.Fragment, null,
                dep ? h('span', { className: 'cli-badge ok' }, h(Icon, { name: 'check', size: 11 }), '已部署') : null,
                h('button', { className: 'mini-btn', onClick: () => deployLocalOne(n) },
                  h(Icon, { name: dep ? 'sync' : 'bolt', size: 12 }), dep ? '重新部署' : '部署'))));
    };

    const legacyBody = h(React.Fragment, null,
      h('div', { className: 'ddc-sec-h' }, h('span', null, '① 共享 DDC（SMB）'), h('span', { className: 'dim' }, '局域网共享缓存盘 · 无独立服务器的小集群')),
      backendPanel('smb'),
      SHARES.length ? h(React.Fragment, null,
        h('div', { className: 'ddc-sec-h' }, h('span', null, '已纳管的共享'), h('span', { className: 'dim' }, SHARES.length + ' 个 · 解除纳管不删除远端文件夹')),
        h('div', { className: 'art-list' }, SHARES.map(shareRow))) : null,
      h('div', { className: 'ddc-sec-h' },
        h('span', null, '② 本地 DDC'),
        h('span', { className: 'dim' }, localDeployed.length + ' / ' + RENDER_NODES.length + ' 已部署 · 每台可单独设置 data-dir')),
      h('div', { className: 'cli-panel' },
        h('div', { className: 'cli-top' },
          h('div', { className: 'local-hint' }, h(Icon, { name: 'server', size: 15 }), '逐台开启本地缓存回退层 · 每台独立 data-dir，可单独部署'),
          h('div', { className: 'cli-go' },
            h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), isDisabled: onlineLocalTargets.length === 0, onPress: deployLocalAll },
              '一键部署（' + onlineLocalTargets.length + '）'))),
        h('div', { className: 'cli-note' }, h(Icon, { name: 'shield', size: 13 }),
          '本地 DDC 作为命中链路的回退层；部署链路在后台逐步执行，写入后自动回读校验。'),
        h('div', { className: 'cli-list' }, RENDER_NODES.map(localRow))));

    /* ---- DDC PAK：① 扫工程 → ② 选工程 → ③ 生成 ---- */
    const selProj = UE_PROJECTS.find((x) => x.id === pakProj) || null;
    const projMachines = selProj ? RENDER_NODES.filter((n) => selProj.machines.includes(n.id) && n.status !== 'offline') : [];
    const srcOpts = projMachines.map((n) => ({ id: n.id, label: n.host, sub: n.ip }));
    const backendOpts = [{ id: 'zen', label: 'ZenServer 后端' }, { id: 'legacy', label: '文件系统后端' }];
    const scopeOpts = [{ id: 'all', label: '全部在线机' }].concat(RENDER_NODES.filter((n) => n.status !== 'offline').map((n) => ({ id: n.id, label: n.host, sub: n.ip })));
    const projRow = (p, selId, onSel) => {
      const on = p.id === selId;
      return h('div', { key: p.id, className: 'proj-row' + (on ? ' on' : ''), onClick: () => onSel(p) },
        h('span', { className: 'proj-mck' + (on ? ' on' : '') }, on ? h(Icon, { name: 'check', size: 12 }) : null),
        h('span', { className: 'proj-ico' }, h(Icon, { name: 'film', size: 17 })),
        h('div', { className: 'proj-main' },
          h('div', { className: 'proj-name' }, p.name),
          h('div', { className: 'proj-sub' }, p.root + '\\' + p.uproject)),
        h('div', { className: 'proj-tags' },
          h('span', { className: 'proj-tag ue' }, 'UE ' + p.ue),
          h('span', { className: 'proj-tag' }, p.size),
          h('span', { className: 'proj-tag' }, p.machines.length + ' 台'),
          p.hasPak ? h('span', { className: 'proj-tag pak' }, h(Icon, { name: 'check', size: 10 }), '已有 PAK') : null,
          p.warn ? h('span', { className: 'proj-tag warn', title: p.warn }, h(Icon, { name: 'alert', size: 10 }), '版本不一致') : null));
    };
    const selectPak = (p) => { setPakProj(p.id); setPakSrc(p.primary); };

    /* verify_pak_output — 只能校验单个工程的产物，没有“列举全部产物”的能力 */
    const pakInfo = (p) => {
      const art = ARTIFACTS.find((a) => a.kind === 'DDC pak' && a.name.indexOf(p.name) >= 0);
      const name = art ? art.name : 'DDC_' + p.name + '_' + p.ue + '_' + pakBackend;
      return { exists: !!p.hasPak, name, path: p.root + '\\DerivedDataCache\\' + name + '.upak', size: art ? art.size : '—' };
    };
    const verifyPak = (p) => {
      const src = CX.node(pakSrc) || CX.node(p.primary);
      const info = pakInfo(p);
      s.runTask({ domain: 'ddc', action: 'verify', target: p.name, chan: 'ssh', note: '校验 DDC PAK 产物 · ' + p.name,
        lines: [
          { msg: 'verify_pak_output --machine ' + src.host + ' --project ' + p.name },
          info.exists ? { lv: 'ok', msg: '产物存在 · ' + info.path + ' · ' + info.size } : { lv: 'warn', msg: '未找到产物 · 该工程尚未生成 PAK' },
        ] });
      setPakVerify((m) => Object.assign({}, m, { [p.id]: info }));
    };
    const pakStatusCard = (p) => {
      const v = pakVerify[p.id];
      const src = CX.node(pakSrc) || CX.node(p.primary);
      return h('div', { className: 'gen-panel' },
        h('div', { className: 'gen-summary' },
          h('span', { className: 'gen-ico' }, h(Icon, { name: 'cache', size: 17 })),
          h('div', { className: 'gen-sum-txt' },
            h('div', { className: 'gen-sum-t' }, h('span', { className: 'gen-sum-name' }, p.name), h('span', { className: 'gen-sum-ue' }, 'UE ' + p.ue)),
            h('div', { className: 'gen-sum-d mono' }, '校验源 · ' + src.host)),
          h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'search', size: 14 }), onPress: () => verifyPak(p) }, v ? '重新校验' : '校验产物')),
        v
          ? h('div', { className: 'pak-verify' + (v.exists ? ' ok' : ' miss') },
              h('div', { className: 'pak-verify-h' },
                h('span', { className: 'pv-ico s-' + (v.exists ? 'positive' : 'notice') }, h(Icon, { name: v.exists ? 'check' : 'alert', size: 14 })),
                h('span', { className: 'pv-state' }, v.exists ? '产物存在' : '未找到产物')),
              h('div', { className: 'pak-verify-kv' },
                h('div', { className: 'pvk' }, h('span', { className: 'k' }, '路径'), h('span', { className: 'v mono' }, v.path)),
                h('div', { className: 'pvk' }, h('span', { className: 'k' }, '大小'), h('span', { className: 'v' }, v.size)),
                h('div', { className: 'pvk' }, h('span', { className: 'k' }, '是否存在'), h('span', { className: 'v s-' + (v.exists ? 'positive' : 'notice') }, v.exists ? '是' : '否'))),
              v.exists
                ? h('div', { className: 'pak-verify-act' }, h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'download', size: 14 }), onPress: () => distribute({ kind: 'DDC pak', name: v.name }) }, '分发到渲染机'))
                : h('div', { className: 'pak-verify-note' }, h(Icon, { name: 'eye', size: 12 }), '该工程在源机上尚无 PAK 产物，先在上方③生成。'))
          : h('div', { className: 'pak-verify-hint' }, h(Icon, { name: 'eye', size: 13 }), '点「校验产物」检查该工程在源机上的 PAK 是否存在（路径 / 大小 / 是否存在）。'));
    };

    const pakBody = h(React.Fragment, null,
      h('div', { className: 'ddc-sec-h' }, h('span', null, '① 扫描 UE 工程'), h('span', { className: 'dim' }, 'discover_projects · 远程扫 .uproject，只发现不写盘')),
      h('div', { className: 'pak-scan' },
        h('div', { className: 'pak-scan-fields' },
          h('div', { className: 'dp-field' }, h('label', null, '扫描范围'),
            h(Selector, { kpre: '范围', value: pakScope, options: scopeOpts, width: 178, onChange: setPakScope })),
          h('div', { className: 'dp-field grow' }, h('label', null, '搜索根目录'),
            h('input', { className: 'dp-input mono', value: pakRoots, spellCheck: false, onChange: (e) => setPakRoots(e.target.value) })),
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'search', size: 14 }), onPress: scanProjects }, '扫描')),
        h('div', { className: 'pak-scan-meta' }, h(Icon, { name: 'check', size: 12 }), '上次扫描 今天 13:32 · 发现 3 个工程 / 6 台机器')),

      h('div', { className: 'ddc-sec-h' }, h('span', null, '② 选择工程'), h('span', { className: 'dim' }, selProj ? '已选 · ' + selProj.name : '选中后针对该工程生成 DDC PAK')),
      h('div', { className: 'proj-list' }, UE_PROJECTS.map((p) => projRow(p, pakProj, selectPak))),

      h('div', { className: 'ddc-sec-h' }, h('span', null, '③ 生成 DDC PAK'), h('span', { className: 'dim' }, 'generate_ddc_pak · GPU 不匹配 preflight 后台自动比对')),
      selProj
        ? h('div', { className: 'gen-panel' },
            h('div', { className: 'gen-summary' },
              h('span', { className: 'gen-ico' }, h(Icon, { name: 'cache', size: 17 })),
              h('div', { className: 'gen-sum-txt' },
                h('div', { className: 'gen-sum-t' }, h('span', { className: 'gen-sum-name' }, selProj.name), h('span', { className: 'gen-sum-ue' }, 'UE ' + selProj.ue)),
                h('div', { className: 'gen-sum-d mono' }, selProj.root + '\\' + selProj.uproject)),
              h('span', { className: 'gen-sum-size' }, selProj.size)),
            selProj.warn ? h('div', { className: 'gen-warn' }, h(Icon, { name: 'alert', size: 13 }), selProj.warn + ' · 生成前请确认引擎版本') : null,
            h('div', { className: 'gen-form' },
              h('div', { className: 'dp-field' }, h('label', null, '生成源机器'),
                h(Selector, { kpre: '机器', value: pakSrc || selProj.primary, options: srcOpts, width: 220, onChange: setPakSrc })),
              h('div', { className: 'dp-field' }, h('label', null, '后端'),
                h(Selector, { kpre: '后端', value: pakBackend, options: backendOpts, width: 178, onChange: setPakBackend }))),
            h('div', { className: 'gen-foot' },
              h('div', { className: 'gen-foot-note' }, h(Icon, { name: 'shield', size: 13 }), '在源机器上载入 .uproject 编译 shader 生成 PAK · 长任务，进度进任务抽屉；Zen 可达时同时灌入共享上游。'),
              h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), onPress: genPak }, '生成 DDC PAK')))
        : h('div', { className: 'gen-empty' }, h(Icon, { name: 'film', size: 22 }), h('span', null, '先在上方选择一个工程，再生成对应的 DDC PAK')),

      h('div', { className: 'ddc-sec-h', style: { marginTop: 22 } }, h('span', null, '④ 校验该工程产物'), h('span', { className: 'dim' }, 'verify_pak_output · 校验选中工程的单个产物，不列举全部')),
      selProj ? pakStatusCard(selProj) : h('div', { className: 'gen-empty' }, h(Icon, { name: 'cache', size: 22 }), h('span', null, '先在上方选择一个工程，再校验它的 PAK 产物')));

    const selPso = UE_PROJECTS.find((x) => x.id === psoProj) || null;
    const psoMachines = selPso ? RENDER_NODES.filter((n) => selPso.machines.includes(n.id) && n.status !== 'offline') : [];
    const psoSrcOpts = psoMachines.map((n) => ({ id: n.id, label: n.host, sub: n.gpu }));
    const psoSrcNode = selPso ? (CX.node(psoSrc) || CX.node(selPso.primary)) : null;
    const resOpts = [{ id: '1920×1080', label: '1920 × 1080' }, { id: '2560×1440', label: '2560 × 1440' }, { id: '3840×2160', label: '3840 × 2160' }];
    const maxOpts = [{ id: '10', label: '10 分钟' }, { id: '20', label: '20 分钟' }, { id: '30', label: '30 分钟' }];
    const selectPso = (p) => { setPsoProj(p.id); setPsoSrc(p.primary); };

    const psoBody = h(React.Fragment, null,
      h('div', { className: 'ddc-sec-h' }, h('span', null, '① 扫描 UE 工程'), h('span', { className: 'dim' }, 'discover_projects · 可按单台机器搜索 .uproject')),
      h('div', { className: 'pak-scan' },
        h('div', { className: 'pak-scan-fields' },
          h('div', { className: 'dp-field' }, h('label', null, '扫描范围'),
            h(Selector, { kpre: '范围', value: psoScope, options: scopeOpts, width: 178, onChange: setPsoScope })),
          h('div', { className: 'dp-field grow' }, h('label', null, '搜索根目录'),
            h('input', { className: 'dp-input mono', value: psoRoots, spellCheck: false, onChange: (e) => setPsoRoots(e.target.value) })),
          h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'search', size: 14 }), onPress: scanPso }, '扫描')),
        h('div', { className: 'pak-scan-meta' }, h(Icon, { name: 'check', size: 12 }), '上次扫描 今天 13:32 · 发现 3 个工程 / 6 台机器')),

      h('div', { className: 'ddc-sec-h' }, h('span', null, '② 选择工程'), h('span', { className: 'dim' }, selPso ? '已选 · ' + selPso.name : '选中后针对该工程收集 PSO 缓存')),
      h('div', { className: 'proj-list' }, UE_PROJECTS.map((p) => projRow(p, psoProj, selectPso))),

      h('div', { className: 'ddc-sec-h' }, h('span', null, '③ 收集 PSO 缓存'), h('span', { className: 'dim' }, 'start_pso_collection · 按源机 GPU 签名生成')),
      selPso
        ? h('div', { className: 'gen-panel' },
            h('div', { className: 'gen-summary' },
              h('span', { className: 'gen-ico' }, h(Icon, { name: 'layers', size: 17 })),
              h('div', { className: 'gen-sum-txt' },
                h('div', { className: 'gen-sum-t' }, h('span', { className: 'gen-sum-name' }, selPso.name), h('span', { className: 'gen-sum-ue' }, 'UE ' + selPso.ue)),
                h('div', { className: 'gen-sum-d mono' }, selPso.root + '\\' + selPso.uproject)),
              h('span', { className: 'gen-sum-size' }, selPso.size)),
            psoSrcNode ? h('div', { className: 'gen-gpu' }, h(Icon, { name: 'eye', size: 13 }), 'PSO 与 GPU 绑定，仅对相同 GPU 签名命中 · 当前源机 GPU ', h('b', null, psoSrcNode.gpu + '（' + psoSrcNode.vendor + '）')) : null,
            h('div', { className: 'gen-form' },
              h('div', { className: 'dp-field' }, h('label', null, '收集源机器'),
                h(Selector, { kpre: '机器', value: psoSrc || selPso.primary, options: psoSrcOpts, width: 208, onChange: setPsoSrc })),
              h('div', { className: 'dp-field' }, h('label', null, '渲染分辨率'),
                h(Selector, { kpre: '分辨率', value: psoRes, options: resOpts, width: 168, onChange: setPsoRes })),
              h('div', { className: 'dp-field' }, h('label', null, '最长时长'),
                h(Selector, { kpre: '时长', value: psoMax, options: maxOpts, width: 138, onChange: setPsoMax }))),
            h('div', { className: 'gen-foot' },
              h('div', { className: 'gen-foot-note' }, h(Icon, { name: 'terminal', size: 13 }), 'UE -game 窗口化跑指定分辨率收集 PSO · 长任务，NDJSON 实时流进任务抽屉。'),
              h(Button, { variant: 'accent', size: 'M', icon: h(Icon, { name: 'bolt', size: 14 }), onPress: collectPso }, '收集 PSO 缓存')))
        : h('div', { className: 'gen-empty' }, h(Icon, { name: 'film', size: 22 }), h('span', null, '先在上方选择一个工程，再收集对应的 PSO 缓存')),

      h('div', { className: 'ddc-sec-h', style: { marginTop: 22 } }, h('span', null, '已收集的 PSO 缓存'), h('span', { className: 'dim' }, psos.length + ' 个产物 · 可分发到同 GPU 机器')),
      h('div', { className: 'art-list' }, psos.map(artRow)));

    const headRight = view === 'ddc_zen'
      ? h('span', { className: 'toolchip' }, h(Icon, { name: 'cube', size: 14 }), '当前后端：ZenServer · render-zen-01')
      : null;

    return h('div', { className: 'res ddc' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, 'DDC · ' + TITLE[view]),
        h('div', { className: 'right' }, headRight)),
      h('div', { className: 'ddc-body' },
        view === 'ddc_zen' ? zenBody : view === 'ddc_legacy' ? legacyBody : view === 'ddc_pak' ? pakBody : psoBody));
  }

  window.VOLO_CACHE_DDC = { ddc: (s) => h(DDC, { s }) };
})();

export {};
