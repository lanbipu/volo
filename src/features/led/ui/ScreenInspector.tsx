/* 屏幕 Inspector（设计：Screens.dc.html 右栏）。参数 / 变换 / 测试图三个页签。
   输入即改草稿（视口立即重画），离开输入框时整份 project.yaml 回写。 */
import { useState, type InputHTMLAttributes, type KeyboardEvent } from "react";
import type { GeneratePatternResult, ProjectConfig, ReconstructionRun, ScreenConfig, ShapePriorConfig } from "@/api/types";
import { copyText } from "@/lib/clipboard";
import { errText, toast } from "@/lib/toast";
import { Button, Empty, Field, Fields, IconButton, Inspector, InspectorBody, InspectorHead, Note, Props, Seg, Select, Status, Switch, ToolTabs, type SelectOption } from "@/ui";
import { alignmentFor, SHAPE_LABEL, screenSize } from "../model/geometry";
import { defaultShape, playPatternLocal, runSource, stopPatternLocal, usePatternImage, type PatternScheme, type ScreenTab } from "../model/screens";
import css from "./led.module.css";

const SHAPES: SelectOption<ShapePriorConfig["type"]>[] = (["flat", "folded", "curved", "arc", "l_shape", "u_shape"] as const).map((v) => ({ value: v, label: SHAPE_LABEL[v] }));

const fmt = (n: number | null | undefined, d = 2) => (n == null || !Number.isFinite(n) ? "" : String(+n.toFixed(d)));
const parse = (t: string) => {
  const n = Number(t);
  return t.trim() !== "" && Number.isFinite(n) ? n : null;
};

export interface ScreenInspectorProps {
  id: string;
  config: ProjectConfig;
  screen: ScreenConfig;
  run: ReconstructionRun | null;
  cabinet: { c: number; r: number } | null;
  tab: ScreenTab;
  onTab: (t: ScreenTab) => void;
  width: number;
  onClose: () => void;
  onDraft: (s: ScreenConfig) => void;
  /** 保存草稿；传 next 时直接保存它（开关 / 下拉这种一步到位的改动）。 */
  onCommit: (next?: ScreenConfig) => void;
  saving: boolean;
  patternOn: boolean;
  onPattern: (on: boolean) => void;
  pattern: GeneratePatternResult | null;
  onGenerate: (scheme: PatternScheme) => Promise<unknown>;
  generating: boolean;
  onOpenRun: (run: ReconstructionRun) => void;
}

export function ScreenInspector(p: ScreenInspectorProps) {
  const { id, run } = p;
  return (
    <Inspector width={p.width}>
      <InspectorHead
        tabs={
          <ToolTabs
            label="Inspector 内容"
            value={p.tab}
            onChange={p.onTab}
            tabs={[
              { key: "params", label: "参数" },
              { key: "transform", label: "变换" },
              { key: "pattern", label: "测试图" },
            ]}
          />
        }
        onClose={p.onClose}
        meta={
          <>
            <span>屏幕</span>
            {run ? <Status pill kind="success" label="已重建" /> : <Status pill kind="queued" label="还没有重建" />}
          </>
        }
        title={id}
        actions={
          <>
            <Button icon="output" aria-pressed={p.patternOn} disabled={!p.pattern} title={p.pattern ? undefined : "先在“测试图”里生成"} onClick={() => p.onPattern(!p.patternOn)}>
              {p.patternOn ? "隐藏测试图" : "显示测试图"}
            </Button>
            {run && (
              <Button icon="open" onClick={() => p.onOpenRun(run)}>
                打开重建 #{run.id}
              </Button>
            )}
          </>
        }
      />
      <InspectorBody>
        {p.tab === "params" && <ParamsTab {...p} />}
        {p.tab === "transform" && <TransformTab {...p} />}
        {p.tab === "pattern" && <PatternTab {...p} />}
        {p.tab !== "pattern" && <ScreenProps {...p} />}
        {p.saving && <p className={css.saving}>正在保存…</p>}
      </InspectorBody>
    </Inspector>
  );
}

/* ------------------------------ 可编辑数字框 ------------------------------ */

/** 文本态独立于草稿：允许“2.”这类中间输入；合法时立即写草稿，失焦提交。 */
function useNumField(onCommit: (next?: ScreenConfig) => void) {
  const [edit, setEdit] = useState<Record<string, string>>({});
  const bind = (key: string, shown: string, apply: (n: number) => void, opts: { int?: boolean; min?: number } = {}) => ({
    value: edit[key] ?? shown,
    onChange: (t: string) => {
      const clean = t.replace(opts.int ? /[^\d]/g : /[^\d.-]/g, "");
      setEdit((e) => ({ ...e, [key]: clean }));
      const n = parse(clean);
      if (n != null && (opts.min == null || n >= opts.min)) apply(opts.int ? Math.round(n) : n);
    },
    onBlur: () => {
      setEdit((e) => {
        const { [key]: _drop, ...rest } = e;
        void _drop;
        return rest;
      });
      onCommit();
    },
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && e.currentTarget.blur(),
  });
  return bind;
}

const HINT = "改动立即反映在视口里，离开输入框时保存。";

function ParamsTab({ screen, onDraft, onCommit }: ScreenInspectorProps) {
  const bind = useNumField(onCommit);
  const s = screen;
  const set = (patch: Partial<ScreenConfig>) => onDraft({ ...s, ...patch });
  const setShape = (patch: Partial<ShapePriorConfig>) => onDraft({ ...s, shape_prior: { ...s.shape_prior, ...patch } as ShapePriorConfig });
  const pitch = s.pixels_per_cabinet?.[0] ? s.cabinet_size_mm[0] / s.pixels_per_cabinet[0] : null;
  const setCab = (i: 0 | 1, v: number) => {
    const cab: [number, number] = [...s.cabinet_size_mm];
    cab[i] = v;
    set({ cabinet_size_mm: cab, pixels_per_cabinet: pitch ? [Math.round(cab[0] / pitch), Math.round(cab[1] / pitch)] : s.pixels_per_cabinet });
  };
  const setGrid = (i: 0 | 1, v: number) => {
    const g: [number, number] = [...s.cabinet_count];
    g[i] = v;
    set({ cabinet_count: g, irregular_mask: s.irregular_mask.filter(([c, r]) => c < g[0] && r < g[1]) });
  };
  const sh = s.shape_prior;
  const shapeFields: { key: string; label: string; unit: string; shown: string; apply: (n: number) => void; int?: boolean }[] = [];
  if (sh.type === "curved") shapeFields.push({ key: "radius", label: "半径", unit: "mm", shown: fmt(sh.radius_mm, 1), apply: (n) => setShape({ radius_mm: n }) });
  if (sh.type === "arc")
    shapeFields.push(
      { key: "flat", label: "中间平直", unit: "列", int: true, shown: String(sh.center_flat_cols), apply: (n) => setShape({ center_flat_cols: n }) },
      { key: "turn", label: "每列转角", unit: "°", shown: fmt(sh.angle_per_col_deg), apply: (n) => setShape({ angle_per_col_deg: n }) },
    );
  if (sh.type === "l_shape")
    shapeFields.push(
      { key: "left", label: "左段", unit: "列", int: true, shown: String(sh.left_cols), apply: (n) => setShape({ left_cols: n }) },
      { key: "corner", label: "拐角", unit: "°", shown: fmt(sh.corner_angle_deg), apply: (n) => setShape({ corner_angle_deg: n }) },
      { key: "soft", label: "过渡", unit: "列", int: true, shown: String(sh.soften_cols), apply: (n) => setShape({ soften_cols: n }) },
    );
  if (sh.type === "u_shape")
    shapeFields.push(
      { key: "wing", label: "两翼", unit: "列", int: true, shown: String(sh.wing_cols), apply: (n) => setShape({ wing_cols: n }) },
      { key: "corner", label: "拐角", unit: "°", shown: fmt(sh.corner_angle_deg), apply: (n) => setShape({ corner_angle_deg: n }) },
      { key: "soft", label: "过渡", unit: "列", int: true, shown: String(sh.soften_cols), apply: (n) => setShape({ soften_cols: n }) },
    );
  const shapeOpts = sh.type === "custom_segments" ? [...SHAPES, { value: "custom_segments" as const, label: SHAPE_LABEL.custom_segments }] : SHAPES;

  return (
    <Fields>
      <Field inline label="形状">
        <Select
          value={sh.type}
          options={shapeOpts}
          onChange={(t) => {
            if (t === sh.type) return;
            onCommit({ ...s, shape_prior: defaultShape(t === "custom_segments" ? "flat" : t, s.cabinet_count[0]) });
          }}
        />
      </Field>
      <Field inline label="箱体">
        <Fields row style={{ gap: 8 }}>
          <NumBox aria-label="箱体宽度" unit="宽" {...bind("cw", String(s.cabinet_size_mm[0]), (n) => setCab(0, n), { min: 1 })} />
          <NumBox aria-label="箱体高度" unit="高" {...bind("ch", String(s.cabinet_size_mm[1]), (n) => setCab(1, n), { min: 1 })} />
        </Fields>
      </Field>
      <Field inline label="排布">
        <Fields row style={{ gap: 8 }}>
          <NumBox aria-label="列数" unit="列" {...bind("cols", String(s.cabinet_count[0]), (n) => setGrid(0, n), { int: true, min: 1 })} />
          <NumBox aria-label="行数" unit="行" {...bind("rows", String(s.cabinet_count[1]), (n) => setGrid(1, n), { int: true, min: 1 })} />
        </Fields>
      </Field>
      <Field inline label="像素间距" htmlFor="sc-pitch" hint={shapeFields.length ? undefined : HINT}>
        <NumBox
          id="sc-pitch"
          unit="mm"
          placeholder="—"
          {...bind("pitch", fmt(pitch), (n) => n > 0 && set({ pixels_per_cabinet: [Math.round(s.cabinet_size_mm[0] / n), Math.round(s.cabinet_size_mm[1] / n)] }))}
        />
      </Field>
      {shapeFields.map((f, i) => (
        <Field key={f.key} inline label={f.label} htmlFor={`sc-${f.key}`} hint={i === shapeFields.length - 1 ? HINT : undefined}>
          <NumBox id={`sc-${f.key}`} unit={f.unit} {...bind(f.key, f.shown, f.apply, { int: f.int, min: 0 })} />
        </Field>
      ))}
    </Fields>
  );
}

function TransformTab({ id, config, screen, onDraft, onCommit }: ScreenInspectorProps) {
  const bind = useNumField(onCommit);
  const s = screen;
  const pos = s.position_m ?? [0, 0, 0];
  const setPos = (i: number, v: number) => {
    const p: [number, number, number] = [pos[0], pos[1], pos[2]];
    p[i] = v;
    onDraft({ ...s, position_m: p });
  };
  const group = alignmentFor(config, id);
  return (
    <>
      <Fields>
        <Field inline label="位置">
          <Fields row style={{ gap: 8 }}>
            {(["X", "Y", "Z"] as const).map((ax, i) => (
              <NumBox key={ax} aria-label={`位置 ${ax}（米）`} unit={ax} {...bind(`p${i}`, fmt(pos[i], 3), (n) => setPos(i, n))} />
            ))}
          </Fields>
        </Field>
        <Field inline label="朝向" htmlFor="sc-yaw">
          <NumBox id="sc-yaw" unit="°" {...bind("yaw", fmt(s.yaw_deg ?? 0), (n) => onDraft({ ...s, yaw_deg: n }))} />
        </Field>
        <Field inline label="底边离地" htmlFor="sc-lift" hint={`位置单位是米，绕竖直轴转。${HINT}`}>
          <NumBox id="sc-lift" unit="mm" {...bind("lift", fmt(s.height_offset_mm ?? 0, 1), (n) => onDraft({ ...s, height_offset_mm: n }))} />
        </Field>
        <Field inline label="出光面">
          <span className={css.switchLine}>
            <Switch
              label="出光面反向"
              checked={!!s.normal_flip}
              onChange={(v) => {
                onCommit({ ...s, normal_flip: v });
              }}
            />
            <span>{s.normal_flip ? "反向" : "默认"}</span>
          </span>
        </Field>
      </Fields>
      <Props
        style={{ marginTop: 24 }}
        items={[
          { label: "舞台对齐", value: group ? `已对齐${group.screens.length > 1 ? ` · 与 ${group.screens.filter((x) => x !== id).join("、")} 同组` : ""}` : "还没有对齐" },
          { label: "原点", value: s.origin_aligned ? "已移到舞台原点" : null },
        ]}
      />
    </>
  );
}

function PatternTab({ id, screen, pattern, onGenerate, generating }: ScreenInspectorProps) {
  const [scheme, setScheme] = useState<PatternScheme>("vpqsp");
  const [playing, setPlaying] = useState(false);
  const img = usePatternImage(pattern?.output_dir ?? null);
  const size = screenSize(screen);
  const gen = () => onGenerate(scheme).then(() => toast(`已生成 ${id} 的测试图`), (e) => toast(`生成失败：${errText(e)}`));
  const play = async () => {
    try {
      if (playing) {
        await stopPatternLocal();
        setPlaying(false);
        toast("已停止播放");
      } else if (pattern) {
        const where = await playPatternLocal(pattern.output_dir);
        setPlaying(true);
        toast(`正在 ${where} 上全屏播放`);
      }
    } catch (e) {
      toast(`播放失败：${errText(e)}`);
    }
  };
  return (
    <>
      <Fields>
        <Field inline label="图案">
          <Seg label="图案方案" options={[{ value: "vpqsp", label: "密集编码点" }, { value: "charuco", label: "ChArUco" }]} value={scheme} onChange={setScheme} />
        </Field>
      </Fields>
      <div className={css.btnRow}>
        <Button variant={pattern ? "default" : "primary"} icon={pattern ? "refresh" : "grid"} busy={generating} disabled={generating} onClick={gen}>
          {pattern ? "重新生成" : "生成测试图"}
        </Button>
        <Button icon={playing ? "stop" : "play"} disabled={!pattern} onClick={play}>
          {playing ? "停止播放" : "在本机显示器播放"}
        </Button>
      </div>
      {pattern ? (
        <>
          <figure className={css.patternFig} style={{ aspectRatio: size.res ? `${size.res[0]} / ${size.res[1]}` : `${size.widthM} / ${size.heightM}` }}>
            {img.data ? <img src={img.data} alt={`${id} 的测试图`} /> : <span>{img.isError ? "预览读取失败" : "正在读取预览…"}</span>}
          </figure>
          <Props
            items={[
              { label: "箱体", value: String(pattern.cabinet_count) },
              { label: "标记点", value: String(pattern.total_markers) },
              {
                label: "输出目录",
                value: <span className="ry-mono">{pattern.output_dir}</span>,
                action: <IconButton icon="copy" label="复制输出目录" size="sm" onClick={() => copyText(pattern.output_dir)} />,
              },
            ]}
          />
          {pattern.warnings.length > 0 && <Note kind="attention">{pattern.warnings.map((w) => w.message).join("；")}</Note>}
        </>
      ) : (
        <Empty icon="grid" title="还没有生成测试图">
          生成之后可以贴到视口里的屏幕上核对朝向，也可以在本机显示器上全屏播放。
        </Empty>
      )}
    </>
  );
}

function ScreenProps({ id, config, screen, run, cabinet }: ScreenInspectorProps) {
  const size = screenSize(screen);
  const curved = screen.shape_prior.type === "curved";
  const nodes = (screen.output_topology?.nodes?.length ? screen.output_topology.nodes : Object.keys(config.screens).length === 1 ? config.output_topology?.nodes : null) ?? [];
  return (
    <Props
      style={{ marginTop: 24 }}
      items={[
        { label: "分辨率", value: size.res ? <span className="ry-mono">{`${size.res[0]} × ${size.res[1]} px`}</span> : null },
        {
          label: "尺寸",
          value: <span className="ry-num">{curved ? `弧长 ${size.widthM.toFixed(2)} m × 高 ${size.heightM.toFixed(2)} m${size.angle != null ? `，张角 ${Math.round(size.angle)}°` : ""}` : `宽 ${size.widthM.toFixed(2)} m × 高 ${size.heightM.toFixed(2)} m`}</span>,
        },
        {
          label: "当前网格",
          value: run ? (
            <span>
              重建 <span className="ry-mono">#{run.id}</span> · {runSource(run)}
              {run.estimated_rms_mm != null ? ` · RMS ${run.estimated_rms_mm.toFixed(2)} mm` : ""}
            </span>
          ) : (
            "设计网格"
          ),
        },
        { label: "驱动", value: nodes.length ? <span className="ry-mono">{nodes.map((n) => `${n.machine.hostname} · ${n.node_id}`).join("，")}</span> : null },
        ...(cabinet ? [{ label: "所选箱体", value: <span className="ry-num">{`第 ${cabinet.c + 1} 列 · 第 ${cabinet.r + 1} 行`}</span> }] : []),
        { label: "标识", value: <span className="ry-mono">{id}</span>, action: <IconButton icon="copy" label="复制标识" size="sm" onClick={() => copyText(id, "已复制标识")} /> },
      ]}
    />
  );
}

/* TextInput 的数字版：透传 onBlur / onKeyDown。 */
function NumBox({ unit, value, onChange, ...rest }: { unit?: string; value: string; onChange: (t: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <div className="volo-input volo-input--num">
      <input type="text" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
      {unit && <span className="volo-input__unit">{unit}</span>}
    </div>
  );
}
