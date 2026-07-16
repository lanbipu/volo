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
import "./styles/pso.css";       // PSO 旧节点就绪矩阵样式（nm-/wv-/hist-/cvar-，PsoMaster/PsoDetail 已下线后基本是死代码，留作 lrp-cancel 等仍被引用的规则）
import "./styles/psoDash.css";   // PSO 上场就绪保障 Dashboard + 设置（绿灯矩阵 glm-/glc- / 驱动缓存 dcr- / 预跑历史+运行态 ph-/pso-run- / 失效告警 fa- / 配置巡检 ck- / 设置双栏 pset-）
import "./styles/keyer.css";     // Keyer Lab（kl-）— Tools · 键控
import "./styles/ddcPak.css";    // DDC PAK 双栏重设计样式（已部署卡片 / 根目录编辑器 / 生成对话框 / 控制台指针统一）
import "./styles/ddcChan.css";   // ③ 本地 DDC「DDC 配置通道详情」展开区样式（chan-panel/chan-row/chan-badge …）
import "./styles/calExt.css";    // Calibrate 增量样式（采集设置模态基础 cap-* 原子；AR 分支 ar-* 主体规则 + 本轮新 IA 追加的 ar-ws-*/ar-ovcard*/ar-degen* 等）
import "./styles/calVideoSource.css";   // 视频源卡片重设计（vs-* —— backend 段选/设备选择器/信号预览区/高级格式覆盖）
import "./styles/calTrackingSource.css"; // 追踪源卡片重设计（ts-* —— 与 vs-* 对偶，监听测试区遥测面板）
import "./styles/cal2.css";      // Calibrate 旧仪表盘语言 token（dash-card/kpi/spill 等），grid.css 复用
import "./styles/grid.css";      // 网格校正单一工作区新 IA 样式（gw-* —— 概览/工作区/检查器/弹层）
import "./styles/calLens.css";   // 镜头校正单页 + 二级对话框样式（相机画面区 / 五态横幅 / 覆盖度环等）
import "./styles/calCaptureWindow.css"; // 实时采集单窗口（capw-* —— 现场画面常驻 + 信号源/会话参数/采集控制两栏 modal，grid/lens 共用）

import "./ds";          // window.Spectrum2DesignSystem_b6d1b3 (+ React global)
import "./data";        // window data globals + Icon
import "./api/uiConfig"; // window.{NODE_STATUS,CHANNEL,ROLES,CACHE_MODULES,DDC_NAV} (presentation config, lifted out of data)
import "./tweaks";      // window.TweaksPanel / Tweak* controls
import { App } from "./shell"; // window.App / Selector / CtxTitle / Stat
import "./pages/cache";        // window.VOLO_CX / VOLO_CACHE
import "./pages/cacheMachines"; // window.VOLO_CACHE_MACHINES
import "./pages/cacheProjectScan"; // 集群工程扫描中立模块（须在 DDC/PSO 前，供其 ES import）
import "./pages/cacheZen";      // window.VOLO_CACHE_ZEN（ZenServer 重做版，须在 cacheDdc 前）
import "./pages/cacheDdcChan";  // window.VOLO_DDC_CHAN（③ 本地 DDC「DDC 配置通道详情」，须在 cacheDdc 前）
import "./pages/cacheDdcSchan"; // window.VOLO_DDC_SCHAN（② 共享 DDC「共享 DDC 配置通道详情」，须在 cacheDdc 前）
import "./pages/cacheDdc";      // window.VOLO_CACHE_DDC
import "./pages/cachePsoDash";  // window.VOLO_CACHE_PSO_DASH（PSO 上场就绪保障 Dashboard + 设置，cacheDdc 的 ddc_pso 路由指向它）
import "./pages/cacheDdcPak";   // window.VOLO_CACHE_DDC_PAK（DDC PAK 双栏重设计，须在 cacheDdc 后）
import "./pages/toolsKeyer";    // window.VOLO_KEYER（键控 · Keyer Lab，须在 skeletons 前）
import "./pages/skeletons";     // window.VOLO_PAGES.{previz,color,live,tools}
import "./pages/calibrate";     // window.VOLO_CAL2 基座（projStore/CalController/openProjectPath/rebuildMesh/…，须在下面几个 leaf 之前，供其 Object.assign 扩展；不再自装 VOLO_PAGES.calibrate，见 gridPages）
import "./pages/calVideoSource";   // window.VoloVideoSource.{VideoSourceCard}（须在 calCapture 之前，供其渲染时引用）
import "./pages/calTrackingSource"; // window.VoloTrackingSource.{TrackingSourceCard} + window.VOLO_CAL2.openTrackingModal（须在 calCapture 之前）
import "./pages/calCapture";    // window.VOLO_CAL2.{openCaptureModal,CaptureModal,loadProfiles}（采集设置 · Profile CRUD，非实时采集会话）
import "./pages/calCaptureWindow"; // window.VOLO_CAPTURE.{openCaptureWindow,openGrid,openLens}（实时采集共享单窗口，须在 calCapture 之后，供其读取 loadProfiles/openCaptureModal；calLens/gridTree/gridInsp 的采集入口都改接这里）
import "./pages/calLens";        // window.VOLO_CAL2.{Lens,lensInspector,useLensLive,lensStore,useLensSolve,...}（镜头校正单页，真接 vpcal；本轮网格校正 IA 改动不涉及）
import "./pages/calLensDialogs"; // window.VOLO_CAL2.{openSolveFromSession,openReport,openExport,openPlayerCheck}
import "./pages/calAr";          // window.VOLO_CAL_AR 基座（arStore/atoms/useVpcalRun + left/center/inspector 路由 + Overview；本轮改动不涉及）
import "./pages/calArTools";     // window.VOLO_CAL_AR.{Markers,Lens,Spatial,Delay}
import "./pages/calArVerify";    // window.VOLO_CAL_AR.{Verify,verifyInspector,Runs}
import "./pages/gridView";       // window.VOLO_GRID.{Center,center,ROLE,PROV,pointName,roleAtCabinet,buildNominalBoxes,buildRealBoxes}（网格校正三维视口）
import "./pages/gridTree";       // window.VOLO_GRID.{left,flows}（场景树 + 测量导入流程面板，须在 gridView 之后，供其 ROLE 引用）
import "./pages/gridInsp";       // window.VOLO_GRID.{inspector,ScreenForm}
import "./pages/gridOverview";   // window.VOLO_GRID.{Overview,enterWorkspace}
import "./pages/gridModals";     // window.VOLO_GRID_MODALS.{measSelector,guideCard,reconstruct,fuse,exportDlg}
import "./pages/gridPages";      // 装配 ctx/left/center/inspector，覆盖 window.VOLO_PAGES.calibrate（须在以上 grid_*/calAr*/calLens* 之后，供其读取全部 window.VOLO_GRID*/VOLO_CAL_AR/VOLO_CAL2）

export { App };
