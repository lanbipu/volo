// Volo · Calibrate —— 重建方法选择（M1 全站仪 / M2 视觉 双卡）。移植自 page_calibrate.jsx methodView()。
import { Icon } from "../../cache/ui/Icon";
import { Button } from "../../cache/ui/Button";
import { Badge } from "../ui/Badge";
import { useCache } from "../../cache/state/store";
import { useCalibrate } from "../state/store";
import type { CalMethod } from "../state/types";

const METHODS: { id: CalMethod; icon: string; title: string; tag: string; desc: string; bullets: string[] }[] = [
  {
    id: "m1",
    icon: "target",
    title: "M1 · 全站仪",
    tag: "Trimble SX",
    desc: "使用全站仪逐点测量物理坐标，导入 CSV 后做刚体配准。精度最高，依赖现场测量与人工。",
    bullets: ["亚毫米级测量精度", "需现场架设与逐点采集", "CSV 导入 + 离群剔除"],
  },
  {
    id: "m2",
    icon: "camera",
    title: "M2 · 视觉",
    tag: "ChArUco + BA",
    desc: "相机拍摄 ChArUco 标定板，特征检测后做 bundle adjustment 联合优化。快速、自动，适合迭代。",
    bullets: ["自动角点检测", "bundle adjustment 联合优化", "分钟级迭代，无需测量员"],
  },
];

export function MethodView() {
  const { calMethod, setCalMethod, setCalStep } = useCalibrate();
  const { pushLog } = useCache();
  return (
    <>
      <div className="canvas-head">
        <span className="t">选择重建方法</span>
        <div className="right">
          <span className="toolchip">
            <Icon name="tools" size={14} />
            {"当前 · " + (calMethod === "m1" ? "M1 全站仪" : "M2 视觉")}
          </span>
        </div>
      </div>
      <div className="mcards">
        {METHODS.map((m) => {
          const on = calMethod === m.id;
          return (
            <div key={m.id} className={"mcard" + (on ? " on" : "")}>
              <div className="mc-top">
                <span className="mc-ic">
                  <Icon name={m.icon} size={20} />
                </span>
                <div style={{ flex: 1 }}>
                  <h3>{m.title}</h3>
                  <div className="mc-tag">{m.tag}</div>
                </div>
                {on ? (
                  <Badge variant="accent" size="S">
                    当前方法
                  </Badge>
                ) : null}
              </div>
              <div className="mc-desc">{m.desc}</div>
              <ul>
                {m.bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
              <div className="mc-f">
                {on ? (
                  <Button variant="accent" size="S" icon={<Icon name="chevr" size={15} />} onPress={() => setCalStep("survey")}>
                    继续
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="S"
                    icon={<Icon name="sync" size={15} />}
                    onPress={() => {
                      setCalMethod(m.id);
                      pushLog({ lv: "info", cat: "calibrate", msg: `切换重建方法为 ${m.title}` });
                    }}
                  >
                    使用此方法
                  </Button>
                )}
                {!on ? (
                  <span style={{ fontSize: 11.5, color: "var(--chrome-faint)" }}>切换将重置测量导入</span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
