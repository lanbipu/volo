// Volo · Cache —— 机器详情浮层，移植自新原型 page_cache.jsx 的 machineDetail() / ddcReadConfig()。
//
// 忠实保留 .drawer--detail / .insp-sect / .kv / .ddc-read-* 视觉结构，mock 换真命令：
//   · 详情主体 → getMachineDetail(id)（machine / ue_installs[] / gpus[]）。
//   · 入网段（新增）→ 未入网时显示「获取入网脚本」入口，打开 ScriptPanel。
//   · ④ 入网账户 → 全栈统一 SSH key 现场入网（认证方式 / 入网脚本 / 公钥标识，均为真实事实）。
//   · ⑤ 关联 → zenStatus(id) + listShares() 过滤 host_machine_id==id；点击跳 DDC 页。
//   · ⑥ 已读到的 DDC 相关配置 → 只读两项能真实读到的：环境变量（get_machine_env_var）与
//     项目 DefaultEngine.ini [StorageServers]（read_ini_section）。这是「读到的配置」，
//     不是「多层有效配置解析」，不假造五层级联。
import { useAsync } from "../state/useAsync";
import { useCache } from "../state/store";
import { useMachines } from "../state/data";
import {
  getMachineDetail,
  zenStatus,
  listShares,
  getMachineEnvVar,
  readIniSection,
  refreshMachine,
  deleteMachine,
} from "../api/commands";
import { Icon } from "../ui/Icon";
import { Button } from "../ui/Button";
import { Dot, StatusPill } from "../ui/status";
import type {
  MachineDetail as MachineDetailDto,
  ZenStatusRow,
  ShareConfig,
} from "../api/types";

const ROLE_LABEL: Record<string, string> = {
  host: "宿主",
  render: "渲染",
  dev: "开发",
  editor: "编辑器",
  unknown: "未知",
};

const VENDOR_LABEL: Record<string, string> = {
  nvidia: "NVIDIA",
  amd: "AMD",
  intel: "Intel",
  unknown: "未知",
};

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className={"v" + (mono ? " mono" : "")}>{v}</span>
    </div>
  );
}

/* ⑥ 已读到的 DDC 相关配置 —— 两项真实可读：环境变量 + 项目 DefaultEngine.ini [StorageServers]。 */
interface DdcRead {
  local: string | null;
  shared: string | null;
  ini: { ok: boolean; val: string; note: string };
}

async function readDdcConfig(id: number): Promise<DdcRead> {
  const local = await getMachineEnvVar(id, "UE-LocalDataCachePath");
  const shared = await getMachineEnvVar(id, "UE-SharedDataCachePath");
  let ini: DdcRead["ini"];
  try {
    const keys = await readIniSection(id, "DefaultEngine.ini", "StorageServers");
    if (keys.length > 0) {
      ini = {
        ok: true,
        val: keys.map((kv) => `${kv.name}=${kv.value}`).join(" · "),
        note: "随版本库下发",
      };
    } else {
      ini = { ok: false, val: "[StorageServers] 未配置共享上游", note: "未写入共享上游服务器" };
    }
  } catch {
    // 项目 ini 不可读（未设项目路径 / 无 DefaultEngine.ini）
    ini = { ok: false, val: "[StorageServers] 未读取到", note: "项目配置未读取" };
  }
  return { local, shared, ini };
}

export function MachineDetail({ id }: { id: number }) {
  const { setDrawer, openPreview, runTask, setNav, enrolled } = useCache();
  const { reload: reloadMachines } = useMachines();
  const close = () => setDrawer(null);

  const detail = useAsync<MachineDetailDto>(() => getMachineDetail(id), [id]);
  const zen = useAsync<ZenStatusRow[]>(() => zenStatus(id), [id]);
  const shares = useAsync<ShareConfig[]>(() => listShares(), [id]);
  const readQ = useAsync<DdcRead>(() => readDdcConfig(id), [id]);

  if (detail.loading && !detail.data) {
    return (
      <div className="drawer drawer--detail">
        <div className="drawer-h detail">
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontFamily: "var(--font-code)" }}>加载中…</h2>
            <div className="sub">读取机器详情</div>
          </div>
          <button className="iconbtn x" onClick={close}>
            <Icon name="x" size={16} />
          </button>
        </div>
      </div>
    );
  }

  if (detail.error || !detail.data) {
    return (
      <div className="drawer drawer--detail">
        <div className="drawer-h detail">
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontFamily: "var(--font-code)" }}>无法加载</h2>
            <div className="sub">
              {detail.error === "not-in-tauri" ? "未运行在 Tauri 宿主中" : "读取机器详情失败"}
            </div>
          </div>
          <button className="iconbtn x" onClick={close}>
            <Icon name="x" size={16} />
          </button>
        </div>
      </div>
    );
  }

  const m = detail.data.machine;
  const off = m.status === "offline";
  // 已入网 = 管理通道已探达（online）或本会话刚跑完入网脚本（enrolled）。
  const isEnrolled = m.status === "online" || enrolled.includes(id);
  const primaryUe =
    detail.data.ue_installs.find((u) => u.is_primary) ?? detail.data.ue_installs[0];
  const gpu = detail.data.gpus[0];

  // ⑤ 关联：该机 zen 端点 + 过滤出 host_machine_id==id 的共享。
  const zenRows = zen.data ?? [];
  const myShares = (shares.data ?? []).filter((s) => s.host_machine_id === id);
  const hasLinks = zenRows.length > 0 || myShares.length > 0;
  const gotoDdc = () => {
    setDrawer(null);
    setNav("ddc_zen");
  };

  return (
    <div className="drawer drawer--detail">
      <div className="drawer-h detail">
        <span className="di info">
          <Dot
            visual={
              m.status === "online" ? "positive" : m.status === "offline" ? "neutral" : "notice"
            }
          />
        </span>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontFamily: "var(--font-code)" }}>{m.hostname}</h2>
          <div className="sub">{ROLE_LABEL[m.role] ?? m.role}</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <StatusPill status={m.status} />
        </div>
        <button className="iconbtn x" onClick={close}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="drawer-b">
        {/* 入网（未入网时）—— SSH key 现场入网，获取脚本拷到目标机运行后回来刷新 */}
        {!isEnrolled ? (
          <div className="insp-sect">
            <div className="lh">入网</div>
            <div className="deploy-block">
              <Button
                variant="accent"
                size="M"
                icon={<Icon name="doc" size={14} />}
                onPress={() => setDrawer({ kind: "script", id })}
              >
                获取入网脚本
              </Button>
              <div className="deploy-ok-note">SSH key 现场入网 · 拷到目标机运行后回来刷新</div>
            </div>
          </div>
        ) : null}

        {/* ① 身份 */}
        <div className="insp-sect">
          <div className="lh">① 身份</div>
          <KV k="IP 地址" v={m.ip} mono />
          <KV k="角色" v={ROLE_LABEL[m.role] ?? m.role} />
          <KV k="最后在线" v={m.last_seen_at ?? "—"} />
        </div>

        {/* ② UE 安装 */}
        <div className="insp-sect">
          <div className="lh">② UE 安装</div>
          {detail.data.ue_installs.length === 0 ? (
            <div className="dim" style={{ fontSize: 12 }}>
              未发现 UE 安装
            </div>
          ) : (
            <>
              <KV k="版本" v={primaryUe?.version ?? "—"} />
              <KV k="安装路径" v={primaryUe?.install_path ?? "—"} mono />
            </>
          )}
        </div>

        {/* ③ GPU（入网后自动采集 · 已过滤虚拟适配器） */}
        <div className="insp-sect">
          <div className="lh">③ GPU（入网后自动采集 · 已过滤虚拟适配器）</div>
          {!gpu ? (
            <div className="dim" style={{ fontSize: 12 }}>
              未采集到 GPU 信息
            </div>
          ) : (
            <>
              <KV k="型号" v={gpu.gpu_model} />
              <KV k="驱动" v={gpu.driver_version} mono />
              <KV k="显存" v={gpu.vram_mb != null ? gpu.vram_mb + " MB" : "—"} />
              <KV k="厂商" v={VENDOR_LABEL[gpu.vendor] ?? gpu.vendor} />
            </>
          )}
        </div>

        {/* ④ 入网账户（SSH key · 现场入网）—— 全栈统一 SSH key，无逐机密码 */}
        <div className="insp-sect">
          <div className="lh">④ 入网账户（SSH key · 现场入网）</div>
          <KV k="认证方式" v="SSH 公钥" />
          <KV k="入网脚本" v="enable-ssh.ps1" mono />
          <KV k="公钥标识" v="uecm-operator" mono />
        </div>

        {/* ⑤ 关联（自动发现：zen 端点 + 共享 DDC；点击跳 DDC 页） */}
        <div className="insp-sect">
          <div className="lh">⑤ 关联（自动发现）</div>
          <div className="rev-links">
            {zenRows.map((z) => (
              <span key={z.endpoint_id} className="rev" onClick={gotoDdc}>
                <Icon name="cube" size={13} />
                {`ZenServer :${z.declared_port} · ${z.role}`}
              </span>
            ))}
            {myShares.map((s) => (
              <span key={s.id ?? s.share_name} className="rev" onClick={gotoDdc}>
                <Icon name="folder" size={13} />
                {`共享 DDC · ${s.share_name}`}
              </span>
            ))}
            {!hasLinks ? (
              <span className="dim" style={{ fontSize: 12 }}>
                无关联资源
              </span>
            ) : null}
          </div>
          {/* 项目反查无反向命令：项目关联见 DDC PAK 页 */}
          <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
            项目关联见 DDC PAK 页
          </div>
        </div>

        {/* ⑥ 已读到的 DDC 相关配置 —— 环境变量 + 项目 DefaultEngine.ini，非有效配置解析 */}
        {!off ? (
          <div className="insp-sect">
            <div className="lh ddc-scan-h">
              <span className="ddc-scan-title">⑥ 已读到的 DDC 相关配置</span>
              <button
                className="mini-btn ddc-rescan"
                disabled={readQ.loading}
                onClick={() => readQ.reload()}
              >
                <Icon name="search" size={12} />
                重新读取
              </button>
            </div>
            <div className="ddc-read-note">
              <Icon name="eye" size={12} />
              这是从这台机器读到的配置，不是有效配置解析。
            </div>
            {readQ.error ? (
              <div className="dim" style={{ fontSize: 12 }}>
                {readQ.error === "not-in-tauri" ? "需在 Volo 桌面应用内读取" : "读取失败 · 机器可能不可达"}
              </div>
            ) : readQ.loading && !readQ.data ? (
              <div className="dim" style={{ fontSize: 12 }}>
                读取中…
              </div>
            ) : readQ.data ? (
              <>
                <div className="ddc-read-row">
                  <div className="ddc-read-h">
                    <span className="ddc-read-k">① 环境变量</span>
                    <code className="ddc-tfile">系统环境变量</code>
                  </div>
                  <KV k="本地缓存路径" v={readQ.data.local || "未设"} mono />
                  <KV k="共享缓存路径" v={readQ.data.shared || "未设"} mono />
                </div>
                <div className={"ddc-read-row" + (readQ.data.ini.ok ? "" : " miss")}>
                  <div className="ddc-read-h">
                    <span className="ddc-read-k">② 项目配置</span>
                    <code className="ddc-tfile">DefaultEngine.ini</code>
                  </div>
                  <div className={"ddc-read-val mono" + (readQ.data.ini.ok ? "" : " empty")}>
                    {readQ.data.ini.val}
                  </div>
                  <div className={"ddc-read-sub" + (readQ.data.ini.ok ? "" : " warn")}>
                    {readQ.data.ini.note}
                  </div>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="drawer-f between">
        <Button
          variant="secondary"
          size="M"
          icon={<Icon name="search" size={14} />}
          isDisabled={off}
          onPress={() => {
            close();
            runTask({
              domain: "machine",
              action: "refresh",
              target: m.hostname,
              chan: "ssh",
              note: "探 UE / GPU / last-seen",
              lines: [
                { msg: `refresh ${m.hostname} …` },
                { lv: "ok", msg: "已更新 UE 安装与 GPU 信息" },
              ],
              run: async () => {
                await refreshMachine(id);
                reloadMachines();
              },
            });
          }}
        >
          刷新
        </Button>
        <Button
          variant="negative"
          size="M"
          icon={<Icon name="trash" size={14} />}
          onPress={() =>
            openPreview({
              title: "删除机器 · " + m.hostname,
              icon: "trash",
              cli: "machine delete",
              destructive: true,
              channel: "ssh",
              confirmInput: true,
              steps: [
                "从集群中移除机器 " + m.hostname,
                "解除它与共享缓存、ZenServer 的关联",
                "清除已保存的这台机器的登录凭据",
              ],
              // 用 simpleScope 而非 scope:[id]：删除是本地移除，离线机也应可删
              //（scope:[id] 下离线机被 predict 判为 skip → willApply 0 → 确认按钮被禁用）。
              simpleScope: [{ host: m.hostname, ip: m.ip, msg: "从集群移除" }],
              task: {
                domain: "machine",
                action: "delete",
                target: m.hostname,
                chan: "ssh",
                note: "已从集群移除",
                lines: [
                  { lv: "warn", msg: `删除 ${m.hostname} … 解除关联` },
                  { lv: "ok", msg: `${m.hostname} 已移除` },
                ],
                run: async () => {
                  await deleteMachine(id);
                  reloadMachines();
                },
              },
              onConfirm: () => setDrawer(null),
            })
          }
        >
          删除机器
        </Button>
      </div>
    </div>
  );
}
