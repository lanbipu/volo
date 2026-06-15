import type { ReactNode } from "react";
import { ToggleButton, Text } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };

// 6 个 page tab —— Volo 统一桌面 App 的顶层导航段。
// 顺序与命名是产品决策（见 MEMORY: Volo UX 方向）；本步只搭骨架，不做实质 UI。
export type TabKey =
  | "previz"
  | "calibrate"
  | "color"
  | "cache"
  | "live"
  | "tools";

export const TABS: { key: TabKey; label: string }[] = [
  { key: "previz", label: "Pre-viz" },
  { key: "calibrate", label: "Calibrate" },
  { key: "color", label: "Color" },
  { key: "cache", label: "Cache" },
  { key: "live", label: "Live" },
  { key: "tools", label: "Tools" },
];

interface AppShellProps {
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  children: ReactNode;
}

// 应用外壳：内容区在上、底部一排 page tab 水平居中。
// 外壳四区细节 / 各 tab 高亮态视觉等 Claude Design 设计稿后再细化。
export function AppShell({ activeTab, onTabChange, children }: AppShellProps) {
  return (
    <div
      className={style({
        minHeight: "[100vh]",
        display: "flex",
        flexDirection: "column",
      })}
    >
      <div
        className={style({
          flexGrow: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 32,
        })}
      >
        {children}
      </div>

      <nav
        aria-label="主导航"
        className={style({
          display: "flex",
          flexDirection: "row",
          justifyContent: "center",
          alignItems: "center",
          gap: 8,
          paddingX: 16,
          paddingY: 12,
          borderTopWidth: 1,
          borderTopStyle: "solid",
          borderTopColor: "gray-200",
        })}
      >
        {TABS.map(({ key, label }) => (
          <ToggleButton
            key={key}
            isSelected={activeTab === key}
            onPress={() => onTabChange(key)}
          >
            <Text>{label}</Text>
          </ToggleButton>
        ))}
      </nav>
    </div>
  );
}
