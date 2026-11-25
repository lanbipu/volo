/* 舞台 LED · 上屏（设计：Output.dc.html；编辑拓扑：OutputTopology.dc.html，对象页签 output:topology）。
   目标 = nDisplay 集群：预检 → 部署 → 黑场待机 → 切测试图；本机显示器：把选中屏幕的测试图全屏放到这台电脑的副屏。 */
import { useMemo, useState } from "react";
import type { Machine, OutputNode } from "@/api/types";
import { useActiveObject, useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN } from "@/lib/nav";
import { errText, toast } from "@/lib/toast";
import {
  Activity,
  Button,
  Chip,
  Crumbs,
  Empty,
  Group,
  HeadRow,
  Icon,
  Inspector,
  InspectorBody,
  InspectorHead,
  InspectorToggle,
  Meta,
  Note,
  Props,
  Row,
  RowTitle,
  Seg,
  Sep,
  Spacer,
  Status,
  Table,
  TableBody,
  Toolbar,
  ToolTabs,
  Workspace,
  type StatusKind,
} from "@/ui";
import { machineTab, useMachineList } from "@/features/cache";
import { composite, machineFor, nodeScreens, rectOf, RENDER_SYNC_LABEL, resolveTopology, runPreflight, showPicture, startOutput, stopOutput, useOutputRuntime, useOutputSession, type NodeRun, type Picture } from "../model/output";
import { currentRun, playPatternLocal, stopPatternLocal, useLedStage, usePatterns, useRuns } from "../model/screens";
import { TopologyEditor, TOPOLOGY_TAB } from "./TopologyEditor";
import css from "./led.module.css";

const COLS = "16px 72px minmax(120px, 1fr) 96px 132px 110px 96px";
const PIC_LABEL: Record<Picture, string> = { black: "黑场", pattern: "测试图", sequence: "结构光序列" };
const hhmmss = (t: number | null) => (t ? new Date(t).toLocaleTimeString("zh-CN", { hour12: false }) : null);

type Target = "cluster" | "local";

interface NodeView {
  n: OutputNode;
  m: Machine | null;
  screens: string[];
  kind: StatusKind;
  label: string;
}

export function OutputPage() {
  const active = useActiveObject("output");
  if (active === TOPOLOGY_TAB.id) return <TopologyEditor />;
  return <OutputMain />;
}

function OutputMain() {
  const { stage, config, loading } = useLedStage();
  const path = stage?.path ?? null;
  const topo = useMemo(() => resolveTopology(config), [config]);
  useOutputRuntime(path, config, topo);
  const sess = useOutputSession();
  const machines = useMachineList();
  const runs = useRuns(path);
  const patterns = usePatterns(path);
  const openObject = useNav((s) => s.openObject);
  const [inspOpen, setInsp] = useInspector("output");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const [target, setTarget] = useState<Target>("cluster");
  const [selId, setSelId] = useState<string | null>(null);
  const [local, setLocal] = useState<{ screen: string } | null>(null);
  const [tab, setTab] = useState<"node" | "preflight" | "log">("node");

  const comp = useMemo(() => composite(config?.screens), [config]);
  const views: NodeView[] = useMemo(
    () =>
      (topo?.nodes ?? []).map((n) => {
        const m = machineFor(machines.data, n);
        const ev = sess.nodes[n.node_id]?.state as NodeRun | undefined;
        let kind: StatusKind = "queued";
        let label = "没有在输出";
        if (ev === "error") [kind, label] = ["failed", "出错"];
        else if (sess.busy && ev === "running") [kind, label] = ["running", "进行中"];
        else if (sess.phase === "showing") [kind, label] = ["running", "正在输出"];
        else if (sess.phase === "standby") [kind, label] = ["clock", "黑场待机"];
        else if (m?.status === "offline") [kind, label] = ["offline", "离线"];
        return { n, m, screens: nodeScreens(n, comp), kind, label };
      }),
    [topo, machines.data, sess.nodes, sess.phase, sess.busy, comp],
  );
  const sel = views.find((v) => v.n.node_id === selId) ?? views[0] ?? null;

  const crumbs = <Crumbs icon="output" current="上屏" />;
  if (!stage || !config) {
    return (
      <main className="ry-main">
        <Toolbar loc label="位置与对象操作">
          {crumbs}
        </Toolbar>
        {!loading && (
          <Empty icon="stage" title="还没有打开 Stage">
            打开一个 Stage 之后才能把画面送上屏幕。
          </Empty>
        )}
      </main>
    );
  }

  const editTopo = () => openObject("output", TOPOLOGY_TAB);
  const busy = !!sess.busy;
  const act = (p: Promise<unknown>, ok?: string) => p.then(() => ok && toast(ok), (e) => toast(errText(e)));
  const localScreen = sel?.screens[0] ?? Object.keys(config.screens)[0] ?? null;

  const pickPicture = (pic: Picture) => {
    if (target === "local") {
      if (pic === "black") return act(stopPatternLocal().then(() => setLocal(null)), "已停止本机播放");
      const p = localScreen ? patterns.data?.[localScreen] : null;
      if (!localScreen || !p) return toast("这块屏幕还没有测试图，先去“屏幕 › 测试图”生成");
      return act(
        playPatternLocal(p.output_dir).then((where) => {
          setLocal({ screen: localScreen });
          toast(`正在 ${where} 上全屏播放 ${localScreen} 的测试图`);
        }),
      );
    }
    if (!topo || pic === "sequence") return;
    act(showPicture(path!, config, topo, pic, patterns.data));
  };

  const running = target === "cluster" ? sess.phase !== "idle" : !!local;
  const statusPill =
    target === "local" ? (
      local ? (
        <Status pill kind="running" label={`本机正在播放 · ${local.screen}`} />
      ) : null
    ) : sess.busy ? (
      <Status pill kind="running" label={`正在${sess.busy}`} />
    ) : sess.phase === "showing" ? (
      <Status pill kind="running" label={`正在输出 · ${PIC_LABEL[sess.picture ?? "pattern"]}`} />
    ) : sess.phase === "standby" ? (
      <Status pill kind="clock" label="黑场待机" />
    ) : null;
  const picture: Picture | null = target === "local" ? (local ? "pattern" : null) : sess.phase === "idle" ? null : sess.picture;

  return (
    <Workspace
      inspector={sel && <NodeInspector v={sel} width={inspW} tab={tab} onTab={setTab} onClose={() => setInsp(false)} runs={runs.data} onOpenMachine={(m) => openObject("machines", machineTab(m))} onPreflight={() => topo && act(runPreflight(path!, config, topo), "预检通过")} busy={busy} />}
      inspectorOpen={inspOpen && !!sel}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      <Toolbar loc label="位置与对象操作">
        {crumbs}
        {statusPill}
        <Spacer />
        <Button icon="check" busy={sess.busy === "预检"} disabled={!topo || busy || target === "local"} onClick={() => topo && act(runPreflight(path!, config, topo), "预检通过")}>
          预检
        </Button>
        {running ? (
          <Button variant="danger" icon="stop" disabled={busy} onClick={() => (target === "local" ? pickPicture("black") : topo && act(stopOutput(path!, config, topo), "已停止输出"))}>
            停止输出
          </Button>
        ) : (
          <Button variant="primary" icon="play" busy={busy && sess.busy !== "预检"} disabled={!topo || busy || target === "local"} onClick={() => topo && act(startOutput(path!, config, topo), "已部署，黑场待机")}>
            开始输出
          </Button>
        )}
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>

      <Toolbar label="视图：输出目标与画面">
        <Meta>目标</Meta>
        <Seg
          label="输出目标"
          options={[
            { value: "cluster", label: "nDisplay 集群" },
            { value: "local", label: "本机显示器" },
          ]}
          value={target}
          onChange={setTarget}
        />
        <Sep />
        <Meta>画面</Meta>
        <Group label="当前画面">
          {(["black", "pattern", "sequence"] as const).map((p) => (
            <Chip key={p} pressed={picture === p} disabled={busy || p === "sequence" || (target === "cluster" && sess.phase === "idle")} onClick={() => pickPicture(p)}>
              {picture === p && <Icon name="check" size="sm" className={css.chipIcon} />}
              {PIC_LABEL[p]}
            </Chip>
          ))}
        </Group>
        <Spacer />
        <Button variant="ghost" icon="sliders" onClick={editTopo}>
          编辑拓扑
        </Button>
      </Toolbar>

      {!topo ? (
        <Empty
          icon="output"
          title="这个 Stage 还没有输出拓扑"
          actions={
            <Button variant="primary" icon="sliders" onClick={editTopo}>
              编辑拓扑
            </Button>
          }
        >
          先定好哪几台渲染机、各自从复合画布上输出哪一块，才能把画面送上屏幕。
        </Empty>
      ) : (
        <div className={css.scroll}>
          {target === "local" && <Note style={{ margin: "0 24px 12px" }}>本机显示器只放一块屏幕的测试图：选中下面的节点就换成它驱动的那块屏幕（现在是 {localScreen ?? "—"}）。</Note>}
          <section aria-label="输出拓扑" className={css.topoSection}>
            <h2 className={css.topoHead}>拓扑 · {views.every((v) => v.screens.length === 1) && views.length === comp.screens.length ? "每块屏幕由一个节点驱动" : `${views.length} 个节点 · ${comp.screens.length} 块屏幕`}</h2>
            <div className={css.topoCards}>
              {views.map((v) => {
                const r = rectOf(v.n);
                return (
                  <button
                    key={v.n.node_id}
                    type="button"
                    aria-pressed={v === sel}
                    className={css.topoCard}
                    style={{ flex: `${Math.max(1, r.w)} 1 0`, aspectRatio: `${Math.max(1, r.w)} / ${Math.max(1, r.h)}` }}
                    onClick={() => setSelId(v.n.node_id)}
                  >
                    <span className={css.topoCardHead}>
                      <span className={css.topoCardName}>{v.screens.join("、") || v.n.node_id}</span>
                      {v.n.primary && <span className="ry-tag">Primary</span>}
                    </span>
                    <span className={css.topoCardMeta}>
                      <span className="ry-mono">
                        {v.n.node_id} · {v.n.machine.hostname || v.n.machine.ip || "未指定机器"}
                      </span>
                      <span className="ry-mono">
                        {r.w} × {r.h}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <Table label="输出节点">
            <HeadRow cols={COLS}>
              <span />
              <span>节点</span>
              <span>机器</span>
              <span>屏幕</span>
              <span>视口</span>
              <span>窗口</span>
              <span className="ry-row__end">同步</span>
            </HeadRow>
            <TableBody>
              {views.map((v) => {
                const r = rectOf(v.n);
                return (
                  <Row key={v.n.node_id} cols={COLS} selected={v === sel} onSelect={() => setSelId(v.n.node_id)}>
                    <Status kind={v.kind} label={v.label} srOnly />
                    <span className={`ry-mono ${css.dim}`}>{v.n.node_id}</span>
                    <RowTitle>{v.n.machine.hostname || v.n.machine.ip || "未指定机器"}</RowTitle>
                    <span>{v.screens.join("、") || "—"}</span>
                    <span className="ry-mono">{`${r.x},${r.y} · ${r.w}×${r.h}`}</span>
                    <span>{windowText(v.n)}</span>
                    <span className="ry-row__end">{RENDER_SYNC_LABEL[topo.render_sync ?? "ethernet_barrier"]}</span>
                  </Row>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </Workspace>
  );
}

const windowText = (n: OutputNode) => (n.fullscreen ? "全屏" : `窗口 ${n.window_px[0]}×${n.window_px[1]}`);

function NodeInspector({ v, width, tab, onTab, onClose, runs, onOpenMachine, onPreflight, busy }: {
  v: NodeView;
  width: number;
  tab: "node" | "preflight" | "log";
  onTab: (t: "node" | "preflight" | "log") => void;
  onClose: () => void;
  runs: Parameters<typeof currentRun>[0];
  onOpenMachine: (m: Machine) => void;
  onPreflight: () => void;
  busy: boolean;
}) {
  const sess = useOutputSession();
  const { n, m } = v;
  const r = rectOf(n);
  const host = n.machine.hostname || n.machine.ip || "未指定机器";
  const pf = sess.preflight;
  const pfItems = (nodes: { node_id: string; host: string; message: string }[]) =>
    pf?.error
      ? [{ key: "err", icon: "failed" as const, iconColor: "var(--status-failed)", text: pf.error, time: "没通过" }]
      : nodes.map((x, i) => ({ key: `${x.node_id}-${i}`, icon: "success" as const, iconColor: "var(--status-success)", text: x.message || `${x.node_id} · ${x.host}`, time: "通过" }));
  const mine = pf ? pf.nodes.filter((x) => x.node_id === n.node_id) : [];
  const logs = sess.log;

  return (
    <Inspector width={width}>
      <InspectorHead
        tabs={
          <ToolTabs
            label="Inspector 内容"
            value={tab}
            onChange={onTab}
            tabs={[
              { key: "node", label: "节点" },
              { key: "preflight", label: "预检", count: pf?.error ? 1 : undefined },
              { key: "log", label: "日志" },
            ]}
          />
        }
        onClose={onClose}
        meta={
          <>
            <span className="ry-mono">{n.node_id}</span>
            <Status pill kind={v.kind} label={v.label} />
          </>
        }
        title={`${v.screens.join("、") || n.node_id} · ${host}`}
        actions={
          <>
            <Button icon="open" disabled={!m} onClick={() => m && onOpenMachine(m)}>
              打开机器
            </Button>
            <Button icon="refresh" disabled title="后端还不支持只重启单个节点">
              只重启此节点
            </Button>
          </>
        }
      />
      <InspectorBody>
        {tab === "node" && (
          <>
            <Props
              items={[
                { label: "机器", value: <span className="ry-mono">{[n.machine.hostname, n.machine.ip].filter(Boolean).join(" · ") || "—"}</span> },
                {
                  label: "屏幕",
                  value: v.screens.length ? (
                    <span>
                      {v.screens.map((id, i) => {
                        const run = currentRun(runs, id);
                        return (
                          <span key={id}>
                            {i > 0 && "，"}
                            {id}
                            {run ? (
                              <>
                                {" "}
                                · 采用重建 <span className="ry-mono">#{run.id}</span>
                              </>
                            ) : (
                              " · 设计网格"
                            )}
                          </span>
                        );
                      })}
                    </span>
                  ) : null,
                },
                { label: "视口", value: <span className="ry-mono">{`x ${r.x} · y ${r.y} · ${r.w} × ${r.h}`}</span> },
                { label: "窗口", value: n.fullscreen ? "全屏" : `窗口 ${n.window_px[0]} × ${n.window_px[1]} · 位置 ${(n.window_origin_px ?? [40, 40]).join(", ")}` },
                { label: "角色", value: n.primary ? "Primary" : null },
                { label: "工程", value: "VoloOutput · UE 5.8" },
                { label: "画面", value: sess.phase === "idle" ? null : PIC_LABEL[sess.picture ?? "black"] },
                { label: "开始", value: hhmmss(sess.startedAt) && <span className="ry-num">{hhmmss(sess.startedAt)}</span> },
              ]}
            />
            <h3 className={css.subHead}>{pf ? `上次预检 · ${hhmmss(pf.at)}` : "还没有预检"}</h3>
            {pf && <Activity style={{ gap: 10 }} items={pfItems(mine)} />}
          </>
        )}
        {tab === "preflight" && (
          <>
            <Button icon="check" busy={sess.busy === "预检"} disabled={busy} onClick={onPreflight}>
              {pf ? "重新预检" : "预检"}
            </Button>
            {pf ? (
              <>
                <h3 className={css.subHead}>{`${hhmmss(pf.at)} · ${pf.error ? "没通过" : `${pf.nodes.length} 项通过`}`}</h3>
                <Activity style={{ gap: 10 }} items={pfItems(pf.nodes)} />
              </>
            ) : (
              <p className={css.saving}>预检会确认每个节点的机器可达、有 UE 5.8，以及拓扑与屏幕定义一致。</p>
            )}
          </>
        )}
        {tab === "log" &&
          (logs.length ? (
            <Activity
              style={{ gap: 10 }}
              items={logs.map((l, i) => ({
                key: `${l.ts}-${i}`,
                icon: l.tone === "error" ? "failed" : l.tone === "ok" ? "success" : "clock",
                iconColor: l.tone === "error" ? "var(--status-failed)" : l.tone === "ok" ? "var(--status-success)" : undefined,
                text: l.node ? (
                  <>
                    <span className="ry-mono">{l.node}</span> · {l.text}
                  </>
                ) : (
                  l.text
                ),
                time: hhmmss(l.ts),
              }))}
            />
          ) : (
            <Empty icon="clock" title="还没有日志">
              预检、部署、切画面和停止输出都会记在这里。
            </Empty>
          ))}
      </InspectorBody>
    </Inspector>
  );
}
