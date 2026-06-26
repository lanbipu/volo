// Volo · Calibrate —— 测量导入（M1 全站仪：瓦片 + 参考点表；M2 视觉：未实现占位）。移植自 page_calibrate.jsx surveyView()。
import { Icon } from "../../cache/ui/Icon";
import { InlineAlert } from "../ui/InlineAlert";
import { useCalibrate } from "../state/store";
import { SURVEY_REPORT, CAL_POINTS, ROLE } from "../state/data";

export function SurveyView() {
  const { calMethod, calSel, setCalSel } = useCalibrate();

  if (calMethod === "m2") {
    return (
      <>
        <div className="canvas-head">
          <span className="t">测量导入 · M2 视觉</span>
        </div>
        <div className="surv">
          <div className="hatch dark" style={{ minHeight: 360 }}>
            <div className="hi">
              <span className="hic">
                <Icon name="camera" size={26} />
              </span>
              <span className="ht">未实现</span>
              <span className="hd">
                M2 视觉方法直接从相机帧提取角点，无独立测量导入步骤。该面板暂未实现。
              </span>
            </div>
          </div>
        </div>
      </>
    );
  }

  const rep = SURVEY_REPORT;
  const tiles: [string, string, number, string][] = [
    ["measured", "实测点", rep.measured, "positive"],
    ["fabricated", "制造点", rep.fabricated, "neutral"],
    ["outlier", "离群点", rep.outlier, "negative"],
    ["missing", "缺失点", rep.missing, "notice"],
  ];
  return (
    <>
      <div className="canvas-head">
        <span className="t">测量导入 · M1 全站仪</span>
        <span className="toolchip">
          <Icon name="download" size={14} />
          survey_main.csv
        </span>
        <div className="right">
          <span className="toolchip">1,024 行 · 已解析</span>
        </div>
      </div>
      <div className="surv cal-scroll">
        <div className="surv-tiles">
          {tiles.map(([id, lab, n, v]) => (
            <div className="stile" key={id}>
              <div className={"n s-" + v}>{n}</div>
              <div className="l">
                <span className={"sdot bg-" + v} />
                {lab}
              </div>
            </div>
          ))}
        </div>
        {rep.warnings.map((w, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <InlineAlert variant={w.lv === "warn" ? "notice" : "informative"} title={w.lv === "warn" ? "警告" : "提示"}>
              {w.msg}
            </InlineAlert>
          </div>
        ))}
        <div className="surv-sub">参考点 / 测量点</div>
        <div className="ptable">
          {CAL_POINTS.map((p) => {
            const isSel = calSel?.type === "point" && calSel.id === p.id;
            return (
              <div
                key={p.id}
                className={"prow" + (isSel ? " sel" : "")}
                onClick={() => setCalSel({ type: "point", id: p.id })}
              >
                <div className="pn">
                  {p.role ? (
                    <span className="sdot" style={{ background: ROLE[p.role].color }} />
                  ) : (
                    <span className="sdot bg-neutral" />
                  )}
                  {p.name}
                </div>
                <div className="xyz">{`[${p.xyz.map((v) => v.toFixed(3)).join(", ")}]`}</div>
                <div style={{ fontSize: 11.5, color: "var(--chrome-dim)" }}>{p.measured ? "实测" : "推测"}</div>
                <div className={"er s-" + (p.err < 1 ? "positive" : p.err < 2 ? "notice" : "negative")}>
                  {p.err.toFixed(2)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
