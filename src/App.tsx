import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "@react-spectrum/s2/page.css";
import { Provider, Button, Heading, Text } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };

type Scheme = "light" | "dark";

// step 0 最小壳：仅验证 S2 framework 接入（Provider + 暗/亮主题）与前后端 invoke 打通。
// 实质 UI（外壳四区 / 6 tab / 各 feature 页）在 Claude Design 设计稿就绪后实现。
function App() {
  const [colorScheme, setColorScheme] = useState<Scheme>("dark");
  const [pong, setPong] = useState("");

  return (
    <Provider
      elementType="main"
      colorScheme={colorScheme}
      background="base"
      styles={style({
        minHeight: "[100vh]",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 24,
      })}
    >
      <Heading level={1} styles={style({ font: "heading-xl" })}>
        Volo
      </Heading>
      <Text>LanX · 虚拟制作（VP / LED）统一桌面控制台</Text>
      <Button
        variant="primary"
        onPress={async () => setPong(await invoke<string>("ping"))}
      >
        Ping 后端
      </Button>
      {pong ? <Text>{pong}</Text> : null}
      <Button
        variant="secondary"
        onPress={() =>
          setColorScheme((s) => (s === "dark" ? "light" : "dark"))
        }
      >
        切换主题（当前 {colorScheme === "dark" ? "暗色" : "亮色"}）
      </Button>
    </Provider>
  );
}

export default App;
