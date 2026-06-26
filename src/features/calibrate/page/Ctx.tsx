// Volo · Calibrate —— 上下文工具条（屏幕选择 + 重建/导出/指导卡）。移植自 page_calibrate.jsx ctx() + ExportDrop。
import { useEffect, useRef, useState } from "react";
import { CtxTitle } from "../../../shell/chrome";
import { Icon } from "../../cache/ui/Icon";
import { Selector } from "../../cache/ui/Selector";
import { Button } from "../../cache/ui/Button";
import { useCache } from "../../cache/state/store";
import { useCalibrate } from "../state/store";
import { CAL_SCREENS } from "../state/data";

const EXPORT_OPTS = [
  { id: "disguise", label: "Disguise", sub: ".obj + 顶点贴图" },
  { id: "unreal", label: "Unreal", sub: "nDisplay 配置" },
  { id: "neutral", label: "Neutral", sub: ".obj 中性网格" },
];

function ExportDrop() {
  const { pushLog } = useCache();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [open]);
  return (
    <div className="ctx-drop" ref={ref}>
      <button className="ctx-drop-btn" onClick={() => setOpen((v) => !v)}>
        <Icon name="download" size={15} />
        导出
        <Icon name="chevd" size={14} />
      </button>
      {open ? (
        <div className="popover">
          {EXPORT_OPTS.map((o) => (
            <div
              key={o.id}
              className="pop-i"
              onClick={() => {
                setOpen(false);
                pushLog({ lv: "ok", cat: "calibrate", msg: `导出网格为 ${o.label} 格式 → mesh_v6.obj` });
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
                <span className="pop-l">{o.label}</span>
                <span className="pop-s">{o.sub}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Ctx() {
  const { calScreen, setCalScreen } = useCalibrate();
  const { pushLog } = useCache();
  const sc = CAL_SCREENS.find((x) => x.id === calScreen) ?? CAL_SCREENS[0];
  return (
    <>
      <CtxTitle icon="calibrate" title="Calibrate" sub="LED 网格重建 → 镜头校正" />
      <div className="ctx-div" />
      <Selector
        kpre="屏幕"
        value={calScreen}
        width={196}
        options={CAL_SCREENS.map((x) => ({
          id: x.id,
          label: x.name,
          sub: `${x.cols}×${x.rows} · ${x.panels} 面板`,
        }))}
        onChange={setCalScreen}
      />
      <div className="ctx-actions">
        <Button
          variant="secondary"
          size="S"
          icon={<Icon name="sync" size={15} />}
          onPress={() => {
            pushLog({ lv: "info", cat: "calibrate", msg: `重建 ${sc.name} 网格 …` });
            pushLog({ lv: "ok", cat: "calibrate", msg: "mesh_v7 重建收敛，estimated RMS 0.40 mm" });
          }}
        >
          重建
        </Button>
        <ExportDrop />
        <Button
          variant="secondary"
          size="S"
          icon={<Icon name="doc" size={15} />}
          onPress={() => pushLog({ lv: "info", cat: "calibrate", msg: "生成校正指导卡 → guide_card.pdf" })}
        >
          生成指导卡
        </Button>
      </div>
    </>
  );
}
