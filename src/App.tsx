// Volo —— LanX 虚拟制作统一桌面控制台。1:1 还原 Volo.html 桌面窗口外壳；缓存控制台接真 Tauri 命令。
// 全自定义视觉（不依赖 RS2）；暗/亮双主题由 .volo-cache 的 data-theme 驱动。
import "./global.css";
import "./features/cache/styles/cache.css";
import { ShellProvider } from "./shell/store";
import { CacheProvider, MachinesProvider } from "./features/cache";
import { Shell } from "./shell/Shell";

export default function App() {
  return (
    <ShellProvider>
      <CacheProvider>
        <MachinesProvider>
          <Shell />
        </MachinesProvider>
      </CacheProvider>
    </ShellProvider>
  );
}
