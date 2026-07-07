//! Pure rule engine. Takes a parsed INI file + env-var state, emits findings.
//! No Windows-specific calls; runs and tests on every platform.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Critical,
    Warning,
    Healthy,
    Info,
}

impl Severity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Severity::Critical => "critical",
            Severity::Warning => "warning",
            Severity::Healthy => "healthy",
            Severity::Info => "info",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Project,
    User,
    Engine,
}

impl Category {
    pub fn as_str(&self) -> &'static str {
        match self {
            Category::Project => "project",
            Category::User => "user",
            Category::Engine => "engine",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedKey {
    pub name: String,
    pub value: String,
    pub line_number: usize,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedSection {
    pub name: String,
    pub keys: Vec<ParsedKey>,
    pub backend_nodes: Vec<crate::core::ini_backend_graph::BackendNode>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedFile {
    pub path: String,
    pub category: Category,
    pub sections: Vec<ParsedSection>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct EnvVarState {
    pub shared_data_cache_path: Option<String>,
    pub local_data_cache_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub rule_id: String,
    pub severity: Severity,
    pub category: Category,
    pub file_path: String,
    pub section: Option<String>,
    pub key_name: Option<String>,
    pub line_number: Option<i64>,
    pub snippet_before: String,
    pub snippet_after: Option<String>,
    pub recommended_action: RecommendedAction,
    pub recommended_value: Option<String>,
    pub symptom: String,
    pub rationale: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecommendedAction {
    Set,
    Remove,
    Manual,
}

impl RecommendedAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            RecommendedAction::Set => "set",
            RecommendedAction::Remove => "remove",
            RecommendedAction::Manual => "manual",
        }
    }
}

const DDC_SECTION: &str = "/Script/UnrealEd.DerivedDataCacheSettings";

pub const DEPRECATED_CVARS: &[&str] = &[
    "r.SShaderCache",
    "r.ShaderCache",
    "s.SkipFinalizeCommandList",
    "r.UseShaderCaching",
];

pub fn run_rules(file: &ParsedFile, env: &EnvVarState) -> Vec<Finding> {
    let mut out = Vec::new();
    out.extend(rule_r001(file));
    out.extend(rule_r002(file));
    out.extend(rule_r004(file));
    out.extend(rule_r005(file));
    out.extend(rule_r006(file, env));
    out.extend(rule_r007(file, env));
    // R008/R009/R010（官方 PSO Precaching CVar 健康断言）已删除：源码核实
    // `IsPSOPrecachingEnabled()` 在编辑器二进制下被 `WITH_EDITOR` 编译期禁用，
    // 生产形态（未 cook -game）这些 CVar 全部无效，断言健康与否没有意义；
    // 防卡顿唯一有效机制 = 预跑填充 GPU 驱动缓存（见 docs/cache/pso-p0-report.md）。
    // 引擎出厂 BaseEngine.ini 是只读基线：它的 [DerivedDataBackendGraph] Shared 节点是 Epic 工厂默认
    // （`Path=?EpicDDC`、`DeleteUnused` 等），不是团队可操作的共享 DDC 策略，Volo 也从不改它。整族
    // 「Shared 节点策略 + 留存提醒」规则（R011–R023 / R027 / R028）只在工程 / 用户层评估，否则每台装了
    // UE 的机器都会被工厂默认刷一墙误报。在派发层一处门控，避免逐规则散落、漏改不一致。
    if file.category != Category::Engine {
        out.extend(rule_r011(file)); out.extend(rule_r012(file)); out.extend(rule_r013(file));
        out.extend(rule_r014(file)); out.extend(rule_r015(file)); out.extend(rule_r016(file));
        out.extend(rule_r017(file)); out.extend(rule_r018(file)); out.extend(rule_r019(file));
        out.extend(rule_r020(file)); out.extend(rule_r021(file, env)); out.extend(rule_r022(file));
        out.extend(rule_r023(file));
        out.extend(rule_r027(file));
        out.extend(rule_r028(file));
    }
    out.extend(rule_r024_shader_pipeline_cache_info(file));
    out.extend(rule_r025(file, env));
    out
}

fn find_ddc(file: &ParsedFile) -> Option<&ParsedSection> {
    file.sections.iter().find(|s| s.name == DDC_SECTION)
}

fn key<'a>(section: &'a ParsedSection, name: &str) -> Option<&'a ParsedKey> {
    section.keys.iter().find(|k| k.name.eq_ignore_ascii_case(name))
}

fn rule_r001(file: &ParsedFile) -> Vec<Finding> {
    let Some(section) = find_ddc(file) else { return vec![]; };
    let path_key = key(section, "Path");
    let env_override = key(section, "EnvPathOverride");
    if path_key.is_some() && env_override.is_none() {
        let pk = path_key.unwrap();
        return vec![Finding {
            rule_id: "R001".into(),
            severity: Severity::Critical,
            category: file.category,
            file_path: file.path.clone(),
            section: Some(section.name.clone()),
            key_name: Some(pk.name.clone()),
            line_number: Some(pk.line_number as i64),
            snippet_before: format!("Path={}", pk.value),
            snippet_after: Some("EnvPathOverride=UE-SharedDataCachePath".into()),
            recommended_action: RecommendedAction::Set,
            recommended_value: Some("UE-SharedDataCachePath".into()),
            symptom: "DDC 用了写死的缓存路径，环境变量覆盖被忽略。".into(),
            rationale: "Path= 设了却没配 EnvPathOverride 时，UE 不再读环境变量，整个集群无法共享缓存。".into(),
        }];
    }
    vec![]
}

fn rule_r002(file: &ParsedFile) -> Vec<Finding> {
    if file.category != Category::User { return vec![]; }
    let Some(section) = find_ddc(file) else { return vec![]; };
    if section.keys.is_empty() { return vec![]; }
    vec![Finding {
        rule_id: "R002".into(),
        severity: Severity::Critical,
        category: file.category,
        file_path: file.path.clone(),
        section: Some(section.name.clone()),
        key_name: None,
        line_number: section.keys.first().map(|k| k.line_number as i64),
        snippet_before: section.keys.iter()
            .map(|k| format!("{}={}", k.name, k.value))
            .collect::<Vec<_>>()
            .join("\n"),
        snippet_after: Some("（把这个用户级文件里的整段 DDC 配置删掉）".into()),
        recommended_action: RecommendedAction::Remove,
        recommended_value: None,
        symptom: "用户级 DDC 设置悄悄盖过了工程和环境变量的配置。".into(),
        rationale: "EditorPerProjectUserSettings.ini 是优先级最高的 DDC 来源，这里的任何 DDC 设置都会遮蔽集群配置。".into(),
    }]
}

fn rule_r004(file: &ParsedFile) -> Vec<Finding> {
    let Some(section) = find_ddc(file) else { return vec![]; };
    let mut out = Vec::new();
    for k in &section.keys {
        if !k.name.eq_ignore_ascii_case("Path") { continue; }
        let v = k.value.trim();
        let starts_with_drive = v.len() >= 2
            && v.chars().nth(1) == Some(':')
            && v.chars().next().map_or(false, |c| c.is_ascii_alphabetic());
        let is_unc = v.starts_with("\\\\");
        if starts_with_drive && !is_unc {
            out.push(Finding {
                rule_id: "R004".into(),
                severity: Severity::Warning,
                category: file.category,
                file_path: file.path.clone(),
                section: Some(section.name.clone()),
                key_name: Some(k.name.clone()),
                line_number: Some(k.line_number as i64),
                snippet_before: format!("Path={}", v),
                snippet_after: Some("Path=\\\\HOST\\Share\\...".into()),
                recommended_action: RecommendedAction::Manual,
                recommended_value: None,
                symptom: "用了映射盘符，而 Windows 后台服务（如 RenderStream）看不到映射盘。".into(),
                rationale: "改用 UNC 路径，系统账户下的进程才能找到共享。".into(),
            });
        }
    }
    out
}

fn rule_r005(file: &ParsedFile) -> Vec<Finding> {
    let mut out = Vec::new();
    for s in &file.sections {
        for k in &s.keys {
            if DEPRECATED_CVARS.iter().any(|d| d.eq_ignore_ascii_case(&k.name)) {
                out.push(Finding {
                    rule_id: "R005".into(),
                    severity: Severity::Warning,
                    category: file.category,
                    file_path: file.path.clone(),
                    section: Some(s.name.clone()),
                    key_name: Some(k.name.clone()),
                    line_number: Some(k.line_number as i64),
                    snippet_before: format!("{}={}", k.name, k.value),
                    snippet_after: Some("（删掉这一行）".into()),
                    recommended_action: RecommendedAction::Remove,
                    recommended_value: None,
                    symptom: "用了已废弃、在 UE 5.x 已失效的控制台变量。".into(),
                    rationale: format!("`{}` 已被移除，留着只会增加困惑、没有任何好处。", k.name),
                });
            }
        }
    }
    out
}

fn rule_r006(file: &ParsedFile, env: &EnvVarState) -> Vec<Finding> {
    let Some(section) = find_ddc(file) else { return vec![]; };
    let Some(envk) = key(section, "EnvPathOverride") else { return vec![]; };
    let v = envk.value.trim();
    let referenced_present = match v {
        "UE-SharedDataCachePath" => env.shared_data_cache_path.as_ref().is_some(),
        "UE-LocalDataCachePath" => env.local_data_cache_path.as_ref().is_some(),
        _ => true,
    };
    if !referenced_present {
        return vec![Finding {
            rule_id: "R006".into(),
            severity: Severity::Warning,
            category: file.category,
            file_path: file.path.clone(),
            section: Some(section.name.clone()),
            key_name: Some(envk.name.clone()),
            line_number: Some(envk.line_number as i64),
            snippet_before: format!("EnvPathOverride={}", v),
            snippet_after: Some(format!("(set environment variable `{}` on this machine)", v)),
            recommended_action: RecommendedAction::Manual,
            recommended_value: None,
            symptom: "配置引用了一个未设置的环境变量，DDC 会回退到本地缓存。".into(),
            rationale: format!("这台机器上没有 `{}`。用 Volo 的环境变量设置把它设上。", v),
        }];
    }
    vec![]
}

fn rule_r007(file: &ParsedFile, env: &EnvVarState) -> Vec<Finding> {
    let Some(section) = find_ddc(file) else { return vec![]; };
    let Some(envk) = key(section, "EnvPathOverride") else { return vec![]; };
    let referenced_present = match envk.value.trim() {
        "UE-SharedDataCachePath" => env.shared_data_cache_path.is_some(),
        "UE-LocalDataCachePath" => env.local_data_cache_path.is_some(),
        _ => false,
    };
    if !referenced_present { return vec![]; }
    vec![Finding {
        rule_id: "R007".into(),
        severity: Severity::Healthy,
        category: file.category,
        file_path: file.path.clone(),
        section: Some(section.name.clone()),
        key_name: Some(envk.name.clone()),
        line_number: Some(envk.line_number as i64),
        snippet_before: format!("EnvPathOverride={}", envk.value),
        snippet_after: None,
        recommended_action: RecommendedAction::Manual,
        recommended_value: None,
        symptom: "配置正确，仅计入健康统计。".into(),
        rationale: "EnvPathOverride 指向的环境变量在这台机器上已设值。".into(),
    }]
}

/// R024（信息级）：`r.ShaderPipelineCache.Enabled` 只对 cook 后的包生效——
/// 本仓生产形态（未 cook `-game`）根本不会加载任何 `.upipelinecache`，健康断言
/// 没有意义。规则降级为：仅当有人**显式配置了**该 CVar 时给一条 Info 说明
/// （让配置者知道它在当前形态下不起作用）；未配置 = 常态，保持沉默。
/// 生效文件同旧判定：DefaultEngine.ini 的 [ConsoleVariables] 段
/// （ConfigCacheIni.cpp::LoadConsoleVariablesFromINI，工程 ConsoleVariables.ini 引擎不读）。
fn rule_r024_shader_pipeline_cache_info(file: &ParsedFile) -> Vec<Finding> {
    if !file
        .path
        .to_ascii_lowercase()
        .ends_with("defaultengine.ini")
    {
        return vec![];
    }
    let Some(section) = file
        .sections
        .iter()
        .find(|section| section.name.eq_ignore_ascii_case("ConsoleVariables"))
    else {
        return vec![];
    };
    let Some(entry) = key(section, "r.ShaderPipelineCache.Enabled") else {
        return vec![];
    };
    vec![Finding {
        rule_id: "R024".into(),
        severity: Severity::Info,
        category: file.category,
        file_path: file.path.clone(),
        section: Some(section.name.clone()),
        key_name: Some(entry.name.clone()),
        line_number: Some(entry.line_number as i64),
        snippet_before: format!("{}={}", entry.name, entry.value),
        snippet_after: None,
        recommended_action: RecommendedAction::Manual,
        recommended_value: None,
        symptom: "配置了 r.ShaderPipelineCache.Enabled，但它在当前生产形态下不起作用。".into(),
        rationale: "捆绑 PSO 缓存文件（.upipelinecache）仅在 cook 后的打包版本里被加载；本团队生产形态是未 cook 的 -game 直启，该 CVar 无效。防卡顿依赖预跑填充 GPU 驱动缓存 + 验证跑（见 PSO 就绪板块）。".into(),
    }]
}

// ── BackendGraph helpers ─────────────────────────────────────────────────────

/// UE 共享 DDC 的 per-machine 覆盖环境变量名。scanner 只读这一个变量进 EnvVarState，
/// R021 的 EnvPathOverride 抑制也只能据此校验。
const SHARED_DDC_ENV_VAR: &str = "UE-SharedDataCachePath";

/// 剥掉 UE INI 值两端的成对双引号（parse_node 只去空白、保留引号）。
fn unquote(s: &str) -> &str {
    s.strip_prefix('"').and_then(|x| x.strip_suffix('"')).unwrap_or(s)
}

/// UNC 路径判定，`\\host\share` 与 `//host/share` 都认（与 crate 内 zen/ops、zen/endpoint 一致；
/// UE / Windows 两种前缀都接受）。
fn is_unc(p: &str) -> bool {
    p.starts_with(r"\\") || p.starts_with("//")
}

fn find_shared_backend(file: &ParsedFile) -> Option<&crate::core::ini_backend_graph::BackendNode> {
    file.sections.iter()
        .find(|s| s.name.eq_ignore_ascii_case("DerivedDataBackendGraph"))?
        .backend_nodes.iter().find(|n| n.name.eq_ignore_ascii_case("Shared"))
}

fn bg_finding(
    file: &ParsedFile, node: &crate::core::ini_backend_graph::BackendNode,
    rule_id: &str, severity: Severity, field: &str, current: &str,
    recommended: &str, symptom: &str, rationale: &str, action: RecommendedAction,
) -> Finding {
    Finding {
        rule_id: rule_id.into(), severity, category: file.category,
        file_path: file.path.clone(),
        section: Some("DerivedDataBackendGraph".into()),
        key_name: Some(format!("Shared.{}", field)),
        line_number: Some(node.line_number as i64),
        snippet_before: format!("{}={}", field, current),
        snippet_after: Some(format!("{}={}", field, recommended)),
        recommended_action: action,
        recommended_value: Some(recommended.into()),
        symptom: symptom.into(),
        rationale: rationale.into(),
    }
}

fn rule_numeric_range(
    file: &ParsedFile, n: &crate::core::ini_backend_graph::BackendNode,
    rule_id: &str, severity: Severity, field: &str,
    lo: i64, hi: i64, default_value: &str, symptom: &str, rationale: &str,
) -> Vec<Finding> {
    let Some(v) = crate::core::ini_backend_graph::get_field(n, field) else { return vec![]; };
    let ok = v.parse::<i64>().map(|x| x >= lo && x <= hi).unwrap_or(false);
    if ok { return vec![]; }
    vec![bg_finding(file, n, rule_id, severity, field, v, default_value,
        symptom, rationale, RecommendedAction::Set)]
}

// ── BackendGraph rules R011–R023 ─────────────────────────────────────────────

use crate::core::ini_backend_graph::get_field;

fn rule_r011(file: &ParsedFile) -> Vec<Finding> {
    let Some(n) = find_shared_backend(file) else { return vec![]; };
    let v = get_field(n, "Type").unwrap_or("");
    if !v.eq_ignore_ascii_case("FileSystem") {
        return vec![bg_finding(file, n, "R011", Severity::Critical, "Type",
            v, "FileSystem",
            "共享缓存的类型缺失或不对（应为 FileSystem）。",
            "没有 Type=FileSystem，UE 可能建出一个无效缓存层，悄悄只用本地缓存。",
            RecommendedAction::Set)];
    }
    vec![]
}

fn rule_r012(file: &ParsedFile) -> Vec<Finding> {
    let Some(n) = find_shared_backend(file) else { return vec![]; };
    match get_field(n, "ReadOnly") {
        Some(v) if v.eq_ignore_ascii_case("true") => vec![bg_finding(file, n, "R012",
            Severity::Warning, "ReadOnly", v, "false",
            "共享缓存被设成只读，集群无法写回。",
            "渲染机要能把首次生成的结果推上去，其他机器才能命中缓存。",
            RecommendedAction::Set)],
        _ => vec![],
    }
}

fn rule_r013(file: &ParsedFile) -> Vec<Finding> {
    let Some(n) = find_shared_backend(file) else { return vec![]; };
    match get_field(n, "Clean") {
        Some(v) if v.eq_ignore_ascii_case("true") => vec![bg_finding(file, n, "R013",
            Severity::Critical, "Clean", v, "false",
            "Clean=true 会在每次启动时清空共享缓存。",
            "生产用的共享缓存必须在多次会话间保留。",
            RecommendedAction::Set)],
        _ => vec![],
    }
}

fn rule_r014(file: &ParsedFile) -> Vec<Finding> {
    let Some(n) = find_shared_backend(file) else { return vec![]; };
    match get_field(n, "Flush") {
        Some(v) if v.eq_ignore_ascii_case("true") => vec![bg_finding(file, n, "R014",
            Severity::Warning, "Flush", v, "false",
            "Flush=true 会在退出时丢弃缓存。",
            "共享缓存必须能在编辑器关闭后保留。",
            RecommendedAction::Set)],
        _ => vec![],
    }
}

fn rule_r015(file: &ParsedFile) -> Vec<Finding> {
    let Some(n) = find_shared_backend(file) else { return vec![]; };
    if get_field(n, "DeleteUnused").is_none() {
        return vec![bg_finding(file, n, "R015", Severity::Warning, "DeleteUnused",
            "（未设置）", "true",
            "DeleteUnused 没配置，缓存回收行为不确定。",
            "不同 UE 版本的默认值可能不同，建议显式固定。",
            RecommendedAction::Set)];
    }
    vec![]
}

fn rule_r016(file: &ParsedFile) -> Vec<Finding> {
    let Some(n) = find_shared_backend(file) else { return vec![]; };
    rule_numeric_range(file, n, "R016", Severity::Warning, "UnusedFileAge",
        1, 365, "10",
        "UnusedFileAge 超出 1–365 天的合理范围。",
        "缓存回收需要一个有意义的保留窗口。")
}

fn rule_r017(file: &ParsedFile) -> Vec<Finding> {
    let Some(n) = find_shared_backend(file) else { return vec![]; };
    rule_numeric_range(file, n, "R017", Severity::Warning, "FoldersToClean",
        1, 100, "10",
        "FoldersToClean 超出 1–100 的范围。",
        "缓存回收的清理粒度不合适。")
}

fn rule_r018(file: &ParsedFile) -> Vec<Finding> {
    let Some(n) = find_shared_backend(file) else { return vec![]; };
    rule_numeric_range(file, n, "R018", Severity::Warning, "MaxFileChecksPerSec",
        1, 100, "1",
        "MaxFileChecksPerSec 超出 1–100 的范围。",
        "设太高会给存储增加压力，太低会拖慢缓存读取。")
}

fn rule_r019(file: &ParsedFile) -> Vec<Finding> {
    let Some(n) = find_shared_backend(file) else { return vec![]; };
    rule_numeric_range(file, n, "R019", Severity::Warning, "ConsiderSlowAt",
        10, 1000, "70",
        "ConsiderSlowAt 超出 10–1000 毫秒。",
        "设错时 UE 可能会停用共享缓存层。")
}

fn rule_r020(file: &ParsedFile) -> Vec<Finding> {
    let Some(n) = find_shared_backend(file) else { return vec![]; };
    match get_field(n, "PromptIfMissing") {
        Some(v) if v.eq_ignore_ascii_case("true") => vec![bg_finding(file, n, "R020",
            Severity::Critical, "PromptIfMissing", v, "false",
            "PromptIfMissing=true 会让无人值守启动卡住。",
            "RenderStream 服务没有界面，一旦弹出路径缺失对话框就会卡在启动。",
            RecommendedAction::Set)],
        _ => vec![],
    }
}

fn rule_r021(file: &ParsedFile, env: &EnvVarState) -> Vec<Finding> {
    let Some(n) = find_shared_backend(file) else { return vec![]; };
    // UE 的 INI 约定会给含空格的路径加引号（如 `Path="\\NAS\Shared DDC"`）；parse_node 只去空白、
    // 不剥引号，所以前缀判断前先剥掉两端引号，否则带引号的合法 UNC 会被误判成「不是 UNC」。
    let path = unquote(get_field(n, "Path").unwrap_or(""));
    // 节点声明了 EnvPathOverride=UE-SharedDataCachePath 且该环境变量已是合法 UNC，则 UE 会用环境变量
    // 覆盖字面 Path、字面值无关紧要——这正是「按机器单独指共享路径」的正常做法（引擎出厂 Shared
    // 默认 `Path=?EpicDDC` 也带这个 override，环境变量一设好就走这条静默路径）。
    // 注：scanner 只把 UE-SharedDataCachePath 读进 env_state，故只能校验这一个 override 变量名。
    if matches!(get_field(n, "EnvPathOverride"), Some(v) if v.eq_ignore_ascii_case(SHARED_DDC_ENV_VAR))
        && matches!(env.shared_data_cache_path.as_deref(), Some(p) if is_unc(p))
    {
        return vec![];
    }
    if !is_unc(path) {
        return vec![bg_finding(file, n, "R021", Severity::Critical, "Path",
            if path.is_empty() { "（未设置）" } else { path },
            r"\\HOST\Share",
            "共享缓存路径缺失或不是 UNC 路径。",
            "映射盘符对 Windows 服务和 RenderStream 不可见。",
            RecommendedAction::Manual)];
    }
    vec![]
}

fn rule_r022(file: &ParsedFile) -> Vec<Finding> {
    let Some(n) = find_shared_backend(file) else { return vec![]; };
    if get_field(n, "EnvPathOverride").is_none() {
        return vec![bg_finding(file, n, "R022", Severity::Warning, "EnvPathOverride",
            "（未设置）", "UE-SharedDataCachePath",
            "没设 EnvPathOverride，环境变量回退被禁用。",
            "没有它，UE 会忽略 UE-SharedDataCachePath，没法按机器单独覆盖路径。",
            RecommendedAction::Set)];
    }
    vec![]
}

fn rule_r023(file: &ParsedFile) -> Vec<Finding> {
    let Some(n) = find_shared_backend(file) else { return vec![]; };
    if get_field(n, "EditorOverrideSetting").is_none() {
        return vec![bg_finding(file, n, "R023", Severity::Info, "EditorOverrideSetting",
            "（未设置）", "SharedDerivedDataCache",
            "没声明 EditorOverrideSetting。",
            "缺了它，编辑器偏好设置界面无法覆盖 INI 里的路径。",
            RecommendedAction::Set)];
    }
    vec![]
}

fn rule_r025(file: &ParsedFile, env: &EnvVarState) -> Vec<Finding> {
    if file.category != Category::User { return vec![]; }
    let prefs = crate::core::editor_preferences::extract(file);
    let mut out = Vec::new();
    if let (Some(proj), Some(env_val)) = (prefs.project_shared.as_ref(), env.shared_data_cache_path.as_ref()) {
        if proj != env_val {
            out.push(Finding {
                rule_id: "R025".into(), severity: Severity::Critical, category: file.category,
                file_path: file.path.clone(),
                section: Some("/Script/UnrealEd.EditorSettings".into()),
                key_name: Some("ProjectSharedDDCPath".into()),
                line_number: None,
                snippet_before: format!("ProjectSharedDDCPath={}", proj),
                snippet_after: Some("（留空，让环境变量 / 工程 Config 接管）".into()),
                recommended_action: RecommendedAction::Remove,
                recommended_value: None,
                symptom: "工程级编辑器偏好悄悄遮蔽了 UE-SharedDataCachePath。".into(),
                rationale: "ProjectSharedDDCPath 非空时，UE 会用它而忽略 EnvPathOverride。".into(),
            });
        }
    }
    out
}

// ── Retention reminders R027 (FileSystem) / R028 (Zen) ───────────────────────
//
// These two flag the "running on default cache expiry" situation and are
// Info-severity *reminders*, not problems. They use RecommendedAction::Manual
// on purpose: the actual write is done by the dedicated, reversible toggles
// (`ini gc-pause/gc-resume` for FileSystem, `ini zen-gc-pause/zen-gc-resume`
// for Zen) — NOT by auto-applying the finding. That keeps R027 from issuing a
// "set DeleteUnused=false" auto-fix that would contradict R015's "set true".
//
// Known gap: both only inspect the *explicitly declared* node/section in the
// scanned file. A project that inherits the engine default entirely (no Shared
// node / no [Zen.AutoLaunch] of its own) is not flagged — that would require a
// full BaseEngine→Default→User config merge.

fn rule_r027(file: &ParsedFile) -> Vec<Finding> {
    let Some(n) = find_shared_backend(file) else { return vec![]; };
    // FileSystem-only concept: DeleteUnused / UnusedFileAge are meaningless on a
    // Zen/other-typed Shared node. R011 already flags a non-FileSystem Type as
    // critical; don't pile misleading retention advice on top of it.
    if matches!(get_field(n, "Type"), Some(t) if !t.eq_ignore_ascii_case("FileSystem")) {
        return vec![];
    }
    // GC already explicitly off → caches persist → nothing to remind about.
    if matches!(get_field(n, "DeleteUnused"), Some(v) if v.eq_ignore_ascii_case("false")) {
        return vec![];
    }
    let age = get_field(n, "UnusedFileAge");
    // UnusedFileAge already pinned well beyond the default window → intentional.
    if let Some(days) = age.and_then(|v| v.parse::<i64>().ok()) {
        if days > crate::core::ddc_retention::FS_REMINDER_MAX_DAYS {
            return vec![];
        }
    }
    let cur_delete = get_field(n, "DeleteUnused").unwrap_or("（未设置，默认 true）");
    let age_desc = age.unwrap_or("未设置（引擎默认约 15 天）");
    vec![bg_finding(
        file, n, "R027", Severity::Info, "DeleteUnused", cur_delete, "false",
        &format!("共享缓存按默认过期策略运行：UnusedFileAge={}，回收已开启 —— 超过默认窗口的派生数据会被回收。", age_desc),
        "工程进行中仍需要的缓存会被回收并触发重新编译。用 `ini gc-pause` 暂停回收（DeleteUnused=false）以在整个工程期间保留共享缓存；`gc-resume` 恢复默认。",
        RecommendedAction::Manual,
    )]
}

fn rule_r028(file: &ParsedFile) -> Vec<Finding> {
    // Only remind when the project explicitly configures [Zen.AutoLaunch]
    // (avoids nagging projects that don't use Zen at all).
    let Some(section) = file.sections.iter()
        .find(|s| s.name.eq_ignore_ascii_case("Zen.AutoLaunch")) else { return vec![]; };
    let extra = key(section, "ExtraArgs");
    let current = extra
        .and_then(|k| crate::core::ddc_retention::parse_gc_cache_duration_seconds(&k.value));
    // GC window already raised well past the default → intentional.
    if let Some(secs) = current {
        if secs > crate::core::ddc_retention::ZEN_REMINDER_MAX_SECONDS {
            return vec![];
        }
    }
    let cur_desc = match current {
        Some(s) => format!("{} 秒（约 {} 天）", s, s / 86_400),
        None => "未设置（引擎默认 1209600 秒 = 14 天）".to_string(),
    };
    vec![Finding {
        rule_id: "R028".into(),
        severity: Severity::Info,
        category: file.category,
        file_path: file.path.clone(),
        section: Some("Zen.AutoLaunch".into()),
        key_name: Some("ExtraArgs".into()),
        line_number: extra.map(|k| k.line_number as i64),
        snippet_before: format!("--gc-cache-duration-seconds = {}", cur_desc),
        snippet_after: Some(format!(
            "--gc-cache-duration-seconds {}",
            crate::core::ddc_retention::ZEN_NEVER_EXPIRE_SECONDS
        )),
        recommended_action: RecommendedAction::Manual,
        recommended_value: None,
        symptom: format!("Zen 服务器按默认回收策略运行（{}）；超过该窗口后未使用的缓存会被回收。", cur_desc),
        rationale: "Zen 没有 DeleteUnused 开关；要在整个工程期间保留缓存，用 `ini zen-gc-pause` 提高 [Zen.AutoLaunch] ExtraArgs 里的 --gc-cache-duration-seconds。`zen-gc-resume` 恢复 14 天默认。".into(),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ddc_section(keys: &[(&str, &str)]) -> ParsedSection {
        ParsedSection {
            name: "/Script/UnrealEd.DerivedDataCacheSettings".into(),
            keys: keys.iter().map(|(k, v)| ParsedKey {
                name: k.to_string(),
                value: v.to_string(),
                line_number: 0,
            }).collect(),
            backend_nodes: vec![],
        }
    }

    #[test]
    fn r001_critical_when_path_set_without_envpathoverride() {
        let file = ParsedFile {
            path: "C:\\Project\\Config\\DefaultEngine.ini".into(),
            category: Category::Project,
            sections: vec![ddc_section(&[("Path", "D:\\OldDDC")])],
        };
        let env_state = EnvVarState::default();
        let findings = run_rules(&file, &env_state);
        assert!(findings.iter().any(|f| f.rule_id == "R001" && f.severity == Severity::Critical));
    }

    #[test]
    fn r001_healthy_when_envpathoverride_set_and_envvar_present() {
        let file = ParsedFile {
            path: "C:\\Project\\Config\\DefaultEngine.ini".into(),
            category: Category::Project,
            sections: vec![ddc_section(&[("EnvPathOverride", "UE-SharedDataCachePath")])],
        };
        let mut env_state = EnvVarState::default();
        env_state.shared_data_cache_path = Some("\\\\HOST\\DDC".into());
        let findings = run_rules(&file, &env_state);
        assert!(findings.iter().any(|f| f.rule_id == "R007" && f.severity == Severity::Healthy));
    }

    #[test]
    fn r002_critical_when_user_level_file_has_ddc_section() {
        let file = ParsedFile {
            path: "C:\\Users\\X\\AppData\\Local\\UnrealEngine\\5.4\\Saved\\Config\\WindowsEditor\\EditorPerProjectUserSettings.ini".into(),
            category: Category::User,
            sections: vec![ddc_section(&[("Path", "C:\\local")])],
        };
        let findings = run_rules(&file, &EnvVarState::default());
        assert!(findings.iter().any(|f| f.rule_id == "R002" && f.severity == Severity::Critical));
    }

    #[test]
    fn r004_warning_when_path_uses_drive_letter() {
        let file = ParsedFile {
            path: "C:\\Project\\Config\\DefaultEngine.ini".into(),
            category: Category::Project,
            sections: vec![ddc_section(&[("Path", "Z:\\DDC")])],
        };
        let findings = run_rules(&file, &EnvVarState::default());
        assert!(findings.iter().any(|f| f.rule_id == "R004" && f.severity == Severity::Warning));
    }

    #[test]
    fn r005_warning_when_deprecated_cvar_present() {
        let file = ParsedFile {
            path: "C:\\Project\\Config\\ConsoleVariables.ini".into(),
            category: Category::Project,
            sections: vec![ParsedSection {
                name: "Startup".into(),
                keys: vec![ParsedKey {
                    name: "r.SShaderCache".into(),
                    value: "1".into(),
                    line_number: 12,
                }],
                backend_nodes: vec![],
            }],
        };
        let findings = run_rules(&file, &EnvVarState::default());
        assert!(findings.iter().any(|f| f.rule_id == "R005" && f.severity == Severity::Warning));
    }

    #[test]
    fn r006_warning_when_envoverride_set_but_envvar_empty() {
        let file = ParsedFile {
            path: "C:\\Project\\Config\\DefaultEngine.ini".into(),
            category: Category::Project,
            sections: vec![ddc_section(&[("EnvPathOverride", "UE-SharedDataCachePath")])],
        };
        let env_state = EnvVarState::default();
        let findings = run_rules(&file, &env_state);
        assert!(findings.iter().any(|f| f.rule_id == "R006" && f.severity == Severity::Warning));
    }

    fn console_variables(keys: &[(&str, &str)]) -> ParsedFile {
        // PSO CVar 规则扫 DefaultEngine.ini 的 [ConsoleVariables] 段（生效位置）。
        ParsedFile {
            path: "C:\\Project\\Config\\DefaultEngine.ini".into(),
            category: Category::Project,
            sections: vec![ParsedSection {
                name: "ConsoleVariables".into(),
                keys: keys
                    .iter()
                    .enumerate()
                    .map(|(idx, (k, v))| ParsedKey {
                        name: k.to_string(),
                        value: v.to_string(),
                        line_number: idx + 1,
                    })
                    .collect(),
                backend_nodes: vec![],
            }],
        }
    }

    #[test]
    fn official_precaching_rules_are_gone() {
        // R008/R009/R010 已删除：官方 PSO Precaching 在未 cook -game 下被
        // WITH_EDITOR 编译期禁用，这些 CVar 无效，健康断言没有意义。
        let file = console_variables(&[
            ("r.PSOPrecaching", "0"),
            ("r.PSOPrecache.Mode", "1"),
            ("r.PSOPrecache.GlobalShaders", "0"),
        ]);
        let findings = run_rules(&file, &EnvVarState::default());
        assert!(!findings
            .iter()
            .any(|f| matches!(f.rule_id.as_str(), "R008" | "R009" | "R010")));
    }

    // ── R024: ShaderPipelineCache.Enabled（信息级，仅显式配置时说明其无效）──

    #[test]
    fn r024_silent_when_shader_pipeline_cache_not_configured() {
        // 未配置 = 常态：捆绑缓存本来就不参与生产形态，不该有任何输出。
        let f = console_variables(&[]);
        assert_silent("R024", &f);
        let no_section = ParsedFile {
            path: r"C:\Project\Config\DefaultEngine.ini".into(),
            category: Category::Project,
            sections: vec![],
        };
        assert_silent("R024", &no_section);
    }

    #[test]
    fn r024_info_when_shader_pipeline_cache_explicitly_configured() {
        for value in ["0", "1"] {
            let f = console_variables(&[("r.ShaderPipelineCache.Enabled", value)]);
            let findings = run_rules(&f, &EnvVarState::default());
            let hit = findings.iter().find(|x| x.rule_id == "R024").unwrap();
            assert_eq!(hit.severity, Severity::Info);
            assert_eq!(hit.recommended_action, RecommendedAction::Manual);
            assert!(hit.recommended_value.is_none());
        }
    }

    #[test]
    fn r024_silent_for_project_consolevariables_file() {
        // 引擎不读工程目录的 ConsoleVariables.ini（源码核实），规则只看 DefaultEngine.ini。
        let f = ParsedFile {
            path: r"C:\Project\Config\ConsoleVariables.ini".into(),
            category: Category::Project,
            sections: vec![],
        };
        assert_silent("R024", &f);
    }

    // ── BackendGraph rule helpers ─────────────────────────────────────────────

    fn ddb_project(node_raw: &str) -> ParsedFile {
        use crate::core::ini_backend_graph::parse_node;
        ParsedFile {
            path: r"C:\Project\Config\DefaultEngine.ini".into(),
            category: Category::Project,
            sections: vec![ParsedSection {
                name: "DerivedDataBackendGraph".into(),
                keys: vec![],
                backend_nodes: vec![parse_node(node_raw, 0).unwrap()],
            }],
        }
    }

    fn assert_fires(rule: &str, file: &ParsedFile) {
        let env = EnvVarState::default();
        let findings = run_rules(file, &env);
        assert!(findings.iter().any(|f| f.rule_id == rule),
            "expected {} to fire; got: {:?}", rule,
            findings.iter().map(|f| f.rule_id.clone()).collect::<Vec<_>>());
    }
    fn assert_silent(rule: &str, file: &ParsedFile) {
        let env = EnvVarState::default();
        let findings = run_rules(file, &env);
        assert!(!findings.iter().any(|f| f.rule_id == rule), "expected {} silent", rule);
    }

    // ── R011–R025 paired fire/silent tests ───────────────────────────────────

    #[test] fn r011_fires_on_wrong_type() { assert_fires("R011", &ddb_project(r"Shared=(Path=\\NAS)")); }
    #[test] fn r011_silent_on_correct_type() { assert_silent("R011", &ddb_project(r"Shared=(Type=FileSystem, Path=\\NAS)")); }
    #[test] fn r012_fires_on_readonly_true() { assert_fires("R012", &ddb_project(r"Shared=(Type=FileSystem, ReadOnly=true)")); }
    #[test] fn r012_silent_on_readonly_false() { assert_silent("R012", &ddb_project(r"Shared=(Type=FileSystem, ReadOnly=false)")); }
    #[test] fn r013_fires_on_clean_true() { assert_fires("R013", &ddb_project(r"Shared=(Type=FileSystem, Clean=true)")); }
    #[test] fn r013_silent_on_clean_false() { assert_silent("R013", &ddb_project(r"Shared=(Type=FileSystem, Clean=false)")); }
    #[test] fn r014_fires_on_flush_true() { assert_fires("R014", &ddb_project(r"Shared=(Type=FileSystem, Flush=true)")); }
    #[test] fn r014_silent_on_flush_false() { assert_silent("R014", &ddb_project(r"Shared=(Type=FileSystem, Flush=false)")); }
    #[test] fn r015_fires_when_missing() { assert_fires("R015", &ddb_project(r"Shared=(Type=FileSystem)")); }
    #[test] fn r015_silent_when_present() { assert_silent("R015", &ddb_project(r"Shared=(Type=FileSystem, DeleteUnused=true)")); }
    #[test] fn r016_fires_for_out_of_range_zero() { assert_fires("R016", &ddb_project(r"Shared=(Type=FileSystem, UnusedFileAge=0)")); }
    #[test] fn r016_fires_for_out_of_range_huge() { assert_fires("R016", &ddb_project(r"Shared=(Type=FileSystem, UnusedFileAge=9999)")); }
    #[test] fn r016_silent_for_normal() { assert_silent("R016", &ddb_project(r"Shared=(Type=FileSystem, UnusedFileAge=10)")); }
    #[test] fn r017_fires_oor() { assert_fires("R017", &ddb_project(r"Shared=(Type=FileSystem, FoldersToClean=0)")); }
    #[test] fn r017_silent_ok() { assert_silent("R017", &ddb_project(r"Shared=(Type=FileSystem, FoldersToClean=10)")); }
    #[test] fn r018_fires_oor() { assert_fires("R018", &ddb_project(r"Shared=(Type=FileSystem, MaxFileChecksPerSec=9999)")); }
    #[test] fn r018_silent_ok() { assert_silent("R018", &ddb_project(r"Shared=(Type=FileSystem, MaxFileChecksPerSec=1)")); }
    #[test] fn r019_fires_oor() { assert_fires("R019", &ddb_project(r"Shared=(Type=FileSystem, ConsiderSlowAt=0)")); }
    #[test] fn r019_silent_ok() { assert_silent("R019", &ddb_project(r"Shared=(Type=FileSystem, ConsiderSlowAt=70)")); }
    #[test] fn r020_fires_on_prompt_true() { assert_fires("R020", &ddb_project(r"Shared=(Type=FileSystem, PromptIfMissing=true)")); }
    #[test] fn r020_silent_on_prompt_false() { assert_silent("R020", &ddb_project(r"Shared=(Type=FileSystem, PromptIfMissing=false)")); }
    #[test] fn r021_fires_on_drive_letter() { assert_fires("R021", &ddb_project(r"Shared=(Type=FileSystem, Path=Z:\DDC)")); }
    #[test] fn r021_fires_on_missing_path() { assert_fires("R021", &ddb_project(r"Shared=(Type=FileSystem)")); }
    #[test] fn r021_silent_on_unc() { assert_silent("R021", &ddb_project(r"Shared=(Type=FileSystem, Path=\\NAS\DDC)")); }
    // 工程 / 用户层的宏路径不是「引擎默认」而是误配：`%ENGINEDIR%…` 解析成本机本地引擎目录、
    // `?EpicDDC` 残留则各机自解析——都不是共享 UNC，无 override 兜底时 R021 必须照报（不能当宏放行）。
    #[test] fn r021_fires_on_project_percent_macro() { assert_fires("R021", &ddb_project(r"Shared=(Type=FileSystem, Path=%ENGINEDIR%DerivedDataCache)")); }
    #[test] fn r021_fires_on_project_epic_macro_without_override() { assert_fires("R021", &ddb_project(r"Shared=(Type=FileSystem, Path=?EpicDDC)")); }
    // 带引号的合法 UNC（含空格的共享名必须加引号）剥引号后应识别为 UNC，不误报。
    #[test] fn r021_silent_on_quoted_unc() { assert_silent("R021", &ddb_project(r#"Shared=(Type=FileSystem, Path="\\NAS\Shared DDC")"#)); }
    // EnvPathOverride=UE-SharedDataCachePath 且环境变量已是合法 UNC → 字面 Path（含宏）被覆盖，不报。
    #[test] fn r021_silent_when_env_override_unc() {
        let f = ddb_project(r"Shared=(Type=FileSystem, Path=?EpicDDC, EnvPathOverride=UE-SharedDataCachePath)");
        let env = EnvVarState { shared_data_cache_path: Some(r"\\LANPC\Volo_DDC".into()), local_data_cache_path: None };
        assert!(!run_rules(&f, &env).iter().any(|x| x.rule_id == "R021"), "R021 应被 EnvPathOverride+合法 UNC 环境变量抑制");
    }
    // 环境变量用正斜杠 UNC（Windows/UE 也接受）同样应抑制。
    #[test] fn r021_silent_when_env_override_forward_slash_unc() {
        let f = ddb_project(r"Shared=(Type=FileSystem, EnvPathOverride=UE-SharedDataCachePath)");
        let env = EnvVarState { shared_data_cache_path: Some("//NAS/DDC".into()), local_data_cache_path: None };
        assert!(!run_rules(&f, &env).iter().any(|x| x.rule_id == "R021"), "正斜杠 UNC 环境变量也应抑制 R021");
    }
    // 但环境变量没设 / 不是 UNC 时，EnvPathOverride 单独存在不足以抑制——仍报。
    #[test] fn r021_fires_when_env_override_but_env_unset() {
        let f = ddb_project(r"Shared=(Type=FileSystem, EnvPathOverride=UE-SharedDataCachePath)");
        assert!(run_rules(&f, &EnvVarState::default()).iter().any(|x| x.rule_id == "R021"), "环境变量未设时 R021 应仍报");
    }
    #[test] fn r022_fires_when_missing() { assert_fires("R022", &ddb_project(r"Shared=(Type=FileSystem, Path=\\NAS)")); }
    #[test] fn r022_silent_when_present() { assert_silent("R022", &ddb_project(r"Shared=(Type=FileSystem, Path=\\NAS, EnvPathOverride=UE-SharedDataCachePath)")); }
    #[test] fn r023_fires_when_missing() { assert_fires("R023", &ddb_project(r"Shared=(Type=FileSystem, Path=\\NAS)")); }

    // ── R027 (FileSystem default-retention reminder) ──────────────────────────
    #[test] fn r027_fires_when_age_unset_and_gc_active() { assert_fires("R027", &ddb_project(r"Shared=(Type=FileSystem, Path=\\NAS)")); }
    #[test] fn r027_fires_when_age_short() { assert_fires("R027", &ddb_project(r"Shared=(Type=FileSystem, UnusedFileAge=10)")); }
    #[test] fn r027_silent_when_gc_paused() { assert_silent("R027", &ddb_project(r"Shared=(Type=FileSystem, DeleteUnused=false)")); }
    #[test] fn r027_silent_when_age_pinned_long() { assert_silent("R027", &ddb_project(r"Shared=(Type=FileSystem, UnusedFileAge=36500)")); }
    #[test] fn r027_silent_on_non_filesystem_shared() { assert_silent("R027", &ddb_project(r"Shared=(Type=Zen, Host=x, Namespace=y)")); }

    // ── R028 (Zen default-retention reminder) ─────────────────────────────────
    fn zen_autolaunch(extra_args: Option<&str>) -> ParsedFile {
        let keys = match extra_args {
            Some(v) => vec![ParsedKey { name: "ExtraArgs".into(), value: v.into(), line_number: 3 }],
            None => vec![],
        };
        ParsedFile {
            path: r"C:\Project\Config\DefaultEngine.ini".into(),
            category: Category::Project,
            sections: vec![ParsedSection { name: "Zen.AutoLaunch".into(), keys, backend_nodes: vec![] }],
        }
    }
    #[test] fn r028_fires_on_default_duration() { assert_fires("R028", &zen_autolaunch(Some("--http asio --gc-cache-duration-seconds 1209600 --quiet"))); }
    #[test] fn r028_fires_when_flag_absent() { assert_fires("R028", &zen_autolaunch(Some("--http asio --quiet"))); }
    #[test] fn r028_silent_when_duration_long() { assert_silent("R028", &zen_autolaunch(Some("--gc-cache-duration-seconds 3153600000"))); }
    #[test] fn r028_silent_when_no_zen_section() {
        let f = ParsedFile { path: r"C:\Project\Config\DefaultEngine.ini".into(), category: Category::Project, sections: vec![] };
        assert_silent("R028", &f);
    }

    // ── 引擎基线整族抑制（派发层按 Category::Engine 一处门控）─────────────────────
    // 引擎出厂 BaseEngine.ini 是只读基线（Volo 从不改它），其 Shared 节点策略 + 留存默认都不是团队
    // 可操作的配置 → R011–R023 / R027 / R028 在引擎层一律静默。R021 也不例外（即便手改成盘符路径，
    // 引擎文件不是 Volo 的修复目标，统一不报，避免与 R015/R027/R028 行为不一致）。
    fn ddb_engine(node_raw: &str) -> ParsedFile {
        ParsedFile { category: Category::Engine,
            path: r"D:\Program Files\Epic Games\UE_5.7\Engine\Config\BaseEngine.ini".into(),
            ..ddb_project(node_raw) }
    }
    #[test] fn r015_silent_on_engine() { assert_silent("R015", &ddb_engine(r"Shared=(Type=FileSystem, Path=?EpicDDC)")); }
    #[test] fn r021_silent_on_engine() { assert_silent("R021", &ddb_engine(r"Shared=(Type=FileSystem, Path=Z:\DDC)")); }
    #[test] fn r027_silent_on_engine() { assert_silent("R027", &ddb_engine(r"Shared=(Type=FileSystem, Path=?EpicDDC)")); }
    #[test] fn r028_silent_on_engine() {
        let mut f = zen_autolaunch(Some("--gc-cache-duration-seconds 1209600"));
        f.category = Category::Engine;
        f.path = r"D:\Program Files\Epic Games\UE_5.7\Engine\Config\BaseEngine.ini".into();
        assert_silent("R028", &f);
    }

    #[test]
    fn r025_fires_when_project_shared_pref_masks_env() {
        let f = ParsedFile {
            path: r"C:\Users\op\AppData\Local\UnrealEngine\5.5\Saved\Config\WindowsEditor\EditorPerProjectUserSettings.ini".into(),
            category: Category::User,
            sections: vec![ParsedSection {
                name: "/Script/UnrealEd.EditorSettings".into(),
                keys: vec![ParsedKey { name: "ProjectSharedDDCPath".into(), value: r"\\WRONG\DDC".into(), line_number: 4 }],
                backend_nodes: vec![],
            }],
        };
        let env = EnvVarState { shared_data_cache_path: Some(r"\\RIGHT\DDC".into()), local_data_cache_path: None };
        let findings = run_rules(&f, &env);
        assert!(findings.iter().any(|x| x.rule_id == "R025" && x.severity == Severity::Critical));
    }
}
