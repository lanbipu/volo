/* Volo — 镜头校正采集：项目内自动路径推导 + 图案自动生成的唯一前端入口。
   后端契约见 docs/calibrate/lens-capture-auto-paths-spec.md（§2 目录约定、§3 行为、
   §4 B1–B3）。**禁止**任何页面自行拼接 vpcal/ 下的路径——一律走 lensWorkspacePaths，
   对照 DEFAULT_NDISPLAY_OUTPUT_PATHS 共享常量的教训。

   路径拼接复用 meshVisualCommands.generatedPatternImagePath 的分隔符判断逻辑：
   Windows verbatim 路径（\\?\C:\...）拒绝用 `/` 拼接，必须按 projectPath 自身的
   分隔符拼。 */
import { call } from "./invoke";
import { exportVpcalScreen } from "./meshCommands";
import { spawnSidecarStreaming, listenSidecarStream } from "./sidecarStream";
import type { SidecarStreamLineEvent } from "./sidecarStream";

/* ----------------------------- 路径推导（纯函数） ----------------------------- */

export interface LensWorkspacePaths {
  /** `<project>/vpcal` */
  vpcalDir: string;
  /** `<project>/vpcal/<screenId>.screen.json`（export_vpcal_screen 默认路径） */
  screenJson: (screenId: string) => string;
  /** `<project>/vpcal/patterns/<screenId>` */
  patternsDir: (screenId: string) => string;
  /** `<project>/vpcal/captures`（采集会话根 = 原「输出目录」） */
  capturesDir: string;
  /** `<project>/vpcal/assignment.json` */
  assignmentPath: string;
  /** 只读展示用的项目内相对路径。 */
  relOutput: string;
}

export function lensWorkspacePaths(projectPath: string): LensWorkspacePaths {
  const sep = projectPath.includes("\\") ? "\\" : "/";
  const trim = (p: string) => p.replace(/[\\/]+$/, "");
  const join = (dir: string, name: string) => trim(dir) + sep + name;
  const vpcal = join(projectPath, "vpcal");
  return {
    vpcalDir: vpcal,
    screenJson: (screenId: string) => join(vpcal, `${screenId}.screen.json`),
    patternsDir: (screenId: string) => join(join(vpcal, "patterns"), screenId),
    capturesDir: join(vpcal, "captures"),
    assignmentPath: join(vpcal, "assignment.json"),
    relOutput: "vpcal/captures/",
  };
}

/* ------------------------------- B1–B3 invoke 包装 ------------------------------- */

export interface LensScreenAssign {
  code: number;
  offset: number;
  columns: number;
}
export interface LensAssignment {
  schema_version: string;
  screens: Record<string, LensScreenAssign>;
}
export interface LensPatternsMeta {
  schema_version: string;
  screen_fingerprint: string;
  screen_id_code: number;
  cab_col_offset: number;
  graycode_tags: boolean;
  generated_at: string;
  files: string[];
}
export interface LensPatternsMetaStatus {
  meta: LensPatternsMeta | null;
  files_present: boolean;
}

/** B1 — 创建 §2 目录骨架（幂等，项目打开/创建时预热）。 */
export const lensWorkspaceEnsure = (projectPath: string) =>
  call<void>("lens_workspace_ensure", { projectPath });

/** B3 — 从 project.yaml 重算并写 assignment.json，返回全表。 */
export const lensAssignmentSync = (projectPath: string) =>
  call<LensAssignment>("lens_assignment_sync", { projectPath });

/** B2（读）— meta.json + 引用 PNG 的磁盘存在性（供 §3.2 失效判定的「files 缺失」项）。 */
export const lensPatternsMetaRead = (projectPath: string, screenId: string) =>
  call<LensPatternsMetaStatus>("lens_patterns_meta_read", { projectPath, screenId });

/** B2（写）— 生成成功后落 meta.json。 */
export const lensPatternsMetaWrite = (
  projectPath: string,
  screenId: string,
  meta: LensPatternsMeta,
) => call<void>("lens_patterns_meta_write", { projectPath, screenId, meta });

/* --------------------------- ensureScreenPatterns（§3.2） --------------------------- */

export const LENS_PATTERNS_SCHEMA = "volo_lens_patterns.v1";

export interface EnsureResult {
  /** 新鲜 screen.json 路径（下游 session.start / lens-cal 的 screenPath 入参）。 */
  screenJson: string;
  /** export_vpcal_screen 返回的 fingerprint。 */
  fingerprint: string;
  /** 该屏图案目录（切图 / request_pattern 推图取用）。 */
  patternsDir: string;
  code: number;
  offset: number;
  /** 本次是否触发了重建（新鲜直接返回时为 false）。 */
  regenerated: boolean;
}

export interface EnsureError extends Error {
  /** 'export' —— screen.json 导出失败（含 normal_flip / irregular_mask / IO）；
   *  'pattern' —— 图案生成 / meta 落盘失败。用于把错误落到对应状态行。 */
  stage?: "export" | "pattern";
}

function tagStage(e: unknown, stage: "export" | "pattern"): EnsureError {
  const err: EnsureError =
    e instanceof Error ? e : new Error(String((e as { message?: string })?.message ?? e));
  err.stage = stage;
  return err;
}

/** 运行一次性 vpcal sidecar 到退出；非零退出 → reject（stderr_tail）。
 *  pattern generate 是秒级渲染任务，spawn 后再订阅足够（不会先于订阅退出）。 */
function runVpcalToCompletion(
  args: string[],
  onLine?: (ev: SidecarStreamLineEvent) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    void spawnSidecarStreaming("vpcal", args)
      .then(({ task_id }) => {
        let unlisten: (() => void) | null = null;
        void listenSidecarStream(task_id, (ev) => {
          if (ev.kind === "line") {
            onLine?.(ev);
            return;
          }
          unlisten?.();
          if (ev.fatal || (ev.exit_code != null && ev.exit_code !== 0)) {
            reject(new Error(ev.stderr_tail || `vpcal pattern generate exit ${ev.exit_code}`));
          } else {
            resolve();
          }
        }).then((fn) => {
          unlisten = fn;
        });
      })
      .catch(reject);
  });
}

/**
 * 确保某屏的 screen.json 与校正图案新鲜（§3.2）。内部顺序：
 *   1. export_vpcal_screen 取新鲜 screen.json + fingerprint（失败 → stage:export）；
 *   2. lens_assignment_sync 取该屏 {code, offset}；
 *   3. 读 meta.json + 文件存在性判定新鲜；新鲜（且非 force）直接返回；
 *   4. 失效 → vpcal pattern generate --graycode-tags → 等 exit → 写 meta.json。
 */
export async function ensureScreenPatterns(
  projectPath: string,
  screenId: string,
  opts: { force?: boolean; onGenerating?: () => void; onLine?: (ev: SidecarStreamLineEvent) => void } = {},
): Promise<EnsureResult> {
  let exp: { path: string; fingerprint: string };
  try {
    exp = await exportVpcalScreen(projectPath, screenId, null);
  } catch (e) {
    throw tagStage(e, "export");
  }

  const paths = lensWorkspacePaths(projectPath);
  const patternsDir = paths.patternsDir(screenId);

  let assignment: LensAssignment;
  try {
    assignment = await lensAssignmentSync(projectPath);
  } catch (e) {
    // 分配失败属于屏幕集合层面的问题（如 >16 屏）——落在屏幕定义行。
    throw tagStage(e, "export");
  }
  const a = assignment.screens[screenId] || { code: 0, offset: 0, columns: 0 };

  let fresh = false;
  try {
    const status = await lensPatternsMetaRead(projectPath, screenId);
    const m = status.meta;
    fresh =
      !!m &&
      m.screen_fingerprint === exp.fingerprint &&
      m.screen_id_code === a.code &&
      m.cab_col_offset === a.offset &&
      status.files_present;
  } catch {
    fresh = false;
  }

  if (fresh && !opts.force) {
    return { screenJson: exp.path, fingerprint: exp.fingerprint, patternsDir, code: a.code, offset: a.offset, regenerated: false };
  }

  opts.onGenerating?.();
  try {
    await runVpcalToCompletion(
      [
        "pattern", "generate",
        "--screen", exp.path,
        "--output-dir", patternsDir,
        "--screen-id", String(a.code),
        "--cab-col-offset", String(a.offset),
        "--graycode-tags",
        "--output", "json",
      ],
      opts.onLine,
    );
  } catch (e) {
    throw tagStage(e, "pattern");
  }

  const meta: LensPatternsMeta = {
    schema_version: LENS_PATTERNS_SCHEMA,
    screen_fingerprint: exp.fingerprint,
    screen_id_code: a.code,
    cab_col_offset: a.offset,
    graycode_tags: true,
    generated_at: new Date().toISOString(),
    files: ["normal.png", "inverted.png"],
  };
  try {
    await lensPatternsMetaWrite(projectPath, screenId, meta);
  } catch (e) {
    throw tagStage(e, "pattern");
  }

  return { screenJson: exp.path, fingerprint: exp.fingerprint, patternsDir, code: a.code, offset: a.offset, regenerated: true };
}
