/* 编辑输出拓扑（设计：OutputTopology.dc.html）。上屏页的对象页签 output:topology。
   在草稿上改，“保存拓扑”时写回 project.yaml 的 output_topology（Stage 级）；校验不过不让保存。 */
import { useMemo, useState } from "react";
import type { Machine, OutputNode, OutputTopology, ProjectConfig } from "@/api/types";
import { useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN, type ObjectTab } from "@/lib/nav";
import { errText, toast } from "@/lib/toast";
import {
  Button,
  Crumbs,
  Empty,
  Field,
  Fields,
  FieldsTitle,
  HeadRow,
  IconButton,
  Inspector,
  InspectorBody,
  InspectorHead,
  InspectorToggle,
  Meta,
  Row,
  Select,
  Seg,
  Sep,
  Spacer,
  Status,
  SwitchRow,
  Table,
  TableBody,
  TextInput,
  Toolbar,
  ToolTabs,
  Workspace,
} from "@/ui";
import { useMachineList } from "@/features/cache";
import { composite, machineFor, nodeScreens, rectOf, resolveTopology, topologyPerScreen, validateTopology } from "../model/output";
import { useLedStage, useSaveStage } from "../model/screens";
import css from "./led.module.css";

export const TOPOLOGY_TAB: ObjectTab = { id: "output:topology", label: "编辑拓扑" };

const COLS = "16px 80px 170px 72px minmax(170px, 1fr) 120px 72px";
const same = (a: OutputTopology | null, b: OutputTopology | null) => JSON.stringify(a) === JSON.stringify(b);

export function TopologyEditor() {
  const { stage, config, loading } = useLedStage();
  const save = useSaveStage(stage?.path ?? null);
  const machines = useMachineList();
  const showList = useNav((s) => s.showList);
  const [inspOpen, setInsp] = useInspector("output:topology");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const orig = useMemo(() => resolveTopology(config), [config]);
  const [draft, setDraft] = useState<OutputTopology | null>(null);
  const [sel, setSel] = useState(0);
  const [view, setView] = useState<"canvas" | "desktop">("canvas");
  const [tab, setTab] = useState<"node" | "activity">("node");

  const crumbs = <Crumbs icon="output" trail={[{ label: "上屏", onClick: () => showList("output") }]} current="编辑拓扑" />;
  if (!stage || !config) {
    return (
      <main className="ry-main">
        <Toolbar loc label="位置与对象操作">
          {crumbs}
        </Toolbar>
        {!loading && <Empty icon="stage" title="还没有打开 Stage" />}
      </main>
    );
  }

  const topo: OutputTopology = draft ?? orig ?? { nodes: [], render_sync: "ethernet_barrier" };
  const dirty = draft != null && !same(draft, orig);
  const issues = validateTopology(topo, config);
  const comp = composite(config.screens);
  const nodes = topo.nodes;
  const cur = nodes[Math.min(sel, nodes.length - 1)] ?? null;
  const curIdx = cur ? nodes.indexOf(cur) : -1;
  const setNodes = (next: OutputNode[]) => setDraft({ ...topo, nodes: next });
  const setNode = (i: number, p: Partial<OutputNode>) => setNodes(nodes.map((n, j) => (j === i ? { ...n, ...p } : n)));

  const addNode = () => {
    const covered = (s: (typeof comp.screens)[number]) => nodes.some((n) => nodeScreens(n, comp).includes(s.id));
    const free = comp.screens.find((s) => !covered(s));
    const r = free ?? { x: comp.canvas.w, y: 0, w: 1920, h: 1080 };
    let k = nodes.length;
    let id = `node_${String.fromCharCode(97 + (k % 26))}`;
    while (nodes.some((n) => n.node_id === id)) id = `node_${String.fromCharCode(97 + (++k % 26))}${k >= 26 ? k : ""}`;
    setNodes([...nodes, { node_id: id, machine: { hostname: "", ip: "" }, viewport_rect_px: [r.x, r.y, r.w, r.h], window_px: [r.w, r.h], window_origin_px: [0, 0], fullscreen: false, primary: nodes.length === 0 }]);
    setSel(nodes.length);
  };

  const doSave = () =>
    save.mutate({ ...config, output_topology: topo } satisfies ProjectConfig, {
      onSuccess: () => {
        setDraft(null);
        toast("拓扑已保存");
      },
      onError: (e) => toast(`保存失败：${errText(e)}`),
    });

  return (
    <Workspace
      inspector={
        cur && (
          <NodeEditor
            node={cur}
            idx={curIdx}
            nodes={nodes}
            comp={comp}
            machines={machines.data ?? []}
            width={inspW}
            tab={tab}
            onTab={setTab}
            onClose={() => setInsp(false)}
            onChange={(p) => setNode(curIdx, p)}
            onPrimary={() => setNodes(nodes.map((n, j) => ({ ...n, primary: j === curIdx })))}
            onDelete={() => {
              setNodes(nodes.filter((_, j) => j !== curIdx));
              setSel(Math.max(0, curIdx - 1));
            }}
          />
        )
      }
      inspectorOpen={inspOpen && !!cur}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      <Toolbar loc label="位置与对象操作">
        {crumbs}
        <Spacer />
        <Button disabled={!dirty} onClick={() => setDraft(null)}>
          放弃改动
        </Button>
        <Button
          variant="primary"
          busy={save.isPending}
          disabled={!dirty || issues.length > 0 || save.isPending}
          onClick={doSave}
        >
          保存拓扑
        </Button>
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>
      <Toolbar label="视图：节点与校验">
        <Button icon="plus" onClick={addNode}>
          添加节点
        </Button>
        <Button variant="ghost" icon="grid" disabled={!Object.keys(config.screens).length} onClick={() => setDraft(topologyPerScreen(config, nodes))}>
          每块屏幕一个节点
        </Button>
        <Spacer />
        {issues.length ? <Status kind="attention" label={`${issues.length} 个问题`} /> : <Status kind="success" label="没有错误" />}
        <Meta>{issues.length ? issues[0].text + (issues.length > 1 ? ` 等` : "") : "每块屏幕都被完整覆盖 · 恰好一个主节点 · 节点之间没有重叠"}</Meta>
      </Toolbar>

      <div className={`volo-viewport ${css.topoViewport}`}>
        <TopoCanvas view={view} topo={topo} comp={comp} sel={curIdx} onSel={setSel} />
        <div className="volo-viewport__hud" data-at="tl" role="toolbar" aria-label="看什么">
          <Seg
            label="看什么"
            options={[
              { value: "canvas", label: "复合画布" },
              { value: "desktop", label: "各机器的桌面" },
            ]}
            value={view}
            onChange={setView}
          />
        </div>
        <div className="volo-viewport__hud volo-viewport__hud--col" data-at="tr" role="toolbar" aria-label="视角">
          <IconButton icon="frame" label="框住全部（画布总是完整显示）" disabled />
        </div>
        <div className="volo-viewport__readout" data-at="bl">
          <span>
            复合画布 {comp.canvas.w} × {comp.canvas.h} px
          </span>
          <span>
            {comp.screens.length} 块屏幕 · {nodes.length} 个节点
          </span>
        </div>
        <div className={`volo-viewport__legend ${css.legend}`} data-at="br">
          <span className="volo-viewport__key">
            <i className={css.keySelected} />
            选中的节点
          </span>
          <span className="volo-viewport__key">
            <i className={css.keyCovered} />
            已被节点覆盖
          </span>
          <span className="volo-viewport__key">
            <i className={css.keyEmpty} />
            没有节点输出
          </span>
        </div>
      </div>

      <Table label="全部节点">
        <TableBody>
          <HeadRow cols={COLS}>
            <span />
            <span>节点</span>
            <span>机器</span>
            <span>屏幕</span>
            <span>从复合画布取哪一块</span>
            <span>桌面上的窗口</span>
            <span />
          </HeadRow>
          {nodes.map((n, i) => {
            const m = machineFor(machines.data, n);
            const r = rectOf(n);
            const o = n.window_origin_px ?? [40, 40];
            const oneToOne = n.window_px[0] === r.w && n.window_px[1] === r.h;
            return (
              <Row key={i} cols={COLS} selected={i === curIdx} onSelect={() => setSel(i)}>
                {!m ? <Status kind="attention" label="机器不在纳管清单里" srOnly /> : m.status === "offline" ? <Status kind="offline" label="离线" srOnly /> : <Status kind="success" label="就绪" srOnly />}
                <span className={`ry-row__id ${css.idPrimary}`}>{n.node_id || "—"}</span>
                <span className={css.cell}>{[n.machine.hostname, n.machine.ip].filter(Boolean).join(" · ") || "未指定"}</span>
                <span className={css.cell}>{nodeScreens(n, comp).join("、") || "—"}</span>
                <span className={`ry-mono ${css.cell}`}>{`${r.x}, ${r.y} · ${r.w} × ${r.h}`}</span>
                <span className={`ry-mono ${css.cell}`}>{`${o[0]}, ${o[1]} · ${oneToOne ? "1:1" : `${n.window_px[0]} × ${n.window_px[1]}`}`}</span>
                <span>{n.primary && <span className="ry-tag">主节点</span>}</span>
              </Row>
            );
          })}
        </TableBody>
      </Table>
    </Workspace>
  );
}

/* ------------------------------ 画布 ------------------------------ */

function TopoCanvas({ view, topo, comp, sel, onSel }: { view: "canvas" | "desktop"; topo: OutputTopology; comp: ReturnType<typeof composite>; sel: number; onSel: (i: number) => void }) {
  const W = 840;
  const H = 440;
  const pad = 40;
  if (view === "desktop") {
    /* 各机器的桌面：每个节点一块桌面，窗口按 window_origin_px / window_px 摆。 */
    const n = Math.max(1, topo.nodes.length);
    const cellW = (W - pad * 2 - (n - 1) * 16) / n;
    const maxDesk = Math.max(1, ...topo.nodes.map((x) => Math.max((x.window_origin_px?.[0] ?? 40) + x.window_px[0], 1920)));
    const k = cellW / maxDesk;
    return (
      <svg className="volo-viewport__canvas" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="各机器的桌面与输出窗口">
        {topo.nodes.map((x, i) => {
          const dx = pad + i * (cellW + 16);
          const deskH = 1080 * k;
          const o = x.window_origin_px ?? [40, 40];
          return (
            <g key={i} onClick={() => onSel(i)}>
              <rect className="volo-scene-shape is-ghost" x={dx} y={120} width={cellW} height={deskH} />
              <rect className={`volo-scene-shape${i === sel ? " is-selected" : ""}`} x={dx + o[0] * k} y={120 + o[1] * k} width={x.window_px[0] * k} height={x.window_px[1] * k} />
              <text className="volo-scene-text" x={dx} y={108}>
                {x.machine.hostname || x.machine.ip || x.node_id}
              </text>
              <text className="volo-scene-text" x={dx} y={120 + deskH + 18}>
                {`${x.node_id} · ${o[0]}, ${o[1]}`}
              </text>
            </g>
          );
        })}
      </svg>
    );
  }
  const k = Math.min((W - pad * 2) / comp.canvas.w, 300 / comp.canvas.h);
  const top = 120;
  const X = (v: number) => pad + v * k;
  const Y = (v: number) => top + v * k;
  const edges = Array.from(new Set([0, ...comp.screens.map((s) => s.x + s.w)]));
  return (
    <svg className="volo-viewport__canvas" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`复合画布：${comp.screens.map((s) => s.id).join("、")}，共 ${topo.nodes.length} 个节点`}>
      <path className="volo-scene-grid" d={`M${pad} ${top - 10}h${W - pad * 2}M${pad} ${Y(comp.canvas.h) + 1}h${W - pad * 2}`} />
      {comp.screens.map((s) => (
        <rect key={s.id} className="volo-scene-shape is-ghost" x={X(s.x)} y={Y(s.y)} width={s.w * k} height={s.h * k} />
      ))}
      {topo.nodes.map((n, i) => {
        const r = rectOf(n);
        return <rect key={i} className={`volo-scene-shape${i === sel ? " is-selected" : ""}`} x={X(r.x)} y={Y(r.y)} width={Math.max(0, r.w * k)} height={Math.max(0, r.h * k)} onClick={() => onSel(i)} />;
      })}
      {topo.nodes.map((n, i) => {
        const r = rectOf(n);
        const scr = nodeScreens(n, comp);
        return (
          <g key={`t${i}`} pointerEvents="none">
            <text className="volo-scene-text" x={X(r.x) + 12} y={Y(r.y) + 24}>
              {`${scr.join("、") || "空白"} · ${r.w} × ${r.h}`}
            </text>
            <text className="volo-scene-text" x={X(r.x) + 12} y={Y(r.y) + 42}>
              {`${n.node_id} · ${n.machine.hostname || n.machine.ip || "未指定"}${n.primary ? " · 主节点" : ""}`}
            </text>
          </g>
        );
      })}
      {edges.map((e, i) => (
        <text key={e} className="volo-scene-text" x={X(e) - (i === 0 ? 0 : i === edges.length - 1 ? 22 : 6)} y={Y(comp.canvas.h) + 19}>
          {e}
        </text>
      ))}
    </svg>
  );
}

/* ------------------------------ Inspector ------------------------------ */

function NumField({ id, label, value, onValue, unit }: { id: string; label: string; value: number; onValue: (n: number) => void; unit?: string }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <Field label={label} htmlFor={id}>
      <TextInput
        id={id}
        num
        unit={unit}
        value={text ?? String(value)}
        onChange={(t) => {
          const c = t.replace(/[^\d-]/g, "");
          setText(c);
          if (c !== "" && Number.isFinite(Number(c))) onValue(Math.round(Number(c)));
        }}
        onBlur={() => setText(null)}
      />
    </Field>
  );
}

function NodeEditor({ node, idx, nodes, comp, machines, width, tab, onTab, onClose, onChange, onPrimary, onDelete }: {
  node: OutputNode;
  idx: number;
  nodes: OutputNode[];
  comp: ReturnType<typeof composite>;
  machines: Machine[];
  width: number;
  tab: "node" | "activity";
  onTab: (t: "node" | "activity") => void;
  onClose: () => void;
  onChange: (p: Partial<OutputNode>) => void;
  onPrimary: () => void;
  onDelete: () => void;
}) {
  const r = rectOf(node);
  const scr = nodeScreens(node, comp);
  const exact = comp.screens.find((s) => s.x === r.x && s.y === r.y && s.w === r.w && s.h === r.h);
  const primary = nodes.find((n) => n.primary);
  const m = machineFor(machines, node);
  const follow = node.window_px[0] === r.w && node.window_px[1] === r.h;
  const o = node.window_origin_px ?? [40, 40];
  const setRect = (i: number, v: number) => {
    const vr: [number, number, number, number] = [...node.viewport_rect_px];
    vr[i] = v;
    onChange({ viewport_rect_px: vr, ...(follow ? { window_px: [vr[2], vr[3]] as [number, number] } : {}) });
  };
  const key = `tn-${idx}`;
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
              { key: "activity", label: "活动" },
            ]}
          />
        }
        onClose={onClose}
        meta={
          <>
            <span>节点</span>
            <span>{scr.length ? `输出${scr.join("、")}` : "没有落在任何屏幕上"}</span>
          </>
        }
        title={node.node_id || "未命名节点"}
      />
      <InspectorBody>
        {tab === "activity" ? (
          <Empty icon="clock" title="还没有活动记录">
            拓扑保存记录接入后会显示在这里。
          </Empty>
        ) : (
          <>
            <Fields>
              <Field inline label="节点名" htmlFor={`${key}-id`}>
                <TextInput id={`${key}-id`} mono value={node.node_id} onChange={(t) => onChange({ node_id: t.replace(/\s/g, "") })} />
              </Field>
              <Field inline label="机器">
                <Select
                  value={m ? String(m.id) : null}
                  placeholder={node.machine.hostname || node.machine.ip || "选择…"}
                  options={machines.map((x) => ({ value: String(x.id), label: `${x.hostname} · ${x.ip}` }))}
                  onChange={(v) => {
                    const x = machines.find((mm) => String(mm.id) === v);
                    if (x) onChange({ machine: { machine_uid: x.uid ?? null, hostname: x.hostname, ip: x.ip } });
                  }}
                />
              </Field>
              <SwitchRow title="主节点" desc={`整个集群恰好一个，现在是 ${primary?.node_id ?? "—"}。`} checked={node.primary} onChange={(v) => v && onPrimary()} />
            </Fields>
            <div className={css.gap12} />
            <Fields>
              <FieldsTitle>从复合画布里取哪一块</FieldsTitle>
              <Fields row>
                <NumField id={`${key}-x`} label="X" value={r.x} onValue={(v) => setRect(0, v)} />
                <NumField id={`${key}-y`} label="Y" value={r.y} onValue={(v) => setRect(1, v)} />
              </Fields>
              <Fields row>
                <NumField id={`${key}-w`} label="宽" unit="px" value={r.w} onValue={(v) => setRect(2, v)} />
                <NumField id={`${key}-h`} label="高" unit="px" value={r.h} onValue={(v) => setRect(3, v)} />
              </Fields>
              <p className="volo-field__hint" style={{ margin: 0 }}>
                {exact ? `和“${exact.id}”的边界一致。` : scr.length ? `跨 ${scr.join("、")}，没有和哪块屏幕的边界对齐。` : "这块区域没有落在任何屏幕上。"}
              </p>
            </Fields>
            <div className={css.gap12} />
            <Fields>
              <FieldsTitle>在这台机器的桌面上放哪</FieldsTitle>
              <Fields row>
                <NumField id={`${key}-wx`} label="窗口 X" value={o[0]} onValue={(v) => onChange({ window_origin_px: [v, o[1]] })} />
                <NumField id={`${key}-wy`} label="窗口 Y" value={o[1]} onValue={(v) => onChange({ window_origin_px: [o[0], v] })} />
              </Fields>
              <SwitchRow title="窗口大小跟随取的那一块" desc="保持像素 1:1，不缩放。" checked={follow} onChange={(v) => onChange({ window_px: v ? [r.w, r.h] : [Math.round(r.w / 2), Math.round(r.h / 2)] })} />
              {!follow && (
                <Fields row>
                  <NumField id={`${key}-ww`} label="窗口宽" unit="px" value={node.window_px[0]} onValue={(v) => onChange({ window_px: [v, node.window_px[1]] })} />
                  <NumField id={`${key}-wh`} label="窗口高" unit="px" value={node.window_px[1]} onValue={(v) => onChange({ window_px: [node.window_px[0], v] })} />
                </Fields>
              )}
              <p className="volo-field__hint" style={{ margin: 0 }}>
                目前只支持窗口输出，全屏还没开放。
              </p>
            </Fields>
            <div className={css.gap20} />
            <div className={css.btnRowTight}>
              <Button variant="danger" onClick={onDelete}>
                删除这个节点
              </Button>
            </div>
          </>
        )}
      </InspectorBody>
    </Inspector>
  );
}
