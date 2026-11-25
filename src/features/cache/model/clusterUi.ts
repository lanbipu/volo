/* 集群各页之间的跳转上下文（如工程详情“生成 PAK”→ 缓存页 PAK 页签并选中该工程）。不持久化。 */
import { create } from "zustand";

export type CacheTab = "zen" | "pak" | "legacy";

interface ClusterUi {
  cacheTab: CacheTab;
  pakProjectId: number | null;
  psoProjectId: number | null;
  setCacheTab: (t: CacheTab) => void;
  focusPak: (projectId: number) => void;
  focusPso: (projectId: number | null) => void;
}

export const useClusterUi = create<ClusterUi>()((set) => ({
  cacheTab: "zen",
  pakProjectId: null,
  psoProjectId: null,
  setCacheTab: (cacheTab) => set({ cacheTab }),
  focusPak: (pakProjectId) => set({ cacheTab: "pak", pakProjectId }),
  focusPso: (psoProjectId) => set({ psoProjectId }),
}));
