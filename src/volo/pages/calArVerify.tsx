// @ts-nocheck
/* Volo — 校正 · AR 工具页 ⑤–⑥
   验证叠加（满铺标注帧查看器 · 逐 marker 误差表）· 历史与导出（runs 表 · OpenTrackIO）。
   1:1 port of the Claude Design handoff `src/cal2_ar_verify.jsx`, wired to real vpcal
   （argv/结果字段核实自 sidecars/vpcal/src/vpcal/cli/{verify,export}.py 与
   docs/design/CALIBRATE-UX.md §4.7/§4.8）。

   标注帧真图（不是设计稿里的假 SVG）：verify overlay 的 data.annotated_images[] 是
   本地绝对 PNG 路径，用新增的 readImageAsDataUrl(path, baseDir) 命令（本会话补的
   唯一后端能力，见 vpcal_runs.rs）读成 data URL 再 <img> 展示。baseDir 传本次输出
   目录，后端会校验 path 确实落在其中，不是任意路径读取。 */
import * as React from "react";
import "../ds";
import { pickFile, pickDirectory, revealPath, listArRuns } from "../api/commands";
import { spawnSidecar } from "../api/sidecarStream";
import { readImageAsDataUrl } from "../api/lensCommands";

(function () {
  const { useState, useEffect } = React;
  const h = React.createElement;

  const overThresh = (m) => m.mean_px > 1.0;

  /* =================== ⑤ 验证叠加 =================== */
  function Verify({ s }) {
    const AR = window.VOLO_CAL_AR;
    const { Button } = window.Spectrum2DesignSystem_b6d1b3;
    const ws = AR.useArWorkspace();
    const vp = AR.useVpcalRun();
    const [resultPath, setResultPath] = useState(null);
    const [frame, setFrame] = useState(0);
    const [frameUrls, setFrameUrls] = useState([]);
    const [loadingImgs, setLoadingImgs] = useState(false);
    const V = ws.lastVerify;

    useEffect(() => {
      if (!vp.data) return;
      AR.arStore.setRunning('verify', false);
      AR.arStore.patch({ lastVerify: vp.data });
      s.pushLog({ lv: 'ok', cat: 'ar', msg: '生成验证叠加 · ' + vp.data.num_frames + ' 帧 · global_rms <b>' + vp.data.global_rms_px.toFixed(2) + ' px</b>（limit 8）' });
      const sorted = (vp.data.per_marker || []).slice().sort((a, b) => b.mean_px - a.mean_px);
      if (sorted[0]) s.setCalSel({ type: 'armarker', id: sorted[0].marker_id });
    }, [vp.data]);
    useEffect(() => {
      if (!vp.err) return;
      AR.arStore.setRunning('verify', false);
      s.pushLog({ lv: 'err', cat: 'ar', msg: '验证叠加失败 · ' + vp.err.msg });
    }, [vp.err]);
    /* 标注帧图片跟着 store 里的 ws.lastVerify 走，不是本次挂载期间的 vp.data ——
       否则切到别的 AR 工具页再切回来时（Verify 组件卸载重挂载，vp 是全新的
       useVpcalRun 实例，vp.data 回到 null），store 里明明还留着上次真实结果，
       画面区却会一直显示「无标注帧图片」（依赖数组用 annotated_images 拼接成的
       key，同一组路径不重复触发网络/IPC 读图）。 */
    const annotatedKey = V && V.annotated_images ? V.annotated_images.join('|') : '';
    useEffect(() => {
      const AR = window.VOLO_CAL_AR;
      const imgs = (V && V.annotated_images) || [];
      setFrame(0);
      if (!imgs.length) { setFrameUrls([]); return undefined; }
      /* verify overlay 把所有标注帧平铺写进同一个 --out 目录（verify.py 的
         overlay_session 不分子目录），第一张图的父目录即为该次输出目录——传给
         read_image_as_data_url 做「路径必须落在这个目录下」的服务端校验，不能让
         这条命令变成任意本地路径读取（code review 发现）。 */
      const baseDir = AR.dirName(imgs[0]);
      let cancelled = false;
      setLoadingImgs(true);
      Promise.all(imgs.map((p) => readImageAsDataUrl(p, baseDir).catch(() => null)))
        .then((urls) => { if (!cancelled) { setFrameUrls(urls); setLoadingImgs(false); } });
      return () => { cancelled = true; };
    }, [annotatedKey]);

    const generate = async () => {
      if (!ws.sessionPath) return;
      let rp = resultPath;
      if (!rp) { rp = await pickFile('quick run 输出 result.json', ['json']).catch(() => null); if (!rp) return; setResultPath(rp); }
      const outDir = await pickDirectory().catch(() => null); if (!outDir) return;
      AR.arStore.setRunning('verify', true);
      s.setLogOpen(true);
      s.pushLog({ lv: 'info', cat: 'ar', msg: '验证叠加 · <b>vpcal verify overlay</b>' });
      vp.run(['verify', 'overlay', '--config', ws.sessionPath, '--result', rp, '--out', outDir, '--limit', '8']);
    };

    if (!V) {
      const reqs = [
        { ok: !!ws.sessionPath, label: 'session', v: ws.sessionPath ? AR.baseName(ws.sessionPath) : '未设置' },
        { ok: !!resultPath, label: 'result.json', v: resultPath ? AR.baseName(resultPath) : '未选择' },
      ];
      return h('div', { className: 'cal2-page' },
        h('div', { className: 'canvas-head' }, h('span', { className: 't' }, '验证叠加'), h('span', { className: 'toolchip' }, h(Icon, { name: 'eye', size: 14 }), 'annotated overlay')),
        h('div', { className: 'dash', style: { paddingTop: 14 } },
          vp.err ? h('div', { className: 'ar-degen ar-degen--negative' }, h(Icon, { name: 'alert', size: 15 }),
            h('div', null, h('b', null, '生成失败'), h('div', { className: 'ar-degen-d' }, vp.err.msg))) : null,
          h('div', { className: 'cluster-empty' },
            h('div', { className: 'ce-ico' }, h(Icon, { name: 'eye', size: 34, stroke: 1.3 })),
            h('div', { className: 'ce-t' }, '尚未生成验证叠加'),
            h('div', { className: 'ce-d' }, '把标定外参投影回采集帧，叠加检测点与重投影点，直观复核精度与逐 marker 误差。'),
            h('div', { className: 'ar-reqcheck' }, reqs.map((r) => h('div', { key: r.label, className: 'ar-req' + (r.ok ? ' ok' : '') },
              h('span', { className: 'ar-req-ic' }, h(Icon, { name: r.ok ? 'check' : 'minus', size: 13 })),
              h('span', { className: 'ar-req-l' }, r.label), h('code', null, r.v)))),
            h('div', { className: 'ce-acts' },
              h(Button, { variant: 'accent', size: 'L', isDisabled: vp.running || !ws.sessionPath, icon: h(Icon, { name: 'eye', size: 16 }), onPress: generate }, vp.running ? '生成中…' : '生成验证叠加'),
              h('span', { className: 'ar-req-limit' }, 'limit 8')))));
    }

    const markers = (V.per_marker || []).slice().sort((a, b) => b.mean_px - a.mean_px);
    return h('div', { className: 'cal2-page' },
      h('div', { className: 'canvas-head' },
        h('span', { className: 't' }, '验证叠加'),
        h('span', { className: 'toolchip' }, h(Icon, { name: 'eye', size: 14 }), V.num_frames + ' 帧 · limit 8'),
        h('div', { className: 'right' }, h(Button, { variant: 'secondary', size: 'S', isDisabled: vp.running, icon: h(Icon, { name: 'sync', size: 14 }), onPress: generate }, '重新生成'))),
      h('div', { className: 'ar-verify' },
        h('div', { className: 'ar-verify-main' },
          h('div', { className: 'ar-frame-big' },
            frameUrls[frame]
              ? h('img', { src: frameUrls[frame], alt: '标注帧', style: { width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#0e0f13' } })
              : h('div', { style: { width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: 'var(--chrome-faint)', fontSize: 12, background: '#0e0f13' } },
                  loadingImgs ? '加载标注帧…' : '无标注帧图片'),
            h('div', { className: 'ar-vmetric' },
              h('div', { className: 'ar-vm-row' }, h('span', null, 'global_rms_px'), h('b', null, V.global_rms_px.toFixed(2))),
              h('div', { className: 'ar-vm-row' }, h('span', null, 'global_max_px'), h('b', null, V.global_max_px.toFixed(2))),
              h('div', { className: 'ar-vm-row' }, h('span', null, 'num_frames'), h('b', null, V.num_frames)),
              h('div', { className: 'ar-vm-row' }, h('span', null, 'num_observations'), h('b', null, V.num_observations.toLocaleString()))),
            h('div', { className: 'ar-legend' },
              h('span', null, h('i', { className: 'lg-cross' }, '+'), 'detected'),
              h('span', null, h('i', { className: 'lg-circle' }), 'reprojected'),
              h('span', null, h('i', { className: 'lg-line' }), 'error'))),
          frameUrls.length ? h('div', { className: 'ar-thumbs' }, frameUrls.map((url, i) => h('button', {
            key: i, className: 'ar-thumb' + (frame === i ? ' on' : ''), onClick: () => setFrame(i),
          },
            url ? h('img', { src: url, style: { width: '100%', display: 'block' } }) : h('div', { style: { width: '100%', aspectRatio: '16/9', background: '#1a1a1e' } }),
            h('span', null, 'f' + String(i).padStart(2, '0'))))) : null),
        h('div', { className: 'ar-verify-side' },
          h('div', { className: 'cal2-subh' }, '逐 marker 误差 · 按 mean_px 排序'),
          h('div', { className: 'ar-mtable' },
            h('div', { className: 'ar-mt-head' }, h('span', null, 'marker_id'), h('span', null, 'count'), h('span', null, 'mean_px'), h('span', null, 'max_px')),
            markers.map((m) => {
              const bad = overThresh(m);
              const on = s.calSel && s.calSel.type === 'armarker' && s.calSel.id === m.marker_id;
              return h('div', {
                key: m.marker_id, className: 'ar-mt-row' + (bad ? ' bad' : '') + (on ? ' sel' : ''),
                onClick: () => s.setCalSel({ type: 'armarker', id: m.marker_id }),
              },
                h('span', { className: 'mono' }, 'id ' + m.marker_id),
                h('span', { className: 'mono dim' }, m.count),
                h('span', { className: 'mono' + (bad ? ' s-negative' : '') }, m.mean_px.toFixed(2)),
                h('span', { className: 'mono' + (bad ? ' s-negative' : '') }, m.max_px.toFixed(2)));
            })),
          h('div', { className: 'ar-mt-hint' }, h(Icon, { name: 'info', size: 12 }), 'mean_px > 1.00 三通道告警 · 点击行在检查器查看详情'))));
  }

  /* 检查器：选中 marker 详情（纯函数，ws 由 calAr.tsx 的 arInspector 无条件调用
     useArWorkspace() 后传入，理由同 calLens.tsx 的 lensInspector 架构注释） */
  function verifyInspector(s, ws) {
    const CX = window.VOLO_CAL2 || {};
    const { Badge } = window.Spectrum2DesignSystem_b6d1b3;
    const sel = s.calSel;
    if (!sel || sel.type !== 'armarker') return CX.inspEmpty ? CX.inspEmpty('选择一个 marker 查看详情') : null;
    const V = ws && ws.lastVerify;
    const m = V && (V.per_marker || []).find((x) => x.marker_id === sel.id);
    if (!m) return CX.inspEmpty ? CX.inspEmpty('该 marker 不在最近一次验证结果中') : null;
    const bad = overThresh(m);
    const KV = (k, v, mono) => h('div', { className: 'kv', key: k }, h('span', { className: 'k' }, k), h('span', { className: 'v' + (mono ? ' mono' : '') }, v));
    return h(React.Fragment, null,
      h('div', { className: 'insp-head' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 } },
          h('span', { style: { width: 30, height: 30, borderRadius: 8, background: 'var(--wash)', display: 'grid', placeItems: 'center' } }, h(Icon, { name: 'pin', size: 16 })),
          h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-code)' } }, 'marker id ' + m.marker_id)),
        h('div', null, h(Badge, { variant: bad ? 'negative' : 'positive', size: 'S' }, bad ? '超阈值' : '正常'))),
      h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '误差'),
        KV('count', m.count, true), KV('mean_px', m.mean_px.toFixed(2), true), KV('max_px', m.max_px.toFixed(2), true)),
      h('div', { className: 'insp-sect' }, h('div', { className: 'lh' }, '说明'),
        h('div', { style: { fontSize: 12, color: 'var(--chrome-dim)', lineHeight: 1.55 } },
          bad ? '该 marker 平均重投影误差超过 1.00 px，多为立方体制造公差来源或视角覆盖不足。建议补采该 marker 附近机位，或改用毫米级实测真值。' : '该 marker 重投影误差在阈值内，真值与检测一致性良好。')));
  }

  /* =================== ⑥ 历史与导出 =================== */
  function Runs({ s }) {
    const AR = window.VOLO_CAL_AR;
    const { Button } = window.Spectrum2DesignSystem_b6d1b3;
    const ws = AR.useArWorkspace();
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(false);
    const [scanErr, setScanErr] = useState(null);
    const [sel, setSel] = useState(null);
    const [delayProfile, setDelayProfile] = useState('none'); /* 'none' | 绝对路径 */
    const [exporting, setExporting] = useState(false);
    const [exportResult, setExportResult] = useState(null);

    const load = async (root) => {
      if (!root) { setRows([]); return; }
      setLoading(true); setScanErr(null);
      try { const r = await listArRuns(root); setRows(r || []); if (r && r.length) setSel((cur) => cur || r[0].id); }
      catch (e) { setScanErr(e && e.message ? e.message : String(e)); setRows([]); }
      finally { setLoading(false); }
    };
    useEffect(() => { load(ws.runsRoot); }, [ws.runsRoot]);

    const run = rows.find((r) => r.id === sel) || rows[0];
    const pickDelayProfile = async () => {
      const p = await pickFile('delay profile JSON（capture delay-cal 输出）', ['json']).catch(() => null);
      if (p) setDelayProfile(p);
    };
    const doExport = async () => {
      if (!run || !ws.sessionPath) return;
      const outDir = await pickDirectory().catch(() => null); if (!outDir) return;
      const sep = outDir.indexOf('\\') >= 0 ? '\\' : '/';
      const outPath = outDir.replace(/[\\/]+$/, '') + sep + 'opentrackio_ar_' + run.id + '.json';
      const argv = ['export', 'opentrackio', '--result', run.result_path, '--session', ws.sessionPath, '--out', outPath, '--frame', 'ue'];
      if (delayProfile !== 'none') argv.push('--delay-profile', delayProfile);
      setExporting(true);
      s.setLogOpen(true);
      s.pushLog({ lv: 'info', cat: 'ar', msg: '导出 OpenTrackIO · <b>vpcal export opentrackio</b>' + (delayProfile !== 'none' ? ' · --delay-profile' : '') });
      try {
        const out = await spawnSidecar('vpcal', argv.concat(['--output', 'json']));
        const env = AR.parseEnvelope(out);
        if (env && env.status === 'error') throw new Error(env.error && env.error.message);
        const rd = env && env.data;
        setExportResult(rd);
        s.pushLog({ lv: 'ok', cat: 'ar', msg: `导出完成 · ${rd.samples} 样本` + (rd.applied_delay_ms != null ? ` · applied_delay ${rd.applied_delay_ms >= 0 ? '+' : ''}${rd.applied_delay_ms.toFixed(1)} ms` : '') });
      } catch (e) {
        s.pushLog({ lv: 'err', cat: 'ar', msg: '导出失败 · ' + (e && e.message ? e.message : e) });
      } finally { setExporting(false); }
    };

    const gridCols = { gridTemplateColumns: '.6fr 1fr 92px 92px 88px 62px 70px 1fr' };
    return h(AR.Page, { title: '历史与导出', chip: h(React.Fragment, null, h(Icon, { name: 'list', size: 14 }), 'runs · OpenTrackIO'), right: null },
      h('div', { className: 'dash-card' },
        h('div', { className: 'dc-h' },
          h('span', { className: 't' }, h(Icon, { name: 'list', size: 14 }), 'runs'),
          h('span', { className: 'dc-n' }, ws.runsRoot ? (loading ? '扫描中…' : rows.length + ' 次') : '未设置 runs 根目录')),
        !ws.runsRoot
          ? h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)', padding: '10px 2px' } },
              h('button', { className: 'cal2-folderbtn', onClick: () => AR.pickArPath('runsroot', null) }, h(Icon, { name: 'folder', size: 13 }), '选择 runs 根目录'))
          : scanErr
            ? h('div', { className: 'ar-degen ar-degen--negative' }, h(Icon, { name: 'alert', size: 15 }), h('div', null, h('b', null, '扫描失败'), h('div', { className: 'ar-degen-d' }, scanErr)))
            : rows.length === 0
              ? h('div', { style: { fontSize: 12, color: 'var(--chrome-faint)', padding: '10px 2px' } }, '未在该目录（含直接子目录）找到 result.json')
              : h(React.Fragment, null,
                  h('div', { className: 'ar-runtable' },
                    h('div', { className: 'ar-rt-head', style: gridCols },
                      h('span', null, 'id'), h('span', null, 'timestamp'), h('span', null, 'reproj_rms'), h('span', null, 'val_rms'),
                      h('span', null, 'confidence'), h('span', null, 'map'), h('span', null, 'delay'), h('span', null, 'result')),
                    rows.map((r) => h('div', {
                      key: r.id, className: 'ar-rt-row' + (sel === r.id ? ' sel' : ''), style: Object.assign({ cursor: 'pointer' }, gridCols), onClick: () => setSel(r.id),
                    },
                      h('span', { className: 'mono' }, r.id),
                      h('span', { className: 'dim' }, r.timestamp || 'n/a'),
                      h('span', null, AR.pxBadge(r.reprojection_rms_px)),
                      h('span', null, AR.pxBadge(r.validation_rms_px, [1, 2])),
                      h('span', null, r.confidence ? AR.confBadge(r.confidence) : 'n/a'),
                      h('span', { className: 'mono dim' }, 'n/a'),
                      h('span', { className: 'mono dim' }, 'n/a'),
                      h('button', { className: 'cal2-objbtn', onClick: (e) => { e.stopPropagation(); revealPath(AR.dirName(r.result_path)).catch(() => {}); } },
                        h(Icon, { name: 'external', size: 12 }), 'result.json')))),
                  h('div', { className: 'ar-mt-hint', style: { marginTop: 8 } }, h(Icon, { name: 'info', size: 12 }), 'map 与 delay 列不在 runs 数据源内，显示 n/a'))),
      h('div', { className: 'ar-export' },
        h('div', { className: 'ar-exp-main' },
          h('div', { className: 'ar-exp-h' }, h(Icon, { name: 'download', size: 14 }), '导出 OpenTrackIO'),
          h('div', { className: 'cap-field' }, h('span', { className: 'cap-lbl' }, 'run'),
            h('select', { className: 'ar-select', value: sel || '', onChange: (e) => setSel(e.target.value) },
              rows.length
                ? rows.map((r, i) => h('option', { key: r.id, value: r.id }, r.id + (r.timestamp ? ' · ' + r.timestamp : '') + (i === 0 ? ' · 最新' : '')))
                : h('option', { value: '' }, '暂无 run'))),
          h('div', { className: 'cap-field' }, h('span', { className: 'cap-lbl' }, '坐标系'),
            h('span', { className: 'ar-fixed-chip' }, h(Icon, { name: 'cube', size: 13 }), 'UE', h('span', { className: 'ar-fixed-lock' }, h(Icon, { name: 'shield', size: 11 }), '固定'))),
          h('div', { className: 'cap-field' }, h('span', { className: 'cap-lbl' }, '延迟档案'),
            h('select', {
              className: 'ar-select', value: delayProfile,
              onChange: (e) => { if (e.target.value === '__browse') pickDelayProfile(); else setDelayProfile(e.target.value); },
            },
              h('option', { value: 'none' }, '不应用延迟档案'),
              delayProfile !== 'none' ? h('option', { value: delayProfile }, AR.baseName(delayProfile)) : null,
              h('option', { value: '__browse' }, '浏览选择…'))),
          h('div', { className: 'ar-exp-note' }, h(Icon, { name: 'shield', size: 13 }),
            delayProfile === 'none' ? '导出原始外参 · 延迟由合成引擎另行补偿' : 'vpcal 已扣除该延迟，避免与合成引擎二次补偿'),
          h('div', { style: { marginTop: 13 } },
            h(Button, { variant: 'accent', size: 'M', isDisabled: exporting || !run || !ws.sessionPath, icon: h(Icon, { name: 'download', size: 15 }), onPress: doExport },
              exporting ? '导出中…' : '导出 OpenTrackIO'))),
        h('div', { className: 'ar-exp-main' },
          h('div', { className: 'ar-exp-h' }, h(Icon, { name: 'doc', size: 14 }), '导出结果'),
          exportResult
            ? h(React.Fragment, null,
                h('div', { className: 'ar-det', style: { gridTemplateColumns: '1fr 1fr', marginBottom: 13 } },
                  AR.gm('samples', exportResult.samples, true),
                  AR.gm('applied_delay_ms', exportResult.applied_delay_ms != null ? (exportResult.applied_delay_ms >= 0 ? '+' : '') + exportResult.applied_delay_ms.toFixed(1) : 'n/a', true)),
                h('div', { className: 'cal2-prod', style: { margin: 0 } },
                  h('span', { className: 'cal2-prod-ic' }, h(Icon, { name: 'doc', size: 14 })),
                  h('div', { className: 'cal2-prod-m' }, h('div', { className: 'cal2-prod-f' }, AR.baseName(exportResult.output)), h('div', { className: 'cal2-prod-d' }, AR.dirName(exportResult.output))),
                  h('button', { className: 'cal2-folderbtn', onClick: () => revealPath(AR.dirName(exportResult.output)).catch(() => {}) }, h(Icon, { name: 'external', size: 13 }), '打开文件夹')))
            : h('div', { className: 'cal2-cap-empty', style: { padding: '24px 16px' } },
                h('div', { className: 'ce-ico', style: { width: 56, height: 56, borderRadius: 14, marginBottom: 12 } }, h(Icon, { name: 'download', size: 26, stroke: 1.3 })),
                h('div', { style: { fontSize: 13, fontWeight: 700, color: 'var(--chrome-dim)' } }, '尚未导出'),
                h('div', { style: { fontSize: 11.5, color: 'var(--chrome-faint)', marginTop: 4 } }, '选择 run 与延迟档案后导出 OpenTrackIO')))));
  }

  window.VOLO_CAL_AR = Object.assign(window.VOLO_CAL_AR || {}, { Verify, verifyInspector, Runs });
})();

export {};
