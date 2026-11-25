/* cache 域对外出口：集群四页（机器 / 工程 / 缓存 / PSO 预热）+ 对象页签构造。 */
export { MachinesPage, machineTab } from "./ui/MachinesPage";
export { ProjectsPage } from "./ui/ProjectsPage";
export { projectTab } from "./model/projects";
export { useMachineList } from "./model/machines";
export { CachePage } from "./ui/CachePage";
export { PsoPage } from "./ui/PsoPage";
export { useAutoPatrol, fmtTime, fmtFull } from "./model/machines";
export { useMachines, useRunInspection, parseTs, STATE_LABEL, type MachineView, type MachineState } from "./model/machines";
export { useShares } from "./model/cache";
