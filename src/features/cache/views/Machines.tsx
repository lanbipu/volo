// Volo · Cache —— 机器管理 section（移植自新原型 cache_machines.jsx 的 MachineSection）。
// 嵌入「集群总览」：已纳管列表（grid/list 双视图） + 扫描入口 + 逐机「获取入网脚本」。
// 新原型处置：全栈统一 SSH key 现场入网，不再「远程部署」；逐机动作改为「获取入网脚本」
// （get_winrm_bootstrap_script → 拷到目标机运行 → 回来刷新）。env 列只剩两态：已入网 / 待入网。
// 砍掉每机 ddc%/pso% 百分比与 per-node channel 标签；机器状态点用真实 Machine.status（三通道）。
import { useState } from "react";
import { Icon } from "../ui/Icon";
import { Button } from "../ui/Button";
import { Dot, StatusPill } from "../ui/status";
import { useCache } from "../state/store";
import { useMachines } from "../state/data";
import { refreshMachine } from "../api/commands";
import type { Machine } from "../api/types";

export function MachineSection({ onScan }: { onScan: () => void }) {
  const { runTask, setDrawer, enrolled } = useCache();
  const { machines, reload } = useMachines();
  const [machView, setMachView] = useState<"list" | "grid">("grid");
  const open = (id: number) => setDrawer({ kind: "machine", id });
  // 「在线」严格 status==="online"（与 CacheActions / Overview 口径一致；unknown 不计在线）。
  const online = machines.filter((n) => n.status === "online").length;
  // 已入网 = 管理通道已探达（status online）或本会话刚跑完入网脚本（enrolled）。
  const isDeployed = (n: Machine) =>
    n.id != null && (n.status === "online" || enrolled.includes(n.id));

  /* 获取入网脚本 = get_winrm_bootstrap_script（SSH key 现场入网，不再远程推送），打开脚本面板 */
  const getScript = (n: Machine) => n.id != null && setDrawer({ kind: "script", id: n.id });

  const envCell = (n: Machine) => {
    if (n.status === "offline")
      return (
        <span className="env-cell">
          <span className="env-dash">—</span>
        </span>
      );
    if (isDeployed(n))
      return (
        <span className="env-cell">
          <span className="env-ok">
            <Icon name="check" size={12} />
            已入网
          </span>
          <button
            className="env-btn redeploy"
            title="重新获取入网脚本"
            onClick={(e) => {
              e.stopPropagation();
              getScript(n);
            }}
          >
            <Icon name="doc" size={12} />
            脚本
          </button>
        </span>
      );
    return (
      <span className="env-cell">
        <button
          className="env-btn pending"
          onClick={(e) => {
            e.stopPropagation();
            getScript(n);
          }}
        >
          <Icon name="doc" size={12} />
          获取入网脚本
        </button>
      </span>
    );
  };

  // 「刷新全部」：对在线机逐个 refreshMachine（真命令），完成后 reload。
  const refreshAll = () => {
    const onlineMachines = machines.filter(
      (n): n is Machine & { id: number } => n.id != null && n.status !== "offline",
    );
    runTask({
      domain: "machine",
      action: "refresh",
      target: "全部在线机",
      chan: "ssh",
      note: "重新探测在线 / UE / last-seen",
      lines: [
        { msg: "machine refresh（全部）…" },
        { lv: "ok", msg: "已刷新在线状态与 UE 安装" },
      ],
      run: async () => {
        for (const n of onlineMachines) {
          await refreshMachine(n.id);
        }
        reload();
      },
    });
  };

  return (
    <div className="dash-card mach-card">
      <div className="dc-h">
        <span className="t">
          <Icon name="node" size={14} />
          机器管理
          <span className="dc-count">{machines.length + " 台 · " + online + " 在线"}</span>
        </span>
        <div className="mach-acts">
          <div className="view-toggle">
            <button
              className={"vt-btn" + (machView === "grid" ? " on" : "")}
              title="图标视图"
              onClick={() => setMachView("grid")}
            >
              <Icon name="grid" size={14} />
            </button>
            <button
              className={"vt-btn" + (machView === "list" ? " on" : "")}
              title="列表视图"
              onClick={() => setMachView("list")}
            >
              <Icon name="list" size={14} />
            </button>
          </div>
          <Button
            variant="secondary"
            size="S"
            icon={<Icon name="sync" size={14} />}
            onPress={refreshAll}
          >
            刷新全部
          </Button>
          <Button
            variant="accent"
            size="S"
            icon={<Icon name="search" size={14} />}
            onPress={onScan}
          >
            扫描网段…
          </Button>
        </div>
      </div>
      <div className="mlist">
        {machView === "list" ? (
          <>
            <div className="mrow2 mhead">
              <span>机器 / IP</span>
              <span>UE 版本</span>
              <span>last-seen</span>
              <span>环境</span>
              <span style={{ textAlign: "right" }}>健康</span>
            </div>
            {machines.map((n) => (
              <div
                key={n.id}
                className={"mrow2" + (n.status === "offline" ? " off" : "")}
                onClick={() => n.id != null && open(n.id)}
              >
                <span className="mname">
                  <Dot
                    visual={
                      n.status === "online"
                        ? "positive"
                        : n.status === "offline"
                          ? "neutral"
                          : "notice"
                    }
                  />
                  <span className="h">{n.hostname}</span>
                  <span className="ip">{n.ip}</span>
                </span>
                <span className="mue">—</span>
                <span className="mseen">{n.last_seen_at ?? "—"}</span>
                {envCell(n)}
                <span style={{ display: "flex", justifyContent: "flex-end" }}>
                  <StatusPill status={n.status} />
                </span>
              </div>
            ))}
          </>
        ) : (
          <div className="mach-grid">
            {machines.map((n) => (
              <div
                key={n.id}
                className={"mach-tile" + (n.status === "offline" ? " off" : "")}
                onClick={() => n.id != null && open(n.id)}
              >
                <div className={"mt-ico " + (n.status !== "offline" ? "s-positive" : "s-neutral")}>
                  <Icon name="node" size={28} stroke={1.4} />
                </div>
                <div className="mt-host">{n.hostname}</div>
                {n.status === "offline" ? (
                  <div className="mt-env mt-env--off">离线</div>
                ) : isDeployed(n) ? (
                  <div className="mt-env mt-env--ok">已入网</div>
                ) : (
                  <div className="mt-env mt-env--pending">待入网</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
