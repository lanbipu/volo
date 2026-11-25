/* 集群 › 缓存（设计：Cache / CachePak / CacheLegacy）。三个页签：Zen / PAK 预置包 / 共享目录（旧版）。
   对象页签 zen:settings = Zen 服务器设置（CacheZenSettings）。 */
import { useRef, useState, type ReactNode } from "react";
import { copyText } from "@/lib/clipboard";
import { useActiveObject, useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN } from "@/lib/nav";
import { errText, toast } from "@/lib/toast";
import {
  Button,
  ConfirmDialog,
  Crumbs,
  Empty,
  GroupRow,
  HeadRow,
  IconButton,
  Inspector,
  InspectorBody,
  InspectorHead,
  InspectorToggle,
  Menu,
  MenuItem,
  Note,
  Props,
  Row,
  RowEnd,
  RowTitle,
  Sep,
  Spacer,
  Status,
  Table,
  TableBody,
  Tag,
  Toolbar,
  ToolTabs,
  Workspace,
  type StatusKind,
} from "@/ui";
import {
  CHANNEL_LABEL,
  chanValue,
  effective,
  gb,
  isSet,
  LEGACY_ORDER,
  legacyRows,
  useChannelReads,
  useShares,
  useZenProbe,
  useZenServer,
  useZenService,
  useZenUsage,
  ZEN_ORDER,
  zenRows,
  type LegacyGroup,
  type LegacyRow,
  type MachineRead,
  type PointScope,
  type PointState,
  type ZenRow,
  type ZenServer,
} from "../model/cache";
import { useClusterUi, type CacheTab } from "../model/clusterUi";
import { fmtFull, fmtTime } from "../model/machines";
import { PAK_GROUP_LABEL, pakView, useDeletePak, useDistributePak, useGeneratePak, usePakEvents, type PakGroup, type PakView } from "../model/pak";
import { humanBytes, projectTab, useProjects } from "../model/projects";
import { machineTab } from "./MachinesPage";
import { ZenPointDialog } from "./ZenPointDialog";
import { ZenSettings, ZEN_SETTINGS_TAB } from "./ZenSettings";
import base from "./cache.module.css";
import css from "./cachePage.module.css";

export function CachePage() {
  const active = useActiveObject("cache");
  const tab = useClusterUi((s) => s.cacheTab);
  if (active === ZEN_SETTINGS_TAB.id) return <ZenSettings />;
  if (tab === "pak") return <PakTab />;
  if (tab === "legacy") return <LegacyTab />;
  return <ZenTab />;
}

/* ------------------------------- 公共片段 ------------------------------- */

function CacheTabs({ children }: { children?: ReactNode }) {
  const tab = useClusterUi((s) => s.cacheTab);
  const setTab = useClusterUi((s) => s.setCacheTab);
  return (
    <div className="ry-detail__tools">
      <ToolTabs<CacheTab>
        label="缓存方式"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "zen", label: "Zen" },
          { key: "pak", label: "PAK 预置包" },
          { key: "legacy", label: "共享目录（旧版）" },
        ]}
      />
      {children && (
        <>
          <Spacer />
          {children}
        </>
      )}
    </div>
  );
}

function DetailHead({ title, meta, children }: { title: string; meta: ReactNode; children?: ReactNode }) {
  return (
    <div className={`ry-detail ${base.detailTop}`}>
      <div className={`ry-detail__head ${base.detailHead}`}>
        <h1 className="ry-detail__title">{title}</h1>
        <div className="ry-detail__meta">{meta}</div>
      </div>
      {children}
    </div>
  );
}

const hhmmss = (ms: number | null) => (ms ? new Date(ms).toLocaleTimeString("zh-CN", { hour12: false }) : "—");
const msTime = (ms: number | null) => (ms ? fmtTime(new Date(ms).toISOString()) : "—");
const msFull = (ms: number | null) => (ms ? fmtFull(new Date(ms).toISOString()) : null);

function CmdValue({ command }: { command: string }) {
  return <span className="ry-mono">{command}</span>;
}
const copyAction = (command: string) => <IconButton size="sm" icon="copy" label="复制等效命令" onClick={() => copyText(command)} />;

function useOpenMachine() {
  const openObject = useNav((s) => s.openObject);
  const go = useNav((s) => s.go);
  return (r: MachineRead) => {
    openObject("machines", machineTab(r.machine));
    go("machines");
  };
}

/* ---------------------------------- Zen ---------------------------------- */

const ZEN_COLS = "16px 88px minmax(180px, 1fr) max-content 84px 96px";
const POINT_STATUS: Record<PointState, [StatusKind, string]> = {
  pointed: ["success", "已指向"],
  elsewhere: ["attention", "指向别处"],
  none: ["queued", "未指向"],
  offline: ["offline", "离线"],
  unknown: ["failed", "读不到"],
};

function zenTitle(z: ZenRow, s: ZenServer): string {
  if (z.state === "offline") return "离线，上线后再确认";
  if (z.state === "unknown") return "读不到这台机器的配置";
  if (z.state === "none") return "没有指向 Zen";
  if (z.state === "pointed") return z.isServer ? "Zen · 本机" : `Zen · ${s.host}`;
  if (z.eff?.zen) {
    try {
      return `Zen · ${new URL(/^[a-z]+:\/\//i.test(z.eff.zen) ? z.eff.zen : `http://${z.eff.zen}`).hostname}`;
    } catch {
      return `Zen · ${z.eff.zen}`;
    }
  }
  return `共享目录 · ${z.eff?.share ?? "—"}`;
}

function ZenTab() {
  const { server, loading, error } = useZenServer();
  const { reads, updatedAt } = useChannelReads();
  const { views } = useProjects();
  const usage = useZenUsage(server?.endpointId ?? null);
  const probe = useZenProbe();
  const svc = useZenService();
  const openObject = useNav((s) => s.openObject);
  const [inspOpen, setInsp] = useInspector("cache:zen");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const [sel, setSel] = useState<number | null>(null);
  const [stopAsk, setStopAsk] = useState(false);
  const [pointFor, setPointFor] = useState<{ ids: number[]; scope: PointScope } | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const { refetch: refetchReads } = useChannelReads();

  const rows = server ? zenRows(reads, server) : [];
  const clients = rows.filter((r) => !r.isServer);
  const own = rows.filter((r) => r.isServer);
  const ordered = [...clients, ...own];
  const selected = ordered.find((r) => r.r.id === sel) ?? ordered[0] ?? null;
  const pointedN = clients.filter((r) => r.state === "pointed").length;
  const running = server?.reachable === true;

  const toolbar = (
    <Toolbar loc label="位置与对象操作">
      <Crumbs icon="cache" current="缓存" />
      <Spacer />
      {server && (
        <>
          {running ? (
            <Button icon="stop" onClick={() => setStopAsk(true)}>
              停止服务
            </Button>
          ) : (
            <Button
              icon="play"
              busy={svc.isPending}
              onClick={() => svc.mutate({ endpointId: server.endpointId, stop: false }, { onSuccess: () => toast(`${server.host} 上的 Zen 已启动`), onError: (e) => toast(`启动失败：${errText(e)}`) })}
            >
              启动服务
            </Button>
          )}
          <Button
            icon="refresh"
            busy={probe.isPending}
            onClick={() => {
              probe.mutate(server.machineId, { onError: (e) => toast(`检测失败：${errText(e)}`) });
              refetchReads();
            }}
          >
            重新检测
          </Button>
          <IconButton ref={moreRef} icon="more" label="更多操作：服务器设置、重新部署、迁移到另一台机器、清空缓存" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)} />
          {moreOpen && (
            <Menu anchor={moreRef} onClose={() => setMoreOpen(false)} label="更多操作" alignEnd>
              <MenuItem onSelect={() => (setMoreOpen(false), openObject("cache", ZEN_SETTINGS_TAB))}>服务器设置</MenuItem>
              <MenuItem disabled onSelect={() => undefined}>
                重新部署
              </MenuItem>
              <MenuItem disabled onSelect={() => undefined}>
                迁移到另一台机器
              </MenuItem>
              <MenuItem danger disabled onSelect={() => undefined}>
                清空缓存
              </MenuItem>
            </Menu>
          )}
        </>
      )}
      <Sep />
      <InspectorToggle open={inspOpen} onChange={setInsp} />
    </Toolbar>
  );

  if (!server) {
    return (
      <main className="ry-main">
        {toolbar}
        <DetailHead title="Zen 缓存服务器" meta={<span>{loading ? "正在读取…" : "还没有部署"}</span>}>
          <CacheTabs />
        </DetailHead>
        {!loading && (
          <Empty icon="cache" title={error ? "读不到 Zen 服务器" : "还没有 Zen 缓存服务器"}>
            {error ? errText(error) : "在一台机器上部署 Zen 之后，这里会显示它的状态和指向它的客户端。"}
          </Empty>
        )}
      </main>
    );
  }

  const used = usage.data?.used ?? null;
  const total = usage.data?.total ?? null;
  const [stKind, stLabel]: [StatusKind, string] = running ? ["success", "运行中"] : server.reachable === false ? ["failed", "连不上"] : ["queued", "未检测"];

  const renderRow = (z: ZenRow) => {
    const [kind, label] = POINT_STATUS[z.state];
    return (
      <Row key={z.r.id} cols={ZEN_COLS} selected={selected === z} onSelect={() => setSel(z.r.id)} onOpen={() => setInsp(true)}>
        <Status kind={kind} label={label} srOnly />
        <span className="ry-mono">{z.r.host}</span>
        <RowTitle tags={z.overridden > 0 ? <Tag>有 {z.overridden} 条通道被覆盖</Tag> : undefined}>{zenTitle(z, server)}</RowTitle>
        <span>{z.eff ? <Tag flexNone={false}>{CHANNEL_LABEL[z.eff.key]}</Tag> : <span className={base.sec}>—</span>}</span>
        <RowEnd>—</RowEnd>
        <RowEnd>{msTime(z.r.at)}</RowEnd>
      </Row>
    );
  };

  return (
    <Workspace
      inspector={selected && <ZenInspector z={selected} server={server} width={inspW} onClose={() => setInsp(false)} onPoint={(scope) => setPointFor({ ids: [selected.r.id], scope })} />}
      inspectorOpen={inspOpen && !!selected}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      {toolbar}
      <DetailHead
        title="Zen 缓存服务器"
        meta={
          <>
            <Status kind={stKind} label={stLabel} pill />
            <span>
              部署在 <span className="ry-mono">{server.host}</span>
            </span>
            <span className="ry-mono">{server.url}</span>
            {server.version && <span>Zen {server.version}</span>}
          </>
        }
      >
        <CacheTabs />
        <div className={css.metrics}>
          <div className={css.metric}>
            <span className="ry-meta">命中率 · 近 24 小时</span>
            <span className={`ry-num ${css.metricValue}`}>—</span>
          </div>
          <div className={css.metric}>
            <span className="ry-meta">已用空间</span>
            <span className={`ry-num ${css.metricValue}`}>
              {gb(used)} {total != null && <span className={css.metricUnit}>/ {gb(total)} GB</span>}
              {total == null && used != null && <span className={css.metricUnit}>GB</span>}
            </span>
            {used != null && total != null && total > 0 && (
              <span className={`volo-meter__track ${css.meter}`} role="meter" aria-valuemin={0} aria-valuemax={total} aria-valuenow={used} aria-label="已用空间">
                <span className="volo-meter__bar" style={{ width: `${Math.min(100, (used / total) * 100)}%` }} />
              </span>
            )}
          </div>
          <div className={css.metric}>
            <span className="ry-meta">请求</span>
            <span className={`ry-num ${css.metricValue}`}>—</span>
          </div>
          <div className={css.metric}>
            <span className="ry-meta">指向它的机器</span>
            <span className={`ry-num ${css.metricValue}`}>
              {pointedN} <span className={css.metricUnit}>/ {clients.length} 台客户端</span>
            </span>
          </div>
        </div>
      </DetailHead>

      <Table label="客户端指向">
        <HeadRow cols={ZEN_COLS}>
          <span />
          <span>机器</span>
          <span>实际读写的缓存</span>
          <span>生效通道</span>
          <RowEnd>命中率</RowEnd>
          <RowEnd>上次确认</RowEnd>
        </HeadRow>
        <TableBody>
          {clients.length > 0 && <GroupRow label="客户端指向" count={clients.length} />}
          {clients.map(renderRow)}
          {own.length > 0 && <GroupRow label="服务器本机" count={own.length} />}
          {own.map(renderRow)}
        </TableBody>
      </Table>
      {!reads.length && updatedAt == null && <div className={base.pane}>正在逐台读取缓存配置…</div>}

      {stopAsk && (
        <ConfirmDialog
          title={`停止 ${server.host} 上的 Zen 服务？`}
          body="停止后，所有指向它的机器读不到共享缓存，会退回本机缓存或从头编译，直到再次启动。"
          props={[
            { label: "影响", value: <span className="ry-mono">{clients.filter((r) => r.state === "pointed").map((r) => r.r.host).join(" · ") || "—"}</span> },
            { label: "可恢复", value: "是，再启动服务即可" },
          ]}
          command={`voloctl zen service stop --endpoint-id ${server.endpointId} --yes`}
          onDryRun={() =>
            svc.mutate({ endpointId: server.endpointId, stop: true, dryRun: true }, { onSuccess: () => toast("试运行通过：没有做任何改动"), onError: (e) => toast(`试运行失败：${errText(e)}`) })
          }
          safeLabel="保持运行"
          dangerLabel="停止服务"
          dangerIcon="stop"
          busy={svc.isPending}
          onClose={() => setStopAsk(false)}
          onConfirm={() =>
            svc.mutate(
              { endpointId: server.endpointId, stop: true },
              { onSuccess: () => (setStopAsk(false), toast(`${server.host} 上的 Zen 已停止`)), onError: (e) => toast(`停止失败：${errText(e)}`) },
            )
          }
        />
      )}
      {pointFor && (
        <ZenPointDialog server={server} machines={reads.filter((r) => pointFor.ids.includes(r.id))} projects={views} initialScope={pointFor.scope} onClose={() => setPointFor(null)} />
      )}
    </Workspace>
  );
}

function ZenInspector({ z, server, width, onClose, onPoint }: { z: ZenRow; server: ZenServer; width: number; onClose: () => void; onPoint: (scope: PointScope) => void }) {
  const [tab, setTab] = useState<"chan" | "cred" | "activity">("chan");
  const openMachine = useOpenMachine();
  const [kind, label] = POINT_STATUS[z.state];
  const pill = z.state === "pointed" ? "已指向 Zen" : label;
  const shareBelow = z.eff?.zen ? ZEN_ORDER.map((k) => z.r.channels[k]).find((c) => c !== z.eff && !!c.share && !c.unread) : undefined;
  const cmd = `voloctl env get --host ${z.r.machine.ip || z.r.host} --name UE-ZenSharedDataCacheHost`;
  return (
    <Inspector width={width}>
      <InspectorHead
        onClose={onClose}
        tabs={
          <ToolTabs
            label="Inspector 内容"
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "chan", label: "通道" },
              { key: "cred", label: "凭据" },
              { key: "activity", label: "活动" },
            ]}
          />
        }
        meta={
          <>
            <span>缓存指向</span>
            <Status kind={kind} label={pill} pill size="sm" />
          </>
        }
        title={z.r.host}
        actions={
          <>
            <Button icon="open" kbd="↵" onClick={() => openMachine(z.r)}>
              打开机器
            </Button>
            <Button disabled={z.r.offline} onClick={() => onPoint("project")}>
              重新写入
            </Button>
          </>
        }
      />
      <InspectorBody>
        {tab === "chan" && (
          <>
            <h3 className={css.chanTitle}>配置通道 · 从上到下优先级递减</h3>
            <ol className={css.chanList}>
              {ZEN_ORDER.map((k, i) => {
                const c = z.r.channels[k];
                const on = c === z.eff;
                const v = chanValue(c);
                return (
                  <li key={k} className={`${css.chan} ${on ? css.chanOn : ""}`}>
                    <span className={`ry-num ${css.chanNum}`}>{i + 1}</span>
                    <span className={css.chanName}>{CHANNEL_LABEL[k]}</span>
                    {z.r.offline || c.unread ? (
                      <span className="ry-meta">—</span>
                    ) : on ? (
                      <Status kind="success" label="当前生效" size="sm" />
                    ) : isSet(c) ? (
                      <Status kind="attention" label="被覆盖" size="sm" />
                    ) : (
                      <span className="ry-meta">未设置</span>
                    )}
                    {v && !z.r.offline && (
                      <>
                        <span />
                        <span className={`ry-mono ${css.chanValue}`}>{v}</span>
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
            {shareBelow && (
              <Note
                kind="attention"
                icon="attention"
                style={{ marginTop: 16 }}
                actions={
                  <Button onClick={() => onPoint("project")} disabled={z.r.offline}>
                    把工程配置也改为 Zen
                  </Button>
                }
              >
                <p>
                  {CHANNEL_LABEL[shareBelow.key]}里还是旧版共享目录。{z.eff ? CHANNEL_LABEL[z.eff.key] : ""}一旦被移除，这台机器会退回共享目录。
                </p>
              </Note>
            )}
            <Props
              className={css.propsGap}
              items={[
                { label: "命中率", value: "—" },
                { label: "凭据", value: "不需要 · Zen 走 HTTP" },
                { label: "确认于", value: msFull(z.r.at) ? <span className="ry-num">{msFull(z.r.at)}</span> : null },
                { label: "命令", value: <CmdValue command={cmd} />, action: copyAction(cmd) },
              ]}
            />
          </>
        )}
        {tab === "cred" && (
          <Props
            items={[
              { label: "读写缓存", value: "不需要 · Zen 走 HTTP" },
              { label: "读写配置", value: "SSH 密钥，不需要单独的凭据" },
              { label: "指向", value: <span className="ry-mono">{server.url}</span> },
            ]}
          />
        )}
        {tab === "activity" && (
          <Empty icon="clock" title="还没有活动记录">
            这台机器的缓存指向改动接入记录后会显示在这里。
          </Empty>
        )}
      </InspectorBody>
    </Inspector>
  );
}

/* ---------------------------------- PAK ---------------------------------- */

const PAK_COLS = "16px 132px minmax(180px, 1fr) 88px 110px 110px";
const PAK_ORDER: PakGroup[] = ["partial", "none", "all"];

function PakTab() {
  const { views, fetching, updatedAt, refetch } = useProjects();
  usePakEvents();
  const pakProjectId = useClusterUi((s) => s.pakProjectId);
  const focusPak = useClusterUi((s) => s.focusPak);
  const [inspOpen, setInsp] = useInspector("cache:pak");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const gen = useGeneratePak();
  const paks = views.map(pakView);
  const ordered = PAK_ORDER.flatMap((g) => paks.filter((p) => p.group === g));
  const selected = ordered.find((p) => p.v.id === pakProjectId) ?? ordered[0] ?? null;

  const generate = (p: PakView) => {
    const src = p.source && !p.source.offline ? p.source : p.v.copies.find((c) => !c.offline);
    if (!src) return toast(`${p.v.name} 没有在线的机器可以生成`);
    gen.mutate({ v: p.v, sourceMachineId: src.loc.machine_id }, { onSuccess: (r) => toast(`已开始在 ${src.host} 上生成 ${p.v.name} 的 PAK · 任务 ${r.job_id}`), onError: (e) => toast(`生成失败：${errText(e)}`) });
  };

  return (
    <Workspace
      inspector={selected && <PakInspector p={selected} width={inspW} onClose={() => setInsp(false)} onGenerate={() => generate(selected)} />}
      inspectorOpen={inspOpen && !!selected}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      <Toolbar loc label="位置与对象操作">
        <Crumbs icon="cache" current="缓存" />
        <Spacer />
        <Button variant="primary" icon="file" disabled={!selected || gen.isPending} onClick={() => selected && generate(selected)}>
          生成 PAK
        </Button>
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>
      <DetailHead title="PAK 预置包" meta={<span>把一个工程编译好的缓存打成一个文件，放在工程目录里跟着走。Zen 连不上或新机器第一次打开时，不用从头编译。</span>}>
        <CacheTabs>
          <IconButton icon="refresh" disabled={fetching} label={`重新检查各机器上的 PAK · 上次 ${hhmmss(updatedAt)}`} onClick={refetch} />
        </CacheTabs>
      </DetailHead>
      {ordered.length ? (
        <Table label="各工程的 PAK 预置包">
          <TableBody>
            <HeadRow cols={PAK_COLS}>
              <span />
              <span>工程</span>
              <span>状况</span>
              <RowEnd>大小</RowEnd>
              <span>源机器</span>
              <RowEnd>生成于</RowEnd>
            </HeadRow>
            {PAK_ORDER.map((g) => {
              const list = paks.filter((p) => p.group === g);
              if (!list.length) return null;
              return [
                <GroupRow key={`g-${g}`} label={PAK_GROUP_LABEL[g]} count={list.length} />,
                ...list.map((p) => (
                  <Row key={p.v.id} cols={PAK_COLS} selected={selected === p} onSelect={() => focusPak(p.v.id)} onOpen={() => setInsp(true)}>
                    <Status kind={g === "all" ? "success" : "queued"} label={g === "all" ? "就绪" : "未开始"} srOnly size="sm" />
                    <span className={`ry-row__id ${base.idPrimary}`}>{p.v.name}</span>
                    <RowTitle>{p.text}</RowTitle>
                    <RowEnd>{p.source?.pak ? humanBytes(p.source.pak.size_bytes) : "—"}</RowEnd>
                    <span className={base.sec}>{p.source?.host ?? "—"}</span>
                    <RowEnd>{fmtTime(p.source?.pak?.modified_at ?? null)}</RowEnd>
                  </Row>
                )),
              ];
            })}
          </TableBody>
        </Table>
      ) : (
        <Empty icon="project" title="还没有工程">
          先在“工程”里扫描到工程，才能为它生成 PAK。
        </Empty>
      )}
    </Workspace>
  );
}

function PakInspector({ p, width, onClose, onGenerate }: { p: PakView; width: number; onClose: () => void; onGenerate: () => void }) {
  const [tab, setTab] = useState<"detail" | "activity">("detail");
  const openObject = useNav((s) => s.openObject);
  const go = useNav((s) => s.go);
  const dist = useDistributePak();
  const del = useDeletePak();
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [delFor, setDelFor] = useState<{ id: number; host: string } | null>(null);
  const v = p.v;
  const src = p.source;
  const hasPak = !!src?.pak;
  const targets = p.missing.map((c) => c.loc.machine_id);
  const cmd = src ? `voloctl ddc distribute --project-id ${v.id} --source-machine ${src.loc.machine_id} --targets ${targets.join(",") || "<机器>"} --yes` : "—";
  const ready = p.group === "all";
  const distribute = () =>
    src &&
    dist.mutate(
      { projectId: v.id, sourceMachineId: src.loc.machine_id, targets },
      { onSuccess: (r) => toast(`已开始分发 ${v.name} 的 PAK 到 ${r.plan.length} 台 · 任务 ${r.job_id}`), onError: (e) => toast(`分发失败：${errText(e)}`) },
    );
  const sorted = [...v.copies].sort((a, b) => (a === src ? -1 : b === src ? 1 : Number(a.offline) - Number(b.offline) || a.host.localeCompare(b.host, "zh-CN", { numeric: true })));

  return (
    <Inspector width={width}>
      <InspectorHead
        onClose={onClose}
        tabs={
          <ToolTabs
            label="Inspector 内容"
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "detail", label: "详情" },
              { key: "activity", label: "活动" },
            ]}
          />
        }
        meta={
          <>
            <span>PAK 预置包</span>
            <Status kind={ready ? "success" : "queued"} label={ready ? "就绪" : "未开始"} pill size="sm" />
          </>
        }
        title={v.name}
        actions={
          <>
            {hasPak && (
              <Button variant="primary" disabled={!targets.length || dist.isPending} onClick={distribute}>
                {targets.length ? `分发到 ${targets.length} 台` : "都已分发"}
              </Button>
            )}
            <Button icon="refresh" variant={hasPak ? "default" : "primary"} onClick={onGenerate}>
              {hasPak ? "重新生成" : "生成 PAK"}
            </Button>
            <IconButton ref={moreRef} icon="more" label="更多操作：打开工程、删除 PAK" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)} />
            {moreOpen && (
              <Menu anchor={moreRef} onClose={() => setMoreOpen(false)} label="更多操作" alignEnd>
                <MenuItem onSelect={() => (setMoreOpen(false), openObject("projects", projectTab(v.raw)), go("projects"))}>打开工程</MenuItem>
                {v.copies
                  .filter((c) => c.pak && !c.offline)
                  .map((c) => (
                    <MenuItem key={c.loc.machine_id} danger onSelect={() => (setMoreOpen(false), setDelFor({ id: c.loc.machine_id, host: c.host }))}>
                      删除 {c.host} 上的 PAK
                    </MenuItem>
                  ))}
              </Menu>
            )}
          </>
        }
      />
      <InspectorBody>
        {tab === "detail" ? (
          <>
            <h3 className={`volo-fields__title ${css.pakTitle}`}>哪些机器上有</h3>
            <ul className={base.copyList}>
              {sorted.map((c) => (
                <li key={c.loc.machine_id} className={base.copyItem}>
                  {c.offline ? <Status kind="offline" label="离线" srOnly size="sm" /> : c.pak ? <Status kind="success" label="就绪" srOnly size="sm" /> : <Status kind="queued" label="未开始" srOnly size="sm" />}
                  <span className={base.idPrimary}>{c.host}</span>
                  <span className={base.copyMain}>
                    {c.offline ? (
                      <>
                        <span className={base.copyPath}>离线</span>
                        <span className={`ry-meta ${css.wrapMeta}`}>上线后再分发一次</span>
                      </>
                    ) : c.pak ? (
                      <>
                        <span className={`ry-mono ${base.copyPath}`}>{c.pak.pak_path}</span>
                        <span className={`ry-meta ${css.wrapMeta}`}>
                          {c === src ? "在这台生成 · " : ""}
                          {humanBytes(c.pak.size_bytes)}
                        </span>
                      </>
                    ) : (
                      <span className={base.copyPath}>还没有</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <Props
              items={[
                { label: "生成于", value: src?.pak?.modified_at ? <span className="ry-num">{fmtFull(src.pak.modified_at)}</span> : null },
                { label: "分发方式", value: `从 ${src?.host ?? "源机器"} 经 SSH 复制到各机器的工程目录。目标机上已有同样大小的文件就跳过。` },
                { label: "删除", value: "只删这台机器上的文件，别的机器上的副本不动。" },
                { label: "命令", value: <CmdValue command={cmd} />, action: src ? copyAction(cmd) : undefined },
              ]}
            />
          </>
        ) : (
          <Empty icon="clock" title="还没有活动记录">
            生成与分发记录接入后会显示在这里。
          </Empty>
        )}
      </InspectorBody>
      {delFor && (
        <ConfirmDialog
          title={`删除 ${delFor.host} 上 ${v.name} 的 PAK？`}
          body="只删这台机器工程目录里的 DDC.ddp，别的机器上的副本不动。删掉之后，这台机器在 Zen 连不上时要从头编译。"
          props={[
            { label: "影响", value: <span className="ry-mono">{delFor.host}</span> },
            { label: "可恢复", value: "是，重新分发或生成即可" },
          ]}
          safeLabel="保留"
          dangerLabel="删除 PAK"
          dangerIcon="close"
          busy={del.isPending}
          onClose={() => setDelFor(null)}
          onConfirm={() =>
            del.mutate({ projectId: v.id, machineId: delFor.id }, { onSuccess: () => (setDelFor(null), toast(`已删除 ${delFor.host} 上的 PAK`)), onError: (e) => toast(`删除失败：${errText(e)}`) })
          }
        />
      )}
    </Inspector>
  );
}

/* ------------------------------ 共享目录（旧版） ------------------------------ */

const LEGACY_COLS = "16px 96px minmax(200px, 1fr) 150px 110px 92px";
const LEGACY_GROUPS: [LegacyGroup, string][] = [
  ["host", "提供共享的机器"],
  ["configured", "配置里还写着它的机器"],
  ["clean", "已经不用它的机器"],
  ["offline", "离线的机器"],
];

function legacyStatus(l: LegacyRow): [StatusKind, string] {
  if (l.group === "offline") return l.r.offline ? ["offline", "离线"] : ["failed", "读不到"];
  if (l.group === "configured") return ["attention", "已过期"];
  return ["success", "就绪"];
}

function legacyTitle(l: LegacyRow): ReactNode {
  if (l.group === "host" && l.share)
    return (
      <span className={`ry-mono ${css.monoSec}`}>
        {l.share.unc_path}
      </span>
    );
  if (l.group === "offline") return l.r.offline ? "离线，上线后再确认" : "读不到这台机器的配置";
  if (l.group === "clean") return "没有任何一处写着共享目录";
  return l.shadowedBy ? `写着，但没在用：被指向 Zen 的${CHANNEL_LABEL[l.shadowedBy.key]}盖住了` : "在用共享目录";
}

function LegacyTab() {
  const { reads, fetching, updatedAt, refetch } = useChannelReads();
  const shares = useShares();
  const { server } = useZenServer();
  const { views } = useProjects();
  const [inspOpen, setInsp] = useInspector("cache:legacy");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const [sel, setSel] = useState<number | null>(null);
  const [pointFor, setPointFor] = useState<number | null>(null);
  const rows = legacyRows(reads, shares.data ?? []);
  const ordered = LEGACY_GROUPS.flatMap(([g]) => rows.filter((r) => r.group === g));
  const selected = ordered.find((r) => r.r.id === sel) ?? ordered.find((r) => r.group === "configured") ?? ordered[0] ?? null;

  return (
    <Workspace
      inspector={selected && <LegacyInspector l={selected} canPoint={!!server} width={inspW} onClose={() => setInsp(false)} onPoint={() => setPointFor(selected.r.id)} />}
      inspectorOpen={inspOpen && !!selected}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      <Toolbar loc label="位置与对象操作">
        <Crumbs icon="cache" current="缓存" />
        <Spacer />
        <Button icon="plus" disabled title="新建共享的对话框还没有设计稿">
          新建共享…
        </Button>
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>
      <DetailHead title="共享目录（旧版）" meta={<span>用一个网络共享文件夹当缓存。Zen 可用时不需要它，这一页留给还没迁完的机器，目标是让下面两组变空。</span>}>
        <CacheTabs>
          <IconButton icon="refresh" disabled={fetching} label={`重新读取各机器的配置 · 上次 ${hhmmss(updatedAt)}`} onClick={refetch} />
        </CacheTabs>
      </DetailHead>
      <Table label="共享目录的使用情况">
        <TableBody>
          <HeadRow cols={LEGACY_COLS}>
            <span />
            <span>机器</span>
            <span>情况</span>
            <span>写在哪里</span>
            <span>凭据</span>
            <RowEnd>上次确认</RowEnd>
          </HeadRow>
          {LEGACY_GROUPS.map(([g, label]) => {
            const list = rows.filter((r) => r.group === g);
            if (!list.length) return null;
            return [
              <GroupRow key={`g-${g}`} label={label} count={list.length} />,
              ...list.map((l) => {
                const [kind, st] = legacyStatus(l);
                const where = l.group === "host" ? l.share?.local_path : l.where.map((c) => CHANNEL_LABEL[c.key]).join("、");
                const cred = l.group === "host" ? (l.share?.mode === "open" ? "不需要 · 来宾访问" : (l.share?.credential_alias ?? "—")) : "—";
                return (
                  <Row key={l.r.id} cols={LEGACY_COLS} selected={selected === l} onSelect={() => setSel(l.r.id)} onOpen={() => setInsp(true)}>
                    <Status kind={kind} label={st} srOnly size="sm" />
                    <span className={`ry-row__id ${base.idPrimary}`}>{l.r.host}</span>
                    <RowTitle>{legacyTitle(l)}</RowTitle>
                    <span className={`${base.sec} ${l.group === "host" ? "ry-mono" : ""}`}>{where || "—"}</span>
                    <span className={base.sec}>{cred}</span>
                    <RowEnd>{msTime(l.r.at)}</RowEnd>
                  </Row>
                );
              }),
            ];
          })}
        </TableBody>
      </Table>
      {pointFor != null && server && (
        <ZenPointDialog server={server} machines={reads.filter((r) => r.id === pointFor)} projects={views} initialScope="project" onClose={() => setPointFor(null)} />
      )}
    </Workspace>
  );
}

function LegacyInspector({ l, canPoint, width, onClose, onPoint }: { l: LegacyRow; canPoint: boolean; width: number; onClose: () => void; onPoint: () => void }) {
  const [tab, setTab] = useState<"cfg" | "activity">("cfg");
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [kind, st] = legacyStatus(l);
  const eff = effective(l.r, LEGACY_ORDER);
  const cmd = `voloctl env get --host ${l.r.machine.ip || l.r.host} --name UE-SharedDataCachePath`;
  const projects = l.r.channels.project.projects ?? [];
  return (
    <Inspector width={width}>
      <InspectorHead
        onClose={onClose}
        tabs={
          <ToolTabs
            label="Inspector 内容"
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "cfg", label: "配置" },
              { key: "activity", label: "活动" },
            ]}
          />
        }
        meta={
          <>
            <span>共享目录 · 旧版</span>
            <Status kind={kind} label={st} pill size="sm" />
          </>
        }
        title={l.r.host}
        actions={
          l.group === "configured" ? (
            <>
              <Button variant="primary" disabled={!canPoint} onClick={onPoint}>
                把工程配置改为 Zen
              </Button>
              <IconButton ref={moreRef} icon="more" label="更多操作：清除这台机器上的全部旧版配置、重新加入共享" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)} />
              {moreOpen && (
                <Menu anchor={moreRef} onClose={() => setMoreOpen(false)} label="更多操作" alignEnd>
                  <MenuItem danger disabled onSelect={() => undefined}>
                    清除这台机器上的全部旧版配置
                  </MenuItem>
                  <MenuItem disabled onSelect={() => undefined}>
                    重新加入共享
                  </MenuItem>
                </Menu>
              )}
            </>
          ) : undefined
        }
      />
      <InspectorBody>
        {tab === "activity" ? (
          <Empty icon="clock" title="还没有活动记录">
            这台机器的共享目录配置改动接入记录后会显示在这里。
          </Empty>
        ) : l.group === "host" && l.share ? (
          <Props
            items={[
              { label: "共享", value: <span className="ry-mono">{l.share.unc_path}</span> },
              { label: "本地目录", value: <span className="ry-mono">{l.share.local_path}</span> },
              { label: "访问方式", value: l.share.mode === "open" ? "来宾访问，不需要凭据" : "专用账户访问" },
              { label: "凭据", value: l.share.credential_alias ?? null },
              { label: "命令", value: <CmdValue command="voloctl share list" />, action: copyAction("voloctl share list") },
            ]}
          />
        ) : (
          <>
            {l.shadowedBy && (
              <Note kind="attention" icon="attention">
                <p>
                  {l.where.map((c) => CHANNEL_LABEL[c.key]).join("、")}里还写着共享目录。现在不生效，但指向 Zen 的{CHANNEL_LABEL[l.shadowedBy.key]}一旦被移除，这台机器会退回共享目录。
                </p>
              </Note>
            )}
            <h3 className={`volo-fields__title ${css.legacyTitle}`}>这台机器上四处配置 · 上面的盖住下面的</h3>
            <ol className={css.legacyList}>
              {LEGACY_ORDER.map((k, i) => {
                const c = l.r.channels[k];
                const v = chanValue(c);
                const kindText = c.zen ? "指向 Zen" : "共享目录";
                return (
                  <li key={k} className={css.legacyItem}>
                    <span className={`ry-num ${css.chanNum}`}>{i + 1}</span>
                    <span className={css.legacyName}>{CHANNEL_LABEL[k]}</span>
                    <span className={base.copyMain}>
                      {l.r.offline || c.unread ? (
                        <span>—</span>
                      ) : v ? (
                        <>
                          <span>
                            {kindText} · {c === eff ? "当前生效" : "被盖住"}
                          </span>
                          <span className={`ry-mono ${css.legacyValue}`}>{v}</span>
                        </>
                      ) : (
                        <span>没有设置</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
            <Props
              items={[
                { label: "工程", value: projects.length ? `${projects.join("、")} 的配置里${projects.length > 1 ? "都" : ""}写着` : null },
                { label: "凭据", value: null },
                { label: "命令", value: <CmdValue command={cmd} />, action: copyAction(cmd) },
              ]}
            />
          </>
        )}
      </InspectorBody>
    </Inspector>
  );
}

