// Volo · Calibrate —— 页面状态（屏幕 / 工作流步骤 / 重建方法 / Inspector 选择）。
// 与 useShell（外壳）/ useCache（缓存域）并存；局部画布状态（cells / zoom / rot 等）留各组件内。
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { CAL_SCREENS } from "./data";
import type { CalStep, CalMethod, CalSelection } from "./types";

export interface CalibrateStore {
  calScreen: string;
  setCalScreen: (s: string) => void;
  calStep: CalStep;
  setCalStep: (s: CalStep) => void;
  calMethod: CalMethod;
  setCalMethod: (m: CalMethod) => void;
  calSel: CalSelection | null;
  setCalSel: (s: CalSelection | null) => void;
}

const Ctx = createContext<CalibrateStore | null>(null);

export function CalibrateProvider({ children }: { children: ReactNode }) {
  const [calScreen, setCalScreen] = useState<string>(CAL_SCREENS[0].id);
  const [calStep, setCalStepRaw] = useState<CalStep>("design");
  const [calMethod, setCalMethod] = useState<CalMethod>("m1");
  const [calSel, setCalSel] = useState<CalSelection | null>(null);
  // 切换工作流步骤时清空选择，避免 Inspector 残留与中心视图不对应的选中对象
  const setCalStep = useCallback((s: CalStep) => {
    setCalStepRaw(s);
    setCalSel(null);
  }, []);

  const value = useMemo<CalibrateStore>(
    () => ({
      calScreen,
      setCalScreen,
      calStep,
      setCalStep,
      calMethod,
      setCalMethod,
      calSel,
      setCalSel,
    }),
    [calScreen, calStep, calMethod, calSel],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCalibrate(): CalibrateStore {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCalibrate must be used within CalibrateProvider");
  return v;
}
