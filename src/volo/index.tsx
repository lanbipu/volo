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

import "./ds";          // window.Spectrum2DesignSystem_b6d1b3 (+ React global)
import "./data";        // window data globals + Icon
import "./tweaks";      // window.TweaksPanel / Tweak* controls
import { App } from "./shell"; // window.App / Selector / CtxTitle / Stat
import "./pages/cache";        // window.VOLO_CX / VOLO_CACHE
import "./pages/cacheMachines"; // window.VOLO_CACHE_MACHINES
import "./pages/cacheDdc";      // window.VOLO_CACHE_DDC
import "./pages/skeletons";     // window.VOLO_PAGES.{previz,color,live,tools}
import "./pages/calibrate";     // window.VOLO_PAGES.calibrate

export { App };
