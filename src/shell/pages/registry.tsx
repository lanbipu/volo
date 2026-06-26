// Volo · 页面注册表 —— PageId → 页面（向外壳四区贡献组件）。
import type { PageId } from "../data";
import type { Page } from "./types";
import { makeSkeleton, PREVIZ_CFG, COLOR_CFG, LIVE_CFG } from "./skeleton";
import { toolsPage } from "./tools";
import { calibratePage } from "../../features/calibrate";

export const PAGE_REGISTRY: Record<PageId, Page> = {
  previz: makeSkeleton(PREVIZ_CFG),
  calibrate: calibratePage,
  color: makeSkeleton(COLOR_CFG),
  live: makeSkeleton(LIVE_CFG),
  tools: toolsPage,
};
