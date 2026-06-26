// Volo · Calibrate —— 网格预览（头部指标 + 内嵌 MeshPreview3D + 质量指标条）。移植自 page_calibrate.jsx previewView()。
import { Icon } from "../../cache/ui/Icon";
import { rmsBadge } from "../ui/rms";
import { MeshPreview3D } from "./MeshPreview3D";
import { useCalibrate } from "../state/store";
import { CAL_SCREENS, MESH_METRICS } from "../state/data";
import type { Visual } from "../state/types";

function Q({ k, v, u, vis }: { k: string; v: string; u?: string; vis?: Visual }) {
  return (
    <div className="qmetric">
      <div className="qk">{k}</div>
      <div className={"qv s-" + (vis || "")}>
        {v}
        {u ? <span className="u">{u}</span> : null}
      </div>
    </div>
  );
}

export function PreviewView() {
  const { calScreen } = useCalibrate();
  const screen = CAL_SCREENS.find((x) => x.id === calScreen) ?? CAL_SCREENS[0];
  const m = MESH_METRICS;
  return (
    <div className="cabwrap">
      <div className="canvas-head">
        <span className="t">{screen.name + " — 网格预览"}</span>
        <span className="toolchip">
          <Icon name="cube" size={14} />
          {`拓扑 ${m.cols} × ${m.rows}`}
        </span>
        <span className="toolchip">
          <Icon name="layers" size={14} />
          {m.vertices.toLocaleString() + " 顶点"}
        </span>
        <div className="right">{rmsBadge(m.est_rms)}</div>
      </div>
      <div className="cabstage" style={{ padding: 0 }}>
        <div className="prev-badge">
          <span className="toolchip">
            <span
              className="leg-sw"
              style={{ backgroundColor: "rgba(255,150,40,.3)", border: "1px solid rgba(255,150,40,.6)" }}
            />
            空 / 低置信
          </span>
        </div>
        <div className="cal-axis">PERSP · world</div>
        <MeshPreview3D />
        <div className="rot-hint">
          <Icon name="rotate" size={13} />
          拖动旋转
        </div>
      </div>
      <div className="modebar" style={{ gap: 9 }}>
        <div className="qbar">
          <Q k="middle_max_dev" v={m.mid_max.toFixed(2)} u="mm" vis="notice" />
          <Q k="middle_mean_dev" v={m.mid_mean.toFixed(2)} u="mm" vis="positive" />
          <Q k="estimated_rms" v={m.est_rms.toFixed(2)} u="mm" vis="positive" />
          <Q k="estimated_p95" v={m.est_p95.toFixed(2)} u="mm" vis="notice" />
        </div>
      </div>
    </div>
  );
}
