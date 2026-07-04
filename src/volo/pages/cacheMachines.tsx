// @ts-nocheck
/* Volo — Cache · 机器管理 (Machines) + 扫描入网向导 · 列表内「部署环境」逐机动作.
   1:1 port of the Claude Design handoff `src/cache_machines.jsx`. Imports
   ./cache first so window.VOLO_CX is populated before `const CX = window.VOLO_CX`. */
import * as React from "react";
import "../ds";
import "./cache";
import { deleteMachine, scanNetwork, addDiscoveredMachine, refreshMachine } from "../api/commands";

(function () {
  const { Button } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect, useRef } = React;
  const h = React.createElement;
  const CX = window.VOLO_CX;
  const dot = CX.dot;

  /* =================== 机器管理 (§4) =================== */
  /* ---- IP / CIDR helpers (scan_network(cidr)) ---- */
  const RE_IP = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const RE_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
  const octOk = (ip) => ip.split('.').every((o) => o !== '' && +o >= 0 && +o <= 255);
  function classify(raw) {
    const v = (raw || '').trim();
    if (!v) return 'empty';
    let m;
    if ((m = v.match(RE_CIDR))) return (octOk(m.slice(1, 5).join('.')) && +m[5] >= 0 && +m[5] <= 32) ? 'cidr' : 'bad';
    if (RE_IP.test(v)) return octOk(v) ? 'ip' : 'bad';
    return 'bad';
  }

  /* ========== 扫描入网向导（① 输入 → ② 扫描 → ③ 选择 → ④ 加入）========== */
  function ScanWizard({ s, onClose }) {
    const [step, setStep] = useState('input'); /* input | scanning | results | done */
    const [targets, setTargets] = useState(['192.168.10.0/24']);
    const [pick, setPick] = useState([]);
    const [added, setAdded] = useState(0);
    /* 真实 scan_network 结果：[{ip, winrm, smb, rpc}]（ProbedHost 只有 ip + 端口可达性，
       无 name/os/ue 来源——这些演示列已去掉）。 */
    const [scanResults, setScanResults] = useState([]);
    const [scanErr, setScanErr] = useState(null);
    const timer = useRef(null);
    useEffect(() => () => timer.current && clearTimeout(timer.current), []);
    useEffect(() => {
      const esc = (e) => { if (e.key === 'Escape') onClose(); };
      window.addEventListener('keydown', esc);
      return () => window.removeEventListener('keydown', esc);
    }, [onClose]);

    const validTargets = targets.map((t) => t.trim()).filter((t) => { const c = classify(t); return c === 'ip' || c === 'cidr'; });
    /* 剔除已纳管 IP（scan 不去重已纳管机），按 /24 分组展示 */
    const managedIps = new Set(RENDER_NODES.map((m) => m.ip));
    const fresh = scanResults.filter((r) => !managedIps.has(r.ip));
    const matchedGroups = (() => {
      const m = {};
      fresh.forEach((r) => { const sub = r.ip.split('.').slice(0, 3).join('.') + '.0/24'; (m[sub] = m[sub] || []).push(r); });
      return Object.keys(m).sort().map((subnet) => ({ subnet, hosts: m[subnet] }));
    })();
    const allDisc = fresh.map((r) => r.ip);

    const setTarget = (i, v) => setTargets((a) => a.map((x, j) => j === i ? v : x));
    const addTarget = () => setTargets((a) => a.concat(''));
    const removeTarget = (i) => setTargets((a) => a.length > 1 ? a.filter((_, j) => j !== i) : a);
    const toggle = (ip) => setPick((v) => v.includes(ip) ? v.filter((x) => x !== ip) : v.concat(ip));
    const toggleSubnet = (g) => {
      const ips = g.hosts.map((x) => x.ip);
      const allOn = ips.every((ip) => pick.includes(ip));
      setPick((v) => allOn ? v.filter((ip) => !ips.includes(ip)) : Array.from(new Set(v.concat(ips))));
    };

    /* 真实 scan_network：单 IP 转 /32（命令只收 CIDR）；多目标 allSettled 合并 probed；
       backend 只回 winrm/smb 可达的主机。扫描在 invoke resolve 后进 results 步。 */
    const startScan = () => {
      if (!validTargets.length) return;
      setPick([]); setScanResults([]); setScanErr(null);
      setStep('scanning');
      const cidrs = validTargets.map((t) => classify(t) === 'ip' ? (t + '/32') : t);
      Promise.allSettled(cidrs.map((c) => scanNetwork(c))).then((rs) => {
        const seen = new Set(); const uniq = [];
        rs.forEach((r) => {
          if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.probed)) {
            r.value.probed.forEach((ph) => { if (!seen.has(ph.ip)) { seen.add(ph.ip); uniq.push({ ip: ph.ip, winrm: ph.winrm_open, smb: ph.smb_open, rpc: ph.rpc_open }); } });
          }
        });
        setScanResults(uniq);
        const failed = rs.filter((r) => r.status === 'rejected').length;
        if (failed && failed === rs.length) setScanErr('全部目标扫描失败');
        setStep('results');
      });
    };
    /* 真实 add_discovered_machine：逐 IP allSettled（hostname 传 null → 后端用 IP 当名）；
       成功后 reloadCache 让新机进列表（不再伪造「后台 GPU 核对」文案）。 */
    const confirmAdd = () => {
      const ips = pick.slice();
      if (!ips.length) return;
      setAdded(ips.length);
      if (s.setMachinesAdded) s.setMachinesAdded(true);
      s.runCmd({ domain: 'machine', action: 'add', target: ips.length + ' 台', chan: 'ssh', note: '加入发现的机器' },
        () => Promise.allSettled(ips.map((ip) => addDiscoveredMachine(ip, null))).then((rs) => {
          const failed = rs.filter((r) => r.status === 'rejected').length;
          if (failed) throw new Error(failed + ' / ' + ips.length + ' 台入库失败');
          return ips.length;
        }),
        { okMsg: (c) => c + ' 台已加入机器列表（UE / GPU 可在列表里逐台「刷新」采集）' })
        .then(() => s.reloadCache(), () => s.reloadCache());
      setStep('done');
    };
    const restart = () => { setStep('input'); setPick([]); setAdded(0); };

    const STEP_IDX = { input: 1, scanning: 2, results: 3, done: 4 };
    const cur = STEP_IDX[step];
    const arr = h('span', { className: 'ob-arr' }, h(Icon, { name: 'arrowr', size: 13 }));
    /* 步骤可点击跳转：输入随时可回；扫描 / 选择需已填有效目标；加入需已完成入网 */
    const reachable = (n) =>
      n === 1 ? true :
      n === 2 ? validTargets.length > 0 :
      n === 3 ? scanResults.length > 0 :   /* 选择=回到结果页：必须已扫描出结果，否则会跳进误导性空结果页 */
      added > 0;
    const goStep = (n) => {
      if (cur === n || !reachable(n)) return;
      if (n === 1) setStep('input');
      else if (n === 2) startScan();            /* 扫描 = 重新发起扫描 */
      else if (n === 3) { setPick([]); setStep('results'); }  /* 选择 = 回到结果页 */
      else setStep('done');
    };
    const stepTab = (n, label) => h('div', {
      className: 'ob-tab' + (cur === n ? ' on' : '') + (cur > n ? ' done' : '') + (reachable(n) && cur !== n ? ' clickable' : ''),
      onClick: () => goStep(n),
      title: reachable(n) && cur !== n ? '跳转到「' + label + '」' : null,
    }, h('span', { className: 'ob-n' }, cur > n ? h(Icon, { name: 'check', size: 12 }) : n), label);

    /* ---- step bodies (scrollable content only — footers are grounded below) ---- */
    const inputBody = h(React.Fragment, null,
      h('div', { className: 'swz-lead' }, '输入要扫描的 IP 或网段（CIDR），可添加多条。只探活、不写库——发现的设备要勾选后才会加入。'),
      h('div', { className: 'ss-list' },
        targets.map((t, i) => {
          const c = classify(t);
          const label = c === 'cidr' ? '网段' : c === 'ip' ? 'IP' : c === 'bad' ? '无效' : '—';
          return h('div', { key: i, className: 'ss-row' },
            h('span', { className: 'ss-type ' + c }, label),
            h('input', { className: 'ss-input mono' + (c === 'bad' ? ' bad' : ''), value: t, autoFocus: i === 0,
              placeholder: '10.20.8.0/24 或 10.20.8.15', spellCheck: false,
              onChange: (e) => setTarget(i, e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') startScan(); } }),
            h('button', { className: 'iconbtn', onClick: () => removeTarget(i), title: '移除', disabled: targets.length <= 1 }, h(Icon, { name: 'x', size: 14 })));
        })),
      h('button', { className: 'mini-btn swz-add', onClick: addTarget }, '＋ 添加 IP / 网段'));

    const scanningBody = h(React.Fragment, null,
      h('div', { className: 'swz-scan-h' }, h('span', { className: 'spin' }, h(Icon, { name: 'sync', size: 16 })), '正在扫描 ' + validTargets.length + ' 个目标 · 探活中…'),
      h('div', { className: 'swz-scan-list' },
        validTargets.map((t) => h('div', { className: 'swz-scan-row', key: t },
          h('span', { className: 'poll-dot' }),
          h('span', { className: 'mono' }, 'scan_network ' + t),
          h('span', { className: 'swz-scan-st' }, '探活中…')))));

    const resultsBody = h(React.Fragment, null,
      h('div', { className: 'swz-results-h' },
        h('span', { className: 'swz-results-t' }, h(Icon, { name: 'search', size: 14 }), '发现 ', h('b', null, allDisc.length), ' 台未纳管设备'),
        h('span', { className: 'swz-sel-pill' }, '已选 ', h('b', null, pick.length))),
      allDisc.length
        ? h('div', { className: 'swz-results-list' }, matchedGroups.map((g) => {
            const ips = g.hosts.map((x) => x.ip); const allOn = ips.every((ip) => pick.includes(ip));
            return h('div', { key: g.subnet, className: 'scan-group' },
              h('div', { className: 'scan-sub' },
                h('span', { className: 'mono' }, g.subnet),
                h('span', { className: 'scan-ct' }, g.hosts.length + ' 台'),
                h('button', { className: 'mini-btn', onClick: () => toggleSubnet(g) }, allOn ? '取消本网段' : '全选本网段')),
              g.hosts.map((x) => h('div', { key: x.ip, className: 'disc-row' + (pick.includes(x.ip) ? ' on' : ''), onClick: () => toggle(x.ip) },
                h('span', { className: 'mck' + (pick.includes(x.ip) ? ' on' : '') }, pick.includes(x.ip) ? h(Icon, { name: 'check', size: 12 }) : null),
                h('span', { className: 'd-host mono' }, x.ip),
                h('span', { className: 'd-note ok' }, h(Icon, { name: 'shield', size: 11 }),
                  x.winrm ? 'WinRM 可达' : x.smb ? 'SMB 可达' : '可达'))));
          }))
        : h('div', { className: 'swz-empty' }, scanErr ? ('扫描失败 · ' + scanErr) : '这些目标下没有发现未纳管设备。已纳管的机器不会重复出现。'));

    const doneBody = h('div', { className: 'ob-done' },
      h('div', { className: 'ob-done-ico' }, h(Icon, { name: 'check', size: 26 })),
      h('div', { className: 'ob-done-t' }, added + ' 台已加入机器列表'),
      h('div', { className: 'ob-done-d' }, '已纳入管理，后台继续：GPU 矩阵核对 · 项目发现。还未入网的机器，在机器列表里逐台「获取入网脚本」，拷到目标机运行后回来点刷新即可。'),
      h('div', { className: 'ob-done-acts' },
        h(Button, { variant: 'accent', size: 'M', onPress: onClose }, '完成'),
        h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'search', size: 14 }), onPress: restart }, '再扫一次')));

    /* ---- grounded footer bar per step ---- */
    const foot =
      step === 'input' ? h('div', { className: 'swz-foot' },
        h('span', { className: 'swz-foot-hint' }, h('span', { className: 'swz-cli' }, 'scan_network(cidr)'), ' · 仅发现未纳管设备'),
        h(Button, { variant: 'accent', size: 'M', isDisabled: !validTargets.length, icon: h(Icon, { name: 'search', size: 14 }), onPress: startScan }, '开始扫描'))
      : step === 'scanning' ? h('div', { className: 'swz-foot' },
        h('span', { className: 'swz-foot-hint' }, '探活完成后会列出未纳管设备'),
        h(Button, { variant: 'secondary', size: 'M', onPress: () => { timer.current && clearTimeout(timer.current); setStep('input'); } }, '取消'))
      : step === 'results' ? h('div', { className: 'swz-foot' },
        h(Button, { variant: 'secondary', size: 'M', icon: h(Icon, { name: 'chevr', size: 14, style: { transform: 'rotate(180deg)' } }), onPress: () => setStep('input') }, '重新输入'),
        h('span', { className: 'swz-foot-hint swz-foot-mid' }, pick.length ? ('已选 ' + pick.length + ' / ' + allDisc.length + ' 台') : '勾选要纳入的设备'),
        h(Button, { variant: 'accent', size: 'M', isDisabled: !pick.length, icon: h(Icon, { name: 'download', size: 14 }), onPress: confirmAdd }, '加入选中 ' + pick.length + ' 台'))
      : null;

    return h('div', { className: 'swz-overlay', onMouseDown: (e) => { if (e.target.classList.contains('swz-overlay')) onClose(); } },
      h('div', { className: 'swz-modal', role: 'dialog', 'aria-modal': 'true' },
        h('div', { className: 'swz-head' },
          h('span', { className: 'swz-ic' }, h(Icon, { name: 'search', size: 16 })),
          h('div', { className: 'swz-title' }, '扫描网段 · 发现并入网'),
          h('button', { className: 'iconbtn', onClick: onClose, title: '关闭' }, h(Icon, { name: 'x', size: 16 }))),
        h('div', { className: 'swz-steps' }, stepTab(1, '输入'), arr, stepTab(2, '扫描'), arr, stepTab(3, '选择'), arr, stepTab(4, '加入')),
        h('div', { className: 'swz-body' },
          step === 'input' ? inputBody : null,
          step === 'scanning' ? scanningBody : null,
          step === 'results' ? resultsBody : null,
          step === 'done' ? doneBody : null),
        foot));
  }

  /* =================== 机器管理 section — 嵌入「集群总览」的已纳管列表 + 扫描入口 + 逐机部署环境 =================== */
  function MachineSection({ s, onScan }) {
    const [machView, setMachView] = useState('grid');   /* 'list' | 'grid' */
    const [selected, setSelected] = useState([]);       /* 勾选待删除的机器 id */
    const [removed, setRemoved] = useState([]);          /* 已批量删除的机器 id（本会话内移除） */
    const open = (id) => { s.setDrawer({ kind: 'machine', id }); CX.showInspector(s); };
    const isDeployed = (n) => n.env !== 'pending' || (s.enrolled || []).includes(n.id);

    /* 排序：主机名按「前缀 + 数字后缀」数字升序；纯 IP 按点分数值升序。numeric localeCompare
       同时正确处理两种情况（RNODE-2 在 RNODE-10 前，10.20.8.2 在 10.20.8.10 前）。 */
    const machCmp = (a, b) => (a.host || '').localeCompare(b.host || '', undefined, { numeric: true, sensitivity: 'base' });
    const visible = RENDER_NODES.filter((n) => !removed.includes(n.id)).slice().sort(machCmp);
    const online = visible.filter((n) => n.status !== 'offline').length;
    const allSel = visible.length > 0 && visible.every((n) => selected.includes(n.id));
    const isSel = (n) => selected.includes(n.id);
    const toggleOne = (id) => setSelected((v) => v.includes(id) ? v.filter((x) => x !== id) : v.concat(id));
    const toggleAll = () => setSelected(allSel ? [] : visible.map((n) => n.id));
    const delSelected = () => {
      const nodes = visible.filter(isSel);
      if (!nodes.length) return;
      /* 走「预览 → 确认 → 执行」确认门（CX.openPreview）；多选时 confirmInput 要求勾选
         确认框，确认后才真实逐台 delete_machine。 */
      CX.openPreview(s, {
        title: '删除所选机器 · ' + nodes.length + ' 台', icon: 'trash', cli: 'machine delete',
        destructive: true, confirmInput: true, channel: 'ssh',
        simpleScope: nodes.map((n) => ({ host: n.host, ip: n.ip, msg: '将移除' })),
        steps: ['从集群中移除选中的 ' + nodes.length + ' 台机器', '解除它们与共享缓存、ZenServer 的关联', '清除这些机器已保存的登录凭据'],
        /* 真实批量 delete_machine：无批量命令 → 前端 allSettled 逐台调用（numeric
           machineId）；任一失败标任务失败，无论成败都 reloadCache 以后端为准（不再本地
           optimistic setRemoved）。 */
        onConfirm: () => {
          setSelected([]);
          s.runCmd({ domain: 'machine', action: 'delete', target: nodes.length + ' 台', chan: 'ssh', note: '从集群移除' },
            () => Promise.allSettled(nodes.map((n) => deleteMachine(n.machineId))).then((rs) => {
              const failed = rs.filter((r) => r.status === 'rejected').length;
              if (failed) throw new Error(failed + ' / ' + nodes.length + ' 台删除失败');
              return nodes.length;
            }),
            { okMsg: (cnt) => cnt + ' 台已从集群移除' })
            .then(() => s.reloadCache(), () => s.reloadCache());
        },
      });
    };
    /* 真实「刷新全部」：并行调用 refresh_machine（真 SSH probe + mark_seen，与 delSelected
       同一个 Promise.allSettled 写法）——refresh_machine 是同步 command 但无连接池/信号量，
       Db 锁只包单条 SQL，probe() 每次起独立 ssh 子进程，没有需要串行的资源争用。
       soft-failure（r.error，含「探测到离线」）只计入失败计数，不让整批任务标红——巡检一圈
       里有机器离线是正常态，不是操作失败；全部失败才标红。 */
    const refreshAll = () => {
      const nodes = visible.filter((n) => n.machineId != null && n.machineId !== 0);
      if (!nodes.length) return;
      s.runCmd({ domain: 'machine', action: 'refresh', target: nodes.length + ' 台', chan: 'winrm', note: '重新探测在线 / UE / GPU' },
        async () => {
          const results = await Promise.allSettled(nodes.map((n) => refreshMachine(n.machineId)));
          const failed = [];
          results.forEach((res, i) => {
            if (res.status === 'rejected') failed.push(nodes[i].host + '（' + (res.reason && res.reason.message ? res.reason.message : String(res.reason)) + '）');
            else if (res.value && res.value.error) failed.push(nodes[i].host + '（' + res.value.error + '）');
          });
          if (failed.length === nodes.length) throw new Error('全部探测失败');
          return failed;
        },
        { okMsg: (failed) => failed.length
            ? ((nodes.length - failed.length) + ' / ' + nodes.length + ' 台在线 · ' + failed.join('、'))
            : '全部 ' + nodes.length + ' 台已刷新在线状态与 UE 安装' })
        .then(() => s.reloadCache(), () => s.reloadCache());
    };

    /* 行 / 图标内的复选框（自带 stopPropagation，避免触发打开详情） */
    const checkbox = (n, cls) => h('span', { className: (cls ? cls + ' ' : '') + 'mck' + (isSel(n) ? ' on' : ''),
      title: '选择', onClick: (e) => { e.stopPropagation(); toggleOne(n.id); } },
      isSel(n) ? h(Icon, { name: 'check', size: 12 }) : null);

    /* 获取入网脚本 = get_winrm_bootstrap_script（SSH key 现场入网，不再远程推送），打开脚本面板 */
    const getScript = (n) => { s.setDrawer({ kind: 'script', id: n.id }); CX.showInspector(s); };

    const envCell = (n) => {
      if (n.status === 'offline') return h('span', { className: 'env-cell' }, h('span', { className: 'env-dash' }, '—'));
      if (isDeployed(n)) return h('span', { className: 'env-cell' },
        h('span', { className: 'env-ok' }, h(Icon, { name: 'check', size: 12 }), '已入网'),
        h('button', { className: 'env-btn redeploy', title: '重新获取入网脚本', onClick: (e) => { e.stopPropagation(); getScript(n); } }, h(Icon, { name: 'doc', size: 12 }), '脚本'));
      return h('span', { className: 'env-cell' },
        h('button', { className: 'env-btn pending', onClick: (e) => { e.stopPropagation(); getScript(n); } }, h(Icon, { name: 'doc', size: 12 }), '获取入网脚本'));
    };

    return h('div', { className: 'dash-card mach-card' },
      h('div', { className: 'dc-h' },
        h('span', { className: 't' }, h(Icon, { name: 'node', size: 14 }), '机器管理',
          h('span', { className: 'dc-count' }, visible.length + ' 台 · ' + online + ' 在线')),
        h('div', { className: 'mach-acts' },
          h('div', { className: 'mach-selall' + (allSel ? ' on' : ''), onClick: toggleAll, title: '全选 / 取消全选' },
            h('span', { className: 'mck' + (allSel ? ' on' : '') }, allSel ? h(Icon, { name: 'check', size: 12 }) : null), '全选'),
          selected.length
            ? h('button', { className: 'mach-del', onClick: delSelected, title: '批量删除所选机器' },
                h(Icon, { name: 'trash', size: 14 }), '删除所选 (' + selected.length + ')')
            : null,
          h('div', { className: 'view-toggle' },
            h('button', { className: 'vt-btn' + (machView === 'grid' ? ' on' : ''), title: '图标视图', onClick: () => setMachView('grid') }, h(Icon, { name: 'grid', size: 14 })),
            h('button', { className: 'vt-btn' + (machView === 'list' ? ' on' : ''), title: '列表视图', onClick: () => setMachView('list') }, h(Icon, { name: 'list', size: 14 }))),
          h(Button, { variant: 'secondary', size: 'S', icon: h(Icon, { name: 'sync', size: 14 }), onPress: refreshAll }, '刷新全部'),
          /* 制作入网 U 盘：全局动作（包与机器无关，做一次入网所有节点）。仅 Windows 可用——
             打包器是 PowerShell sidecar，非 Win 时禁用并解释。span 包裹让禁用态仍显 title。 */
          h('span', { title: s.platform === 'win' ? '生成全局通用的 SSH 入网 U 盘包' : '该功能仅 Windows 可用（打包依赖 PowerShell）', style: { display: 'inline-flex' } },
            h(Button, { variant: 'secondary', size: 'S', isDisabled: s.platform !== 'win', icon: h(Icon, { name: 'usb', size: 14 }), onPress: () => { s.setDrawer({ kind: 'usb' }); CX.showInspector(s); } }, '制作入网 U 盘')),
          h(Button, { variant: 'accent', size: 'S', icon: h(Icon, { name: 'search', size: 14 }), onPress: onScan }, '扫描网段…'))),
      h('div', { className: 'mlist' },
        machView === 'list'
          ? h(React.Fragment, null,
              h('div', { className: 'mrow2 mhead' },
                h('span', null, ''),
                h('span', null, '机器 / IP'), h('span', null, 'UE 版本'), h('span', null, 'last-seen'), h('span', null, '环境'), h('span', { style: { textAlign: 'right' } }, '健康')),
              visible.map((n) => h('div', { key: n.id, className: 'mrow2' + (n.status === 'offline' ? ' off' : '') + (isSel(n) ? ' picked' : ''), onClick: () => open(n.id) },
                checkbox(n),
                h('span', { className: 'mname' }, dot(NODE_STATUS[n.status].visual), h('span', { className: 'h' }, n.host), h('span', { className: 'ip' }, n.ip)),
                h('span', { className: 'mue' }, n.ue === '—' ? '—' : 'UE ' + n.ue),
                h('span', { className: 'mseen' }, n.last),
                envCell(n),
                h('span', { style: { display: 'flex', justifyContent: 'flex-end' } }, h(CX.StatusPill, { status: n.status })))))
          : h('div', { className: 'mach-grid' },
              visible.map((n) => h('div', { key: n.id, className: 'mach-tile' + (n.status === 'offline' ? ' off' : '') + (isSel(n) ? ' picked' : ''), onClick: () => open(n.id) },
                checkbox(n, 'mt-check'),
                h('div', { className: 'mt-ico ' + (n.status !== 'offline' ? 's-positive' : 's-neutral') }, h(Icon, { name: 'node', size: 28, stroke: 1.4 })),
                h('div', { className: 'mt-host' }, n.host),
                n.status === 'offline'
                  ? h('div', { className: 'mt-env mt-env--off' }, '离线')
                  : isDeployed(n)
                    ? h('div', { className: 'mt-env mt-env--ok' }, '已入网')
                    : h('div', { className: 'mt-env mt-env--pending' }, '待入网'))))));
  }

  window.VOLO_CACHE_MACHINES = {
    ScanWizard: (props) => h(ScanWizard, props),
    section: (s, onScan) => h(MachineSection, { s, onScan }),
  };
})();

export {};
