/* 舞台 LED · 屏幕（设计：Screens.dc.html + ScreenNew.dc.html）。
   三维视口里看全部屏幕；选一块在 Inspector 里改参数 / 摆放 / 生成测试图。网格版本：设计 / 重建（当前采用的那次）/ 叠加对比。 */
import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { getRunReport } from "@/api/meshCommands";
import { isTauri } from "@/api/invoke";
import type { ReconstructionRun, ScreenConfig } from "@/api/types";
import { INSPECTOR_MAX, INSPECTOR_MIN, useInspector, useNav } from "@/lib/nav";
import { errText, toast } from "@/lib/toast";
import { Button, Chip, Crumbs, DisplayMenu, Empty, Group, Icon, IconButton, InspectorToggle, Seg, Sep, Spacer, Switch, Toolbar, Workspace } from "@/ui";
import { alignmentFor, designBoxes, rebuiltBoxes, unionBox, type Built } from "../model/geometry";
import { currentRun, ledKeys, useGeneratePattern, useLedStage, usePatternImage, usePatterns, useRuns, useSaveStage, useScreensUi, withScreen, type MeshVersion } from "../model/screens";
import { CameraRig, frame, Viewport, type PickHit, type SceneEntry, type ViewportLabel } from "../viewport/Viewport";
import { ScreenInspector } from "./ScreenInspector";
import { ScreenNewDialog } from "./ScreenNewDialog";
import css from "./led.module.css";

const VERSIONS: { value: MeshVersion; label: string }[] = [
  { value: "design", label: "设计" },
  { value: "rebuilt", label: "重建" },
  { value: "overlay", label: "叠加对比" },
];

export function ScreensPage() {
  const { stage, config, loading } = useLedStage();
  const ui = useScreensUi();
  const [inspOpen, setInsp] = useInspector("screens");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const openObject = useNav((s) => s.openObject);
  const [rig] = useState(() => new CameraRig());
  const [draft, setDraft] = useState<{ id: string; cfg: ScreenConfig } | null>(null);
  const [cab, setCab] = useState<{ id: string; c: number; r: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const [showLabels, setShowLabels] = useState(true);

  const path = stage?.path ?? null;
  const save = useSaveStage(path);
  const runsQ = useRuns(path);
  const patternsQ = usePatterns(path);
  const gen = useGeneratePattern(path);

  const ids = useMemo(() => Object.keys(config?.screens ?? {}).sort(), [config]);
  const sel = ui.sel && ids.includes(ui.sel) ? ui.sel : null;
  const runs = runsQ.data;
  const curRuns = useMemo(() => Object.fromEntries(ids.map((id) => [id, currentRun(runs, id)])) as Record<string, ReconstructionRun | null>, [ids, runs]);
  const reportQs = useQueries({
    queries: ids.map((id) => ({
      queryKey: ledKeys.report(curRuns[id]?.id ?? -1),
      queryFn: () => getRunReport(curRuns[id]!.id),
      enabled: isTauri() && !!curRuns[id] && ui.version !== "design",
      staleTime: Infinity,
    })),
  });
  const reports = ids.map((_, i) => reportQs[i]?.data ?? null);
  const reportKey = reports.map((r) => (r ? r.created_at + r.screen_id : "")).join("|");

  const screenOf = (id: string): ScreenConfig | undefined => (draft?.id === id ? draft.cfg : config?.screens[id]);
  const pattern = sel ? (patternsQ.data?.[sel] ?? null) : null;
  const patternImg = usePatternImage(ui.pattern && pattern ? pattern.output_dir : null);

  /* ---------------- 几何：每块屏一个 entry ---------------- */
  const built = useMemo(() => {
    const out: { id: string; g: Built; ghost: Built | null; rebuilt: boolean }[] = [];
    if (!config) return out;
    ids.forEach((id, i) => {
      const cfg = draft?.id === id ? draft.cfg : config.screens[id];
      const rep = reports[i];
      const useRebuilt = ui.version !== "design" && !!rep;
      const g = useRebuilt ? rebuiltBoxes(rep.surface, cfg, alignmentFor(config, id)) : designBoxes(cfg);
      const ghost = useRebuilt && (ui.version === "overlay" || ui.ghost) ? designBoxes(cfg) : null;
      out.push({ id, g, ghost, rebuilt: useRebuilt });
    });
    return out;
    // reports 由 reportKey 代表（useQueries 每次渲染返回新数组）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, ids, draft, ui.version, ui.ghost, reportKey]);

  const visible = useMemo(() => (ui.isolate && sel ? built.filter((b) => b.id === sel) : built), [built, ui.isolate, sel]);
  const entries = useMemo<SceneEntry[]>(
    () =>
      visible.map((b) => {
        const cfg = (draft?.id === b.id ? draft.cfg : config?.screens[b.id]) as ScreenConfig;
        return {
          id: b.id,
          isActive: true,
          selected: b.id === sel,
          boxes: b.g.boxes,
          ghostBoxes: b.ghost?.boxes ?? null,
          provByKey: null,
          cutout: true,
          patternUrl: b.id === sel && ui.pattern ? (patternImg.data ?? null) : null,
          normalSign: cfg?.normal_flip ? -1 : 1,
          selKeys: cab && cab.id === b.id ? [`${cab.c},${cab.r}`] : [],
        };
      }),
    [visible, sel, cab, ui.pattern, patternImg.data, draft, config],
  );
  const labels = useMemo<ViewportLabel[]>(
    () =>
      showLabels
        ? visible.flatMap((b) => (b.g.bbox ? [{ id: b.id, text: b.id, selected: b.id === sel, at: { x: (b.g.bbox.min.x + b.g.bbox.max.x) / 2, y: (b.g.bbox.min.y + b.g.bbox.max.y) / 2, z: b.g.bbox.max.z + 0.15 } }] : []))
        : [],
    [visible, sel, showLabels],
  );
  const allBox = useMemo(() => unionBox(visible.map((b) => b.g.bbox)), [visible]);
  const selBox = built.find((b) => b.id === sel)?.g.bbox ?? null;

  /* 用户还没动过相机时，跟着内容自动取景。 */
  const boxKey = allBox ? [allBox.min.x, allBox.min.y, allBox.min.z, allBox.max.x, allBox.max.y, allBox.max.z].map((v) => v.toFixed(2)).join(",") : "";
  useEffect(() => {
    if (allBox && !rig.touched) frame(rig, allBox, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxKey, rig]);

  /* ---------------- 选择 ---------------- */
  const select = (id: string | null) => {
    if (draft && draft.id !== id) setDraft(null);
    setCab(null);
    ui.set({ sel: id, pattern: false });
  };
  const onPick = (hit: PickHit | null) => {
    if (!hit) return select(null);
    if (hit.entryId !== sel) select(hit.entryId);
    if (ui.pick === "cabinet") setCab((c) => (c && c.id === hit.entryId && c.c === hit.box.c && c.r === hit.box.r ? null : { id: hit.entryId, c: hit.box.c, r: hit.box.r }));
  };

  /* ---------------- 保存 ---------------- */
  const commit = (next?: ScreenConfig) => {
    if (!config || !sel) return;
    const cfg = next ?? (draft?.id === sel ? draft.cfg : null);
    if (!cfg) return;
    if (next) setDraft({ id: sel, cfg: next });
    if (JSON.stringify(cfg) === JSON.stringify(config.screens[sel])) return setDraft(null);
    save.mutate(withScreen(config, sel, cfg), {
      onSuccess: () => setDraft((d) => (d && d.id === sel && d.cfg === cfg ? null : d)),
      onError: (e) => toast(`保存失败：${errText(e)}`),
    });
  };

  const openRun = (run: ReconstructionRun) => openObject("rebuild", { id: `run:${run.id}`, label: `重建 #${run.id} ${run.screen_id}`, status: "success", statusLabel: "成功" });

  const crumbs = <Crumbs icon="screens" current="屏幕" />;
  if (!stage || !config) {
    return (
      <main className="ry-main">
        <Toolbar loc label="位置与对象操作">
          {crumbs}
        </Toolbar>
        {!loading && (
          <Empty icon="stage" title="还没有打开 Stage">
            在侧栏顶部的 Stage 切换器里打开一个 Stage 文件夹，屏幕就会出现在这里。
          </Empty>
        )}
      </main>
    );
  }

  const selScreen = sel ? screenOf(sel) : undefined;
  const selRun = sel ? curRuns[sel] : null;
  const selBuilt = built.find((b) => b.id === sel);
  const verLabel = sel && selBuilt ? (selBuilt.rebuilt && selRun ? `${ui.version === "overlay" ? "叠加 " : "重建 "}#${selRun.id}` : ui.version === "design" ? "设计" : "设计 · 还没有重建") : VERSIONS.find((v) => v.value === ui.version)?.label;

  return (
    <Workspace
      inspector={
        sel &&
        selScreen && (
          <ScreenInspector
            id={sel}
            config={config}
            screen={selScreen}
            run={selRun}
            cabinet={cab && cab.id === sel ? cab : null}
            tab={ui.tab}
            onTab={(tab) => ui.set({ tab })}
            width={inspW}
            onClose={() => setInsp(false)}
            onDraft={(cfg) => setDraft({ id: sel, cfg })}
            onCommit={commit}
            saving={save.isPending}
            patternOn={ui.pattern}
            onPattern={(pattern) => ui.set({ pattern })}
            pattern={pattern}
            onGenerate={(scheme) => gen.mutateAsync({ screenId: sel, scheme, allIds: ids })}
            generating={gen.isPending}
            onOpenRun={openRun}
          />
        )
      }
      inspectorOpen={inspOpen && !!sel}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      <Toolbar loc label="位置与对象操作">
        {crumbs}
        <Spacer />
        <Button icon="plus" onClick={() => setCreating(true)}>
          新建屏幕
        </Button>
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>

      <Toolbar label="视图：屏幕、网格版本与显示">
        <Group label="聚焦屏幕" fixed>
          <Chip pressed={!sel} count={ids.length} onClick={() => select(null)}>
            全部
          </Chip>
          {ids.map((id) => (
            <Chip key={id} pressed={id === sel} onClick={() => select(id)}>
              {id === sel && <Icon name="check" size="sm" className={css.chipIcon} />}
              {id}
            </Chip>
          ))}
        </Group>
        <Spacer />
        <Seg label="网格版本" options={VERSIONS} value={ui.version} onChange={(version) => ui.set({ version })} />
        <DisplayMenu
          rows={[
            { label: "地面网格", control: <Switch label="地面网格" checked={ui.ground} onChange={(ground) => ui.set({ ground })} /> },
            { label: "屏幕名称", control: <Switch label="屏幕名称" checked={showLabels} onChange={setShowLabels} /> },
          ]}
          onReset={() => {
            ui.set({ ground: true, version: "rebuilt", ghost: false, isolate: false });
            setShowLabels(true);
          }}
        />
      </Toolbar>

      {ids.length === 0 ? (
        <Empty
          icon="screens"
          title="这个 Stage 还没有屏幕"
          actions={
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              新建屏幕
            </Button>
          }
        >
          新建一块屏幕，填上箱体规格和排布，再在视口里摆位置。
        </Empty>
      ) : (
        <Viewport rig={rig} entries={entries} ground={ui.ground} labels={labels} label={`三维视口：${ids.length} 块屏幕${sel ? `，${sel} 被选中` : ""}`} onPick={onPick} hover={ui.pick === "cabinet"}>
          <div className="volo-viewport__hud" data-at="tl" role="toolbar" aria-label="选择模式">
            <Seg
              label="选择模式"
              options={[
                { value: "screen", label: "屏幕" },
                { value: "cabinet", label: "箱体" },
              ]}
              value={ui.pick}
              onChange={(pick) => {
                setCab(null);
                ui.set({ pick });
              }}
            />
          </div>
          <div className="volo-viewport__hud volo-viewport__hud--col" data-at="tr" role="toolbar" aria-label="视角与显示">
            <IconButton icon="fit" label="框住全部" onClick={() => frame(rig, allBox)} />
            <IconButton icon="focus" label="聚焦所选" disabled={!selBox} onClick={() => frame(rig, selBox)} />
            <span className="volo-viewport__sep" />
            <IconButton icon="layers" label="叠加设计网格" pressed={ui.ghost || ui.version === "overlay"} disabled={ui.version !== "rebuilt"} onClick={() => ui.set({ ghost: !ui.ghost })} />
            <IconButton icon="eye" label="隐藏未选中的屏幕" pressed={ui.isolate} disabled={!sel} onClick={() => ui.set({ isolate: !ui.isolate })} />
          </div>
          <div className="volo-viewport__readout" data-at="bl">
            <span>{sel ?? `全部 ${ids.length} 块屏幕`}</span>
            {selScreen && (
              <span>
                {selScreen.cabinet_count[0]} × {selScreen.cabinet_count[1]} 箱体
              </span>
            )}
            {cab && cab.id === sel && <span>{`C${cab.c + 1} R${cab.r + 1}`}</span>}
            {verLabel && <span>{verLabel}</span>}
            <span>单位 mm</span>
          </div>
        </Viewport>
      )}

      {creating && (
        <ScreenNewDialog
          config={config}
          from={sel}
          onClose={() => setCreating(false)}
          save={(next) => save.mutateAsync(next)}
          onCreated={(id) => {
            setCreating(false);
            rig.release();
            select(id);
          }}
        />
      )}
    </Workspace>
  );
}
