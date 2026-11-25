/* 集群 › 机器（设计：Machines.dc.html、StateLoading / StateError、App.dc.html 的 machines 路由）。
   列表按状况分组；单击选中 → Inspector，双击 / ↵ / “打开” → 机器详情页签。 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ObjectTab } from "@/lib/nav";
import { useActiveObject, useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN } from "@/lib/nav";
import { copyText } from "@/lib/clipboard";
import { errText, toast } from "@/lib/toast";
import {
  Activity,
  Banner,
  Button,
  ConfirmDialog,
  ChipFilter,
  Crumbs,
  DisplayChips,
  DisplayMenu,
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
  Meta,
  Note,
  Progress,
  Props,
  Row,
  RowEnd,
  RowTitle,
  Search,
  Sep,
  Seg,
  Skel,
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
import { fmtFull, fmtTime, ROLE_LABEL, STATE_LABEL, useMachines, useRefreshMachine, useRemoveMachine, useRenameMachine, useRunInspection, type MachineState, type MachineView, type RoleKey } from "../model/machines";
import { useViewPrefs } from "../model/viewPrefs";
import { AddMachineDialog } from "./AddMachineDialog";
import { MachineDetail } from "./MachineDetail";
import { PromptDialog } from "./PromptDialog";
import css from "./cache.module.css";

export const STATE_KIND: Record<MachineState, StatusKind> = { failed: "failed", success: "success", offline: "offline", queued: "queued" };
const STATE_ORDER: MachineState[] = ["failed", "queued", "success", "offline"];

export function machineTab(m: { id: number | null; hostname: string }): ObjectTab {
  return { id: `machine:${m.id ?? 0}`, label: m.hostname };
}

type ColKey = "title" | "ip" | "driver" | "user" | "last";
const COLS: { key: ColKey; label: string; width: string }[] = [
  { key: "title", label: "角色与状况", width: "minmax(200px, 1fr)" },
  { key: "ip", label: "地址", width: "112px" },
  { key: "driver", label: "GPU 驱动", width: "104px" },
  { key: "user", label: "UE 用户", width: "72px" },
  { key: "last", label: "上次巡检", width: "88px" },
];

type RoleFilter = "all" | RoleKey;

export function MachinesPage() {
  const active = useActiveObject("machines");
  const id = active?.startsWith("machine:") ? Number(active.slice(8)) : null;
  return id != null && Number.isFinite(id) ? <MachineDetail id={id} /> : <MachinesList />;
}

function MachinesList() {
  const { views, loading, fetching, error, healthAt, refetch } = useMachines();
  const openObject = useNav((s) => s.openObject);
  const [inspOpen, setInsp] = useInspector("machines");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const [role, setRole] = useState<RoleFilter>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const inspect = useRunInspection();
  const [prefs, setPrefs, resetPrefs] = useViewPrefs("machines", { group: "state", sort: "state", cols: { title: true, ip: true, driver: true, user: true, last: true } });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA"))) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const roleCount = (r: RoleKey) => views.filter((v) => v.role === r || (r === "shared" && v.tags.includes("缓存服务器"))).length;
  const roleOptions = [
    { key: "all" as RoleFilter, label: "全部", count: views.length },
    ...(["render", "shared", "spare", "workstation"] as RoleKey[]).filter((r) => roleCount(r) > 0).map((r) => ({ key: r as RoleFilter, label: ROLE_LABEL[r], count: roleCount(r) })),
  ];

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    let list = views.filter((v) => role === "all" || v.role === role);
    if (s) list = list.filter((v) => `${v.host} ${v.ip} ${v.tags.join(" ")} ${v.summary}`.toLowerCase().includes(s));
    const byName = (a: MachineView, b: MachineView) => a.host.localeCompare(b.host, "zh-CN", { numeric: true });
    if (prefs.sort === "name") list = [...list].sort(byName);
    else if (prefs.sort === "last") list = [...list].sort((a, b) => (b.checkedAt ?? "").localeCompare(a.checkedAt ?? "") || byName(a, b));
    else list = [...list].sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || byName(a, b));
    return list;
  }, [views, role, q, prefs.sort]);

  const selected = views.find((v) => v.id === sel) ?? shown[0] ?? null;

  const cols = ["16px", "88px", ...COLS.filter((c) => prefs.cols[c.key]).map((c) => c.width)].join(" ");
  const passed = views.filter((v) => v.state === "success").length;
  const checked = views.filter((v) => v.state !== "queued").length;

  const runAll = () => {
    const ids = views.filter((v) => v.state !== "offline").map((v) => v.id);
    inspect.mutate(ids, {
      onSuccess: (fail) => toast(fail.length ? `巡检部分完成：${fail.join("；")}` : `巡检完成 · ${ids.length} 台`),
      onError: (e) => toast(`巡检失败：${errText(e)}`),
    });
  };
  const open = (v: MachineView) => openObject("machines", machineTab(v.raw));

  const groups: { state: MachineState; rows: MachineView[] }[] =
    prefs.group === "none" ? [{ state: "success", rows: shown }] : STATE_ORDER.map((s) => ({ state: s, rows: shown.filter((v) => v.state === s) })).filter((g) => g.rows.length);

  const inspector = selected ? (
    <MachineInspector v={selected} onClose={() => setInsp(false)} onOpen={() => open(selected)} width={inspW} />
  ) : (
    <aside className={`ry-inspector ${css.inspEmpty}`} aria-label="Inspector" style={{ width: inspW }}>
      <Empty icon="inspector" title="未选择机器">
        在列表中选择一行，这里会显示它的巡检结果、属性与活动。
      </Empty>
    </aside>
  );

  return (
    <Workspace inspector={inspector} inspectorOpen={inspOpen} inspectorWidth={inspW} onInspectorWidth={setInspW} minWidth={INSPECTOR_MIN} maxWidth={INSPECTOR_MAX}>
      <Toolbar loc label="位置与对象操作">
        <Crumbs icon="machine" current="机器" />
        <Spacer />
        {healthAt && (
          <Meta>
            上次巡检 {fmtTime(healthAt)} · {passed} / {checked || views.length} 通过
          </Meta>
        )}
        <Button icon="refresh" busy={inspect.isPending} onClick={runAll} disabled={!views.length}>
          立即巡检
        </Button>
        <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
          添加机器
        </Button>
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>

      <Toolbar label="视图：筛选、搜索与显示">
        <ChipFilter label="按角色筛选" options={roleOptions} value={role} onChange={setRole} />
        <Spacer />
        <Search ref={searchRef} value={q} onChange={setQ} aria-label="筛选机器：名称、地址、角色" />
        <DisplayMenu
          onReset={resetPrefs}
          rows={[
            { label: "分组", control: <Seg block label="分组" value={prefs.group} onChange={(group) => setPrefs({ group })} options={[{ value: "state", label: "状况" }, { value: "none", label: "不分组" }]} /> },
            { label: "排序", control: <Seg block label="排序" value={prefs.sort} onChange={(sort) => setPrefs({ sort })} options={[{ value: "state", label: "状况" }, { value: "name", label: "名称" }, { value: "last", label: "上次巡检" }]} /> },
            { label: "列", control: <DisplayChips label="列" options={COLS.map((c) => ({ value: c.key, label: c.label }))} value={prefs.cols as Record<ColKey, boolean>} onToggle={(k) => setPrefs({ cols: { ...prefs.cols, [k]: !prefs.cols[k] } })} /> },
          ]}
        />
        <IconButton icon="refresh" label={healthAt ? `刷新 · 上次 ${fmtTime(healthAt)}` : "刷新"} onClick={refetch} aria-busy={fetching || undefined} />
      </Toolbar>

      <Progress on={fetching && !loading} />
      {error && !loading && (
        <Banner actions={<Button icon="refresh" onClick={refetch}>重试</Button>}>
          <b>刷新失败</b>：{errText(error)}
          {views.length ? "。下面仍是上次读到的数据。" : ""}
        </Banner>
      )}

      <Table label="机器">
        <TableBody>
        <HeadRow cols={cols}>
          <span />
          <span>名称</span>
          {COLS.filter((c) => prefs.cols[c.key]).map((c) => (c.key === "last" ? <RowEnd key={c.key}>{c.label}</RowEnd> : <span key={c.key}>{c.label}</span>))}
        </HeadRow>
          {loading &&
            [38, 67, 56, 45, 74, 63].map((w, i) => (
              <div key={i} className="ry-row" aria-hidden="true" style={{ ["--cols" as string]: cols }}>
                <span>
                  <Skel circle />
                </span>
                <span>
                  <Skel width={64} />
                </span>
                {prefs.cols.title && (
                  <span>
                    <Skel width={`${w}%`} />
                  </span>
                )}
                {prefs.cols.ip && <span><Skel width={76} /></span>}
                {prefs.cols.driver && <span><Skel width={48} /></span>}
                {prefs.cols.user && <span><Skel width={40} /></span>}
                {prefs.cols.last && <span><Skel width={44} end /></span>}
              </div>
            ))}
          {!loading && !error && views.length === 0 && (
            <Empty icon="machine" title="集群里还没有机器" actions={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>添加机器</Button>}>
              加入机器后，Volo 才能在它们上面巡检、部署缓存和上屏。
            </Empty>
          )}
          {!loading && views.length > 0 && shown.length === 0 && <Empty icon="search" title="没有匹配的机器">换个关键词，或清除筛选。</Empty>}
          {groups.map((g) => (
            <div key={g.state} className={css.contents}>
              {prefs.group !== "none" && <GroupRow kind={STATE_KIND[g.state]} label={STATE_LABEL[g.state]} count={g.rows.length} />}
              {g.rows.map((v) => (
                <Row key={v.id} cols={cols} selected={v.id === selected?.id} onSelect={() => setSel(v.id)} onOpen={() => open(v)}>
                  <Status kind={STATE_KIND[v.state]} label={STATE_LABEL[v.state]} srOnly />
                  <span className="ry-mono">{v.host}</span>
                  {prefs.cols.title && (
                    <RowTitle tags={v.tags.map((t) => <Tag key={t}>{t}</Tag>)}>{v.summary}</RowTitle>
                  )}
                  {prefs.cols.ip && <span className="ry-mono">{v.ip}</span>}
                  {prefs.cols.driver && <span className="ry-num">{v.driver ?? "—"}</span>}
                  {prefs.cols.user && <span className="ry-mono">{v.ueUser ?? "—"}</span>}
                  {prefs.cols.last && <RowEnd>{fmtTime(v.state === "offline" ? v.lastSeen : v.checkedAt)}</RowEnd>}
                </Row>
              ))}
            </div>
          ))}
        </TableBody>
      </Table>
      {adding && <AddMachineDialog existing={views.map((v) => v.ip)} onClose={() => setAdding(false)} />}
    </Workspace>
  );
}

/* ------------------------------- Inspector ------------------------------- */

type InspTab = "checks" | "props" | "activity";

function MachineInspector({ v, onClose, onOpen, width }: { v: MachineView; onClose: () => void; onOpen: () => void; width: number }) {
  const [tab, setTab] = useState<InspTab>("checks");
  const refresh = useRefreshMachine();
  const inspect = useRunInspection();
  const remove = useRemoveMachine();
  const renameM = useRenameMachine();
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [rename, setRename] = useState(false);
  const fails = v.checks.filter((c) => c.status === "fail");
  const firstFail = fails[0];

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
              { key: "checks", label: "巡检", count: fails.length + v.findings.length, countSr: "项未通过" },
              { key: "props", label: "属性" },
              { key: "activity", label: "活动" },
            ]}
          />
        }
        meta={
          <>
            <span>{v.tags[0]}</span>
            <Status kind={STATE_KIND[v.state]} label={STATE_LABEL[v.state]} pill />
          </>
        }
        title={v.host}
        actions={
          <>
            <Button icon="open" kbd="↵" onClick={onOpen}>
              打开
            </Button>
            <Button
              icon="refresh"
              busy={inspect.isPending}
              disabled={v.state === "offline"}
              onClick={() =>
                inspect.mutate([v.id], {
                  onSuccess: (f) => toast(f.length ? `巡检部分完成：${f.join("；")}` : `${v.host} 巡检完成`),
                  onError: (e) => toast(`巡检失败：${errText(e)}`),
                })
              }
            >
              重新巡检
            </Button>
            <IconButton ref={moreRef} icon="more-h" label="更多操作" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)} />
            {moreOpen && (
              <Menu anchor={moreRef} onClose={() => setMoreOpen(false)} label="更多操作" alignEnd>
                <MenuItem
                  onSelect={() => {
                    setMoreOpen(false);
                    setRename(true);
                  }}
                >
                  编辑
                </MenuItem>
                <MenuItem
                  onSelect={() => {
                    setMoreOpen(false);
                    refresh.mutate(v.id, { onSuccess: () => toast(`已重新获取 ${v.host} 的机器信息`), onError: (e) => toast(`获取失败：${errText(e)}`) });
                  }}
                >
                  重新获取机器信息
                </MenuItem>
                <MenuItem
                  danger
                  onSelect={() => {
                    setMoreOpen(false);
                    setConfirm(true);
                  }}
                >
                  移除机器
                </MenuItem>
              </Menu>
            )}
          </>
        }
      />
      <InspectorBody>
        {tab === "checks" && (
          <>
            {firstFail && (
              <Note
                kind="failed"
                actions={
                  <>
                    <Button onClick={onOpen}>查看修复步骤</Button>
                  </>
                }
              >
                {firstFail.remediation || firstFail.message || `${firstFail.label}未通过。`}
              </Note>
            )}
            {!firstFail && v.findings[0] && (
              <Note kind="failed" actions={<Button onClick={onOpen}>查看修复步骤</Button>}>
                {v.findings[0].symptom}
              </Note>
            )}
            {v.checks.length === 0 ? (
              <p className={css.muted}>{v.state === "offline" ? "这台机器连不上，没有巡检结果。" : "还没有巡检过。点“重新巡检”跑一次。"}</p>
            ) : (
              <Activity
                style={{ gap: 10, marginTop: firstFail || v.findings[0] ? 16 : 0 }}
                items={v.checks.map((c) => ({
                  key: c.key,
                  icon: c.status === "pass" ? "success" : c.status === "fail" ? "failed" : c.status === "offline" ? "offline" : "queued",
                  iconColor: c.status === "pass" ? "var(--status-success)" : c.status === "fail" ? "var(--status-failed)" : undefined,
                  text: c.label,
                  time: c.status === "pass" ? "通过" : c.status === "fail" ? "未通过" : c.status === "offline" ? "连不上" : "跳过",
                }))}
              />
            )}
            <Props
              style={{ marginTop: 20 }}
              items={[
                { label: "上屏", value: v.output ? <span>节点 <span className="ry-mono">{v.output.node}</span>{v.output.primary ? " · 主节点" : ""}</span> : null },
                { label: "地址", value: <span className="ry-mono">{v.ip}</span> },
                { label: "通道", value: null },
                { label: "巡检于", value: v.checkedAt ? <span className="ry-num">{fmtFull(v.checkedAt)}</span> : null },
                {
                  label: "命令",
                  value: <span className="ry-mono">voloctl health run</span>,
                  action: <IconButton size="sm" icon="copy" label="复制等效命令" onClick={() => copyText("voloctl health run")} />,
                },
              ]}
            />
          </>
        )}
        {tab === "props" && (
          <Props
            items={[
              { label: "名称", value: v.host },
              { label: "地址", value: <span className="ry-mono">{v.ip}</span> },
              { label: "角色", value: ROLE_LABEL[v.role] },
              { label: "GPU", value: v.gpuModel },
              { label: "GPU 驱动", value: v.driver ? <span className="ry-num">{v.driver}{v.driverMismatch ? " · 与集群不一致" : ""}</span> : null },
              { label: "UE 运行用户", value: v.ueUser ? <span className="ry-mono">{v.ueUser}</span> : null },
              { label: "上次在线", value: v.lastSeen ? <span className="ry-num">{fmtFull(v.lastSeen)}</span> : null },
              { label: "机器 ID", value: v.uid ? <span className="ry-mono">{v.uid}</span> : null },
            ]}
          />
        )}
        {tab === "activity" && (
          <Empty icon="clock" title="还没有活动记录">
            这台机器上的操作记录接入后会显示在这里。
          </Empty>
        )}
      </InspectorBody>
      {rename && (
        <PromptDialog
          title={`给 ${v.host} 改名`}
          body="只改 Volo 里的显示名，不会改这台机器的系统主机名。"
          label="名称"
          mono
          initial={v.host}
          submitLabel="改名"
          busy={renameM.isPending}
          onClose={() => setRename(false)}
          onSubmit={(hostname) =>
            renameM.mutate({ id: v.id, hostname }, { onSuccess: () => (setRename(false), toast(`已改名为 ${hostname}`)), onError: (e) => toast(`改名失败：${errText(e)}`) })
          }
        />
      )}
      {confirm && (
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
          onClose={() => setConfirm(false)}
          onConfirm={() =>
            remove.mutate(v.id, {
              onSuccess: () => {
                setConfirm(false);
                toast(`${v.host} 已从集群移除`);
              },
              onError: (e) => toast(`移除失败：${errText(e)}`),
            })
          }
        />
      )}
    </Inspector>
  );
}
