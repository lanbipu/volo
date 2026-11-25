/* 集群 › 工程（设计：Projects.dc.html 列表、ProjectsCards.dc.html 卡片、ProjectScan、ProjectDetail）。 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listMachines } from "@/api/commands";
import { isTauri } from "@/api/invoke";
import { getStageMembership } from "@/api/stageCommands";
import { useCurrentStage } from "@/features/stage";
import { useActiveObject, useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN } from "@/lib/nav";
import { copyText } from "@/lib/clipboard";
import { errText, toast } from "@/lib/toast";
import {
  Banner,
  Button,
  ChipFilter,
  ConfirmDialog,
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
  Note,
  Progress,
  Props,
  Row,
  RowEnd,
  RowTitle,
  Search,
  Seg,
  Sep,
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
import { cacheKeys, fmtFull, fmtTime } from "../model/machines";
import { humanBytes, openFolderOn, projectTab, PROJECT_KIND, PROJECT_STATE_LABEL, PSO_REASON, useDeleteProject, useProjects, useThumbs, type ProjectState, type ProjectView } from "../model/projects";
import { useViewPrefs } from "../model/viewPrefs";
import { ProjectDetail } from "./ProjectDetail";
import { ProjectScanDialog } from "./ProjectScanDialog";
import css from "./cache.module.css";

const STATE_ORDER: ProjectState[] = ["attention", "queued", "success"];
type Filter = "all" | "pso" | "nopak" | "partial";
type ColKey = "machines" | "ue" | "cache" | "pak" | "pso" | "last";
const COLS: { key: ColKey; label: string; width: string; end?: boolean }[] = [
  { key: "machines", label: "所在机器", width: "minmax(160px, 1fr)" },
  { key: "ue", label: "引擎", width: "64px", end: true },
  { key: "cache", label: "缓存", width: "132px" },
  { key: "pak", label: "PAK 预置包", width: "132px" },
  { key: "pso", label: "PSO 预热", width: "132px" },
  { key: "last", label: "上次变动", width: "92px", end: true },
];

export function ProjectsPage() {
  const active = useActiveObject("projects");
  const id = active?.startsWith("project:") ? Number(active.slice(8)) : null;
  return id != null && Number.isFinite(id) ? <ProjectDetail id={id} /> : <ProjectsList />;
}

export function useClusterMachines() {
  return useQuery({ queryKey: cacheKeys.machines, queryFn: listMachines, enabled: isTauri() });
}

function ProjectsList() {
  const { views, loading, fetching, error, updatedAt, refetch } = useProjects();
  const machines = useClusterMachines();
  const openObject = useNav((s) => s.openObject);
  const [inspOpen, setInsp] = useInspector("projects");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [prefs, setPrefs, resetPrefs] = useViewPrefs("projects", {
    view: "list",
    group: "state",
    sort: "last",
    cols: { machines: true, ue: true, cache: true, pak: true, pso: true, last: true, reason: true, time: true },
  });
  const cards = prefs.view === "cards";
  const thumbs = useThumbs(views, cards);

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

  const needsPso = (v: ProjectView) => v.psoReady < v.copies.filter((c) => !c.offline).length;
  const counts = { all: views.length, pso: views.filter(needsPso).length, nopak: views.filter((v) => v.pakCount === 0).length, partial: views.filter((v) => v.pakCount > 0 && v.pakCount < v.copies.length).length };

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    let list = views.filter((v) => filter === "all" || (filter === "pso" ? needsPso(v) : filter === "nopak" ? v.pakCount === 0 : v.pakCount > 0 && v.pakCount < v.copies.length));
    if (s) list = list.filter((v) => `${v.name} ${v.uproject} ${v.copies.map((c) => `${c.host} ${c.loc.abs_path}`).join(" ")}`.toLowerCase().includes(s));
    const byName = (a: ProjectView, b: ProjectView) => a.name.localeCompare(b.name, "zh-CN", { numeric: true });
    if (prefs.sort === "name") return [...list].sort(byName);
    if (prefs.sort === "size") return [...list].sort((a, b) => (thumbs.get(b.id)?.size ?? 0) - (thumbs.get(a.id)?.size ?? 0) || byName(a, b));
    return [...list].sort((a, b) => (b.lastChange ?? "").localeCompare(a.lastChange ?? "") || byName(a, b));
  }, [views, filter, q, prefs.sort, thumbs]);

  const groups: { key: string; kind?: StatusKind; label: string; rows: ProjectView[] }[] =
    prefs.group === "none"
      ? [{ key: "all", label: "", rows: shown }]
      : prefs.group === "ue"
        ? Array.from(new Set(shown.map((v) => v.ue ?? "—"))).map((ue) => ({ key: ue, label: ue === "—" ? "引擎版本未知" : `UE ${ue}`, rows: shown.filter((v) => (v.ue ?? "—") === ue) }))
        : STATE_ORDER.map((s) => ({ key: s, kind: PROJECT_KIND[s], label: PROJECT_STATE_LABEL[s], rows: shown.filter((v) => v.state === s) })).filter((g) => g.rows.length);

  const selected = views.find((v) => v.id === sel) ?? groups[0]?.rows[0] ?? null;
  const open = (v: ProjectView) => openObject("projects", projectTab(v.raw));
  const cols = ["16px", "132px", ...COLS.filter((c) => prefs.cols[c.key]).map((c) => c.width)].join(" ");

  const inspector = selected ? (
    <ProjectInspector v={selected} width={inspW} thumb={cards ? (thumbs.get(selected.id)?.src ?? null) : null} onClose={() => setInsp(false)} onOpen={() => open(selected)} />
  ) : (
    <aside className={`ry-inspector ${css.inspEmpty}`} aria-label="Inspector" style={{ width: inspW }}>
      <Empty icon="inspector" title="未选择工程">
        在列表中选择一个工程，这里会显示它在哪些机器上、PAK 与 PSO 的状况。
      </Empty>
    </aside>
  );

  return (
    <Workspace inspector={inspector} inspectorOpen={inspOpen} inspectorWidth={inspW} onInspectorWidth={setInspW} minWidth={INSPECTOR_MIN} maxWidth={INSPECTOR_MAX}>
      <Toolbar loc label="位置与对象操作">
        <Crumbs icon="project" current="工程" />
        <Spacer />
        <Button variant="primary" icon="search" onClick={() => setScanning(true)}>
          扫描工程
        </Button>
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>

      <Toolbar label="视图：筛选、搜索与显示">
        <ChipFilter
          label="按状况筛选"
          value={filter}
          onChange={setFilter}
          options={[
            { key: "all", label: "全部", count: counts.all },
            { key: "pso", label: "需要预热", count: counts.pso },
            { key: "nopak", label: "没有 PAK", count: counts.nopak },
            { key: "partial", label: "没有分发完", count: counts.partial },
          ]}
        />
        <Spacer />
        <Search ref={searchRef} value={q} onChange={setQ} aria-label="筛选工程：名称、路径、机器" />
        <DisplayMenu
          onReset={resetPrefs}
          rows={[
            { label: "视图", control: <Seg block label="视图" value={prefs.view ?? "list"} onChange={(view) => setPrefs({ view })} options={[{ value: "list", label: "列表" }, { value: "cards", label: "卡片" }]} /> },
            { label: "分组", control: <Seg block label="分组" value={prefs.group} onChange={(group) => setPrefs({ group })} options={[{ value: "state", label: "状况" }, { value: "ue", label: "引擎版本" }, { value: "none", label: "不分组" }]} /> },
            { label: "排序", control: <Seg block label="排序" value={prefs.sort} onChange={(sort) => setPrefs({ sort })} options={[{ value: "last", label: "上次变动" }, { value: "name", label: "名称" }, { value: "size", label: "大小" }]} /> },
            cards
              ? { label: "卡片上显示", control: <DisplayChips label="卡片上显示" options={[{ value: "reason", label: "状况说明" }, { value: "time", label: "上次变动" }]} value={prefs.cols as Record<"reason" | "time", boolean>} onToggle={(k) => setPrefs({ cols: { ...prefs.cols, [k]: !prefs.cols[k] } })} /> }
              : { label: "列", control: <DisplayChips label="列" options={COLS.map((c) => ({ value: c.key, label: c.label }))} value={prefs.cols as Record<ColKey, boolean>} onToggle={(k) => setPrefs({ cols: { ...prefs.cols, [k]: !prefs.cols[k] } })} /> },
          ]}
        />
        <IconButton icon="refresh" label={updatedAt ? `刷新 · 上次扫描 ${new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : "刷新"} onClick={refetch} aria-busy={fetching || undefined} />
      </Toolbar>

      <Progress on={fetching && !loading} />
      {error && !loading && (
        <Banner actions={<Button icon="refresh" onClick={refetch}>重试</Button>}>
          <b>刷新失败</b>：{errText(error)}
        </Banner>
      )}

      {!loading && !error && views.length === 0 && (
        <Empty icon="project" title="还没有发现工程" actions={<Button variant="primary" icon="search" onClick={() => setScanning(true)}>扫描工程</Button>}>
          扫描一次，Volo 会记下每台机器上的 UE 工程，之后才能生成 PAK、预热 PSO。
        </Empty>
      )}
      {!loading && views.length > 0 && shown.length === 0 && <Empty icon="search" title="没有匹配的工程">换个关键词，或清除筛选。</Empty>}

      {cards ? (
        <div className={css.scroll}>
          <div className="volo-cards" role="grid" aria-label="工程">
            {groups.map((g) => (
              <Fragment key={g.key}>
                {prefs.group !== "none" && <GroupRow kind={g.kind} label={g.label} count={g.rows.length} />}
                {g.rows.map((v) => {
                  const t = thumbs.get(v.id);
                  return (
                    <button
                      key={v.id}
                      type="button"
                      className="volo-card"
                      role="row"
                      aria-selected={v.id === selected?.id}
                      onClick={() => setSel(v.id)}
                      onDoubleClick={() => open(v)}
                      onKeyDown={(e) => e.key === "Enter" && open(v)}
                    >
                      <span className="volo-card__thumb">
                        {t?.src ? (
                          <img className="volo-card__img" src={t.src} alt={`${v.name} 的工程截图`} />
                        ) : (
                          <>
                            <span className="volo-card__mono" aria-hidden="true">
                              {v.name.replace(/[^A-Za-z0-9]/g, "").replace(/[a-z0-9]/g, "").slice(0, 2) || v.name.slice(0, 2).toUpperCase()}
                            </span>
                            <span className="volo-card__nothumb">没有截图</span>
                          </>
                        )}
                      </span>
                      <span className="volo-card__body">
                        <span className="volo-card__head">
                          <span className="volo-card__name">{v.name}</span>
                          {prefs.cols.time && <span className="volo-card__time">{fmtTime(v.lastChange)}</span>}
                        </span>
                        <span className="volo-card__sub">
                          <Status kind={PROJECT_KIND[v.state]} label={PROJECT_STATE_LABEL[v.state]} />
                          {prefs.cols.reason && <span className="volo-card__reason">{v.reason}</span>}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>
      ) : (
        <Table label="工程">
          <TableBody>
            <HeadRow cols={cols}>
              <span />
              <span>名称</span>
              {COLS.filter((c) => prefs.cols[c.key]).map((c) => (c.end ? <RowEnd key={c.key}>{c.label}</RowEnd> : <span key={c.key}>{c.label}</span>))}
            </HeadRow>
            {loading &&
              [52, 70, 44].map((w, i) => (
                <div key={i} className="ry-row" aria-hidden="true" style={{ ["--cols" as string]: cols }}>
                  <span>
                    <Skel circle />
                  </span>
                  <span>
                    <Skel width={72} />
                  </span>
                  {COLS.filter((c) => prefs.cols[c.key]).map((c) => (
                    <span key={c.key}>
                      <Skel width={c.key === "machines" ? `${w}%` : 48} end={c.end} />
                    </span>
                  ))}
                </div>
              ))}
            {groups.map((g) => (
              <div key={g.key} className={css.contents}>
                {prefs.group !== "none" && <GroupRow kind={g.kind} label={g.label} count={g.rows.length} />}
                {g.rows.map((v) => (
                  <Row key={v.id} cols={cols} selected={v.id === selected?.id} onSelect={() => setSel(v.id)} onOpen={() => open(v)}>
                    <Status kind={PROJECT_KIND[v.state]} label={PROJECT_STATE_LABEL[v.state]} srOnly />
                    <span className={`ry-row__id ${css.idPrimary}`}>{v.name}</span>
                    {prefs.cols.machines && <RowTitle tags={v.source ? <Tag>主 {v.source.host}</Tag> : undefined}>{v.copies.length} 台</RowTitle>}
                    {prefs.cols.ue && <RowEnd>{v.ue ?? "—"}</RowEnd>}
                    {prefs.cols.cache && <span className={css.sec}>—</span>}
                    {prefs.cols.pak && <span className={css.sec}>{v.pakText}</span>}
                    {prefs.cols.pso && <span className={css.sec}>{v.psoText}</span>}
                    {prefs.cols.last && <RowEnd>{fmtTime(v.lastChange)}</RowEnd>}
                  </Row>
                ))}
              </div>
            ))}
          </TableBody>
        </Table>
      )}
      {scanning && <ProjectScanDialog machines={machines.data ?? []} onClose={() => setScanning(false)} />}
    </Workspace>
  );
}

/* ------------------------------- Inspector ------------------------------- */

function ProjectInspector({ v, width, thumb, onClose, onOpen }: { v: ProjectView; width: number; thumb: string | null; onClose: () => void; onOpen: () => void }) {
  const [tab, setTab] = useState<"overview" | "activity">("overview");
  const go = useNav((s) => s.go);
  const machines = useClusterMachines();
  const { stage } = useCurrentStage();
  const member = useQuery({ queryKey: ["stage", "membership", stage?.stageId ?? ""], queryFn: () => getStageMembership(stage?.stageId as string), enabled: isTauri() && !!stage?.stageId });
  const remove = useDeleteProject();
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [opening, setOpening] = useState(false);

  const degraded = v.copies.filter((c) => c.pso?.status === "degraded");
  const reasons = Array.from(new Set(degraded.flatMap((c) => c.pso?.invalidation_reasons.map((r) => PSO_REASON[r.reason] ?? r.reason) ?? [])));
  const mainPath = v.source?.loc.abs_path;
  const pakSize = v.copies.find((c) => c.pak)?.pak?.size_bytes;
  const firstSeen = v.copies.map((c) => c.loc.discovered_at).filter((x): x is string => !!x).sort()[0] ?? null;

  const openFolder = () => {
    const src = v.source;
    if (!src?.machine) return toast("找不到这个工程所在的机器");
    setOpening(true);
    openFolderOn(src.machine, src.loc.abs_path, machines.data ?? [])
      .catch((e) => toast(`打开文件夹失败：${errText(e)}`))
      .finally(() => setOpening(false));
  };

  return (
    <Inspector width={width}>
      <InspectorHead
        onClose={onClose}
        tabs={<ToolTabs label="Inspector 内容" value={tab} onChange={setTab} tabs={[{ key: "overview", label: "概况" }, { key: "activity", label: "活动" }]} />}
        meta={
          <>
            <span>工程</span>
            <Status kind={PROJECT_KIND[v.state]} label={PROJECT_STATE_LABEL[v.state]} pill />
          </>
        }
        title={v.name}
        actions={
          <>
            <Button icon="open" kbd="↵" onClick={onOpen}>
              打开
            </Button>
            <Button icon="project" busy={opening} disabled={!v.source?.machine} onClick={openFolder}>
              在源机上打开文件夹
            </Button>
            <IconButton ref={moreRef} icon="more" label="更多操作：更换源机器、从 Volo 移除记录" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)} />
            {moreOpen && (
              <Menu anchor={moreRef} onClose={() => setMoreOpen(false)} label="更多操作" alignEnd>
                <MenuItem disabled onSelect={() => undefined}>
                  更换源机器
                </MenuItem>
                <MenuItem danger onSelect={() => (setMoreOpen(false), setConfirm(true))}>
                  从 Volo 移除记录
                </MenuItem>
              </Menu>
            )}
          </>
        }
      />
      <InspectorBody>
        {tab === "overview" && (
          <>
            {thumb && (
              <>
                <div className={`volo-card__thumb ${css.thumbBox}`}>
                  <img className="volo-card__img" src={thumb} alt={`${v.name} 的工程截图`} />
                </div>
                <p className={`volo-field__hint ${css.thumbHint}`}>截图取自工程目录：先找与 .uproject 同名的 PNG，没有就用 Saved 里编辑器自动存的那张。</p>
              </>
            )}
            {degraded.length > 0 && (
              <Note kind="attention" actions={<Button onClick={() => go("pso")}>去“PSO 预热”</Button>}>
                {degraded.map((c) => c.host).join("、")} 上的 PSO 预热已过期{reasons.length ? `，因为${reasons.join("、")}` : ""}。
                {v.psoReady ? `另外 ${v.psoReady} 台就绪。` : ""}
              </Note>
            )}
            {v.driftNote && <Note kind="attention">{v.driftNote}</Note>}
            <h3 className={`volo-fields__title ${css.sectionTitle}`}>它在哪些机器上</h3>
            <ul className={css.copyList}>
              {v.copies.map((c) => {
                const kind: StatusKind = c.offline ? "offline" : c.pso?.status === "degraded" ? "attention" : c.pso?.status === "ok" ? "success" : "queued";
                const label = c.offline ? "离线" : c.pso?.status === "degraded" ? "已过期" : c.pso?.status === "ok" ? "就绪" : "未预热";
                const notes = [c === v.source ? "源机器" : null, c.pak ? `PAK ${humanBytes(c.pak.size_bytes)}` : null, mainPath && c.loc.abs_path !== mainPath ? "路径和其他机器不同" : null, c.offline ? "离线前的记录" : null].filter(Boolean);
                return (
                  <li key={c.loc.id ?? c.loc.machine_id} className={css.copyItem}>
                    <Status kind={kind} label={label} srOnly />
                    <span className={css.idPrimary}>{c.host}</span>
                    <span className={css.hostText}>
                      <span className={`ry-mono ${css.copyPath}`}>{c.loc.abs_path}</span>
                      {notes.length > 0 && <span className={`ry-meta ${css.hostNote}`}>{notes.join(" · ")}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
            <Props
              items={[
                { label: "引擎", value: v.ue ? `UE ${v.ue}` : null },
                { label: "缓存", value: null },
                { label: "PAK", value: v.pakCount ? `${humanBytes(pakSize)} · ${v.pakCount === v.copies.length ? `${v.copies.length} 台都有` : `${v.pakCount} / ${v.copies.length} 台有`}` : "还没有生成" },
                { label: "Stage", value: stage && member.data?.project_ids.includes(v.id) ? stage.name : null },
                { label: "发现于", value: firstSeen ? <span className="ry-num">{fmtFull(firstSeen)}</span> : null },
                {
                  label: "命令",
                  value: <span className="ry-mono">voloctl project locations {v.id}</span>,
                  action: <IconButton size="sm" icon="copy" label="复制等效命令" onClick={() => copyText(`voloctl project locations ${v.id}`)} />,
                },
              ]}
            />
          </>
        )}
        {tab === "activity" && (
          <Empty icon="clock" title="还没有活动记录">
            这个工程的扫描、生成 PAK 与预热记录接入后会显示在这里。
          </Empty>
        )}
      </InspectorBody>
      {confirm && (
        <ConfirmDialog
          title={`从 Volo 移除 ${v.name} 的记录？`}
          body="只删除 Volo 里这个工程和它在各机器上的位置记录，磁盘上的工程文件、PAK 和缓存都不动。重新扫描就能找回。"
          props={[
            { label: "影响", value: <span className="ry-mono">{v.copies.map((c) => c.host).join(" · ") || "—"}</span> },
            { label: "可恢复", value: "是，重新扫描工程即可" },
          ]}
          command={`voloctl project delete ${v.id} --yes`}
          safeLabel="保留"
          dangerLabel="移除记录"
          dangerIcon="close"
          busy={remove.isPending}
          onClose={() => setConfirm(false)}
          onConfirm={() =>
            remove.mutate(v.id, {
              onSuccess: () => (setConfirm(false), toast(`已移除 ${v.name} 的记录`)),
              onError: (e) => toast(`移除失败：${errText(e)}`),
            })
          }
        />
      )}
    </Inspector>
  );
}
