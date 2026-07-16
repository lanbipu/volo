/* Volo — live-capture developer console (hash #/dev/capture).
   开发者调试页（plan §0 第 6 条豁免：非产品 UI）——在 Calibrate 采集面板的
   Claude Design handoff 落地之前，用这页驱动并验证完整闭环：

     spawn vpcal capture session (streaming bridge, W3.1)
       ← NDJSON: progress / pose_captured / detect_feedback / coverage_update
                 request_pattern / preview_ready / warning / result
       → stdin: {"cmd": finish|stop|skip_pose|pattern_ready}
     pattern player window (commands/player.rs) ← request_pattern 自动接线
     MJPEG preview (vpcal preview server) → <img>

   产品采集面板落地时，本页的数据流封装（useCaptureSession）原样复用。 */
import * as React from "react";
import {
  spawnSidecarStreaming,
  useSidecarStream,
  type SidecarStreamLineEvent,
} from "../api/sidecarStream";
import {
  closePatternPlayer,
  listMonitors,
  openPatternPlayer,
  playerClear,
  playerShowPattern,
  type MonitorInfo,
  type ShowPatternResult,
} from "../api/player";

/* ---------------- vpcal NDJSON event shapes (subset we render) ---------------- */

interface VpcalEvent {
  type: string;
  sequence?: number;
  [k: string]: unknown;
}

interface CoverageSummary {
  poses_captured: number;
  sensor_coverage_pct: number;
  sensor_missing_regions: string[];
  screen_markers_seen: number;
  screen_markers_total: number;
  screen_coverage_pct: number;
  pose_spatial_spread_mm: number;
  suggestions: string[];
  angular_spread_deg?: number;
  edge_obs_fraction?: number;
  corners_present?: number;
  center_present?: boolean;
  rotation_axis_spread?: number;
  gate_checklist?: Array<{
    key: string;
    label: string;
    ok: boolean;
    value: unknown;
    target: unknown;
    hint?: string;
  }>;
}

/* ---------------- capture session data layer (reusable by the real panel) ---------------- */

export interface CaptureSessionOptions {
  screenPath: string;
  outDir: string;
  backend: string;
  device: string;
  trackProtocol: string;
  trackPort: number;
  trackHost?: string;
  poses: number;
  inverted: boolean;
  graycodeSync: boolean;
  lensPath: string;
  settleMs: number;
  burst: number;
  width?: number | string | null;
  height?: number | string | null;
  fps?: number | string | null;
  transferFunction?: string;
}

export function buildSessionArgs(o: CaptureSessionOptions): string[] {
  const args = [
    "capture", "session",
    "--screen", o.screenPath,
    "--out", o.outDir,
    "--backend", o.backend,
    "--device", o.device,
    "--track-protocol", o.trackProtocol,
    "--track-port", String(o.trackPort),
    "--track-host", o.trackHost || "0.0.0.0",
    "--poses", String(o.poses),
    "--settle-ms", String(o.settleMs),
    "--burst", String(o.burst),
    "--preview-port", "0",
    "--output", "ndjson",
  ];
  if (o.width) args.push("--width", String(o.width));
  if (o.height) args.push("--height", String(o.height));
  if (o.fps) args.push("--fps", String(o.fps));
  if (o.transferFunction) args.push("--transfer-function", o.transferFunction);
  if (o.inverted) args.push("--inverted");
  if (o.graycodeSync) args.push("--graycode-sync");
  if (o.lensPath) args.push("--lens", o.lensPath);
  return args;
}

export function useCaptureSession() {
  const [taskId, setTaskId] = React.useState<string | null>(null);
  const [spawnError, setSpawnError] = React.useState<string | null>(null);
  const { state, writeLine, cancel } = useSidecarStream(taskId);

  const events = React.useMemo<VpcalEvent[]>(
    () =>
      state.lines
        .map((l: SidecarStreamLineEvent) => l.parsed as VpcalEvent | undefined)
        .filter((p): p is VpcalEvent => !!p && typeof p.type === "string"),
    [state.lines],
  );

  const latest = <T,>(type: string): T | null => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === type) return events[i] as unknown as T;
    }
    return null;
  };

  const start = async (options: CaptureSessionOptions) => {
    setSpawnError(null);
    try {
      const resp = await spawnSidecarStreaming("vpcal", buildSessionArgs(options));
      setTaskId(resp.task_id);
    } catch (e) {
      setSpawnError(e instanceof Error ? e.message : String(e));
    }
  };

  const sendCmd = (cmd: Record<string, unknown>) => writeLine(JSON.stringify(cmd));

  return { taskId, spawnError, state, events, latest, start, sendCmd, cancel };
}

/* -------------------------------- page -------------------------------- */

const box: React.CSSProperties = {
  border: "1px solid var(--border-secondary, #3a3a3a)",
  borderRadius: 8,
  padding: 12,
  background: "var(--surface-secondary, #222)",
};
const h2: React.CSSProperties = { margin: "0 0 8px", fontSize: 14, fontWeight: 600 };
const label: React.CSSProperties = { fontSize: 12, opacity: 0.8, display: "block", marginBottom: 2 };
const input: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "4px 8px", fontSize: 12,
  background: "var(--surface-primary, #171717)", border: "1px solid var(--border-secondary, #3a3a3a)",
  borderRadius: 6, color: "inherit",
};
const btn: React.CSSProperties = {
  padding: "5px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer",
  border: "1px solid var(--border-secondary, #3a3a3a)",
  background: "var(--surface-tertiary, #2c2c2c)", color: "inherit",
};

function Field(props: { name: string; value: string; onChange: (v: string) => void; width?: number }) {
  return (
    <div style={{ width: props.width ?? 220 }}>
      <span style={label}>{props.name}</span>
      <input style={input} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
    </div>
  );
}

export function DevCapture(): React.ReactElement {
  const [opts, setOpts] = React.useState<CaptureSessionOptions>({
    screenPath: "", outDir: "", backend: "uvc", device: "0",
    trackProtocol: "freed", trackPort: 6301, poses: 8,
    inverted: false, graycodeSync: false, lensPath: "", settleMs: 300, burst: 5,
  });
  const [patternDir, setPatternDir] = React.useState("");
  const [monitors, setMonitors] = React.useState<MonitorInfo[]>([]);
  const [monitorIdx, setMonitorIdx] = React.useState(0);
  const [playerNote, setPlayerNote] = React.useState<string>("");
  const session = useCaptureSession();

  const set = (patch: Partial<CaptureSessionOptions>) =>
    setOpts((o) => ({ ...o, ...patch }));

  /* request_pattern → 播放窗自动切图 → pattern_ready 回执（Phase 3c 闭环）。 */
  const handledSeq = React.useRef(new Set<number>());
  React.useEffect(() => {
    for (const ev of session.events) {
      if (ev.type !== "request_pattern" || typeof ev.sequence !== "number") continue;
      if (handledSeq.current.has(ev.sequence)) continue;
      handledSeq.current.add(ev.sequence);
      const pattern = String(ev.pattern ?? "normal");
      if (!patternDir) {
        setPlayerNote(`✗ 后端请求 ${pattern}，但未配置 pattern 目录；未发送 pattern_ready`);
        continue;
      }
      void playerShowPattern(`${patternDir}/${pattern}.png`, pattern)
        .then((r: ShowPatternResult) => {
          setPlayerNote(r.resolution_mismatch
            ? `⚠ 分辨率不一致：pattern ${r.pattern_width}×${r.pattern_height} vs 窗口 ${r.window_width}×${r.window_height}（违反 C0 1:1 前置）`
            : `✓ 已显示 ${pattern}（${r.pattern_width}×${r.pattern_height}，1:1）`);
          return session.sendCmd({ cmd: "pattern_ready", pattern });
        })
        .catch((e) => setPlayerNote(`✗ 播放失败：${e instanceof Error ? e.message : String(e)}`));
    }
  }, [session.events, patternDir]); // eslint-disable-line react-hooks/exhaustive-deps

  const preview = session.latest<{ mjpeg_url?: string }>("preview_ready");
  const coverage = session.latest<CoverageSummary>("coverage_update");
  const progress = session.latest<{ state?: string; poses_captured?: number }>("progress");
  const detect = session.latest<{ pose_index?: number; marker_hits?: number; mean_confidence?: number }>("detect_feedback");
  const result = session.latest<{ data?: { session_dir?: string; poses_captured?: number; lens_ready?: boolean } }>("result");
  const running = session.taskId !== null && session.state.exit === null;

  return (
    <div style={{
      minHeight: "100vh", padding: 16, boxSizing: "border-box",
      background: "var(--surface-primary, #171717)", color: "var(--text-primary, #eee)",
      fontFamily: '-apple-system, "PingFang SC", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif',
      fontSize: 13, lineHeight: 1.7, display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{ fontSize: 16, fontWeight: 600 }}>
        实时采集开发者控制台 <span style={{ opacity: 0.5, fontSize: 12 }}>#/dev/capture · 非产品 UI</span>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {/* ── 会话配置 ── */}
        <div style={{ ...box, flex: "1 1 460px" }}>
          <div style={h2}>① 采集会话</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Field name="screen.json" value={opts.screenPath} onChange={(v) => set({ screenPath: v })} width={320} />
            <Field name="输出目录" value={opts.outDir} onChange={(v) => set({ outDir: v })} width={320} />
            <Field name="lens.json（可选）" value={opts.lensPath} onChange={(v) => set({ lensPath: v })} width={320} />
            <Field name="backend (uvc|ndi|decklink|synthetic)" value={opts.backend} onChange={(v) => set({ backend: v })} width={230} />
            <Field name="device" value={opts.device} onChange={(v) => set({ device: v })} width={80} />
            <Field name="追踪协议" value={opts.trackProtocol} onChange={(v) => set({ trackProtocol: v })} width={110} />
            <Field name="追踪端口" value={String(opts.trackPort)} onChange={(v) => set({ trackPort: Number(v) || 6301 })} width={90} />
            <Field name="pose 数" value={String(opts.poses)} onChange={(v) => set({ poses: Number(v) || 0 })} width={70} />
            <Field name="settle (ms)" value={String(opts.settleMs)} onChange={(v) => set({ settleMs: Number(v) || 300 })} width={90} />
            <Field name="连拍帧数" value={String(opts.burst)} onChange={(v) => set({ burst: Number(v) || 5 })} width={80} />
          </div>
          <div style={{ display: "flex", gap: 14, margin: "8px 0" }}>
            <label style={{ fontSize: 12 }}>
              <input type="checkbox" checked={opts.inverted} onChange={(e) => set({ inverted: e.target.checked })} /> inverted 双帧
            </label>
            <label style={{ fontSize: 12 }}>
              <input type="checkbox" checked={opts.graycodeSync} onChange={(e) => set({ graycodeSync: e.target.checked })} /> Gray code 确认
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button style={{ ...btn, background: "#2f5c34" }} disabled={running || !opts.screenPath || !opts.outDir}
              onClick={() => void session.start(opts)}>▶ 开始采集</button>
            <button style={btn} disabled={!running} onClick={() => void session.sendCmd({ cmd: "finish" })}>完成并组装</button>
            <button style={btn} disabled={!running} onClick={() => void session.sendCmd({ cmd: "skip_pose" })}>跳过当前 pose</button>
            <button style={{ ...btn, background: "#5c2f2f" }} disabled={!running} onClick={() => void session.cancel()}>■ 中止</button>
          </div>
          {session.spawnError ? <div style={{ color: "#f66", marginTop: 6 }}>启动失败：{session.spawnError}</div> : null}
        </div>

        {/* ── 播放器 ── */}
        <div style={{ ...box, flex: "1 1 380px" }}>
          <div style={h2}>② 图案播放器（第二窗口）</div>
          <Field name="pattern 目录（含 normal.png / inverted.png）" value={patternDir} onChange={setPatternDir} width={340} />
          <div style={{ display: "flex", gap: 8, alignItems: "end", margin: "8px 0", flexWrap: "wrap" }}>
            <button style={btn} onClick={() => void listMonitors().then(setMonitors)}>枚举显示器</button>
            <select style={{ ...input, width: 240 }} value={monitorIdx} onChange={(e) => setMonitorIdx(Number(e.target.value))}>
              {monitors.map((m) => (
                <option key={m.index} value={m.index}>
                  {m.index}: {m.name ?? "未命名"} {m.width}×{m.height}{m.is_primary ? "（主屏）" : ""}
                </option>
              ))}
            </select>
            <button style={btn} onClick={() => void openPatternPlayer(monitorIdx).then((w) =>
              setPlayerNote(`播放窗已置于显示器 ${w.monitor_index}（${w.width}×${w.height} 物理像素）`))}>打开播放窗</button>
            <button style={btn} onClick={() => void closePatternPlayer()}>关闭</button>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button style={btn} disabled={!patternDir} onClick={() => void playerShowPattern(`${patternDir}/normal.png`, "normal")
              .then((r) => setPlayerNote(r.resolution_mismatch ? "⚠ 分辨率不一致" : "✓ normal 已显示"))}>显示 normal</button>
            <button style={btn} disabled={!patternDir} onClick={() => void playerShowPattern(`${patternDir}/inverted.png`, "inverted")
              .then((r) => setPlayerNote(r.resolution_mismatch ? "⚠ 分辨率不一致" : "✓ inverted 已显示"))}>显示 inverted</button>
            <button style={btn} onClick={() => void playerClear()}>黑场</button>
          </div>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.9 }}>{playerNote}</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {/* ── 预览 + 状态 ── */}
        <div style={{ ...box, flex: "2 1 500px" }}>
          <div style={h2}>③ 预览 · 状态机</div>
          {preview?.mjpeg_url
            ? <img src={preview.mjpeg_url} alt="预览" style={{ width: "100%", maxWidth: 720, background: "#000", borderRadius: 6 }} />
            : <div style={{ opacity: 0.6 }}>等待 preview_ready 事件（sidecar 启动后自动出现）…</div>}
          <div style={{ display: "flex", gap: 18, marginTop: 8, fontSize: 12, flexWrap: "wrap" }}>
            <span>状态：<strong>{progress?.state ?? "—"}</strong></span>
            <span>已采集 pose：<strong>{progress?.poses_captured ?? 0}</strong></span>
            <span>最近检测：{detect ? `pose ${detect.pose_index} · ${detect.marker_hits} markers · 置信度 ${detect.mean_confidence}` : "—"}</span>
            <span>会话：{running ? "运行中" : session.state.exit ? `已退出（code ${session.state.exit.exit_code ?? "?"}）` : "未启动"}</span>
          </div>
          {session.state.exit?.fatal ? (
            <div style={{ color: "#f66", marginTop: 6 }}>异常退出，stderr 尾部：<pre style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>{session.state.exit.stderr_tail}</pre></div>
          ) : null}
          {result?.data ? (
            <div style={{ marginTop: 8, padding: 8, background: "#1d3323", borderRadius: 6, fontSize: 12 }}>
              ✓ 会话完成：{result.data.poses_captured} poses → {result.data.session_dir}
              {result.data.lens_ready ? "（可直接 quick run）" : "（缺 lens profile，补齐后再求解）"}
            </div>
          ) : null}
        </div>

        {/* ── coverage ── */}
        <div style={{ ...box, flex: "1 1 320px" }}>
          <div style={h2}>④ 覆盖度反馈</div>
          {coverage ? (
            <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
              <span>画面九宫格覆盖：{Math.round(coverage.sensor_coverage_pct * 100)}%
                {coverage.sensor_missing_regions.length ? `（缺：${coverage.sensor_missing_regions.join("、")}）` : ""}</span>
              <span>屏幕 marker：{coverage.screen_markers_seen}/{coverage.screen_markers_total}（{Math.round(coverage.screen_coverage_pct * 100)}%）</span>
              <span>pose 空间跨度：{coverage.pose_spatial_spread_mm} mm</span>
              {coverage.angular_spread_deg == null ? null : <span>角度跨度：{coverage.angular_spread_deg.toFixed(1)}°</span>}
              {coverage.edge_obs_fraction == null ? null : <span>边缘观测占比：{Math.round(coverage.edge_obs_fraction * 100)}%</span>}
              {coverage.gate_checklist?.map((gate) => (
                <span key={gate.key} style={{ color: gate.ok ? "#72c98b" : "#e8c268" }}>
                  {gate.ok ? "✓" : "○"} {gate.label}：{String(gate.value ?? "—")} / {String(gate.target ?? "—")}
                  {!gate.ok && gate.hint ? ` · ${gate.hint}` : ""}
                </span>
              ))}
              {coverage.suggestions.map((s, i) => (
                <span key={i} style={{ color: "#e8c268" }}>→ {s}</span>
              ))}
            </div>
          ) : <div style={{ opacity: 0.6 }}>暂无（每个 pose 采集后更新）</div>}
        </div>
      </div>

      {/* ── 事件日志 ── */}
      <div style={{ ...box }}>
        <div style={h2}>⑤ 事件流（NDJSON）</div>
        <pre style={{
          maxHeight: 240, overflow: "auto", margin: 0, fontSize: 11, lineHeight: 1.5,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        }}>
          {session.state.lines.slice(-200).map((l) => l.raw).join("\n") || "（尚无输出）"}
        </pre>
      </div>
    </div>
  );
}
