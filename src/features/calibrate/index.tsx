// Volo · Calibrate —— 页面出口（向外壳四区贡献组件）。移植自 Claude Design 原型 page_calibrate.jsx。
import type { Page } from "../../shell/pages/types";
import { Ctx } from "./page/Ctx";
import { Left } from "./page/Left";
import { Center } from "./page/Center";
import { Inspector } from "./page/Inspector";

export { CalibrateProvider } from "./state/store";

export const calibratePage: Page = { Ctx, Left, Center, Inspector };
