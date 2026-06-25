// Volo · 页面契约 —— 每个页面向外壳四区贡献组件（上下文条 / 左子栏 / 中心 / 检查器 + 可选浮层）。
import type { ComponentType } from "react";

export interface Page {
  Ctx: ComponentType;
  Left: ComponentType;
  Center: ComponentType;
  Inspector: ComponentType;
  Overlay?: ComponentType;
}
