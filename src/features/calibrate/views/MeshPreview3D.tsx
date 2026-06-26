// Volo · Calibrate —— 网格 3D 预览（纯 SVG 手写投影：圆弧墙 + yaw/pitch 旋转 + 地面网格）。移植自 page_calibrate.jsx MeshPreview3D。
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { MESH_METRICS } from "../state/data";

export function MeshPreview3D() {
  const cols = MESH_METRICS.cols;
  const rows = MESH_METRICS.rows;
  const [rot, setRot] = useState({ yaw: -2.532, pitch: -0.276 });
  const [zoom, setZoom] = useState(1.36);
  const [pan, setPan] = useState({ x: -47, y: -75 });
  const rotRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const onDown = (e: ReactMouseEvent) => {
    if (e.button === 2) {
      e.preventDefault();
      panRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
      return;
    }
    if (e.button !== 0) return;
    rotRef.current = { x: e.clientX, y: e.clientY, yaw: rot.yaw, pitch: rot.pitch };
  };

  useEffect(() => {
    const svg = svgRef.current;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => Math.max(0.4, Math.min(4, +(z - Math.sign(e.deltaY) * 0.12).toFixed(2))));
    };
    if (svg) svg.addEventListener("wheel", onWheel, { passive: false });
    const mv = (e: MouseEvent) => {
      if (rotRef.current) {
        const d = rotRef.current;
        setRot({
          yaw: d.yaw + (e.clientX - d.x) * 0.006,
          pitch: Math.max(-0.5, Math.min(0.6, d.pitch + (e.clientY - d.y) * 0.004)),
        });
      } else if (panRef.current) {
        const p = panRef.current;
        const k = 900 / ((svg && svg.clientWidth) || 900);
        setPan({ x: p.px + (e.clientX - p.x) * k, y: p.py + (e.clientY - p.y) * k });
      }
    };
    const up = () => {
      rotRef.current = null;
      panRef.current = null;
    };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
    return () => {
      if (svg) svg.removeEventListener("wheel", onWheel);
      window.removeEventListener("mousemove", mv);
      window.removeEventListener("mouseup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 几何只依赖旋转（rot）；pan/zoom 仅作用于外层 <g> transform，因此几何按 [rot.yaw, rot.pitch] 记忆，
  // 避免 pan/zoom 帧重算约 2400 次三角投影。cols/rows 来自模块级常量 MESH_METRICS，恒定。
  const { lines, hatch, dots, ground } = useMemo(() => {
    const R = 540;
    const z0 = 230;
    const Hh = 300;
    const arc = (110 * Math.PI) / 180;
    const zc = z0 + 150;
    const cyaw = Math.cos(rot.yaw);
    const syaw = Math.sin(rot.yaw);
    const cpit = Math.cos(rot.pitch);
    const spit = Math.sin(rot.pitch);

    const pt = (i: number, j: number): [number, number, number] => {
      const a = -arc / 2 + (arc * i) / cols;
      const x = R * Math.sin(a);
      const y = -Hh / 2 + (Hh * j) / rows;
      const z = z0 + R * (1 - Math.cos(a));
      const dx = x;
      const dz = z - zc;
      const x2 = dx * cyaw - dz * syaw;
      const z2 = dx * syaw + dz * cyaw + zc;
      const dy = y;
      const dz2 = z2 - zc;
      const y2 = dy * cpit - dz2 * spit;
      const z3 = dy * spit + dz2 * cpit + zc;
      const f = 780;
      const sc = f / (f + z3);
      return [450 + x2 * sc, 300 - y2 * sc, sc];
    };
    const low = (i: number, j: number) => i >= cols - 8 && j <= 3;

    const lines: ReactNode[] = [];
    for (let i = 0; i <= cols; i++) {
      let d = "";
      for (let j = 0; j <= rows; j++) {
        const [px, py] = pt(i, j);
        d += (j ? "L" : "M") + px.toFixed(1) + " " + py.toFixed(1) + " ";
      }
      lines.push(<path key={"c" + i} d={d} stroke="rgba(120,180,255,.30)" strokeWidth={i % 4 === 0 ? 1.2 : 0.6} fill="none" />);
    }
    for (let j = 0; j <= rows; j++) {
      let d = "";
      for (let i = 0; i <= cols; i++) {
        const [px, py] = pt(i, j);
        d += (i ? "L" : "M") + px.toFixed(1) + " " + py.toFixed(1) + " ";
      }
      lines.push(<path key={"r" + j} d={d} stroke="rgba(120,180,255,.30)" strokeWidth={j % 4 === 0 ? 1.2 : 0.6} fill="none" />);
    }

    const hatch: ReactNode[] = [];
    for (let i = cols - 8; i < cols; i += 1)
      for (let j = 0; j < 3; j += 1) {
        const a = pt(i, j);
        const b = pt(i + 1, j);
        const cc = pt(i + 1, j + 1);
        const dd = pt(i, j + 1);
        hatch.push(
          <polygon
            key={"h" + i + "_" + j}
            points={`${a[0]},${a[1]} ${b[0]},${b[1]} ${cc[0]},${cc[1]} ${dd[0]},${dd[1]}`}
            fill="url(#lowhatch)"
            stroke="none"
          />,
        );
      }

    const dots: ReactNode[] = [];
    for (let i = 0; i <= cols; i += 4)
      for (let j = 0; j <= rows; j += 2) {
        const [px, py] = pt(i, j);
        dots.push(<circle key={"d" + i + "_" + j} cx={px} cy={py} r={1.7} fill={low(i, j) ? "rgba(255,150,40,.7)" : "var(--volo-600)"} />);
      }

    const F = 780;
    const project = (x: number, y: number, z: number): [number, number] => {
      const dx = x;
      const dz = z - zc;
      const x2 = dx * cyaw - dz * syaw;
      const z2 = dx * syaw + dz * cyaw + zc;
      const dy = y;
      const dz2 = z2 - zc;
      const y2 = dy * cpit - dz2 * spit;
      const z3 = dy * spit + dz2 * cpit + zc;
      const sc = F / (F + z3);
      return [450 + x2 * sc, 300 - y2 * sc];
    };
    const gY = -Hh / 2;
    const gx0 = -800;
    const gx1 = 800;
    const gz0 = -160;
    const gz1 = 1120;
    const S = 80;
    const ground: ReactNode[] = [];
    const q00 = project(gx0, gY, gz0);
    const q10 = project(gx1, gY, gz0);
    const q11 = project(gx1, gY, gz1);
    const q01 = project(gx0, gY, gz1);
    ground.push(
      <polygon
        key="gfill"
        points={`${q00[0]},${q00[1]} ${q10[0]},${q10[1]} ${q11[0]},${q11[1]} ${q01[0]},${q01[1]}`}
        fill="rgba(120,140,170,.045)"
        stroke="none"
      />,
    );
    for (let x = gx0; x <= gx1 + 0.5; x += S) {
      const a = project(x, gY, gz0);
      const b = project(x, gY, gz1);
      ground.push(<line key={"gx" + x} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="rgba(135,155,185,.17)" strokeWidth={Math.round(x) % 400 === 0 ? 1 : 0.5} />);
    }
    for (let z = gz0; z <= gz1 + 0.5; z += S) {
      const a = project(gx0, gY, z);
      const b = project(gx1, gY, z);
      ground.push(<line key={"gz" + z} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="rgba(135,155,185,.17)" strokeWidth={Math.round(z) % 400 === 0 ? 1 : 0.5} />);
    }
    return { lines, hatch, dots, ground };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rot.yaw, rot.pitch]);

  const tf = `translate(${450 + pan.x} ${300 + pan.y}) scale(${zoom}) translate(-450 -300)`;
  return (
    <svg
      viewBox="0 0 900 600"
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      ref={svgRef}
      style={{ display: "block", cursor: "grab" }}
      onMouseDown={onDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <defs>
        <pattern id="lowhatch" width={7} height={7} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={7} height={7} fill="rgba(255,150,40,.05)" />
          <line x1={0} y1={0} x2={0} y2={7} stroke="rgba(255,150,40,.4)" strokeWidth={1} />
        </pattern>
      </defs>
      <g transform={tf}>
        <g>{ground}</g>
        <g>{hatch}</g>
        <g>{lines}</g>
        <g>{dots}</g>
      </g>
    </svg>
  );
}
