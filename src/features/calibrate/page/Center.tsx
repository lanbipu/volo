// Volo · Calibrate —— 中心区（CalTop + 6 视图路由）。移植自 page_calibrate.jsx center() + stepView()。
import { useCalibrate } from "../state/store";
import { CalTop } from "../views/CalTop";
import { MethodView } from "../views/MethodView";
import { SurveyView } from "../views/SurveyView";
import { PreviewView } from "../views/PreviewView";
import { CabinetEditor } from "../views/CabinetEditor";
import { RunsTable } from "../views/RunsTable";
import { LensView } from "../views/LensView";
import { CAL_RUNS } from "../state/data";

function StepView() {
  const { calStep } = useCalibrate();
  switch (calStep) {
    case "method":
      return <MethodView />;
    case "survey":
      return <SurveyView />;
    case "preview":
      return <PreviewView />;
    case "runs":
      return (
        <>
          <div className="canvas-head">
            <span className="t">重建历史</span>
            <div className="right">
              <span className="toolchip">{CAL_RUNS.length + " 次重建"}</span>
            </div>
          </div>
          <RunsTable />
        </>
      );
    case "lens":
      return <LensView />;
    default:
      return <CabinetEditor />;
  }
}

export function Center() {
  return (
    <div className="dash cal-dash">
      <CalTop />
      <div className="dash-card cal-stage-card">
        <StepView />
      </div>
    </div>
  );
}
