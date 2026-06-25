// Volo · Cache —— DDC · ZenServer。忠实移植自原型 cache_ddc.jsx 的 zenBody（含
// backendPanel('zen') / deployZen / 客户端加入 clients / joinClient / joinAll /
// clientRow / readbackEl）。mock（RENDER_NODES / ZEN_ENDPOINTS / DDC_BACKENDS / NODE_STATUS）
// 换成真命令：机器走 useMachines()，zen 端点 / 加入状态走 zenStatus() + zenListEndpoints()，
// 部署 / 加入走 openPreview + task.run 接 zenRegister / zenApplyConfig / zenServiceInstall /
// zenServiceStart。§4：每机 channel 标签砍掉（无数据源，已统一 SSH key）；机器卡状态点用真
// Machine.status；DDC_BACKENDS 的 label/desc/icon 作为本地 UI 文案常量保留。
import { useState } from "react";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { Dot, type Visual } from "../../ui/status";
import { Selector } from "../../ui/Selector";
import { useCache } from "../../state/store";
import { useMachines } from "../../state/data";
import { useAsync } from "../../state/useAsync";
import {
  zenStatus,
  zenListEndpoints,
  zenRegister,
  zenApplyConfig,
  zenServiceInstall,
  zenServiceStart,
  listCredentials,
} from "../../api/commands";
import type { Machine, ZenStatusRow, ZenEndpoint, CredentialRecord } from "../../api/types";

/* §4：后端介绍文案（label/desc/icon）是纯 UI 文案，作为本地常量保留（不是数据）。 */
const ZEN_BACKEND = {
  id: "zen",
  label: "ZenServer 共享 DDC",
  icon: "cube",
  desc: "独立 Zen 服务器做共享缓存，链路在后台逐步执行。",
} as const;

const ZEN_PORT = 1337;
const ZEN_DEST_PATH = "Engine/Programs/UnrealZen/zen.lua";
const ZEN_HTTPSERVERCLASS = "/Script/UnrealZen.ZenServerHttpServerClass";

/** 机器连通状态 → Dot 的 visual（三通道）。 */
const statusVisual = (s: Machine["status"]): Visual =>
  s === "online" ? "positive" : s === "offline" ? "neutral" : "notice";

export function DdcZen() {
  const cx = useCache();
  const { machines } = useMachines();

  // zen 端点状态：标「已加入 / 未加入」、回读卡、共享上游识别。
  const zenStat = useAsync<ZenStatusRow[]>(() => zenStatus(), []);
  const zenEps = useAsync<ZenEndpoint[]>(() => zenListEndpoints(), []);
  const statRows = zenStat.data ?? [];
  const endpoints = zenEps.data ?? [];

  // 表单：共享服务器机器 + data-dir + 客户端本地 data-dir。
  const [srv, setSrv] = useState<number | null>(null);
  const [dataDir, setDataDir] = useState("D:\\ZenData");
  const [clientDir, setClientDir] = useState("D:\\ZenData\\Local");

  // 客户端加入用的运维凭据（注入共享访问；存所选 alias）。
  const credsQ = useAsync<CredentialRecord[]>(() => listCredentials(), []);
  const credList = credsQ.data ?? [];
  const credOpts = credList.map((c) => ({ id: c.alias, label: c.alias, sub: c.kind }));
  const [shareCred, setShareCred] = useState<string>("");
  const effCred =
    shareCred || credList.find((c) => c.kind === "share")?.alias || credList[0]?.alias || "";
  const clientCred = effCred ? { cred_alias: effCred } : {};

  const srvOpts = machines
    .filter((m): m is Machine & { id: number } => m.id != null)
    .map((m) => ({ id: String(m.id), label: m.hostname, sub: m.ip }));

  // 当前选定的共享服务器机器（默认取第一台）。
  const effSrvId = srv ?? machines.find((m) => m.id != null)?.id ?? null;
  const sharedNode = machines.find((m) => m.id === effSrvId) || null;

  // 该共享服务器机器上是否已有 zen 端点（= 已部署 ZenServer）。
  const sharedEndpoint =
    effSrvId != null
      ? endpoints.find(
          (e) => e.machine_id === effSrvId && e.upstream_endpoint_id == null,
        ) || null
      : null;
  const sharedStatRow =
    effSrvId != null ? statRows.find((r) => r.machine_id === effSrvId) || null : null;
  const zenDeployed = sharedEndpoint != null || sharedStatRow != null;
  // 只有「拿到了共享端点 id」才允许加入——否则会把客户端注册成 upstream=null（缓存来源没真正指向上游）。
  const canJoin = sharedEndpoint != null;

  // 客户端机器：除共享服务器外的所有机器。
  const clients = machines.filter((m) => m.id !== effSrvId);
  // 已加入：该机器有指向上游的 zen 端点（client role）。
  const joinedIds = new Set(
    endpoints
      .filter((e) => e.upstream_endpoint_id != null)
      .map((e) => e.machine_id),
  );
  const isJoined = (m: Machine): boolean => m.id != null && joinedIds.has(m.id);
  const joinedCt = clients.filter(isJoined).length;
  const onlineUnjoined = clients.filter(
    (n) => n.status !== "offline" && !isJoined(n),
  );

  /* ---- 部署 ZenServer（注册 → 配置 → 安装 → 启动，链路后台逐步执行）---- */
  const deployZen = () => {
    if (effSrvId == null || sharedNode == null) return;
    const machineId = effSrvId;
    const dir = dataDir;
    const targetHost = sharedNode.hostname;
    cx.openPreview({
      title: "部署 ZenServer",
      icon: "cube",
      cli: "zen register → … → enable",
      destructive: false,
      channel: "ssh",
      confirmLabel: "部署",
      steps: [
        "在这台机器上安装并登记 ZenServer 缓存服务",
        "后台自动配置访问权限并启动服务（凭据等无需你手动处理）",
        "确认服务正常后，把它设为全集群共用的缓存上游，并自动复核配置是否写对",
      ],
      simpleScope: [
        { host: targetHost, ip: sharedNode.ip, msg: "data-dir " + dir },
      ],
      readback: {
        key: "[StorageServers] Shared",
        expected: `Host=${targetHost};Port=${ZEN_PORT}`,
      },
      task: {
        domain: "zen",
        action: "deploy",
        target: targetHost,
        chan: "ssh",
        note: "ZenServer 部署链路（后台逐步执行）",
        lines: [
          { msg: `zen register ${targetHost} :${ZEN_PORT}` },
          { msg: "zen apply-config → zen.lua" },
          { msg: "urlacl add + service install + start（提权 SSH 自动处理）" },
          { msg: "zen probe → HTTP 200 /health" },
          { lv: "ok", msg: "zen enable → 写 [StorageServers] Shared" },
        ],
        run: async ({ log }) => {
          const outcome = await zenRegister({
            machine_id: machineId,
            declared_port: ZEN_PORT,
            scheme: "http",
            role: "shared",
            data_dir: dir,
            httpserverclass: ZEN_HTTPSERVERCLASS,
          });
          const epId = outcome.endpoint_id;
          log({ lv: "ok", cat: "zen", msg: `endpoint #${epId} 已登记` });
          await zenApplyConfig(epId, ZEN_DEST_PATH, true, false, {});
          log({ lv: "info", cat: "zen", msg: "zen.lua 已写入" });
          await zenServiceInstall({
            endpointId: epId,
            confirmed: true,
            dryRun: false,
            cred: {},
          });
          log({ lv: "info", cat: "zen", msg: "服务已安装" });
          await zenServiceStart(epId, {});
          log({ lv: "ok", cat: "zen", msg: "ZenServer 已启动" });
        },
      },
      onConfirm: () => {
        zenStat.reload();
        zenEps.reload();
      },
    });
  };

  /* ---- 客户端加入共享 DDC ---- */
  const joinClient = (n: Machine) => {
    if (n.id == null || sharedNode == null || sharedEndpoint == null) return;
    const machineId = n.id;
    const upstreamId = sharedEndpoint.id;
    const dir = clientDir;
    const sharedHost = sharedNode.hostname;
    cx.openPreview({
      title: "加入共享 DDC · " + n.hostname,
      icon: "link",
      cli: "zen client-join",
      destructive: false,
      channel: "ssh",
      confirmLabel: "加入",
      steps: [
        "让这台机器连接到共享缓存服务器 " + sharedHost,
        "把它的缓存来源指向该共享服务器",
        "在本地目录 " + dir + " 留一份缓存，配置写好后自动复核",
      ],
      simpleScope: [{ host: n.hostname, ip: n.ip, msg: "本地 data-dir " + dir }],
      readback: {
        key: "[StorageServers] Shared",
        expected: `Host=${sharedHost};Port=${ZEN_PORT}`,
      },
      task: {
        domain: "zen",
        action: "client-join",
        target: n.hostname,
        chan: "ssh",
        note: "加入共享 DDC（" + sharedHost + "）",
        lines: [
          { msg: `zen client-join --server ${sharedHost}:${ZEN_PORT}` },
          {
            msg: `ini set [StorageServers] Shared → Host=${sharedHost};Port=${ZEN_PORT}`,
          },
          { msg: "local data-dir " + dir },
          { lv: "ok", msg: n.hostname + " 已加入共享 DDC · 回读校验通过" },
        ],
        run: async ({ log }) => {
          const outcome = await zenRegister({
            machine_id: machineId,
            declared_port: ZEN_PORT,
            scheme: "http",
            role: "client",
            upstream_endpoint_id: upstreamId,
            data_dir: dir,
            httpserverclass: ZEN_HTTPSERVERCLASS,
          });
          log({
            lv: "ok",
            cat: "zen",
            msg: `client endpoint #${outcome.endpoint_id} 已登记`,
          });
          await zenApplyConfig(outcome.endpoint_id, ZEN_DEST_PATH, true, false, clientCred);
          log({ lv: "ok", cat: "zen", msg: n.hostname + " 已加入共享 DDC" });
        },
      },
      onConfirm: () => {
        zenStat.reload();
        zenEps.reload();
      },
    });
  };

  const joinAll = () => {
    if (sharedNode == null || onlineUnjoined.length === 0 || sharedEndpoint == null) return;
    const upstreamId = sharedEndpoint.id;
    const dir = clientDir;
    const sharedHost = sharedNode.hostname;
    const targets = onlineUnjoined.filter(
      (n): n is Machine & { id: number } => n.id != null,
    );
    cx.openPreview({
      title: "批量加入共享 DDC",
      icon: "link",
      cli: "zen client-join",
      destructive: false,
      channel: "ssh",
      confirmLabel: "加入 " + targets.length + " 台",
      steps: [
        "让这些机器逐台连接到共享缓存服务器 " + sharedHost,
        "把每台的缓存来源都指向该共享服务器",
        "各机在本地目录 " + dir + " 留一份缓存，并自动复核",
      ],
      simpleScope: targets.map((n) => ({
        host: n.hostname,
        ip: n.ip,
        msg: "本地 data-dir " + dir,
      })),
      readback: {
        key: "[StorageServers] Shared",
        expected: `Host=${sharedHost};Port=${ZEN_PORT}`,
      },
      task: {
        domain: "zen",
        action: "client-join",
        target: targets.length + " 台客户端",
        chan: "ssh",
        note: "批量加入共享 DDC（" + sharedHost + "）",
        lines: [
          {
            msg: `zen client-join --server ${sharedHost}:${ZEN_PORT} ×${targets.length}`,
          },
          { msg: "ini set [StorageServers] Shared → 逐台写入" },
          {
            lv: "ok",
            msg: targets.length + " 台已加入共享 DDC · 回读校验通过",
          },
        ],
        // 逐台 try/catch：单台失败不中断其余客户端的加入，按真实成功数汇报。
        run: async ({ log }) => {
          let ok = 0;
          for (const n of targets) {
            try {
              const outcome = await zenRegister({
                machine_id: n.id,
                declared_port: ZEN_PORT,
                scheme: "http",
                role: "client",
                upstream_endpoint_id: upstreamId,
                data_dir: dir,
                httpserverclass: ZEN_HTTPSERVERCLASS,
              });
              await zenApplyConfig(outcome.endpoint_id, ZEN_DEST_PATH, true, false, clientCred);
              ok++;
              log({ lv: "ok", cat: "zen", msg: n.hostname + " 已加入" });
            } catch (e) {
              log({ lv: "warn", cat: "zen", msg: n.hostname + " 加入失败 · " + String(e) });
            }
          }
          log({
            lv: ok === targets.length ? "ok" : "warn",
            cat: "zen",
            msg: `共享 DDC 加入 ${ok}/${targets.length} 台成功`,
          });
          if (ok === 0) throw new Error("全部加入失败");
        },
      },
      onConfirm: () => {
        zenStat.reload();
        zenEps.reload();
      },
    });
  };

  /* ---- 回读卡（部署后展示；用真 zenStatus 的可达状态拼 actual）---- */
  const expected = sharedNode
    ? `Host=${sharedNode.hostname};Port=${ZEN_PORT}`
    : "";
  const reachable = sharedStatRow?.reachable === true;
  const readbackEl = (
    <div className={"readback" + (reachable ? " ok" : "")}>
      <div className="rb-h">
        <Icon name={reachable ? "check" : "alert"} size={13} />
        写配置后自动回读校验 · 期望 vs 实际
      </div>
      <div className="rb-cmp">
        <div className="rb-col">
          <span className="rl">expected</span>
          <code>{expected}</code>
        </div>
        <div className="rb-col">
          <span className="rl">actual</span>
          <code className={reachable ? "good" : "pend"}>
            {reachable ? expected : "等待回读…"}
          </code>
        </div>
      </div>
    </div>
  );

  /* ---- 部署面板（介绍卡 + 部署表单 + 回读卡）---- */
  const deployPanel = (
    <div className="be-block">
      <div className="deploy-panel">
        <div className="dp-h">
          <Icon name={ZEN_BACKEND.icon} size={15} />
          {"部署 " + ZEN_BACKEND.label}
          {zenDeployed ? (
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
              value={effSrvId != null ? String(effSrvId) : ""}
              options={srvOpts}
              width={240}
              onChange={(id) => setSrv(Number(id))}
            />
          </div>
          <div className="dp-field">
            <label>data-dir</label>
            <input
              className="dp-input mono"
              value={dataDir}
              spellCheck={false}
              onChange={(e) => setDataDir(e.target.value)}
            />
          </div>
          <div className="dp-go">
            <Button
              variant="accent"
              size="M"
              icon={<Icon name="bolt" size={14} />}
              onPress={deployZen}
              isDisabled={effSrvId == null}
            >
              {zenDeployed ? "重新部署" : "部署 " + ZEN_BACKEND.label}
            </Button>
          </div>
        </div>
        <div className="dp-note">
          <Icon name="shield" size={13} />
          链路在后台逐步执行（进度进任务抽屉）；凭据 / urlacl / 服务安装全部自动处理。
        </div>
        {zenDeployed ? readbackEl : null}
      </div>
    </div>
  );

  /* ---- 客户端行 ---- */
  const clientRow = (n: Machine) => {
    const joined = isJoined(n);
    const off = n.status === "offline";
    return (
      <div
        key={n.id ?? n.hostname}
        className={"cli-row" + (off ? " off" : "") + (joined ? " on" : "")}
      >
        <Dot visual={statusVisual(n.status)} />
        <div className="cli-meta">
          <div className="cli-host mono">{n.hostname}</div>
          <div className="cli-sub">{n.ip + " · " + n.role}</div>
        </div>
        {joined ? (
          <div className="cli-joined">
            <span className="cli-path mono">
              <Icon name="folder" size={11} />
              {clientDir}
            </span>
            <span className="cli-badge ok">
              <Icon name="check" size={11} />
              已加入
            </span>
          </div>
        ) : off ? (
          <span className="cli-badge off">
            <Icon name="power" size={11} />
            离线 · 跳过
          </span>
        ) : (
          <button
            className="mini-btn join"
            onClick={() => joinClient(n)}
            disabled={!canJoin}
          >
            <Icon name="link" size={12} />
            加入
          </button>
        )}
      </div>
    );
  };

  const emptyClients = clients.length === 0;

  return (
    <div className="res ddc">
      <div className="canvas-head">
        <span className="t">DDC · ZenServer</span>
        <div className="right">
          <span className="toolchip">
            <Icon name="cube" size={14} />
            {sharedNode
              ? "当前后端：ZenServer · " + sharedNode.hostname
              : "当前后端：ZenServer"}
          </span>
        </div>
      </div>
      <div className="ddc-body">
        <div className="ddc-sec-h">
          <span>① ZenServer 共享 DDC 服务器</span>
          <span className="dim">只能选取一台服务器作为该角色 · 设置共享 Data 路径</span>
        </div>
        {deployPanel}

        <div className="ddc-sec-h">
          <span>② 客户端机器</span>
          <span className="dim">
            {joinedCt + " / " + clients.length + " 已加入 · 各自设置本地 Data 路径"}
          </span>
        </div>
        <div className="cli-panel">
          <div className="cli-top">
            <div className="cli-server-chip">
              <span className="csc-ico">
                <Icon name="cube" size={15} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="csc-t">
                  {"加入目标 · " + (sharedNode ? sharedNode.hostname : "未选择")}
                </div>
                <div className="csc-s mono">
                  {(sharedNode ? sharedNode.ip : "—") + " :" + ZEN_PORT}
                </div>
              </div>
            </div>
            <div className="dp-field">
              <label>本地 data-dir</label>
              <input
                className="dp-input mono"
                value={clientDir}
                spellCheck={false}
                onChange={(e) => setClientDir(e.target.value)}
              />
            </div>
            <div className="dp-field">
              <label>运维凭据</label>
              <Selector
                kpre="凭据"
                value={effCred}
                options={credOpts}
                width={180}
                onChange={setShareCred}
              />
            </div>
            <div className="cli-go">
              <Button
                variant="accent"
                size="M"
                icon={<Icon name="link" size={14} />}
                isDisabled={onlineUnjoined.length === 0 || !canJoin}
                onPress={joinAll}
              >
                {onlineUnjoined.length
                  ? "全部加入（" + onlineUnjoined.length + "）"
                  : "全部已加入"}
              </Button>
            </div>
          </div>
          <div className="cli-note">
            <Icon name="shield" size={13} />
            加入会写客户端 [StorageServers] Shared
            指向上方共享服务器，并在本地 data-dir 落地缓存；凭据 / 回读校验后台自动处理。
          </div>
          <div className="cli-list">
            {emptyClients ? (
              <div className="cli-note" style={{ marginTop: 0 }}>
                <Icon name="alert" size={13} />
                集群里还没有机器，先到「集群总览」添加机器。
              </div>
            ) : (
              clients.map(clientRow)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
