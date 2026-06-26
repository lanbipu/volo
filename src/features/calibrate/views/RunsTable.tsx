// Volo · Calibrate —— 重建历史表（行可展开报告）。移植自 page_calibrate.jsx RunsTable。
import { useState } from "react";
import { Icon } from "../../cache/ui/Icon";
import { rmsBadge } from "../ui/rms";
import { useCache } from "../../cache/state/store";
import { useCalibrate } from "../state/store";
import { CAL_RUNS } from "../state/data";

export function RunsTable() {
  const { calSel, setCalSel } = useCalibrate();
  const { pushLog } = useCache();
  const [exp, setExp] = useState<string | null>(null);
  return (
    <div className="runtable cal-scroll">
      <div className="rt-head">
        <span>Created</span>
        <span>Screen</span>
        <span>Method</span>
        <span>RMS</span>
        <span>Vertices</span>
        <span>Target</span>
        <span>OBJ</span>
      </div>
      {CAL_RUNS.map((r) => (
        <div key={r.id}>
          <div
            className={"rt-row" + (calSel?.type === "run" && calSel.id === r.id ? " sel" : "")}
            onClick={() => {
              setCalSel({ type: "run", id: r.id });
              setExp((e) => (e === r.id ? null : r.id));
            }}
          >
            <span className="dim">{r.created}</span>
            <span>{r.screen}</span>
            <span className="dim">{r.method}</span>
            <span>{rmsBadge(r.rms)}</span>
            <span className="mono">{r.vertices != null ? r.vertices.toLocaleString() : "—"}</span>
            <span className="mono dim">{r.target}</span>
            <span>
              {r.obj ? (
                <button
                  className="iconbtn"
                  style={{ width: 24, height: 24 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    pushLog({ lv: "ok", cat: "calibrate", msg: `下载 ${r.target}.obj` });
                  }}
                >
                  <Icon name="download" size={15} />
                </button>
              ) : (
                <span style={{ color: "var(--chrome-faint)" }}>—</span>
              )}
            </span>
          </div>
          {exp === r.id ? (
            <div className="rt-exp">
              <div className="ttl">{"重建报告 · " + r.target}</div>
              {r.metrics ? (
                <div className="qbar">
                  <div className="qmetric">
                    <div className="qk">middle_max_dev</div>
                    <div className="qv">
                      {r.metrics.mid_max.toFixed(2)}
                      <span className="u">mm</span>
                    </div>
                  </div>
                  <div className="qmetric">
                    <div className="qk">middle_mean_dev</div>
                    <div className="qv">
                      {r.metrics.mid_mean.toFixed(2)}
                      <span className="u">mm</span>
                    </div>
                  </div>
                  <div className="qmetric">
                    <div className="qk">estimated_rms</div>
                    <div className="qv">
                      {r.metrics.est_rms.toFixed(2)}
                      <span className="u">mm</span>
                    </div>
                  </div>
                  <div className="qmetric">
                    <div className="qk">estimated_p95</div>
                    <div className="qv">
                      {r.metrics.est_p95.toFixed(2)}
                      <span className="u">mm</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--chrome-faint)" }}>该次重建未收敛，无质量指标。</div>
              )}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
