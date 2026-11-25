/* 机器详情（设计：MachineDetail.dc.html + App.dc.html 的 machine_* 路由）。
   页签：巡检与配置（巡检结果 + INI 配置检查发现，按状况分组）/ 工程 / 属性 / 活动。 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { IniFinding } from "@/api/types";
import { useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN } from "@/lib/nav";
import { copyText } from "@/lib/clipboard";
import { errText, toast } from "@/lib/toast";
import {
  Button,
  Chip,
  ConfirmDialog,
  Crumbs,
  Empty,
  GroupRow,
  Group,
  HeadRow,
  IconButton,
  Inspector,
  InspectorBody,
  InspectorHead,
  InspectorToggle,
  Menu,
  MenuItem,
  Props,
  Row,
  RowTitle,
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
import { CHECK_TEXT } from "../model/checks";
import { useClusterUi } from "../model/clusterUi";
import { PSO_REASON, useProjects, type CopyView, type ProjectView } from "../model/projects";
import {
  fmtFull,
  fmtTime,
  ROLE_LABEL,
  STATE_LABEL,
  useApplyFinding,
  useMachineDetail,
  useMachineProjects,
  useMachines,
  useRefreshMachine,
  useRemoveMachine,
  useRenameMachine,
  useRunInspection,
  useSetUeUser,
  useSkipFinding,
  type CheckView,
  type MachineView,
} from "../model/machines";
import { PromptDialog } from "./PromptDialog";
import css from "./cache.module.css";

type Tab = "checks" | "projects" | "props" | "activity";
type Source = "all" | "health" | "ini";
type ItemState = "failed" | "attention" | "success" | "offline" | "queued";

interface Item {
  id: string;
  state: ItemState;
  text: string;
  source: "巡检" | "配置检查" | "PSO 预热";
  how: string;
  check?: CheckView;
  finding?: IniFinding;
  pso?: { project: ProjectView; copy: CopyView };
}

const ITEM_KIND: Record<ItemState, StatusKind> = { failed: "failed", attention: "attention", success: "success", offline: "offline", queued: "queued" };
const ITEM_LABEL: Record<ItemState, string> = { failed: "需处理", attention: "已过期", success: "就绪", offline: "连不上", queued: "跳过" };
const ITEM_ORDER: ItemState[] = ["failed", "attention", "offline", "queued", "success"];
const PASS_SHOWN = 3;
const COLS = "16px minmax(240px, 1fr) 96px 180px";
const PROJ_COLS = "16px 140px minmax(200px, 1fr) 150px 160px";

function buildItems(v: MachineView, projects: ProjectView[]): Item[] {
  const out: Item[] = [];
  for (const p of projects) {
    const copy = p.copies.find((c) => c.loc.machine_id === v.id);
    if (copy?.pso?.status !== "degraded") continue;
    const driver = copy.pso.invalidation_reasons.some((r) => r.reason === "gpu_driver_changed");
    out.push({ id: `p:${p.id}`, state: "attention", text: `${p.name} 的 PSO 预热已过期`, source: "PSO 预热", how: driver ? "先修好驱动，再去预热" : "重新预热", pso: { project: p, copy } });
  }
  for (const c of v.checks) {
    const state: ItemState = c.status === "pass" ? "success" : c.status === "fail" ? "failed" : c.status === "offline" ? "offline" : "queued";
    out.push({
      id: `c:${c.key}`,
      state,
      text: state === "failed" ? c.message || CHECK_TEXT[c.key]?.fail || `${c.label}未通过` : c.label,
      source: "巡检",
      how: state === "failed" ? "手动 · 按步骤处理后重新巡检" : "—",
      check: c,
    });
  }
  for (const f of v.findings) {
    out.push({
      id: `f:${f.id ?? f.rule_id}`,
      state: "failed",
      text: f.symptom || f.rule_id,
      source: "配置检查",
      how: f.recommended_action === "manual" ? "手动 · 按说明修改后重新检查" : "可以自动修复",
      finding: f,
    });
  }
  return out;
}

export function MachineDetail({ id }: { id: number }) {
  const { views, loading, healthAt } = useMachines();
  const v = views.find((x) => x.id === id) ?? null;
  const tabId = `machine:${id}`;
  const showList = useNav((s) => s.showList);
  const closeObject = useNav((s) => s.closeObject);
  const updateObject = useNav((s) => s.updateObject);

  useEffect(() => {
    if (v) updateObject("machines", tabId, { label: v.host, status: v.state === "success" ? "success" : v.state === "failed" ? "failed" : v.state === "offline" ? "offline" : "queued", statusLabel: STATE_LABEL[v.state] });
  }, [v?.host, v?.state, tabId, updateObject, v]);

  if (!v) {
    return (
      <main className="ry-main">
        <Toolbar loc label="位置与对象操作">
          <Crumbs icon="machine" trail={[{ label: "机器", onClick: () => showList("machines") }]} current="—" />
        </Toolbar>
        {!loading && (
          <Empty icon="machine" title="这台机器已不在集群里" actions={<Button onClick={() => closeObject("machines", tabId)}>关闭页签</Button>}>
            它可能已被移除。回到机器列表可以重新添加。
          </Empty>
        )}
      </main>
    );
  }
  return <Detail v={v} healthAt={healthAt} />;
}

function Detail({ v, healthAt }: { v: MachineView; healthAt: string | null }) {
  const showList = useNav((s) => s.showList);
  const closeObject = useNav((s) => s.closeObject);
  const [inspOpen, setInsp] = useInspector("machines:detail");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const detail = useMachineDetail(v.id);
  const inspect = useRunInspection();
  const refresh = useRefreshMachine();
  const remove = useRemoveMachine();
  const rename = useRenameMachine();
  const setUe = useSetUeUser();
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [dialog, setDialog] = useState<null | "rename" | "ue" | "remove">(null);
  const [tab, setTab] = useState<Tab>("checks");
  const [source, setSource] = useState<Source>("all");
  const [expanded, setExpanded] = useState(false);
  const { views: projects } = useProjects();
  const items = useMemo(() => buildItems(v, projects), [v, projects]);
  const [sel, setSel] = useState<string | null>(null);

  const filtered = items.filter((i) => source === "all" || (source === "health" ? i.source === "巡检" : i.source === "配置检查"));
  const selected = filtered.find((i) => i.id === sel) ?? filtered.find((i) => i.state === "failed") ?? filtered[0] ?? null;

  const ue = detail.data?.ue_installs.find((u) => u.is_primary) ?? detail.data?.ue_installs[0];
  const gpus = detail.data?.gpus ?? [];
  const gpuText = gpus.length ? Array.from(new Set(gpus.map((g) => g.gpu_model))).map((m) => `${m}${gpus.filter((g) => g.gpu_model === m).length > 1 ? ` × ${gpus.filter((g) => g.gpu_model === m).length}` : ""}`).join(" · ") : v.gpuModel;

  const runInspect = () =>
    inspect.mutate([v.id], {
      onSuccess: (f) => toast(f.length ? `巡检部分完成：${f.join("；")}` : `${v.host} 巡检完成`),
      onError: (e) => toast(`巡检失败：${errText(e)}`),
    });

  const tabsEl = (
    <ToolTabs
      label="机器内容"
      value={tab}
      onChange={setTab}
      tabs={[
        { key: "checks", label: "巡检与配置" },
        { key: "projects", label: "工程" },
        { key: "props", label: "属性" },
        { key: "activity", label: "活动" },
      ]}
    />
  );

  const inspector =
    tab === "checks" && selected ? <ItemInspector v={v} item={selected} healthAt={healthAt} width={inspW} onClose={() => setInsp(false)} onInspect={runInspect} inspecting={inspect.isPending} /> : null;

  return (
    <Workspace inspector={inspector} inspectorOpen={inspOpen} inspectorWidth={inspW} onInspectorWidth={setInspW} minWidth={INSPECTOR_MIN} maxWidth={INSPECTOR_MAX}>
      <Toolbar loc label="位置与对象操作">
        <Crumbs icon="machine" trail={[{ label: "机器", onClick: () => showList("machines") }]} current={v.host} />
        <Spacer />
        <Button icon="refresh" busy={inspect.isPending} disabled={v.state === "offline"} onClick={runInspect}>
          重新巡检
        </Button>
        <IconButton ref={moreRef} icon="more" label="更多操作：改名、更换 UE 运行用户、重新获取机器信息、从集群移除" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)} />
        {moreOpen && (
          <Menu anchor={moreRef} onClose={() => setMoreOpen(false)} label="更多操作" alignEnd>
            <MenuItem onSelect={() => (setMoreOpen(false), setDialog("rename"))}>改名</MenuItem>
            <MenuItem onSelect={() => (setMoreOpen(false), setDialog("ue"))}>更换 UE 运行用户</MenuItem>
            <MenuItem
              onSelect={() => {
                setMoreOpen(false);
                refresh.mutate(v.id, { onSuccess: () => toast(`已重新获取 ${v.host} 的机器信息`), onError: (e) => toast(`获取失败：${errText(e)}`) });
              }}
            >
              重新获取机器信息
            </MenuItem>
            <MenuItem danger onSelect={() => (setMoreOpen(false), setDialog("remove"))}>
              从集群移除
            </MenuItem>
          </Menu>
        )}
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>

      <div className={`ry-detail ${css.detailTop}`}>
        <div className={`ry-detail__head ${css.detailHead}`}>
          <h1 className="ry-detail__title">{v.host}</h1>
          <div className="ry-detail__meta">
            <Status kind={ITEM_KIND[v.state]} label={STATE_LABEL[v.state]} pill />
            <span>{ROLE_LABEL[v.role]}</span>
            <span className="ry-mono">{v.ip}</span>
            {v.output && <span>上屏 · {v.output.node}</span>}
            {(ue || v.ueUser) && (
              <span>
                {ue ? `UE ${ue.version}` : "UE —"}
                {v.ueUser ? ` · 运行用户 ${v.ueUser}` : ""}
              </span>
            )}
            {v.checkedAt && <span className="ry-num">上次巡检 {fmtTime(v.checkedAt)}</span>}
          </div>
        </div>
        <div className="ry-detail__tools">
          {tabsEl}
          {tab === "checks" && (
            <>
              <Spacer />
              <Group label="按来源筛选" fixed>
                <Chip pressed={source === "all"} count={items.length} onClick={() => setSource("all")}>
                  全部
                </Chip>
                <Chip pressed={source === "health"} count={items.filter((i) => i.source === "巡检").length} onClick={() => setSource("health")}>
                  巡检
                </Chip>
                <Chip pressed={source === "ini"} count={items.filter((i) => i.source === "配置检查").length} onClick={() => setSource("ini")}>
                  配置检查
                </Chip>
              </Group>
            </>
          )}
        </div>
      </div>

      {tab === "checks" && (
        <Table label={`${v.host} 的巡检与配置发现`}>
          <TableBody>
            <HeadRow cols={COLS}>
              <span />
              <span>发现</span>
              <span>来自</span>
              <span>怎么处理</span>
            </HeadRow>
            {filtered.length === 0 && (
              <Empty icon="verify" title={items.length ? "这个来源没有发现" : "还没有巡检过"} actions={!items.length && <Button icon="refresh" onClick={runInspect}>重新巡检</Button>}>
                {items.length ? "换个来源看看。" : "巡检会检查远程通道、缓存路径、GPU 驱动和工程配置。"}
              </Empty>
            )}
            {ITEM_ORDER.map((st) => {
              const rows = filtered.filter((i) => i.state === st);
              if (!rows.length) return null;
              const collapse = st === "success" && !expanded && rows.length > PASS_SHOWN + 1;
              const shown = collapse ? rows.slice(0, PASS_SHOWN) : rows;
              return (
                <div key={st} className={css.contents}>
                  <GroupRow kind={ITEM_KIND[st]} label={ITEM_LABEL[st]} count={rows.length} />
                  {shown.map((i) => (
                    <Row key={i.id} cols={COLS} selected={selected?.id === i.id} onSelect={() => setSel(i.id)} onOpen={() => (setSel(i.id), setInsp(true))}>
                      <Status kind={ITEM_KIND[i.state]} label={ITEM_LABEL[i.state]} srOnly />
                      <RowTitle>{i.text}</RowTitle>
                      <span className={css.sec}>{i.source}</span>
                      <span className={css.sec}>{i.how}</span>
                    </Row>
                  ))}
                  {collapse && (
                    <Row cols={COLS} onSelect={() => setExpanded(true)} onOpen={() => setExpanded(true)}>
                      <Status kind="success" label="就绪" srOnly />
                      <RowTitle>另外 {rows.length - PASS_SHOWN} 项通过</RowTitle>
                      <span className={css.sec}>巡检</span>
                      <span className={css.sec}>—</span>
                    </Row>
                  )}
                </div>
              );
            })}
          </TableBody>
        </Table>
      )}

      {tab === "projects" && <MachineProjects v={v} />}

      {tab === "props" && (
        <div className={css.pane}>
          <div className={css.paneInner}>
            <Props
              items={[
                { label: "名称", value: v.host },
                { label: "地址", value: <span className="ry-mono">{v.ip}</span> },
                { label: "角色", value: ROLE_LABEL[v.role] },
                { label: "上屏", value: v.output ? `节点 ${v.output.node}${v.output.primary ? " · 主节点" : ""}` : null },
                { label: "UE 运行用户", value: v.ueUser },
                { label: "UE", value: detail.data?.ue_installs.length ? detail.data.ue_installs.map((u) => `${u.version}${u.is_primary ? "（主）" : ""}`).join(" · ") : null },
                { label: "显卡", value: gpuText },
                { label: "GPU 驱动", value: v.driver ? `${v.driver}${v.driverMismatch ? " · 与集群不一致" : ""}` : null },
                { label: "上次在线", value: v.lastSeen ? <span className="ry-num">{fmtFull(v.lastSeen)}</span> : null },
                { label: "机器 ID", value: v.uid ? <span className="ry-mono">{v.uid}</span> : null },
              ]}
            />
          </div>
        </div>
      )}

      {tab === "activity" && (
        <div className={css.pane}>
          <Empty icon="clock" title="还没有活动记录">
            这台机器上的操作记录接入后会显示在这里。
          </Empty>
        </div>
      )}

      {dialog === "rename" && (
        <PromptDialog
          title={`给 ${v.host} 改名`}
          body="只改 Volo 里的显示名，不会改这台机器的系统主机名。"
          label="名称"
          mono
          initial={v.host}
          submitLabel="改名"
          busy={rename.isPending}
          onClose={() => setDialog(null)}
          onSubmit={(hostname) =>
            rename.mutate(
              { id: v.id, hostname },
              { onSuccess: () => (setDialog(null), toast(`已改名为 ${hostname}`)), onError: (e) => toast(`改名失败：${errText(e)}`) },
            )
          }
        />
      )}
      {dialog === "ue" && (
        <PromptDialog
          title="更换 UE 运行用户"
          body="UE 以这个 Windows 账户在桌面上运行。留空 = 清除，巡检时按默认账户检查。"
          label="运行用户"
          mono
          allowEmpty
          initial={v.ueUser ?? ""}
          submitLabel="保存"
          busy={setUe.isPending}
          onClose={() => setDialog(null)}
          onSubmit={(user) => setUe.mutate({ id: v.id, user }, { onSuccess: () => (setDialog(null), toast("UE 运行用户已更新")), onError: (e) => toast(`保存失败：${errText(e)}`) })}
        />
      )}
      {dialog === "remove" && (
        <ConfirmDialog
          title={`从集群移除 ${v.host}？`}
          body="只是让 Volo 不再管理这台机器：它上面的工程、缓存和配置都不动。之后想再管理，重新添加即可。"
          props={[
            { label: "影响", value: <span className="ry-mono">{v.host} · {v.ip}</span> },
            { label: "可恢复", value: "是，重新添加机器即可" },
          ]}
          command={`voloctl machine delete ${v.id} --yes`}
          safeLabel="保留"
          dangerLabel="移除机器"
          dangerIcon="close"
          busy={remove.isPending}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            remove.mutate(v.id, {
              onSuccess: () => {
                setDialog(null);
                closeObject("machines", `machine:${v.id}`);
                toast(`${v.host} 已从集群移除`);
              },
              onError: (e) => toast(`移除失败：${errText(e)}`),
            })
          }
        />
      )}
    </Workspace>
  );
}

/* --------------------------- 发现项 Inspector --------------------------- */

function ItemInspector({ v, item, healthAt, width, onClose, onInspect, inspecting }: { v: MachineView; item: Item; healthAt: string | null; width: number; onClose: () => void; onInspect: () => void; inspecting: boolean }) {
  const [tab, setTab] = useState<"detail" | "activity">("detail");
  const apply = useApplyFinding();
  const skip = useSkipFinding();
  const f = item.finding;
  const c = item.check;
  const pso = item.pso;
  const go = useNav((s) => s.go);
  const focusPso = useClusterUi((s) => s.focusPso);
  const auto = f && f.recommended_action !== "manual" && f.id != null;
  const cmd = f ? `voloctl ini apply ${f.id ?? ""} --yes` : "voloctl health run";

  const actions = f ? (
    <>
      {auto && (
        <Button
          variant="primary"
          busy={apply.isPending}
          onClick={() => apply.mutate(f.id as number, { onSuccess: () => toast("已应用修复，重启这台机器上的 UE 后生效"), onError: (e) => toast(`修复失败：${errText(e)}`) })}
        >
          应用修复
        </Button>
      )}
      {f.id != null && (
        <Button busy={skip.isPending} onClick={() => skip.mutate(f.id as number, { onSuccess: () => toast("已跳过这一项"), onError: (e) => toast(`跳过失败：${errText(e)}`) })}>
          跳过这一项
        </Button>
      )}
    </>
  ) : pso ? (
    <Button variant="primary" onClick={() => (focusPso(pso.project.id), go("pso"))}>
      去“PSO 预热”
    </Button>
  ) : item.state === "failed" ? (
    <Button icon="refresh" busy={inspecting} onClick={onInspect}>
      重新巡检
    </Button>
  ) : null;

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
            <span>{item.source}</span>
            <Status kind={ITEM_KIND[item.state]} label={ITEM_LABEL[item.state]} pill />
          </>
        }
        title={item.text}
        actions={actions}
      />
      <InspectorBody>
        {tab === "detail" && f && (
          <>
            {f.rationale && <p className={css.lead}>{f.rationale}</p>}
            {(f.snippet_before || f.snippet_after) && (
              <div className={css.diff}>
                <div className={css.diffRow}>
                  <span className="ry-meta">现在</span>
                  <span className="ry-mono">{f.snippet_before || "（没有这一项）"}</span>
                </div>
                <div className={css.diffSep} />
                <div className={css.diffRow}>
                  <span className="ry-meta">改成</span>
                  <span className="ry-mono">{f.snippet_after ?? (f.recommended_action === "remove" ? "（删除这一行）" : "—")}</span>
                </div>
              </div>
            )}
            <Props
              items={[
                { label: "文件", value: <span className="ry-mono">{f.file_path}</span> },
                { label: "位置", value: f.section ? <span className="ry-mono">[{f.section}]{f.key_name ? ` ${f.key_name}` : ""}{f.line_number != null ? ` · 第 ${f.line_number} 行` : ""}</span> : null },
                { label: "备份", value: auto ? "修改前在同一个文件夹留一份 .bak" : null },
                { label: "生效", value: auto ? "重启这台机器上的 UE 之后" : null },
                { label: "规则", value: <span className="ry-mono">{f.rule_id}</span> },
                { label: "命令", value: <span className="ry-mono">{cmd}</span>, action: <IconButton size="sm" icon="copy" label="复制等效命令" onClick={() => copyText(cmd)} /> },
              ]}
            />
          </>
        )}
        {tab === "detail" && c && (
          <>
            {(c.remediation || c.message) && <p className={css.lead}>{item.state === "failed" ? c.remediation || c.message : c.message}</p>}
            <Props
              items={[
                { label: "探测项", value: <span className="ry-mono">{c.key}</span> },
                { label: "地址", value: <span className="ry-mono">{v.ip}</span> },
                { label: "巡检于", value: healthAt ? <span className="ry-num">{fmtFull(healthAt)}</span> : null },
                { label: "命令", value: <span className="ry-mono">{cmd}</span>, action: <IconButton size="sm" icon="copy" label="复制等效命令" onClick={() => copyText(cmd)} /> },
              ]}
            />
          </>
        )}
        {tab === "detail" && pso && (
          <>
            <p className={css.lead}>
              {pso.copy.pso?.invalidation_reasons.map((r) => `${PSO_REASON[r.reason] ?? r.reason}${r.detail ? `（${r.detail}）` : ""}`).join("；") || "PSO 缓存已过期"}
              ，原有的 PSO 缓存在这台机器上不再适用。
            </p>
            <Props
              items={[
                { label: "工程", value: pso.project.name },
                { label: "路径", value: <span className="ry-mono">{pso.copy.loc.abs_path}</span> },
                { label: "上次就绪", value: pso.copy.pso?.green_verified_at ? <span className="ry-num">{fmtFull(pso.copy.pso.green_verified_at)}</span> : null },
                { label: "发现于", value: pso.copy.pso?.invalidation_reasons[0]?.detected_at ? <span className="ry-num">{fmtFull(pso.copy.pso.invalidation_reasons[0].detected_at)}</span> : null },
              ]}
            />
          </>
        )}
        {tab === "activity" && <p className={css.muted}>这一项的处理记录接入后会显示在这里。</p>}
      </InspectorBody>
    </Inspector>
  );
}

/* ------------------------------- 工程页签 ------------------------------- */

function MachineProjects({ v }: { v: MachineView }) {
  const q = useMachineProjects(v.id);
  const rows = q.data ?? [];
  return (
    <Table label={`${v.host} 上的工程`}>
      <TableBody>
        <HeadRow cols={PROJ_COLS}>
          <span />
          <span>工程</span>
          <span>路径</span>
          <span>缓存指向</span>
          <span>PSO 预热</span>
        </HeadRow>
        {!q.isLoading && rows.length === 0 && (
          <Empty icon="project" title="这台机器上还没找到工程">
            在“工程”页扫描一次，Volo 会记下每台机器上的工程位置。
          </Empty>
        )}
        {rows.map(({ project, loc }) => {
          const bad = v.findings.some((f) => f.file_path.toLowerCase().startsWith(loc.abs_path.toLowerCase()));
          return (
            <Row key={`${project.id}:${loc.id}`} cols={PROJ_COLS}>
              <Status kind={bad ? "failed" : "success"} label={bad ? "需处理" : "就绪"} srOnly />
              <span className={`ry-row__id ${css.idPrimary}`}>{project.display_name || project.uproject_name}</span>
              <span className={`ry-mono ${css.sec}`}>{loc.abs_path}</span>
              <span className={css.sec}>—</span>
              <span className={css.sec}>{bad ? "工程配置有需处理的项" : "—"}</span>
            </Row>
          );
        })}
      </TableBody>
    </Table>
  );
}
