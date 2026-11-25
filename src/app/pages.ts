/* 唯一的页面表（frontend-structure.md §5）。侧栏结构按 LAN-36 画布（Sidebar.dc.html）：
   概览 / 待处理 / 任务 · 舞台（LED：屏幕 → 上屏 → 摄影机 → 重建；AR：标记 → 摄影机 → 空间求解 → 验证）
   · 集群（机器 / 工程 / 缓存 / PSO 预热）· 工具（键控实验 / 追踪模拟）· 设置与凭据。 */
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { IconName } from "@/ui";
import type { PageId } from "@/lib/nav";

export type NavGroup = "top" | "stage-led" | "stage-ar" | "cluster" | "tools" | "bottom";

export interface PageDef {
  id: PageId;
  label: string;
  icon: IconName;
  group: NavGroup;
  component: LazyExoticComponent<ComponentType>;
}

const cache = () => import("@/features/cache");
const led = () => import("@/features/led");
const ar = () => import("@/features/ar");
const tools = () => import("@/features/tools");
const settings = () => import("@/features/settings");
const tasks = () => import("@/features/tasks");

export const PAGES: readonly PageDef[] = [
  { id: "overview", label: "概览", icon: "overview", group: "top", component: lazy(() => import("@/features/overview").then((m) => ({ default: m.OverviewPage }))) },
  { id: "inbox", label: "待处理", icon: "inbox", group: "top", component: lazy(() => tasks().then((m) => ({ default: m.InboxPage }))) },
  { id: "tasks", label: "任务", icon: "tasks", group: "top", component: lazy(() => tasks().then((m) => ({ default: m.TasksPage }))) },
  { id: "screens", label: "屏幕", icon: "screens", group: "stage-led", component: lazy(() => led().then((m) => ({ default: m.ScreensPage }))) },
  { id: "output", label: "上屏", icon: "output", group: "stage-led", component: lazy(() => led().then((m) => ({ default: m.OutputPage }))) },
  { id: "camera", label: "摄影机", icon: "camera", group: "stage-led", component: lazy(() => import("./CameraRoute").then((m) => ({ default: m.CameraRoute }))) },
  { id: "rebuild", label: "重建", icon: "rebuild", group: "stage-led", component: lazy(() => led().then((m) => ({ default: m.RebuildPage }))) },
  { id: "markers", label: "标记", icon: "marker", group: "stage-ar", component: lazy(() => ar().then((m) => ({ default: m.MarkersPage }))) },
  { id: "spatial", label: "空间求解", icon: "spatial", group: "stage-ar", component: lazy(() => ar().then((m) => ({ default: m.SpatialPage }))) },
  { id: "verify", label: "验证", icon: "verify", group: "stage-ar", component: lazy(() => ar().then((m) => ({ default: m.VerifyPage }))) },
  { id: "machines", label: "机器", icon: "machine", group: "cluster", component: lazy(() => cache().then((m) => ({ default: m.MachinesPage }))) },
  { id: "projects", label: "工程", icon: "project", group: "cluster", component: lazy(() => cache().then((m) => ({ default: m.ProjectsPage }))) },
  { id: "cache", label: "缓存", icon: "cache", group: "cluster", component: lazy(() => cache().then((m) => ({ default: m.CachePage }))) },
  { id: "pso", label: "PSO 预热", icon: "pso", group: "cluster", component: lazy(() => cache().then((m) => ({ default: m.PsoPage }))) },
  { id: "keyer", label: "键控实验", icon: "keyer", group: "tools", component: lazy(() => tools().then((m) => ({ default: m.KeyerPage }))) },
  { id: "tracksim", label: "追踪模拟", icon: "tracksim", group: "tools", component: lazy(() => tools().then((m) => ({ default: m.TracksimPage }))) },
  { id: "settings", label: "设置与凭据", icon: "sliders", group: "bottom", component: lazy(() => settings().then((m) => ({ default: m.SettingsPage }))) },
];

export function findPage(id: PageId): PageDef {
  return PAGES.find((p) => p.id === id) ?? PAGES.find((p) => p.id === "machines")!;
}
