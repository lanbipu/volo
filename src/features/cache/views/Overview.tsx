// Volo · Cache —— 集群总览（移植自原型 page_cache.jsx 的 Overview 函数）。
// 集群健康条 land-status + KPI 卡 + 机器管理 section + 诊断面板 + 最近任务 + 空集群引导。
// 真命令接线：机器 useMachines()；健康 listRecentHealthRuns/listHealthResultsForRun；
// INI listRecentIniRuns/listFindings/applyFinding/skipFinding；巡检 runHealthCheck；
// GPU 一致性 getGpuConsistencyMatrix；最近任务 useCache().tasks。
// §4 处置：砍掉「本地 DDC 就绪 / PSO 就绪」KPI（无数据源）→ 改为「节点在线」「GPU 一致性」
// 等真实可得指标；机器卡的 ddc/pso 百分比、per-node channel 标签由 MachineSection 一并砍掉。
import { useState } from "react";
import { Icon } from "../ui/Icon";
import { Button } from "../ui/Button";
import { ChannelTag, TONE_META, type Tone } from "../ui/status";
import { useCache } from "../state/store";
import { useMachines } from "../state/data";
import { useAsync } from "../state/useAsync";
import {
  listRecentHealthRuns,
  listHealthResultsForRun,
  listRecentIniRuns,
  listFindings,
  listCredentials,
  runHealthCheck,
  scanInis,
  zenProbe,
  zenCacheStats,
  getGpuConsistencyMatrix,
  applyFinding,
  skipFinding,
} from "../api/commands";
import type {
  CheckStatus,
  HealthCheckRow,
  IniFinding,
  IniSeverity,
} from "../api/types";
import { MachineSection } from "./Machines";
import { ScanWizard } from "./ScanWizard";

/* 健康检查项 status / INI severity → 视觉 tone（仅取严重度通道）。 */
const CHECK_TONE: Record<CheckStatus, Tone> = {
  healthy: "healthy",
  warning: "warning",
  critical: "critical",
  offline: "offline",
  na: "na",
  unknown: "unknown",
};
const SEV_TONE: Record<IniSeverity, Tone> = {
  critical: "critical",
  warning: "warning",
  healthy: "healthy",
  info: "info",
};

/** 巡检发现的一条待处理问题（健康检查项 + INI finding 合并后的统一形态）。 */
interface Problem {
  key: string;
  src: string;
  tag: string;
  tone: Tone;
  rank: number; // 0=critical 1=warning（排序用）
  label: string;
  detail: string;
  onFix: () => void;
  onSkip?: () => void;
}

const taskVis = (st: string) =>
  st === "running"
    ? "accent"
    : st === "success"
      ? "positive"
      : st === "failed"
        ? "negative"
        : "neutral";

export function Overview() {
  const { tasks, openPreview, runTask, setLogOpen, setLogSearch } = useCache();
  const { machines } = useMachines();
  const [scanOpen, setScanOpen] = useState(false);
  const onScan = () => setScanOpen(true);

  // 最近一次健康巡检 run → 该 run 的逐机结果。
  const healthRuns = useAsync(() => listRecentHealthRuns(1), []);
  const healthRunId = healthRuns.data?.[0]?.id ?? null;
  const healthResults = useAsync<HealthCheckRow[]>(
    () => (healthRunId == null ? Promise.resolve([]) : listHealthResultsForRun(healthRunId)),
    [healthRunId],
  );

  // 最近一次 INI 扫描 run → 该 run 的 findings。
  const iniRuns = useAsync(() => listRecentIniRuns(1), []);
  const iniRunId = iniRuns.data?.[0]?.id ?? null;
  const iniFindings = useAsync<IniFinding[]>(
    () => (iniRunId == null ? Promise.resolve([]) : listFindings(iniRunId)),
    [iniRunId],
  );

  // 凭据（修复 / 巡检需要 alias）。
  const creds = useAsync(() => listCredentials(), []);
  const alias = creds.data?.[0]?.alias ?? "";

  // GPU 一致性矩阵。
  const gpu = useAsync(() => getGpuConsistencyMatrix(), []);

  const wizard = scanOpen ? <ScanWizard onClose={() => setScanOpen(false)} /> : null;

  /* ---------- 空集群引导：先扫描添加机器，巡检才有意义 ---------- */
  if (!machines.length) {
    const step = (n: number, icon: string, title: string, desc: string, on: boolean) => (
      <div className={"ce-step" + (on ? " on" : "")}>
        <span className="ce-step-n">{on ? <Icon name="arrowr" size={13} /> : n}</span>
        <span className="ce-step-ico">
          <Icon name={icon} size={18} />
        </span>
        <div className="ce-step-txt">
          <div className="ce-step-t">{title}</div>
          <div className="ce-step-d">{desc}</div>
        </div>
      </div>
    );
    return (
      <div className="dash">
        <div className="cluster-empty">
          <div className="ce-ico">
            <Icon name="node" size={36} stroke={1.3} />
          </div>
          <div className="ce-t">集群里还没有机器</div>
          <div className="ce-d">
            先扫描局域网，发现并加入机器。没有机器，巡检与缓存管理都无从谈起 —— 添加机器是第一步。
          </div>
          <div className="ce-acts">
            <Button
              variant="accent"
              size="L"
              icon={<Icon name="search" size={16} />}
              onPress={onScan}
            >
              扫描局域网…
            </Button>
          </div>
          <div className="ce-steps">
            {step(1, "search", "扫描网段", "输入 IP 或 CIDR，探活发现未纳管设备", true)}
            {step(2, "download", "选择并加入", "勾选要纳管的机器，加入机器列表", false)}
            {step(3, "pulse", "巡检与部署", "机器就位后，才能巡检健康、部署缓存", false)}
          </div>
        </div>
        {wizard}
      </div>
    );
  }

  /* ---------- 已有机器：全局概览 + 机器管理 ---------- */
  // 「在线」严格指 status==="online"（unknown 是探测未定，不计在线）—— 与 CacheActions / Machines 统一口径。
  const onlineCount = machines.filter((n) => n.status === "online").length;
  const totalCount = machines.length;
  const offlineCount = machines.filter((n) => n.status === "offline").length;
  const allOnline = offlineCount === 0;

  // GPU 一致性：与 baseline 一致（match）的机器数。
  const gpuCells = gpu.data?.cells ?? [];
  const gpuMatch = gpuCells.filter((c) => c.status === "match").length;
  const gpuDeviation = gpuCells.filter((c) => c.status === "deviation").length;
  const hasBaseline = !!gpu.data?.baseline;

  const onlineIds = machines
    .filter((n): n is typeof n & { id: number } => n.id != null && n.status !== "offline")
    .map((n) => n.id);

  // 立即巡检 = 原型的统一检测：zen probe → cache-stats → health run → ini scan。
  // 健康巡检与 INI 一致性都在这里跑，结果汇入下方「诊断与健康」（不再有独立的一致性 / 健康页）。
  const refreshScan = () =>
    runTask({
      domain: "health",
      action: "run",
      target: "集群 · " + onlineCount + " 台",
      chan: "ssh",
      note: "zen probe → cache-stats → health run → ini scan",
      lines: [
        { msg: "zen probe → cache-stats（消除 zen 陈旧误报）" },
        { msg: "run_health_check L1/L2/L3 · ini_consistency / gpu_consistency / zen_reachable" },
        { msg: "scan_inis · DDC 一致性（产出可修复项）" },
        { lv: "ok", msg: "巡检完成 · 结果见下方「诊断与健康」" },
      ],
      run: async (ctx) => {
        // zen 预热（best-effort，不阻断后续巡检）
        try {
          await zenProbe();
          await zenCacheStats();
        } catch (e) {
          ctx.log({ lv: "warn", cat: "zen", msg: "zen 预热跳过 · " + String(e) });
        }
        // 健康巡检（核心；失败则整次巡检标失败）
        await runHealthCheck({ machine_ids: onlineIds, credential_alias: alias, project_paths: [] });
        healthRuns.reload();
        gpu.reload();
        // INI 一致性扫描（best-effort，产出可修复 findings）
        try {
          await scanInis({ machine_ids: onlineIds, credential_alias: alias, project_paths: [] });
          iniRuns.reload();
        } catch (e) {
          ctx.log({ lv: "warn", cat: "ini", msg: "INI 一致性扫描失败 · " + String(e) });
        }
      },
    });

  // 健康检查项修复（无逐项 remediation 命令，走 preview 展示 + re-scan 提示）。
  const fixCheck = (machineId: number, name: string, msg: string, remediation: string) =>
    openPreview({
      title: "应用修复 · " + name,
      icon: "pulse",
      cli: "health remediation",
      destructive: false,
      channel: "ssh",
      steps: [remediation || msg, "修复后请重新巡检这一项，确认是否恢复正常"],
      scope: machineId ? [machineId] : [],
    });

  // INI finding 修复 → applyFinding（真命令，进 preview→确认→执行）。
  // finding 已绑定 machine_id，用 simpleScope 把目标机展示出来；同时让确认按钮可用
  // （scope:[] 会被 PreviewPanel 的 willApply===0 判定永久禁用确认）。
  const fixIni = (f: IniFinding) => {
    const fm = machines.find((m) => m.id === f.machine_id);
    openPreview({
      title: "应用修复 · " + f.rule_id,
      icon: "pulse",
      cli: "ini apply",
      destructive: false,
      channel: "ssh",
      steps: [
        (f.file_path || "") +
          (f.section ? " " + f.section : "") +
          "：" +
          f.snippet_before +
          (f.snippet_after ? " → " + f.snippet_after : ""),
        "先创建 .bak.<时间戳> 备份，apply 后请重新巡检确认 warning 计数下降",
      ],
      simpleScope: [
        { host: fm?.hostname ?? "机器 #" + f.machine_id, ip: fm?.ip ?? "—", msg: "应用 INI 修复" },
      ],
      task: {
        domain: "ini",
        action: "apply",
        target: "finding #" + (f.id ?? ""),
        chan: "ssh",
        note: f.rule_id + " · " + f.recommended_action,
        lines: [
          {
            msg:
              "apply_finding " +
              (f.id ?? "") +
              " → " +
              (f.recommended_value ?? f.recommended_action),
          },
          { lv: "ok", msg: "已修复，请 re-scan 确认 warning 计数下降" },
        ],
        run:
          f.id == null
            ? undefined
            : async () => {
                await applyFinding(f.id as number, alias);
                iniRuns.reload();
              },
      },
    });
  };

  const skipIni = async (f: IniFinding) => {
    if (f.id == null) return;
    await skipFinding(f.id);
    iniFindings.reload();
  };

  // 健康检查项（critical / warning）→ 待处理问题。
  const healthRows = healthResults.data ?? [];
  const healthProblems: Problem[] = healthRows.flatMap((row) =>
    Object.entries(row.machine_results)
      .filter(([, o]) => o.status === "critical" || o.status === "warning")
      .map(([name, o]) => ({
        key: "h_" + row.machine_id + "_" + name,
        src: "健康",
        tag: name,
        tone: CHECK_TONE[o.status],
        rank: o.status === "critical" ? 0 : 1,
        label: o.message || name,
        detail: o.sample || o.remediation || "",
        onFix: () => fixCheck(row.machine_id, name, o.message, o.remediation),
      })),
  );

  // INI findings（critical / warning，未修复未跳过）→ 待处理问题。
  const iniProblems: Problem[] = (iniFindings.data ?? [])
    .filter(
      (f) =>
        (f.severity === "critical" || f.severity === "warning") &&
        !f.fixed_at &&
        !f.skipped_at,
    )
    .map((f) => ({
      key: "i_" + (f.id ?? f.rule_id),
      src: "INI",
      tag: f.rule_id,
      tone: SEV_TONE[f.severity],
      rank: f.severity === "critical" ? 0 : 1,
      label: f.symptom || f.recommended_action,
      detail: f.rationale,
      onFix: () => fixIni(f),
      onSkip: () => void skipIni(f),
    }));

  const problems = [...healthProblems, ...iniProblems].sort((a, b) => a.rank - b.rank);
  const critCt = problems.filter((p) => p.rank === 0).length;
  const warnCt = problems.length - critCt;
  const alerts = problems.length;

  // 集群健康条总体 tone。
  const overall: Tone = problems.some((p) => p.rank === 0)
    ? "critical"
    : problems.length
      ? "warning"
      : "healthy";
  const overallMeta = TONE_META[overall];

  // 巡检快照时间（最近 health run）。
  const lastRun =
    healthRuns.data?.[0]?.finished_at ?? healthRuns.data?.[0]?.started_at ?? null;

  const kpi = (
    icon: string,
    k: string,
    big: string,
    bigTone: string,
    note: string,
    noteTone: string,
  ) => (
    <div className="kpi">
      <div className="kpi-h">
        <span className="kpi-ico">
          <Icon name={icon} size={15} />
        </span>
        <span className="kpi-k">{k}</span>
      </div>
      <div className={"kpi-v" + (bigTone ? " " + bigTone : "")}>{big}</div>
      <div className={"kpi-note" + (noteTone ? " " + noteTone : "")}>{note}</div>
    </div>
  );

  const recent = tasks.slice(0, 5);

  return (
    <div className="dash">
      {/* 1 · 集群健康总览条 */}
      <div className={"land-status hero-" + overall}>
        <div className={"ls-badge s-" + overallMeta.visual}>
          <Icon name={overallMeta.icon} size={24} />
        </div>
        <div className="ls-main">
          <div className="ls-line">
            <b>{onlineCount + " 台在线"}</b>
            <span className="dim"> / </span>
            <span>{offlineCount + " 台离线"}</span>
            <span className="dim"> · </span>
            <b className={"s-" + (critCt ? "negative" : alerts ? "notice" : "positive")}>
              {alerts + " 项告警"}
            </b>
          </div>
          <div className="ls-sub">
            {"后台自动巡检 · 上次 " + (lastRun ?? "—") + " · 缓存快照，非实时轮询"}
          </div>
        </div>
        <Button
          variant="accent"
          size="M"
          icon={<Icon name="sync" size={15} />}
          onPress={refreshScan}
        >
          立即巡检
        </Button>
      </div>

      {/* 2 · 关键指标小卡（§4：砍掉本地 DDC / PSO 就绪，改为真实可得指标） */}
      <div className="dash-kpis">
        {kpi(
          "node",
          "节点在线",
          onlineCount + " / " + totalCount + " 台",
          allOnline ? "s-positive" : "s-negative",
          allOnline ? "全部在线" : offlineCount + " 台离线 · " + onlineCount + " 台在线",
          allOnline ? "s-positive" : "s-negative",
        )}
        {kpi(
          "cpu",
          "GPU 一致性",
          hasBaseline ? gpuMatch + " / " + gpuCells.length + " 匹配" : "—",
          gpuDeviation ? "s-notice" : "s-positive",
          !hasBaseline
            ? "无基线 · 待巡检"
            : gpuDeviation
              ? gpuDeviation + " 台驱动偏离基线"
              : "驱动全部对齐基线",
          gpuDeviation ? "s-notice" : "s-positive",
        )}
        {kpi(
          "alert",
          "待处理问题",
          alerts + " 项",
          critCt ? "s-negative" : warnCt ? "s-notice" : "s-positive",
          critCt
            ? critCt + " 严重 · " + warnCt + " 警告"
            : warnCt
              ? warnCt + " 警告"
              : "全部检查通过",
          critCt ? "s-negative" : warnCt ? "s-notice" : "s-positive",
        )}
        {kpi(
          "eye",
          "上次巡检快照",
          lastRun ?? "未巡检",
          healthRunId ? "" : "s-notice",
          lastRun ? "缓存快照，非实时轮询" : "尚无巡检记录 · 点「立即巡检」",
          healthRunId ? "" : "s-notice",
        )}
      </div>

      {/* 3 · 机器管理（扫描 / 加入 / 列表 / 部署环境） */}
      <MachineSection onScan={onScan} />

      {/* 4 · 诊断健康面板 | 最近任务 */}
      <div className="dash-grid dash-grid--diag">
        <div className="dash-card diag-card">
          <div className="dc-h">
            <span className="t">
              <Icon name="pulse" size={14} />
              诊断与健康 · 待处理问题
            </span>
            <span className="dc-n">{lastRun ? "上次 " + lastRun : "尚未巡检"}</span>
          </div>
          <div className="diag-sub">
            {critCt ? <span className="diag-cnt s-negative">{critCt + " 严重"}</span> : null}
            {warnCt ? <span className="diag-cnt s-notice">{warnCt + " 警告"}</span> : null}
            <span className="diag-cnt-src">健康巡检 + INI 一致性</span>
          </div>
          {problems.length === 0 ? (
            <div className="diag-clear">
              <Icon name="check" size={15} />
              {healthRunId || iniRunId
                ? "全部检查通过，暂无待处理问题"
                : "尚无巡检记录 · 点「立即巡检」"}
            </div>
          ) : (
            <div className="diag-list">
              {problems.map((p) => {
                const m = TONE_META[p.tone];
                return (
                  <div key={p.key} className="diag-row">
                    <span className={"diag-ico s-" + m.visual}>
                      <Icon name={m.icon} size={13} />
                    </span>
                    <span className="diag-layer">{p.src}</span>
                    <div className="diag-meta">
                      <div className="dl">{p.label}</div>
                      <div className="dd">
                        <span className="diag-rule">{p.tag}</span>
                        {p.detail}
                      </div>
                    </div>
                    {p.onSkip ? (
                      <button className="mini-btn" onClick={p.onSkip}>
                        跳过
                      </button>
                    ) : null}
                    <button className="fix-btn" onClick={p.onFix}>
                      <Icon name="bolt" size={12} />
                      修复
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="dash-col">
          <div className="dash-card">
            <div className="dc-h">
              <span className="t">
                <Icon name="list" size={14} />
                最近任务
              </span>
              <span
                className="dc-n"
                style={{ cursor: "pointer" }}
                onClick={() => setLogOpen(true)}
              >
                NDJSON 流 →
              </span>
            </div>
            <div className="recent">
              {recent.length === 0 ? (
                <div className="diag-clear">
                  <Icon name="list" size={15} />
                  暂无任务
                </div>
              ) : (
                recent.map((t) => (
                  <div
                    key={t.id}
                    className="recent-row compact"
                    onClick={() => {
                      setLogSearch("#" + t.no);
                      setLogOpen(true);
                    }}
                  >
                    <span className={"tk-state s-" + taskVis(t.state)}>
                      {t.state === "running" ? (
                        <span className="spin">
                          <Icon name="sync" size={13} />
                        </span>
                      ) : t.state === "success" ? (
                        <Icon name="check" size={13} />
                      ) : t.state === "failed" ? (
                        <Icon name="x" size={13} />
                      ) : (
                        <Icon name="pause" size={13} />
                      )}
                    </span>
                    <span className="tk-title">
                      {t.title}
                      <span className="no">{"#" + t.no}</span>
                    </span>
                    <ChannelTag ch={t.chan} mini />
                    {t.state === "running" ? (
                      <span className="tk-pct">{t.pct + "%"}</span>
                    ) : (
                      <span className="tk-el">{t.elapsed}</span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
      {wizard}
    </div>
  );
}
