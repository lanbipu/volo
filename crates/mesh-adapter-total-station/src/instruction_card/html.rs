use crate::instruction_card::InstructionCard;
use crate::shape_grid::expected_grid_positions;

/// Render an instruction card as standalone HTML.
///
/// When `bottom_completion.lowest_measurable_row > 1`, rows below the
/// baseline are excluded from the "physical measurement" table because
/// those vertices are occluded by stage/equipment and will be fabricated
/// downstream by vertical extension. Telling the field operator to
/// measure them would be misleading.
pub fn generate_html(card: &InstructionCard) -> String {
    let grid = expected_grid_positions(&card.screen_id, &card.cfg).unwrap_or_default();
    let total = grid.len();
    // 1-based row threshold: only render rows >= this row index in the
    // measurement table. Without bottom_completion, this is 1 (all rows).
    let lowest_measurable_row: u32 = card
        .cfg
        .bottom_completion
        .as_ref()
        .map(|bc| bc.lowest_measurable_row)
        .unwrap_or(1);
    let measurable_count = grid
        .iter()
        .filter(|g| g.row_zero_based + 1 >= lowest_measurable_row)
        .count();
    let fabricated_below = total.saturating_sub(measurable_count);

    let mut html = String::new();
    html.push_str("<!DOCTYPE html>\n");
    html.push_str("<html lang=\"zh\">\n<head>\n");
    html.push_str("<meta charset=\"utf-8\">\n");
    html.push_str(&format!(
        "<title>LED 屏建模指示卡 - {}</title>\n",
        html_escape(&card.project_name)
    ));
    html.push_str("<style>\n");
    html.push_str("body { font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif; line-height: 1.5; max-width: 900px; margin: 2em auto; padding: 0 1em; }\n");
    html.push_str("h1 { border-bottom: 2px solid #333; padding-bottom: 0.3em; }\n");
    html.push_str("table { border-collapse: collapse; margin: 1em 0; width: 100%; }\n");
    html.push_str("th, td { border: 1px solid #999; padding: 4px 8px; text-align: left; }\n");
    html.push_str("th { background: #eee; }\n");
    html.push_str(".ref { background: #ffe4b5; }\n");
    html.push_str("</style>\n</head>\n<body>\n");

    html.push_str(&format!(
        "<h1>LED 屏建模 - 测量指示卡</h1>\n<p>项目：<b>{}</b> &nbsp;&nbsp; 屏体：<b>{}</b></p>\n",
        html_escape(&card.project_name),
        html_escape(&card.screen_id)
    ));
    html.push_str(&format!(
        "<p>箱体阵列：{} × {} &nbsp;&nbsp; 单箱体：{} × {} mm</p>\n",
        card.cfg.cabinet_count[0],
        card.cfg.cabinet_count[1],
        card.cfg.cabinet_size_mm[0],
        card.cfg.cabinet_size_mm[1]
    ));
    if fabricated_below > 0 {
        html.push_str(&format!(
            "<p>可测点数：{measurable_count}（含 3 参考点）；底部 {fabricated_below} 点因遮挡跳过，工具将垂直延伸补全</p>\n"
        ));
    } else {
        html.push_str(&format!("<p>总测点数：{total}（含 3 参考点）</p>\n"));
    }

    html.push_str("<h2>第一步：3 个参考点（必须按仪器点号 1, 2, 3 顺序测量）</h2>\n<table>\n");
    html.push_str("<tr><th>仪器点号</th><th>角色</th><th>网格命名</th></tr>\n");
    html.push_str(&format!(
        "<tr class=\"ref\"><td>1</td><td>① Origin (0, 0, 0)</td><td>{}</td></tr>\n",
        html_escape(&card.origin_grid_name)
    ));
    html.push_str(&format!(
        "<tr class=\"ref\"><td>2</td><td>② X-axis</td><td>{}</td></tr>\n",
        html_escape(&card.x_axis_grid_name)
    ));
    html.push_str(&format!(
        "<tr class=\"ref\"><td>3</td><td>③ XY-plane</td><td>{}</td></tr>\n",
        html_escape(&card.xy_plane_grid_name)
    ));
    html.push_str("</table>\n");

    html.push_str("<h2>第二步：其他网格测点（仪器自动点号 4 起）</h2>\n<table>\n");
    html.push_str("<tr><th>网格命名</th><th>X (m)</th><th>Y (m)</th><th>Z (m)</th></tr>\n");
    let ref_names = [
        card.origin_grid_name.as_str(),
        card.x_axis_grid_name.as_str(),
        card.xy_plane_grid_name.as_str(),
    ];
    for ge in &grid {
        if ref_names.contains(&ge.name.as_str()) {
            continue;
        }
        // Skip rows below the lowest measurable baseline — they're
        // occluded in the field and will be fabricated by the adapter.
        if ge.row_zero_based + 1 < lowest_measurable_row {
            continue;
        }
        html.push_str(&format!(
            "<tr><td>{}</td><td>{:.3}</td><td>{:.3}</td><td>{:.3}</td></tr>\n",
            html_escape(&ge.name),
            ge.model_position.x,
            ge.model_position.y,
            ge.model_position.z
        ));
    }
    html.push_str("</table>\n");
    if fabricated_below > 0 {
        html.push_str(&format!(
            "<p><b>注：</b>R001..R{:03} 行因底部遮挡未列入测量清单——工具会用 R{:03} 的实测位置垂直向下推算补全（精度 ±5-15mm）。</p>\n",
            lowest_measurable_row - 1,
            lowest_measurable_row
        ));
    }

    html.push_str("<h2>现场操作要点</h2>\n<ul>\n");
    html.push_str("<li>先测 ①②③ 三个参考点（仪器点号 1-3）</li>\n");
    html.push_str("<li>其他点测量顺序无所谓（仪器点号 4 起递增）</li>\n");
    html.push_str("<li>测完导出 CSV，工具会自动按几何位置归名</li>\n");
    html.push_str("<li>漏测可补，工具会识别缺什么</li>\n");
    html.push_str("</ul>\n");
    html.push_str("</body>\n</html>\n");

    html
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
