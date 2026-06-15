//! Verify Rust IPC types round-trip with sample JSON matching ipc.schema.json.

use mesh_adapter_visual_ba::ipc::{Event, ReconstructInput};

#[test]
fn parse_progress_event() {
    let raw = r#"{"event":"progress","stage":"detect_charuco","percent":0.3,"message":"3/10"}"#;
    match serde_json::from_str::<Event>(raw).unwrap() {
        Event::Progress(p) => {
            assert_eq!(p.stage, "detect_charuco");
            assert!((p.percent - 0.3).abs() < 1e-9);
        }
        other => panic!("expected progress, got {other:?}"),
    }
}

#[test]
fn parse_result_event_with_visual_ba_source() {
    let raw = r#"{
      "event":"result",
      "data": {
        "measured_points":[{
          "name":"MAIN_V001_R001",
          "position":[1.0,2.0,3.0],
          "uncertainty":{"covariance":[[1,0,0],[0,1,0],[0,0,1]]},
          "source":{"visual_ba":{"camera_count":5}}
        }],
        "ba_stats":{"rms_reprojection_px":0.5,"iterations":12,"converged":true},
        "frame_strategy_used":"nominal_anchoring",
        "procrustes_align_rms_m":0.003
      }
    }"#;
    match serde_json::from_str::<Event>(raw).unwrap() {
        Event::Result(r) => {
            // r.data is now raw JSON; deserialize into the reconstruct result type.
            let data: mesh_adapter_visual_ba::ipc::ResultData =
                serde_json::from_value(r.data).unwrap();
            let pt = &data.measured_points[0];
            assert_eq!(pt.name, "MAIN_V001_R001");
            assert_eq!(pt.source.visual_ba.camera_count, 5);
        }
        _ => panic!("expected result"),
    }
}

#[test]
fn serialize_reconstruct_input_round_trip() {
    // New capture-manifest payload shape: project has no coordinate_frame /
    // frame_strategy / frame_anchors; references live at the top level.
    let json = serde_json::json!({
        "command":"reconstruct",
        "version":1,
        "project":{
            "screen_id":"MAIN",
            "cabinet_array":{"cols":4,"rows":4,"cabinet_size_mm":[500,500]},
            "shape_prior":"flat"
        },
        "capture_manifest_path":"/cap/manifest.json",
        "screen_mapping_path":"/cap/screen_mapping.json",
        "pose_report_path":"/cap/pose_report.json"
    });
    let parsed: ReconstructInput = serde_json::from_value(json.clone()).unwrap();
    let round = serde_json::to_value(&parsed).unwrap();
    assert_eq!(round["project"]["screen_id"], "MAIN");
    assert_eq!(round["capture_manifest_path"], "/cap/manifest.json");
    assert_eq!(round["screen_mapping_path"], "/cap/screen_mapping.json");
    assert_eq!(round["pose_report_path"], "/cap/pose_report.json");
}

#[test]
fn measured_point_dto_into_ir_preserves_camera_count() {
    use mesh_adapter_visual_ba::ipc::{
        MeasuredPointDto, PointSource, PointSourceVisualBa, Uncertainty,
    };
    let dto = MeasuredPointDto {
        name: "MAIN_V001_R002".into(),
        position: [1.0, 2.0, 3.0],
        uncertainty: Uncertainty::Isotropic(0.005),
        source: PointSource {
            visual_ba: PointSourceVisualBa { camera_count: 7 },
        },
    };
    let ir = dto.into_ir();
    assert_eq!(ir.name, "MAIN_V001_R002");
    assert_eq!(ir.position, nalgebra::Vector3::new(1.0, 2.0, 3.0));
    match ir.source {
        mesh_core::point::PointSource::VisualBA { camera_count } => assert_eq!(camera_count, 7),
        _ => panic!("expected VisualBA source"),
    }
}

#[test]
fn isotropic_uncertainty_meters_to_millimeters() {
    use mesh_adapter_visual_ba::ipc::{
        MeasuredPointDto, PointSource, PointSourceVisualBa, Uncertainty,
    };
    let dto = MeasuredPointDto {
        name: "x".into(),
        position: [0.0, 0.0, 0.0],
        uncertainty: Uncertainty::Isotropic(0.005), // 5mm sidecar output
        source: PointSource {
            visual_ba: PointSourceVisualBa { camera_count: 1 },
        },
    };
    let ir = dto.into_ir();
    match ir.uncertainty {
        mesh_core::uncertainty::Uncertainty::Isotropic(sigma_mm) => {
            assert!((sigma_mm - 5.0).abs() < 1e-9, "expected 5mm got {sigma_mm}");
        }
        _ => panic!("expected Isotropic"),
    }
}

#[test]
fn covariance_uncertainty_m2_to_mm2() {
    use mesh_adapter_visual_ba::ipc::{
        MeasuredPointDto, PointSource, PointSourceVisualBa, Uncertainty,
    };
    // 1mm sigma in each axis → variance 1e-6 m² → expect 1.0 mm² after conversion
    let dto = MeasuredPointDto {
        name: "x".into(),
        position: [0.0, 0.0, 0.0],
        uncertainty: Uncertainty::Covariance([
            [1.0e-6, 0.0, 0.0],
            [0.0, 1.0e-6, 0.0],
            [0.0, 0.0, 1.0e-6],
        ]),
        source: PointSource {
            visual_ba: PointSourceVisualBa { camera_count: 1 },
        },
    };
    let ir = dto.into_ir();
    match ir.uncertainty {
        mesh_core::uncertainty::Uncertainty::Covariance3x3(m) => {
            assert!(
                (m[(0, 0)] - 1.0).abs() < 1e-9,
                "diag should be 1 mm², got {}",
                m[(0, 0)]
            );
            assert!((m[(1, 1)] - 1.0).abs() < 1e-9);
            assert!((m[(2, 2)] - 1.0).abs() < 1e-9);
        }
        _ => panic!("expected Covariance3x3"),
    }
}
