use std::path::Path;

use crate::error::AdapterError;

/// 1-based 列号映射；label 可选（用于生成可读 id）。
#[derive(Debug, Clone, Copy)]
pub struct ColumnMap {
    pub x: usize,
    pub y: usize,
    pub z: usize,
    pub label: Option<usize>,
}

/// 一个散点：稳定唯一 id（行号+label）+ 原始坐标（与 CSV 同单位）。
#[derive(Debug, Clone)]
pub struct ScatterPoint {
    pub id: String,
    pub xyz: [f64; 3],
}

/// 解析无表头的散点 CSV。`columns` 为 None 时默认取"末尾 3 个可解析为数值的列"作 xyz、首列作 label。
pub fn parse_scatter_csv(
    path: &Path,
    columns: Option<ColumnMap>,
) -> Result<Vec<ScatterPoint>, AdapterError> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_path(path)
        .map_err(|e| AdapterError::InvalidInput(format!("open csv: {e}")))?;

    let mut out = Vec::new();
    for (ri, rec) in rdr.records().enumerate() {
        let rec = rec
            .map_err(|e| AdapterError::InvalidInput(format!("csv row {}: {e}", ri + 1)))?;
        let fields: Vec<&str> = rec.iter().collect();
        let cm = match columns {
            Some(c) => c,
            None => infer_columns(&fields).ok_or_else(|| {
                AdapterError::InvalidInput(format!(
                    "row {}: cannot infer xyz columns; pass --columns",
                    ri + 1
                ))
            })?,
        };
        let get = |idx: usize| -> Result<f64, AdapterError> {
            fields
                .get(idx - 1)
                .and_then(|s| s.trim().parse::<f64>().ok())
                .ok_or_else(|| {
                    AdapterError::InvalidInput(format!(
                        "row {}: column {idx} not a number",
                        ri + 1
                    ))
                })
        };
        let xyz = [get(cm.x)?, get(cm.y)?, get(cm.z)?];
        let label = cm
            .label
            .and_then(|li| fields.get(li - 1))
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or("");
        // Row number guarantees a unique id; label only adds readability.
        // Repeated or empty labels are legal independent measurements
        // (robust fitting handles redundancy) so we never reject on label.
        let id = format!("row{}_{}", ri + 1, label);
        out.push(ScatterPoint { id, xyz });
    }
    if out.is_empty() {
        return Err(AdapterError::InvalidInput(
            "no scatter points parsed".into(),
        ));
    }
    Ok(out)
}

/// 默认推断：取末尾 3 个能解析成数值的列作 x,y,z；首列作 label。
fn infer_columns(fields: &[&str]) -> Option<ColumnMap> {
    let numeric: Vec<usize> = fields
        .iter()
        .enumerate()
        .filter(|(_, s)| s.trim().parse::<f64>().is_ok())
        .map(|(i, _)| i + 1)
        .collect();
    if numeric.len() < 3 {
        return None;
    }
    let n = numeric.len();
    Some(ColumnMap {
        x: numeric[n - 3],
        y: numeric[n - 2],
        z: numeric[n - 1],
        label: Some(1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_tmp(content: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f
    }

    #[test]
    fn parses_bengtie_style_no_header_extra_col() {
        let f = write_tmp("1,,1000.0,100.0,100.0\nLEDB-1,,1005.8,108.2,103.9\n");
        let cols = ColumnMap {
            x: 3,
            y: 4,
            z: 5,
            label: Some(1),
        };
        let pts = parse_scatter_csv(f.path(), Some(cols)).unwrap();
        assert_eq!(pts.len(), 2);
        assert_eq!(pts[1].id, "row2_LEDB-1");
        assert_eq!(pts[1].xyz, [1005.8, 108.2, 103.9]);
    }

    #[test]
    fn same_label_rows_get_unique_row_ids() {
        // Two measurements sharing the label "A" are legal redundant points;
        // the row number keeps their ids distinct.
        let f = write_tmp("A,,1.0,2.0,3.0\nA,,4.0,5.0,6.0\n");
        let cols = ColumnMap {
            x: 3,
            y: 4,
            z: 5,
            label: Some(1),
        };
        let pts = parse_scatter_csv(f.path(), Some(cols)).unwrap();
        assert_eq!(pts.len(), 2);
        assert_eq!(pts[0].id, "row1_A");
        assert_eq!(pts[1].id, "row2_A");
    }

    #[test]
    fn empty_label_rows_parse() {
        // Empty label columns are common in real CSVs; rows must still parse
        // and stay distinct via the row number.
        let f = write_tmp(",,1.0,2.0,3.0\n,,4.0,5.0,6.0\n,,7.0,8.0,9.0\n");
        let cols = ColumnMap {
            x: 3,
            y: 4,
            z: 5,
            label: Some(1),
        };
        let pts = parse_scatter_csv(f.path(), Some(cols)).unwrap();
        assert_eq!(pts.len(), 3);
        assert_eq!(pts[0].id, "row1_");
        assert_eq!(pts[1].id, "row2_");
        assert_eq!(pts[2].id, "row3_");
    }
}
