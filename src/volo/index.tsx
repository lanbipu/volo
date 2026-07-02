// @ts-nocheck
/* Volo — entry barrel for the ported Claude Design handoff. Imports the
   design's CSS (token sheets → app chrome → clean overrides) and every ported
   module in dependency order so all window.* registries (Spectrum2 bundle,
   data globals, Tweaks controls, VOLO_PAGES / VOLO_CACHE*) are populated before
   App renders. Re-exports App for main.tsx. */
import "./styles/colors.css";
import "./styles/typography.css";
import "./styles/spacing.css";
import "./styles/fonts.css";
import "./styles/app.css";
import "./styles/clean.css";
import "./styles/zen.css";       // ZenServer 重做版样式（zen-status / zbadge / zsteps / zcli …）
import "./styles/pso.css";       // PSO 上场就绪保障样式（nm-矩阵 / wv-预热 / hist-历史 / cvar-合规 / lrp-cancel）

import "./ds";          // window.Spectrum2DesignSystem_b6d1b3 (+ React global)
import "./data";        // window data globals + Icon
import "./api/uiConfig"; // window.{NODE_STATUS,CHANNEL,ROLES,CACHE_MODULES,DDC_NAV} (presentation config, lifted out of data)
import "./tweaks";      // window.TweaksPanel / Tweak* controls
import { App } from "./shell"; // window.App / Selector / CtxTitle / Stat
import "./pages/cache";        // window.VOLO_CX / VOLO_CACHE
import "./pages/cacheMachines"; // window.VOLO_CACHE_MACHINES
import "./pages/cacheZen";      // window.VOLO_CACHE_ZEN（ZenServer 重做版，须在 cacheDdc 前）
import "./pages/cacheDdc";      // window.VOLO_CACHE_DDC
import "./pages/skeletons";     // window.VOLO_PAGES.{previz,color,live,tools}
import "./pages/calibrate";     // window.VOLO_PAGES.calibrate

export { App };
