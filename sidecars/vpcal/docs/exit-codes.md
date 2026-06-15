# Exit Codes

vpcal 的 exit code 体系遵循 [CLI_DESIGN_SPEC.md](../../docs/CLI_DESIGN_SPEC.md) §5，并在
[vpcal Phase 1 Implementation Spec](../../docs/vpcal_phase1_implementation_spec.md) §12 中具体化为本工具的场景。

所有 CLI 命令在退出时返回下表中的某一个 code。配合 `--output json` / `--output ndjson`
模式，进程退出码会与错误 envelope 中的 `error.exit_code` 字段保持一致（见 CLI_DESIGN_SPEC §4.2）。

## Exit Code 表

| Code | 语义 | vpcal 具体场景 |
|------|------|----------------|
| `0` | success | 校正成功完成；所有阶段（validate → detect → solve → report）正常结束并写出结果文件 |
| `1` | runtime error | solver 发散、未预期的内部异常、其他未分类的运行时错误 |
| `2` | argument error | session config 格式错误、缺少必要字段、CLI 参数语法错误、未知 flag |
| `3` | config error | 配置文件路径不存在、配置文件本身格式不合法（无法解析为 JSON/YAML/TOML） |
| `5` | resource not found | 图像目录 / tracking 文件 / screen 定义文件不存在 |
| `6` | precondition failed | pose 数 < 3、无可用 observation、image-tracking 帧对齐失败（匹配数 < 3）、lens 模型不支持（如提供了 k4/k5/k6 rational 系数） |
| `7` | timeout | solver 超过 `solver.timeout_seconds`（默认 300s）仍未收敛 |
| `9` | partial failure | solver 收敛但结果置信度低（总 observation < 50，标记为 low-confidence） |

## coarse vs fine-grained 语义

exit code 只承载**粗粒度**分类，用于 shell / CI / Agent 做快速分支判断。
**细粒度**的业务语义由错误 envelope 中的 `error.code` 字符串承载（CLI_DESIGN_SPEC §5）。

例如同一个 exit code `2`（argument error）下，`error.code` 可能是：

```json
{
  "schema_version": "1.0",
  "status": "error",
  "operation_id": "quick.run",
  "error": {
    "code": "ARG_VALIDATION",
    "exit_code": 2,
    "message": "session config missing required field 'screen.path'",
    "retryable": false,
    "details": { "field": "screen.path" }
  }
}
```

而 exit code `6`（precondition failed）下，`error.code` 可能是 `PRECONDITION_FAILED`，
配合 `details` 区分是 pose 数不足、帧对齐失败、还是 lens 模型不支持。

调用方应优先用 `exit_code` 做控制流分支，用 `error.code` 做精细化处理与提示。
两者始终一致：envelope 中的 `error.exit_code` 等于进程实际退出码。

## POSIX 保留与信号约定

- `126` / `127` 是 **POSIX 保留**码（命令无法执行 / 命令未找到），vpcal **绝不主动使用**。
- `128+N` 为信号约定：进程被信号 `N` 终止时退出码为 `128+N`。常见值：
  - `130` = `128+2`（SIGINT，Ctrl-C 中断）
  - `143` = `128+15`（SIGTERM）

  vpcal 在收到 SIGINT / SIGTERM 时执行优雅清理后以对应的 `128+N` 退出
  （CLI_DESIGN_SPEC §9 Cancellation）。

- code `4`（auth / permission error）和 `8`（external dependency failure）在
  CLI_DESIGN_SPEC §5 通用表中定义，但 Phase 1 vpcal 是纯离线计算工具、无认证与外部网络依赖，
  因此**不使用**这两个码。
