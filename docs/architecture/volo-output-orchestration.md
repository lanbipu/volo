# Volo Output A-P2 编排契约

## 五个命令

Tauri 暴露以下五个命令，均以 `request` 作为唯一顶层参数。JS 调用形态固定为
`invoke(command, { request })`；`request` 内部字段保持 Rust/serde 的 snake_case。

1. `output_preflight`：逐节点验证 SSH、UE 版本与目录可写性。它不要求模板已部署。
2. `output_deploy`：把 bundle 内最小模板和由当前 topology 生成的 `.ndisplay` config 部署到全部节点。
3. `output_start`：secondary-first、primary-last 启动；每节点必须在 UE log 中找到 DisplayCluster 连接/同步证据。
4. `output_show`：统一承载 `show` / `clear`；show 先推新 PNG 再原子切 manifest，clear 只原子切 manifest。
5. `output_stop`：按工程路径精确筛选并停止 UE 进程。

所有阻塞 SSH/SCP 工作均在 `spawn_blocking` 中执行。核心顺序与发布语义位于零 Tauri 依赖的 `mesh-app::output`；`src-tauri` 只负责 SSH transport 和 command DTO。

## DTO

```ts
type OutputMode = "show" | "clear";

interface RuntimePaths {
  editor_path: string;
  project_path: string;
  config_path: string;
  manifest_path: string;
  image_dir: string;
}

interface RuntimeRequest {
  session_id: string;
  screen: ScreenConfig;
  paths: RuntimePaths;
  ssh_user?: string | null;
}

interface DeployRequest extends RuntimeRequest {
  ue_version: string;
}

interface ShowRequest extends RuntimeRequest {
  mode: OutputMode;
  image_path?: string | null; // mode=show 必填；mode=clear 必须为空
}

interface OutputNodeResult {
  node_id: string;
  host: string;
  message: string;
}

interface OutputCommandResult {
  session_id: string;
  operation: "preflight" | "deploy" | "start" | "show" | "clear" | "stop";
  revision?: number | null;
  remote_image_path?: string | null;
  nodes: OutputNodeResult[];
}
```

五个命令都返回 `OutputCommandResult`。失败沿现有 `call()` 约定 reject，不把错误伪装成
`ok:false` 的成功返回。`screen.output_topology` 缺失或 topology validation 存在 error 时，
preflight/deploy/start/show/stop 都拒绝执行。

## 事件

```ts
type OutputOperation = "preflight" | "deploy" | "start" | "show" | "clear" | "stop";
type OutputEventState = "queued" | "running" | "ok" | "error";

interface NDisplayOutputEvent {
  session_id: string;
  operation: OutputOperation;
  node_id: string;
  host: string;
  state: OutputEventState;
  message: string;
  revision?: number | null;
  timestamp_ms: number;
}

interface NDisplayOutputRunnerEvent {
  session_id: string;
  operation: OutputOperation;
  state: "running" | "ok" | "error";
  completed: number;
  total: number;
  message: string;
  revision?: number | null;
  timestamp_ms: number;
}
```

- `ndisplay-output-event`：节点状态 pill 和节点日志的数据源。
- `ndisplay-output-runner`：按钮流程锁、总进度和失败回执的数据源。
- 每条事件必须含 `session_id`，前端只消费当前 screen session。
- runner 先发 `running`，最终只发一个 `ok` 或 `error`。节点完成后各发一条 `ok`；
  无法归属具体节点的错误只发 runner `error`。

## 请求路径

`RuntimePaths` 中的路径均为节点 Windows 绝对路径：

- `editor_path`
- `project_path`
- `config_path`
- `manifest_path`
- `image_dir`

模板工程来自 bundle resource `ue-template/VoloOutput`。`output_deploy` 写入 `project_path`
对应的工程根，并把生成的 config 写到 `config_path`。`output_start` 会再次硬检查模板、
config 和 Blueprint asset 已存在，避免绕过部署 gate。

## 启动不变量

启动参数固定包含：

```text
-game -messaging -dc_cluster -dc_dev_mono
-RemoteControlIsHeadless -RCWebControlEnable -ClusterForceApplyResponse
```

并按节点补齐 `-dc_cfg`、`-dc_node`、窗口尺寸与独立 `-abslog`。`Start-Process` 返回 PID 不代表成功；60 秒内没有 `LogDisplayClusterCluster` / `LogDisplayClusterNetwork` 的连接、同步或 barrier 激活证据，命令必须失败。

## 发布不变量

- revision 在任何远端写之前预留；失败 revision 不复用。每个 session 的最新值持久化到 app config 的 `output-revisions.json`，并以 Unix 秒为下限，避免 App 重启后倒退。
- show 的远端文件名为 `frame-<revision>.png`，同一 session 不覆盖旧图片。
- 所有节点 PNG 推送完成之前，不允许替换任何 manifest。
- manifest 使用 UTF-8 无 BOM 写入 `<manifest>.tmp`，再由同卷 `Move-Item -Force` 原子覆盖。
- manifest 发布仍按 secondary-first、primary-last 执行。
- crop 永远来自 `OutputNode.viewport_rect_px`，不允许 command 调用方另传一份漂移值。

## 已知待复验项

Razer SSH 恢复后执行双机连接证据模式复验及 UE 5.7 兼容验证。若确认 UE 5.8 保存的 `uasset` 无法由 5.7 加载，则把 preflight 从“报告版本”收紧为“拒绝非 5.8”，并同步更新模板支持声明。
