/* 新外壳（设计：LAN-36 画布 App.dc.html / Main.dc.html）。
   ry-window = 侧栏（窗口地面）+ 右列（标签栏 + 内容卡片 ry-card）；页面只渲染卡片里的工作区。 */
import { Suspense, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listMachines, listProjects } from "@/api/commands";
import { isTauri } from "@/api/invoke";
import { machineTab, projectTab, useAutoPatrol } from "@/features/cache";
import { useGeneralSettings } from "@/features/settings";
import { CommandPalette, OVERLAY_ID, Toast, TooltipLayer, type PaletteItem } from "@/ui";
import { useNav } from "@/lib/nav";
import { useToastStore } from "@/lib/toast";
import { PAGES, findPage } from "./pages";
import { Sidebar } from "./Sidebar";
import { WindowBar } from "./WindowBar";
import { useShellStore } from "./shellStore";
import css from "./AppShell.module.css";

export function AppShell() {
  const page = useNav((s) => s.page);
  const go = useNav((s) => s.go);
  const openObject = useNav((s) => s.openObject);
  const theme = useShellStore((s) => s.theme);
  const density = useShellStore((s) => s.density);
  const side = useShellStore((s) => s.side);
  const setTheme = useShellStore((s) => s.setTheme);
  const setDensity = useShellStore((s) => s.setDensity);
  const toggleSide = useShellStore((s) => s.toggleSide);
  const toastText = useToastStore((s) => s.text);
  const [palette, setPalette] = useState(false);

  /* 跟随系统：按 prefers-color-scheme 改主题（不经 setTheme，免得关掉跟随）。 */
  const followSystem = useShellStore((s) => s.followSystem);
  useEffect(() => {
    if (!followSystem) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => useShellStore.setState({ theme: mq.matches ? "dark" : "light" });
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [followSystem]);

  /* 设置 › 巡检：启动时 / 定时巡检全部在线机器。 */
  const patrol = useGeneralSettings();
  useAutoPatrol({ onStart: patrol.patrolOnStart, everyMin: patrol.patrolTimed ? Number(patrol.patrolMinutes) || null : null });

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-ry-density", density);
  }, [theme, density]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const machines = useQuery({ queryKey: ["cache", "machines"], queryFn: listMachines, enabled: isTauri() && palette });
  const projects = useQuery({ queryKey: ["cache", "projects"], queryFn: listProjects, enabled: isTauri() && palette });

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    for (const m of machines.data ?? []) {
      out.push({ id: `m:${m.id}`, group: "对象", icon: "machine", title: m.hostname, sub: `机器 · ${m.ip}`, keywords: m.ip, run: () => openObject("machines", machineTab(m)) });
    }
    for (const p of projects.data ?? []) {
      out.push({ id: `p:${p.id}`, group: "对象", icon: "project", title: p.display_name || p.uproject_name, sub: `工程 · ${p.uproject_name}`, run: () => openObject("projects", projectTab(p)) });
    }
    for (const p of PAGES) {
      out.push({ id: `nav:${p.id}`, group: "导航", icon: p.icon, title: `前往 ${p.label}`, run: () => go(p.id) });
    }
    out.push(
      { id: "cmd:theme", group: "界面", icon: "sun", title: theme === "dark" ? "切换到浅色主题" : "切换到深色主题", run: () => setTheme(theme === "dark" ? "light" : "dark") },
      { id: "cmd:density", group: "界面", icon: "density", title: density === "comfortable" ? "切换到紧凑密度" : "切换到舒适密度", run: () => setDensity(density === "comfortable" ? "compact" : "comfortable") },
      { id: "cmd:side", group: "界面", icon: "sidebar", title: side ? "收起导航" : "展开导航", run: toggleSide },
    );
    return out;
  }, [machines.data, projects.data, theme, density, side, go, openObject, setTheme, setDensity, toggleSide]);

  const def = findPage(page);
  const Page = def.component;

  return (
    <div className={`ry ry-window ${css.window} ${isTauri() ? css.native : ""}`} data-theme={theme} data-ry-density={density}>
      {side && <Sidebar onSearch={() => setPalette(true)} />}
      <div className="ry-col">
        <WindowBar onOpenPalette={() => setPalette(true)} />
        <div className="ry-card">
          <Suspense fallback={<main className="ry-main" />}><Page key={page} /></Suspense>
        </div>
      </div>
      <div id={OVERLAY_ID} className={css.overlay}>
        {palette && <CommandPalette items={items} onClose={() => setPalette(false)} />}
        {toastText && <Toast>{toastText}</Toast>}
      </div>
      <TooltipLayer />
    </div>
  );
}
