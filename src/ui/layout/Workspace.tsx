/* 内容卡片里的工作区：ry-main（Location Bar + 视图栏 + 内容）| 分隔条 | Inspector。
   外壳已经渲染了 ry-card，页面只渲染这里。Inspector 关闭时不渲染分隔条。 */
import type { ReactNode } from "react";
import { Splitter } from "../components/Splitter";

export interface WorkspaceProps {
  children: ReactNode;
  inspector?: ReactNode;
  inspectorOpen?: boolean;
  inspectorWidth?: number;
  onInspectorWidth?: (w: number) => void;
  minWidth?: number;
  maxWidth?: number;
}

export function Workspace({ children, inspector, inspectorOpen = true, inspectorWidth = 340, onInspectorWidth, minWidth = 300, maxWidth = 520 }: WorkspaceProps) {
  const show = inspectorOpen && inspector != null;
  return (
    <>
      <main className="ry-main">{children}</main>
      {show && (
        <>
          <Splitter label="调整 Inspector 宽度" value={inspectorWidth} min={minWidth} max={maxWidth} side="right" onChange={(w) => onInspectorWidth?.(w)} />
          {inspector}
        </>
      )}
    </>
  );
}

/** Location Bar 右端的 Inspector 开关（aria-pressed = 是否打开）。 */
export { InspectorToggle } from "./InspectorToggle";
