/* Tauri 事件桥：除 api/ 外唯一允许直接 listen 的地方（frontend-structure.md §4）。
   页面不直接 listen；进度 / 状态推送经这里转成 Query 失效或 store 更新。 */
import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { isTauri } from "@/api/invoke";

/** 订阅一个 Tauri 事件；返回取消函数。非 Tauri 环境（浏览器 / 测试）下为空操作。 */
export function onTauriEvent<T>(event: string, handler: (payload: T) => void): () => void {
  if (!isTauri()) return () => {};
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  void listen<T>(event, (e) => handler(e.payload)).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/** 收到事件即让对应查询失效重拉。 */
export function invalidateOnEvent(client: QueryClient, event: string, queryKey: QueryKey): () => void {
  return onTauriEvent(event, () => {
    void client.invalidateQueries({ queryKey });
  });
}

/** 组件内订阅 Tauri 事件；handler 变化不会重新订阅。 */
export function useTauriEvent<T>(event: string, handler: (payload: T) => void): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => onTauriEvent<T>(event, (p) => ref.current(p)), [event]);
}
