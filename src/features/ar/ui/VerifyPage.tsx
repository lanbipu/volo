/* 舞台 AR · 验证（设计：ArVerify.dc.html）。
   把当前采用的空间求解投回采集帧（vpcal verify overlay），看每个标记检测到的位置和投影回来的位置差多少。
   标注帧是 vpcal 画好的 PNG（十字 = 检测到的位置，圆圈 = 投影回来的位置）；只有本次运行生成的帧能读。
   导出 OpenTrackIO 也在这里（vpcal export opentrackio，UE 坐标系）。 */
import { useMemo, useRef, useState } from "react";
import { pickFile } from "@/api/commands";
import { useCurrentStage } from "@/features/stage";
import { copyText } from "@/lib/clipboard";
import { useInspector, useNav, INSPECTOR_MAX, INSPECTOR_MIN } from "@/lib/nav";
import { errText, toast } from "@/lib/toast";
import {
  Activity,
  Button,
  Chip,
  Crumbs,
  Empty,
  Field,
  Fields,
  FieldsTitle,
  Group,
  GroupRow,
  HeadRow,
  IconButton,
  Inspector,
  InspectorBody,
  InspectorHead,
  InspectorToggle,
  Meta,
  Note,
  Progress,
  Props,
  Row,
  RowEnd,
  RowTitle,
  Search,
  Seg,
  Sep,
  Spacer,
  Status,
  Table,
  TableBody,
  TextInput,
  Toolbar,
  ToolTabs,
  Workspace,
} from "@/ui";
import {
  adoptedRun,
  baseName,
  dirOf,
  exportOpenTrackIO,
  fullTime,
  joinPath,
  markerCenter,
  markerNo,
  markerPlace,
  patchWs,
  runLabel,
  runVerify,
  signed,
  useArJobs,
  useArLog,
  useArRuns,
  useArUi,
  useArWorkspace,
  useMarkerMap,
  useVerifyFrames,
  VERIFY_LIMIT_PX,
  type ArRunSummary,
  type MarkerDef,
  type VerifyData,
  type VerifyMarker,
} from "../model/ar";
import { logItems, useSlashFocus } from "./hooks";
import css from "./ar.module.css";

const COLS = "16px 64px minmax(120px, 1fr) 84px 84px 84px";
const bad = (m: VerifyMarker) => m.mean_px > VERIFY_LIMIT_PX;

export function VerifyPage() {
  const { stage, loading } = useCurrentStage();
  const path = stage?.path ?? null;
  const ws = useArWorkspace(path);
  const runsQ = useArRuns(path);
  const mapQ = useMarkerMap(ws.markerMap);
  const jobs = useArJobs();
  const ui = useArUi();
  const [inspOpen, setInsp] = useInspector("verify");
  const inspW = useNav((s) => s.inspectorWidth);
  const setInspW = useNav((s) => s.setInspectorWidth);
  const [over, setOver] = useState(false);
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);

  const runs = runsQ.data;
  const adopted = adoptedRun(runs, ws);
  const v = ws.verify;
  const basedOn = v ? (runs?.find((r) => r.id === v.runId) ?? null) : null;
  const byId = useMemo(() => new Map((mapQ.data?.markers ?? []).map((mk) => [mk.marker_id, mk])), [mapQ.data]);
  const all = useMemo(() => [...(v?.data.per_marker ?? [])].sort((a, b) => b.mean_px - a.mean_px), [v]);
  const match = (m: VerifyMarker) => !q.trim() || `${m.marker_id} 标记 ${markerNo(m.marker_id)} ${markerPlace(byId.get(m.marker_id))}`.toLowerCase().includes(q.trim().toLowerCase());
  const shown = all.filter((m) => (!over || bad(m)) && match(m));
  const sel = all.find((m) => m.marker_id === ui.verifySel) ?? shown[0] ?? null;

  const crumbs = <Crumbs icon="verify" current="验证" />;
  if (!stage) {
    return (
      <main className="ry-main">
        <Toolbar loc label="位置与对象操作">
          {crumbs}
        </Toolbar>
        {!loading && (
          <Empty icon="stage" title="还没有打开 Stage">
            打开一个 AR Stage 之后，这里复核空间求解的精度。
          </Empty>
        )}
      </main>
    );
  }

  const generate = async () => {
    if (!adopted) return toast("先做一次空间求解");
    let session = ws.session;
    if (!session) {
      session = await pickFile("采集会话 session.json", ["json"]).catch(() => null);
      if (!session) return;
      patchWs(stage.path, { session });
    }
    try {
      await runVerify(stage.path, session, adopted);
    } catch (e) {
      toast(`验证叠加失败：${errText(e)}`);
    }
  };
  const openExport = () => {
    ui.set({ verifyInsp: "export" });
    setInsp(true);
  };

  return (
    <Workspace
      inspector={<VerifyInspector stagePath={stage.path} sel={sel} marker={sel ? byId.get(sel.marker_id) : undefined} data={v?.data ?? null} run={adopted} width={inspW} onClose={() => setInsp(false)} />}
      inspectorOpen={inspOpen}
      inspectorWidth={inspW}
      onInspectorWidth={setInspW}
      minWidth={INSPECTOR_MIN}
      maxWidth={INSPECTOR_MAX}
    >
      <Toolbar loc label="位置与对象操作">
        {crumbs}
        <Spacer />
        <Button icon="refresh" busy={jobs.verifying} disabled={!adopted} onClick={() => void generate()}>
          {v ? "重新生成" : "生成验证叠加"}
        </Button>
        <Button variant="primary" icon="export" disabled={!adopted} onClick={openExport}>
          导出 OpenTrackIO
        </Button>
        <Sep />
        <InspectorToggle open={inspOpen} onChange={setInsp} />
      </Toolbar>
      <Progress on={jobs.verifying} />

      {v ? (
        <>
          <Toolbar label="视图：筛选、搜索与显示">
            <Group label="按结果筛选" fixed>
              <Chip pressed={!over} count={all.length} onClick={() => setOver(false)}>
                全部标记
              </Chip>
              <Chip pressed={over} count={all.filter(bad).length} onClick={() => setOver(true)}>
                {`超过 ${VERIFY_LIMIT_PX.toFixed(2)} px`}
              </Chip>
            </Group>
            <Meta className={css.metaGap}>{`基于空间求解 ${basedOn ? runLabel(basedOn) : v.runId} · 全局 RMS ${v.data.global_rms_px.toFixed(2)} px · ${v.data.num_frames} 帧`}</Meta>
            <Spacer />
            <Search ref={searchRef} value={q} onChange={setQ} placeholder="筛选…" aria-label="筛选标记：编号、位置" shortcut="/" />
          </Toolbar>
          {adopted && v.runId !== adopted.id && (
            <div className={css.banner}>
              <Status kind="attention" label="注意" srOnly />
              <span>{`这份验证基于 ${basedOn ? runLabel(basedOn) : v.runId}，现在采用的是 ${runLabel(adopted)}。重新生成一次才对得上。`}</span>
            </div>
          )}
          <FrameViewer data={v.data} />
          <Table label="逐标记误差，按平均值从大到小" className={css.tableTop}>
            <TableBody>
              <HeadRow cols={COLS}>
                <span />
                <span>标记</span>
                <span>位置</span>
                <RowEnd>平均</RowEnd>
                <RowEnd>最大</RowEnd>
                <RowEnd>出现</RowEnd>
              </HeadRow>
              {(["bad", "ok"] as const).map((grp) => {
                const rows = shown.filter((m) => (grp === "bad") === bad(m));
                if (!rows.length) return null;
                const kind = grp === "bad" ? "failed" : "success";
                const label = grp === "bad" ? "需处理" : "就绪";
                return [
                  <GroupRow key={`g-${grp}`} kind={kind} label={label} count={rows.length} />,
                  ...rows.map((m) => (
                    <Row key={m.marker_id} cols={COLS} selected={m === sel} onSelect={() => ui.set({ verifySel: m.marker_id, verifyInsp: "marker" })}>
                      <Status kind={kind} label={label} srOnly />
                      <RowTitle>{`标记 ${markerNo(m.marker_id)}`}</RowTitle>
                      <span className={`ry-row__sub ${css.sub}`}>{markerPlace(byId.get(m.marker_id))}</span>
                      <RowEnd>{`${m.mean_px.toFixed(2)} px`}</RowEnd>
                      <RowEnd>{`${m.max_px.toFixed(2)} px`}</RowEnd>
                      <RowEnd>{`${Math.min(m.count, v.data.num_frames)} / ${v.data.num_frames} 帧`}</RowEnd>
                    </Row>
                  )),
                ];
              })}
            </TableBody>
          </Table>
        </>
      ) : (
        <Empty
          icon="verify"
          title="还没有验证叠加"
          actions={
            <Button variant="primary" icon="play" busy={jobs.verifying} disabled={!adopted} onClick={() => void generate()}>
              生成验证叠加
            </Button>
          }
        >
          {adopted
            ? `把空间求解 ${runLabel(adopted)} 投回采集帧，叠加检测到的位置和投影回来的位置，逐个标记看偏差。`
            : "先在「空间求解」里做一次求解，再回来生成验证叠加。"}
        </Empty>
      )}
    </Workspace>
  );
}

/* ------------------------------ 标注帧 ------------------------------ */

function FrameViewer({ data }: { data: VerifyData }) {
  const frames = useVerifyFrames(data.annotated_images);
  const [i, setI] = useState(0);
  const [size, setSize] = useState<[number, number] | null>(null);
  const [cover, setCover] = useState(false);
  const n = data.annotated_images.length;
  const idx = Math.min(i, Math.max(0, n - 1));
  const url = frames.data?.[idx] ?? null;
  const row = data.per_frame.find((f) => data.annotated_images[idx]?.includes(baseName(f.image).replace(/\.[^.]+$/, ""))) ?? data.per_frame[idx];
  const unreadable = frames.isSuccess && n > 0 && frames.data.every((u) => !u);

  return (
    <div className={`volo-viewport ${css.frameView}`}>
      <div className="volo-viewport__canvas" role="img" aria-label={`标注帧 ${idx + 1} / ${n}`}>
        {url ? (
          <img className={cover ? css.frameImgCover : css.frameImg} src={url} alt="" onLoad={(e) => setSize([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])} />
        ) : (
          <div className={css.frameEmpty}>{frames.isLoading ? "正在读取标注帧…" : unreadable ? "标注帧要重新生成才能看：读取授权只在生成它的那次运行里有效。" : n ? "这一帧读不出来" : "这次验证没有写出标注帧"}</div>
        )}
      </div>
      <div className="volo-viewport__hud" data-at="tl" role="toolbar" aria-label="显示">
        <Seg
          label="显示"
          options={[
            { value: "overlay", label: "叠加" },
            { value: "plain", label: "只看画面" },
          ]}
          value="overlay"
          onChange={(v) => v === "plain" && toast("vpcal 只写出了叠加后的帧，原始画面还不能单独看")}
        />
      </div>
      <div className="volo-viewport__hud" data-at="tc" role="toolbar" aria-label="标注帧">
        <IconButton icon="chevron-left" label="上一帧" disabled={idx <= 0} onClick={() => setI(idx - 1)} />
        <span className={`ry-num ${css.frameNo}`}>{n ? `帧 ${idx + 1} / ${n}` : "没有帧"}</span>
        <IconButton icon="chevron-right" label="下一帧" disabled={idx >= n - 1} onClick={() => setI(idx + 1)} />
      </div>
      <div className="volo-viewport__hud volo-viewport__hud--col" data-at="tr" role="toolbar" aria-label="视角">
        <IconButton icon="frame" label={cover ? "适应窗口" : "铺满窗口"} pressed={cover} onClick={() => setCover((c) => !c)} />
        <IconButton icon="eye" label="放大所选标记（vpcal 还不输出每帧的标记位置）" disabled />
      </div>
      <div className="volo-viewport__readout" data-at="bl">
        <span>{row ? baseName(row.image) : "—"}</span>
        <span>{size ? `${size[0]} × ${size[1]}` : "—"}</span>
        <span>{row?.rms_px != null ? `本帧 RMS ${row.rms_px.toFixed(2)} px` : "本帧 RMS —"}</span>
      </div>
      <div className={`volo-viewport__legend ${css.legend}`} data-at="br">
        <span className="volo-viewport__key">
          <b aria-hidden="true" className={css.keyCross}>
            +
          </b>
          检测到的位置
        </span>
        <span className="volo-viewport__key">
          <i className={css.keyCircle} />
          投影回来的位置
        </span>
      </div>
    </div>
  );
}

/* ------------------------------ Inspector ------------------------------ */

function VerifyInspector({
  stagePath,
  sel,
  marker,
  data,
  run,
  width,
  onClose,
}: {
  stagePath: string;
  sel: VerifyMarker | null;
  marker: MarkerDef | undefined;
  data: VerifyData | null;
  run: ArRunSummary | null;
  width: number;
  onClose: () => void;
}) {
  const ui = useArUi();
  const go = useNav((s) => s.go);
  const events = useArLog((s) => s.events);
  const log = useMemo(() => events.filter((e) => e.area === "verify"), [events]);
  const tab = ui.verifyInsp;
  const tabs = (
    <ToolTabs
      label="Inspector 内容"
      value={tab}
      onChange={(k) => ui.set({ verifyInsp: k })}
      tabs={[
        { key: "marker", label: "所选标记" },
        { key: "export", label: "导出" },
        { key: "activity", label: "活动" },
      ]}
    />
  );

  if (tab === "export") return <ExportPane stagePath={stagePath} run={run} width={width} onClose={onClose} tabs={tabs} />;
  if (tab === "activity") {
    return (
      <Inspector width={width}>
        <InspectorHead tabs={tabs} onClose={onClose} title="活动" />
        <InspectorBody>
          {log.length ? (
            <Activity style={{ gap: 10 }} items={logItems(log)} />
          ) : (
            <Empty icon="clock" title="这次打开后还没有操作">
              生成验证叠加、导出 OpenTrackIO 都会记在这里。
            </Empty>
          )}
        </InspectorBody>
      </Inspector>
    );
  }
  if (!sel || !data) {
    return (
      <Inspector width={width}>
        <InspectorHead tabs={tabs} onClose={onClose} title="没有选中标记" />
        <InspectorBody>
          <Empty icon="marker" title={data ? "在列表里选一个标记" : "还没有验证结果"}>
            {data ? "看它的偏差和实测位置。" : "生成一次验证叠加之后，这里显示所选标记的偏差。"}
          </Empty>
        </InspectorBody>
      </Inspector>
    );
  }
  const isBad = bad(sel);
  const place = markerPlace(marker).replace("立面 · ", "");
  const ctr = marker ? markerCenter(marker) : null;
  return (
    <Inspector width={width}>
      <InspectorHead
        tabs={tabs}
        onClose={onClose}
        meta={
          <>
            <span>标记</span>
            <Status pill kind={isBad ? "failed" : "success"} label={isBad ? "需处理" : "就绪"} />
          </>
        }
        title={`标记 ${markerNo(sel.marker_id)} · ${place}`}
        actions={
          <Button
            icon="open"
            kbd="↵"
            onClick={() => {
              ui.set({ markerSel: sel.marker_id, markerInsp: "marker" });
              go("markers");
            }}
          >
            在“标记”里查看
          </Button>
        }
      />
      <InspectorBody>
        {isBad && (
          <>
            <Note kind="failed">
              <>
                <p>{`平均偏差 ${sel.mean_px.toFixed(2)} px，超过 ${VERIFY_LIMIT_PX.toFixed(2)} px。`}</p>
                <p>{sel.count < data.num_frames / 2 ? "看到它的帧不多，先补采几个能看清它的机位，再求解一次。" : "多数帧都看到了它还偏，多半是这个标记的实测位置有偏差。重新实测它和旁边的标记，再求解一次。"}</p>
              </>
            </Note>
            <div className={css.gap20} />
          </>
        )}
        <Props
          items={[
            { label: "平均", value: <span className="ry-num">{`${sel.mean_px.toFixed(2)} px`}</span> },
            { label: "最大", value: <span className="ry-num">{`${sel.max_px.toFixed(2)} px`}</span> },
            { label: "出现", value: <span className="ry-num">{`${data.num_frames} 帧里的 ${Math.min(sel.count, data.num_frames)} 帧`}</span> },
            { label: "偏移", value: null },
            { label: "真值", value: ctr ? <span className="ry-mono">{`x ${signedPlain(ctr[0])}  y ${signedPlain(ctr[1])}  z ${signedPlain(ctr[2])} m`}</span> : null },
            { label: "阈值", value: `${VERIFY_LIMIT_PX.toFixed(2)} px` },
          ]}
        />
      </InspectorBody>
    </Inspector>
  );
}

const signedPlain = (mm: number) => (mm < 0 ? `−${Math.abs(mm / 1000).toFixed(3)}` : (mm / 1000).toFixed(3));

function ExportPane({ stagePath, run, width, onClose, tabs }: { stagePath: string; run: ArRunSummary | null; width: number; onClose: () => void; tabs: React.ReactNode }) {
  const ws = useArWorkspace(stagePath);
  const jobs = useArJobs();
  const delay = ws.delay[0] ?? null;
  const [apply, setApply] = useState<"yes" | "no">(delay ? "yes" : "no");
  const defaultOut = run ? joinPath(dirOf(run.result_path)!, `opentrackio_${run.id}.json`) : "";
  const [out, setOut] = useState(defaultOut);
  const [done, setDone] = useState<{ output: string; samples?: number; applied_delay_ms?: number | null } | null>(null);
  const target = out.trim() || defaultOut;

  const go = async () => {
    if (!run || !ws.session) return;
    try {
      const r = await exportOpenTrackIO(ws.session, run, target, apply === "yes" && delay ? delay.path : null);
      setDone({ ...r, output: r.output ?? target });
      toast(`已导出 ${baseName(r.output ?? target)}`);
    } catch (e) {
      toast(`导出失败：${errText(e)}`);
    }
  };

  return (
    <Inspector width={width}>
      <InspectorHead
        tabs={tabs}
        onClose={onClose}
        meta={<span>导出 OpenTrackIO</span>}
        title={run ? `空间求解 ${runLabel(run)}` : "还没有可导出的求解"}
        actions={
          <Button variant="primary" icon="export" busy={jobs.exporting} disabled={!run || !ws.session} title={!ws.session ? "先选择采集会话" : undefined} onClick={() => void go()}>
            导出
          </Button>
        }
      />
      <InspectorBody>
        <p className={css.lead}>把追踪数据换算到真实世界坐标，写成 OpenTrackIO 给 UE 用。延迟可以在这里先扣掉，合成端就不要再补一次。</p>
        <Fields>
          <FieldsTitle>导出内容</FieldsTitle>
          <Field label="坐标系" inline>
            <span className={css.fixed}>UE · 固定</span>
          </Field>
          <Field label="延迟" inline>
            <Seg
              label="延迟"
              block
              options={[
                { value: "yes", label: delay ? `扣掉 ${signed(delay.data.cameras[0]?.delay_ms ?? 0)} ms` : "扣掉延迟" },
                { value: "no", label: "不扣" },
              ]}
              value={apply}
              onChange={setApply}
              disabled={!delay}
            />
          </Field>
          <Field label="写到" htmlFor="otio-out" hint={delay ? undefined : "还没有校准延迟，导出原始外参；延迟由合成端补偿。"}>
            <TextInput id="otio-out" mono value={out} onChange={setOut} placeholder={defaultOut} />
          </Field>
        </Fields>
        <div className={css.gap20} />
        <Props
          items={[
            { label: "求解", value: run ? <span className="ry-num">{`${runLabel(run)} · 验证 RMS ${run.validation_rms_px?.toFixed(2) ?? "—"} px`}</span> : null },
            { label: "会话", value: ws.session ? <span className="ry-mono">{baseName(dirOf(ws.session))}</span> : null },
            { label: "延迟档案", value: delay ? <span className="ry-num">{`${signed(delay.data.cameras[0]?.delay_ms ?? 0)} ms · ${fullTime(delay.at)}`}</span> : null },
            ...(done
              ? [
                  { label: "已写出", value: <span className="ry-mono">{done.output}</span>, action: <IconButton icon="copy" size="sm" label="复制路径" onClick={() => copyText(done.output, "已复制路径")} /> },
                  { label: "样本", value: done.samples != null ? <span className="ry-num">{`${done.samples} 个`}</span> : null },
                ]
              : []),
          ]}
        />
      </InspectorBody>
    </Inspector>
  );
}
