/* Volo — Stage 数据模型 schema（AR 校正方案 Phase E1）。

   Stage = 一个摄影棚/场地的校正对象集合。本文件是 Stage 项目目录 JSON 的
   TypeScript 真相源（字段 snake_case，对齐未来 Rust `Serialize` wire 格式，
   与 src/volo/api/types.ts 同约定）；整体优化方案 W2 的 Stage 接线落地时以
   此为准接入状态层。

   stage_type 决定 Calibrate 页的流程分支：
   - "led"    — LED 墙棚：屏幕既是 marker 载体也是成像面（VP-QSP 流程）。
   - "ar"     — 无屏实景棚：真值来自实测 marker map（vpcal marker_map 路径），
                流程为 Markers → Lens → Spatial → Delay → Verify → Runs。
   - "hybrid" — 预留（数据模型占位，首期不实现联合求解）。

   纪律（docs/schema-versions.md D6）：per-实体维度一律列表结构 —— screens、
   marker_maps 即使当前只有一个也用数组；LED 模式 marker_maps 为 []，AR 模式
   screens 允许为 []。 */

export type StageType = "led" | "ar" | "hybrid";

/** LED 屏幕条目 — 指向 vpcal ScreenDefinition JSON（或 OBJ 网格）。 */
export interface StageScreen {
  id: string;
  name: string;
  /** Stage 目录内的相对路径，如 "screens/main_wall.json"。 */
  path: string;
}

/** 实测 marker map 条目 — 指向 vpcal MarkerMapDefinition JSON。 */
export interface StageMarkerMap {
  id: string;
  name: string;
  /** Stage 目录内的相对路径，如 "marker_maps/stage_survey.json"。 */
  path: string;
  /** 真值来源（对应 vpcal survey_source 汇总）："total_station" / "tape" /
   *  "cad" / "cube_placement"；未知为 null（诚实呈现，不编数字）。 */
  survey_source: string | null;
}

export interface Stage {
  schema_version: string;
  id: string;
  name: string;
  /** 缺省 "led" —— 既有 Stage JSON 无此字段时按 LED 解释（向后兼容）。 */
  stage_type: StageType;
  /** LED 屏幕列表；AR 模式允许为空。 */
  screens: StageScreen[];
  /** 实测 marker map 列表；LED 模式为空。 */
  marker_maps: StageMarkerMap[];
}

export const STAGE_SCHEMA_VERSION = "1.0";

/** 解析 Stage JSON 并补默认值：缺 stage_type → "led"，缺列表 → []。
 *  逐位保持 LED 既有行为（plan E1 验收：stage_type 缺省行为不变）。 */
export function normalizeStage(raw: Record<string, unknown>): Stage {
  const stageType = raw.stage_type as StageType | undefined;
  return {
    schema_version: (raw.schema_version as string) ?? STAGE_SCHEMA_VERSION,
    id: (raw.id as string) ?? "",
    name: (raw.name as string) ?? "",
    stage_type: stageType === "ar" || stageType === "hybrid" ? stageType : "led",
    screens: (raw.screens as StageScreen[] | undefined) ?? [],
    marker_maps: (raw.marker_maps as StageMarkerMap[] | undefined) ?? [],
  };
}

/** AR 分支左栏步骤（plan E2 规格，视觉稿待 Claude Design handoff 后实现）。 */
export const AR_CALIBRATE_STEPS = [
  "markers",
  "lens",
  "spatial",
  "delay",
  "verify",
  "runs",
] as const;
export type ArCalibrateStep = (typeof AR_CALIBRATE_STEPS)[number];

/** 导出能力按 stage_type 收敛：AR 模式隐藏 nDisplay（无屏可导）。 */
export function stageExports(stageType: StageType): { opentrackio: boolean; ndisplay: boolean } {
  return { opentrackio: true, ndisplay: stageType !== "ar" };
}
