// Volo · 应用外壳数据 —— 页签 / Stage / 菜单（移植自原型 data.jsx）。
import type { IconName } from "../features/cache/ui/Icon";

export interface PageDef {
  id: PageId;
  label: string;
  icon: IconName;
  skeleton: boolean;
  title: string;
  sub: string;
}

export type PageId = "previz" | "calibrate" | "color" | "live" | "tools";

// 1:1 还原 Volo.html：5 个页签，缓存控制台在「工具(tools)」页下。
// 非缓存页（含 calibrate）按用户选择走占位骨架（skeleton:true）。
export const PAGES: PageDef[] = [
  { id: "previz", label: "预演", icon: "previz", skeleton: true, title: "预可视化", sub: "场景布局与机位走位" },
  { id: "calibrate", label: "校正", icon: "calibrate", skeleton: false, title: "Calibrate", sub: "LED 网格重建 → 镜头校正" },
  { id: "color", label: "调色", icon: "color", skeleton: true, title: "调色", sub: "屏幕 LUT 与一级" },
  { id: "live", label: "现场", icon: "live", skeleton: true, title: "现场", sub: "现场回放与录制" },
  { id: "tools", label: "工具", icon: "tools", skeleton: false, title: "工具", sub: "渲染缓存 · 诊断" },
];

export interface StageDef {
  id: string;
  name: string;
  volume: string;
  status: "positive" | "notice" | "neutral";
  state: string;
}

export const STAGES: StageDef[] = [
  { id: "st4", name: "Stage 04", volume: "Volume A", status: "positive", state: "在线" },
  { id: "st2", name: "Stage 02", volume: "Volume B", status: "notice", state: "校准中" },
  { id: "st1", name: "Stage 01", volume: "插入墙", status: "neutral", state: "空闲" },
];

export const APP_MENUS = ["文件", "编辑", "视图", "舞台", "渲染", "现场", "窗口", "帮助"];
