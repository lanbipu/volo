// Volo · Cache —— 入网脚本面板（B5）。移植自新原型 page_cache.jsx 的 ScriptPanel。
// 全栈统一 SSH key 现场入网，后端不再远程推送：getWinrmBootstrapScript() 返回 enable-ssh.ps1 脚本文本，
// 拷到目标机以管理员运行后，回来点「刷新」→ refreshMachine + 标记 enrolled。
import { useState } from "react";
import { Icon } from "../ui/Icon";
import { Button } from "../ui/Button";
import { useCache } from "../state/store";
import { useMachines } from "../state/data";
import { useAsync } from "../state/useAsync";
import { getWinrmBootstrapScript, refreshMachine } from "../api/commands";

export function ScriptPanel({ id }: { id: number }) {
  const { setDrawer, runTask, markEnrolled } = useCache();
  const { byId, reload } = useMachines();
  const n = byId(id);
  const scriptQ = useAsync<string>(() => getWinrmBootstrapScript(), []);
  const [copied, setCopied] = useState(false);
  const close = () => setDrawer(null);
  if (!n) return null;

  const script =
    scriptQ.data ??
    (scriptQ.error === "not-in-tauri" ? "# 需在 Volo 桌面应用内获取脚本" : "# 加载入网脚本…");
  const copy = () => {
    navigator.clipboard?.writeText(script).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const refresh = () => {
    close();
    markEnrolled(id);
    runTask({
      domain: "machine",
      action: "refresh",
      target: n.hostname,
      chan: "ssh",
      note: "刷新入网状态（SSH 探活）",
      lines: [
        { msg: `refresh_machine ${n.hostname} — 探 SSH:22 / UE / GPU` },
        { lv: "ok", msg: `${n.hostname} SSH 可达 · 已入网` },
      ],
      run: async () => {
        await refreshMachine(id);
        reload();
      },
    });
  };
  const step = (i: number, tx: string) => (
    <div className="step-line" key={i}>
      <span className="sn">{i}</span>
      <span className="step-tx">{tx}</span>
    </div>
  );

  return (
    <div className="drawer drawer--script">
      <div className="drawer-h">
        <span className="di info">
          <Icon name="doc" size={17} />
        </span>
        <div style={{ minWidth: 0 }}>
          <h2>获取入网脚本</h2>
          <div className="sub">
            <span className="cli-pill">get_winrm_bootstrap_script</span>
            <span> · {n.hostname}</span>
          </div>
        </div>
        <button className="iconbtn x" onClick={close}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="drawer-b">
        <div className="script-intro">
          <Icon name="shield" size={14} />
          全栈已统一 SSH key 现场入网，后端不再远程推送配置。把下面脚本拷到目标机、以管理员运行，回来点「刷新」。
        </div>
        <div className="dblock">
          <div className="dblock-h">
            <span className="no">1</span>
            操作步骤
          </div>
          <div className="steps-list">
            {step(1, `把脚本拷贝到目标机 ${n.hostname}（${n.ip}）`)}
            {step(2, "以管理员运行 enable-ssh.ps1")}
            {step(3, "回到 Volo，点下方「刷新」确认入网")}
          </div>
        </div>
        <div className="dblock">
          <div className="dblock-h">
            <span className="no">2</span>
            enable-ssh.ps1
            <button className="mini-btn script-copy" onClick={copy}>
              <Icon name={copied ? "check" : "copy"} size={12} />
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          <pre className="script-code">{script}</pre>
        </div>
      </div>
      <div className="drawer-f">
        <Button variant="secondary" size="M" onPress={close}>
          关闭
        </Button>
        <Button variant="accent" size="M" icon={<Icon name="sync" size={15} />} onPress={refresh}>
          已运行 · 刷新
        </Button>
      </div>
    </div>
  );
}
