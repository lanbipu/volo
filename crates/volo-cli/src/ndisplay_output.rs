//! `voloctl output …` — nDisplay output runtime CLI (thin transport over mesh-app).

use cache_core::core::ssh::{run_json, scp_push_file, NodeScript, SshExecutor};
use clap::{Parser, Subcommand};
use mesh_app::output::{self, OutputTransport, RuntimePaths};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use volo_shared::dto::{OutputNode, ScreenConfig};
use volo_shared::error::{VoloError, VoloResult};

const DEFAULT_EDITOR: &str =
    r"D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor.exe";
const DEFAULT_PROJECT: &str =
    r"C:\ProgramData\UECM\ndisplay-output\VoloOutput\VoloOutput.uproject";
const DEFAULT_CONFIG: &str =
    r"C:\ProgramData\UECM\ndisplay-output\VoloOutput\Config\VoloOutput.ndisplay";
const DEFAULT_MANIFEST: &str = r"C:\ProgramData\UECM\ndisplay-output\session\manifest.json";
const DEFAULT_IMAGE_DIR: &str = r"C:\ProgramData\UECM\ndisplay-output\session\frames";

#[derive(Debug, Parser)]
#[command(name = "output", about = "nDisplay output runtime (show / sequence / start)")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Preflight SSH / UE / directories on every topology node.
    Preflight {
        #[command(flatten)]
        common: CommonArgs,
    },
    /// Stop UE processes for the project on every node.
    Stop {
        #[command(flatten)]
        common: CommonArgs,
    },
    /// Start the nDisplay cluster (secondary-first launch + evidence wait).
    Start {
        #[command(flatten)]
        common: CommonArgs,
    },
    /// Push a static PNG and atomically publish mode=show manifests.
    Show {
        #[command(flatten)]
        common: CommonArgs,
        /// Local PNG (full composite canvas).
        #[arg(long)]
        image: PathBuf,
    },
    /// Publish mode=clear (blackout) on every node.
    Clear {
        #[command(flatten)]
        common: CommonArgs,
    },
    /// Push a PNG sequence and wait for cluster ready/done milestones.
    #[command(name = "play-sequence")]
    PlaySequence {
        #[command(flatten)]
        common: CommonArgs,
        #[arg(long)]
        sequence_dir: PathBuf,
        #[arg(long, default_value_t = 2.0)]
        fps: f64,
        #[arg(long, default_value_t = 0)]
        origin_x: u32,
        #[arg(long, default_value_t = 0)]
        origin_y: u32,
    },
    /// Abort sequence playback (mode=clear).
    Abort {
        #[command(flatten)]
        common: CommonArgs,
    },
    /// Push UE template (uproject/config/content/binaries) + generated .ndisplay.
    Deploy {
        #[command(flatten)]
        common: CommonArgs,
        #[arg(long)]
        template_root: PathBuf,
        #[arg(long, default_value = "5.8")]
        ue_version: String,
    },
}

#[derive(Debug, Clone, clap::Args)]
pub struct CommonArgs {
    #[arg(long)]
    session_id: String,
    #[arg(long)]
    screen_json: PathBuf,
    #[arg(long)]
    ssh_user: Option<String>,
    /// Compatibility fallback when a node has no `--editor-for` override.
    #[arg(long, default_value = DEFAULT_EDITOR)]
    editor_path: String,
    /// Per-node UnrealEditor.exe override: `NodeId=C:\path\UnrealEditor.exe` (repeatable).
    #[arg(long = "editor-for", value_name = "NODE=PATH")]
    editor_for: Vec<String>,
    #[arg(long, default_value = DEFAULT_PROJECT)]
    project_path: String,
    #[arg(long, default_value = DEFAULT_CONFIG)]
    config_path: String,
    #[arg(long, default_value = DEFAULT_MANIFEST)]
    manifest_path: String,
    #[arg(long, default_value = DEFAULT_IMAGE_DIR)]
    image_dir: String,
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
        let mut args = serde_json::json!({
            "action": action,
            "node_id": node.node_id,
            "editor_path": paths.editor_for(&node.node_id),
            "project_path": paths.project_path,
            "config_path": paths.config_path,
            "manifest_path": paths.manifest_path,
            "image_dir": paths.image_dir,
            "window_width": node.window_px[0],
            "window_height": node.window_px[1],
            "window_x": node.window_origin_px[0],
            "window_y": node.window_origin_px[1]
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
    fn launch(
        &self,
        node: &OutputNode,
        paths: &RuntimePaths,
        clear_manifest_json: Option<&str>,
    ) -> Result<String, String> {
        let extra = match clear_manifest_json {
            Some(manifest_json) => serde_json::json!({ "clear_manifest_json": manifest_json }),
            None => serde_json::json!({}),
        };
        self.run(node, "launch", paths, extra).map(|x| x.message)
    }
    fn wait_evidence(
        &self,
        node: &OutputNode,
        paths: &RuntimePaths,
    ) -> Result<(bool, String), String> {
        self.run(node, "wait_evidence", paths, serde_json::json!({}))
            .map(|x| (x.cluster_connected, x.message))
    }
    fn wait_log_pattern(
        &self,
        node: &OutputNode,
        paths: &RuntimePaths,
        pattern: &str,
        timeout_secs: u64,
    ) -> Result<String, String> {
        self.run(
            node,
            "wait_log",
            paths,
            serde_json::json!({
                "pattern": pattern,
                "timeout_secs": timeout_secs
            }),
        )
        .map(|x| x.message)
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
        scp_push_file(
            &self.exec.key_path,
            &self.exec.known_hosts,
            user,
            &output::node_host(node),
            local,
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

fn load_screen(path: &Path) -> VoloResult<ScreenConfig> {
    let text = std::fs::read_to_string(path).map_err(|error| {
        VoloError::Io(format!("read screen json {}: {error}", path.display()))
    })?;
    serde_json::from_str(&text).map_err(|error| {
        VoloError::InvalidInput(format!("invalid screen json {}: {error}", path.display()))
    })
}

fn parse_editor_for(entries: &[String]) -> VoloResult<BTreeMap<String, String>> {
    let mut map = BTreeMap::new();
    for entry in entries {
        let (node, path) = entry.split_once('=').ok_or_else(|| {
            VoloError::InvalidInput(format!(
                "--editor-for expects NODE=PATH, got '{entry}'"
            ))
        })?;
        let node = node.trim();
        let path = path.trim();
        if node.is_empty() || path.is_empty() {
            return Err(VoloError::InvalidInput(format!(
                "--editor-for expects NODE=PATH, got '{entry}'"
            )));
        }
        map.insert(node.to_string(), path.to_string());
    }
    Ok(map)
}

fn runtime_paths(common: &CommonArgs) -> VoloResult<RuntimePaths> {
    Ok(RuntimePaths {
        editor_path: common.editor_path.clone(),
        editor_paths: parse_editor_for(&common.editor_for)?,
        project_path: common.project_path.clone(),
        config_path: common.config_path.clone(),
        manifest_path: common.manifest_path.clone(),
        image_dir: common.image_dir.clone(),
    })
}

fn reserve_revision(session_id: &str) -> VoloResult<u64> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err(VoloError::InvalidInput(
            "session_id must not be empty".into(),
        ));
    }
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| VoloError::Other(format!("system clock before Unix epoch: {error}")))?
        .as_secs();
    Ok(epoch.max(1))
}

fn transport(user: Option<String>) -> VoloResult<SshOutputTransport> {
    SshOutputTransport::new(user).map_err(VoloError::Other)
}

/// Dispatch `voloctl output …`. Returns process exit code.
pub fn dispatch(cli: Cli) -> i32 {
    match run(cli) {
        Ok(summary) => {
            println!("{summary}");
            0
        }
        Err(error) => {
            eprintln!("voloctl output: {error}");
            1
        }
    }
}

fn run(cli: Cli) -> VoloResult<String> {
    match cli.command {
        Command::Preflight { common } => {
            let screen = load_screen(&common.screen_json)?;
            let paths = runtime_paths(&common)?;
            let nodes = output::preflight(&transport(common.ssh_user)?, &screen, &paths)?;
            Ok(serde_json::json!({
                "session_id": common.session_id,
                "operation": "preflight",
                "nodes": nodes,
            })
            .to_string())
        }
        Command::Stop { common } => {
            let screen = load_screen(&common.screen_json)?;
            let paths = runtime_paths(&common)?;
            let nodes = output::stop(&transport(common.ssh_user)?, &screen, &paths)?;
            Ok(serde_json::json!({
                "session_id": common.session_id,
                "operation": "stop",
                "nodes": nodes,
            })
            .to_string())
        }
        Command::Start { common } => {
            let screen = load_screen(&common.screen_json)?;
            let paths = runtime_paths(&common)?;
            let clear_revision = reserve_revision(&common.session_id)?;
            eprintln!("starting cluster (clear_revision={clear_revision})…");
            let nodes = output::start(
                &transport(common.ssh_user)?,
                &screen,
                &paths,
                Some(clear_revision),
            )?;
            Ok(serde_json::json!({
                "session_id": common.session_id,
                "operation": "start",
                "revision": clear_revision,
                "nodes": nodes,
            })
            .to_string())
        }
        Command::Show { common, image } => {
            let screen = load_screen(&common.screen_json)?;
            let paths = runtime_paths(&common)?;
            let revision = reserve_revision(&common.session_id)?;
            eprintln!("show {} (revision={revision})…", image.display());
            let published =
                output::show(&transport(common.ssh_user)?, &screen, &paths, &image, revision)?;
            Ok(serde_json::json!({
                "session_id": common.session_id,
                "operation": "show",
                "revision": published.revision,
                "remote_image_path": published.remote_image_path,
                "nodes": published.nodes,
            })
            .to_string())
        }
        Command::Clear { common } => {
            let screen = load_screen(&common.screen_json)?;
            let paths = runtime_paths(&common)?;
            let revision = reserve_revision(&common.session_id)?;
            let published = output::clear(&transport(common.ssh_user)?, &screen, &paths, revision)?;
            Ok(serde_json::json!({
                "session_id": common.session_id,
                "operation": "clear",
                "revision": published.revision,
                "nodes": published.nodes,
            })
            .to_string())
        }
        Command::PlaySequence {
            common,
            sequence_dir,
            fps,
            origin_x,
            origin_y,
        } => {
            let screen = load_screen(&common.screen_json)?;
            let paths = runtime_paths(&common)?;
            let revision = reserve_revision(&common.session_id)?;
            let transport = transport(common.ssh_user)?;
            let frames = output::list_sequence_frames(&sequence_dir)?;
            let n_frames = u32::try_from(frames.len())
                .map_err(|_| VoloError::InvalidInput("sequence frame_count exceeds u32".into()))?;
            eprintln!("pushing {n_frames} frames (revision={revision})…");
            let published = output::push_sequence(
                &transport,
                &screen,
                &paths,
                &frames,
                [origin_x, origin_y],
                fps,
                revision,
            )?;
            eprintln!("preloading…");
            output::wait_sequence_ready(&transport, &screen, &paths, revision)?;
            eprintln!("playing…");
            let done = output::wait_sequence_done(
                &transport,
                &screen,
                &paths,
                revision,
                n_frames,
                fps,
            )?;
            Ok(serde_json::json!({
                "session_id": common.session_id,
                "operation": "play_sequence",
                "revision": revision,
                "remote_sequence_dir": published.remote_image_path,
                "nodes": done,
            })
            .to_string())
        }
        Command::Abort { common } => {
            let screen = load_screen(&common.screen_json)?;
            let paths = runtime_paths(&common)?;
            let revision = reserve_revision(&common.session_id)?;
            let published = output::clear(&transport(common.ssh_user)?, &screen, &paths, revision)?;
            Ok(serde_json::json!({
                "session_id": common.session_id,
                "operation": "sequence_abort",
                "revision": revision,
                "nodes": published.nodes,
            })
            .to_string())
        }
        Command::Deploy {
            common,
            template_root,
            ue_version,
        } => {
            let screen = load_screen(&common.screen_json)?;
            let paths = runtime_paths(&common)?;
            eprintln!(
                "deploying template {} (ue={ue_version})…",
                template_root.display()
            );
            let nodes = output::deploy(
                &transport(common.ssh_user)?,
                &screen,
                &paths,
                &template_root,
                &ue_version,
            )?;
            Ok(serde_json::json!({
                "session_id": common.session_id,
                "operation": "deploy",
                "nodes": nodes,
            })
            .to_string())
        }
    }
}
