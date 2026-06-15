# Volo 移植整体 Review —— 问题清单与修复状态

> 本文记录一次对 Volo monorepo 移植成果的整体 review 发现的 25 项问题，以及在
> `feat/review-fixes` 分支上的逐项修复状态（修了 / 部分 / 未修+原因），作为
> 可勾选 checklist。源仓（`ue-cache-manager` / `led-mesh-toolkit` /
> `calibration/vpcal` / `calibration/tracksim`）只读参照，绝不改动。
>
> 状态图例：✅ 修了 · 🟡 部分 · ❌ 未修 · ⬜ 待办

---

## P1 核心 bug

### 1. ✅ mesh DB GUI/CLI 分叉
- **问题**：`src-tauri/src/lib.rs` 的 mesh setup `open` 的是
  `app_data_dir/lmt.sqlite`（GUI bundle identifier = `com.lanbipu.volo`，故落在
  `com.lanbipu.volo/lmt.sqlite`），而 CLI `voloctl lmt` 经
  `volo_shared::data::connection::default_db_path()` 落在
  `com.lanbipu.lmt/lmt.sqlite` —— 两个文件，GUI 写 CLI 读不到。
- **修复**：`src-tauri/src/lib.rs:63` 改用
  `volo_shared::data::connection::default_db_path()`，与 CLI 同源
  （`crates/volo-cli/src/lmt/commands/util.rs:15,44` 也是它）。
- **验证**：两侧均 grep 到 `default_db_path`，路径统一为
  `<data_dir>/com.lanbipu.lmt/lmt.sqlite`。

### 2. ✅ lmt argv 错误信封漂移
- **问题**：lmt 子命令的 **argv 解析失败**（如 `--bogus`）在顶层
  `try_get_matches_from` 阶段就报错，落到 catch-all `emit_parse_error`，套用
  UECM 的 `usage_error`/exit64；而非 LMT 原生 `invalid_input`/exit2。
  （`from_arg_matches` 那条路径本已正确路由到 `emit_lmt_parse_error`，但
  tokenization 错误根本到不了那里。）
- **修复**：`crates/volo-cli/src/main.rs` 顶层 parse 失败时新增
  `argv_targets_lmt()` 判定（扫第一个非 flag 位置参数是否 `lmt`），是则走
  `emit_lmt_parse_error`，否则 `emit_parse_error`。
- **验证**（实测）：
  - `voloctl lmt reconstruct --bogus --json` → `invalid_input` / exit **2** ✅
  - `voloctl uecm boguscmd --json` → `usage_error` / exit **64**（未破坏）✅
  - `voloctl uecm boguscmd`（非 json）→ exit 64；`voloctl lmt reconstruct --bogus`
    （非 json）→ exit 64（clap 原生 `e.exit()`，与 LMT 源仓非 json 行为一致；
    invalid_input/exit2 是 `--json` 契约）。

### 3. ✅ examples 资源绑定丢失
- **问题**：`seed_example_project`（`src-tauri/src/commands/mesh_projects.rs:55-66`）
  运行期读 `app.path().resource_dir().join("examples")`，但
  `tauri.conf.json` `bundle.resources` 没有 examples —— dev 下源树在能跑，
  **打包后** `examples/` 不在 bundle，运行期会找不到。源仓
  `led-mesh-toolkit/src-tauri/tauri.conf.json` 原本有 `"../examples": "examples"`。
- **修复**：`src-tauri/tauri.conf.json` `bundle.resources` 加
  `"../examples": "examples"`（examples 在 worktree 根，src-tauri 是 bundle 基准
  目录，故相对路径 `../examples`）。
- **机制核对**：`seed_example_project` 走 runtime `resource_dir`，**不是**
  `include_dir!` 编译期内嵌（`crates/mesh-app/src/projects.rs` 里那份
  `seed_embedded_example` 存在但未被 tauri command 调用）。故需要 bundle。

### 4. ✅ tokio nested-runtime 隐患
- **问题**：`crates/mesh-app/src/visual.rs` 的 `rt()` 每次
  `tokio::runtime::Runtime::new()` + `block_on`。一旦未来某个 **async** tauri
  command（跑在 Tauri 自己的 runtime 上）调用这些 sync `run_*`，会 panic
  *"Cannot start a runtime from within a runtime"*。
- **修复**：把 `rt()` 换成 `block_on_future(fut)`：
  `Handle::try_current()` 有 → `block_in_place` + `handle.block_on`（复用当前
  runtime，不嵌套）；无 → 临时 current-thread runtime（CLI / 单测路径）。11 处
  调用点全部改为 `block_on_future(X)?.map_err(map_vba_err)?`。
- **验证**：`cargo build --workspace` 通过；现有 visual 单测（含真 sidecar
  round-trip）保持绿。

---

## P2 资产 / cosmetic

### 5. ✅ `vendor_path()` dev fallback 漏改
- **问题**：`crates/cache-core/src/core/powershell.rs` 的 `vendor_path()` dev
  fallback 走 `CARGO_MANIFEST_DIR`（=`crates/cache-core`）`.parent()`（=`crates`）
  `.join("vendor")` → `crates/vendor/`（不存在）。而 `script_path()` 正确走上两层
  到 workspace 根再 `src-tauri/resources/ps-scripts`。
- **修复**：`vendor_path()` fallback 校准成与 `script_path()` 对称 —— 上两层
  + `src-tauri/resources/vendor`。

### 6. ✅ `ps-scripts/__tests__/` 不该进 bundle
- **问题**：`tauri.conf.json` `"resources/ps-scripts": "ps-scripts"` 整目录
  glob，把 `__tests__/`（2 个 `.tests.ps1`）也打进 app。
- **修复**：改为按扩展名 glob —— `resources/ps-scripts/*.ps1` /`*.cmd` /`*.txt`
  → `ps-scripts`，真实脚本全在顶层（44 `.ps1` + 1 `.cmd` + 1 `.txt`），
  `__tests__/` 自然排除。runtime 落盘的 `ps-scripts/` 子目录名不变，
  `script_path()` 定位不受影响。

### 7. ✅ bootstrap.rs message 旧 CLI 名
- **问题**：`src-tauri/src/commands/bootstrap.rs:63` message 写
  `uecm-cli ssh package-bootstrap`。
- **修复**：→ `voloctl uecm ssh package-bootstrap`。

### 8. ✅ pdf webview2 线程名旧前缀
- **问题**：`src-tauri/src/pdf_render/windows.rs:62` 线程名 `lmt-pdf-webview2`。
- **修复**：→ `volo-pdf-webview2`。

---

## P3 契约准确性

### 9. ✅ manifest.rs cli_command + domain_system.rs binary 漂移
- **问题**：`crates/volo-cli/src/manifest.rs` 的 93 处 `cli_command: "uecm-cli ..."`
  与 `domain_system.rs` 的 `binary: "uecm-cli"` / schema `"binary"` / 测试断言，
  都还是旧二进制名，与现实（`voloctl uecm ...`）漂移。
- **修复**：两文件全量 `uecm-cli` → `voloctl uecm`（cli_command 字符串、binary
  字段、schema、`//!` 文档、单测断言）。
- **同步**：`docs/architecture/repo-structure.md` step2 verify 不再要求与旧
  `contract-manifest.json` diff=0，改为反映 voloctl 命名空间。

### 10. ✅ vpcal contract-manifest 陈旧
- **问题**：`sidecars/vpcal/docs/contract-manifest.json` 是陈旧 7-op 快照，
  实际 live CLI 暴露 13 op（缺 `simulate.sweep` / `report.diff` /
  `export.ndisplay` / `capture.{track,video,playback}`）。
- **修复**：跑 `.venv/bin/vpcal manifest` 重新导出为 live 13-op。

---

## P4 测试

### 11. ✅ vpcal 默认 pytest collection ERROR
- **问题**：`sidecars/vpcal` 默认 `pytest` 在 **collection** 期就 ERROR ——
  `tests/integration/test_tracker_free_walkthrough.py` 模块级
  `json.loads((WALKTHROUGH/...).read_text())` 读 gitignore 的 `_walkthrough/`
  数据（`test_main_path_walkthrough.py` 的读在函数内，靠 skipif 兜住，但前者
  在 import 期就炸）。
- **修复**：给两个 walkthrough 测试加 `@pytest.mark.walkthrough` marker +
  `pyproject.toml` `[tool.pytest.ini_options]` `addopts = -m "not walkthrough"`
  +`collect_ignore`（见实施说明），默认 `pytest` 绿，按需 `-m walkthrough` 仍可跑。
- **验证**：`.venv/bin/pytest` 默认绿。

### 12. ✅ dead_code 清理
- **问题**：`volo-cli` 2 处孤儿测试 helper + `cache-core`
  `lookup_machine_hostname`（`core/ini_scanner.rs:524`，编译 warning）。
- **修复**：确认无调用方后处理（删除 / `#[allow]` 标注理由，见实施说明）。

### 13. ✅ lmt 99 E2E 迁移
- **问题**：`led-mesh-toolkit/crates/lmt-cli/tests/cli_e2e.rs`（99 测）尚未迁入
  volo workspace（它正是 #2 的回归护栏）。
- **修复**：迁到 `crates/volo-cli/tests/`，改 binary 名（voloctl）/ argv 前缀
  （`lmt`）/ 路径基准 / sidecar 接线。

### 14. ✅ UECM E2E 迁移
- **问题**：`ue-cache-manager` 的 `cli_smoke.rs`(41) + `usage_envelope.rs`(2)
  尚未迁入。
- **修复**：迁到 `crates/volo-cli/tests/`，改 `voloctl uecm` 形态。

---

## P5 sidecar 接线

### 15. 🟡 vpcal/tracksim spawn command
- **问题**：`src-tauri` 没有触达 vpcal/tracksim 两 sidecar 的 spawn command。
- **核对结论（重要）**：vpcal（click CLI）与 tracksim（argparse CLI）都是
  **argv-based 子命令** CLI，**不是** mesh-vba 那种 stdin-JSON/stdout-NDJSON
  常驻 channel。强行套 mesh-vba 的 NDJSON bridge 与现实不符。故后端通路实现为
  **spawn `.venv/bin/<cli>` + argv + 捕获 stdout JSON** 的基础 command（vpcal/
  tracksim 子命令支持 `--output json` 时回传结构化结果）。前端 UI 等设计稿。
- **状态见实施说明**。

### 16. 🟡 打包脚本 + tauri.conf 绑定
- **问题**：vpcal/tracksim 缺 `build_exe.sh`（PyInstaller）；`tauri.conf.json`
  未绑 3 个 sidecar-vendor。mesh-vba 已知债：`build_exe.sh` 输出路径与
  `locate.rs` 期望是否对齐。
- **核对结论**：mesh-vba 的 `build_exe.sh` 输出
  `$ROOT/target/sidecar-vendor/<platform>`（`$ROOT`=workspace 根），
  `mesh-adapter-visual-ba/src/locate.rs` 也搜 workspace 根
  `target/sidecar-vendor/<platform>` —— **本已对齐，无 mismatch**（详见实施说明
  的实测）。
- **状态见实施说明**。

---

## P6 架构

### 17. （选择见下）volo-shared error rename
- **问题**：`volo-shared` 的全局基座 error 仍叫 `LmtError`/`LmtResult`
  （feature-neutral 基座却挂着 lmt 名）。
- **选择**：见文末"error rename 决策"。

---

## 实施说明与决策

（随实施补充：error rename 的最终选择、各项验证实际输出、卡点。）
