/* Volo — Mesh (LMT) core group typed command bindings (Calibrate page M1: Design /
   Method / Survey / Preview / Runs / 输出). One wrapper per `#[tauri::command]` in
   src-tauri/src/commands/mesh_{projects,reconstruct,total_station,measurements,export}.rs.
   Arg keys are camelCase (Rust snake_case → JS camelCase); optional Rust params
   (`Option<T>`) are passed as explicit `null` when omitted. See ./types for the
   DTO shapes; ./invoke for the transport.

   UI 接入状态标注（同 commands.ts 惯例）：
     ✅ wired  —— 已接 Calibrate 页真实数据/动作路径
   全部 14 条本次（W2）接线，无 🔌/📝。 */
import { call } from "./invoke";
import type {
  InstructionCardResult, MeasuredPoints, ProjectConfig, RecentProject,
  ReconstructionReport, ReconstructionResult, ReconstructionRun, TotalStationImportResult,
} from "./types";

/* ----------------------------- project.yaml ----------------------------- */
// ✅ wired: Calibrate 项目加载（打开项目 / 切换最近项目 / 保存后回读校验）→ loadProjectYaml
export const loadProjectYaml = (absPath: string) => call<ProjectConfig>("load_project_yaml", { absPath });
// ✅ wired: Calibrate Design 步「保存」→ saveProjectYaml（整 config 回写，仅改动映射得到的字段）
export const saveProjectYaml = (absPath: string, config: ProjectConfig) =>
  call<void>("save_project_yaml", { absPath, config });

/* ----------------------------- recent projects ----------------------------- */
// ✅ wired: Calibrate 页加载时取最近项目 → listRecentProjects
export const listRecentProjects = () => call<RecentProject[]>("list_recent_projects");
// ✅ wired: 「打开项目」/「示例项目」成功后登记 → addRecentProject
export const addRecentProject = (absPath: string, displayName: string) =>
  call<RecentProject>("add_recent_project", { absPath, displayName });
// 📝 no-ui: 无移除最近项目入口（当前无对应 UI 承载点）
export const removeRecentProject = (id: number) => call<void>("remove_recent_project", { id });
// ✅ wired: 空态「示例项目」入口 → seedExampleProject(targetDir, example) 后 addRecentProject
export const seedExampleProject = (targetDir: string, example: string) =>
  call<string>("seed_example_project", { targetDir, example });

/* ----------------------------- measurements ----------------------------- */
// ✅ wired: Survey 步点表 → loadMeasurementsYaml（CSV 导入产物的 measurementsYamlPath 拼绝对路径后读取）
export const loadMeasurementsYaml = (path: string) => call<MeasuredPoints>("load_measurements_yaml", { path });

/* ----------------------------- total station (M1) ----------------------------- */
// ✅ wired: Survey 步「导入 CSV」→ importTotalStationCsv（mode 省略走后端默认 "grid"）
export const importTotalStationCsv = (
  projectAbsPath: string, csvPath: string, screenId: string,
  mode?: "grid" | "scatter" | null, columns?: string | null,
) => call<TotalStationImportResult>("import_total_station_csv", {
  projectAbsPath, csvPath, screenId, mode: mode ?? null, columns: columns ?? null,
});

/* ----------------------------- reconstruction ----------------------------- */
// ✅ wired: overview「重建」→ reconstructSurface via runCmd
export const reconstructSurface = (projectPath: string, screenId: string, measurementsPath: string) =>
  call<ReconstructionResult>("reconstruct_surface", { projectPath, screenId, measurementsPath });
// ✅ wired: Runs 步列表 → listRuns（按当前屏幕过滤）
export const listRuns = (projectPath: string, screenId?: string | null) =>
  call<ReconstructionRun[]>("list_runs", { projectPath, screenId: screenId ?? null });
// ✅ wired: Runs 步行展开 → getRunReport（异步加载完整 JSON report）
export const getRunReport = (runId: number) => call<ReconstructionReport>("get_run_report", { runId });
// ✅ wired: run 详情「设为当前」→ setRunCurrent（同屏其余 run 自动取消置位）
export const setRunCurrent = (runId: number) => call<void>("set_run_current", { runId });

/* ----------------------------- export ----------------------------- */
// ✅ wired: 左侧「导出」→ exportObj（target: disguise/unreal/neutral）
export const exportObj = (runId: number, target: "disguise" | "unreal" | "neutral", dstAbsPath?: string | null) =>
  call<string>("export_obj", { runId, target, dstAbsPath: dstAbsPath ?? null });

/* ----------------------------- instruction card ----------------------------- */
// ✅ wired: 左侧「生成指导卡」→ generateInstructionCard（HTML 预览）
export const generateInstructionCard = (projectAbsPath: string, screenId: string) =>
  call<InstructionCardResult>("generate_instruction_card", { projectAbsPath, screenId });
// ✅ wired: 指导卡预览「另存为 PDF」→ saveInstructionPdf
export const saveInstructionPdf = (projectAbsPath: string, screenId: string, dstPdfPath: string) =>
  call<string>("save_instruction_pdf", { projectAbsPath, screenId, dstPdfPath });

export interface VpcalScreenExport {
  path: string;
  fingerprint: string;
}
// Shared contract: Lens imports this wrapper rather than duplicating an invoke.
export const exportVpcalScreen = (projectPath: string, screenId: string, outPath?: string | null) =>
  call<VpcalScreenExport>("export_vpcal_screen", {
    projectPath, screenId, outPath: outPath ?? null,
  });
