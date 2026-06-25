// Volo · Cache —— DDC · DDC PAK（移植自原型 cache_ddc.jsx 的 pakBody / scanProjects / genPak /
// projRow / selectPak / srcOpts / backendOpts / scopeOpts / distribute / artRow）。
// 接真命令：listProjects / listProjectLocations / discoverProjects / generateDdcPak /
// distributeDdcPak / verifyPakOutput；机器走 useMachines()。
// §4：每工程 size / hasPak / 版本警告 / UE 版本无后端字段 → 砍；路径改用 ProjectLocation；
//     「已生成的 DDC PAK」后端无 list 命令 → 渲染空态（提供「校验产物」按钮调 verifyPakOutput）。
import { useMemo, useState } from "react";
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
  listCredentials,
  discoverProjects,
  generateDdcPak,
  distributeDdcPak,
  verifyPakOutput,
} from "../../api/commands";
import type {
  ProjectSummary,
  ProjectLocation,
  CredentialRecord,
  Machine,
  BackendChoice,
} from "../../api/types";

const SCOPE_ALL = "all";
const projLabel = (p: ProjectSummary) => p.display_name ?? p.uproject_name;

/* ④ 校验产物结果（verify_pak_output → 路径 / 大小 / 是否存在）。srcId 记录校验所用的源机，
   分发时据此分发，避免校验后改了源机选择器导致「校验源」与「分发源」不一致。 */
interface PakVerify {
  exists: boolean;
  path: string;
  size: string;
  srcId: number;
}

export function DdcPak() {
  const cx = useCache();
  const { machines, byId } = useMachines();

  // ① 扫描范围 / 搜索根目录（原型 pakScope / pakRoots）
  const [pakScope, setPakScope] = useState<string>(SCOPE_ALL);
  const [pakRoots, setPakRoots] = useState("D:\\Projects;E:\\UEProjects");
  // ② 选中工程（原型 pakProj）/ ③ 生成源机器 + 后端（原型 pakSrc / pakBackend）
  const [pakProj, setPakProj] = useState<number | null>(null);
  const [pakSrc, setPakSrc] = useState<string>("");
  const [pakBackend, setPakBackend] = useState<BackendChoice>("remote");
  // ④ 校验结果：projId → {exists, path, size}
  const [pakVerify, setPakVerify] = useState<Record<number, PakVerify>>({});

  // 真命令取数：工程库 / 凭据
  const projectsQ = useAsync<ProjectSummary[]>(() => listProjects(), []);
  const credsQ = useAsync<CredentialRecord[]>(() => listCredentials(), []);
  const projects = projectsQ.data ?? [];
  // 选中工程后取它的位置（机器 / 路径）
  const locsQ = useAsync<ProjectLocation[]>(
    () => (pakProj == null ? Promise.resolve([]) : listProjectLocations(pakProj)),
    [pakProj],
  );
  const locations = locsQ.data ?? [];

  // 操作凭据别名（discover / generate / distribute 需要；取第一个凭据，无则不传）
  const opAlias = useMemo<string | undefined>(
    () => (credsQ.data && credsQ.data.length > 0 ? credsQ.data[0].alias : undefined),
    [credsQ.data],
  );

  const onlineMachines = machines.filter((m) => m.status !== "offline" && m.id != null);

  // 扫描范围下拉：全部在线机 + 每台在线机
  const scopeOpts: SelectorOption[] = [{ id: SCOPE_ALL, label: "全部在线机" }].concat(
    onlineMachines.map((m) => ({ id: String(m.id), label: m.hostname, sub: m.ip })),
  );

  // 后端：remote（ZenServer / 远程编）/ local（文件系统 / 本机编）—— BackendChoice
  const backendOpts: SelectorOption[] = [
    { id: "remote", label: "ZenServer 后端" },
    { id: "local", label: "文件系统后端" },
  ];

  // 选中工程 + 它的位置机器
  const selProj = projects.find((p) => p.id === pakProj) ?? null;
  const projMachines: Machine[] = locations
    .map((l) => byId(l.machine_id))
    .filter((m): m is Machine => !!m && m.status !== "offline");
  const srcOpts: SelectorOption[] = projMachines.map((m) => ({
    id: String(m.id),
    label: m.hostname,
    sub: m.ip,
  }));
  // 默认源机只取「在候选里（即在线）」的 primary location，否则退到第一个在线候选，否则空。
  // 不能直接用 primaryLoc.machine_id —— 它可能离线、不在 srcOpts 里，会让 genPak 对着离线机提交。
  const primaryLoc = locations[0] ?? null;
  const primaryInOpts =
    primaryLoc && srcOpts.some((o) => o.id === String(primaryLoc.machine_id))
      ? String(primaryLoc.machine_id)
      : "";
  const primarySrcId = primaryInOpts || srcOpts[0]?.id || "";
  // 生效源机：选中值仍在候选里才用，否则回退 primary —— 避免选择器重筛后显示态与提交 id 脱节。
  const effSrcId = pakSrc && srcOpts.some((o) => o.id === pakSrc) ? pakSrc : primarySrcId;

  // ---- ① 扫描 UE 工程：discover_projects（远程扫 .uproject，只发现不写盘）----
  const scanProjects = () => {
    const roots = pakRoots
      .split(";")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
    const targets =
      pakScope === SCOPE_ALL
        ? onlineMachines
        : machines.filter((m) => m.id != null && String(m.id) === pakScope);
    const targetLabel =
      pakScope === SCOPE_ALL ? "全部在线机" : targets[0]?.hostname ?? pakScope;
    cx.runTask({
      domain: "project",
      action: "discover",
      target: targetLabel,
      note: "远程扫描 UE 工程（.uproject）",
      lines: [
        {
          msg:
            "discover_projects --scope " +
            (pakScope === SCOPE_ALL ? "online" : targetLabel) +
            ' --roots "' +
            pakRoots +
            '"',
        },
        { lv: "ok", msg: "扫描完成，已对齐项目身份" },
      ],
      run: async (ctx) => {
        for (const m of targets) {
          if (m.id == null) continue;
          ctx.log({ lv: "info", cat: "project", msg: `discover ${m.hostname} …` });
          await discoverProjects(m.id, roots, opAlias);
        }
        projectsQ.reload();
      },
    });
  };

  // ② 选中工程：记录工程 + 默认源机器
  const selectPak = (p: ProjectSummary) => {
    setPakProj(p.id);
    setPakSrc("");
  };

  // ③ 生成 DDC PAK：generate_ddc_pak（长任务，返回 job_id；存入 task.jobId 以便取消）
  const genPak = () => {
    if (!selProj) return;
    const srcId = Number(effSrcId);
    if (!Number.isFinite(srcId) || srcId <= 0) return;
    const srcMachine = byId(srcId);
    cx.runTask({
      domain: "ddc",
      action: "generate",
      target: projLabel(selProj),
      note: "生成 DDC PAK · " + projLabel(selProj) + "（长任务）",
      job: true,
      lines: [
        {
          msg:
            "generate_ddc_pak --project " +
            projLabel(selProj) +
            " --src " +
            (srcMachine?.hostname ?? srcId) +
            " --backend " +
            pakBackend,
        },
        { msg: "载入 .uproject · 编译 shader …" },
        { lv: "ok", msg: "DDC PAK 生成完成" },
      ],
      run: async (ctx) => {
        const res = await generateDdcPak({
          backend: pakBackend,
          sourceMachineId: srcId,
          projectId: selProj.id,
          operatorCredentialAlias: opAlias,
        });
        ctx.update({ jobId: res.job_id });
        ctx.log({
          lv: "info",
          cat: "ddc",
          msg: "job " + res.job_id + " · backend " + res.backend,
        });
      },
    });
  };

  // 产物分发：distribute_ddc_pak（源机由调用方传入——校验卡传校验过的源，避免源机不一致）
  const distribute = (srcId: number) => {
    if (!selProj) return;
    const targetIds = onlineMachines
      .filter((m) => m.id != null && m.id !== srcId)
      .map((m) => m.id!) as number[];
    cx.openPreview({
      title: "分发 · " + projLabel(selProj),
      icon: "download",
      cli: "ddc distribute",
      destructive: false,
      confirmLabel: "分发",
      steps: [
        "把这份 DDC PAK 复制分发到各台渲染机",
        "只传缺少的部分，已经有的自动跳过",
      ],
      scope: targetIds,
      task: {
        domain: "ddc",
        action: "distribute",
        target: projLabel(selProj),
        note: "分发完成",
        lines: [
          { msg: "ddc distribute " + projLabel(selProj) },
          { msg: "Robocopy 增量同步 …" },
          { lv: "ok", msg: "分发完成至目标机" },
        ],
        job: true,
        // 用确认浮层最终勾选范围（ctx.scope）做目标，未改动则用默认在线机集。
        run: async (ctx) => {
          const res = await distributeDdcPak({
            sourceMachineId: srcId,
            projectId: selProj.id,
            targetMachineIds: ctx.scope.length ? ctx.scope : targetIds,
            operatorCredentialAlias: opAlias,
          });
          ctx.update({ jobId: res.job_id });
        },
      },
    });
  };

  // ④ 校验该工程产物：verify_pak_output（只校验单个工程的产物，不列举全部）。
  // PakOutput 无 exists 标志 → 成功返回视为「产物存在」，命令抛错视为「未找到」。
  const verifyPak = (p: ProjectSummary) => {
    const srcId = Number(effSrcId);
    if (!Number.isFinite(srcId) || srcId <= 0) return;
    const srcMachine = byId(srcId);
    cx.runTask({
      domain: "ddc",
      action: "verify",
      target: projLabel(p),
      note: "校验 DDC PAK 产物 · " + projLabel(p),
      lines: [
        {
          msg: "verify_pak_output --machine " + (srcMachine?.hostname ?? srcId) + " --project " + projLabel(p),
        },
      ],
      run: async (ctx) => {
        try {
          const out = await verifyPakOutput(srcId, p.id, opAlias);
          setPakVerify((m) => ({ ...m, [p.id]: { exists: true, path: out.path, size: fmtBytes(out.size_bytes), srcId } }));
          ctx.log({ lv: "ok", cat: "ddc", msg: "产物存在 · " + out.path + " · " + fmtBytes(out.size_bytes) });
        } catch {
          setPakVerify((m) => ({ ...m, [p.id]: { exists: false, path: "—（源机上未找到）", size: "—", srcId } }));
          ctx.log({ lv: "warn", cat: "ddc", msg: "未找到产物 · 该工程尚未生成 PAK" });
        }
      },
    });
  };

  // ④ 校验状态卡：摘要 + 校验按钮 + 校验结果（路径 / 大小 / 是否存在 + 分发）。
  const pakStatusCard = (p: ProjectSummary) => {
    const v = pakVerify[p.id];
    // 已校验则展示校验时用的源机，未校验展示当前选择器的源机
    const cardSrcId = v ? v.srcId : Number(effSrcId);
    const srcHost = byId(cardSrcId)?.hostname ?? String(cardSrcId);
    return (
      <div className="gen-panel">
        <div className="gen-summary">
          <span className="gen-ico">
            <Icon name="cache" size={17} />
          </span>
          <div className="gen-sum-txt">
            <div className="gen-sum-t">
              <span className="gen-sum-name">{projLabel(p)}</span>
            </div>
            <div className="gen-sum-d mono">{"校验源 · " + srcHost}</div>
          </div>
          <Button
            variant="secondary"
            size="M"
            icon={<Icon name="search" size={14} />}
            onPress={() => verifyPak(p)}
          >
            {v ? "重新校验" : "校验产物"}
          </Button>
        </div>
        {v ? (
          <div className={"pak-verify" + (v.exists ? " ok" : " miss")}>
            <div className="pak-verify-h">
              <span className={"pv-ico s-" + (v.exists ? "positive" : "notice")}>
                <Icon name={v.exists ? "check" : "alert"} size={14} />
              </span>
              <span className="pv-state">{v.exists ? "产物存在" : "未找到产物"}</span>
            </div>
            <div className="pak-verify-kv">
              <div className="pvk">
                <span className="k">路径</span>
                <span className="v mono">{v.path}</span>
              </div>
              <div className="pvk">
                <span className="k">大小</span>
                <span className="v">{v.size}</span>
              </div>
              <div className="pvk">
                <span className="k">是否存在</span>
                <span className={"v s-" + (v.exists ? "positive" : "notice")}>
                  {v.exists ? "是" : "否"}
                </span>
              </div>
            </div>
            {v.exists ? (
              <div className="pak-verify-act">
                <Button
                  variant="accent"
                  size="M"
                  icon={<Icon name="download" size={14} />}
                  onPress={() => distribute(v.srcId)}
                >
                  分发到渲染机
                </Button>
              </div>
            ) : (
              <div className="pak-verify-note">
                <Icon name="eye" size={12} />
                该工程在源机上尚无 PAK 产物，先在上方③生成。
              </div>
            )}
          </div>
        ) : (
          <div className="pak-verify-hint">
            <Icon name="eye" size={13} />
            点「校验产物」检查该工程在源机上的 PAK 是否存在（路径 / 大小 / 是否存在）。
          </div>
        )}
      </div>
    );
  };

  // proj-row：§4 砍掉 size / hasPak / 版本警告 / UE 版本标签（ProjectSummary 无这些字段）。
  // 名称用 display_name || uproject_name；路径用工程身份 .uproject 名；台数用 location_count。
  const projRow = (p: ProjectSummary) => {
    const on = p.id === pakProj;
    return (
      <div key={p.id} className={"proj-row" + (on ? " on" : "")} onClick={() => selectPak(p)}>
        <span className={"proj-mck" + (on ? " on" : "")}>
          {on ? <Icon name="check" size={12} /> : null}
        </span>
        <span className="proj-ico">
          <Icon name="film" size={17} />
        </span>
        <div className="proj-main">
          <div className="proj-name">{projLabel(p)}</div>
          <div className="proj-sub">{p.uproject_name}</div>
        </div>
        <div className="proj-tags">
          <span className="proj-tag">{p.location_count} 台</span>
        </div>
      </div>
    );
  };

  const projLoading = projectsQ.loading;
  const projError = projectsQ.error;

  return (
    <div className="res ddc">
      <div className="canvas-head">
        <span className="t">DDC · DDC PAK</span>
        <div className="right" />
      </div>
      <div className="ddc-body">
        {/* ① 扫描 UE 工程 */}
        <div className="ddc-sec-h">
          <span>① 扫描 UE 工程</span>
          <span className="dim">discover_projects · 远程扫 .uproject，只发现不写盘</span>
        </div>
        <div className="pak-scan">
          <div className="pak-scan-fields">
            <div className="dp-field">
              <label>扫描范围</label>
              <Selector
                kpre="范围"
                value={pakScope}
                options={scopeOpts}
                width={178}
                onChange={setPakScope}
              />
            </div>
            <div className="dp-field grow">
              <label>搜索根目录</label>
              <input
                className="dp-input mono"
                value={pakRoots}
                spellCheck={false}
                onChange={(e) => setPakRoots(e.target.value)}
              />
            </div>
            <Button
              variant="accent"
              size="M"
              icon={<Icon name="search" size={14} />}
              onPress={scanProjects}
            >
              扫描
            </Button>
          </div>
          <div className="pak-scan-meta">
            <Icon name="check" size={12} />
            {projLoading
              ? "正在加载工程库 …"
              : projError
                ? "工程库暂不可用 · 点击「扫描」远程发现 .uproject"
                : `已登记 ${projects.length} 个工程`}
          </div>
        </div>

        {/* ② 选择工程 */}
        <div className="ddc-sec-h">
          <span>② 选择工程</span>
          <span className="dim">
            {selProj ? "已选 · " + projLabel(selProj) : "选中后针对该工程生成 DDC PAK"}
          </span>
        </div>
        {projects.length > 0 ? (
          <div className="proj-list">{projects.map(projRow)}</div>
        ) : (
          <div className="gen-empty">
            <Icon name="film" size={22} />
            <span>
              {projLoading ? "加载中 …" : "还没有登记的 UE 工程 · 先在上方扫描发现 .uproject"}
            </span>
          </div>
        )}

        {/* ③ 生成 DDC PAK */}
        <div className="ddc-sec-h">
          <span>③ 生成 DDC PAK</span>
          <span className="dim">generate_ddc_pak · GPU 不匹配 preflight 后台自动比对</span>
        </div>
        {selProj ? (
          <div className="gen-panel">
            <div className="gen-summary">
              <span className="gen-ico">
                <Icon name="cache" size={17} />
              </span>
              <div className="gen-sum-txt">
                <div className="gen-sum-t">
                  <span className="gen-sum-name">{projLabel(selProj)}</span>
                </div>
                <div className="gen-sum-d mono">
                  {primaryLoc ? primaryLoc.uproject_path : selProj.uproject_name}
                </div>
              </div>
              <span className="gen-sum-size">{selProj.location_count} 台</span>
            </div>
            <div className="gen-form">
              <div className="dp-field">
                <label>生成源机器</label>
                <Selector
                  kpre="机器"
                  value={effSrcId}
                  options={srcOpts}
                  width={220}
                  onChange={setPakSrc}
                />
              </div>
              <div className="dp-field">
                <label>后端</label>
                <Selector
                  kpre="后端"
                  value={pakBackend}
                  options={backendOpts}
                  width={178}
                  onChange={(id) => setPakBackend(id as BackendChoice)}
                />
              </div>
            </div>
            <div className="gen-foot">
              <div className="gen-foot-note">
                <Icon name="shield" size={13} />
                在源机器上载入 .uproject 编译 shader 生成 PAK · 长任务，进度进任务抽屉；Zen
                可达时同时灌入共享上游。
              </div>
              <Button
                variant="accent"
                size="M"
                icon={<Icon name="bolt" size={14} />}
                onPress={genPak}
              >
                生成 DDC PAK
              </Button>
            </div>
          </div>
        ) : (
          <div className="gen-empty">
            <Icon name="film" size={22} />
            <span>先在上方选择一个工程，再生成对应的 DDC PAK</span>
          </div>
        )}

        {/* ④ 校验该工程产物 —— verify_pak_output：校验选中工程的单个产物，不列举全部 */}
        <div className="ddc-sec-h" style={{ marginTop: 22 }}>
          <span>④ 校验该工程产物</span>
          <span className="dim">verify_pak_output · 校验选中工程的单个产物，不列举全部</span>
        </div>
        {selProj ? (
          pakStatusCard(selProj)
        ) : (
          <div className="gen-empty">
            <Icon name="cache" size={22} />
            <span>先在上方选择一个工程，再校验它的 PAK 产物</span>
          </div>
        )}
      </div>
    </div>
  );
}
