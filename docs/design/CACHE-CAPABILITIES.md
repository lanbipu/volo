# Cache 页 · 后端能力清单（GUI 命令 + DTO 契约）

> **这是什么**：Volo 后端**已注册、已验证**的 Tauri 命令与数据契约——Cache 页 `.tsx` 落地时真正能 `invoke()` 的命令、它们的参数、以及返回数据里**真实存在的字段**。来源：`src-tauri/src/commands/*.rs`（已接入 `lib.rs` invoke_handler）+ `crates/cache-core` 的 DTO，逐文件 grep 实测（2026-06-15）。
>
> **和其它设计文档的分工**：
> - `WIREFRAMES.md §1` —— 视觉结构（哪块放什么组件、字段名、组件名）。
> - `CACHE-UX.md` —— 操作真相（能做什么、按什么顺序、状态模型、护栏）。
> - **本文** —— **能力边界**（数据/动作到底有没有、字段到底有哪些）。前两者是"该长什么样/怎么用"，本文是"后端到底给不给得了"。
>
> **唯一的使用规则**：**在本清单的边界内自由设计。任何设计想要、但本清单里没有的数据或动作，必须当场标红** —— 要么砍掉，要么有意识地记为「需新增后端命令」。这一条就是防"UI 承诺了后端兑现不了的东西"的落地事故。
>
> ⚠️ 字段是最容易踩坑的地方：原型 `page_cache.jsx` 里假设的 `ddc%`、`pso%`、`vram`、`vendor`、per-node `channel`、`zen/share/proj` 反向链接，**经实测都不是 DTO 字段**（见 §4）。

---

## 1. 可显示的数据（实体 + 真实字段）

只列**确实存在**的字段。字段名即 DTO 字段（serde 序列化后前端拿到的 key）。

| 实体 | 真实字段（实测） | 来源命令 |
|---|---|---|
| **Machine** | `id` · `hostname` · `ip` · `role`(`host`\|`render`\|`dev`\|`editor`\|`unknown`) · `status`(`online`\|`offline`\|`unknown`) · `last_seen_at` | `list_machines` |
| **MachineDetail** | `machine`(上行) + `ue_installs[]` + `gpus[]` | `get_machine_detail(id)` |
| **UeInstall** | `Version` · `Path` | （随 MachineDetail） |
| **GpuInfo** | `Name` · `Driver` · `DriverDate`（**无 vram / vendor**） | （随 MachineDetail）/ `machine_gpus` |
| **CredentialRecord** | `id` · `alias`(如 `UECM:winrm:RENDER-01`) · `kind` · `username`（**不含明文密码**） | `list_credentials` |
| **GpuMatrix** | `signatures[]`(GPU 签名计数) · `baseline`(可空) · `cells[]`(每机 GPU 单元) | `get_gpu_consistency_matrix` |
| **健康检查结果** | `HealthCheckRow[]`（L1/L2/L3 项，含 remediation；字段细节见 `health_check_runs.rs`） | `run_health_check` → `list_health_results_for_run(scan_run_id)` |
| **巡检/扫描历史** | `ScanRun[]`（run 元数据） | `list_recent_health_runs` · `list_recent_ini_runs` · `list_scan_runs` |
| **INI findings** | `IniFinding[]`（扫出的配置问题 + diff） | `list_findings(scan_run_id)` · `get_finding(id)` |
| **共享 DDC** | `ShareConfig[]` | `list_shares` |
| **项目** | `ProjectSummary[]` · `ProjectLocation[]` | `list_projects` · `list_project_locations(project_id)` |
| **PSO 缓存文件** | `PsoCacheFile[]` | `list_pso_cache_files(project_id, source_machine_id?, gpu_signature?)` |
| **Zen 状态** | `ZenStatusRow[]`(按 machine) · 缓存命中统计 · 端点列表 | `zen_status(machine_id?)` · `zen_cache_stats(...)` · `zen_list_endpoints(...)` |
| **Zen 基线** | baseline 列表 | `zen_baseline_list(...)` |

---

## 2. 可触发的动作（命令 + 关键参数）

标签：🔴 破坏性（写远端/删除，需二次确认）· ⏳ 长任务（进任务抽屉，有进度、可 `cancel_ue_job` 取消）· 👁 dry-run 预览（不执行，只返回计划）。

### 机器 / 节点纳管
| 命令 | 关键参数 | 标签 |
|---|---|---|
| `scan_network` | `cidr` | ⏳(async) |
| `add_machine` / `add_discovered_machine` | `hostname, ip` / `ip, hostname?` | |
| `refresh_machine` | `machine_id` | 重探 UE/GPU/last-seen |
| `rename_machine` | `id, hostname` | |
| `delete_machine` | `id` | 🔴 |
| `get_winrm_bootstrap_script` | — | 取脚本文本 |
| `bootstrap_winrm` | `machine_id, credential_alias, enable_local_account_remote_admin` | 🔴 远端配置 |

### 凭据
| 命令 | 关键参数 | 标签 |
|---|---|---|
| `list_credentials` | — | |
| `save_credential` | `alias, kind, username, password` | 🔴 写 SecretStore |
| `delete_credential` | `alias` | 🔴 |

### 环境变量 / INI 编辑（远端写配置）
| 命令 | 关键参数 | 标签 |
|---|---|---|
| `get_machine_env_var` / `_with_credential` | `machine_id, name[, credential_alias]` | |
| `set_machine_env_var` / `_with_credential` | `machine_id, name, value[, credential_alias]` | 🔴 |
| `batch_set_env_var` | `machine_ids[], name, value, credential_alias` | 🔴 ⏳ 批量 |
| `read_ini_section` / `_with_credential` | `machine_id, file_path, section[, credential_alias]` | |
| `set_ini_key` / `_with_credential` | `machine_id, file_path, section, name, value[, credential_alias]` | 🔴 |
| `batch_set_ini_key` | `machine_ids[], file_path, section, name, value, credential_alias` | 🔴 ⏳ 批量 |

### INI 扫描 / 修复
| 命令 | 关键参数 | 标签 |
|---|---|---|
| `scan_inis` | `request{machine_ids[], project_paths, user_profile_path?, credential_alias?}` | |
| `list_findings` / `list_findings_for_run` / `get_finding` | `scan_run_id` / `finding_id` | |
| `apply_finding` | `finding_id, credential_alias` | 🔴 写远端 INI（自动备份） |
| `skip_finding` | `finding_id` | |
| `verify_pso_precaching` | `request{...}`（project_paths 必填） | |

> **新增提醒规则 R027 / R028（缓存留存默认探测）**：扫描会在「缓存跑在默认过期策略上」时产出 `Info` 级 `IniFinding`（提醒，非问题）。
> - **R027（FileSystem）**：项目显式声明了 `[DerivedDataBackendGraph] Shared` 节点，但 `DeleteUnused` 未关、`UnusedFileAge` 缺失或 ≤30 天 → 提醒可设为项目期常驻。
> - **R028（Zen）**：项目显式配置了 `[Zen.AutoLaunch]`，但 `ExtraArgs` 的 `--gc-cache-duration-seconds` 缺失或 ≤30 天 → 同。
> - 两者 `recommended_action=manual`（**不走 `apply_finding` 自动修**，避免与 R015「DeleteUnused=true」矛盾）；真正的写操作走下面的 GC 开关命令。
> - **已知盲区**：只看「显式声明」。纯继承引擎默认（项目里没有 Shared 节点 / 没有 `[Zen.AutoLaunch]`）的情况**不报**——要全 BaseEngine→Default→User 配置合并才能判，本期不做。

### DDC 留存 / GC 开关（"缓存永不过期 ↔ 恢复默认"）
> 字段以 UE 源码实测为准：FileSystem 的留存字段是 **`UnusedFileAge`**（非 `DaysToKeep`；引擎默认 15 天、BaseEngine `Shared` 出厂 10），GC 总开关是 **`DeleteUnused`**（默认 `true`）；Zen 没有 `DeleteUnused`，留存靠 `[Zen.AutoLaunch] ExtraArgs` 的 **`--gc-cache-duration-seconds`**（默认 1209600 秒 = 14 天）。"永不过期" = FS 停 GC（`DeleteUnused=false`）/ Zen 把秒数设到约 100 年。均写**项目 `DefaultEngine.ini`**。

| 命令 | 关键参数 | 标签 |
|---|---|---|
| `gc_pause` | `machine_id, project_id` | 🔴 FS 停 GC（`DeleteUnused=false`） |
| `gc_resume` | `machine_id, project_id, unused_file_age`(天) | 🔴 FS 恢复 GC（`DeleteUnused=true` + 回填 `UnusedFileAge`，默认 10） |
| `zen_gc_pause` | `machine_id, project_id` | 🔴 Zen 设 `--gc-cache-duration-seconds` ≈100 年 |
| `zen_gc_resume` | `machine_id, project_id, gc_seconds` | 🔴 Zen 恢复留存窗口（默认 1209600 = 14 天） |

### 共享 DDC
| 命令 | 关键参数 | 标签 |
|---|---|---|
| `create_share` | `host_machine_id, mode, share_name, local_path, operator_credential_alias?, svc_username?` | 🔴 |
| `list_shares` | — | |
| `inject_share_credential_to_clients` | `share_config_id, client_machine_ids[], operator_credential_alias?` | 🔴 |
| `delete_share` | `share_config_id, also_remove_remote` | 🔴 |

### 项目
| 命令 | 关键参数 | 标签 |
|---|---|---|
| `list_projects` / `list_project_locations` | — / `project_id` | |
| `discover_projects` | `machine_id, search_roots[], operator_credential_alias?` | |
| `set_project_location` | `project_id, machine_id, abs_path, uproject_path, manual` | 🔴 |
| `create_project_manual` | `uproject_name, display_name?` | |
| `delete_project` / `delete_project_location` | `project_id` / `location_id` | 🔴 |

### DDC Pak（重型 UE 任务）
| 命令 | 关键参数 | 标签 |
|---|---|---|
| `generate_ddc_pak` | `backend, source_machine_id?, project_id, local_uproject_path?, local_engine_path?, ue_version?, operator_credential_alias?` | 🔴 ⏳ |
| `verify_pak_output` | `machine_id, project_id, operator_credential_alias?` | |
| `distribute_ddc_pak` | `source_machine_id, project_id, target_machine_ids[], named_share_unc?, ...cred` | 🔴 ⏳ |
| `cancel_ue_job` | `job_id` | （取消 ⏳ 任务） |

### PSO 缓存
| 命令 | 关键参数 | 标签 |
|---|---|---|
| `start_pso_collection` | `source_machine_id, project_id, ue_version?, resolution_w, resolution_h, windowed, max_minutes, ...cred` | 🔴 ⏳ |
| `list_pso_cache_files` | `project_id, source_machine_id?, gpu_signature?` | |
| `distribute_pso_cache` | `request{...}` | 🔴 ⏳ |

### 健康 / 一致性 / 部署
| 命令 | 关键参数 | 标签 |
|---|---|---|
| `run_health_check` | `request{...}` | 三层探测 |
| `list_recent_health_runs` / `list_health_results_for_run` | `limit` / `scan_run_id` | |
| `get_gpu_consistency_matrix` | — | |
| `run_consistency_check` | `hosts[], credential_alias?` → snapshots + inconsistencies | ⏳ |
| `run_log_verify` | `host, editor_exe, project, timeout, credential_alias?` | ⏳ |
| **`deploy_ddc_plan_preview`** | `plan` → `DeployStep[]` | 👁 **dry-run，不执行** |
| `deploy_ddc_run` | `plan, credential_alias?, stop_on_failure` | 🔴 ⏳ |

### Zen 缓存服务（22 命令）
- **状态/探测**：`zen_status(machine_id?)` · `zen_probe(...)` · `zen_cache_stats(...)` · `zen_detect_binary(...)` · `zen_list_endpoints(...)`
- **基线**：`zen_baseline_list` · `zen_baseline_lock` 🔴 · `zen_baseline_unlock` 🔴
- **注册/配置**：`zen_register(input)` 🔴 · `zen_unregister` 🔴 · `zen_change_role` 🔴 · `zen_apply_config` 🔴 · `zen_lua_preview(endpoint_id)` 👁
- **服务管理**：`zen_service_install` 🔴 / `uninstall` 🔴 / `start` 🔴 / `stop` 🔴 / `status`
- **URL ACL**：`zen_urlacl_add` 🔴 / `list` / `remove` 🔴
- **校验**：`zen_verify_rules`

---

## 3. 塑造 UX 的硬约束（设计必须尊重）

1. **聚合健康是"运行快照"，不是实时轮询** —— `run_health_check` 产出一个 run（存库），UI 看的是 `list_health_results_for_run` 的某次 run 结果；不是后台实时刷新。所以集群健康用"上次巡检 + 立即巡检"，别设计成实时跳动的仪表。（原型已正确标「快照·非实时轮询」，保持。）单端点 `zen_probe` / `zen_cache_stats` 可即时探。
2. **长任务有真实 job 模型** —— `generate_ddc_pak` / `start_pso_collection` / `distribute_*` 返回 job 句柄、被 `UeJobRegistry` 跟踪、可 `cancel_ue_job` 取消。**任务抽屉（进度/取消/历史）是有后端支撑的**，可放心设计。
3. **远端操作要选凭据** —— 大量动作带 `credential_alias` / `operator_credential_alias`。凡是对远端机器写操作的流程，UX 要有凭据选择（来自 `list_credentials`）。注：`apply_finding` 的 `credential_alias` 是兼容桩（实走 SSH key），但 UI 仍按"需要凭据"呈现即可。
4. **破坏性操作需二次确认** —— §2 中所有 🔴 命令，设计上走「preview → 确认 → 执行」浮层（原型那套 `PreviewPanel` 模式正确）。
5. **dry-run 是真的** —— `deploy_ddc_plan_preview` 真能不执行只返回步骤。原型的"预览(dry-run)"语义在部署流程上有后端兑现；其余破坏性操作的"预览"目前是前端展示意图，不一定有对应 dry-run 命令（要逐个对）。
6. **机器有角色** —— `Machine.role` ∈ `host/render/dev/editor/unknown`。原型按角色筛选机器是成立的，但**枚举值以这五个为准**（原型里的 `shared`/`roleKey` 命名要对齐到这套）。

---

## 4. ⚠️ 设计已超出当前后端的项（必须处置）

下面是原型 `page_cache.jsx` 里用了、但**实测后端给不了**的东西。每项给出处置建议。**设计时遇到同类，照此判**。

| 设计里假设的 | 实测后端 | 处置 |
|---|---|---|
| 每台机 `ddc%`（本地 DDC 命中率）| Machine 无此字段；本次抽取的命令里**无 per-machine DDC% 指标来源** | **需后端**（新增统计命令）或**砍**（改展示真实存在的：pak 是否存在 / `verify_pak_output`）|
| 每台机 `pso%`（PSO 就绪）| 同上，无 per-machine 指标 | **需后端** 或 改展示 `list_pso_cache_files` 的文件数/有无 |
| 仪表盘 KPI「本地 DDC 均值 / PSO 就绪」| 上述两项的聚合，**无数据源** | 随上两项；在有真实指标前，这两个 KPI 不要做 |
| GPU `vram` · `vendor` | `GpuInfo` 只有 `Name/Driver/DriverDate` | **需后端**（扩展 GPU 采集）或 **砍**这两个字段 |
| 每台机 `channel` 标签（winrm/ssh）| Machine 无 channel 字段；通道概念在凭据/bootstrap 层 | **需确认/需后端**——若要 per-node 通道徽标得加字段；否则按"凭据类型"间接表达 |
| 机器详情 ⑤ 关联：`zen` / `share` / `proj` 反向链接 | 不是 Machine 字段 | **可拼**：用 `zen_status(machine_id)` + `list_shares` + `list_projects/locations` 交叉查，**多命令组装**而非单字段 |
| `driver` 偏离基线提示 | `GpuInfo.Driver` 有；"基线偏离"判断靠 `get_gpu_consistency_matrix` | **可做**，但文案来源是 GpuMatrix，不是 Machine 字段 |

> 判定口径：**「需后端」= 有意识排期加命令；「砍」= 改用已有数据；「可拼」= 前端用多个已有命令组装**。三者都行，唯独不许"假装字段存在直接渲染"——那就是落地崩的来源。

---

## 5. 怎么用这份清单

- **喂给 Claude Design**：在设计 Cache 页的对话里，把本文作为**常驻边界上下文**（连同 `CACHE-UX.md` 的工作流叙事）。一句话指令：「按这份能力清单设计，任何超出 §1/§2 的数据或动作，标出来归到 §4 三类之一」。
- **只在后端变更时更新**：本文是稳定锚，不随每轮 UI 迭代改；只有新增/改动 Tauri 命令或 DTO 时同步。
- **落地对账**：某页设计收敛后，逐个 UI 元素核对——每个数据字段/动作都能在 §1/§2 找到，或在 §4 有处置。这一步过了，`.tsx` 接 `invoke()` 才不会撞空。
