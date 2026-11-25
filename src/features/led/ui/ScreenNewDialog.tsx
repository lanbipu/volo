/* 新建屏幕（设计：ScreenNew.dc.html）。名称即 project.yaml 里的屏幕 key（也是测点名前缀）。 */
import { useState } from "react";
import type { ProjectConfig, ScreenConfig } from "@/api/types";
import { errText, toast } from "@/lib/toast";
import { Button, Check, Dialog, DialogBody, Field, Fields, Seg, TextInput } from "@/ui";
import { newScreenConfig, screenIdError, withScreen, type NewShape } from "../model/screens";
import { screenSize } from "../model/geometry";

const SHAPES: { value: NewShape; label: string }[] = [
  { value: "flat", label: "平面" },
  { value: "folded", label: "折线" },
  { value: "curved", label: "弧形" },
  { value: "l_shape", label: "L 形" },
  { value: "u_shape", label: "U 形" },
];

const num = (t: string) => t.replace(/[^\d.]/g, "");
const pitchOf = (s: ScreenConfig | undefined) => (s?.pixels_per_cabinet?.[0] ? +(s.cabinet_size_mm[0] / s.pixels_per_cabinet[0]).toFixed(2) : null);

export function ScreenNewDialog({ config, from, onClose, onCreated, save }: {
  config: ProjectConfig;
  /** 当前选中的屏幕：规格可以从它带过来。 */
  from: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
  save: (next: ProjectConfig) => Promise<unknown>;
}) {
  const src = from ? config.screens[from] : undefined;
  const [name, setName] = useState("");
  const [shape, setShape] = useState<NewShape>("flat");
  const [carry, setCarry] = useState(!!src);
  const [own, setOwn] = useState({ w: "500", h: "500", cols: "8", rows: "8", pitch: "2.6" });
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const f = carry && src ? { ...own, w: String(src.cabinet_size_mm[0]), h: String(src.cabinet_size_mm[1]), pitch: String(pitchOf(src) ?? "") } : own;
  /* 改了带过来的规格 → 不再算“带过来”，以当前值为起点继续编辑。 */
  const set = (k: keyof typeof own) => (t: string) => {
    if (carry && src && (k === "w" || k === "h" || k === "pitch")) setCarry(false);
    setOwn({ ...f, [k]: num(t) });
  };
  const id = name.trim();
  const idErr = screenIdError(id, config);
  const cab: [number, number] = [Number(f.w), Number(f.h)];
  const grid: [number, number] = [Math.round(Number(f.cols)), Math.round(Number(f.rows))];
  const pitch = Number(f.pitch) || null;
  const valid = !idErr && cab.every((v) => v > 0) && grid.every((v) => v > 0);
  const preview = cab.every((v) => v > 0) && grid.every((v) => v > 0) ? screenSize(newScreenConfig(shape, cab, grid, pitch)) : null;

  const create = async () => {
    setTouched(true);
    if (!valid) return;
    setBusy(true);
    try {
      await save(withScreen(config, id, newScreenConfig(shape, cab, grid, pitch)));
      toast(`已新建屏幕 ${id}`);
      onCreated(id);
    } catch (e) {
      toast(`新建失败：${errText(e)}`);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="新建屏幕"
      width={480}
      onClose={onClose}
      actions={
        <>
          <Button kbd="Esc" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={busy || (touched && !valid)} onClick={create}>
            创建
          </Button>
        </>
      }
    >
      <DialogBody>建好之后在三维视口里摆位置。这里填的参数随时能在 Inspector 里改。</DialogBody>
      <Fields style={{ marginTop: 16 }}>
        <Field label="名称" htmlFor="sn-name" error={touched && idErr ? idErr : undefined}>
          <TextInput id="sn-name" value={name} onChange={setName} placeholder="例如 MAIN" invalid={touched && !!idErr} onKeyDown={(e) => e.key === "Enter" && create()} />
        </Field>
        <Field label="形状" hint="形状之后还能改。异形屏先按最接近的形状建，再在视口里逐箱体调整。">
          <Seg block label="形状" options={SHAPES} value={shape} onChange={setShape} />
        </Field>
        <Fields row>
          <Field label="箱体宽" htmlFor="sn-w">
            <TextInput id="sn-w" num unit="mm" value={f.w} onChange={set("w")} />
          </Field>
          <Field label="箱体高" htmlFor="sn-h">
            <TextInput id="sn-h" num unit="mm" value={f.h} onChange={set("h")} />
          </Field>
        </Fields>
        <Fields row>
          <Field label="列" htmlFor="sn-cols">
            <TextInput id="sn-cols" num value={f.cols} onChange={set("cols")} />
          </Field>
          <Field label="行" htmlFor="sn-rows">
            <TextInput id="sn-rows" num value={f.rows} onChange={set("rows")} />
          </Field>
          <Field label="像素间距" htmlFor="sn-pitch">
            <TextInput id="sn-pitch" num unit="mm" value={f.pitch} onChange={set("pitch")} />
          </Field>
        </Fields>
        <p className="volo-field__hint" style={{ margin: 0 }}>
          {preview ? `${preview.widthM.toFixed(2)} × ${preview.heightM.toFixed(2)} m${preview.res ? ` · ${preview.res[0]} × ${preview.res[1]} px` : ""}` : "—"}
        </p>
        {src && (
          <Check checked={carry} onChange={setCarry}>
            把箱体规格和像素间距从“{from}”带过来
          </Check>
        )}
      </Fields>
    </Dialog>
  );
}
