use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use volo_shared::{
    dto::{OutputNode, ScreenConfig},
    error::{VoloError, VoloResult},
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TopologyIssueSeverity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TopologyIssue {
    pub severity: TopologyIssueSeverity,
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub node_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TopologyValidation {
    pub canvas_px: [u32; 2],
    pub errors: Vec<TopologyIssue>,
    pub warnings: Vec<TopologyIssue>,
}

pub const OUTPUT_MANIFEST_SCHEMA_VERSION: &str = "volo_output.v1";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutputManifestMode {
    Show,
    Clear,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutputManifest {
    pub schema_version: String,
    pub revision: u64,
    pub mode: OutputManifestMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_path: Option<String>,
    /// 与 image_path 同值。真机验收的 BP_VoloOutput 蓝图读的字段名是
    /// texture_path（偏离了 guide 的 image_path）；蓝图是手工二进制资产，
    /// 契约侧双字段兼容两种命名。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub texture_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crop_x: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crop_y: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crop_w: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crop_h: Option<u32>,
}

impl TopologyValidation {
    pub fn is_valid(&self) -> bool {
        self.errors.is_empty()
    }
}

pub fn validate_topology(screen: &ScreenConfig) -> VoloResult<TopologyValidation> {
    let topology = screen
        .output_topology
        .as_ref()
        .ok_or_else(|| VoloError::InvalidInput("screen.output_topology is required".to_string()))?;
    let canvas_px = canvas_size(screen)?;
    let mut result = TopologyValidation {
        canvas_px,
        errors: Vec::new(),
        warnings: Vec::new(),
    };

    let mut node_ids = HashSet::new();
    let mut primary_count = 0usize;
    let mut hostname_nodes: HashMap<String, Vec<String>> = HashMap::new();
    let mut ip_nodes: HashMap<String, Vec<String>> = HashMap::new();
    let mut geometry_valid = true;
    let mut total_area = 0u64;

    for node in &topology.nodes {
        if !is_valid_node_id(&node.node_id) {
            push_issue(
                &mut result.errors,
                TopologyIssueSeverity::Error,
                "invalid_node_id",
                format!("node_id '{}' contains unsupported characters", node.node_id),
                vec![node.node_id.clone()],
            );
        }
        if !node_ids.insert(node.node_id.clone()) {
            push_issue(
                &mut result.errors,
                TopologyIssueSeverity::Error,
                "duplicate_node_id",
                format!("node_id '{}' is duplicated", node.node_id),
                vec![node.node_id.clone()],
            );
        }
        if node.primary {
            primary_count += 1;
        }

        let [x, y, width, height] = node.viewport_rect_px;
        let right = x.checked_add(width);
        let bottom = y.checked_add(height);
        if width == 0 || height == 0 {
            geometry_valid = false;
            push_issue(
                &mut result.errors,
                TopologyIssueSeverity::Error,
                "zero_sized_viewport",
                format!("node '{}' has a zero-sized viewport", node.node_id),
                vec![node.node_id.clone()],
            );
        } else if right.is_none()
            || bottom.is_none()
            || right.is_some_and(|value| value > canvas_px[0])
            || bottom.is_some_and(|value| value > canvas_px[1])
        {
            geometry_valid = false;
            push_issue(
                &mut result.errors,
                TopologyIssueSeverity::Error,
                "viewport_out_of_bounds",
                format!(
                    "node '{}' viewport {:?} exceeds canvas {:?}",
                    node.node_id, node.viewport_rect_px, canvas_px
                ),
                vec![node.node_id.clone()],
            );
        } else {
            total_area += u64::from(width) * u64::from(height);
        }

        if node.window_px != [width, height] {
            push_issue(
                &mut result.errors,
                TopologyIssueSeverity::Error,
                "resolution_mismatch",
                format!(
                    "node '{}' window {:?} differs from viewport size [{width}, {height}]; pixel 1:1 output requires equal dimensions",
                    node.node_id, node.window_px
                ),
                vec![node.node_id.clone()],
            );
        }

        let hostname = node.machine.hostname.trim();
        if !hostname.is_empty() {
            hostname_nodes
                .entry(hostname.to_ascii_lowercase())
                .or_default()
                .push(node.node_id.clone());
        }
        let ip = node.machine.ip.trim();
        if !ip.is_empty() {
            ip_nodes
                .entry(ip.to_string())
                .or_default()
                .push(node.node_id.clone());
        }
    }

    for (index, left) in topology.nodes.iter().enumerate() {
        for right in topology.nodes.iter().skip(index + 1) {
            if rectangles_overlap(left, right) {
                geometry_valid = false;
                push_issue(
                    &mut result.errors,
                    TopologyIssueSeverity::Error,
                    "viewport_overlap",
                    format!(
                        "nodes '{}' and '{}' have overlapping viewports",
                        left.node_id, right.node_id
                    ),
                    vec![left.node_id.clone(), right.node_id.clone()],
                );
            }
        }
    }

    if primary_count != 1 {
        push_issue(
            &mut result.errors,
            TopologyIssueSeverity::Error,
            "primary_count",
            format!("exactly one primary node is required; found {primary_count}"),
            Vec::new(),
        );
    }

    if geometry_valid && total_area != u64::from(canvas_px[0]) * u64::from(canvas_px[1]) {
        push_issue(
            &mut result.warnings,
            TopologyIssueSeverity::Warning,
            "canvas_not_fully_covered",
            format!(
                "viewport union covers {total_area} of {} canvas pixels",
                u64::from(canvas_px[0]) * u64::from(canvas_px[1])
            ),
            Vec::new(),
        );
    }

    let mut warned_node_sets = HashSet::new();
    for (identity_kind, groups) in [("hostname", hostname_nodes), ("IP", ip_nodes)] {
        for nodes in groups.into_values().filter(|nodes| nodes.len() > 1) {
            let mut node_set = nodes.clone();
            node_set.sort();
            if !warned_node_sets.insert(node_set) {
                continue;
            }
            push_issue(
                &mut result.warnings,
                TopologyIssueSeverity::Warning,
                "multiple_nodes_on_machine",
                format!(
                    "the same machine {identity_kind} is assigned to multiple nodes: {}",
                    nodes.join(", ")
                ),
                nodes,
            );
        }
    }

    Ok(result)
}

pub fn generate_manifest_json(
    screen: &ScreenConfig,
    revision: u64,
    mode: OutputManifestMode,
    image_paths: &BTreeMap<String, String>,
) -> VoloResult<BTreeMap<String, Value>> {
    let validation = validate_topology(screen)?;
    if !validation.is_valid() {
        return Err(VoloError::InvalidInput(format!(
            "invalid output topology: {}",
            validation
                .errors
                .iter()
                .map(|issue| issue.message.as_str())
                .collect::<Vec<_>>()
                .join("; ")
        )));
    }

    let topology = screen.output_topology.as_ref().expect("validated topology");
    let mut manifests = BTreeMap::new();
    match mode {
        OutputManifestMode::Show => {
            for node in &topology.nodes {
                let image_path = image_paths.get(&node.node_id).ok_or_else(|| {
                    VoloError::InvalidInput(format!(
                        "image_path is missing for node '{}'",
                        node.node_id
                    ))
                })?;
                if image_path.trim().is_empty() {
                    return Err(VoloError::InvalidInput(format!(
                        "image_path is empty for node '{}'",
                        node.node_id
                    )));
                }
                let [crop_x, crop_y, crop_w, crop_h] = node.viewport_rect_px;
                let manifest = serde_json::to_value(OutputManifest {
                    schema_version: OUTPUT_MANIFEST_SCHEMA_VERSION.to_string(),
                    revision,
                    mode,
                    image_path: Some(image_path.clone()),
                    texture_path: Some(image_path.clone()),
                    crop_x: Some(crop_x),
                    crop_y: Some(crop_y),
                    crop_w: Some(crop_w),
                    crop_h: Some(crop_h),
                })
                .map_err(|error| VoloError::Other(format!("serialize output manifest: {error}")))?;
                manifests.insert(node.node_id.clone(), manifest);
            }
            if image_paths.len() != manifests.len() {
                let unknown = image_paths
                    .keys()
                    .filter(|node_id| !manifests.contains_key(*node_id))
                    .cloned()
                    .collect::<Vec<_>>();
                return Err(VoloError::InvalidInput(format!(
                    "image_path contains unknown nodes: {}",
                    unknown.join(", ")
                )));
            }
        }
        OutputManifestMode::Clear => {
            if !image_paths.is_empty() {
                return Err(VoloError::InvalidInput(
                    "clear manifest must not contain image paths".to_string(),
                ));
            }
            for node in &topology.nodes {
                let manifest = serde_json::to_value(OutputManifest {
                    schema_version: OUTPUT_MANIFEST_SCHEMA_VERSION.to_string(),
                    revision,
                    mode,
                    image_path: None,
                    texture_path: None,
                    crop_x: None,
                    crop_y: None,
                    crop_w: None,
                    crop_h: None,
                })
                .map_err(|error| VoloError::Other(format!("serialize output manifest: {error}")))?;
                manifests.insert(node.node_id.clone(), manifest);
            }
        }
    }
    Ok(manifests)
}

pub fn generate_ndisplay_json(
    screen: &ScreenConfig,
    resolved_node_ips: &BTreeMap<String, String>,
    ue_version: &str,
) -> VoloResult<Value> {
    if !ue_version.starts_with("5.7") && !ue_version.starts_with("5.8") {
        return Err(VoloError::InvalidInput(format!(
            "unsupported UE version '{ue_version}'; only the P0-verified 5.7/5.8 schema is supported"
        )));
    }
    let validation = validate_topology(screen)?;
    if !validation.is_valid() {
        return Err(VoloError::InvalidInput(format!(
            "invalid output topology: {}",
            validation
                .errors
                .iter()
                .map(|issue| issue.message.as_str())
                .collect::<Vec<_>>()
                .join("; ")
        )));
    }
    let topology = screen.output_topology.as_ref().expect("validated topology");
    let primary = topology
        .nodes
        .iter()
        .find(|node| node.primary)
        .expect("validated primary node");

    let mut nodes = Map::new();
    for node in &topology.nodes {
        let host = resolved_node_ips.get(&node.node_id).ok_or_else(|| {
            VoloError::InvalidInput(format!(
                "resolved IP is missing for node '{}'",
                node.node_id
            ))
        })?;
        let viewport_name = format!(
            "{}Viewport",
            node.node_id.strip_suffix("Node").unwrap_or(&node.node_id)
        );
        let [_, _, viewport_width, viewport_height] = node.viewport_rect_px;
        nodes.insert(
            node.node_id.clone(),
            json!({
                "host": host,
                "sound": false,
                // Phase 1 supports windowed output only. Keep the DTO field for
                // forward compatibility, but never emit a conflicting mode.
                "fullScreen": false,
                "window": {
                    "x": node.window_origin_px[0],
                    "y": node.window_origin_px[1],
                    "w": node.window_px[0],
                    "h": node.window_px[1]
                },
                "postprocess": {},
                "viewports": {
                    viewport_name: {
                        "camera": "",
                        "bufferRatio": 1,
                        "gPUIndex": -1,
                        "allowCrossGPUTransfer": false,
                        "isShared": false,
                        "region": {
                            "x": 0,
                            "y": 0,
                            "w": viewport_width,
                            "h": viewport_height
                        },
                        "projectionPolicy": {
                            "type": "simple",
                            "parameters": {"screen": "VoloScreen"}
                        }
                    }
                },
                "outputRemap": {
                    "bEnable": false,
                    "dataSource": "mesh",
                    "staticMeshAsset": "",
                    "externalFile": ""
                }
            }),
        );
    }

    let width_cm = f64::from(screen.cabinet_count[0]) * screen.cabinet_size_mm[0] / 10.0;
    let height_cm = f64::from(screen.cabinet_count[1]) * screen.cabinet_size_mm[1] / 10.0;
    let width_cm_json = json_number(width_cm)?;
    let height_cm_json = json_number(height_cm)?;
    let half_width_cm_json = json_number(-width_cm / 2.0)?;
    let half_height_cm_json = json_number(height_cm / 2.0)?;

    Ok(json!({
        "nDisplay": {
            "description": "Volo two-node nDisplay output spike",
            "version": "5.00",
            "assetPath": "/Game/VoloOutput/BP_VoloOutput.BP_VoloOutput",
            "misc": {
                "bFollowLocalPlayerCamera": false,
                "bExitOnEsc": true,
                "bOverrideViewportsFromExternalConfig": true
            },
            "scene": {
                "cameras": {
                    "DefaultViewPoint": {
                        "interpupillaryDistance": 6.4,
                        "swapEyes": false,
                        "stereoOffset": "none",
                        "parentId": "",
                        "location": {"x": -80, "y": 0, "z": 10},
                        "rotation": {"pitch": 0, "yaw": 0, "roll": 0}
                    }
                },
                "screens": {
                    "VoloScreen": {
                        "size": {
                            "width": width_cm_json,
                            "height": height_cm_json
                        },
                        "parentId": "",
                        "location": {
                            "x": 100,
                            "y": half_width_cm_json,
                            "z": half_height_cm_json
                        },
                        "rotation": {"pitch": 0, "yaw": 0, "roll": 0}
                    }
                }
            },
            "cluster": {
                "primaryNode": {
                    "id": primary.node_id,
                    "ports": {
                        "ClusterSync": 41001,
                        "ClusterEventsJson": 41003,
                        "ClusterEventsBinary": 41004
                    }
                },
                "sync": {
                    "renderSyncPolicy": {"type": "none", "parameters": {}},
                    "inputSyncPolicy": {"type": "ReplicatePrimary", "parameters": {}}
                },
                "network": {
                    "ConnectRetriesAmount": "300",
                    "ConnectRetryDelay": "1000",
                    "GameStartBarrierTimeout": "180000",
                    "FrameStartBarrierTimeout": "60000",
                    "FrameEndBarrierTimeout": "60000",
                    "RenderSyncBarrierTimeout": "60000"
                },
                "failover": {"failoverPolicy": "Disabled"},
                "nodes": Value::Object(nodes)
            },
            "customParameters": {},
            "diagnostics": {
                "simulateLag": false,
                "minLagTime": 0.01,
                "maxLagTime": 0.3
            }
        }
    }))
}

fn canvas_size(screen: &ScreenConfig) -> VoloResult<[u32; 2]> {
    let pixels = screen.pixels_per_cabinet.ok_or_else(|| {
        VoloError::InvalidInput(
            "pixels_per_cabinet is required before configuring output topology".to_string(),
        )
    })?;
    Ok([
        screen.cabinet_count[0]
            .checked_mul(pixels[0])
            .ok_or_else(|| VoloError::InvalidInput("canvas width overflows u32".to_string()))?,
        screen.cabinet_count[1]
            .checked_mul(pixels[1])
            .ok_or_else(|| VoloError::InvalidInput("canvas height overflows u32".to_string()))?,
    ])
}

fn json_number(value: f64) -> VoloResult<Value> {
    if !value.is_finite() {
        return Err(VoloError::InvalidInput(
            "nDisplay physical screen dimensions must be finite".to_string(),
        ));
    }
    if value.fract() == 0.0 && value >= i64::MIN as f64 && value <= i64::MAX as f64 {
        return Ok(json!(value as i64));
    }
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .ok_or_else(|| VoloError::InvalidInput("invalid nDisplay numeric value".to_string()))
}

fn is_valid_node_id(node_id: &str) -> bool {
    let mut chars = node_id.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphanumeric())
        && chars
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

fn rectangles_overlap(left: &OutputNode, right: &OutputNode) -> bool {
    let [left_x, left_y, left_width, left_height] = left.viewport_rect_px;
    let [right_x, right_y, right_width, right_height] = right.viewport_rect_px;
    if left_width == 0 || left_height == 0 || right_width == 0 || right_height == 0 {
        return false;
    }
    let Some(left_right) = left_x.checked_add(left_width) else {
        return false;
    };
    let Some(left_bottom) = left_y.checked_add(left_height) else {
        return false;
    };
    let Some(right_right) = right_x.checked_add(right_width) else {
        return false;
    };
    let Some(right_bottom) = right_y.checked_add(right_height) else {
        return false;
    };
    left_x < right_right && right_x < left_right && left_y < right_bottom && right_y < left_bottom
}

fn push_issue(
    target: &mut Vec<TopologyIssue>,
    severity: TopologyIssueSeverity,
    code: &str,
    message: String,
    node_ids: Vec<String>,
) {
    target.push(TopologyIssue {
        severity,
        code: code.to_string(),
        message,
        node_ids,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use volo_shared::dto::{MachineRef, OutputNode, OutputTopology, ShapeMode, ShapePriorConfig};

    fn screen(nodes: Vec<OutputNode>) -> ScreenConfig {
        ScreenConfig {
            cabinet_count: [2, 1],
            cabinet_size_mm: [1000.0, 1000.0],
            pixels_per_cabinet: Some([800, 600]),
            output_topology: Some(OutputTopology { nodes }),
            shape_prior: ShapePriorConfig::Flat,
            shape_mode: ShapeMode::Rectangle,
            irregular_mask: Vec::new(),
            bottom_completion: None,
            position_m: [0.0; 3],
            yaw_deg: 0.0,
            height_offset_mm: 0.0,
            normal_flip: false,
            origin_aligned: false,
        }
    }

    fn node(id: &str, x: u32, primary: bool, hostname: &str) -> OutputNode {
        OutputNode {
            node_id: id.to_string(),
            machine: MachineRef {
                hostname: hostname.to_string(),
                ip: String::new(),
            },
            viewport_rect_px: [x, 0, 800, 600],
            window_px: [800, 600],
            window_origin_px: [40, 40],
            fullscreen: false,
            primary,
        }
    }

    #[test]
    fn valid_two_node_topology_covers_canvas() {
        let validation = validate_topology(&screen(vec![
            node("RazerNode", 0, true, "razer"),
            node("LanNode", 800, false, "lanpc"),
        ]))
        .unwrap();
        assert!(validation.is_valid(), "{:?}", validation.errors);
        assert!(validation.warnings.is_empty(), "{:?}", validation.warnings);
    }

    #[test]
    fn validation_reports_rule_table_errors_and_warnings() {
        let mut second = node("bad id", 700, true, "razer");
        second.window_px = [1920, 1080];
        let validation = validate_topology(&screen(vec![
            node("dup", 0, true, "razer"),
            second,
            node("dup", 1500, false, "lanpc"),
        ]))
        .unwrap();
        let error_codes: HashSet<_> = validation
            .errors
            .iter()
            .map(|issue| issue.code.as_str())
            .collect();
        assert!(error_codes.contains("invalid_node_id"));
        assert!(error_codes.contains("duplicate_node_id"));
        assert!(error_codes.contains("viewport_overlap"));
        assert!(error_codes.contains("viewport_out_of_bounds"));
        assert!(error_codes.contains("primary_count"));
        assert!(error_codes.contains("resolution_mismatch"));
        let warning_codes: HashSet<_> = validation
            .warnings
            .iter()
            .map(|issue| issue.code.as_str())
            .collect();
        assert!(warning_codes.contains("multiple_nodes_on_machine"));
    }

    #[test]
    fn same_machine_ip_warns_even_when_hostnames_differ() {
        let mut first = node("NodeA", 0, true, "render-a");
        first.machine.ip = "192.168.10.20".to_string();
        let mut second = node("NodeB", 800, false, "render-a-alias");
        second.machine.ip = "192.168.10.20".to_string();

        let validation = validate_topology(&screen(vec![first, second])).unwrap();
        let warnings: Vec<_> = validation
            .warnings
            .iter()
            .filter(|issue| issue.code == "multiple_nodes_on_machine")
            .collect();
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].message.contains("IP"));
        assert_eq!(warnings[0].node_ids, ["NodeA", "NodeB"]);
    }

    #[test]
    fn missing_pixels_per_cabinet_is_rejected() {
        let mut config = screen(vec![node("OnlyNode", 0, true, "lanpc")]);
        config.pixels_per_cabinet = None;
        assert!(matches!(
            validate_topology(&config),
            Err(VoloError::InvalidInput(message))
                if message.contains("pixels_per_cabinet")
        ));
    }

    #[test]
    fn resolution_mismatch_is_a_hard_error() {
        let mut only = node("OnlyNode", 0, true, "lanpc");
        only.viewport_rect_px = [0, 0, 1600, 600];
        only.window_px = [800, 600];
        let validation = validate_topology(&screen(vec![only])).unwrap();
        assert!(validation
            .errors
            .iter()
            .any(|issue| issue.code == "resolution_mismatch"));
    }

    #[test]
    fn generated_show_manifest_matches_v1_contract() {
        let config = screen(vec![
            node("RazerNode", 0, true, "razer"),
            node("LanNode", 800, false, "lanpc"),
        ]);
        let paths = BTreeMap::from([
            (
                "LanNode".to_string(),
                r"C:\ProgramData\UECM\ndisplay-output\images\frame-42.png".to_string(),
            ),
            (
                "RazerNode".to_string(),
                r"C:\ProgramData\UECM\ndisplay-output\images\frame-42.png".to_string(),
            ),
        ]);
        let actual = generate_manifest_json(&config, 42, OutputManifestMode::Show, &paths).unwrap();
        let expected: Value = serde_json::from_str(include_str!(
            "../testdata/ndisplay/golden-output-manifest-v1.json"
        ))
        .unwrap();
        assert_eq!(actual["LanNode"], expected);
        assert_eq!(actual["RazerNode"]["crop_x"], 0);
    }

    #[test]
    fn generated_clear_manifest_has_no_node_payloads() {
        let config = screen(vec![
            node("RazerNode", 0, true, "razer"),
            node("LanNode", 800, false, "lanpc"),
        ]);
        let actual =
            generate_manifest_json(&config, 43, OutputManifestMode::Clear, &BTreeMap::new())
                .unwrap();
        assert_eq!(actual.len(), 2);
        for manifest in actual.values() {
            assert_eq!(manifest["schema_version"], OUTPUT_MANIFEST_SCHEMA_VERSION);
            assert_eq!(manifest["revision"], 43);
            assert_eq!(manifest["mode"], "clear");
            assert!(manifest.get("image_path").is_none());
            assert!(manifest.get("crop_x").is_none());
        }
    }

    #[test]
    fn show_manifest_rejects_missing_or_unknown_nodes() {
        let config = screen(vec![
            node("RazerNode", 0, true, "razer"),
            node("LanNode", 800, false, "lanpc"),
        ]);
        let missing = BTreeMap::from([("LanNode".to_string(), "frame.png".to_string())]);
        assert!(matches!(
            generate_manifest_json(&config, 1, OutputManifestMode::Show, &missing),
            Err(VoloError::InvalidInput(message)) if message.contains("RazerNode")
        ));

        let unknown = BTreeMap::from([
            ("LanNode".to_string(), "frame.png".to_string()),
            ("RazerNode".to_string(), "frame.png".to_string()),
            ("GhostNode".to_string(), "frame.png".to_string()),
        ]);
        assert!(matches!(
            generate_manifest_json(&config, 1, OutputManifestMode::Show, &unknown),
            Err(VoloError::InvalidInput(message)) if message.contains("GhostNode")
        ));
    }

    #[test]
    fn generated_ue57_and_ue58_json_match_p0_golden() {
        let config = screen(vec![
            node("RazerNode", 0, true, "razer"),
            node("LanNode", 800, false, "lanpc"),
        ]);
        let resolved = BTreeMap::from([
            ("LanNode".to_string(), "192.168.10.20".to_string()),
            ("RazerNode".to_string(), "192.168.10.173".to_string()),
        ]);
        let expected: Value = serde_json::from_str(include_str!(
            "../testdata/ndisplay/golden-ue58-two-node.ndisplay"
        ))
        .unwrap();
        for version in ["5.7", "5.8"] {
            let actual = generate_ndisplay_json(&config, &resolved, version).unwrap();
            assert_eq!(actual, expected, "UE {version}");
        }
    }

    #[test]
    fn ndisplay_generator_forces_phase_one_windowed_mode() {
        let mut fullscreen_node = node("LanNode", 0, true, "lanpc");
        fullscreen_node.fullscreen = true;
        let config = screen(vec![fullscreen_node]);
        let resolved = BTreeMap::from([("LanNode".to_string(), "127.0.0.1".to_string())]);
        let actual = generate_ndisplay_json(&config, &resolved, "5.8").unwrap();
        assert_eq!(
            actual["nDisplay"]["cluster"]["nodes"]["LanNode"]["fullScreen"],
            false
        );
    }

    #[test]
    fn unknown_ue_schema_is_rejected() {
        let config = screen(vec![
            node("RazerNode", 0, true, "razer"),
            node("LanNode", 800, false, "lanpc"),
        ]);
        assert!(matches!(
            generate_ndisplay_json(&config, &BTreeMap::new(), "5.6"),
            Err(VoloError::InvalidInput(message)) if message.contains("unsupported UE version")
        ));
    }
}
