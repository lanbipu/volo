/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
  plugins: [react()],

  resolve: {
    // 新结构的路径别名（docs/architecture/frontend-structure.md §2）。
    // `@/api` 暂指旧址 src/volo/api；旧壳删除后整体移到 src/api，只改这一行。
    alias: [
      { find: /^@\/api(\/|$)/, replacement: `${root}/src/volo/api$1` },
      { find: /^@\//, replacement: `${root}/src/` },
    ],
  },

  build: {
    target: ["es2022"],
    cssMinify: "lightningcss",
  },

  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mjs"],
    environment: "node",
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
