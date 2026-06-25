// Volo · Cache 控制台 —— 左导航配置（集群总览 + DDC 管理折叠子菜单）+ Tools 页的诊断子类目。
import type { IconName } from "../ui/Icon";

export interface CacheModule {
  id: string;
  label: string;
  sub: string;
  icon: IconName;
}

export interface DdcNavItem {
  id: DdcView;
  label: string;
  icon: IconName;
}

export type DdcView = "ddc_zen" | "ddc_legacy" | "ddc_pak" | "ddc_pso";
export type DiagView = "diag_net" | "diag_sync" | "diag_thm" | "diag_term";
// 一致性 / 健康不再是独立页面：检测由集群总览的「立即巡检」触发，结果汇入「诊断与健康」栏。
export type CacheNav = "home" | DdcView | DiagView;

export const CACHE_MODULES: CacheModule[] = [
  { id: "home", label: "集群总览", sub: "Cluster", icon: "grid" },
  { id: "ddc", label: "DDC 管理", sub: "DDC", icon: "cache" },
];

export const DDC_NAV: DdcNavItem[] = [
  { id: "ddc_zen", label: "ZenServer", icon: "cube" },
  { id: "ddc_legacy", label: "文件系统 DDC", icon: "server" },
  { id: "ddc_pak", label: "DDC PAK", icon: "cache" },
  { id: "ddc_pso", label: "PSO 缓存", icon: "layers" },
];

export const DDC_TITLE: Record<DdcView, string> = {
  ddc_zen: "ZenServer",
  ddc_legacy: "文件系统 DDC",
  ddc_pak: "DDC PAK",
  ddc_pso: "PSO 缓存",
};

// Tools 页「诊断」类目（占位骨架），1:1 移植自原型 page_skeletons.jsx DIAG。
export interface DiagItem {
  id: DiagView;
  label: string;
  icon: IconName;
  intent: string;
}
export const DIAG: DiagItem[] = [
  { id: "diag_net", label: "网络探针", icon: "net", intent: "探测集群子网拓扑、丢包率与可用带宽。" },
  { id: "diag_sync", label: "同步分析", icon: "bolt", intent: "分析 genlock / PTP 锁相的抖动与漂移。" },
  { id: "diag_thm", label: "热成像图", icon: "thermo", intent: "汇总各渲染节点的 GPU 温度与功耗热点。" },
  { id: "diag_term", label: "脚本控制台", icon: "terminal", intent: "对选定节点批量执行远程诊断脚本。" },
];

export const isDdcView = (nav: string): nav is DdcView => /^ddc_/.test(nav);
export const isDiagView = (nav: string): nav is DiagView => /^diag_/.test(nav);
/** 缓存类目 = 集群总览 + DDC（非诊断）。 */
export const isCacheNav = (nav: string): boolean => !isDiagView(nav);
