//! Transport-agnostic orchestration for the nDisplay output runtime.

use crate::ndisplay::{
    generate_manifest_json, generate_manifest_json_node_relative, OutputManifestMode,
};
use std::collections::BTreeMap;
use std::path::Path;
use volo_shared::dto::{OutputNode, ScreenConfig};
use volo_shared::error::{VoloError, VoloResult};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RuntimePaths {
    pub editor_path: String,
    #[serde(default)]
    pub editor_paths: BTreeMap<String, String>,
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

pub trait OutputTransport: Sync {
    fn preflight(&self, node: &OutputNode, paths: &RuntimePaths) -> Result<String, String>;
    /// `clear_manifest_json`: when set, the node writes this clear manifest
    /// atomically before launching UE so start does not need a separate SSH hop.
    fn launch(
        &self,
        node: &OutputNode,
        paths: &RuntimePaths,
        clear_manifest_json: Option<&str>,
    ) -> Result<String, String>;
    fn wait_evidence(
        &self,
        node: &OutputNode,
        paths: &RuntimePaths,
    ) -> Result<(bool, String), String>;
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

/// Run `f` on every node in parallel; aggregate all errors (no fail-fast).
fn map_nodes_parallel<R: Send>(
    nodes: &[OutputNode],
    f: impl Fn(&OutputNode) -> VoloResult<R> + Sync,
) -> VoloResult<Vec<R>> {
    let mut slots: Vec<Option<VoloResult<R>>> = nodes.iter().map(|_| None).collect();
    std::thread::scope(|scope| {
        for (slot, node) in slots.iter_mut().zip(nodes.iter()) {
            scope.spawn(|| {
                *slot = Some(f(node));
            });
        }
    });
    let mut out = Vec::with_capacity(nodes.len());
    let mut errors = Vec::new();
    for slot in slots {
        match slot.expect("parallel node slot filled") {
            Ok(value) => out.push(value),
            Err(error) => errors.push(error.to_string()),
        }
    }
    if !errors.is_empty() {
        return Err(VoloError::Other(errors.join("; ")));
    }
    Ok(out)
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
    let nodes = ordered_nodes(screen)?;
    map_nodes_parallel(&nodes, |node| map_node(node, transport.preflight(node, paths)))
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
            template_root.join("Config/DefaultGame.ini"),
            win_join(project_root, "Config\\DefaultGame.ini"),
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

    map_nodes_parallel(&nodes, |node| {
        transport
            .prepare_deploy(node, paths)
            .map_err(|error| VoloError::Other(format!("prepare {}: {error}", node.node_id)))?;
        for (local, remote) in &files {
            transport
                .push_file(node, local, remote)
                .map_err(|error| VoloError::Other(format!("deploy {}: {error}", node.node_id)))?;
        }
        map_node(
            node,
            transport.publish_text(node, &paths.config_path, &config),
        )
    })
}

/// Two-phase start: parallel launch on every node, then parallel wait for
/// cluster evidence. A live process alone is not success.
pub fn start<T: OutputTransport>(
    transport: &T,
    screen: &ScreenConfig,
    paths: &RuntimePaths,
    clear_revision: Option<u64>,
) -> VoloResult<Vec<NodeResult>> {
    let nodes = ordered_nodes(screen)?;
    // Clear payloads are identical across nodes; serialize once for every launch.
    let clear_json = match clear_revision {
        Some(revision) => Some(clear_manifest_json(screen, revision)?),
        None => None,
    };

    let launch_messages = map_nodes_parallel(&nodes, |node| {
        transport
            .launch(node, paths, clear_json.as_deref())
            .map(|message| (node.node_id.clone(), message))
            .map_err(|error| {
                VoloError::Other(format!("{} ({}): {error}", node.node_id, node_host(node)))
            })
    })?;
    let launch_messages: BTreeMap<_, _> = launch_messages.into_iter().collect();

    map_nodes_parallel(&nodes, |node| {
        let (cluster_connected, evidence) =
            transport.wait_evidence(node, paths).map_err(|error| {
                VoloError::Other(format!("{} ({}): {error}", node.node_id, node_host(node)))
            })?;
        if !cluster_connected {
            return Err(VoloError::Other(format!(
                "{} ({}) started without cluster render evidence: {evidence}",
                node.node_id,
                node_host(node)
            )));
        }
        Ok(NodeResult {
            node_id: node.node_id.clone(),
            host: node_host(node),
            message: format!(
                "{}; {}",
                launch_messages
                    .get(&node.node_id)
                    .expect("launch message recorded for every node"),
                evidence
            ),
        })
    })
}

pub fn stop<T: OutputTransport>(
    transport: &T,
    screen: &ScreenConfig,
    paths: &RuntimePaths,
) -> VoloResult<Vec<NodeResult>> {
    let nodes = ordered_nodes(screen)?;
    map_nodes_parallel(&nodes, |node| map_node(node, transport.stop(node, paths)))
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
    // UE ImportFileAsTexture2D 把灰度 PNG 导成单通道 G8 纹理，viewport 上整图
    // 泛红（lanPC 实测）；推送前统一转成 RGB。
    let local_png = ensure_rgb_png(local_png, revision)?;

    // Phase 1: immutable payload everywhere (parallel). No visible state changes.
    map_nodes_parallel(&nodes, |node| {
        transport
            .push_file(node, &local_png, &remote_image_path)
            .map_err(|error| VoloError::Other(format!("push {}: {error}", node.node_id)))
    })?;

    let image_paths = nodes
        .iter()
        .map(|node| (node.node_id.clone(), remote_image_path.clone()))
        .collect::<BTreeMap<_, _>>();
    let manifests =
        generate_manifest_json(screen, revision, OutputManifestMode::Show, &image_paths)?;

    // Phase 2: atomic manifest replacement. Secondary-first, primary-last (serial).
    let mut results = Vec::with_capacity(nodes.len());
    for node in &nodes {
        let manifest = manifests
            .get(&node.node_id)
            .expect("manifest generated for every validated node");
        let manifest = serde_json::to_string(manifest)?;
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
    let manifest = clear_manifest_json(screen, revision)?;
    // Clear has no cross-node barrier; publish in parallel.
    let results = map_nodes_parallel(&nodes, |node| {
        map_node(
            node,
            transport.publish_manifest(node, &paths.manifest_path, &manifest),
        )
    })?;
    Ok(PublishResult {
        revision,
        remote_image_path: None,
        nodes: results,
    })
}

/// Clear-mode manifests are node-identical; one JSON string is enough for every node.
fn clear_manifest_json(screen: &ScreenConfig, revision: u64) -> VoloResult<String> {
    let manifests = generate_manifest_json(
        screen,
        revision,
        OutputManifestMode::Clear,
        &BTreeMap::new(),
    )?;
    let manifest = manifests
        .values()
        .next()
        .ok_or_else(|| VoloError::InvalidInput("output topology has no nodes".into()))?;
    Ok(serde_json::to_string(manifest)?)
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

/// One screen's test-pattern layer in Stage composite coordinates.
pub struct StageLayer {
    pub screen_id: String,
    pub image_path: std::path::PathBuf,
    pub origin_px: [u32; 2],
}

/// Stage show: each node receives an image of exactly its own crop size,
/// composed from the intersecting screens' pattern PNGs. No global
/// composite image is ever materialized, so canvas size never exceeds any
/// single node's output resolution.
pub fn show_stage<T: OutputTransport>(
    transport: &T,
    screen: &ScreenConfig,
    paths: &RuntimePaths,
    layers: &[StageLayer],
    revision: u64,
) -> VoloResult<PublishResult> {
    let nodes = ordered_nodes(screen)?;
    let mut decoded: BTreeMap<&str, image::RgbImage> = BTreeMap::new();
    let mut rgb_paths: BTreeMap<&str, std::path::PathBuf> = BTreeMap::new();
    for layer in layers {
        if !layer.image_path.is_file() {
            return Err(VoloError::InvalidInput(format!(
                "屏幕 {} 尚未生成测试图（{} 不存在），请先在该屏生成测试图",
                layer.screen_id,
                layer.image_path.display()
            )));
        }
        let img = image::open(&layer.image_path)
            .map_err(|error| {
                VoloError::Other(format!("decode {}: {error}", layer.image_path.display()))
            })?
            .to_rgb8();
        decoded.insert(layer.screen_id.as_str(), img);
        // Pre-convert once before parallel push; tag by screen so grayscale
        // temps do not collide across layers.
        rgb_paths.insert(
            layer.screen_id.as_str(),
            ensure_rgb_png_tagged(&layer.image_path, revision, &layer.screen_id)?,
        );
    }

    let remote_image_path = win_join(&paths.image_dir, &format!("frame-{revision}.png"));
    // Phase 1: per-node image compose + push in parallel. No visible state changes.
    map_nodes_parallel(&nodes, |node| {
        let [cx, cy, cw, ch] = node.viewport_rect_px;
        // Fast path: crop exactly matches one screen's layer -> push that
        // screen's pattern PNG as-is (no re-encode, pixel-identical).
        if let Some(exact) = layers.iter().find(|layer| {
            let img = &decoded[layer.screen_id.as_str()];
            layer.origin_px == [cx, cy] && img.width() == cw && img.height() == ch
        }) {
            let local = &rgb_paths[exact.screen_id.as_str()];
            return transport
                .push_file(node, local, &remote_image_path)
                .map_err(|error| VoloError::Other(format!("push {}: {error}", node.node_id)));
        }
        let mut canvas = image::RgbImage::new(cw.max(1), ch.max(1));
        for layer in layers {
            let img = &decoded[layer.screen_id.as_str()];
            let (lx, ly) = (layer.origin_px[0], layer.origin_px[1]);
            let (lw, lh) = (img.width(), img.height());
            let x0 = cx.max(lx);
            let y0 = cy.max(ly);
            let x1 = (cx + cw).min(lx + lw);
            let y1 = (cy + ch).min(ly + lh);
            if x0 >= x1 || y0 >= y1 {
                continue;
            }
            let view = image::imageops::crop_imm(img, x0 - lx, y0 - ly, x1 - x0, y1 - y0);
            image::imageops::replace(
                &mut canvas,
                &view.to_image(),
                i64::from(x0 - cx),
                i64::from(y0 - cy),
            );
        }
        let local = std::env::temp_dir().join(format!(
            "volo-output-node-{}-{revision}.png",
            node.node_id
        ));
        canvas
            .save(&local)
            .map_err(|error| VoloError::Other(format!("encode {}: {error}", local.display())))?;
        transport
            .push_file(node, &local, &remote_image_path)
            .map_err(|error| VoloError::Other(format!("push {}: {error}", node.node_id)))
    })?;

    let image_paths = nodes
        .iter()
        .map(|node| (node.node_id.clone(), remote_image_path.clone()))
        .collect::<BTreeMap<_, _>>();
    let manifests = generate_manifest_json_node_relative(screen, revision, &image_paths)?;

    // Phase 2: atomic manifest replacement. Secondary-first, primary-last (serial).
    let mut results = Vec::with_capacity(nodes.len());
    for node in &nodes {
        let manifest = manifests
            .get(&node.node_id)
            .expect("manifest generated for every validated node");
        let manifest = serde_json::to_string(manifest)?;
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

/// Returns a path to an RGB8/RGBA8 PNG: the input itself when already
/// multi-channel, otherwise a converted copy under the OS temp dir.
fn ensure_rgb_png(local_png: &Path, revision: u64) -> VoloResult<std::path::PathBuf> {
    ensure_rgb_png_tagged(local_png, revision, "frame")
}

fn ensure_rgb_png_tagged(
    local_png: &Path,
    revision: u64,
    tag: &str,
) -> VoloResult<std::path::PathBuf> {
    let decoded = image::open(local_png)
        .map_err(|error| VoloError::Other(format!("decode {}: {error}", local_png.display())))?;
    match decoded {
        image::DynamicImage::ImageRgb8(_) | image::DynamicImage::ImageRgba8(_) => {
            Ok(local_png.to_path_buf())
        }
        other => {
            let safe_tag: String = tag
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                .collect();
            let out = std::env::temp_dir()
                .join(format!("volo-output-frame-{revision}-{safe_tag}-rgb.png"));
            other
                .to_rgb8()
                .save(&out)
                .map_err(|error| VoloError::Other(format!("encode {}: {error}", out.display())))?;
            Ok(out)
        }
    }
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
        fn launch(
            &self,
            n: &OutputNode,
            _: &RuntimePaths,
            clear_manifest_json: Option<&str>,
        ) -> Result<String, String> {
            let tag = if clear_manifest_json.is_some() {
                format!("launch:{}:clear", n.node_id)
            } else {
                format!("launch:{}", n.node_id)
            };
            self.calls.lock().unwrap().push(tag);
            Ok("PID=1".into())
        }
        fn wait_evidence(
            &self,
            n: &OutputNode,
            _: &RuntimePaths,
        ) -> Result<(bool, String), String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("wait:{}", n.node_id));
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
        fn publish_manifest(
            &self,
            n: &OutputNode,
            _: &str,
            content: &str,
        ) -> Result<String, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("manifest:{}:{content}", n.node_id));
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
            window_origin_px: [40, 40],
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
            editor_paths: BTreeMap::new(),
            project_path: "x.uproject".into(),
            config_path: "x.ndisplay".into(),
            manifest_path: r"C:\out\manifest.json".into(),
            image_dir: r"C:\out\frames".into(),
        }
    }

    #[test]
    fn start_launches_every_node_before_waiting_for_log_evidence() {
        let fake = Fake {
            calls: Mutex::new(vec![]),
            connected: true,
        };
        start(&fake, &screen(), &paths(), Some(1)).unwrap();
        let calls = fake.calls.lock().unwrap().clone();
        let first_wait = calls
            .iter()
            .position(|call| call.starts_with("wait:"))
            .expect("wait phase");
        let launch_phase: std::collections::HashSet<_> =
            calls[..first_wait].iter().cloned().collect();
        let wait_phase: std::collections::HashSet<_> =
            calls[first_wait..].iter().cloned().collect();
        assert_eq!(
            launch_phase,
            ["launch:secondary:clear", "launch:primary:clear"]
                .into_iter()
                .map(str::to_string)
                .collect()
        );
        assert_eq!(
            wait_phase,
            ["wait:secondary", "wait:primary"]
                .into_iter()
                .map(str::to_string)
                .collect()
        );
        let bad = Fake {
            calls: Mutex::new(vec![]),
            connected: false,
        };
        assert!(start(&bad, &screen(), &paths(), None).is_err());
    }
    #[test]
    fn show_pushes_all_images_before_any_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("x.png");
        // 真 PNG（1×1 灰度）：show 现在会解码并按需转 RGB，占位字节过不了 decode。
        image::GrayImage::from_pixel(1, 1, image::Luma([128u8]))
            .save(&png)
            .unwrap();
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
        assert!(calls[..first_manifest]
            .iter()
            .all(|call| call.contains("frame-7.png")));
        let secondary: serde_json::Value = serde_json::from_str(
            calls[first_manifest]
                .strip_prefix("manifest:secondary:")
                .unwrap(),
        )
        .unwrap();
        let primary: serde_json::Value = serde_json::from_str(
            calls[first_manifest + 1]
                .strip_prefix("manifest:primary:")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(secondary["crop_x"], 4);
        assert_eq!(primary["crop_x"], 0);
        assert!(secondary.get("nodes").is_none());
    }

    #[test]
    fn deploy_pushes_template_and_generated_config_to_every_node() {
        let dir = tempfile::tempdir().unwrap();
        for relative in [
            "VoloOutput.uproject",
            "Config/DefaultEngine.ini",
            "Config/DefaultGame.ini",
            "Config/DefaultRemoteControl.ini",
            "Content/VoloOutput/BP_VoloOutput.uasset",
        ] {
            let path = dir.path().join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"fixture").unwrap();
        }
        let fake = Fake {
            calls: Mutex::new(vec![]),
            connected: true,
        };
        let mut runtime_paths = paths();
        runtime_paths.project_path = r"C:\Volo\VoloOutput.uproject".into();
        runtime_paths.config_path = r"C:\Volo\Config\VoloOutput.ndisplay".into();
        deploy(&fake, &screen(), &runtime_paths, dir.path(), "5.8").unwrap();
        let calls = fake.calls.lock().unwrap();
        assert_eq!(
            calls
                .iter()
                .filter(|call| call.starts_with("prepare:"))
                .count(),
            2
        );
        assert_eq!(
            calls
                .iter()
                .filter(|call| call.starts_with("push:"))
                .count(),
            10
        );
        assert_eq!(
            calls
                .iter()
                .filter(|call| call.starts_with("text:"))
                .count(),
            2
        );
    }
}
