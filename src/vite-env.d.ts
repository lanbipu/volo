/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "next" = 默认启动新壳（src/app）；其他 / 未设 = 旧壳（src/volo）。见 src/main.tsx。 */
  readonly VITE_VOLO_SHELL?: string;
}
