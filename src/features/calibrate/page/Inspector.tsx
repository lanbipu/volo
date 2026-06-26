// Volo · Calibrate —— Inspector（4 态：cabinet / cabinetMulti / point / run）。移植自 page_calibrate.jsx inspector()。
// 本文件实现 empty / point / run；cabinet / cabinetMulti 由 Task 5 的 CabinetInspector 接管。
import { Icon } from "../../cache/ui/Icon";
import { Badge } from "../ui/Badge";
import { Stat } from "../ui/Stat";
import { KV } from "../ui/KV";
import { rmsBadge } from "../ui/rms";
import { useCalibrate } from "../state/store";
import { CAL_POINTS, CAL_RUNS, ROLE } from "../state/data";
import { CabinetInspector } from "../views/CabinetEditor";

export function Inspector() {
  const { calSel } = useCalibrate();

  if (!calSel) {
    return (
      <div className="insp-empty">
        <div className="ph">
          <Icon name="target" size={30} />
        </div>
        <div>
          <div style={{ color: "var(--chrome-dim)", fontWeight: 600, marginBottom: 4 }}>未选择对象</div>
          选择 cabinet / 测量点 / 重建记录
        </div>
      </div>
    );
  }

  if (calSel.type === "cabinet" || calSel.type === "cabinetMulti") {
    return <CabinetInspector sel={calSel} />;
  }

  if (calSel.type === "point") {
    const p = CAL_POINTS.find((x) => x.id === calSel.id);
    if (!p) return null;
    const errVis = p.err < 1 ? "positive" : p.err < 2 ? "notice" : "negative";
    return (
      <>
        <div className="insp-head">
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
            <span className="step-ico">
              <Icon name="pin" size={16} />
            </span>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, fontFamily: "var(--font-code)" }}>{p.name}</h2>
          </div>
          <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
            <span className={"spill spill--" + (p.measured ? "positive" : "notice")}>
              <Icon name={p.measured ? "check" : "alert"} size={13} />
              {p.measured ? "实测" : "推测"}
            </span>
            {p.role ? (
              <Badge variant="accent" size="S">
                {ROLE[p.role].label}
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="insp-sect">
          <div className="lh">坐标 [x, y, z] (m)</div>
          <KV k="x" v={p.xyz[0].toFixed(4)} mono />
          <KV k="y" v={p.xyz[1].toFixed(4)} mono />
          <KV k="z" v={p.xyz[2].toFixed(4)} mono />
        </div>
        <div className="insp-sect">
          <div className="lh">质量</div>
          <KV k="来源" v={p.measured ? "measured 实测" : "guessed 推测"} />
          <KV k="不确定度 σ" v={p.sigma.toFixed(1) + " mm"} mono />
          <Stat k="误差" v={p.err.toFixed(2) + " mm"} pct={Math.min(100, (p.err / 3) * 100)} variant={errVis} />
        </div>
      </>
    );
  }

  // run
  const r = CAL_RUNS.find((x) => x.id === calSel.id);
  if (!r) return null;
  return (
    <>
      <div className="insp-head">
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
          <span className="step-ico">
            <Icon name="list" size={16} />
          </span>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, fontFamily: "var(--font-code)" }}>{r.target}</h2>
        </div>
        <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
          {rmsBadge(r.rms)}
          <span style={{ fontSize: 11.5, color: "var(--chrome-faint)" }}>{r.created}</span>
        </div>
      </div>
      <div className="insp-sect">
        <div className="lh">概要</div>
        <KV k="方法" v={r.method} />
        <KV k="屏幕" v={r.screen} />
        <KV k="顶点数" v={r.vertices != null ? r.vertices.toLocaleString() : "—"} mono />
        <KV k="OBJ" v={r.obj ? "已导出" : "未导出"} />
      </div>
      {r.metrics ? (
        <div className="insp-sect">
          <div className="lh">质量指标 (mm)</div>
          <Stat
            k="middle_max_dev"
            v={r.metrics.mid_max.toFixed(2)}
            pct={Math.min(100, (r.metrics.mid_max / 12) * 100)}
            variant={r.metrics.mid_max < 3 ? "positive" : r.metrics.mid_max < 8 ? "notice" : "negative"}
          />
          <Stat
            k="middle_mean_dev"
            v={r.metrics.mid_mean.toFixed(2)}
            pct={Math.min(100, (r.metrics.mid_mean / 8) * 100)}
            variant="positive"
          />
          <Stat
            k="estimated_rms"
            v={r.metrics.est_rms.toFixed(2)}
            pct={Math.min(100, (r.metrics.est_rms / 12) * 100)}
            variant={(r.rms ?? 0) < 3 ? "positive" : (r.rms ?? 0) < 8 ? "notice" : "negative"}
          />
          <Stat
            k="estimated_p95"
            v={r.metrics.est_p95.toFixed(2)}
            pct={Math.min(100, (r.metrics.est_p95 / 16) * 100)}
            variant="notice"
          />
        </div>
      ) : (
        <div className="insp-sect">
          <div style={{ fontSize: 12, color: "var(--chrome-faint)" }}>该次重建未收敛，无质量指标。</div>
        </div>
      )}
    </>
  );
}
