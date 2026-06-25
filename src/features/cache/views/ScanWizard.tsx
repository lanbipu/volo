// Volo · Cache —— 扫描入网向导（移植自原型 cache_machines.jsx 的 ScanWizard）。
// ① 输入 IP/CIDR（保留原型 classify/校验）② 对每个 CIDR 调真命令 scanNetwork(cidr) 汇总
// probed[] ③ 勾选发现的主机 ④ 对勾选项调 addDiscoveredMachine(ip,hostname)，完成后 reload。
import { useEffect, useState } from "react";
import { Icon } from "../ui/Icon";
import { Button } from "../ui/Button";
import { useCache, type TaskLine } from "../state/store";
import { useMachines } from "../state/data";
import { scanNetwork, addDiscoveredMachine } from "../api/commands";
import type { ProbedHost } from "../api/types";

/* ---- IP / CIDR helpers（scan_network(cidr)）---- */
const RE_IP = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const RE_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const octOk = (ip: string) => ip.split(".").every((o) => o !== "" && +o >= 0 && +o <= 255);
type Kind = "empty" | "ip" | "cidr" | "bad";
function classify(raw: string): Kind {
  const v = (raw || "").trim();
  if (!v) return "empty";
  let m: RegExpMatchArray | null;
  if ((m = v.match(RE_CIDR)))
    return octOk(m.slice(1, 5).join(".")) && +m[5] >= 0 && +m[5] <= 32 ? "cidr" : "bad";
  if (RE_IP.test(v)) return octOk(v) ? "ip" : "bad";
  return "bad";
}

type WizStep = "input" | "scanning" | "results" | "done";

/** 扫描发现的主机（合并 scanNetwork 真实返回 probed[]，附带来源网段）。 */
interface DiscRow extends ProbedHost {
  subnet: string;
}

// 后端只回端口探活，无 hostname/reachable —— 由开放端口推导可达性与端口摘要。
const reachableOf = (x: ProbedHost) => x.winrm_open || x.smb_open || x.rpc_open;
const portsOf = (x: ProbedHost) =>
  [x.winrm_open && "WinRM:5985", x.smb_open && "SMB:445", x.rpc_open && "RPC:135"]
    .filter(Boolean)
    .join(" · ") || "无开放端口";

export function ScanWizard({ onClose }: { onClose: () => void }) {
  const { runTask } = useCache();
  const { reload } = useMachines();
  const [step, setStep] = useState<WizStep>("input");
  const [targets, setTargets] = useState<string[]>(["10.20.8.0/24", "10.20.9.0/24"]);
  const [pick, setPick] = useState<string[]>([]);
  const [added, setAdded] = useState(0);
  const [discovered, setDiscovered] = useState<DiscRow[]>([]);
  const [scanErr, setScanErr] = useState<string | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const validTargets = targets
    .map((t) => t.trim())
    .filter((t) => {
      const c = classify(t);
      return c === "ip" || c === "cidr";
    });

  // 真实扫描结果按网段分组展示。
  const matchedGroups = validTargets
    .map((subnet) => ({ subnet, hosts: discovered.filter((x) => x.subnet === subnet) }))
    .filter((g) => g.hosts.length);
  const allDisc = discovered.map((x) => x.ip);

  const setTarget = (i: number, v: string) =>
    setTargets((a) => a.map((x, j) => (j === i ? v : x)));
  const addTarget = () => setTargets((a) => a.concat(""));
  const removeTarget = (i: number) =>
    setTargets((a) => (a.length > 1 ? a.filter((_, j) => j !== i) : a));
  const toggle = (ip: string) =>
    setPick((v) => (v.includes(ip) ? v.filter((x) => x !== ip) : v.concat(ip)));
  const toggleSubnet = (hosts: DiscRow[]) => {
    const ips = hosts.map((x) => x.ip);
    const allOn = ips.every((ip) => pick.includes(ip));
    setPick((v) =>
      allOn ? v.filter((ip) => !ips.includes(ip)) : Array.from(new Set(v.concat(ips))),
    );
  };

  const startScan = async () => {
    if (!validTargets.length) return;
    setPick([]);
    setScanErr(null);
    setStep("scanning");
    // 每个网段独立成败：用 allSettled，保留已成功网段的发现结果，仅把失败网段汇成提示。
    const settled = await Promise.allSettled(
      validTargets.map(async (subnet) => {
        const res = await scanNetwork(subnet);
        return res.probed.map((p): DiscRow => ({ ...p, subnet }));
      }),
    );
    const rows = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const failed = validTargets.filter((_, i) => settled[i].status === "rejected");
    setDiscovered(rows);
    setScanErr(failed.length ? `${failed.length} 个网段扫描失败：${failed.join("、")}` : null);
    setStep("results");
  };

  const confirmAdd = () => {
    const sel = discovered.filter((x) => pick.includes(x.ip));
    const lines: TaskLine[] = sel
      .map((x): TaskLine => ({ msg: "add_discovered_machine " + x.ip }))
      .concat([{ msg: "后台：GPU 矩阵核对 · 项目发现 …" }]);
    runTask({
      domain: "machine",
      action: "add",
      target: sel.length + " 台",
      chan: "ssh",
      note: "纳管选中设备",
      lines,
      // 真入库完成后再切「完成」页，并用真实成功台数（部分失败也如实反映）。
      run: async (ctx) => {
        const results = await Promise.allSettled(
          sel.map((x) => addDiscoveredMachine(x.ip)),
        );
        const ok = results.filter((r) => r.status === "fulfilled").length;
        reload();
        setAdded(ok);
        setStep("done");
        ctx.log({
          lv: ok === sel.length ? "ok" : "warn",
          cat: "machine",
          msg: `入网完成 · ${ok}/${sel.length} 台已纳入` + (ok < sel.length ? "（部分失败）" : ""),
        });
      },
    });
  };

  const restart = () => {
    setStep("input");
    setPick([]);
    setAdded(0);
    setDiscovered([]);
    setScanErr(null);
  };

  const STEP_IDX: Record<WizStep, number> = { input: 1, scanning: 2, results: 3, done: 4 };
  const cur = STEP_IDX[step];
  const arr = (
    <span className="ob-arr">
      <Icon name="arrowr" size={13} />
    </span>
  );
  const stepTab = (n: number, label: string) => (
    <div className={"ob-tab" + (cur === n ? " on" : "") + (cur > n ? " done" : "")}>
      <span className="ob-n">{cur > n ? <Icon name="check" size={12} /> : n}</span>
      {label}
    </div>
  );

  /* ---- step bodies ---- */
  const inputBody = (
    <>
      <div className="swz-lead">
        输入要扫描的 IP 或网段（CIDR），可添加多条。只探活、不写库——发现的设备要勾选后才会加入。
      </div>
      <div className="ss-list">
        {targets.map((t, i) => {
          const c = classify(t);
          const label = c === "cidr" ? "网段" : c === "ip" ? "IP" : c === "bad" ? "无效" : "—";
          return (
            <div key={i} className="ss-row">
              <span className={"ss-type " + c}>{label}</span>
              <input
                className={"ss-input mono" + (c === "bad" ? " bad" : "")}
                value={t}
                autoFocus={i === 0}
                placeholder="10.20.8.0/24 或 10.20.8.15"
                spellCheck={false}
                onChange={(e) => setTarget(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void startScan();
                }}
              />
              <button
                className="iconbtn"
                onClick={() => removeTarget(i)}
                title="移除"
                disabled={targets.length <= 1}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <button className="mini-btn swz-add" onClick={addTarget}>
        ＋ 添加 IP / 网段
      </button>
    </>
  );

  const scanningBody = (
    <>
      <div className="swz-scan-h">
        <span className="spin">
          <Icon name="sync" size={16} />
        </span>
        {"正在扫描 " + validTargets.length + " 个目标 · 探活中…"}
      </div>
      <div className="swz-scan-list">
        {validTargets.map((t) => (
          <div className="swz-scan-row" key={t}>
            <span className="poll-dot" />
            <span className="mono">{"scan_network " + t}</span>
            <span className="swz-scan-st">探活中…</span>
          </div>
        ))}
      </div>
    </>
  );

  const resultsBody = (
    <>
      <div className="swz-results-h">
        <span className="swz-results-t">
          <Icon name="search" size={14} />
          发现 <b>{allDisc.length}</b> 台未纳管设备
        </span>
        <span className="swz-sel-pill">
          已选 <b>{pick.length}</b>
        </span>
      </div>
      {/* 部分网段失败只作非阻断提示，不吞掉已成功网段发现的设备 */}
      {scanErr ? (
        <div className="swz-scan-warn">
          <Icon name="alert" size={13} />
          {scanErr}
        </div>
      ) : null}
      {allDisc.length ? (
        <div className="swz-results-list">
          {matchedGroups.map((g) => {
            const ips = g.hosts.map((x) => x.ip);
            const allOn = ips.every((ip) => pick.includes(ip));
            return (
              <div key={g.subnet} className="scan-group">
                <div className="scan-sub">
                  <span className="mono">{g.subnet}</span>
                  <span className="scan-ct">{g.hosts.length + " 台"}</span>
                  <button className="mini-btn" onClick={() => toggleSubnet(g.hosts)}>
                    {allOn ? "取消本网段" : "全选本网段"}
                  </button>
                </div>
                {g.hosts.map((x) => (
                  <div
                    key={x.ip}
                    className={"disc-row" + (pick.includes(x.ip) ? " on" : "")}
                    onClick={() => toggle(x.ip)}
                  >
                    <span className={"mck" + (pick.includes(x.ip) ? " on" : "")}>
                      {pick.includes(x.ip) ? <Icon name="check" size={12} /> : null}
                    </span>
                    <span className="d-host">{portsOf(x)}</span>
                    <span className="d-ip mono">{x.ip}</span>
                    {reachableOf(x) ? (
                      <span className="d-note ok">
                        <Icon name="shield" size={11} />
                        可管理
                      </span>
                    ) : (
                      <span className="d-note warn">
                        <Icon name="alert" size={11} />
                        无管理端口
                      </span>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="swz-empty">
          {scanErr
            ? "扫描失败，且没有成功发现的设备。"
            : "这些目标下没有发现未纳管设备。已纳管的机器不会重复出现。"}
        </div>
      )}
    </>
  );

  const doneBody = (
    <div className="ob-done">
      <div className="ob-done-ico">
        <Icon name="check" size={26} />
      </div>
      <div className="ob-done-t">{added + " 台已加入机器列表"}</div>
      <div className="ob-done-d">
        已纳入管理，后台继续：GPU 矩阵核对 · 项目发现。还未入网的机器，在机器列表里逐台「获取入网脚本」，拷到目标机运行后回来点刷新即可。
      </div>
      <div className="ob-done-acts">
        <Button variant="accent" size="M" onPress={onClose}>
          完成
        </Button>
        <Button
          variant="secondary"
          size="M"
          icon={<Icon name="search" size={14} />}
          onPress={restart}
        >
          再扫一次
        </Button>
      </div>
    </div>
  );

  /* ---- grounded footer bar per step ---- */
  const foot =
    step === "input" ? (
      <div className="swz-foot">
        <span className="swz-foot-hint">
          <span className="swz-cli">scan_network(cidr)</span> · 仅发现未纳管设备
        </span>
        <Button
          variant="accent"
          size="M"
          isDisabled={!validTargets.length}
          icon={<Icon name="search" size={14} />}
          onPress={() => void startScan()}
        >
          开始扫描
        </Button>
      </div>
    ) : step === "scanning" ? (
      <div className="swz-foot">
        <span className="swz-foot-hint">探活完成后会列出未纳管设备</span>
        <Button variant="secondary" size="M" onPress={() => setStep("input")}>
          取消
        </Button>
      </div>
    ) : step === "results" ? (
      <div className="swz-foot">
        <Button
          variant="secondary"
          size="M"
          icon={<Icon name="chevr" size={14} style={{ transform: "rotate(180deg)" }} />}
          onPress={() => setStep("input")}
        >
          重新输入
        </Button>
        <span className="swz-foot-hint swz-foot-mid">
          {pick.length ? "已选 " + pick.length + " / " + allDisc.length + " 台" : "勾选要纳入的设备"}
        </span>
        <Button
          variant="accent"
          size="M"
          isDisabled={!pick.length}
          icon={<Icon name="download" size={14} />}
          onPress={() => void confirmAdd()}
        >
          {"加入选中 " + pick.length + " 台"}
        </Button>
      </div>
    ) : null;

  return (
    <div
      className="swz-overlay"
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).classList.contains("swz-overlay")) onClose();
      }}
    >
      <div className="swz-modal" role="dialog" aria-modal="true">
        <div className="swz-head">
          <span className="swz-ic">
            <Icon name="search" size={16} />
          </span>
          <div className="swz-title">扫描网段 · 发现并入网</div>
          <button className="iconbtn" onClick={onClose} title="关闭">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="swz-steps">
          {stepTab(1, "输入")}
          {arr}
          {stepTab(2, "扫描")}
          {arr}
          {stepTab(3, "选择")}
          {arr}
          {stepTab(4, "加入")}
        </div>
        <div className="swz-body">
          {step === "input" ? inputBody : null}
          {step === "scanning" ? scanningBody : null}
          {step === "results" ? resultsBody : null}
          {step === "done" ? doneBody : null}
        </div>
        {foot}
      </div>
    </div>
  );
}
