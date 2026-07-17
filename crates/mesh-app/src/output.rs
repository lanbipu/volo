//! Transport-agnostic orchestration for the nDisplay output runtime.

use crate::ndisplay::{generate_manifest_json, OutputManifestMode};
use std::collections::BTreeMap;
use std::path::Path;
use volo_shared::dto::{OutputNode, ScreenConfig};
use volo_shared::error::{VoloError, VoloResult};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RuntimePaths {
    pub editor_path: String,
    pub project_path: String,
    pub config_path: String,
    pub manifest_path: String,
    pub image_dir: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NodeResult {
    pub node_id: String,
    pub host: String,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PublishResult {
    pub revision: u64,
    pub remote_image_path: Option<String>,
    pub nodes: Vec<NodeResult>,
}

pub trait OutputTransport {
    fn preflight(&self, node: &OutputNode, paths: &RuntimePaths) -> Result<String, String>;
    fn start(&self, node: &OutputNode, paths: &RuntimePaths) -> Result<(bool, String), String>;
    fn stop(&self, node: &OutputNode, paths: &RuntimePaths) -> Result<String, String>;
    fn prepare_deploy(&self, node: &OutputNode, paths: &RuntimePaths) -> Result<String, String>;
    fn push_file(&self, node: &OutputNode, local: &Path, remote: &str) -> Result<(), String>;
    fn publish_text(
        &self,
        node: &OutputNode,
        remote_path: &str,
        content: &str,
    ) -> Result<String, String>;
    fn publish_manifest(
        &self,
        node: &OutputNode,
        manifest_path: &str,
        manifest_json: &str,
    ) -> Result<String, String>;
}

pub fn ordered_nodes(screen: &ScreenConfig) -> VoloResult<Vec<OutputNode>> {
    let report = crate::ndisplay::validate_topology(screen)?;
    if !report.errors.is_empty() {
        return Err(VoloError::InvalidInput(
            report
                .errors
                .iter()
                .map(|issue| format!("{}: {}", issue.code, issue.message))
                .collect::<Vec<_>>()
                .join("; "),
        ));
    }
    let mut nodes = screen
        .output_topology
        .as_ref()
        .expect("validated topology")
        .nodes
        .clone();
    nodes.sort_by(|a, b| a.primary.cmp(&b.primary).then(a.node_id.cmp(&b.node_id)));
    Ok(nodes)
}

pub fn preflight<T: OutputTransport>(
    transport: &T,
    screen: &ScreenConfig,
    paths: &RuntimePaths,
) -> VoloResult<Vec<NodeResult>> {
    ordered_nodes(screen)?
        .iter()
        .map(|node| map_node(node, transport.preflight(node, paths)))
        .collect()
}

pub fn deploy<T: OutputTransport>(
    transport: &T,
    screen: &ScreenConfig,
    paths: &RuntimePaths,
    template_root: &Path,
    ue_version: &str,
) -> VoloResult<Vec<NodeResult>> {
    let nodes = ordered_nodes(screen)?;
    let project_root = win_parent(&paths.project_path)
        .ok_or_else(|| VoloError::InvalidInput("project_path has no parent directory".into()))?;
    let files = [
        (
            template_root.join("VoloOutput.uproject"),
            paths.project_path.clone(),
        ),
        (
            template_root.join("Config/DefaultEngine.ini"),
            win_join(project_root, "Config\\DefaultEngine.ini"),
        ),
        (
            template_root.join("Config/DefaultRemoteControl.ini"),
            win_join(project_root, "Config\\DefaultRemoteControl.ini"),
        ),
        (
            template_root.join("Content/VoloOutput/BP_VoloOutput.uasset"),
            win_join(project_root, "Content\\VoloOutput\\BP_VoloOutput.uasset"),
        ),
    ];
    for (local, _) in &files {
        if !local.is_file() {
            return Err(VoloError::NotFound(local.display().to_string()));
        }
    }
    let resolved_ips = nodes
        .iter()
        .map(|node| (node.node_id.clone(), node_host(node)))
        .collect::<BTreeMap<_, _>>();
    let config = serde_json::to_string_pretty(&crate::ndisplay::generate_ndisplay_json(
        screen,
        &resolved_ips,
        ue_version,
    )?)?;

    let mut results = Vec::with_capacity(nodes.len());
    for node in &nodes {
        transport
            .prepare_deploy(node, paths)
            .map_err(|error| VoloError::Other(format!("prepare {}: {error}", node.node_id)))?;
        for (local, remote) in &files {
            transport
                .push_file(node, local, remote)
                .map_err(|error| VoloError::Other(format!("deploy {}: {error}", node.node_id)))?;
        }
        results.push(map_node(
            node,
            transport.publish_text(node, &paths.config_path, &config),
        )?);
    }
    Ok(results)
}

/// Starts secondaries first and the primary last. A live process is not enough:
/// the transport must return `cluster_connected=true`, sourced from UE log evidence.
pub fn start<T: OutputTransport>(
    transport: &T,
    screen: &ScreenConfig,
    paths: &RuntimePaths,
) -> VoloResult<Vec<NodeResult>> {
    ordered_nodes(screen)?
        .iter()
        .map(|node| {
            let (cluster_connected, message) = transport.start(node, paths).map_err(|error| {
                VoloError::Other(format!("{} ({}): {error}", node.node_id, node_host(node)))
            })?;
            if !cluster_connected {
                return Err(VoloError::Other(format!(
                    "{} ({}) started without cluster connection log evidence: {message}",
                    node.node_id,
                    node_host(node)
                )));
            }
            Ok(NodeResult {
                node_id: node.node_id.clone(),
                host: node_host(node),
                message,
            })
        })
        .collect()
}

pub fn stop<T: OutputTransport>(
    transport: &T,
    screen: &ScreenConfig,
    paths: &RuntimePaths,
) -> VoloResult<Vec<NodeResult>> {
    let mut nodes = ordered_nodes(screen)?;
    nodes.reverse();
    nodes
        .iter()
        .map(|node| map_node(node, transport.stop(node, paths)))
        .collect()
}

/// Publishes a never-reused PNG name to every node before atomically replacing
/// any manifest. Callers reserve `revision` before entering this function.
pub fn show<T: OutputTransport>(
    transport: &T,
    screen: &ScreenConfig,
    paths: &RuntimePaths,
    local_png: &Path,
    revision: u64,
) -> VoloResult<PublishResult> {
    if local_png
        .extension()
        .and_then(|x| x.to_str())
        .map(|x| x.eq_ignore_ascii_case("png"))
        != Some(true)
    {
        return Err(VoloError::InvalidInput("show image must be a PNG".into()));
    }
    if !local_png.is_file() {
        return Err(VoloError::NotFound(local_png.display().to_string()));
    }
    let nodes = ordered_nodes(screen)?;
    let remote_image_path = win_join(&paths.image_dir, &format!("frame-{revision}.png"));

    // Phase 1: immutable payload everywhere. No visible state changes here.
    for node in &nodes {
        transport
            .push_file(node, local_png, &remote_image_path)
            .map_err(|error| VoloError::Other(format!("push {}: {error}", node.node_id)))?;
    }

    let image_paths = nodes
        .iter()
        .map(|node| (node.node_id.clone(), remote_image_path.clone()))
        .collect::<BTreeMap<_, _>>();
    let manifest =
        generate_manifest_json(screen, revision, OutputManifestMode::Show, &image_paths)?;
    let manifest = serde_json::to_string(&manifest)?;

    // Phase 2: atomic manifest replacement. Secondary-first, primary-last.
    let mut results = Vec::with_capacity(nodes.len());
    for node in &nodes {
        results.push(map_node(
            node,
            transport.publish_manifest(node, &paths.manifest_path, &manifest),
        )?);
    }
    Ok(PublishResult {
        revision,
        remote_image_path: Some(remote_image_path),
        nodes: results,
    })
}

pub fn clear<T: OutputTransport>(
    transport: &T,
    screen: &ScreenConfig,
    paths: &RuntimePaths,
    revision: u64,
) -> VoloResult<PublishResult> {
    let nodes = ordered_nodes(screen)?;
    let manifest = generate_manifest_json(
        screen,
        revision,
        OutputManifestMode::Clear,
        &BTreeMap::new(),
    )?;
    let manifest = serde_json::to_string(&manifest)?;
    let mut results = Vec::with_capacity(nodes.len());
    for node in &nodes {
        results.push(map_node(
            node,
            transport.publish_manifest(node, &paths.manifest_path, &manifest),
        )?);
    }
    Ok(PublishResult {
        revision,
        remote_image_path: None,
        nodes: results,
    })
}

fn map_node(node: &OutputNode, result: Result<String, String>) -> VoloResult<NodeResult> {
    result
        .map(|message| NodeResult {
            node_id: node.node_id.clone(),
            host: node_host(node),
            message,
        })
        .map_err(|error| {
            VoloError::Other(format!("{} ({}): {error}", node.node_id, node_host(node)))
        })
}

pub fn node_host(node: &OutputNode) -> String {
    if node.machine.ip.trim().is_empty() {
        node.machine.hostname.clone()
    } else {
        node.machine.ip.clone()
    }
}

fn win_join(dir: &str, name: &str) -> String {
    format!("{}\\{}", dir.trim_end_matches(['\\', '/']), name)
}

fn win_parent(path: &str) -> Option<&str> {
    let index = path.rfind(['\\', '/'])?;
    (index > 0).then_some(&path[..index])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use volo_shared::dto::{MachineRef, OutputTopology, ShapeMode, ShapePriorConfig};

    struct Fake {
        calls: Mutex<Vec<String>>,
        connected: bool,
    }
    impl OutputTransport for Fake {
        fn preflight(&self, n: &OutputNode, _: &RuntimePaths) -> Result<String, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("preflight:{}", n.node_id));
            Ok("ok".into())
        }
        fn start(&self, n: &OutputNode, _: &RuntimePaths) -> Result<(bool, String), String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("start:{}", n.node_id));
            Ok((self.connected, "log".into()))
        }
        fn stop(&self, n: &OutputNode, _: &RuntimePaths) -> Result<String, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("stop:{}", n.node_id));
            Ok("ok".into())
        }
        fn prepare_deploy(&self, n: &OutputNode, _: &RuntimePaths) -> Result<String, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("prepare:{}", n.node_id));
            Ok("ok".into())
        }
        fn push_file(&self, n: &OutputNode, _: &Path, remote: &str) -> Result<(), String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("push:{}:{remote}", n.node_id));
            Ok(())
        }
        fn publish_text(&self, n: &OutputNode, remote: &str, _: &str) -> Result<String, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("text:{}:{remote}", n.node_id));
            Ok("ok".into())
        }
        fn publish_manifest(&self, n: &OutputNode, _: &str, _: &str) -> Result<String, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("manifest:{}", n.node_id));
            Ok("ok".into())
        }
    }
    fn node(id: &str, x: u32, primary: bool) -> OutputNode {
        OutputNode {
            node_id: id.into(),
            machine: MachineRef {
                hostname: id.into(),
                ip: format!("10.0.0.{x}"),
            },
            viewport_rect_px: [x * 4, 0, 4, 4],
            window_px: [4, 4],
            fullscreen: false,
            primary,
        }
    }
    fn screen() -> ScreenConfig {
        ScreenConfig {
            cabinet_count: [2, 1],
            cabinet_size_mm: [1.0, 1.0],
            pixels_per_cabinet: Some([4, 4]),
            output_topology: Some(OutputTopology {
                nodes: vec![node("primary", 0, true), node("secondary", 1, false)],
            }),
            shape_prior: ShapePriorConfig::Flat,
            shape_mode: ShapeMode::Rectangle,
            irregular_mask: vec![],
            bottom_completion: None,
            position_m: [0.0; 3],
            yaw_deg: 0.0,
            height_offset_mm: 0.0,
            normal_flip: false,
            origin_aligned: false,
        }
    }
    fn paths() -> RuntimePaths {
        RuntimePaths {
            editor_path: "ue.exe".into(),
            project_path: "x.uproject".into(),
            config_path: "x.ndisplay".into(),
            manifest_path: r"C:\out\manifest.json".into(),
            image_dir: r"C:\out\frames".into(),
        }
    }

    #[test]
    fn start_is_secondary_first_and_requires_log_evidence() {
        let fake = Fake {
            calls: Mutex::new(vec![]),
            connected: true,
        };
        start(&fake, &screen(), &paths()).unwrap();
        assert_eq!(
            *fake.calls.lock().unwrap(),
            vec!["start:secondary", "start:primary"]
        );
        let bad = Fake {
            calls: Mutex::new(vec![]),
            connected: false,
        };
        assert!(start(&bad, &screen(), &paths()).is_err());
    }
    #[test]
    fn show_pushes_all_images_before_any_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("x.png");
        std::fs::write(&png, b"png").unwrap();
        let fake = Fake {
            calls: Mutex::new(vec![]),
            connected: true,
        };
        show(&fake, &screen(), &paths(), &png, 7).unwrap();
        let calls = fake.calls.lock().unwrap();
        let first_manifest = calls
            .iter()
            .position(|x| x.starts_with("manifest:"))
            .unwrap();
        assert_eq!(first_manifest, 2);
        assert!(calls[0].contains("frame-7.png"));
    }
}
