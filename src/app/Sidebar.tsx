/* 工作区导航（设计：Sidebar.dc.html）。舞台分组按当前 Stage 类型显示 LED 或 AR 的页。 */
import { useQuery } from "@tanstack/react-query";
import { listMachines, listProjects } from "@/api/commands";
import { isTauri } from "@/api/invoke";
import { StageSwitcher, useCurrentStage } from "@/features/stage";
import { useInboxBadge } from "@/features/tasks";
import { Caret, Icon, IconButton } from "@/ui";
import { useNav, type PageId } from "@/lib/nav";
import { PAGES, type NavGroup, type PageDef } from "./pages";
import { useShellStore } from "./shellStore";
import css from "./AppShell.module.css";

function NavItem({ def, count, box, sr }: { def: PageDef; count?: number | null; box?: boolean; sr?: string }) {
  const page = useNav((s) => s.page);
  const go = useNav((s) => s.go);
  return (
    <button type="button" className="ry-navitem" aria-current={page === def.id ? "page" : "false"} onClick={() => go(def.id)}>
      <Icon name={def.icon} />
      <span className="ry-navitem__label">{def.label}</span>
      {count != null && count > 0 && (
        <span className={box ? "ry-navitem__count ry-navitem__count--box" : "ry-navitem__count"}>
          {count}
          {sr && <span className="ry-sr"> {sr}</span>}
        </span>
      )}
    </button>
  );
}

function GroupHead({ id, label }: { id: string; label: string }) {
  const collapsed = useShellStore((s) => !!s.collapsed[id]);
  const toggle = useShellStore((s) => s.toggleGroup);
  return (
    <button type="button" className="ry-navgroup" aria-expanded={!collapsed} onClick={() => toggle(id)}>
      {label}
      <Caret />
    </button>
  );
}

export function Sidebar({ onSearch }: { onSearch: () => void }) {
  const toggleSide = useShellStore((s) => s.toggleSide);
  const collapsed = useShellStore((s) => s.collapsed);
  const { stage } = useCurrentStage();
  const machines = useQuery({ queryKey: ["cache", "machines"], queryFn: listMachines, enabled: isTauri() });
  const projects = useQuery({ queryKey: ["cache", "projects"], queryFn: listProjects, enabled: isTauri() });

  const badge = useInboxBadge();
  const counts: Partial<Record<PageId, number | null>> = {
    inbox: badge.inbox,
    tasks: badge.tasks,
    machines: machines.data?.length ?? null,
    projects: projects.data?.length ?? null,
    screens: stage?.config ? Object.keys(stage.config.screens ?? {}).length : null,
    camera: stage?.config?.cameras?.length ?? null,
  };
  const of = (g: NavGroup) => PAGES.filter((p) => p.group === g);
  const stageGroup: NavGroup = stage?.type === "ar" ? "stage-ar" : "stage-led";
  /* AR 舞台的“摄影机”在标记之后（Sidebar.dc.html）。 */
  const stagePages = stageGroup === "stage-ar" ? [of("stage-ar")[0], PAGES.find((p) => p.id === "camera")!, ...of("stage-ar").slice(1)] : of("stage-led");

  return (
    <nav className={`ry-sidebar ${css.sidebar}`} aria-label="工作区导航">
      <div className="ry-sidebar__top" data-tauri-drag-region>
        <span className="ry-lights" aria-hidden="true" data-native-lights>
          <i />
          <i />
          <i />
        </span>
        <span className="ry-toolbar__spacer" data-tauri-drag-region />
        <IconButton icon="sidebar" label="收起导航" pressed onClick={toggleSide} />
      </div>
      <StageSwitcher onSearch={onSearch} />

      {of("top").map((p) => (
        <NavItem key={p.id} def={p} count={counts[p.id]} box={p.id === "inbox"} sr={p.id === "inbox" ? "项待处理" : undefined} />
      ))}

      {stage && (
        <>
          <GroupHead id="stage" label={stageGroup === "stage-ar" ? "舞台 · AR" : "舞台 · LED"} />
          {!collapsed.stage && stagePages.map((p) => <NavItem key={p.id} def={p} count={counts[p.id]} />)}
        </>
      )}

      <GroupHead id="cluster" label="集群" />
      {!collapsed.cluster && of("cluster").map((p) => <NavItem key={p.id} def={p} count={counts[p.id]} />)}

      <GroupHead id="tools" label="工具" />
      {!collapsed.tools && of("tools").map((p) => <NavItem key={p.id} def={p} />)}

      <div className="ry-sidebar__grow" />
      {of("bottom").map((p) => (
        <NavItem key={p.id} def={p} count={counts[p.id]} box={p.id === "inbox"} sr={p.id === "inbox" ? "项待处理" : undefined} />
      ))}
    </nav>
  );
}
