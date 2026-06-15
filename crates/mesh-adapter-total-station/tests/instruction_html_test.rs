use mesh_adapter_total_station::instruction_card::html::generate_html;
use mesh_adapter_total_station::instruction_card::InstructionCard;
use mesh_adapter_total_station::project::{
    BottomCompletion, FallbackMethod, ScreenConfig, ShapePriorConfig,
};

#[test]
fn html_contains_project_name_and_screen_id() {
    let cfg = ScreenConfig {
        cabinet_count: [4, 2],
        cabinet_size_mm: [500.0, 500.0],
        shape_prior: ShapePriorConfig::Flat,
        bottom_completion: None,
        absent_cells: vec![],
    };
    let card = InstructionCard {
        project_name: "Studio_A".into(),
        screen_id: "MAIN".into(),
        cfg,
        origin_grid_name: "MAIN_V001_R001".into(),
        x_axis_grid_name: "MAIN_V005_R001".into(),
        xy_plane_grid_name: "MAIN_V001_R003".into(),
    };
    let html = generate_html(&card);
    assert!(html.contains("<title>"));
    assert!(html.contains("Studio_A"));
    assert!(html.contains("MAIN"));
    assert!(html.contains("MAIN_V001_R001"));
    assert!(html.contains("MAIN_V005_R001"));
    assert!(html.contains("MAIN_V001_R003"));
    // Should list all 15 grid points (5 × 3)
    assert!(html.matches("MAIN_V").count() >= 15);
}

#[test]
fn html_excludes_rows_below_lowest_measurable_row() {
    // 4 cols × 5 rows = vertex grid 5×6 = 30 vertices.
    // lowest_measurable_row=3 → R001 and R002 (10 vertices) are occluded.
    // Card should list only 30 - 10 = 20 vertices in the measurement table
    // and note that R001..R002 will be fabricated.
    let cfg = ScreenConfig {
        cabinet_count: [4, 5],
        cabinet_size_mm: [500.0, 500.0],
        shape_prior: ShapePriorConfig::Flat,
        bottom_completion: Some(BottomCompletion {
            lowest_measurable_row: 3,
            fallback_method: FallbackMethod::Vertical,
        }),
        absent_cells: vec![],
    };
    let card = InstructionCard {
        project_name: "WithOcclusion".into(),
        screen_id: "MAIN".into(),
        cfg,
        origin_grid_name: "MAIN_V001_R003".into(),
        x_axis_grid_name: "MAIN_V005_R003".into(),
        xy_plane_grid_name: "MAIN_V001_R006".into(),
    };
    let html = generate_html(&card);
    assert!(
        !html.contains("MAIN_V001_R001"),
        "R001 should be excluded from measurement table"
    );
    assert!(
        !html.contains("MAIN_V003_R002"),
        "R002 should be excluded from measurement table"
    );
    assert!(
        html.contains("MAIN_V001_R003"),
        "R003 should appear (reference)"
    );
    assert!(
        html.contains("垂直向下推算"),
        "fallback note should be present"
    );
}
