/* 扫描工程用的搜索目录：常用目录（星标）持久化，下次打开扫描对话框时预填。 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { persistOptions } from "@/lib/persist";

interface RootsState {
  favorites: string[];
  toggle: (root: string) => void;
}

export const useScanRoots = create<RootsState>()(
  persist(
    (set) => ({
      favorites: [],
      toggle: (root) => set((s) => ({ favorites: s.favorites.includes(root) ? s.favorites.filter((r) => r !== root) : [...s.favorites, root] })),
    }),
    persistOptions<RootsState, Pick<RootsState, "favorites">>("cache.scan-roots", 1, ({ favorites }) => ({ favorites })),
  ),
);
