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
    out.extend(pso_cvar_rule(
        file,
        "R008",
        "r.PSOPrecaching",
        Severity::Critical,
        "着色器（PSO）预缓存被关闭或没配置。",
        "要先打开运行时 PSO 预缓存，之后收集和分发的 PSO 缓存文件才有意义。",
    ));
    out.extend(pso_cvar_rule(
        file,
        "R009",
        "r.PSOPrecache.Compile",
        Severity::Warning,
        "PSO 预缓存编译被关闭或没配置。",
        "不同 UE 版本和工程配置可能默认关掉编译，除非显式打开。",
    ));
    out.extend(pso_cvar_rule(
        file,
        "R010",
        "r.PSOPrecache.GlobalShaders",
        Severity::Warning,
        "全局着色器 PSO 预缓存被关闭或没配置。",
        "打开全局着色器预缓存，有助于集群内各机器运行时 PSO 行为一致。",
    ));
    out.extend(rule_r011(file)); out.extend(rule_r012(file)); out.extend(rule_r013(file));
    out.extend(rule_r014(file)); out.extend(rule_r015(file)); out.extend(rule_r016(file));
    out.extend(rule_r017(file)); out.extend(rule_r018(file)); out.extend(rule_r019(file));
    out.extend(rule_r020(file)); out.extend(rule_r021(file)); out.extend(rule_r022(file));
    out.extend(rule_r023(file));
    out.extend(pso_cvar_rule(file, "R024", "r.ShaderPipelineCache.Enabled", Severity::Critical,
        "PSO 缓存文件的加载被关闭或没配置。",
        "没有这个控制台变量，收集来的 PSO 缓存文件在运行时不会被加载。"));
    out.extend(rule_r025(file, env));
    out.extend(rule_r027(file));
    out.extend(rule_r028(file));
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

fn pso_cvar_rule(
    file: &ParsedFile,
    rule_id: &str,
    key_name: &str,
    severity: Severity,
    symptom: &str,
    rationale: &str,
) -> Vec<Finding> {
    if !file
        .path
        .to_ascii_lowercase()
        .ends_with("consolevariables.ini")
    {
        return vec![];
    }

    let Some(section) = file
        .sections
        .iter()
        .find(|section| section.name.eq_ignore_ascii_case("ConsoleVariables"))
    else {
        return vec![pso_missing_finding(
            file, rule_id, key_name, severity, symptom, rationale, None,
        )];
    };

    match key(section, key_name) {
        Some(entry) if entry.value.trim() == "1" => vec![],
        Some(entry) => vec![Finding {
            rule_id: rule_id.into(),
            severity,
            category: file.category,
            file_path: file.path.clone(),
            section: Some(section.name.clone()),
            key_name: Some(entry.name.clone()),
            line_number: Some(entry.line_number as i64),
            snippet_before: format!("{}={}", entry.name, entry.value),
            snippet_after: Some(format!("{}=1", key_name)),
            recommended_action: RecommendedAction::Set,
            recommended_value: Some("1".into()),
            symptom: symptom.into(),
            rationale: rationale.into(),
        }],
        None => vec![pso_missing_finding(
            file,
            rule_id,
            key_name,
            severity,
            symptom,
            rationale,
            Some(section.name.clone()),
        )],
    }
}

fn pso_missing_finding(
    file: &ParsedFile,
    rule_id: &str,
    key_name: &str,
    severity: Severity,
    symptom: &str,
    rationale: &str,
    section: Option<String>,
) -> Finding {
    Finding {
        rule_id: rule_id.into(),
        severity,
        category: file.category,
        file_path: file.path.clone(),
        section: section.or_else(|| Some("ConsoleVariables".into())),
        key_name: Some(key_name.into()),
        line_number: None,
        snippet_before: "（未设置）".into(),
        snippet_after: Some(format!("{}=1", key_name)),
        recommended_action: RecommendedAction::Set,
        recommended_value: Some("1".into()),
        symptom: symptom.into(),
        rationale: rationale.into(),
    }
}

// ── BackendGraph helpers ─────────────────────────────────────────────────────

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

fn rule_r021(file: &ParsedFile) -> Vec<Finding> {
    let Some(n) = find_shared_backend(file) else { return vec![]; };
    let path = get_field(n, "Path").unwrap_or("");
    if !path.starts_with(r"\\") {
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
        ParsedFile {
            path: "C:\\Project\\Config\\ConsoleVariables.ini".into(),
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
    fn r008_reports_critical_when_pso_precaching_is_missing() {
        let file = console_variables(&[
            ("r.PSOPrecache.Compile", "1"),
            ("r.PSOPrecache.GlobalShaders", "1"),
        ]);
        let findings = run_rules(&file, &EnvVarState::default());
        assert!(findings
            .iter()
            .any(|f| f.rule_id == "R008" && f.severity == Severity::Critical));
    }

    #[test]
    fn r009_reports_warning_when_pso_compile_is_off() {
        let file = console_variables(&[
            ("r.PSOPrecaching", "1"),
            ("r.PSOPrecache.Compile", "0"),
            ("r.PSOPrecache.GlobalShaders", "1"),
        ]);
        let findings = run_rules(&file, &EnvVarState::default());
        assert!(findings
            .iter()
            .any(|f| f.rule_id == "R009" && f.recommended_action == RecommendedAction::Set));
    }

    #[test]
    fn r010_reports_warning_when_global_shader_pso_is_missing() {
        let file = console_variables(&[
            ("r.PSOPrecaching", "1"),
            ("r.PSOPrecache.Compile", "1"),
        ]);
        let findings = run_rules(&file, &EnvVarState::default());
        assert!(findings
            .iter()
            .any(|f| f.rule_id == "R010" && f.recommended_value.as_deref() == Some("1")));
    }

    #[test]
    fn pso_rules_are_clean_when_all_required_cvars_are_enabled() {
        let file = console_variables(&[
            ("r.PSOPrecaching", "1"),
            ("r.PSOPrecache.Compile", "1"),
            ("r.PSOPrecache.GlobalShaders", "1"),
        ]);
        let findings = run_rules(&file, &EnvVarState::default());
        assert!(!findings
            .iter()
            .any(|f| matches!(f.rule_id.as_str(), "R008" | "R009" | "R010")));
    }

    // ── R024: ShaderPipelineCache.Enabled ────────────────────────────────────

    #[test]
    fn r024_fires_when_shader_pipeline_cache_missing() {
        let f = console_variables(&[]);
        assert_fires("R024", &f);
    }

    #[test]
    fn r024_fires_when_shader_pipeline_cache_disabled() {
        let f = console_variables(&[("r.ShaderPipelineCache.Enabled", "0")]);
        assert_fires("R024", &f);
    }

    #[test]
    fn r024_silent_when_shader_pipeline_cache_enabled() {
        let f = console_variables(&[("r.ShaderPipelineCache.Enabled", "1")]);
        assert_silent("R024", &f);
    }

    #[test]
    fn r024_silent_for_non_consolevariables_file() {
        // R024's pso_cvar_rule wraps an early-return for non-CV files.
        let f = ParsedFile {
            path: r"C:\Project\Config\DefaultEngine.ini".into(),
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
