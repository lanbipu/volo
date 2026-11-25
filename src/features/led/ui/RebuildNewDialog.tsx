/* 新建重建（设计：RebuildNew.dc.html）。
   全站仪：选 CSV → 导入 → 重建，在这里直接跑完；视觉 / 结构光的采集在「摄影机」页做，这里只检查前提然后带过去。
   融合暂不开放；等效命令行（voloctl）还没有对应命令，所以不显示。 */
import { useState } from "react";
import type { ProjectConfig, ReconstructionRun } from "@/api/types";
import { useNav } from "@/lib/nav";
import { errText, toast } from "@/lib/toast";
import { Button, Check, Dialog, DialogBody, Field, Fields, Seg, Select, Status, TextInput, type StatusKind } from "@/ui";
import { composite, nodeScreens, resolveTopology, useOutputSession } from "../model/output";
import { useTotalStationRebuild } from "../model/rebuild";
import { currentRun, useRunReport } from "../model/screens";
import css from "./led.module.css";

type Method = "visual" | "sl" | "ts";

const METHODS: { value: Method | "fusion"; label: string; desc: string }[] = [
  { value: "visual", label: "用摄影机多机位拍", desc: "屏幕打出图案，摄影机换几十个机位拍。最准，需要一支标定好的镜头。" },
  { value: "sl", label: "结构光", desc: "机位不动，屏幕播放一组条纹。摄影机不方便移动时用。" },
  { value: "ts", label: "导入全站仪测量", desc: "导入测量点的 CSV。还没测的话，先生成一张指导卡，照着卡上的点位去测。" },
  { value: "fusion", label: "融合 · 还不能用", desc: "用全站仪的点校准视觉结果的尺度。需要这块屏先各有一次成功的视觉重建和全站仪导入。" },
];

interface Prereq {
  kind: StatusKind;
  sr: string;
  text: string;
}

export function RebuildNewDialog({ config, path, runs, initialScreen, onClose }: { config: ProjectConfig; path: string; runs: ReconstructionRun[]; initialScreen: string; onClose: () => void }) {
  const ids = Object.keys(config.screens);
  const cams = config.cameras ?? [];
  const [screen, setScreen] = useState(initialScreen);
  const [method, setMethod] = useState<Method>("visual");
  const [camId, setCamId] = useState<string | null>(cams[0]?.id ?? null);
  const [frames, setFrames] = useState("48");
  const go = useNav((s) => s.go);
  const ts = useTotalStationRebuild(path);
  const sess = useOutputSession();
  const last = currentRun(runs, screen);
  const lastReport = useRunReport(last?.id ?? null);

  const cam = cams.find((c) => c.id === camId) ?? null;
  const camLabel = (c: (typeof cams)[number]) => (c.lens?.focal_mm ? `${c.name} · ${c.lens.focal_mm} mm` : c.name);
  const usesCamera = method !== "ts";

  const prereqs: Prereq[] = [];
  if (usesCamera) {
    const topo = resolveTopology(config);
    const drivers = topo ? topo.nodes.filter((n) => nodeScreens(n, composite(config.screens)).includes(screen)).map((n) => n.node_id) : [];
    prereqs.push(
      sess.phase !== "idle"
        ? { kind: "success", sr: "就绪", text: `上屏正在输出${drivers.length ? `，${screen} 由 ${drivers.join("、")} 驱动` : ""}` }
        : { kind: "attention", sr: "未就绪", text: "上屏还没开始输出。先到「上屏」开始输出，采集时屏幕才能打图案。" },
    );
    if (!cam) prereqs.push({ kind: "attention", sr: "未就绪", text: "这个 Stage 还没有摄影机。先到「摄影机」添加一台。" });
    else if (cam.lens?.calibration_rms_px != null) prereqs.push({ kind: "success", sr: "就绪", text: `${cam.name} 的镜头标定可用 · RMS ${cam.lens.calibration_rms_px.toFixed(2)} px` });
    else prereqs.push({ kind: "attention", sr: "未就绪", text: `${cam.name} 还没有镜头标定。先到「摄影机」标定镜头。` });
  } else {
    prereqs.push({ kind: "success", sr: "就绪", text: "全站仪导入不需要上屏和摄影机。开始后选择测量 CSV，导入后直接重建。" });
  }
  const warn = lastReport.data?.quality_metrics.warnings?.[0];
  const outliers = lastReport.data?.quality_metrics.outliers?.length ?? 0;
  if (last && (warn || outliers)) prereqs.push({ kind: "attention", sr: "注意", text: `上一次（#${last.id}）${warn ?? `剔除了 ${outliers} 个测点`}` });

  const n = Number(frames);
  const framesErr = usesCamera && method === "visual" && !(Number.isInteger(n) && n > 0) ? "填一个正整数" : undefined;

  const start = () => {
    if (method === "ts") {
      ts.mutate(screen, {
        onSuccess: (id) => {
          if (id == null) return;
          toast(`${screen} 重建完成 · #${id}`);
          onClose();
        },
        onError: (e) => toast(`重建失败：${errText(e)}`),
      });
      return;
    }
    onClose();
    go("camera");
    toast(method === "visual" ? `在摄影机页采集 ${screen}：计划拍 ${n} 帧` : `在摄影机页对 ${screen} 跑结构光采集`);
  };

  return (
    <Dialog
      title="新建重建"
      width={560}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" className={css.pushLeft} disabled title="模拟采集还没有接入">
            先模拟一遍
          </Button>
          <Button kbd="Esc" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" busy={ts.isPending} disabled={!!framesErr || (usesCamera && !cam)} onClick={start}>
            {method === "ts" ? "选择 CSV 并重建" : "开始采集"}
          </Button>
        </>
      }
    >
      <DialogBody>量出一块屏幕的真实形状。每次重建都留一条记录，量完再决定采不采用。</DialogBody>
      <Fields style={{ marginTop: 16 }}>
        <Field label="屏幕">
          <Seg label="屏幕" block options={ids.map((id) => ({ value: id, label: id }))} value={screen} onChange={setScreen} />
        </Field>
        <Field label="怎么量">
          <div role="radiogroup" aria-label="怎么量" className={css.radioList}>
            {METHODS.map((m) => (
              <Check key={m.value} radio top name="rb-method" checked={method === m.value} disabled={m.value === "fusion"} onChange={() => m.value !== "fusion" && setMethod(m.value)}>
                {m.label}
                <small className={css.radioDesc}>{m.desc}</small>
              </Check>
            ))}
          </div>
        </Field>
        {usesCamera && (
          <Fields row>
            <Field label="摄影机">
              <Select value={camId} options={cams.map((c) => ({ value: c.id, label: camLabel(c) }))} onChange={setCamId} disabled={!cams.length} placeholder="还没有摄影机" />
            </Field>
            {method === "visual" && (
              <Field label="计划拍多少帧" htmlFor="rb-frames" error={framesErr}>
                <TextInput id="rb-frames" num value={frames} onChange={(t) => setFrames(t.replace(/\D/g, ""))} invalid={!!framesErr} />
              </Field>
            )}
          </Fields>
        )}
        <Field label="开始前">
          <ul className={css.prereqs}>
            {prereqs.map((p, i) => (
              <li key={i}>
                <Status kind={p.kind} label={p.sr} srOnly />
                <span>{p.text}</span>
              </li>
            ))}
          </ul>
        </Field>
      </Fields>
    </Dialog>
  );
}
