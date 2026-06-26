// Volo · Calibrate —— 校正总览条（land-status hero）。移植自 page_calibrate.jsx calTop()。
import { Icon } from "../../cache/ui/Icon";
import { Button } from "../../cache/ui/Button";
import { useCache } from "../../cache/state/store";
import { useCalibrate } from "../state/store";
import { CAL_SCREENS, MESH_METRICS, CAL_RUNS, LENS_STAGES, SEVCAL } from "../state/data";
import type { CalSev } from "../state/types";

export function CalTop() {
  const { calScreen } = useCalibrate();
  const { pushLog } = useCache();
  const screen = CAL_SCREENS.find((x) => x.id === calScreen) ?? CAL_SCREENS[0];
  const m = MESH_METRICS;
  const lensRun = LENS_STAGES.filter((x) => x.status === "done").length === LENS_STAGES.length;
  const latest = CAL_RUNS.find((r) => r.rms != null) ?? CAL_RUNS[0];
  const rmsVis = m.est_rms < 3 ? "positive" : m.est_rms < 8 ? "notice" : "negative";
  const overall: CalSev =
    rmsVis === "negative" ? "critical" : !lensRun || rmsVis === "notice" ? "warning" : "healthy";
  const sev = SEVCAL[overall];
  const rebuild = () => {
    pushLog({ lv: "info", cat: "calibrate", msg: `重建 ${screen.name} 网格 …` });
    pushLog({ lv: "ok", cat: "calibrate", msg: "mesh_v7 重建收敛，estimated RMS 0.40 mm" });
  };
  return (
    <div className={"land-status hero-" + overall}>
      <div className={"ls-badge s-" + sev.visual}>
        <Icon name={sev.icon} size={24} />
      </div>
      <div className="ls-main">
        <div className="ls-line">
          <b>{m.est_rms.toFixed(2) + " mm"}</b>
          <span className="dim">{" RMS · "}</span>
          <span>网格已重建</span>
          <span className="dim">{" · "}</span>
          <b className={"s-" + (lensRun ? "positive" : "notice")}>
            {lensRun ? "镜头已校正" : "镜头校正未运行"}
          </b>
        </div>
        <div className="ls-sub">
          {"当前 " +
            screen.name +
            " · 拓扑 " +
            m.cols +
            " × " +
            m.rows +
            " · " +
            m.vertices.toLocaleString() +
            " 顶点 · 上次重建 " +
            latest.target +
            " · " +
            latest.created}
        </div>
      </div>
      <Button variant="accent" size="M" icon={<Icon name="sync" size={15} />} onPress={rebuild}>
        重建
      </Button>
    </div>
  );
}
