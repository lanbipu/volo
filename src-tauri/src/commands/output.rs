//! Thin Tauri transport for the output orchestrator in `mesh-app`.

use cache_core::core::ssh::{run_json, scp_push_file, NodeScript, SshExecutor};
use mesh_app::output::{self, OutputTransport, PublishResult, RuntimePaths};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;
use volo_shared::dto::{OutputNode, ScreenConfig};
use volo_shared::error::{VoloError, VoloResult};

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
        // The wall-clock floor prevents a deleted state file or fast app restart
        // from returning to small revisions. It remains within Blueprint int32
        // through 2038; fail explicitly after that instead of wrapping.
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
        // Reserve before any remote write. A failed/partially visible revision is never reused.
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
    pub screen: ScreenConfig,
    pub paths: RuntimePaths,
    #[serde(default)]
    pub ssh_user: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PublishRequest {
    pub session_id: String,
    pub screen: ScreenConfig,
    pub paths: RuntimePaths,
    #[serde(default)]
    pub ssh_user: Option<String>,
    #[serde(default)]
    pub image_path: Option<PathBuf>,
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
            .map_err(|e| e.to_string())
    }

    fn run(
        &self,
        node: &OutputNode,
        action: &'static str,
        paths: &RuntimePaths,
        extra: serde_json::Value,
    ) -> Result<ScriptEnvelope, String> {
        let mut args = serde_json::json!({
            "action": action,
            "node_id": node.node_id,
            "editor_path": paths.editor_path,
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

impl OutputTransport for SshOutputTransport {
    fn preflight(&self, node: &OutputNode, paths: &RuntimePaths) -> Result<String, String> {
        self.run(node, "preflight", paths, serde_json::json!({}))
            .map(|x| x.message)
    }
    fn start(&self, node: &OutputNode, paths: &RuntimePaths) -> Result<(bool, String), String> {
        self.run(node, "start", paths, serde_json::json!({}))
            .map(|x| (x.cluster_connected, x.message))
    }
    fn stop(&self, node: &OutputNode, paths: &RuntimePaths) -> Result<String, String> {
        self.run(node, "stop", paths, serde_json::json!({}))
            .map(|x| x.message)
    }
    fn push_file(&self, node: &OutputNode, local: &Path, remote: &str) -> Result<(), String> {
        let user = self.ssh_user.as_deref().unwrap_or(&self.exec.default_user);
        scp_push_file(
            &self.exec.key_path,
            &self.exec.known_hosts,
            user,
            &output::node_host(node),
            local,
            &remote.replace('\\', "/"),
        )
        .map_err(|e| e.to_string())
    }
    fn publish_manifest(
        &self,
        node: &OutputNode,
        manifest_path: &str,
        manifest_json: &str,
    ) -> Result<String, String> {
        let paths = RuntimePaths {
            editor_path: String::new(),
            project_path: String::new(),
            config_path: String::new(),
            manifest_path: manifest_path.into(),
            image_dir: String::new(),
        };
        self.run(
            node,
            "publish",
            &paths,
            serde_json::json!({"manifest_json": manifest_json}),
        )
        .map(|x| x.message)
    }
}

fn transport(user: Option<String>) -> VoloResult<SshOutputTransport> {
    SshOutputTransport::new(user).map_err(VoloError::Other)
}

#[tauri::command]
pub async fn output_preflight(request: RuntimeRequest) -> VoloResult<Vec<output::NodeResult>> {
    tokio::task::spawn_blocking(move || {
        output::preflight(
            &transport(request.ssh_user)?,
            &request.screen,
            &request.paths,
        )
    })
    .await
    .map_err(|e| VoloError::Other(format!("output preflight task failed: {e}")))?
}

#[tauri::command]
pub async fn output_start(request: RuntimeRequest) -> VoloResult<Vec<output::NodeResult>> {
    tokio::task::spawn_blocking(move || {
        output::start(
            &transport(request.ssh_user)?,
            &request.screen,
            &request.paths,
        )
    })
    .await
    .map_err(|e| VoloError::Other(format!("output start task failed: {e}")))?
}

#[tauri::command]
pub async fn output_stop(request: RuntimeRequest) -> VoloResult<Vec<output::NodeResult>> {
    tokio::task::spawn_blocking(move || {
        output::stop(
            &transport(request.ssh_user)?,
            &request.screen,
            &request.paths,
        )
    })
    .await
    .map_err(|e| VoloError::Other(format!("output stop task failed: {e}")))?
}

#[tauri::command]
pub async fn output_show(
    sessions: State<'_, OutputSessions>,
    request: PublishRequest,
) -> VoloResult<PublishResult> {
    let revision = sessions.reserve_revision(&request.session_id)?;
    let image = request
        .image_path
        .clone()
        .ok_or_else(|| VoloError::InvalidInput("image_path is required for show".into()))?;
    tokio::task::spawn_blocking(move || {
        output::show(
            &transport(request.ssh_user)?,
            &request.screen,
            &request.paths,
            &image,
            revision,
        )
    })
    .await
    .map_err(|e| VoloError::Other(format!("output show task failed: {e}")))?
}

#[tauri::command]
pub async fn output_clear(
    sessions: State<'_, OutputSessions>,
    request: PublishRequest,
) -> VoloResult<PublishResult> {
    let revision = sessions.reserve_revision(&request.session_id)?;
    tokio::task::spawn_blocking(move || {
        output::clear(
            &transport(request.ssh_user)?,
            &request.screen,
            &request.paths,
            revision,
        )
    })
    .await
    .map_err(|e| VoloError::Other(format!("output clear task failed: {e}")))?
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
}
