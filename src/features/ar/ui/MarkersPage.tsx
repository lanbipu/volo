/* 舞台 AR · 标记（设计：ArMarkers.dc.html）。
   视口画出当前标记真值（marker map）里每个标记的位置：地面 / 立面，采用的那次求解里一次都没检测到的画虚线框。
   真值的导入（全站仪 CSV → marker-map create）、校验（marker-map validate）、校平（marker-map rebase --to-ground）都在这里。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { pickDirectory, pickFile } from "@/api/commands";
import { useCurrentStage } from "@/features/stage";
import { CameraRig, Viewport, type PickBox, type SceneEntry, type ViewportLabel } from "@/features/led";
import { useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN } from "@/lib/nav";
import { errText, toast } from "@/lib/toast";
import {
  Activity,
  Button,
  Chip,
  Crumbs,
  Empty,
  Group,
  IconButton,
  Inspector,
  InspectorBody,
  InspectorHead,
  InspectorToggle,
  Note,
  Props,
  Search,
  Seg,
  Sep,
  Spacer,
  Status,
  Toolbar,
  ToolTabs,
  Workspace,
  type StatusKind,
} from "@/ui";
import {
  adoptedRun,
  baseName,
  fullTime,
  generateBoards,
  GRADE_LABEL,
  groundOver,
  importSurvey,
  levelMap,
  markerCenter,
  markerCorners,
  markerRightMid,
  referencePlanes,
  markerNo,
  markerPlace,
  markerSize,
  patchWs,
  SOURCE_LABEL,
  tildePath,
  useArJobs,
  useArLog,
  useArRun,
  useArRuns,
  useArUi,
  useArWorkspace,
  useMarkerMap,
  validateMap,
  type MarkerDef,
  type MarkerFilter,
} from "../model/ar";
import { logItems, useSlashFocus } from "./hooks";
import css from "./ar.module.css";

const ENTRY = "markers";
/* 从台前略偏左、稍高处看向后墙（与设计稿的取景一致）。 */
const VIEW_AZ = 196;
const VIEW_EL = 18;
const m = (v: number) => v / 1000;

export function MarkersPage() {
  const { stage, loading } = useCurrentStage();
  const path = stage?.path ?? null;
  const ws = useArWorkspace(path);
  const mapQ = useMarkerMap(ws.markerMap);
  const runsQ = useArRuns(path);
  const run = adoptedRun(runsQ.data, ws);
  const runQ = useArRun(run?.result_path);
  const jobs = useArJobs();
  const ui = useArUi();
  const [inspOpen, setInsp] = useInspector("markers");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const [filter, setFilter] = useState<MarkerFilter>("all");
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);
  const [rig] = useState(() => {
    const r = new CameraRig();
    r.setAzEl(VIEW_AZ, VIEW_EL);
    r.apply();
    return r;
  });

  const markers = useMemo(() => mapQ.data?.markers ?? [], [mapQ.data]);
  const never = useMemo(() => new Set(runQ.data?.qa.detection?.map_markers_never_detected ?? []), [runQ.data]);
  const hasRun = !!runQ.data?.qa.detection;
  const missing = (mk: MarkerDef) => hasRun && never.has(mk.marker_id);
  const match = (mk: MarkerDef) => !q.trim() || `${mk.marker_id} 标记 ${markerNo(mk.marker_id)} ${markerPlace(mk)}`.toLowerCase().includes(q.trim().toLowerCase());
  const pass = (mk: MarkerDef, f: MarkerFilter) => (f === "ground" ? !!mk.on_ground : f === "wall" ? !mk.on_ground : f === "missing" ? missing(mk) : true);
  const shown = markers.filter((mk) => pass(mk, filter) && match(mk));
  const count = (f: MarkerFilter) => markers.filter((mk) => pass(mk, f)).length;
  const sel = markers.find((mk) => mk.marker_id === ui.markerSel) ?? null;

  const boxes = useMemo(() => {
    const out: PickBox[] = [];
    shown.forEach((mk, i) => {
      const c = markerCorners(mk);
      if (c) out.push({ key: mk.marker_id, c: i, r: 0, corners: c.map((p) => ({ x: m(p[0]), y: m(p[1]), z: m(p[2]) })), masked: missing(mk) });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shown/missing 由 markers、filter、q、never 决定
  }, [markers, filter, q, never, hasRun]);
  const bbox = useMemo(() => boxOf(boxes), [boxes]);
  const selBox = useMemo(() => boxOf(boxes.filter((b) => b.key === sel?.marker_id)), [boxes, sel]);
  const planes = useMemo<PickBox[]>(
    () =>
      referencePlanes(markers)
        .filter((p) => !p.ground || ui.showGround)
        .map((p, i) => ({ key: `plane:${p.key}`, c: i, r: 0, corners: p.corners.map((c) => ({ x: m(c[0]), y: m(c[1]), z: m(c[2]) })), masked: true })),
    [markers, ui.showGround],
  );
  const entries = useMemo<SceneEntry[]>(
    () => [
      { id: "planes", isActive: true, selected: false, boxes: planes, ghostBoxes: null, provByKey: null, cutout: true, patternUrl: null, normalSign: 1, selKeys: [] },
      { id: ENTRY, isActive: true, selected: false, boxes, ghostBoxes: null, provByKey: null, cutout: true, patternUrl: null, normalSign: 1, selKeys: sel ? [sel.marker_id] : [] },
    ],
    [boxes, planes, sel],
  );
  const labels = useMemo<ViewportLabel[]>(
    () =>
      ui.showLabels
        ? shown.flatMap((mk) => {
            const p = markerRightMid(mk);
            if (!p) return [];
            return [{ id: mk.marker_id, text: markerNo(mk.marker_id), at: { x: m(p[0]), y: m(p[1]), z: m(p[2]) }, selected: mk.marker_id === sel?.marker_id, plain: true }];
          })
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shown 由 markers、filter、q 决定
    [markers, filter, q, ui.showLabels, sel, never],
  );
  const bkey = bbox ? `${bbox.min.x},${bbox.max.x},${bbox.max.y},${bbox.max.z}` : "";
  useEffect(() => {
    if (bbox && !rig.touched) frameTight(rig, bbox, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 以 bkey 比较
  }, [bkey, rig]);

  const crumbs = <Crumbs icon="marker" current="标记" />;
  if (!stage) {
    return (
      <main className="ry-main">
        <Toolbar loc label="位置与对象操作">
          {crumbs}
        </Toolbar>
        {!loading && (
          <Empty icon="stage" title="还没有打开 Stage">
            打开一个 AR Stage 之后，这里管理它的标记真值。
          </Empty>
        )}
      </main>
    );
  }

  const doImport = async () => {
    const csv = await pickFile("全站仪测量 CSV", ["csv"]).catch(() => null);
    if (!csv) return;
    try {
      await importSurvey(stage.path, csv);
      toast(`已导入 ${baseName(csv)}`);
    } catch (e) {
      toast(`导入失败：${errText(e)}`);
    }
  };
  const doPick = async () => {
    const f = await pickFile("标记真值 JSON", ["json"]).catch(() => null);
    if (!f) return;
    patchWs(stage.path, { markerMap: f, validate: null });
    validateMap(stage.path, f).catch((e) => toast(`校验失败：${errText(e)}`));
  };
  const doBoards = async () => {
    const dir = await pickDirectory().catch(() => null);
    if (!dir) return;
    try {
      const r = await generateBoards(dir);
      toast(`生成了 ${r.boards?.length ?? 0} 张打印板${r.survey_template ? "和测量模板" : ""}`);
    } catch (e) {
      toast(`生成失败：${errText(e)}`);
    }
  };
  const revalidate = () => ws.markerMap && validateMap(stage.path, ws.markerMap).catch((e) => toast(`校验失败：${errText(e)}`));
  const lastAt = ws.validate && ws.validate.map === ws.markerMap ? ws.validate.at : null;

  const select = (id: string | null) => {
    ui.set({ markerSel: id });
    if (id) ui.set({ markerInsp: "marker" });
  };

  return (
    <Workspace
      inspector={
        ws.markerMap && (
          <MarkersInspector
            stagePath={stage.path}
            sel={sel}
            missing={sel ? missing(sel) : false}
            hasRun={hasRun}
            never={[...never]}
            markers={markers}
            width={inspW}
            onClose={() => setInsp(false)}
            onPick={doPick}
            onFocus={() => frameTight(rig, selBox)}
          />
        )
      }
      inspectorOpen={inspOpen && !!ws.markerMap}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      <Toolbar loc label="位置与对象操作">
        {crumbs}
        <Spacer />
        <Button variant="ghost" icon="grid" onClick={() => void doBoards()}>
          生成打印板
        </Button>
        <Button variant="primary" icon="import" busy={jobs.importing} onClick={() => void doImport()}>
          导入真值
        </Button>
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>

      {ws.markerMap ? (
        <>
          <Toolbar label="视图：筛选、搜索与显示">
            <Group label="按位置筛选" fixed>
              <Chip pressed={filter === "all"} count={count("all")} onClick={() => setFilter("all")}>
                全部
              </Chip>
              <Chip pressed={filter === "ground"} count={count("ground")} onClick={() => setFilter("ground")}>
                地面
              </Chip>
              <Chip pressed={filter === "wall"} count={count("wall")} onClick={() => setFilter("wall")}>
                立面
              </Chip>
              <Chip pressed={filter === "missing"} count={hasRun ? count("missing") : "—"} disabled={!hasRun} onClick={() => setFilter("missing")}>
                未检测到
              </Chip>
            </Group>
            <Spacer />
            <Search ref={searchRef} value={q} onChange={setQ} placeholder="筛选…" aria-label="筛选标记：编号、位置" shortcut="/" />
            <IconButton icon="refresh" disabled={jobs.validating} label={`重新校验${lastAt ? ` · 上次 ${new Date(lastAt).toLocaleTimeString("zh-CN", { hour12: false })}` : ""}`} onClick={() => void revalidate()} />
          </Toolbar>
          {mapQ.isError ? (
            <Empty icon="failed" title="读不了这份标记真值" actions={<Button onClick={() => void doPick()}>换一个文件</Button>}>
              {errText(mapQ.error)}
            </Empty>
          ) : (
            <Viewport rig={rig} entries={entries} ground={false} labels={labels} hover label={`三维视口：${markers.length} 个标记的实测位置`} onPick={(hit) => select(hit?.entryId === ENTRY ? hit.box.key : null)}>
              <div className="volo-viewport__hud" data-at="tl" role="toolbar" aria-label="视角">
                <Seg
                  label="视角"
                  options={[
                    { value: "persp", label: "透视" },
                    { value: "top", label: "俯视" },
                  ]}
                  value={ui.view}
                  onChange={(v) => {
                    ui.set({ view: v });
                    rig.preset(v, VIEW_AZ, VIEW_EL);
                  }}
                />
              </div>
              <div className="volo-viewport__hud volo-viewport__hud--col" data-at="tr" role="toolbar" aria-label="视角与显示">
                <IconButton icon="fit" label="框住全部" onClick={() => frameTight(rig, bbox)} />
                <IconButton icon="focus" label="聚焦所选" disabled={!selBox} onClick={() => frameTight(rig, selBox)} />
                <span className="volo-viewport__sep" />
                <IconButton icon="ground" label="显示拟合出的地面" pressed={ui.showGround} onClick={() => ui.set({ showGround: !ui.showGround })} />
                <IconButton icon="grid" label="显示编号" pressed={ui.showLabels} onClick={() => ui.set({ showLabels: !ui.showLabels })} />
              </div>
              <div className="volo-viewport__readout" data-at="bl">
                {sel ? (
                  <>
                    <span>{`标记 ${markerNo(sel.marker_id)}`}</span>
                    <span>{markerPlace(sel).replace("立面 · ", "")}</span>
                    <span>{xyzText(sel)}</span>
                  </>
                ) : (
                  <>
                    <span>{`${markers.length} 个标记`}</span>
                    <span>单位 m</span>
                  </>
                )}
              </div>
              <div className={`volo-viewport__legend ${css.legend}`} data-at="br">
                <span className="volo-viewport__key">
                  <i className={css.keySelected} />
                  选中
                </span>
                <span className="volo-viewport__key">
                  <i className={css.keyDetected} />
                  已检测到
                </span>
                <span className="volo-viewport__key">
                  <i className={css.keyMissing} />
                  未检测到 / 参照
                </span>
              </div>
              {mapQ.isLoading && (
                <div className="volo-viewport__legend" data-at="tc">
                  正在读取标记真值…
                </div>
              )}
            </Viewport>
          )}
        </>
      ) : (
        <Empty
          icon="marker"
          title="还没有标记真值"
          actions={
            <>
              <Button variant="primary" icon="import" busy={jobs.importing} onClick={() => void doImport()}>
                导入全站仪 CSV
              </Button>
              <Button icon="folder" onClick={() => void doPick()}>
                选择已有文件
              </Button>
            </>
          }
        >
          标记真值是棚里每个标记的实测位置，空间求解靠它把追踪对齐到真实世界。还没测的话，先生成打印板，贴好后用全站仪测。
        </Empty>
      )}
    </Workspace>
  );
}

/** 视口默认按包围球取景，留白太多；标记分布在两面墙 + 地面，收紧到 0.72。 */
function frameTight(rig: CameraRig, box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null, smooth = true) {
  if (!box) return;
  const v = rig.fitView(box.min, box.max);
  if (smooth) return rig.smoothTo({ target: v.target, dist: v.dist * 0.72 });
  rig.target.copy(v.target);
  rig.dist = v.dist * 0.72;
  rig.apply();
}

function boxOf(bs: PickBox[]) {
  if (!bs.length) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  bs.forEach((b) =>
    b.corners.forEach((p) => {
      min.x = Math.min(min.x, p.x);
      min.y = Math.min(min.y, p.y);
      min.z = Math.min(min.z, p.z);
      max.x = Math.max(max.x, p.x);
      max.y = Math.max(max.y, p.y);
      max.z = Math.max(max.z, p.z);
    }),
  );
  return { min, max };
}

function xyzText(mk: MarkerDef) {
  const c = markerCenter(mk);
  return c ? `x ${(c[0] / 1000).toFixed(3)}  y ${(c[1] / 1000).toFixed(3)}  z ${(c[2] / 1000).toFixed(3)} m` : "—";
}

/* ------------------------------ Inspector ------------------------------ */

function MarkersInspector({
  stagePath,
  sel,
  missing,
  hasRun,
  never,
  markers,
  width,
  onClose,
  onPick,
  onFocus,
}: {
  stagePath: string;
  sel: MarkerDef | null;
  missing: boolean;
  hasRun: boolean;
  never: string[];
  markers: MarkerDef[];
  width: number;
  onClose: () => void;
  onPick: () => void;
  onFocus: () => void;
}) {
  const ui = useArUi();
  const ws = useArWorkspace(stagePath);
  const jobs = useArJobs();
  const events = useArLog((s) => s.events);
  const log = useMemo(() => events.filter((e) => e.area === "markers"), [events]);
  const map = ws.markerMap!;
  const v = ws.validate && ws.validate.map === map ? ws.validate : null;
  const g = v?.data.ground_plane;
  const over = groundOver(g);
  const tab = ui.markerInsp;

  const truthStatus: { kind: StatusKind; label: string } = jobs.validating
    ? { kind: "running", label: "校验中" }
    : !v
      ? { kind: "queued", label: "未校验" }
      : over
        ? { kind: "failed", label: "需处理" }
        : v.data.validation.warnings.length
          ? { kind: "attention", label: "有提醒" }
          : { kind: "success", label: "就绪" };

  const level = () =>
    levelMap(stagePath, map).then(
      () => toast("已校平到地面，改用新文件"),
      (e) => toast(`校平失败：${errText(e)}`),
    );

  const sizes = [...new Set(markers.map((mk) => markerSize(mk)).filter((s): s is number => s != null).map((s) => Math.round(s)))];
  const sources = v ? Object.keys(v.data.world_alignment.by_source) : [...new Set(markers.map((mk) => mk.survey_source ?? "undeclared"))];
  const neverNos = never.map(markerNo);

  const head =
    tab === "marker" && sel ? (
      <InspectorHead
        tabs={<InspTabs />}
        onClose={onClose}
        meta={
          <>
            <span>标记</span>
            <Status pill kind={!hasRun ? "queued" : missing ? "failed" : "success"} label={!hasRun ? "还没求解" : missing ? "未检测到" : "已检测到"} />
          </>
        }
        title={`标记 ${markerNo(sel.marker_id)} · ${markerPlace(sel).replace("立面 · ", "")}`}
        actions={
          <Button icon="focus" onClick={onFocus}>
            在视口里聚焦
          </Button>
        }
      />
    ) : tab === "marker" ? (
      <InspectorHead tabs={<InspTabs />} onClose={onClose} title="没有选中标记" />
    ) : (
      <InspectorHead
        tabs={<InspTabs />}
        onClose={onClose}
        meta={
          <>
            <span>标记真值</span>
            <Status pill kind={truthStatus.kind} label={truthStatus.label} />
          </>
        }
        title={baseName(map)}
        actions={
          <>
            {over ? (
              <Button variant="primary" busy={jobs.leveling} onClick={() => void level()}>
                校平到地面
              </Button>
            ) : (
              !v && (
                <Button variant="primary" busy={jobs.validating} onClick={() => void validateMap(stagePath, map).catch((e) => toast(`校验失败：${errText(e)}`))}>
                  校验
                </Button>
              )
            )}
            <Button icon="project" onClick={onPick}>
              更换文件
            </Button>
          </>
        }
      />
    );

  return (
    <Inspector width={width}>
      {head}
      <InspectorBody>
        {tab === "truth" && (
          <>
            {over && g && (
              <>
                <Note kind="failed">
                  <>
                  <p>{`拟合出的地面相对水平面倾斜 ${g.tilt_from_z_deg!.toFixed(2)}°，容差 ${g.tolerance_deg!.toFixed(2)}°。不校平的话，求解出的摄影机会整体歪向一侧。`}</p>
                  <p>校平会把地面旋转对齐到 z = 0，并写出一份新文件，原文件不改。</p>
                  </>
                </Note>
                <div className={css.gap20} />
              </>
            )}
            {v && !over && v.data.validation.warnings.length > 0 && (
              <>
                <Note kind="attention">
                  <>
                    {v.data.validation.warnings.map((w, i) => (
                      <p key={i}>{w}</p>
                    ))}
                  </>
                </Note>
                <div className={css.gap20} />
              </>
            )}
            <Props
              items={[
                { label: "文件", value: <span className="ry-mono">{tildePath(map)}</span> },
                { label: "来源", value: sources.map((s) => SOURCE_LABEL[s] ?? s).join("、") || null },
                { label: "标记", value: markers.length ? `${markers.length} 个${sizes.length === 1 ? ` · 边长 ${sizes[0]} mm` : sizes.length ? ` · 边长 ${Math.min(...sizes)}–${Math.max(...sizes)} mm` : ""}` : null },
                {
                  label: "可检测",
                  value: v ? (
                    <span className="ry-num">{`${v.data.validation.num_detectable} / ${v.data.validation.num_markers}${neverNos.length ? ` · ${neverNos.join("、")} 号在采集里没有出现过` : ""}`}</span>
                  ) : null,
                },
                {
                  label: "世界对齐",
                  value: v ? `${GRADE_LABEL[v.data.world_alignment.grade] ?? v.data.world_alignment.grade}${v.data.world_alignment.max_uncertainty_mm != null ? ` · 最大 ±${v.data.world_alignment.max_uncertainty_mm.toFixed(1)} mm` : ""}` : null,
                },
                { label: "地面", value: g ? (g.available ? `由 ${g.num_ground_markers} 个地面标记拟合` : `拟合不出（${g.num_ground_markers} 个地面标记）`) : null },
                { label: "倾斜", value: g?.available && g.tilt_from_z_deg != null ? <span className="ry-num">{`${g.tilt_from_z_deg.toFixed(2)}° · 容差 ${g.tolerance_deg?.toFixed(2) ?? "—"}°`}</span> : null },
                { label: "校验于", value: v ? <span className="ry-num">{fullTime(v.at)}</span> : null },
              ]}
            />
          </>
        )}
        {tab === "marker" &&
          (sel ? (
            <Props
              items={[
                { label: "编号", value: <span className="ry-mono">{sel.marker_id}</span> },
                { label: "位置", value: markerPlace(sel) },
                { label: "坐标", value: <span className="ry-mono">{xyzText(sel)}</span> },
                { label: "边长", value: markerSize(sel) != null ? <span className="ry-num">{`${Math.round(markerSize(sel)!)} mm`}</span> : null },
                { label: "图案", value: sel.dictionary ? <span className="ry-mono">{`${sel.dictionary.replace(/^DICT_/, "")}${sel.tag_id != null ? ` · id ${sel.tag_id}` : ""}`}</span> : sel.marker_type },
                { label: "精度", value: sel.uncertainty_mm != null ? <span className="ry-num">{`±${sel.uncertainty_mm} mm`}</span> : null },
                { label: "来源", value: sel.survey_source ? (SOURCE_LABEL[sel.survey_source] ?? sel.survey_source) : null },
                { label: "检测", value: !hasRun ? "还没有求解记录" : missing ? "采用的那次求解里一次都没检测到" : "采用的那次求解里检测到了" },
              ]}
            />
          ) : (
            <Empty icon="marker" title="在视口里点一个标记">
              看它的实测坐标、图案和检测情况。
            </Empty>
          ))}
        {tab === "activity" &&
          (log.length ? (
            <Activity style={{ gap: 10 }} items={logItems(log)} />
          ) : (
            <Empty icon="clock" title="这次打开后还没有操作">
              导入、校验、校平真值都会记在这里。
            </Empty>
          ))}
      </InspectorBody>
    </Inspector>
  );
}

function InspTabs() {
  const ui = useArUi();
  return (
    <ToolTabs
      label="Inspector 内容"
      value={ui.markerInsp}
      onChange={(k) => ui.set({ markerInsp: k })}
      tabs={[
        { key: "truth", label: "真值" },
        { key: "marker", label: "所选标记" },
        { key: "activity", label: "活动" },
      ]}
    />
  );
}
