// @ts-nocheck
/* Volo — 校正 · 网格校正 · 重建与预览（满铺 3D 网格面预览）
   1:1 port of the Claude Design handoff `src/cal2_preview.jsx`，网格几何改回旧
   pages/calibrate.tsx 的 MeshPreview3D 真实实现：按 surface.vertices 的真实位置
   （米）做包围盒适配窗口缩放，喂给与坐标无关的旋转 + 透视投影；hatch 低置信区
   由 vertex_provenance==='extrapolated' 驱动，provenance 为空数组（旧 surface，
   语义未知）时不画 hatch，不假设"全部已测量"。

   质量指标卡字段对齐真实 QualityMetrics（crates/mesh-core/src/surface.rs）：
   method / middle_max_dev_mm / middle_mean_dev_mm / measured_count / expected_count /
   estimated_rms_mm / estimated_p95_mm / extrapolated_count / warnings —— 没有
   "interpolated_count" 这个独立字段，measured/expected 比例直接用 measured_count/
   expected_count，不拆三段拼凑。 */
import * as React from "react";

(function () {
  const { Button, Badge } = window.Spectrum2DesignSystem_b6d1b3;
  const { useState, useEffect, useRef } = React;
  const h = React.createElement;
  const CX = window.VOLO_CAL2;

  const PROV4 = Object.assign({}, PROVENANCE, { unknown: { label: 'unknown 来源未知', tone: 'neutral', dot: 'rgba(150,155,165,.7)' } });

  /* ---- rotatable 3D LED-wall mesh（真实顶点，非程序化弧面）---- */
  function Mesh3D({ surface }) {
    const cols = surface.topology.cols, rows = surface.topology.rows;
    const vertices = surface.vertices;
    const provenance = surface.vertex_provenance || [];
    const vidx = (c, r) => r * (cols + 1) + c; /* 必须与 crates/mesh-core/src/surface.rs GridTopology::vertex_index 一致 */
    const isExtrap = (c, r) => provenance.length ? provenance[vidx(c, r)] === 'extrapolated' : false;
    const [rot, setRot] = useState({ yaw: -2.532, pitch: -0.276 });
    const [zoom, setZoom] = useState(1.36);
    const [pan, setPan] = useState({ x: -47, y: -75 });
    const rotRef = useRef(null); const panRef = useRef(null); const svgRef = useRef(null);
    const onDown = (e) => {
      if (e.button === 2) { e.preventDefault(); panRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; return; }
      if (e.button !== 0) return; rotRef.current = { x: e.clientX, y: e.clientY, ...rot };
    };
    useEffect(() => {
      const svg = svgRef.current;
      const onWheel = (e) => { e.preventDefault(); setZoom((z) => Math.max(0.4, Math.min(4, +(z - Math.sign(e.deltaY) * 0.12).toFixed(2)))); };
      if (svg) svg.addEventListener('wheel', onWheel, { passive: false });
      const mv = (e) => {
        if (rotRef.current) { const d = rotRef.current; setRot({ yaw: d.yaw + (e.clientX - d.x) * 0.006, pitch: Math.max(-0.5, Math.min(0.6, d.pitch + (e.clientY - d.y) * 0.004)) }); }
        else if (panRef.current) { const p = panRef.current; const k = 900 / ((svg && svg.clientWidth) || 900); setPan({ x: p.px + (e.clientX - p.x) * k, y: p.py + (e.clientY - p.y) * k }); }
      };
      const up = () => { rotRef.current = null; panRef.current = null; };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
      return () => { if (svg) svg.removeEventListener('wheel', onWheel); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    }, []);

    const z0 = 230, Hh = 300, zc = z0 + 150;
    const cyaw = Math.cos(rot.yaw), syaw = Math.sin(rot.yaw), cpit = Math.cos(rot.pitch), spit = Math.sin(rot.pitch);
    const F = 780;
    const project = (x, y, z) => {
      let dx = x, dz = z - zc; let x2 = dx * cyaw - dz * syaw, z2 = dx * syaw + dz * cyaw + zc;
      let dy = y, dz2 = z2 - zc; let y2 = dy * cpit - dz2 * spit, z3 = dy * spit + dz2 * cpit + zc;
      const sc = F / (F + z3);
      return [450 + x2 * sc, 300 - y2 * sc, sc];
    };
    const xs = vertices.map((v) => v[0]), ys = vertices.map((v) => v[1]), zs = vertices.map((v) => v[2]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys), minZ = Math.min(...zs);
    const spanX = Math.max(maxX - minX, 0.05), spanY = Math.max(maxY - minY, 0.05);
    const FIT = 620 / Math.max(spanX, spanY);
    const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
    const pt = (c, r) => { const v = vertices[vidx(c, r)]; return project((v[0] - midX) * FIT, (v[1] - midY) * FIT, z0 + (v[2] - minZ) * FIT); };
    const lines = [];
    for (let i = 0; i <= cols; i++) { let d = ''; for (let j = 0; j <= rows; j++) { const [px, py] = pt(i, j); d += (j ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1) + ' '; }
      lines.push(h('path', { key: 'c' + i, d, stroke: 'rgba(120,180,255,.30)', strokeWidth: i % 4 === 0 ? 1.2 : .6, fill: 'none' })); }
    for (let j = 0; j <= rows; j++) { let d = ''; for (let i = 0; i <= cols; i++) { const [px, py] = pt(i, j); d += (i ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1) + ' '; }
      lines.push(h('path', { key: 'r' + j, d, stroke: 'rgba(120,180,255,.30)', strokeWidth: j % 4 === 0 ? 1.2 : .6, fill: 'none' })); }
    const hatch = [];
    for (let i = 0; i < cols; i += 1) for (let j = 0; j < rows; j += 1) {
      if (!(isExtrap(i, j) || isExtrap(i + 1, j) || isExtrap(i, j + 1) || isExtrap(i + 1, j + 1))) continue;
      const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), dd = pt(i, j + 1);
      hatch.push(h('polygon', { key: 'h' + i + j, points: a[0] + ',' + a[1] + ' ' + b[0] + ',' + b[1] + ' ' + c[0] + ',' + c[1] + ' ' + dd[0] + ',' + dd[1], fill: 'url(#lowhatch2)', stroke: 'none' }));
    }
    const stepI = Math.max(1, Math.round(cols / 16)), stepJ = Math.max(1, Math.round(rows / 8));
    const dots = [];
    for (let i = 0; i <= cols; i += stepI) for (let j = 0; j <= rows; j += stepJ) { const [px, py] = pt(i, j);
      dots.push(h('circle', { key: 'd' + i + '_' + j, cx: px, cy: py, r: 1.9, fill: isExtrap(i, j) ? (PROV4.extrapolated.dot) : (PROV4.measured.dot) })); }

    const gY = -Hh / 2, gx0 = -800, gx1 = 800, gz0 = -160, gz1 = 1120, S = 80; const ground = [];
    const q00 = project(gx0, gY, gz0), q10 = project(gx1, gY, gz0), q11 = project(gx1, gY, gz1), q01 = project(gx0, gY, gz1);
    ground.push(h('polygon', { key: 'gfill', points: q00[0] + ',' + q00[1] + ' ' + q10[0] + ',' + q10[1] + ' ' + q11[0] + ',' + q11[1] + ' ' + q01[0] + ',' + q01[1], fill: 'rgba(120,140,170,.045)', stroke: 'none' }));
    for (let x = gx0; x <= gx1 + 0.5; x += S) { const a = project(x, gY, gz0), b = project(x, gY, gz1); ground.push(h('line', { key: 'gx' + x, x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: 'rgba(135,155,185,.17)', strokeWidth: Math.round(x) % 400 === 0 ? 1 : .5 })); }
    for (let z = gz0; z <= gz1 + 0.5; z += S) { const a = project(gx0, gY, z), b = project(gx1, gY, z); ground.push(h('line', { key: 'gz' + z, x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: 'rgba(135,155,185,.17)', strokeWidth: Math.round(z) % 400 === 0 ? 1 : .5 })); }

    const tf = 'translate(' + (450 + pan.x) + ' ' + (300 + pan.y) + ') scale(' + zoom + ') translate(-450 -300)';
    return h('svg', { viewBox: '0 0 900 600', width: '100%', height: '100%', preserveAspectRatio: 'xMidYMid meet', ref: svgRef, style: { display: 'block', cursor: 'grab' }, onMouseDown: onDown, onContextMenu: (e) => e.preventDefault() },
      h('defs', null, h('pattern', { id: 'lowhatch2', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
        h('rect', { width: 7, height: 7, fill: 'rgba(255,150,40,.05)' }), h('line', { x1: 0, y1: 0, x2: 0, y2: 7, stroke: 'rgba(255,150,40,.4)', strokeWidth: 1 }))),
      h('g', { transform: tf }, h('g', null, ground), h('g', null, hatch), h('g', null, lines), h('g', null, dots)));
  }

  function MetricCard({ qm, surveyReport }) {
    const Q = (k, v, u, vis) => h('div', { className: 'cal2-q' }, h('div', { className: 'cal2-q-k' }, k), h('div', { className: 'cal2-q-v s-' + (vis || '') }, v, u ? h('span', { className: 'cal2-q-u' }, u) : null));
    const Qn = (k, val, u) => h('div', { className: 'cal2-q' }, h('div', { className: 'cal2-q-k' }, k),
      val == null ? h('div', { className: 'cal2-q-v', style: { fontSize: 13 } }, h(Badge, { variant: 'neutral', size: 'S' }, '无 holdout 残差'))
        : h('div', { className: 'cal2-q-v s-' + (val < 3 ? 'positive' : val < 8 ? 'notice' : 'negative') }, val.toFixed(2), h('span', { className: 'cal2-q-u' }, u)));
    const [foldOpen, setFold] = useState(false);
    return h('div', { className: 'cal2-metriccard' },
      h('div', { className: 'cal2-mc-h' }, h(Icon, { name: 'pulse', size: 14 }), '质量指标', CX.rmsBadge(qm.estimated_rms_mm)),
      h('div', { className: 'cal2-mc-grid' },
        Q('middle_max_dev_mm', qm.middle_max_dev_mm.toFixed(2), 'mm', 'notice'),
        Q('middle_mean_dev_mm', qm.middle_mean_dev_mm.toFixed(2), 'mm', 'positive'),
        Q('measured/expected', qm.measured_count.toLocaleString() + '/' + qm.expected_count.toLocaleString(), '', ''),
        Qn('estimated_rms_mm', qm.estimated_rms_mm, 'mm'),
        Qn('estimated_p95_mm', qm.estimated_p95_mm, 'mm'),
        Q('extrapolated_count', qm.extrapolated_count, '', qm.extrapolated_count > 0 ? 'notice' : 'positive')),
      (qm.missing.length || qm.outliers.length) ? h('button', { className: 'cal2-mc-fold', onClick: () => setFold((v) => !v) },
        h(Icon, { name: 'chevr', size: 12, style: { transform: foldOpen ? 'rotate(90deg)' : 'none' } }),
        'missing ' + qm.missing.length + ' · outliers ' + qm.outliers.length) : null,
      foldOpen ? h('div', { className: 'cal2-mc-fold-b' },
        h('div', { className: 'cal2-ff' }, h('span', { className: 'k' }, 'missing'), h('span', { className: 'v mono s-notice' }, qm.missing.length)),
        h('div', { className: 'cal2-ff' }, h('span', { className: 'k' }, 'outliers'), h('span', { className: 'v mono s-negative' }, qm.outliers.length))) : null,
      qm.warnings.map((w, i) => h('div', { key: i, className: 'cal2-mc-warn' }, h(Icon, { name: 'alert', size: 13 }), w)));
  }

  function Preview({ s }) {
    const proj = CX.useProj();
    const rec = proj.reconstruction;
    const built = !!rec;
    const hasSurvey = !!proj.measurementsAbsPath;
    const rebuild = () => CX.rebuildMesh(s, proj);

    if (!built) {
      return h('div', { className: 'cal2-canvas-wrap' },
        h('div', { className: 'cal2-stage cal2-stage--empty' },
          h('div', { className: 'cal2-preview-empty' },
            h('div', { className: 'ce-ico' }, h(Icon, { name: 'cube3', size: 34, stroke: 1.3 })),
            h('div', { className: 'ce-t', style: { fontSize: 17 } }, '还没有重建网格'),
            h('div', { className: 'ce-d' }, hasSurvey ? '测量数据已就绪，点「重建」生成 LED 网格面并评估质量偏差。' : '需先导入测量数据，才能重建网格。'),
            h('div', { className: 'ce-acts' },
              hasSurvey
                ? h(Button, { variant: 'accent', size: 'L', icon: h(Icon, { name: 'sync', size: 16 }), isDisabled: proj.rebuilding, onPress: rebuild }, proj.rebuilding ? '重建中…' : '重建')
                : h(Button, { variant: 'accent', size: 'L', icon: h(Icon, { name: 'arrowr', size: 16 }), onPress: () => s.setCalNav('survey') }, '前往测量导入')))));
    }

    const surface = rec.surface;
    const qm = surface.quality_metrics;
    return h('div', { className: 'cal2-canvas-wrap' },
      h('div', { className: 'cal2-stage cal2-stage--mesh' },
        h('div', { className: 'cal2-float cal2-float--tl' },
          h('span', { className: 'cal2-axis-chip' }, 'PERSP · world · ' + surface.topology.cols + '×' + surface.topology.rows),
          h('button', {
            className: 'cal2-savebtn dirty', disabled: !hasSurvey || proj.rebuilding, style: (hasSurvey && !proj.rebuilding) ? null : { opacity: .5, cursor: 'not-allowed' },
            onClick: () => hasSurvey && !proj.rebuilding && rebuild(), title: hasSurvey ? '重新重建' : '需先导入测量数据 → 前往测量导入' },
            h(Icon, { name: 'sync', size: 14 }), proj.rebuilding ? '重建中…' : '重建'),
          !hasSurvey ? h('span', { className: 'cal2-reason' }, h(Icon, { name: 'alert', size: 12 }), '需先导入测量数据 → 前往测量导入') : null),
        h('div', { className: 'cal2-float cal2-float--tr' }, h(MetricCard, { qm, surveyReport: proj.surveyReport })),
        h(Mesh3D, { surface }),
        h('div', { className: 'cal2-float cal2-float--bl cal2-leg cal2-leg--prov' },
          (surface.vertex_provenance && surface.vertex_provenance.length ? ['measured', 'interpolated', 'extrapolated'] : ['unknown']).map((k) => h('span', { key: k, className: 'leg-i' }, h('span', { className: 'leg-sw', style: { background: PROV4[k].dot, borderRadius: '50%' } }), PROV4[k].label))),
        h('div', { className: 'cal2-float cal2-float--br cal2-rothint' }, h(Icon, { name: 'rotate', size: 13 }), '左键旋转 · 右键平移 · 滚轮缩放')));
  }

  window.VOLO_CAL2 = Object.assign(window.VOLO_CAL2 || {}, { Preview });
})();
