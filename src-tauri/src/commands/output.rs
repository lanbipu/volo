//! Thin Tauri transport for the output orchestrator in `mesh-app`.

use cache_core::core::ssh::{run_json, scp_push_file, NodeScript, SshExecutor};
use mesh_app::output::{self, OutputTransport, RuntimePaths};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use volo_shared::dto::{OutputNode, ScreenConfig};
use volo_shared::error::{VoloError, VoloResult};

const NODE_EVENT: &str = "ndisplay-output-event";
const RUNNER_EVENT: &str = "ndisplay-output-runner";

#[derive(Clone, Default)]
pub struct OutputSessions {
    revisions: Arc<Mutex<BTreeMap<String, u64>>>,
    state_path: Option<Arc<PathBuf>>,
}

impl OutputSessions {
    pub fn from_config() -> VoloResult<Self> {
        let config_dir = cache_core::startup::resolve_config_dir()
            .map_err(|error| VoloError::Other(error.to_string()))?;
        std::fs::create_dir_all(&config_dir)?;
        let state_path = config_dir.join("output-revisions.json");
        let revisions = if state_path.is_file() {
            serde_json::from_slice(&std::fs::read(&state_path)?).map_err(|error| {
                VoloError::Other(format!(
                    "invalid output revision state {}: {error}",
                    state_path.display()
                ))
            })?
        } else {
            BTreeMap::new()
        };
        Ok(Self {
            revisions: Arc::new(Mutex::new(revisions)),
            state_path: Some(Arc::new(state_path)),
        })
    }

    fn reserve_revision(&self, session_id: &str) -> VoloResult<u64> {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Err(VoloError::InvalidInput(
                "session_id must not be empty".into(),
            ));
        }
        let mut revisions = self
            .revisions
            .lock()
            .map_err(|_| VoloError::Other("output session registry poisoned".into()))?;
        let epoch_seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| VoloError::Other(format!("system clock before Unix epoch: {error}")))?
            .as_secs();
        let revision = revisions
            .get(session_id)
            .copied()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| VoloError::Other("output revision overflow".into()))?
            .max(epoch_seconds);
        if revision > i32::MAX as u64 {
            return Err(VoloError::Other(
                "output revision exceeds Blueprint Integer range".into(),
            ));
        }
        let previous = revisions.insert(session_id.to_string(), revision);
        if let Some(path) = &self.state_path {
            let encoded = serde_json::to_vec(&*revisions)?;
            if let Err(error) = std::fs::write(path.as_ref(), encoded) {
                match previous {
                    Some(value) => {
                        revisions.insert(session_id.to_string(), value);
                    }
                    None => {
                        revisions.remove(session_id);
                    }
                }
                return Err(VoloError::Io(format!(
                    "persist output revision state {}: {error}",
                    path.display()
                )));
            }
        }
        Ok(revision)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct RuntimeRequest {
    pub session_id: String,
    pub screen: ScreenConfig,
    pub paths: RuntimePaths,
    #[serde(default)]
    pub ssh_user: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeployRequest {
    pub session_id: String,
    pub screen: ScreenConfig,
    pub paths: RuntimePaths,
    pub ue_version: String,
    #[serde(default)]
    pub ssh_user: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputMode {
    Show,
    Clear,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ShowRequest {
    pub session_id: String,
    pub screen: ScreenConfig,
    pub paths: RuntimePaths,
    pub mode: OutputMode,
    #[serde(default)]
    pub image_path: Option<PathBuf>,
    #[serde(default)]
    pub ssh_user: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputCommandResult {
    pub session_id: String,
    pub operation: String,
    pub revision: Option<u64>,
    pub remote_image_path: Option<String>,
    pub nodes: Vec<output::NodeResult>,
}

#[derive(Debug, Clone, Serialize)]
struct NodeEventPayload {
    session_id: String,
    operation: String,
    node_id: String,
    host: String,
    state: String,
    message: String,
    revision: Option<u64>,
    timestamp_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
struct RunnerEventPayload {
    session_id: String,
    operation: String,
    state: String,
    completed: usize,
    total: usize,
    message: String,
    revision: Option<u64>,
    timestamp_ms: u128,
}

#[derive(Debug, Deserialize)]
struct ScriptEnvelope {
    ok: bool,
    message: String,
    #[serde(default)]
    cluster_connected: bool,
}

struct SshOutputTransport {
    exec: SshExecutor,
    ssh_user: Option<String>,
}

impl SshOutputTransport {
    fn new(ssh_user: Option<String>) -> Result<Self, String> {
        SshExecutor::from_config()
            .map(|exec| Self { exec, ssh_user })
            .map_err(|error| error.to_string())
    }

    fn run(
        &self,
        node: &OutputNode,
        action: &'static str,
        paths: &RuntimePaths,
        extra: serde_json::Value,
    ) -> Result<ScriptEnvelope, String> {
        let editor_path = editor_path_for_node(paths, &node.node_id);
        let mut args = serde_json::json!({
            "action": action,
            "node_id": node.node_id,
            "editor_path": editor_path,
            "project_path": paths.project_path,
            "config_path": paths.config_path,
            "manifest_path": paths.manifest_path,
            "image_dir": paths.image_dir,
            "window_width": node.window_px[0],
            "window_height": node.window_px[1]
        });
        if let (Some(target), Some(source)) = (args.as_object_mut(), extra.as_object()) {
            target.extend(source.clone());
        }
        let script = NodeScript {
            name: "output-runtime.ps1",
            args,
            ssh_user: self.ssh_user.clone(),
        };
        let envelope: ScriptEnvelope =
            run_json(&self.exec, &output::node_host(node), &script).map_err(|e| e.to_string())?;
        if envelope.ok {
            Ok(envelope)
        } else {
            Err(envelope.message)
        }
    }
}

fn editor_path_for_node<'a>(paths: &'a RuntimePaths, node_id: &str) -> &'a str {
    paths
        .editor_paths
        .get(node_id)
        .map(String::as_str)
        .unwrap_or(&paths.editor_path)
}

impl OutputTransport for SshOutputTransport {
    fn preflight(&self, node: &OutputNode, paths: &RuntimePaths) -> Result<String, String> {
        self.run(node, "preflight", paths, serde_json::json!({}))
            .map(|x| x.message)
    }
    fn launch(&self, node: &OutputNode, paths: &RuntimePaths) -> Result<String, String> {
        self.run(node, "launch", paths, serde_json::json!({}))
            .map(|x| x.message)
    }
    fn wait_evidence(
        &self,
        node: &OutputNode,
        paths: &RuntimePaths,
    ) -> Result<(bool, String), String> {
        self.run(node, "wait_evidence", paths, serde_json::json!({}))
            .map(|x| (x.cluster_connected, x.message))
    }
    fn stop(&self, node: &OutputNode, paths: &RuntimePaths) -> Result<String, String> {
        self.run(node, "stop", paths, serde_json::json!({}))
            .map(|x| x.message)
    }
    fn prepare_deploy(&self, node: &OutputNode, paths: &RuntimePaths) -> Result<String, String> {
        self.run(node, "prepare_deploy", paths, serde_json::json!({}))
            .map(|x| x.message)
    }
    fn push_file(&self, node: &OutputNode, local: &Path, remote: &str) -> Result<(), String> {
        let user = self.ssh_user.as_deref().unwrap_or(&self.exec.default_user);
        // 本地路径可能来自 canonicalize/resource_dir，Windows 上带 \\?\ verbatim
        // 前缀会让 scp 把冒号解析成远程主机分隔符——统一在传输层剥掉。
        let local = strip_verbatim(local.to_path_buf());
        scp_push_file(
            &self.exec.key_path,
            &self.exec.known_hosts,
            user,
            &output::node_host(node),
            &local,
            &remote.replace('\\', "/"),
        )
        .map_err(|error| error.to_string())
    }
    fn publish_text(
        &self,
        node: &OutputNode,
        remote_path: &str,
        content: &str,
    ) -> Result<String, String> {
        let empty_paths = RuntimePaths {
            editor_path: String::new(),
            editor_paths: Default::default(),
            project_path: String::new(),
            config_path: remote_path.into(),
            manifest_path: String::new(),
            image_dir: String::new(),
        };
        self.run(
            node,
            "publish_text",
            &empty_paths,
            serde_json::json!({"content": content}),
        )
        .map(|x| x.message)
    }
    fn publish_manifest(
        &self,
        node: &OutputNode,
        manifest_path: &str,
        manifest_json: &str,
    ) -> Result<String, String> {
        let empty_paths = RuntimePaths {
            editor_path: String::new(),
            editor_paths: Default::default(),
            project_path: String::new(),
            config_path: String::new(),
            manifest_path: manifest_path.into(),
            image_dir: String::new(),
        };
        self.run(
            node,
            "publish",
            &empty_paths,
            serde_json::json!({"manifest_json": manifest_json}),
        )
        .map(|x| x.message)
    }
}

fn transport(user: Option<String>) -> VoloResult<SshOutputTransport> {
    SshOutputTransport::new(user).map_err(VoloError::Other)
}

fn timestamp_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn node_count(screen: &ScreenConfig) -> usize {
    screen
        .output_topology
        .as_ref()
        .map(|topology| topology.nodes.len())
        .unwrap_or(0)
}

fn emit_runner(
    app: &AppHandle,
    session_id: &str,
    operation: &str,
    state: &str,
    completed: usize,
    total: usize,
    message: impl Into<String>,
    revision: Option<u64>,
) {
    let _ = app.emit(
        RUNNER_EVENT,
        RunnerEventPayload {
            session_id: session_id.into(),
            operation: operation.into(),
            state: state.into(),
            completed,
            total,
            message: message.into(),
            revision,
            timestamp_ms: timestamp_ms(),
        },
    );
}

fn finish_operation(
    app: &AppHandle,
    session_id: String,
    operation: &str,
    revision: Option<u64>,
    remote_image_path: Option<String>,
    total: usize,
    result: VoloResult<Vec<output::NodeResult>>,
) -> VoloResult<OutputCommandResult> {
    match result {
        Ok(nodes) => {
            for node in &nodes {
                let _ = app.emit(
                    NODE_EVENT,
                    NodeEventPayload {
                        session_id: session_id.clone(),
                        operation: operation.into(),
                        node_id: node.node_id.clone(),
                        host: node.host.clone(),
                        state: "ok".into(),
                        message: node.message.clone(),
                        revision,
                        timestamp_ms: timestamp_ms(),
                    },
                );
            }
            emit_runner(
                app,
                &session_id,
                operation,
                "ok",
                nodes.len(),
                total,
                "操作完成",
                revision,
            );
            Ok(OutputCommandResult {
                session_id,
                operation: operation.into(),
                revision,
                remote_image_path,
                nodes,
            })
        }
        Err(error) => {
            tracing::error!("ndisplay output {operation} failed: {error}");
            emit_runner(
                app,
                &session_id,
                operation,
                "error",
                0,
                total,
                error.to_string(),
                revision,
            );
            Err(error)
        }
    }
}

/// Windows `resource_dir()` can come back verbatim-prefixed (`\\?\C:\...`);
/// scp parses the `:` in that prefix as a remote-host separator, so strip it.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(stripped) => PathBuf::from(stripped),
        None => path,
    }
}

fn template_root(app: &AppHandle) -> VoloResult<PathBuf> {
    let bundled = strip_verbatim(
        app.path()
            .resource_dir()
            .map_err(|error| VoloError::Io(error.to_string()))?
            .join("ue-template/VoloOutput"),
    );
    if bundled.is_dir() {
        return Ok(bundled);
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/ue-template/VoloOutput");
    if dev.is_dir() {
        Ok(dev)
    } else {
        Err(VoloError::NotFound(format!(
            "VoloOutput template not found at {} or {}",
            bundled.display(),
            dev.display()
        )))
    }
}

#[tauri::command]
pub async fn output_preflight(
    app: AppHandle,
    request: RuntimeRequest,
) -> VoloResult<OutputCommandResult> {
    let total = node_count(&request.screen);
    emit_runner(
        &app,
        &request.session_id,
        "preflight",
        "running",
        0,
        total,
        "正在预检",
        None,
    );
    let session_id = request.session_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        output::preflight(
            &transport(request.ssh_user)?,
            &request.screen,
            &request.paths,
        )
    })
    .await
    .map_err(|error| VoloError::Other(format!("output preflight task failed: {error}")))?;
    finish_operation(&app, session_id, "preflight", None, None, total, result)
}

#[tauri::command]
pub async fn output_deploy(
    app: AppHandle,
    request: DeployRequest,
) -> VoloResult<OutputCommandResult> {
    let total = node_count(&request.screen);
    emit_runner(
        &app,
        &request.session_id,
        "deploy",
        "running",
        0,
        total,
        "正在部署",
        None,
    );
    let root = template_root(&app)?;
    let session_id = request.session_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        output::deploy(
            &transport(request.ssh_user)?,
            &request.screen,
            &request.paths,
            &root,
            &request.ue_version,
        )
    })
    .await
    .map_err(|error| VoloError::Other(format!("output deploy task failed: {error}")))?;
    finish_operation(&app, session_id, "deploy", None, None, total, result)
}

#[tauri::command]
pub async fn output_start(
    app: AppHandle,
    sessions: State<'_, OutputSessions>,
    request: RuntimeRequest,
) -> VoloResult<OutputCommandResult> {
    let total = node_count(&request.screen);
    emit_runner(
        &app,
        &request.session_id,
        "start",
        "running",
        0,
        total,
        "正在启动",
        None,
    );
    // 上一会话的 manifest（mode=show）残留在节点上；新 UE 的 LastRevision=-1
    // 会把它当新指令立即上屏旧图。启动前先发布 clear，保证起始为黑场。
    let clear_revision = sessions.reserve_revision(&request.session_id)?;
    let session_id = request.session_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let transport = transport(request.ssh_user)?;
        output::clear(&transport, &request.screen, &request.paths, clear_revision)?;
        output::start(&transport, &request.screen, &request.paths)
    })
    .await
    .map_err(|error| VoloError::Other(format!("output start task failed: {error}")))?;
    finish_operation(&app, session_id, "start", None, None, total, result)
}

#[tauri::command]
pub async fn output_show(
    app: AppHandle,
    sessions: State<'_, OutputSessions>,
    request: ShowRequest,
) -> VoloResult<OutputCommandResult> {
    let revision = sessions.reserve_revision(&request.session_id)?;
    let operation = match request.mode {
        OutputMode::Show => "show",
        OutputMode::Clear => "clear",
    };
    let total = node_count(&request.screen);
    emit_runner(
        &app,
        &request.session_id,
        operation,
        "running",
        0,
        total,
        "正在发布",
        Some(revision),
    );
    let session_id = request.session_id.clone();
    let result = tokio::task::spawn_blocking(move || match request.mode {
        OutputMode::Show => {
            let image = request.image_path.ok_or_else(|| {
                VoloError::InvalidInput("image_path is required when mode=show".into())
            })?;
            let published = output::show(
                &transport(request.ssh_user)?,
                &request.screen,
                &request.paths,
                &image,
                revision,
            )?;
            Ok((published.nodes, published.remote_image_path))
        }
        OutputMode::Clear => {
            if request.image_path.is_some() {
                return Err(VoloError::InvalidInput(
                    "image_path must be empty when mode=clear".into(),
                ));
            }
            let published = output::clear(
                &transport(request.ssh_user)?,
                &request.screen,
                &request.paths,
                revision,
            )?;
            Ok((published.nodes, None))
        }
    })
    .await
    .map_err(|error| VoloError::Other(format!("output show task failed: {error}")))?;
    match result {
        Ok((nodes, remote_image_path)) => finish_operation(
            &app,
            session_id,
            operation,
            Some(revision),
            remote_image_path,
            total,
            Ok(nodes),
        ),
        Err(error) => finish_operation(
            &app,
            session_id,
            operation,
            Some(revision),
            None,
            total,
            Err(error),
        ),
    }
}

#[tauri::command]
pub async fn output_stop(
    app: AppHandle,
    request: RuntimeRequest,
) -> VoloResult<OutputCommandResult> {
    let total = node_count(&request.screen);
    emit_runner(
        &app,
        &request.session_id,
        "stop",
        "running",
        0,
        total,
        "正在停止",
        None,
    );
    let session_id = request.session_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        output::stop(
            &transport(request.ssh_user)?,
            &request.screen,
            &request.paths,
        )
    })
    .await
    .map_err(|error| VoloError::Other(format!("output stop task failed: {error}")))?;
    finish_operation(&app, session_id, "stop", None, None, total, result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revisions_are_monotonic_per_session_and_independent_between_sessions() {
        let sessions = OutputSessions::default();
        let first = sessions.reserve_revision("screen-a").unwrap();
        assert_eq!(sessions.reserve_revision("screen-a").unwrap(), first + 1);
        assert!(sessions.reserve_revision("screen-b").unwrap() >= first);
    }

    #[test]
    fn blank_session_id_is_rejected() {
        assert!(OutputSessions::default().reserve_revision("  ").is_err());
    }

    #[test]
    fn node_editor_path_overrides_compatibility_fallback() {
        let paths = RuntimePaths {
            editor_path: r"C:\fallback\UnrealEditor.exe".into(),
            editor_paths: std::collections::BTreeMap::from([(
                "RazerNode".into(),
                r"D:\UE_5.8\Engine\Binaries\Win64\UnrealEditor.exe".into(),
            )]),
            project_path: String::new(),
            config_path: String::new(),
            manifest_path: String::new(),
            image_dir: String::new(),
        };
        assert_eq!(
            editor_path_for_node(&paths, "RazerNode"),
            r"D:\UE_5.8\Engine\Binaries\Win64\UnrealEditor.exe"
        );
        assert_eq!(
            editor_path_for_node(&paths, "LanNode"),
            r"C:\fallback\UnrealEditor.exe"
        );
    }
}
