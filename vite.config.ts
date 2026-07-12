import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import macros from "unplugin-parcel-macros";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const root = process.cwd();
// @ts-expect-error process is a nodejs global
const keyerTestTools = process.env.VITE_KEYER_TEST_TOOLS === "1";

// https://vite.dev/config/
export default defineConfig(async () => ({
  publicDir: keyerTestTools ? `${root}/testdata/keyer` : "public",
  define: {
    __KEYER_TESTSET_FS__: JSON.stringify(`${root}/testdata/keyer/testset`),
    __KEYER_VIDEO_FS__: JSON.stringify(`${root}/testdata/keyer/greenscreen_1080p60_h264.mp4`),
  },
  // macros.vite() 必须在 react() 前：处理 @react-spectrum/s2 的 style() 宏
  plugins: [macros.vite(), react()],

  // S2 style-macro 生成的 CSS 合并为单 chunk + lightningcss 压缩
  build: {
    target: ["es2022"],
    cssMinify: "lightningcss",
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (
            /macro-(.*)\.css$/.test(id) ||
            /@react-spectrum\/s2\/.*\.css$/.test(id)
          ) {
            return "s2-styles";
          }
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    fs: {
      allow: [root],
    },
  },
}));
