/* PAK 预置包（设计：CachePak.dc.html）。数据复用工程视图（每份副本上有没有 DDC.ddp），
   生成 / 分发是后台任务：命令立即返回 job_id，进度经 ue-runner-progress / pak-verified / pak-distribute-progress 推送，
   这里收到完成事件就让工程数据重拉。 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { deleteDdcPak, distributeDdcPak, generateDdcPak } from "@/api/commands";
import type { BatchEvent } from "@/api/types";
import { useTauriEvent } from "@/lib/events";
import type { CopyView, ProjectView } from "./projects";

export type PakGroup = "partial" | "none" | "all";
export const PAK_GROUP_LABEL: Record<PakGroup, string> = { partial: "没有分发完", none: "还没有生成", all: "每台都有" };

export interface PakView {
  v: ProjectView;
  group: PakGroup;
  /** 生成 PAK 的机器：已有 PAK 的那份副本，否则工程的源机器。 */
  source: CopyView | null;
  /** 在线、还没有 PAK 的副本 = 可分发目标。 */
  missing: CopyView[];
  text: string;
}

export function pakView(v: ProjectView): PakView {
  const online = v.copies.filter((c) => !c.offline);
  const has = v.copies.filter((c) => c.pak);
  const missing = online.filter((c) => !c.pak);
  const source = has.find((c) => c === v.source) ?? has[0] ?? v.source;
  if (!has.length) return { v, group: "none", source, missing, text: "没有 PAK，新机器第一次打开要从头编译" };
  if (!missing.length) return { v, group: "all", source, missing, text: `${online.length} 台在线机器都有` };
  const text = has.length === 1 ? `只在源机上，另外 ${missing.length} 台还没有` : `${has.length} 台有，另外 ${missing.length} 台还没有`;
  return { v, group: "partial", source, missing, text };
}

/** 生成 / 分发完成时让工程（含已部署 PAK 列表）重拉。 */
export function usePakEvents() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["cache", "projects"] });
  useTauriEvent("pak-verified", refresh);
  useTauriEvent<{ event?: BatchEvent }>("pak-distribute-progress", (p) => {
    if (p?.event && p.event.status !== "running") refresh();
  });
}

export function useGeneratePak() {
  return useMutation({
    mutationFn: ({ v, sourceMachineId }: { v: ProjectView; sourceMachineId: number }) => generateDdcPak("remote", v.id, sourceMachineId, null, null, v.ue, null),
  });
}

export function useDistributePak() {
  return useMutation({
    mutationFn: ({ projectId, sourceMachineId, targets }: { projectId: number; sourceMachineId: number; targets: number[] }) =>
      distributeDdcPak(sourceMachineId, projectId, targets, null, null, null),
  });
}

export function useDeletePak() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, machineId }: { projectId: number; machineId: number }) => deleteDdcPak(machineId, projectId),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["cache", "projects"] }),
  });
}
