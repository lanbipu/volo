/* 摄影机页按当前 Stage 的类型分流：LED 是镜头标定，AR 是延迟校准。 */
import { lazy } from "react";
import { useCurrentStage } from "@/features/stage";

const LedCamera = lazy(() => import("@/features/led").then((m) => ({ default: m.CameraPage })));
const ArCamera = lazy(() => import("@/features/ar").then((m) => ({ default: m.ArCameraPage })));

export function CameraRoute() {
  const { stage } = useCurrentStage();
  return stage?.type === "ar" ? <ArCamera /> : <LedCamera />;
}
