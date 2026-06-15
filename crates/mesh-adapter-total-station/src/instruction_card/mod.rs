use crate::project::ScreenConfig;

pub mod html;

/// Data needed to render an instruction card.
///
/// HTML rendering happens here (preview + the source-of-truth for PDF).
/// PDF rendering lives in `lmt-tauri` because it needs the platform webview;
/// it consumes the HTML this struct produces, so there's only one template.
#[derive(Debug, Clone)]
pub struct InstructionCard {
    pub project_name: String,
    pub screen_id: String,
    pub cfg: ScreenConfig,
    pub origin_grid_name: String,
    pub x_axis_grid_name: String,
    pub xy_plane_grid_name: String,
}
