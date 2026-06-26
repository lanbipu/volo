// Volo · Calibrate —— 左侧工作流导航（网格重建组 + 镜头校正组 + 双进度）。移植自 page_calibrate.jsx left() + StepItem。
import { Icon } from "../../cache/ui/Icon";
import { useCalibrate } from "../state/store";
import { CAL_STEPS, STEP_DETAIL } from "../state/data";
import type { CalStepDef, CalStep } from "../state/types";

function StepItem({
  st,
  calStep,
  onSelect,
}: {
  st: CalStepDef;
  calStep: CalStep;
  onSelect: (s: CalStep) => void;
}) {
  const isCur = calStep === st.id;
  const done = st.status === "done";
  const cls = "cstep" + (isCur ? " on" : "") + (done ? " done" : "");
  const statusTxt =
    done ? "已完成" : st.status === "active" ? "进行中" : st.status === "ready" ? "可用" : "待运行";
  return (
    <div className={cls} onClick={() => onSelect(st.id)}>
      <span className="cstep-ico">{done ? <Icon name="check" size={13} /> : st.n}</span>
      <div className="cstep-main">
        <div className="cstep-t">
          {st.label}
          <span className="cn">{" · " + st.cn}</span>
        </div>
        <div className="cstep-s">{statusTxt}</div>
        {isCur ? <div className="step-d">{STEP_DETAIL[st.id]}</div> : null}
      </div>
    </div>
  );
}

export function Left() {
  const { calStep, setCalStep } = useCalibrate();
  const mesh = CAL_STEPS.filter((x) => x.group === "mesh");
  const lens = CAL_STEPS.filter((x) => x.group === "lens");
  return (
    <>
      <div className="sect">
        <div className="sect-h">
          <span className="t">网格重建</span>
        </div>
        <div className="cal-list">
          {mesh.map((st) => (
            <StepItem key={st.id} st={st} calStep={calStep} onSelect={setCalStep} />
          ))}
        </div>
      </div>
      <div className="sect">
        <div className="sect-h">
          <span className="t">镜头校正</span>
        </div>
        <div className="cal-list">
          {lens.map((st) => (
            <StepItem key={st.id} st={st} calStep={calStep} onSelect={setCalStep} />
          ))}
        </div>
      </div>
      <div className="sect" style={{ marginTop: "auto" }}>
        <div className="farm-roll">
          <div className="top">
            <span>重建进度</span>
            <span>4 / 5</span>
          </div>
          <div className="vmeter vmeter--accent">
            <div className="vmeter__fill" style={{ width: "80%" }} />
          </div>
          <div className="top" style={{ marginTop: 10 }}>
            <span>镜头校正</span>
            <span>未运行</span>
          </div>
          <div className="vmeter vmeter--neutral">
            <div className="vmeter__fill" style={{ width: "0%" }} />
          </div>
        </div>
      </div>
    </>
  );
}
