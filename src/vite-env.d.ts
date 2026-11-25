/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" = 键控实验显示「加载测试视频 / 自动加载测试集」（开发时默认显示）。 */
  readonly VITE_KEYER_TEST_TOOLS?: string;
}

/** 键控测试素材在仓库里的绝对路径（vite.config.ts define，开发时经 /@fs 读）。 */
declare const __KEYER_TESTSET_FS__: string;
declare const __KEYER_VIDEO_FS__: string;
