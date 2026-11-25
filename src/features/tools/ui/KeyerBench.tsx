/* 键控实验 · 基准测试：选一组测试集 PNG（可带 manifest.json），逐 case 跑引擎，出误差表；报告可导出 JSON。
   用自己的画布和引擎，不动实验台的参数。设计稿没画这一页，按新 DS 补。 */
import { useEffect, useRef, useState } from "react";
import { saveFileBytes } from "@/api/commands";
import { errText, toast } from "@/lib/toast";
import { Button, Empty, HeadRow, Note, Progress, Row, RowEnd, RowTitle, Spacer, Table, TableBody, Toolbar, GroupRow } from "@/ui";
import { KeyerEngine } from "../keyer/engine";
import { probeWebGpu, type GpuProbeResult } from "../keyer/gpu";
import { BENCH_METRICS, devFsUrl, loadDevTestset, runBench, type BenchManifestEntry, type BenchReport, type BenchRow } from "../model/keyerBench";
import css from "./tools.module.css";

const TEST_TOOLS = import.meta.env.DEV || import.meta.env.VITE_KEYER_TEST_TOOLS === "1";
const COLS = `minmax(160px, 1fr) repeat(${BENCH_METRICS.length}, 72px) 72px`;

export function BenchView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<KeyerEngine | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [probe, setProbe] = useState<GpuProbeResult | null>(null);
  const [rows, setRows] = useState<BenchRow[]>([]);
  const [report, setReport] = useState<BenchReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    probeWebGpu(canvasRef.current!)
      .then((r) => {
        if (dead) return;
        setProbe(r);
        if (r.ok) engineRef.current = new KeyerEngine(r);
      })
      .catch((e) => !dead && setProbe({ ok: false, reason: errText(e) }));
    return () => {
      dead = true;
      engineRef.current = null;
    };
  }, []);

  const run = async (files: File[], manifest: BenchManifestEntry[]) => {
    const e = engineRef.current;
    if (!e || !files.length) return;
    setRunning(true);
    setRows([]);
    setReport(null);
    setError(null);
    try {
      setReport(await runBench(e, files, manifest, setRows));
    } catch (err) {
      setError(errText(err));
    } finally {
      setRunning(false);
    }
  };
  const pick = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    const mf = files.find((f) => f.name === "manifest.json");
    let manifest: BenchManifestEntry[] = [];
    if (mf) {
      try {
        manifest = JSON.parse(await mf.text()) as BenchManifestEntry[];
      } catch {
        toast("manifest.json 读不出来，按默认参数跑");
      }
    }
    await run(files.filter((f) => f.name.endsWith(".png")), manifest);
  };
  const autoLoad = async () => {
    try {
      const { files, manifest } = await loadDevTestset(import.meta.env.DEV ? devFsUrl(__KEYER_TESTSET_FS__) : "/testset");
      await run(files, manifest);
    } catch (err) {
      setError(errText(err));
    }
  };
  const exportReport = async () => {
    if (!report) return;
    try {
      const path = await saveFileBytes("keyer-report.json", "JSON", ["json"], new TextEncoder().encode(JSON.stringify(report, null, 2)));
      if (path) toast("已导出报告");
    } catch (err) {
      toast(`导出失败：${errText(err)}`);
    }
  };
  const ok = !!probe?.ok;

  return (
    <>
      <Toolbar label="基准测试操作">
        <Button icon="import" busy={running} disabled={!ok || running} onClick={() => fileRef.current?.click()}>
          选择测试集
        </Button>
        {TEST_TOOLS && (
          <Button variant="ghost" disabled={!ok || running} onClick={() => void autoLoad()}>
            自动加载测试集
          </Button>
        )}
        <Spacer />
        <Button icon="export" disabled={!report} onClick={() => void exportReport()}>
          导出报告
        </Button>
      </Toolbar>
      <Progress on={running} />
      <input
        ref={fileRef}
        type="file"
        hidden
        multiple
        accept="image/png,application/json"
        onChange={(e) => {
          const l = e.target.files;
          void pick(l).finally(() => {
            e.target.value = "";
          });
        }}
      />
      <div className={`volo-viewport ${css.benchView}`}>
        <canvas ref={canvasRef} width={1280} height={720} className={css.benchCanvas} aria-label="当前 case 的键控结果" />
        {!rows.length && !running && (
          <div className={css.keyEmpty}>
            {probe && !probe.ok ? (
              <Note kind="failed">
                <p>{`这台电脑的 WebGPU 不可用：${probe.reason}`}</p>
              </Note>
            ) : (
              <Empty icon="grid" title="还没有跑基准测试">
                选一组测试集 PNG（case01_xxx.input / gt / fgpre / plate.png，可带 manifest.json），逐个 case 和真值比。
              </Empty>
            )}
          </div>
        )}
      </div>
      {error && <p className={css.errText}>{error}</p>}
      {rows.length > 0 && (
        <Table label="基准测试误差，越小越好" className={css.tableTop}>
          <TableBody>
            <HeadRow cols={COLS}>
              <span>case</span>
              {BENCH_METRICS.map((m) => (
                <RowEnd key={m.key}>{m.label}</RowEnd>
              ))}
              <RowEnd>耗时</RowEnd>
            </HeadRow>
            <GroupRow kind={running ? "running" : "success"} label={running ? "进行中" : "已完成"} count={rows.length} />
            {rows.map((r) => (
              <Row key={r.id} cols={COLS}>
                <RowTitle>
                  <span className="ry-mono">{r.id}</span>
                </RowTitle>
                {BENCH_METRICS.map((m) => (
                  <RowEnd key={m.key}>{r[m.key].toFixed(4)}</RowEnd>
                ))}
                <RowEnd>{`${r.ms.toFixed(0)} ms`}</RowEnd>
              </Row>
            ))}
            {report && (
              <Row cols={COLS} className={css.aggRow}>
                <RowTitle>平均</RowTitle>
                {BENCH_METRICS.map((m) => (
                  <RowEnd key={m.key}>{report.aggregate[m.key].toFixed(4)}</RowEnd>
                ))}
                <RowEnd>—</RowEnd>
              </Row>
            )}
          </TableBody>
        </Table>
      )}
    </>
  );
}
