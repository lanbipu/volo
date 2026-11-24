import { QueryClient } from "@tanstack/react-query";

/* 桌面 App：窗口聚焦不代表数据变了，后端推送靠 Tauri 事件失效（lib/events）。 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
      mutations: { retry: 0 },
    },
  });
}
