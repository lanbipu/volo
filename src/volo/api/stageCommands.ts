/* Volo — Stage typed command bindings（LAN-9）。
   Stage 文档 = Calibrate 的 project.yaml（stage_id / stage_type 字段，读写走
   meshCommands.loadProjectYaml / saveProjectYaml）；本文件只封装 Stage 身份分配
   与 Cache 库里的归属关系（机器 / UE 工程 ↔ stage_id，多对多）。
   「当前 Stage」选择器 UI 待 Claude Design 出稿，故以下均暂为 📝 no-ui。 */
import { call } from "./invoke";
import type { StageMembership } from "./types";

// 📝 no-ui: 返回项目的 stage_id；旧项目首次调用时分配 UUID 并写回 project.yaml
export const ensureProjectStageId = (absPath: string) =>
  call<string>("ensure_project_stage_id", { absPath });
// 📝 no-ui: 某 Stage 名下的机器 / UE 工程 id
export const getStageMembership = (stageId: string) =>
  call<StageMembership>("get_stage_membership", { stageId });
// 📝 no-ui: 机器归属到 Stage（幂等）
export const assignMachineToStage = (stageId: string, machineId: number) =>
  call<void>("assign_machine_to_stage", { stageId, machineId });
// 📝 no-ui
export const unassignMachineFromStage = (stageId: string, machineId: number) =>
  call<void>("unassign_machine_from_stage", { stageId, machineId });
// 📝 no-ui: UE 工程（Cache projects.id）归属到 Stage（幂等）
export const assignProjectToStage = (stageId: string, projectId: number) =>
  call<void>("assign_project_to_stage", { stageId, projectId });
// 📝 no-ui
export const unassignProjectFromStage = (stageId: string, projectId: number) =>
  call<void>("unassign_project_from_stage", { stageId, projectId });
// 📝 no-ui
export const listStagesForMachine = (machineId: number) =>
  call<string[]>("list_stages_for_machine", { machineId });
// 📝 no-ui
export const listStagesForProject = (projectId: number) =>
  call<string[]>("list_stages_for_project", { projectId });
