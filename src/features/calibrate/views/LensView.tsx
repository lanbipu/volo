// Volo · Calibrate —— 镜头校正（占位流程）。移植自 page_calibrate.jsx lensView()。
import { Icon } from "../../cache/ui/Icon";
import { Button } from "../../cache/ui/Button";
import { InlineAlert } from "../ui/InlineAlert";
import { useCache } from "../../cache/state/store";
import { LENS_STAGES } from "../state/data";

const DOF: [string, string][] = [
  ["t.x", "—"],
  ["t.y", "—"],
  ["t.z", "—"],
  ["r.x", "—"],
  ["r.y", "—"],
  ["r.z", "—"],
  ["scale", "—"],
];
const QUALITY = ["RMS (px)", "inlier", "outlier", "重投影误差 (px)"];

export function LensView() {
  const { pushLog } = useCache();
  return (
    <>
      <div className="canvas-head">
        <span className="t">镜头校正</span>
        <div className="right">
          <Button
            variant="accent"
            size="S"
            icon={<Icon name="target" size={14} />}
            onPress={() => pushLog({ lv: "info", cat: "calibrate", msg: "镜头求解：占位流程，Detect → Solve 尚未接入" })}
          >
            运行求解
          </Button>
        </div>
      </div>
      <div className="lwrap cal-scroll">
        <div className="lstages">
          {LENS_STAGES.map((st) => (
            <div
              key={st.id}
              className={"lstage" + (st.status === "done" ? " done" : "") + (st.status === "active" ? " active" : "")}
            >
              <div className="ln">{st.status === "done" ? <Icon name="check" size={14} /> : st.n}</div>
              <div className="lt">{st.label}</div>
              <div className="lc">{st.cn + " · " + (st.status === "done" ? "已完成" : "待运行")}</div>
            </div>
          ))}
        </div>
        <div style={{ marginBottom: 14 }}>
          <InlineAlert variant="informative" title="占位流程">
            镜头校正尚未接入。完成 Detect → Solve 后将生成 7-DOF 变换矩阵、RMS / inlier / outlier 与重投影误差。
          </InlineAlert>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16 }}>
          <div>
            <div className="surv-sub" style={{ marginTop: 0 }}>
              变换矩阵 · 7 自由度
            </div>
            <div className="hatch" style={{ minHeight: 0, padding: 14 }}>
              <div className="lmatrix" style={{ width: "100%" }}>
                {DOF.map(([k, v]) => (
                  <div className="lmcell" key={k} style={{ textAlign: "left" }}>
                    <span style={{ color: "var(--chrome-faint)", fontSize: 11 }}>{k + " = "}</span>
                    {v}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div>
            <div className="surv-sub" style={{ marginTop: 0 }}>
              求解质量
            </div>
            <div className="qbar" style={{ flexDirection: "column" }}>
              {QUALITY.map((k) => (
                <div
                  className="qmetric"
                  key={k}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <div className="qk">{k}</div>
                  <div className="qv" style={{ color: "var(--chrome-faint)" }}>
                    —
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
