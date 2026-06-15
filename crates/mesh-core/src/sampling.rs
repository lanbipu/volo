use serde::{Deserialize, Serialize};

/// 测量点的采样方式，决定走哪条重建路径。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SamplingMode {
    /// 点落在网格顶点上，各自带 `<screen>_V<col>_R<row>` 名字（现状路径）。
    #[default]
    Grid,
    /// 屏面上的任意散点，靠曲面拟合重建。
    Scatter,
}
