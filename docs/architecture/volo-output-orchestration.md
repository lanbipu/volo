# Volo Output A-P2 编排契约

## 命令

Tauri 暴露以下命令，均以 `request` 作为唯一顶层参数。JS 调用形态固定为
`invoke(command, { request })`；`request` 内部字段保持 Rust/serde 的 snake_case。

1. `output_preflight`：逐节点验证 SSH、UE 5.8 与目录可写性。它不要求模板已部署；非 5.8 直接拒绝。UE 版本以 `Engine/Build/Build.version` JSON（Major/Minor/Patch）为准；exe 的 ProductVersion 是 `++UE5+Release-5.8-CL-...` 格式，不能做前缀比较。
2. `output_deploy`：把 bundle 内最小模板和由当前 topology 生成的 `.ndisplay` config 部署到全部节点。`renderSyncPolicy` 取自拓扑 `render_sync`（默认 `ethernet_barrier`）。
3. `output_start`：secondary-first、primary-last 启动；每节点必须在 UE log 中找到 DisplayCluster 连接/同步证据。
4. `output_show`：统一承载 `show` / `clear`；show 先推新 PNG 再原子切 manifest，clear 只原子切 manifest。**勿**用它播序列（`stage` 存在时会忽略 `image_path`）。
5. `output_stop`：按工程路径精确筛选并停止 UE 进程。
6. `output_play_sequence`：推送 v2 `mode=sequence` 帧目录 → 等 ready → 等 done；runner 阶段 `pushing` / `preloading` / `playing` / `done` / `failed`。详见 `docs/calibrate/ndisplay-sequence-playback-spec.md`。
7. `output_sequence_abort`：转发 clear 中止序列。

CLI：`voloctl output play-sequence` / `voloctl output abort`（同核）。

所有阻塞 SSH/SCP 工作均在 `spawn_blocking` 中执行。核心顺序与发布语义位于零 Tauri 依赖的 `mesh-app::output`；`src-tauri` 只负责 SSH transport 和 command DTO。

## DTO

```ts
type OutputMode = "show" | "clear";

interface RuntimePaths {
  editor_path: string;
  editor_paths?: Record<string, string>;
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
- `editor_paths`：可选的 node id → `UnrealEditor.exe` 映射；存在对应节点项时优先于兼容 fallback `editor_path`。
- `project_path`
- `config_path`
- `manifest_path`
- `image_dir`

模板工程来自 bundle resource `ue-template/VoloOutput`。`output_deploy` 写入 `project_path`
对应的工程根，并把生成的 config 写到 `config_path`。`output_start` 会再次硬检查模板、
config 和 Blueprint asset 已存在，避免绕过部署 gate。

前端在 preflight 时按拓扑节点的 hostname/IP 匹配机器库，读取该机器的 `machine_ue_installs`，选择 5.8（优先 primary install）并构造节点级 `editor_paths`。机器不存在或未探测到 5.8 时预检直接失败；硬编码 `editor_path` 只保留为旧调用方兼容 fallback。

一期只允许窗口模式：拓扑对话框保留但禁用 `fullscreen` 开关并提示“一期仅窗口模式”，保存时强制写 `false`；nDisplay 生成器也无条件输出 `fullScreen: false`。DTO 字段保留供后续版本启用。

## 启动不变量

启动参数固定包含：

```text
-game -messaging -dc_cluster -dc_dev_mono
-RemoteControlIsHeadless -RCWebControlEnable -ClusterForceApplyResponse
-NoScreenMessages
```

`-NoScreenMessages` 是 2026-07-17 真机加入的固定项：`dc_dev_mono` 使视图成为 stereo view，引擎（SceneRendering.cpp，非 SHIPPING 构建）会在左上角常驻 `StereoView: Primary / Stereo rendering method: Splitscreen-like` 调试字并上墙；与 Pixel Streaming 插件无关（模板未启用该插件，只是同一段 screen-debug 代码的不同触发者）。

节点侧启动必须经 Interactive-logon 计划任务落到交互桌面会话（`New-ScheduledTaskPrincipal -LogonType Interactive`，launcher 脚本再做 `SetWindowPos TOPMOST→NOTOPMOST + SetForegroundWindow` 把 UE 窗口置前）：SSH 网络登录直接 `Start-Process` 会落在 session 0，UE 创建 D3D12 设备时以 `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE` 秒崩且无 abslog。

`output_start` 在启动任何节点前，先用预留的新 revision 向全部节点发布一份 clear manifest：新 UE 进程 `LastRevision=-1`，会把上一会话残留的 show manifest 当新指令，启动即上屏旧图。

并按节点补齐 `-dc_cfg`、`-dc_node`、窗口尺寸与独立 `-abslog`。启动分两阶段：先按 secondary-first、primary-last 对全部节点执行 `launch`，校验进程没有立即退出；之后才逐节点执行 `wait_evidence`。不能在启动下一个节点前阻塞等当前节点证据，否则 secondary 会在等待 primary 时形成死锁。

`Start-Process` 返回 PID 不代表成功。成功主证据是 UE log 中的 `LogDisplayClusterGame:.*Create viewport manager`（GameStart barrier 通过后出现），旧的 cluster/network/barrier pattern 仅作备选。证据等待上限为 240 秒，覆盖 180 秒 GameStart barrier 和首次 shader 编译；超时错误必须包含节点 log 路径。

`launch` 会拒绝同一 `project_path` 已有 UnrealEditor 进程的重入，并提示先停止。preflight 会把主机上正在运行的 UE 进程以“进程名 + PID + 截断命令行摘要”追加为非阻塞警告。

## 发布不变量

- revision 在任何远端写之前预留；失败 revision 不复用。每个 session 的最新值持久化到 app config 的 `output-revisions.json`，并以 Unix 秒为下限，避免 App 重启后倒退。
- show 的远端文件名为 `frame-<revision>.png`，同一 session 不覆盖旧图片。
- 所有节点 PNG 推送完成之前，不允许替换任何 manifest。
- manifest 使用 UTF-8 无 BOM 写入 `<manifest>.tmp`，再由同卷 `Move-Item -Force` 原子覆盖。
- 每个节点收到一份顶层含 `image_path`、`crop_x/y/w/h` 的扁平 manifest；clear 只含 schema、revision、mode。
- manifest 发布仍按 secondary-first、primary-last 执行。
- crop 永远来自 `OutputNode.viewport_rect_px`，不允许 command 调用方另传一份漂移值。

## 兼容性结论

2026-07-17 已在 lanPC 用 UE 5.7.4 对模板副本执行 package load：退出码 1，明确报告
`Package EngineVersion: 5.8.0`，以及 FortniteMain、UE5-Main、UE5-Release、
FortniteRelease 四组 `Custom version is too new`。因此一期只支持 UE 5.8，preflight
硬拒绝非 5.8；不再把 5.7 列为待验证兼容版本。

Razer SSH 的网络阻塞已解除，但执行端必须从 Mac 使用带
`-o PubkeyAuthentication=no` 的指定 `sshpass` 命令；不得回退为多 key 公钥认证。

## 操作端 SSH 与路径注意（2026-07-17 真机结论）

- App 连节点用的是自己 keystore 的 `uecm_ed25519`（`AppData\Roaming\com.lanbipu.uecm`，默认用户 `uecm-svc`），不是操作者的个人 ssh key；其公钥必须进节点的 `C:\ProgramData\ssh\administrators_authorized_keys`。
- 节点必须先在机器库登记并「刷新」探测过 UE 安装，preflight 才能解析出节点级 editor 路径。
- Windows 上 `resource_dir()`/canonicalize 返回 `\\?\C:\...` verbatim 路径，scp 会把冒号当远端主机分隔符报 `Could not resolve hostname \\?\c`；transport 的 `push_file` 统一剥去该前缀。

## 二期待办（暂缓）

- 全屏输出：启用 `fullscreen` 开关，在全屏路径复验 dev_mono 水印与双线性 1:1。
- 采集闭环自动切图；首启 shader 编译耗时记录。
