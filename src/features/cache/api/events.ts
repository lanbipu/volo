// Volo · Cache 控制台 —— 长任务 / 进度事件流
//
// 4 个可取消长任务（generate_ddc_pak / start_pso_collection / distribute_ddc_pak /
// distribute_pso_cache）以及 health / batch / deploy 通过 Tauri 事件推进度。前端用 listen()
// 订阅，把事件喂进 store 的任务抽屉 + NDJSON 控制台。
//
// 事件名（实测自命令契约）：
//   generate     → "ue-runner-progress" + "pak-verified"
//   pak distribute → "pak-distribute-progress"
//   pso collect  → "ue-runner-progress" + "pso-collect-finalized"
//   pso distribute → "pso-distribute-progress"
//   deploy_ddc_run → "deploy-event"
//   run_health_check → "health-progress"
//   batch_set_*  → "batch-progress"

import { listen, type UnlistenFn, type Event } from "@tauri-apps/api/event";

export const CACHE_EVENTS = {
  ueRunnerProgress: "ue-runner-progress",
  pakVerified: "pak-verified",
  pakDistributeProgress: "pak-distribute-progress",
  psoCollectFinalized: "pso-collect-finalized",
  psoDistributeProgress: "pso-distribute-progress",
  deployEvent: "deploy-event",
  healthProgress: "health-progress",
  batchProgress: "batch-progress",
} as const;

export type CacheEventName = (typeof CACHE_EVENTS)[keyof typeof CACHE_EVENTS];

/** 订阅一个事件，返回 unlisten。payload 形态各异，消费方自行收窄。 */
export function onCacheEvent<T = unknown>(
  name: CacheEventName,
  cb: (payload: T, ev: Event<T>) => void,
): Promise<UnlistenFn> {
  return listen<T>(name, (ev) => cb(ev.payload, ev));
}

/** 同时订阅多个事件，返回一次性解绑函数。 */
export async function onCacheEvents(
  subs: Array<{ name: CacheEventName; cb: (payload: unknown, ev: Event<unknown>) => void }>,
): Promise<UnlistenFn> {
  const unlistens = await Promise.all(subs.map((s) => onCacheEvent(s.name, s.cb)));
  return () => unlistens.forEach((u) => u());
}
