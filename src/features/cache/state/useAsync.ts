// Volo · Cache —— 通用异步数据 hook（接真 Tauri 命令；非 Tauri 环境下给出明确错误）。
import { useCallback, useEffect, useRef, useState } from "react";
import { inTauri } from "../api/commands";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * 跑一个返回 Promise 的取数函数。deps 变化时自动重取。
 * 非 Tauri 宿主（纯 vite dev）下直接置错，不抛崩溃 —— 视图渲染空 / 错误态。
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const tick = useRef(0);

  const run = useCallback(() => {
    if (!inTauri()) {
      setError("not-in-tauri");
      setLoading(false);
      return;
    }
    const myTick = ++tick.current;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => {
        if (alive.current && myTick === tick.current) setData(d);
      })
      .catch((e) => {
        if (alive.current && myTick === tick.current) setError(String(e?.message ?? e));
      })
      .finally(() => {
        if (alive.current && myTick === tick.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    alive.current = true;
    run();
    return () => {
      alive.current = false;
    };
  }, [run]);

  return { data, loading, error, reload: run };
}
