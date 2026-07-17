# Volo Output A-P2 编排契约

## 命令边界

Tauri 暴露五个命令，均以 `request` 作为唯一顶层参数：

1. `output_preflight`：逐节点验证 UE、模板工程与 nDisplay config，创建 manifest/图片目录。
2. `output_start`：secondary-first、primary-last 启动；每节点必须在 UE log 中找到 DisplayCluster 连接/同步证据。
3. `output_stop`：按工程路径精确筛选并停止 UE 进程。
4. `output_show`：为 session 预留单调 revision，以新文件名推送 PNG，全部成功后再逐节点原子替换 manifest。
5. `output_clear`：为 session 预留单调 revision，原子发布 `mode:"clear"` manifest。

所有阻塞 SSH/SCP 工作均在 `spawn_blocking` 中执行。核心顺序与发布语义位于零 Tauri 依赖的 `mesh-app::output`；`src-tauri` 只负责 SSH transport 和 command DTO。

## 请求路径

`RuntimePaths` 中的路径均为节点 Windows 绝对路径：

- `editor_path`
- `project_path`
- `config_path`
- `manifest_path`
- `image_dir`

模板工程来自 bundle resource `ue-template/VoloOutput`。当前五命令契约把模板/config 的安装视为调用前的部署步骤；`output_preflight` 会硬检查它们已存在，缺失即拒绝启动。

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
