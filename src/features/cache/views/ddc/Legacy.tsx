// Volo · Cache —— DDC · 文件系统 DDC。移植自新原型 cache_ddc.jsx 的 legacyBody / backendPanel('smb') /
// deploySMB / deleteShare / shareRow / 本地 DDC 列表（localRow / deployLocalOne / deployLocalAll）。
//
// 真命令接线：
//  · 共享 DDC（SMB）：createShare(...)（破坏性 → openPreview.task.run），用所选运维凭据创建。
//  · 已纳管的共享：listShares() 列出，逐个「解除纳管」→ deleteShare(id, alsoRemoveRemote=false)
//    —— 只从 Volo 解除纳管，不删远端共享文件夹（B7：后端不支持远端删共享）。
//  · 本地 DDC：后端无 local-cache create —— 用 setMachineEnvVar(id,'UE-LocalDataCachePath',dir) 实现。
//
// 新原型处置：SMB 面板加「运维凭据」选择；去掉旧的逐机「连接客户端」内联按钮（客户端接入随
// backend-graph 自动生效）；机器行去掉 ddc% / channel，状态点用真实 Machine.status。
import { useMemo, useState } from "react";
import { Icon } from "../../ui/Icon";
import { Button } from "../../ui/Button";
import { Dot, type Visual } from "../../ui/status";
import { Selector } from "../../ui/Selector";
import { useCache } from "../../state/store";
import { useMachines } from "../../state/data";
import { useAsync } from "../../state/useAsync";
import { listShares, createShare, deleteShare, listCredentials, setMachineEnvVar } from "../../api/commands";
import type { Machine, ShareConfig, CredentialRecord } from "../../api/types";

const LOCAL_DDC_ENV = "UE-LocalDataCachePath";
const DEFAULT_LOCAL_DIR = "D:\\UE_DDC\\Local";

/** 真实机器状态 → 状态点 visual（三通道）。 */
const statusVisual = (s: Machine["status"]): Visual =>
  s === "online" ? "positive" : s === "offline" ? "neutral" : "notice";

// 后端 ShareMode serde rename_all="lowercase" → "open" | "managed"（见 crates share_configs.rs）
const MODE_LABEL: Record<string, string> = { open: "开放", managed: "受控" };

export function DdcLegacy() {
  const { openPreview } = useCache();
  const { machines } = useMachines();
  const shares = useAsync<ShareConfig[]>(() => listShares(), []);
  const shareList = shares.data ?? [];
  const credsQ = useAsync<CredentialRecord[]>(() => listCredentials(), []);
  const credList = credsQ.data ?? [];

  /* ---- 共享 DDC（SMB）部署表单 ---- */
  const machineOpts = machines
    .filter((n): n is Machine & { id: number } => n.id != null)
    .map((n) => ({ id: String(n.id), label: n.hostname, sub: n.ip }));
  const [srv, setSrv] = useState<string>("");
  const srvId = srv ? Number(srv) : machineOpts.length ? Number(machineOpts[0].id) : null;
  const srvNode = machines.find((n) => n.id === srvId) ?? null;
  const [smbLocalPath, setSmbLocalPath] = useState<string>("D:\\Volo\\DDC");

  /* 运维凭据：共享 DDC 创建用（share-kind 优先），存所选 alias。 */
  const credOpts = credList.map((c) => ({ id: c.alias, label: c.alias, sub: c.kind }));
  const [shareCred, setShareCred] = useState<string>("");
  const effCred =
    shareCred || credList.find((c) => c.kind === "share")?.alias || credList[0]?.alias || "";

  /* 该宿主上是否已有共享（驱动「已部署」徽标）。 */
  const hostShare = srvId != null ? shareList.find((s) => s.host_machine_id === srvId) ?? null : null;

  /* ---- 本地 DDC：每台机器独立路径 + 独立 / 一键部署 ---- */
  const [localDirs, setLocalDirs] = useState<Record<number, string>>({});
  const dirOf = (id: number): string => localDirs[id] ?? DEFAULT_LOCAL_DIR;
  const setLocalDir = (id: number, v: string) => setLocalDirs((m) => ({ ...m, [id]: v }));

  const onlineLocalTargets = useMemo(
    () => machines.filter((n) => n.status !== "offline" && n.id != null),
    [machines],
  );

  /* ---- SMB：创建共享（破坏性 → preview.task.run 接 createShare） ---- */
  const deploySMB = () => {
    if (srvNode == null || srvId == null) return;
    openPreview({
      title: "创建共享 DDC（SMB）",
      icon: "folder",
      cli: "create_share",
      destructive: true,
      channel: "ssh",
      confirmLabel: hostShare ? "重新创建共享" : "创建共享",
      steps: [
        "使用运维凭据 " + (effCred || "（未选）") + " 在这台机器上新建一个共享缓存文件夹",
        "自动把集群的缓存指向这个共享文件夹",
        "其他机器会自动连接并开始使用这个共享缓存",
      ],
      simpleScope: [{ host: srvNode.hostname, ip: srvNode.ip, msg: "共享盘宿主 · " + smbLocalPath }],
      task: {
        domain: "share",
        action: "create",
        target: srvNode.hostname,
        chan: "ssh",
        note: "SMB 共享 DDC 已创建（凭据 " + (effCred || "—") + "）",
        lines: [
          {
            msg:
              "create_share host=" +
              srvNode.hostname +
              " name=DDC local=" +
              smbLocalPath +
              (effCred ? " --cred " + effCred : ""),
          },
          { lv: "ok", msg: "共享创建完成，backend-graph 已写入" },
        ],
        run: async () => {
          await createShare({
            hostMachineId: srvId,
            mode: "open",
            shareName: "DDC",
            localPath: smbLocalPath,
            operatorCredentialAlias: effCred || undefined,
          });
          shares.reload();
        },
      },
    });
  };

  /* ---- 解除共享纳管：delete_share also_remove_remote=false（不删远端文件夹） ---- */
  const removeShare = (sh: ShareConfig) => {
    if (sh.id == null) return;
    const shareId = sh.id;
    openPreview({
      title: "解除共享纳管 · " + sh.unc_path,
      icon: "trash",
      cli: "delete_share",
      destructive: true,
      channel: "ssh",
      confirmLabel: "解除纳管",
      steps: [
        "从 Volo 解除对该共享的纳管（不再分发 / 不再注入客户端）",
        "不会删除远端共享文件夹本身（后端暂不支持远端删共享）",
      ],
      simpleScope: [{ host: sh.unc_path, ip: MODE_LABEL[sh.mode] ?? sh.mode, msg: "仅解除纳管" }],
      task: {
        domain: "share",
        action: "delete",
        target: sh.unc_path,
        chan: "ssh",
        note: "已解除共享纳管（远端文件夹保留）",
        lines: [
          { lv: "warn", msg: "delete_share " + sh.unc_path + " (also_remove_remote=false)" },
          { lv: "ok", msg: "已从 Volo 解除纳管 · 远端共享文件夹保留" },
        ],
        run: async () => {
          await deleteShare(shareId, false);
          shares.reload();
        },
      },
    });
  };

  const shareRow = (sh: ShareConfig) => {
    const host = machines.find((n) => n.id === sh.host_machine_id);
    return (
      <div key={sh.id ?? sh.unc_path} className="art-row">
        <span className="art-dot s-positive">
          <Icon name="folder" size={12} />
        </span>
        <div className="art-meta">
          <div className="art-name mono">{sh.unc_path}</div>
          <div className="art-sub">
            {(MODE_LABEL[sh.mode] ?? sh.mode) + " · 宿主 " + (host?.hostname ?? sh.host_machine_id)}
          </div>
        </div>
        <button className="mini-btn danger" onClick={() => removeShare(sh)}>
          <Icon name="trash" size={12} />
          解除纳管
        </button>
      </div>
    );
  };

  /* ---- 本地 DDC：单台 / 一键部署（setMachineEnvVar UE-LocalDataCachePath） ---- */
  const deployLocalOne = (n: Machine) => {
    if (n.id == null) return;
    const id = n.id;
    const dir = dirOf(id);
    openPreview({
      title: "部署本地 DDC · " + n.hostname,
      icon: "server",
      cli: "set_machine_env_var " + LOCAL_DDC_ENV,
      destructive: true,
      channel: "ssh",
      confirmLabel: "部署",
      steps: [
        "在这台机器写入本地 DDC 路径 " + dir,
        "作为找不到共享缓存时的本地兜底，配置后自动复核",
      ],
      simpleScope: [{ host: n.hostname, ip: n.ip, msg: dir }],
      task: {
        domain: "local-ddc",
        action: "deploy",
        target: n.hostname,
        chan: "ssh",
        note: "本地 DDC 已部署 · " + dir,
        lines: [
          { msg: "set_machine_env_var " + LOCAL_DDC_ENV + "=" + dir },
          { lv: "ok", msg: n.hostname + " 本地缓存层已就绪" },
        ],
        run: () => setMachineEnvVar(id, LOCAL_DDC_ENV, dir),
      },
    });
  };

  const deployLocalAll = () => {
    const targets = onlineLocalTargets;
    openPreview({
      title: "一键部署本地 DDC",
      icon: "bolt",
      cli: "set_machine_env_var " + LOCAL_DDC_ENV,
      destructive: true,
      channel: "ssh",
      confirmLabel: "部署 " + targets.length + " 台",
      steps: [
        "为这些机器逐台写入本地 DDC 路径",
        "作为找不到共享缓存时的本地兜底，配置后自动复核",
      ],
      simpleScope: targets.map((n) => ({ host: n.hostname, ip: n.ip, msg: dirOf(n.id!) })),
      task: {
        domain: "local-ddc",
        action: "deploy",
        target: targets.length + " 台",
        chan: "ssh",
        note: "一键部署本地 DDC（" + targets.length + " 台）",
        lines: [
          { msg: "set_machine_env_var " + LOCAL_DDC_ENV + " ×" + targets.length },
          { lv: "ok", msg: targets.length + " 台本地缓存层已就绪" },
        ],
        // allSettled：单台失败不中断其余写入，按真实成功数汇报（对齐 ScanWizard.confirmAdd）。
        run: async (ctx) => {
          const results = await Promise.allSettled(
            targets.map((n) => setMachineEnvVar(n.id!, LOCAL_DDC_ENV, dirOf(n.id!))),
          );
          let ok = 0;
          results.forEach((r, i) => {
            if (r.status === "fulfilled") ok++;
            else
              ctx.log({
                lv: "warn",
                cat: "local-ddc",
                msg: `${targets[i].hostname} 写入失败 · ${String(r.reason)}`,
              });
          });
          ctx.log({
            lv: ok === targets.length ? "ok" : "warn",
            cat: "local-ddc",
            msg: `本地 DDC 部署 ${ok}/${targets.length} 台成功`,
          });
          if (ok === 0) throw new Error("全部部署失败");
        },
      },
    });
  };

  /* ---- 本地 DDC 逐机行 ---- */
  const localRow = (n: Machine) => {
    const off = n.status === "offline";
    const id = n.id;
    return (
      <div key={id ?? n.ip} className={"cli-row local" + (off ? " off" : "")}>
        <Dot visual={statusVisual(n.status)} />
        <div className="cli-meta">
          <div className="cli-host mono">{n.hostname}</div>
          <div className="cli-sub">{n.ip + " · " + n.role}</div>
        </div>
        <input
          className="cli-pathin mono"
          value={id != null ? dirOf(id) : DEFAULT_LOCAL_DIR}
          disabled={off || id == null}
          spellCheck={false}
          onChange={(e) => id != null && setLocalDir(id, e.target.value)}
        />
        <div className="local-act">
          {off ? (
            <span className="cli-badge off">
              <Icon name="power" size={11} />
              离线
            </span>
          ) : (
            <button className="mini-btn" onClick={() => deployLocalOne(n)}>
              <Icon name="bolt" size={12} />
              部署
            </button>
          )}
        </div>
      </div>
    );
  };

  /* ---- ① 共享 DDC（SMB）部署面板（保留 .be-block / .deploy-panel） ---- */
  const smbPanel = (
    <div className="be-block">
      <div className="deploy-panel">
        <div className="dp-h">
          <Icon name="folder" size={15} />
          部署 共享 DDC（SMB）
          {hostShare ? (
            <span className="dp-cur">
              <Icon name="check" size={11} />
              已部署
            </span>
          ) : null}
        </div>
        <div className="dp-form">
          <div className="dp-field">
            <label>服务器机器</label>
            <Selector
              kpre="机器"
              value={srvId != null ? String(srvId) : ""}
              options={machineOpts}
              width={240}
              onChange={setSrv}
            />
          </div>
          <div className="dp-field">
            <label>共享路径（宿主本地）</label>
            <input
              className="dp-input mono"
              value={smbLocalPath}
              spellCheck={false}
              onChange={(e) => setSmbLocalPath(e.target.value)}
            />
          </div>
          <div className="dp-field">
            <label>运维凭据</label>
            <Selector
              kpre="凭据"
              value={effCred}
              options={credOpts}
              width={200}
              onChange={setShareCred}
            />
          </div>
          <div className="dp-go">
            <Button
              variant="accent"
              size="M"
              icon={<Icon name="bolt" size={14} />}
              isDisabled={srvId == null}
              onPress={deploySMB}
            >
              {hostShare ? "重新部署" : "创建共享"}
            </Button>
          </div>
        </div>
        <div className="dp-note">
          <Icon name="shield" size={13} />
          链路在后台逐步执行（进度进任务抽屉）；凭据 / 共享权限自动处理。
        </div>
      </div>
    </div>
  );

  const localCount = "在线 " + onlineLocalTargets.length + " / " + machines.length;

  const legacyBody = (
    <>
      <div className="ddc-sec-h">
        <span>① 共享 DDC（SMB）</span>
        <span className="dim">局域网共享缓存盘 · 无独立服务器的小集群</span>
      </div>
      {smbPanel}
      {shareList.length ? (
        <>
          <div className="ddc-sec-h">
            <span>已纳管的共享</span>
            <span className="dim">{shareList.length + " 个 · 解除纳管不删除远端文件夹"}</span>
          </div>
          <div className="art-list">{shareList.map(shareRow)}</div>
        </>
      ) : null}
      <div className="ddc-sec-h">
        <span>② 本地 DDC</span>
        <span className="dim">{localCount} · 每台可单独设置 data-dir</span>
      </div>
      <div className="cli-panel">
        <div className="cli-top">
          <div className="local-hint">
            <Icon name="server" size={15} />
            逐台开启本地缓存回退层 · 每台独立 data-dir，可单独部署
          </div>
          <div className="cli-go">
            <Button
              variant="accent"
              size="M"
              icon={<Icon name="bolt" size={14} />}
              isDisabled={onlineLocalTargets.length === 0}
              onPress={deployLocalAll}
            >
              {"一键部署（" + onlineLocalTargets.length + "）"}
            </Button>
          </div>
        </div>
        <div className="cli-note">
          <Icon name="shield" size={13} />
          本地 DDC 作为命中链路的回退层；部署链路在后台逐步执行，写入后自动回读校验。
        </div>
        <div className="cli-list">
          {machines.length === 0 ? (
            <div className="cli-row">
              <div className="cli-meta">
                <div className="cli-sub">集群里还没有机器</div>
              </div>
            </div>
          ) : (
            machines.map(localRow)
          )}
        </div>
      </div>
    </>
  );

  return (
    <div className="res ddc">
      <div className="canvas-head">
        <span className="t">DDC · 文件系统 DDC</span>
        <div className="right" />
      </div>
      <div className="ddc-body">{legacyBody}</div>
    </div>
  );
}
