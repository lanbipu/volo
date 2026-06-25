// Volo · Cache —— DDC · PSO 缓存。
// 忠实移植自原型 cache_ddc.jsx 的 psoBody（scanPso / collectPso / selectPso / proj-list /
// gen-panel / art-list）。mock（UE_PROJECTS / RENDER_NODES / ARTIFACTS）换真命令：
//   listProjects / listProjectLocations / discoverProjects / startPsoCollection /
//   listPsoCacheFiles / distributePsoCache + useMachines / getMachineDetail。
// §4 处置：
//  · 工程行的 ue/size/hasPak/warn 后端无数据源 → 砍（保留 proj-row 结构，用真字段：
//    display_name / uproject_name / location_count）。
//  · 源机器候选由 listProjectLocations 的 machine_ids ∩ 在线机器拼出（替代 selPso.machines）。
//  · 源机 GPU 提示用 getMachineDetail(srcId).gpus[0]（gpu_model/vendor 后端有，正常显示）。
//  · 「已收集的 PSO 缓存」用 listPsoCacheFiles 真实文件列表渲染（这是 §4「PSO 用文件数/有无」的正解，
//    按 gpu_signature 展示，PSO 与 GPU 签名绑定的提示保留）。
import { useState } from "react";
import { Icon } from "../../ui/Icon";
import { Button } from "../../ui/Button";
import { Selector, type SelectorOption } from "../../ui/Selector";
import { fmtBytes } from "../../ui/format";
import { useCache } from "../../state/store";
import { useMachines } from "../../state/data";
import { useAsync } from "../../state/useAsync";
import {
  listProjects,
  listProjectLocations,
  discoverProjects,
  getMachineDetail,
  startPsoCollection,
  listPsoCacheFiles,
  distributePsoCache,
} from "../../api/commands";
import type {
  ProjectSummary,
  ProjectLocation,
  MachineDetail,
  PsoCacheFile,
} from "../../api/types";

/* 渲染分辨率 / 最长时长 —— 纯 UI 选项（非数据，照原型常量保留）。 */
const resOpts: SelectorOption[] = [
  { id: "1920×1080", label: "1920 × 1080" },
  { id: "2560×1440", label: "2560 × 1440" },
  { id: "3840×2160", label: "3840 × 2160" },
];
const maxOpts: SelectorOption[] = [
  { id: "10", label: "10 分钟" },
  { id: "20", label: "20 分钟" },
  { id: "30", label: "30 分钟" },
];

const projTitle = (p: ProjectSummary): string => p.display_name ?? p.uproject_name;

export function DdcPso() {
  const s = useCache();
  const { machines, byId } = useMachines();

  const [psoProj, setPsoProj] = useState<number | null>(null);
  const [psoSrc, setPsoSrc] = useState<number | null>(null);
  const [psoRes, setPsoRes] = useState("1920×1080");
  const [psoMax, setPsoMax] = useState("20");
  const [psoScope, setPsoScope] = useState("all");
  const [psoRoots, setPsoRoots] = useState("D:\\Projects;E:\\UEProjects");

  /* 工程库：listProjects（替代 UE_PROJECTS）。 */
  const projsAsync = useAsync<ProjectSummary[]>(() => listProjects(), []);
  const projects = projsAsync.data ?? [];
  const selPso = projects.find((p) => p.id === psoProj) ?? null;

  /* 选中工程的位置 → 取 machine_ids，与在线机器交集 = 收集源机器候选（替代 selPso.machines）。 */
  const locAsync = useAsync<ProjectLocation[]>(
    () => (psoProj == null ? Promise.resolve([]) : listProjectLocations(psoProj)),
    [psoProj],
  );
  const locMachineIds = (locAsync.data ?? []).map((l) => l.machine_id);
  const psoMachines = machines.filter(
    (n) => n.id != null && locMachineIds.includes(n.id) && n.status !== "offline",
  );
  const psoSrcOpts: SelectorOption[] = psoMachines.map((n) => ({
    id: String(n.id),
    label: n.hostname,
    sub: n.ip,
  }));
  // 校验选中源机仍在当前候选里；不在（离线/工程位置变化）则回退首台，避免显示态与提交 id 脱节。
  const effSrc =
    psoSrc != null && psoMachines.some((m) => m.id === psoSrc)
      ? psoSrc
      : psoMachines[0]?.id ?? null;

  /* 源机 GPU 提示：getMachineDetail(srcId).gpus[0]（§4：vendor/model 后端有）。 */
  const detailAsync = useAsync<MachineDetail | null>(
    () => (effSrc == null ? Promise.resolve(null) : getMachineDetail(effSrc)),
    [effSrc],
  );
  const srcGpu = detailAsync.data?.gpus?.[0] ?? null;

  /* 已收集的 PSO 缓存：listPsoCacheFiles（替代 ARTIFACTS · PSO）。 */
  const filesAsync = useAsync<PsoCacheFile[]>(
    () =>
      psoProj == null
        ? Promise.resolve([])
        : listPsoCacheFiles(psoProj, effSrc ?? undefined),
    [psoProj, effSrc],
  );
  const psoFiles = filesAsync.data ?? [];

  /* 扫描范围下拉：全部在线机 + 各在线机（替代 scopeOpts，机器来自真 useMachines）。 */
  const scopeOpts: SelectorOption[] = [{ id: "all", label: "全部在线机" }].concat(
    machines
      .filter((n) => n.id != null && n.status !== "offline")
      .map((n) => ({ id: String(n.id), label: n.hostname, sub: n.ip })),
  );
  const scopeMachine = psoScope === "all" ? null : byId(Number(psoScope));

  /* ---- ① 扫描 UE 工程（discover_projects，可按单台机器搜索）---- */
  const scanPso = () => {
    const roots = psoRoots
      .split(";")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
    const machineId = scopeMachine?.id ?? machines.find((n) => n.status !== "offline" && n.id != null)?.id ?? null;
    s.runTask({
      domain: "project",
      action: "discover",
      target: psoScope === "all" ? "全部在线机" : scopeMachine?.hostname ?? "—",
      note: "远程扫描 UE 工程（.uproject）",
      lines: [
        {
          msg:
            "discover_projects --scope " +
            (psoScope === "all" ? "online" : scopeMachine?.hostname ?? "—") +
            ' --roots "' +
            psoRoots +
            '"',
        },
        { lv: "ok", msg: "扫描完成，已对齐项目身份" },
      ],
      run: () => {
        if (machineId == null) return Promise.reject(new Error("没有可扫描的在线机器"));
        return discoverProjects(machineId, roots).then(() => projsAsync.reload());
      },
    });
  };

  /* ---- ③ 收集 PSO 缓存（start_pso_collection；长任务 · NDJSON · 按 GPU 签名）---- */
  const collectPso = () => {
    if (!selPso || effSrc == null) return;
    const [wStr, hStr] = psoRes.split("×");
    const resolutionW = parseInt(wStr, 10) || 1920;
    const resolutionH = parseInt(hStr, 10) || 1080;
    const maxMinutes = parseInt(psoMax, 10) || 20;
    const src = byId(effSrc);
    const projId = selPso.id;
    s.runTask({
      domain: "pso",
      action: "collect",
      target: projTitle(selPso),
      note: "收集 PSO 缓存 · " + projTitle(selPso) + "（长任务 · NDJSON）",
      lines: [
        {
          msg:
            "start_pso_collection --project " +
            projTitle(selPso) +
            " --src " +
            (src?.hostname ?? "—") +
            " --res " +
            psoRes +
            " --max " +
            psoMax +
            "min",
        },
        {
          msg:
            "GPU 签名：" +
            (srcGpu ? srcGpu.gpu_model + "（" + srcGpu.vendor + "）" : "—") +
            " · -game 窗口化收集",
        },
        { lv: "ok", msg: "PSO 收集完成 · " + projTitle(selPso) },
      ],
      job: true,
      run: async (ctx) => {
        const res = await startPsoCollection({
          sourceMachineId: effSrc,
          projectId: projId,
          resolutionW,
          resolutionH,
          windowed: true,
          maxMinutes,
        });
        ctx.update({ jobId: res.job_id }); // 存 job_id，任务抽屉才能真取消（cancel_ue_job）
        filesAsync.reload();
      },
    });
  };

  /* ---- 分发单个 PSO 文件（distribute_pso_cache，破坏性走 openPreview）---- */
  const distribute = (f: PsoCacheFile) => {
    if (f.id == null) return;
    const fileId = f.id;
    const defaultTargets = machines
      .filter((n) => n.id != null && n.status !== "offline" && n.role === "render")
      .map((n) => n.id!);
    s.openPreview({
      title: "分发 · " + f.file_name,
      icon: "download",
      cli: "pso distribute",
      channel: "ssh",
      steps: [
        "把这份 PSO 缓存包复制分发到各台渲染机",
        "分发前自动比对各机显卡是否匹配，不用你手动核对",
        "只有真的不匹配时才会弹出提醒",
      ],
      scope: defaultTargets,
      task: {
        domain: "pso",
        action: "distribute",
        target: f.file_name,
        note: "分发完成",
        lines: [
          { msg: "pso distribute " + f.file_name },
          { msg: "GPU preflight：按签名 " + f.gpu_signature + " 比对" },
          { lv: "ok", msg: "分发完成至目标机" },
        ],
        job: true,
        // 用确认浮层最终勾选的范围（ctx.scope）做真实目标，未改动则用默认全集。
        run: async (ctx) => {
          const res = await distributePsoCache({
            file_id: fileId,
            target_machine_ids: ctx.scope.length ? ctx.scope : defaultTargets,
            force_gpu_mismatch: false,
          });
          ctx.update({ jobId: res.job_id });
        },
      },
    });
  };

  /* ---- 工程行（proj-row；§4：砍 ue/size/hasPak/warn，用真字段）---- */
  const selectPso = (p: ProjectSummary) => {
    setPsoProj(p.id);
    setPsoSrc(null);
  };
  const projRow = (p: ProjectSummary) => {
    const on = p.id === psoProj;
    return (
      <div
        key={p.id}
        className={"proj-row" + (on ? " on" : "")}
        onClick={() => selectPso(p)}
      >
        <span className={"proj-mck" + (on ? " on" : "")}>
          {on ? <Icon name="check" size={12} /> : null}
        </span>
        <span className="proj-ico">
          <Icon name="film" size={17} />
        </span>
        <div className="proj-main">
          <div className="proj-name">{projTitle(p)}</div>
          <div className="proj-sub">{p.uproject_name}</div>
        </div>
        <div className="proj-tags">
          <span className="proj-tag">{p.location_count} 台</span>
        </div>
      </div>
    );
  };

  /* ---- PSO 产物行（art-row；按 gpu_signature 展示，§4 GPU 绑定提示保留）---- */
  const artRow = (a: PsoCacheFile) => (
    <div key={a.id ?? a.file_name} className="art-row">
      <span className="art-dot s-positive">
        <Icon name="check" size={12} />
      </span>
      <div className="art-meta">
        <div className="art-name mono">{a.file_name}</div>
        <div className="art-sub">
          {fmtBytes(a.size_bytes)}
          {" · GPU " + a.gpu_signature}
          {a.ue_version ? " · UE " + a.ue_version : ""}
          {a.collected_at ? " · " + a.collected_at : ""}
        </div>
      </div>
      <button className="mini-btn" onClick={() => distribute(a)}>
        <Icon name="download" size={12} />
        分发
      </button>
    </div>
  );

  return (
    <div className="res ddc">
      <div className="canvas-head">
        <span className="t">DDC · PSO 缓存</span>
        <div className="right" />
      </div>
      <div className="ddc-body">
        <div className="ddc-sec-h">
          <span>① 扫描 UE 工程</span>
          <span className="dim">discover_projects · 可按单台机器搜索 .uproject</span>
        </div>
        <div className="pak-scan">
          <div className="pak-scan-fields">
            <div className="dp-field">
              <label>扫描范围</label>
              <Selector
                kpre="范围"
                value={psoScope}
                options={scopeOpts}
                width={178}
                onChange={setPsoScope}
              />
            </div>
            <div className="dp-field grow">
              <label>搜索根目录</label>
              <input
                className="dp-input mono"
                value={psoRoots}
                spellCheck={false}
                onChange={(e) => setPsoRoots(e.target.value)}
              />
            </div>
            <Button
              variant="accent"
              size="M"
              icon={<Icon name="search" size={14} />}
              onPress={scanPso}
            >
              扫描
            </Button>
          </div>
          <div className="pak-scan-meta">
            <Icon name="check" size={12} />
            {projsAsync.loading
              ? "正在加载工程库…"
              : "已发现 " + projects.length + " 个工程"}
          </div>
        </div>

        <div className="ddc-sec-h">
          <span>② 选择工程</span>
          <span className="dim">
            {selPso ? "已选 · " + projTitle(selPso) : "选中后针对该工程收集 PSO 缓存"}
          </span>
        </div>
        <div className="proj-list">
          {projects.length > 0 ? (
            projects.map(projRow)
          ) : (
            <div className="gen-empty">
              <Icon name="film" size={22} />
              <span>
                {projsAsync.error
                  ? "暂无工程数据"
                  : "还没有已登记的 UE 工程，先在上方扫描"}
              </span>
            </div>
          )}
        </div>

        <div className="ddc-sec-h">
          <span>③ 收集 PSO 缓存</span>
          <span className="dim">start_pso_collection · 按源机 GPU 签名生成</span>
        </div>
        {selPso ? (
          <div className="gen-panel">
            <div className="gen-summary">
              <span className="gen-ico">
                <Icon name="layers" size={17} />
              </span>
              <div className="gen-sum-txt">
                <div className="gen-sum-t">
                  <span className="gen-sum-name">{projTitle(selPso)}</span>
                </div>
                <div className="gen-sum-d mono">{selPso.uproject_name}</div>
              </div>
              <span className="gen-sum-size">{selPso.location_count} 台</span>
            </div>
            <div className="gen-gpu">
              <Icon name="eye" size={13} />
              PSO 与 GPU 绑定，仅对相同 GPU 签名命中 · 当前源机 GPU{" "}
              <b>
                {srcGpu
                  ? srcGpu.gpu_model + "（" + srcGpu.vendor + "）"
                  : detailAsync.loading
                    ? "查询中…"
                    : "—"}
              </b>
            </div>
            <div className="gen-form">
              <div className="dp-field">
                <label>收集源机器</label>
                {psoSrcOpts.length > 0 ? (
                  <Selector
                    kpre="机器"
                    value={String(effSrc ?? "")}
                    options={psoSrcOpts}
                    width={208}
                    onChange={(id) => setPsoSrc(Number(id))}
                  />
                ) : (
                  <span className="dim" style={{ fontSize: 12 }}>
                    该工程暂无在线机器
                  </span>
                )}
              </div>
              <div className="dp-field">
                <label>渲染分辨率</label>
                <Selector
                  kpre="分辨率"
                  value={psoRes}
                  options={resOpts}
                  width={168}
                  onChange={setPsoRes}
                />
              </div>
              <div className="dp-field">
                <label>最长时长</label>
                <Selector
                  kpre="时长"
                  value={psoMax}
                  options={maxOpts}
                  width={138}
                  onChange={setPsoMax}
                />
              </div>
            </div>
            <div className="gen-foot">
              <div className="gen-foot-note">
                <Icon name="terminal" size={13} />
                UE -game 窗口化跑指定分辨率收集 PSO · 长任务，NDJSON 实时流进任务抽屉。
              </div>
              <Button
                variant="accent"
                size="M"
                icon={<Icon name="bolt" size={14} />}
                isDisabled={effSrc == null}
                onPress={collectPso}
              >
                收集 PSO 缓存
              </Button>
            </div>
          </div>
        ) : (
          <div className="gen-empty">
            <Icon name="film" size={22} />
            <span>先在上方选择一个工程，再收集对应的 PSO 缓存</span>
          </div>
        )}

        <div className="ddc-sec-h" style={{ marginTop: 22 }}>
          <span>已收集的 PSO 缓存</span>
          <span className="dim">
            {psoFiles.length} 个产物 · 可分发到同 GPU 机器
          </span>
        </div>
        <div className="art-list">
          {psoFiles.length > 0 ? (
            psoFiles.map(artRow)
          ) : (
            <div className="gen-empty">
              <Icon name="layers" size={22} />
              <span>
                {psoProj == null
                  ? "先选择工程查看其已收集的 PSO 缓存"
                  : filesAsync.loading
                    ? "正在加载已收集的 PSO 缓存…"
                    : "该工程还没有已收集的 PSO 缓存"}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
