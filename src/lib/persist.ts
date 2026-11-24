/* 界面偏好持久化的 key 约定（frontend-structure.md §4）：按域拆 key，不再塞进单个大对象。
   与 zustand `persist` 中间件配合：persist(fn, persistOptions("shell", 1))。 */
import { createJSONStorage, type PersistOptions } from "zustand/middleware";

export const PERSIST_PREFIX = "volo:";

export function persistKey(domain: string): string {
  if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(domain)) {
    throw new Error(`persist 域名不合法：${domain}（小写、用 . 分层，如 calibrate.grid）`);
  }
  return PERSIST_PREFIX + domain;
}

/** 生成 persist 选项；partialize 用来只存偏好字段，不存会话数据。 */
export function persistOptions<S, P = Partial<S>>(
  domain: string,
  version: number,
  partialize?: (s: S) => P,
): PersistOptions<S, P> {
  return {
    name: persistKey(domain),
    version,
    storage: createJSONStorage(() => localStorage),
    ...(partialize ? { partialize } : {}),
  };
}
