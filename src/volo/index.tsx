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
import "./styles/ddcPak.css";    // DDC PAK 双栏重设计样式（已部署卡片 / 根目录编辑器 / 生成对话框 / 控制台指针统一）
import "./styles/calExt.css";    // Calibrate 增量样式（采集设置模态基础 cap-* 原子；AR 分支 ar-* 主体规则 + 本轮新 IA 追加的 ar-ws-*/ar-ovcard*/ar-degen* 等）
import "./styles/cal2.css";      // Calibrate 新 IA 样式（概览 / 网格校正折叠组 / 镜头校正）
import "./styles/calLens.css";   // 镜头校正单页 + 二级对话框样式（相机画面区 / 五态横幅 / 覆盖度环等）

import "./ds";          // window.Spectrum2DesignSystem_b6d1b3 (+ React global)
import "./data";        // window data globals + Icon
import "./api/uiConfig"; // window.{NODE_STATUS,CHANNEL,ROLES,CACHE_MODULES,DDC_NAV} (presentation config, lifted out of data)
import "./tweaks";      // window.TweaksPanel / Tweak* controls
import { App } from "./shell"; // window.App / Selector / CtxTitle / Stat
import "./pages/cache";        // window.VOLO_CX / VOLO_CACHE
import "./pages/cacheMachines"; // window.VOLO_CACHE_MACHINES
import "./pages/cacheZen";      // window.VOLO_CACHE_ZEN（ZenServer 重做版，须在 cacheDdc 前）
import "./pages/cacheDdc";      // window.VOLO_CACHE_DDC
import "./pages/cacheDdcPak";   // window.VOLO_CACHE_DDC_PAK（DDC PAK 双栏重设计，须在 cacheDdc 后）
import "./pages/skeletons";     // window.VOLO_PAGES.{previz,color,live,tools}
import "./pages/calibrate";     // window.VOLO_CAL2 基座 + window.VOLO_PAGES.calibrate 骨架（须在下面几个 leaf 之前，供其 Object.assign 扩展）
import "./pages/calOverview";   // window.VOLO_CAL2.Overview
import "./pages/calCapture";    // window.VOLO_CAL2.{openCaptureModal,CaptureModal,loadProfiles}（采集设置 · Profile CRUD，非实时采集会话）
import "./pages/calDesign";     // window.VOLO_CAL2.{Design,designInspector}
import "./pages/calSurvey";     // window.VOLO_CAL2.{Survey,surveyInspector}
import "./pages/calPreview";    // window.VOLO_CAL2.Preview
import "./pages/calHistory";    // window.VOLO_CAL2.{History,historyInspector}
import "./pages/calLens";        // window.VOLO_CAL2.{Lens,lensInspector,useLensLive,lensStore,useLensSolve,...}（镜头校正单页，真接 vpcal）
import "./pages/calLensDialogs"; // window.VOLO_CAL2.{openSolveFromSession,openReport,openExport,openPlayerCheck}
import "./pages/calAr";          // window.VOLO_CAL_AR 基座（arStore/atoms/useVpcalRun + left/center/inspector 路由 + Overview）
import "./pages/calArTools";     // window.VOLO_CAL_AR.{Markers,Lens,Spatial,Delay}
import "./pages/calArVerify";    // window.VOLO_CAL_AR.{Verify,verifyInspector,Runs}

export { App };
