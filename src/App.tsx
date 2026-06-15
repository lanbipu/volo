import { useState } from "react";
import type { ComponentType } from "react";
import { invoke } from "@tauri-apps/api/core";
import "@react-spectrum/s2/page.css";
import { Provider, Button, Heading, Text } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { AppShell, type TabKey } from "./shell/AppShell";
import Previz from "./features/previz";
import Calibrate from "./features/calibrate";
import Color from "./features/color";
import Cache from "./features/cache";
import Live from "./features/live";
import Tools from "./features/tools";

type Scheme = "light" | "dark";

// tab key → feature 占位页。各页实质 UI 等 Claude Design 设计稿后实现。
const FEATURES: Record<TabKey, ComponentType> = {
  previz: Previz,
  calibrate: Calibrate,
  color: Color,
  cache: Cache,
  live: Live,
  tools: Tools,
};

// step 5 壳：AppShell 底部 6 tab 导航 + tab 切换显示对应 feature 占位页。
// 保留 step 0 的 Provider 暗/亮主题切换与前后端 ping 打通验证。
function App() {
  const [colorScheme, setColorScheme] = useState<Scheme>("dark");
  const [activeTab, setActiveTab] = useState<TabKey>("previz");
  const [pong, setPong] = useState("");

  const ActiveFeature = FEATURES[activeTab];

  return (
    <Provider
      elementType="main"
      colorScheme={colorScheme}
      background="base"
      styles={style({ minHeight: "[100vh]" })}
    >
      <AppShell activeTab={activeTab} onTabChange={setActiveTab}>
        <Heading level={1} styles={style({ font: "heading-xl" })}>
          Volo
        </Heading>
        <Text>LanX · 虚拟制作（VP / LED）统一桌面控制台</Text>

        <ActiveFeature />

        <Button
          variant="primary"
          onPress={async () => setPong(await invoke<string>("ping"))}
        >
          Ping 后端
        </Button>
        {pong ? <Text>{pong}</Text> : null}
        <Button
          variant="secondary"
          onPress={() => setColorScheme((s) => (s === "dark" ? "light" : "dark"))}
        >
          切换主题（当前 {colorScheme === "dark" ? "暗色" : "亮色"}）
        </Button>
      </AppShell>
    </Provider>
  );
}

export default App;
