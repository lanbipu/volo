// Volo · Calibrate —— Cabinet 网格编辑器 + 其 Inspector。移植自 page_calibrate.jsx CabinetEditor / seedCells / inspector(cabinet,cabinetMulti)。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { Icon } from "../../cache/ui/Icon";
import { useCalibrate } from "../state/store";
import { CAL_SCREENS, ROLE, CAB_STATE } from "../state/data";
import type { CalScreen, CalRole, CabState, CalSelection } from "../state/types";
import { KV } from "../ui/KV";

type Cell = { state: CabState; role?: CalRole };
type Cells = Record<string, Cell>;
type Mode = "select" | "mask" | "refs" | "baseline";
type CabSel = Extract<CalSelection, { type: "cabinet" } | { type: "cabinetMulti" }>;

function seedCells(screen: CalScreen): Cells {
  const { cols, rows } = screen;
  const m: Cells = {};
  const set = (c: number, r: number, v: Cell) => {
    if (c >= 0 && c < cols && r >= 0 && r < rows) m[c + "," + r] = v;
  };
  set(0, 0, { state: "masked" });
  set(1, 0, { state: "masked" });
  set(0, 1, { state: "masked" });
  set(cols - 1, rows - 1, { state: "masked" });
  set(cols - 2, rows - 1, { state: "masked" });
  set(3, rows - 2, { state: "below" });
  set(4, rows - 2, { state: "below" });
  set(2, rows - 1, { state: "below" });
  set(2, rows - 2, { state: "ref", role: "origin" });
  set(cols - 3, rows - 2, { state: "ref", role: "x_axis" });
  set(cols - 3, 1, { state: "ref", role: "xy_plane" });
  return m;
}

export function CabinetEditor() {
  const { calScreen, calSel, setCalSel } = useCalibrate();
  const screen = CAL_SCREENS.find((x) => x.id === calScreen) ?? CAL_SCREENS[0];
  const { cols, rows } = screen;
  const [cells, setCells] = useState<Cells>(() => seedCells(screen));
  const [mode, setMode] = useState<Mode>("select");
  const [role, setRole] = useState<CalRole>("origin");
  const [undoStack, setUndo] = useState<Cells[]>([]);
  const [redoStack, setRedo] = useState<Cells[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fitW, setFitW] = useState(0);
  const [selKeys, setSelKeys] = useState<Set<string>>(() => new Set());
  const marqueeRef = useRef<{ x: number; y: number; moved: boolean; onCell: boolean } | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const selKeysRef = useRef(selKeys);
  selKeysRef.current = selKeys;
  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  const setSel = (nextSet: Set<string>) => {
    selKeysRef.current = nextSet;
    setSelKeys(nextSet);
  };
  const setMultiSel = (arr: string[]) => {
    if (!arr.length) {
      setCalSel(null);
      return;
    }
    if (arr.length === 1) {
      const [c, r] = arr[0].split(",").map(Number);
      const cell = cellsRef.current[arr[0]] || { state: "normal" as CabState };
      setCalSel({ type: "cabinet", col: c, row: r, state: cell.state || "normal", role: cell.role || null });
      return;
    }
    const bd: Record<CabState, number> = { normal: 0, masked: 0, below: 0, ref: 0 };
    arr.forEach((k) => {
      const st = (cellsRef.current[k] && cellsRef.current[k].state) || "normal";
      bd[st] = (bd[st] || 0) + 1;
    });
    setCalSel({ type: "cabinetMulti", count: arr.length, bd });
  };

  // 滚轮缩放 + 右键拖动平移
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => Math.max(0.4, Math.min(4, +(z - Math.sign(e.deltaY) * 0.12).toFixed(2))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    const move = (e: MouseEvent) => {
      if (!panRef.current) return;
      setPan({
        x: panRef.current.px + (e.clientX - panRef.current.x),
        y: panRef.current.py + (e.clientY - panRef.current.y),
      });
    };
    const up = () => {
      if (panRef.current) {
        el.classList.remove("panning");
        panRef.current = null;
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    // handlers 只用 panRef / setZoom / setPan，不读 pan state —— 无需每帧重订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onStageDown = (e: ReactMouseEvent) => {
    if (e.button === 2) {
      e.preventDefault();
      panRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
      stageRef.current?.classList.add("panning");
      return;
    }
    if (e.button !== 0 || mode !== "select") return;
    if (e.metaKey || e.altKey) return;
    e.preventDefault();
    const target = e.target as HTMLElement;
    marqueeRef.current = { x: e.clientX, y: e.clientY, moved: false, onCell: !!target.closest(".cab") };
  };
  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // 左键拖动 marquee 框选
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const m = marqueeRef.current;
      if (!m) return;
      if (Math.abs(e.clientX - m.x) + Math.abs(e.clientY - m.y) > 4) m.moved = true;
      const el = stageRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setMarquee({ x0: m.x - rect.left, y0: m.y - rect.top, x1: e.clientX - rect.left, y1: e.clientY - rect.top });
      const minX = Math.min(m.x, e.clientX);
      const maxX = Math.max(m.x, e.clientX);
      const minY = Math.min(m.y, e.clientY);
      const maxY = Math.max(m.y, e.clientY);
      const set = new Set<string>();
      el.querySelectorAll(".cab").forEach((cab) => {
        const cr = (cab as HTMLElement).dataset.cr;
        const rr = cab.getBoundingClientRect();
        if (cr && rr.left < maxX && rr.right > minX && rr.top < maxY && rr.bottom > minY) set.add(cr);
      });
      setSel(set);
    };
    const up = () => {
      const m = marqueeRef.current;
      if (!m) return;
      marqueeRef.current = null;
      setMarquee(null);
      if (m.moved) setMultiSel([...selKeysRef.current]);
      else if (!m.onCell) {
        setSel(new Set());
        setCalSel(null);
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 适应窗口：网格在 stage 内按宽高约束
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const PAD = 44;
    const calc = () => {
      const w = el.clientWidth - PAD;
      const hh = el.clientHeight - PAD;
      if (w <= 0 || hh <= 0) return;
      setFitW(Math.max(160, Math.min(w, hh * (cols / rows))));
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cols, rows]);

  // 换屏幕：重置
  useEffect(() => {
    setCells(seedCells(screen));
    setUndo([]);
    setRedo([]);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setSel(new Set());
    setCalSel(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calScreen]);

  const selCab = (c: number, r: number, cell?: Cell) =>
    setCalSel({ type: "cabinet", col: c, row: r, state: (cell && cell.state) || "normal", role: (cell && cell.role) || null });
  // undo/redo 改变了 cells，但 calSel 是点击时的快照 —— 按回滚后的 cells 刷新当前选中 cabinet 的状态
  const refreshCalSel = (next: Cells) => {
    if (calSel?.type === "cabinet") {
      selCab(calSel.col, calSel.row, next[calSel.col + "," + calSel.row]);
    }
  };
  const commit = (next: Cells) => {
    setUndo((u) => [...u, cells]);
    setRedo([]);
    setCells(next);
  };
  const doUndo = () => {
    if (!undoStack.length) return;
    const prev = undoStack[undoStack.length - 1];
    setRedo((r) => [...r, cells]);
    setCells(prev);
    setUndo((u) => u.slice(0, -1));
    refreshCalSel(prev);
  };
  const doRedo = () => {
    if (!redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    setUndo((u) => [...u, cells]);
    setCells(next);
    setRedo((r) => r.slice(0, -1));
    refreshCalSel(next);
  };

  // 初始选 origin
  useEffect(() => {
    const ent = Object.entries(cells).find(([, v]) => v.role === "origin");
    if (ent && (!calSel || calSel.type !== "cabinet")) {
      const [c, r] = ent[0].split(",").map(Number);
      selCab(c, r, ent[1]);
      setSel(new Set([ent[0]]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 键盘快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && /^(INPUT|TEXTAREA)$/.test(tgt.tagName)) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "z") {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "y") {
        e.preventDefault();
        doRedo();
        return;
      }
      if (k === "m") setMode((m) => (m === "mask" ? "select" : "mask"));
      else if (k === "r") setMode((m) => (m === "refs" ? "select" : "refs"));
      else if (k === "b") setMode((m) => (m === "baseline" ? "select" : "baseline"));
      else if (k === "escape") setMode("select");
      else if (k === "1") setRole("origin");
      else if (k === "2") setRole("x_axis");
      else if (k === "3") setRole("xy_plane");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cells, undoStack, redoStack]);

  const onCell = (c: number, r: number, e: ReactMouseEvent) => {
    const key = c + "," + r;
    const cur = cells[key] || { state: "normal" as CabState };
    if (mode === "select") {
      if (e && (e.metaKey || e.altKey)) {
        const n = new Set(selKeysRef.current);
        if (n.has(key)) n.delete(key);
        else n.add(key);
        setSel(n);
        setMultiSel([...n]);
        return;
      }
      setSel(new Set([key]));
      selCab(c, r, cur);
      return;
    }
    const next: Cells = { ...cells };
    if (mode === "mask") next[key] = cur.state === "masked" ? { state: "normal" } : { state: "masked" };
    else if (mode === "baseline") next[key] = cur.state === "below" ? { state: "normal" } : { state: "below" };
    else if (mode === "refs") next[key] = { state: "ref", role };
    commit(next);
    setSel(new Set([key]));
    selCab(c, r, next[key]);
  };

  const grid: ReactNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[c + "," + r] || { state: "normal" as CabState };
      const isSel = selKeys.has(c + "," + r);
      let cls = "cab";
      if (cell.state === "masked") cls += " masked";
      else if (cell.state === "below") cls += " below";
      else if (cell.state === "ref") cls += " ref-" + cell.role;
      if (isSel) cls += " sel";
      grid.push(
        <div
          key={c + "," + r}
          className={cls}
          data-cr={c + "," + r}
          onClick={(e) => onCell(c, r, e)}
          title={`col ${c}, row ${r}`}
        >
          {cell.state === "ref" && cell.role ? <span className="rl">{ROLE[cell.role].short}</span> : null}
        </div>,
      );
    }
  }

  const ModeBtn = (id: Mode, label: string, key: string, icon: string) => (
    <div className={"mbtn" + (mode === id ? " on" : "")} onClick={() => setMode((m) => (m === id ? "select" : id))}>
      <Icon name={icon} size={14} />
      {label}
      <kbd>{key}</kbd>
    </div>
  );

  return (
    <div className="cabwrap">
      <div className="canvas-head">
        <span className="t">{screen.name + " — Cabinet 网格"}</span>
        <span className="toolchip">
          <Icon name="grid" size={14} />
          {`${cols} × ${rows} cabinet`}
        </span>
        <span className="toolchip">
          {mode === "select" ? "选择模式" : mode === "mask" ? "遮罩模式" : mode === "refs" ? "参考点模式" : "基线模式"}
        </span>
        <div className="right">
          <div className="zoombar">
            <button className="zb-btn" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} title="缩小">
              −
            </button>
            <button className="zb-lbl" onClick={resetView} title="适应窗口">
              {Math.round(zoom * 100) + "%"}
            </button>
            <button className="zb-btn" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} title="放大">
              +
            </button>
          </div>
          <button
            className="iconbtn"
            disabled={!undoStack.length}
            style={{ opacity: undoStack.length ? 1 : 0.4 }}
            onClick={doUndo}
            title="撤销"
          >
            <Icon name="undo" size={16} />
          </button>
          <button
            className="iconbtn"
            disabled={!redoStack.length}
            style={{ opacity: redoStack.length ? 1 : 0.4 }}
            onClick={doRedo}
            title="重做"
          >
            <Icon name="redo" size={16} />
          </button>
        </div>
      </div>
      <div
        className={"cabstage" + (marquee ? " marquee" : "")}
        ref={stageRef}
        onMouseDown={onStageDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          className="cabgrid"
          style={{
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            width: fitW ? fitW + "px" : undefined,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          {grid}
        </div>
        {marquee ? (
          <div
            className="marquee-box"
            style={{
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
            }}
          />
        ) : null}
      </div>
      <div className="modebar">
        {ModeBtn("mask", "遮罩", "M", "panel")}
        {ModeBtn("refs", "参考点", "R", "pin")}
        {ModeBtn("baseline", "基线", "B", "ruler")}
        {mode === "refs" ? (
          <div className="role-seg">
            {(["origin", "x_axis", "xy_plane"] as CalRole[]).map((rk, i) => (
              <button key={rk} className={role === rk ? "on r-" + rk : ""} onClick={() => setRole(rk)}>
                <span className="sdot" style={{ background: ROLE[rk].color }} />
                {ROLE[rk].label}
                <kbd style={{ marginLeft: 2 }}>{i + 1}</kbd>
              </button>
            ))}
          </div>
        ) : null}
        <span className="sp" />
      </div>
      <div className="leg">
        <span className="leg-i">
          <span className="leg-sw" style={{ background: "#3a4654" }} />
          正常
        </span>
        <span className="leg-i">
          <span className="leg-sw" style={{ background: "repeating-linear-gradient(45deg,#26262b 0 3px,#1b1b1f 3px 6px)" }} />
          遮罩
        </span>
        <span className="leg-i">
          <span className="leg-sw" style={{ background: "#243a52" }} />
          基线以下
        </span>
        <span className="leg-i">
          <span className="leg-sw" style={{ background: ROLE.origin.color }} />
          origin
        </span>
        <span className="leg-i">
          <span className="leg-sw" style={{ background: ROLE.x_axis.color }} />
          x_axis
        </span>
        <span className="leg-i">
          <span className="leg-sw" style={{ background: ROLE.xy_plane.color }} />
          xy_plane
        </span>
      </div>
    </div>
  );
}

export function CabinetInspector({ sel }: { sel: CabSel }) {
  const { calScreen } = useCalibrate();
  const cols = (CAL_SCREENS.find((x) => x.id === calScreen) ?? CAL_SCREENS[0]).cols;
  if (sel.type === "cabinetMulti") {
    const bd = sel.bd;
    const order = ([
      ["normal", "informative"],
      ["masked", "neutral"],
      ["below", "notice"],
      ["ref", "positive"],
    ] as [CabState, string][]).filter(([k]) => bd[k]);
    return (
      <>
        <div className="insp-head">
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
            <span className="step-ico">
              <Icon name="grid" size={16} />
            </span>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
              {"已选 " + sel.count + " 个 Cabinet"}
            </h2>
          </div>
          <span className="spill spill--informative">
            <Icon name="check" size={13} />
            多选
          </span>
        </div>
        <div className="insp-sect">
          <div className="lh">选区构成</div>
          {order.length ? (
            order.map(([k, v]) => (
              <div className="kv" key={k}>
                <span className="k">
                  <span className={"sdot bg-" + v} style={{ display: "inline-block", marginRight: 7 }} />
                  {CAB_STATE[k]}
                </span>
                <span className="v">{bd[k]}</span>
              </div>
            ))
          ) : (
            <div style={{ fontSize: 12, color: "var(--chrome-faint)" }}>—</div>
          )}
        </div>
        <div className="insp-sect">
          <div style={{ fontSize: 11.5, color: "var(--chrome-faint)", lineHeight: 1.55 }}>
            左键拖动可框选，按住 ⌘ / Alt 点击可加选或减选；切到遮罩 / 参考点 / 基线模式可对选区批量编辑。
          </div>
        </div>
      </>
    );
  }

  const st = sel.state || "normal";
  const stVis = st === "masked" ? "neutral" : st === "below" ? "notice" : st === "ref" ? "positive" : "informative";
  return (
    <>
      <div className="insp-head">
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
          <span className="step-ico">
            <Icon name="grid" size={16} />
          </span>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, fontFamily: "var(--font-code)" }}>
            {`Cabinet ${sel.col},${sel.row}`}
          </h2>
        </div>
        <span className={"spill spill--" + stVis}>
          <Icon name={st === "normal" ? "check" : "panel"} size={13} />
          {CAB_STATE[st]}
        </span>
      </div>
      <div className="insp-sect">
        <div className="lh">位置</div>
        <KV k="列 (col)" v={sel.col} mono />
        <KV k="行 (row)" v={sel.row} mono />
        <KV k="面板索引" v={`#${sel.row * cols + sel.col}`} mono />
      </div>
      <div className="insp-sect">
        <div className="lh">状态</div>
        <div className="kv">
          <span className="k">类型</span>
          <span className="v">{CAB_STATE[st]}</span>
        </div>
        <KV k="参与重建" v={st === "masked" ? "否（遮罩）" : "是"} />
        <KV k="ref 角色" v={sel.role ? ROLE[sel.role].label : "—"} mono={!!sel.role} />
      </div>
      {sel.role ? (
        <div className="insp-sect">
          <div className="lh">坐标系角色</div>
          <div style={{ fontSize: 12, color: "var(--chrome-dim)", lineHeight: 1.5 }}>
            {sel.role === "origin"
              ? "世界坐标原点 (0,0,0)，定义网格基准位置。"
              : sel.role === "x_axis"
                ? "定义 X 轴方向，与 origin 构成基准向量。"
                : "与 origin / x_axis 共同定义 XY 平面与法向。"}
          </div>
        </div>
      ) : null}
    </>
  );
}
