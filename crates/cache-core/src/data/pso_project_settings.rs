//! CRUD for `pso_project_settings` — per-project persisted prerun config for
//! the PSO Dashboard "设置" sub-view (dc_cfg source, extra args, target
//! machines, timing knobs).

use crate::data::Db;
use crate::error::{VoloError, VoloResult};
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct PsoProjectSettings {
    pub project_id: i64,
    /// "asset" | "manual"
    pub dc_cfg_source: String,
    pub dc_cfg_asset: Option<String>,
    pub dc_cfg_manual_path: Option<String>,
    /// 空格分隔的附加启动参数（与 StartPsoWarmupRequest.extra_args 的
    /// Vec<String> 之间由调用方 split_whitespace 转换）
    pub extra_args: String,
    pub offscreen: bool,
    /// JSON 数组文本，如 "[1,2,3]"（机器 id 列表）
    pub target_machine_ids: String,
    pub max_minutes: i64,
    pub probe_interval_secs: i64,
    /// 遍历引擎已加载地图包路径（如 /Game/InCamVFXBP/Maps/LED_CurvedStage）；留空 = 该工程预跑
    /// 不启用遍历（退化为固定机位，行为等同未接遍历引擎前）。
    pub map_path: Option<String>,
    /// nDisplay 集群节点 id（如 "Node_0"），传给 UE 的 `-dc_node`/`-StageFriendlyName`——必须与
    /// dc_cfg 指向的 .ndisplay 配置内定义的节点名一致，与配置文件路径本身无关。当前设置模型是
    /// per-project 单值，同一工程下所有目标节点共用这一个 dc_node；多节点 nDisplay 集群要分别
    /// 预跑/冷启动验证每台机器时手动切换该值（无法从 .ndisplay 内容自动反解 IP→节点名）。留空
    /// 时退回 "Node_0"。
    pub dc_node: Option<String>,
    pub updated_at: Option<String>,
}

pub fn get(db: &Db, project_id: i64) -> VoloResult<Option<PsoProjectSettings>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT project_id, dc_cfg_source, dc_cfg_asset, dc_cfg_manual_path, extra_args,
                offscreen, target_machine_ids, max_minutes, probe_interval_secs, map_path, dc_node, updated_at
         FROM pso_project_settings WHERE project_id = ?",
    )?;
    let mut rows = stmt.query([project_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_settings(row)?))
    } else {
        Ok(None)
    }
}

pub fn upsert(db: &Db, input: &PsoProjectSettings) -> VoloResult<PsoProjectSettings> {
    {
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO pso_project_settings (
                project_id, dc_cfg_source, dc_cfg_asset, dc_cfg_manual_path, extra_args,
                offscreen, target_machine_ids, max_minutes, probe_interval_secs, map_path, dc_node, updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(project_id) DO UPDATE SET
                dc_cfg_source = excluded.dc_cfg_source,
                dc_cfg_asset = excluded.dc_cfg_asset,
                dc_cfg_manual_path = excluded.dc_cfg_manual_path,
                extra_args = excluded.extra_args,
                offscreen = excluded.offscreen,
                target_machine_ids = excluded.target_machine_ids,
                max_minutes = excluded.max_minutes,
                probe_interval_secs = excluded.probe_interval_secs,
                map_path = excluded.map_path,
                dc_node = excluded.dc_node,
                updated_at = CURRENT_TIMESTAMP",
            params![
                input.project_id,
                input.dc_cfg_source,
                input.dc_cfg_asset,
                input.dc_cfg_manual_path,
                input.extra_args,
                bool_to_i64(input.offscreen),
                input.target_machine_ids,
                input.max_minutes,
                input.probe_interval_secs,
                input.map_path,
                input.dc_node,
            ],
        )?;
    }
    get(db, input.project_id)?.ok_or_else(|| {
        VoloError::OperationFailed("pso_project_settings upsert: row missing after write".into())
    })
}

fn row_to_settings(row: &rusqlite::Row<'_>) -> rusqlite::Result<PsoProjectSettings> {
    Ok(PsoProjectSettings {
        project_id: row.get(0)?,
        dc_cfg_source: row.get(1)?,
        dc_cfg_asset: row.get(2)?,
        dc_cfg_manual_path: row.get(3)?,
        extra_args: row.get(4)?,
        offscreen: row.get::<_, i64>(5)? != 0,
        target_machine_ids: row.get(6)?,
        max_minutes: row.get(7)?,
        probe_interval_secs: row.get(8)?,
        map_path: row.get(9)?,
        dc_node: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{open_in_memory, projects, schema};

    fn setup() -> (Db, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let project_id = projects::upsert(
            &db,
            &projects::Project {
                id: None,
                uproject_name: "Demo.uproject".into(),
                uproject_stem_lower: "demo".into(),
                uproject_guid: None,
                display_name: None,
                first_seen_at: None,
                last_seen_at: None,
                ue_version_major: Some(5),
                ue_version_minor: Some(7),
                engine_association_raw: Some("5.7".into()),
                engine_association_kind: Some("version".into()),
            },
        )
        .unwrap();
        (db, project_id)
    }

    fn sample(project_id: i64) -> PsoProjectSettings {
        PsoProjectSettings {
            project_id,
            dc_cfg_source: "manual".into(),
            dc_cfg_asset: None,
            dc_cfg_manual_path: Some(r"D:\configs\stage.ndisplay".into()),
            extra_args: "-log".into(),
            offscreen: true,
            target_machine_ids: "[1,2]".into(),
            max_minutes: 20,
            probe_interval_secs: 30,
            map_path: None,
            dc_node: None,
            updated_at: None,
        }
    }

    #[test]
    fn upsert_inserts_when_new() {
        let (db, project_id) = setup();
        let got = upsert(&db, &sample(project_id)).unwrap();
        assert_eq!(got.project_id, project_id);
        assert_eq!(got.dc_cfg_source, "manual");
        assert_eq!(got.target_machine_ids, "[1,2]");
        assert!(got.updated_at.is_some());
    }

    #[test]
    fn upsert_updates_when_exists() {
        let (db, project_id) = setup();
        upsert(&db, &sample(project_id)).unwrap();
        let mut row = sample(project_id);
        row.dc_cfg_source = "asset".into();
        row.dc_cfg_asset = Some("stage.ndisplay".into());
        row.max_minutes = 45;
        let got = upsert(&db, &row).unwrap();
        assert_eq!(got.dc_cfg_source, "asset");
        assert_eq!(got.dc_cfg_asset.as_deref(), Some("stage.ndisplay"));
        assert_eq!(got.max_minutes, 45);
        let fetched = get(&db, project_id).unwrap().unwrap();
        assert_eq!(fetched.dc_cfg_source, "asset");
    }

    #[test]
    fn get_returns_none_when_missing() {
        let (db, _project_id) = setup();
        assert!(get(&db, 9999).unwrap().is_none());
    }
}
