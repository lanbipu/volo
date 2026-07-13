use mesh_core::export::build::surface_to_mesh_output;
use mesh_core::export::obj::write_obj;
use mesh_core::shape::CabinetArray;
use mesh_core::surface::{
    GridTopology, MeshOutput, QualityMetrics, ReconstructedSurface, TargetSoftware, MAX_GRID_DIM,
};
use mesh_core::uv::compute_grid_uv;
use volo_shared::data::{runs, Db};
use volo_shared::dto::{
    CabinetPoseReportFile, ExportPoseObjResult, PoseReportGauge, ReconstructionReport, ShapeMode,
};
use volo_shared::error::{VoloError, VoloResult};
use nalgebra::Vector3;
use std::path::{Path, PathBuf};

fn parse_target(s: &str) -> VoloResult<TargetSoftware> {
    match s {
        "disguise" => Ok(TargetSoftware::Disguise),
        "unreal" => Ok(TargetSoftware::Unreal),
        "neutral" => Ok(TargetSoftware::Neutral),
        other => Err(VoloError::InvalidInput(format!("unknown target: {other}"))),
    }
}

pub fn build_shape_prior(
    screen_cfg: &volo_shared::dto::ScreenConfig,
) -> VoloResult<mesh_core::shape::ShapePrior> {
    use volo_shared::dto::ShapePriorConfig;
    Ok(match &screen_cfg.shape_prior {
        ShapePriorConfig::Flat => mesh_core::shape::ShapePrior::Flat,
        ShapePriorConfig::Curved { radius_mm, .. } => {
            mesh_core::shape::ShapePrior::Curved { radius_mm: *radius_mm }
        }
        ShapePriorConfig::Folded { fold_seams_at_columns } => mesh_core::shape::ShapePrior::Folded {
            fold_seam_columns: fold_seams_at_columns.clone(),
        },
        ShapePriorConfig::Arc { center_flat_cols, angle_per_col_deg } => {
            mesh_core::shape::ShapePrior::Arc {
                center_flat_cols: *center_flat_cols,
                angle_per_col_deg: *angle_per_col_deg,
            }
        }
        ShapePriorConfig::LShape { left_cols, soften_cols, corner_angle_deg } => {
            mesh_core::shape::ShapePrior::LShape {
                left_cols: *left_cols,
                soften_cols: *soften_cols,
                corner_angle_deg: *corner_angle_deg,
            }
        }
        ShapePriorConfig::UShape { wing_cols, soften_cols, corner_angle_deg } => {
            mesh_core::shape::ShapePrior::UShape {
                wing_cols: *wing_cols,
                soften_cols: *soften_cols,
                corner_angle_deg: *corner_angle_deg,
            }
        }
        ShapePriorConfig::CustomSegments { segments } => mesh_core::shape::ShapePrior::CustomSegments {
            segments: segments
                .iter()
                .map(|s| mesh_core::shape::ShapeSegment { cols: s.cols, cum_angle_deg: s.cum_angle_deg })
                .collect(),
        },
    })
}

pub fn build_cabinet_array(screen_cfg: &volo_shared::dto::ScreenConfig) -> VoloResult<CabinetArray> {
    let [cols, rows] = screen_cfg.cabinet_count;
    let cabinet_size_mm = screen_cfg.cabinet_size_mm;
    match screen_cfg.shape_mode {
        ShapeMode::Rectangle => Ok(CabinetArray::rectangle(cols, rows, cabinet_size_mm)),
        ShapeMode::Irregular => {
            let absent: Vec<(u32, u32)> = screen_cfg
                .irregular_mask
                .iter()
                .map(|&[c, r]| (c, r))
                .collect();
            Ok(CabinetArray::irregular(cols, rows, cabinet_size_mm, absent))
        }
    }
}

/// Rotate (about world +Y, `yaw_deg`) then translate (`position_m`) every
/// vertex in place. Identity when both fields are default (0), which is
/// every `project.yaml` written before these fields existed.
fn apply_world_transform(vertices: &mut [Vector3<f64>], screen_cfg: &volo_shared::dto::ScreenConfig) {
    if screen_cfg.yaw_deg == 0.0 && screen_cfg.position_m == [0.0, 0.0, 0.0] {
        return;
    }
    // Model-frame Z is the row axis (the one shape_grid.rs's expected_grid_positions
    // and CoordinateFrame::from_three_points_m01 leave invariant across columns —
    // see the frame's `[b0, b2, -b1]` permutation), i.e. the wall's own "up" —
    // not world Y. Yaw therefore rotates the X-Y (column/bow) plane and leaves Z
    // untouched, so a screen spins in place around its own vertical axis.
    let theta = screen_cfg.yaw_deg.to_radians();
    let (s, c) = theta.sin_cos();
    let [tx, ty, tz] = screen_cfg.position_m;
    for v in vertices.iter_mut() {
        let (x, y) = (v.x, v.y);
        v.x = x * c + y * s + tx;
        v.y = -x * s + y * c + ty;
        v.z += tz;
    }
}

pub fn run_export(
    db: Db,
    run_id: i64,
    target: &str,
    dst_abs_path: Option<&std::path::Path>,
) -> VoloResult<String> {
    let target_enum = parse_target(target)?;

    let (project_path, report_rel) = {
        let conn = db.lock().unwrap();
        runs::get_report_path(&conn, run_id)?
    };

    let project_root = PathBuf::from(&project_path);
    let report_abs = project_root.join(&report_rel);
    let mut report: ReconstructionReport = serde_json::from_slice(&std::fs::read(&report_abs)?)?;

    // World-space placement (`ScreenConfig.position_m`/`yaw_deg`) is a
    // presentation-layer transform, not a reconstruction input — unlike
    // weld_tolerance/cabinet_array below (frozen in the report so re-exports
    // stay reproducible), this reads the *current* project.yaml so moving a
    // screen after reconstruction is reflected without re-running it. A
    // missing/unreadable project.yaml or a since-renamed screen id just
    // falls back to identity — this is a placement nicety, not something
    // that should fail the export.
    if let Ok(config) = crate::projects::load_project_yaml_from_path(&project_root) {
        if let Some(screen_cfg) = config.screens.get(&report.surface.screen_id) {
            apply_world_transform(&mut report.surface.vertices, screen_cfg);
        }
    }

    // Use snapshotted values from the report — no re-read of project.yaml.
    let weld_m = report.weld_tolerance_mm / 1000.0;
    let mesh = surface_to_mesh_output(&report.surface, &report.cabinet_array, target_enum, weld_m)?;

    // Caller-chosen destination (from a save dialog) takes precedence; otherwise
    // fall back to the legacy `{project}/output/<screen>_<target>_run<id>.obj`.
    //
    // DB bookkeeping (`runs.output_obj_path`): project-relative when the
    // chosen path is under `{project}/`, else absolute. UI must handle both
    // (an absolute path here will not survive a cross-machine project move —
    // M1.1 scope, revisit when project archive/import is added).
    let (out_abs, out_rel_for_db) = match dst_abs_path {
        Some(p) => {
            // `out_abs` 给 caller 返回时保持 raw(caller 看到自己给的 path
            // 形态,API 不变);但 strip_prefix 时用 canonical 版本跟
            // canonical project_root 比较——这样 macOS `/var/folders/...`
            // (raw)与 `/private/var/folders/...`(canonical)不会因
            // symlink 错位让 output_obj_path 退回 absolute。
            let abs_raw = ensure_obj_extension(p);
            if let Some(parent) = abs_raw.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)?;
                }
            }
            let canon_for_compare = match (abs_raw.parent(), abs_raw.file_name()) {
                (Some(parent), Some(file)) if !parent.as_os_str().is_empty() => {
                    let canon_parent =
                        std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
                    canon_parent.join(file)
                }
                _ => abs_raw.clone(),
            };
            // project_root 来自 DB:本 patch 之后写入是 canonical,但旧 row
            // 可能仍是 raw symlink。两种 abs(raw / canonical)各跟两种 root
            // (raw / canonical)都试一遍,任一组合 strip 成功就用它的
            // project-relative 表示,否则 fallback 到原始 absolute。
            let canon_root = std::fs::canonicalize(&project_root)
                .unwrap_or_else(|_| project_root.clone());
            let rel = [
                abs_raw.strip_prefix(&project_root).ok(),
                canon_for_compare.strip_prefix(&project_root).ok(),
                abs_raw.strip_prefix(&canon_root).ok(),
                canon_for_compare.strip_prefix(&canon_root).ok(),
            ]
            .into_iter()
            .flatten()
            .next()
            .map(|r| r.display().to_string())
            .unwrap_or_else(|| abs_raw.display().to_string());
            (abs_raw, rel)
        }
        None => {
            let rel = PathBuf::from("output")
                .join(format!("{}_{target}_run{run_id}.obj", report.screen_id));
            let abs = project_root.join(&rel);
            if let Some(parent) = abs.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)?;
                }
            }
            (abs, rel.display().to_string())
        }
    };
    write_obj(&mesh, &out_abs)?;

    {
        let conn = db.lock().unwrap();
        runs::update_export(&conn, run_id, target, &out_rel_for_db)?;
    }

    Ok(out_abs.display().to_string())
}

/// Merge a `cabinet_pose_report.json` into ONE world-frame OBJ.
///
/// 几何：每块 cabinet 一块独立 quad（4 顶点，不焊接），世界坐标烘进顶点。
/// UV：一张整体 0-1 网格，每块占它在 (cols×rows) 网格里的格子（cols/rows 由 cabinet_id 反推）；
/// 给了 `screen_mapping` 时按其 `input_rect_px` 生成非均匀 UV cell（FIX-13 ③）。
/// 几何按 `TargetSoftware::Neutral` 原样输出（pose report 已是 +Y up / +Z outward = disguise 约定，
/// 不套 core→target 适配器）。`target` 字符串校验+记录但不改轴；
/// `unreal` 显式拒绝（FIX-13 ②：pose-report 帧没有已验证的 UE 适配，宁可 exit 2 不给假出口）。
///
/// `--root`：以该 cabinet 局部系为世界系（它轴对齐落原点），其余块保持真实相对位姿。
/// `--ground`：底边贴地（基准=root 块，未给 root 时=整体）。
/// `--split`：每块 cabinet 独立 OBJ（FIX-13 ①：与合并路径共用同一变换源——
/// disguise 的 canonical 摆位 / flipY / winding / UV-V 翻转照常生效，
/// split 文件与合并导出对应箱体逐顶点一致；仅 UV 改为每文件独立 [0,1]）。
pub fn run_export_pose_obj(
    pose_report_path: &Path,
    target: &str,
    out_file: &Path,
    root: Option<&str>,
    ground: bool,
    split: bool,
    screen_mapping: Option<&Path>,
) -> VoloResult<ExportPoseObjResult> {
    let target_enum = parse_target(target)?; // 校验 target；几何原样（Neutral）
    reject_unreal_pose_obj(target_enum)?;
    if split && screen_mapping.is_some() {
        return Err(VoloError::InvalidInput(
            "--screen-mapping shapes the merged UV atlas; --split files each carry \
             their own full [0,1] UV (disguise assigns per-cabinet feed rects natively) \
             — drop one of the two flags"
                .into(),
        ));
    }
    let report: CabinetPoseReportFile =
        serde_json::from_slice(&std::fs::read(pose_report_path)?)?;
    if report.cabinet_poses.is_empty() {
        return Err(VoloError::InvalidInput(
            "pose report has no cabinet_poses".into(),
        ));
    }

    // align_to_nominal report 已被重建端 Procrustes 摆进设计帧,导出**不能**再
    // 猜朝向(apply_canonical_frame);--root 会覆盖这个已定的摆放,故拒。
    let align = report.frame.gauge_strategy == PoseReportGauge::AlignToNominal;
    if align && root.is_some() {
        return Err(VoloError::InvalidInput(
            "align_to_nominal report is already in the design frame; --root would override it".into(),
        ));
    }

    // 网格维度（同时校验每个 cabinet_id 可解析）。
    let ids: Vec<&str> = report
        .cabinet_poses
        .iter()
        .map(|c| c.cabinet_id.as_str())
        .collect();
    let (cols, rows) = infer_grid_dims(&ids)?;

    // 可选 re-root：从基准 cabinet 推 world→local 变换。
    let frame = match root {
        None => None,
        Some(rid) => {
            let rc = report
                .cabinet_poses
                .iter()
                .find(|c| c.cabinet_id == rid)
                .ok_or_else(|| {
                    VoloError::NotFound(format!("--root cabinet '{rid}' not in pose report"))
                })?;
            Some(CabinetFrame::from_corners(&rc.corners_mm).ok_or_else(|| {
                VoloError::InvalidInput(format!(
                    "--root cabinet '{rid}' has degenerate corners (zero-area or collinear)"
                ))
            })?)
        }
    };

    // 每块：(id, col, row, 角点[已应用 re-root])。
    let mut panels: Vec<(String, u32, u32, [[f64; 3]; 4])> =
        Vec::with_capacity(report.cabinet_poses.len());
    for cab in &report.cabinet_poses {
        let (col, row) = parse_cabinet_col_row(&cab.cabinet_id).ok_or_else(|| {
            VoloError::InvalidInput(format!(
                "cabinet_id {:?} not parseable as V<col>_R<row>",
                cab.cabinet_id
            ))
        })?;
        let mut cs = cab.corners_mm;
        if let Some(f) = &frame {
            for c in cs.iter_mut() {
                *c = f.world_to_local(c);
            }
        }
        panels.push((cab.cabinet_id.clone(), col, row, cs));
    }

    // 摆放 + disguise 约定。disguise(不管有没有 --root)统一产出:发光面 +Y up、朝观众、内容正向。
    //   - 无 root → 标准摆法(中心列转正 + flipY + 居中 + 贴地)。
    //   - 有 root → re-root(上面已应用)+ 补 flipY(re-root 是 canonical 的镜像,差一个反射)+ 贴地。
    //   - neutral → 原始帧(+可选 --ground),不套任何 disguise 约定。
    // flipY 是反射:后面对所有 disguise 反转 winding(发光面 +Z)、panel UV cell 内 V 翻转(内容正向)。
    // FIX-13 ①: --split 与合并路径共用这同一变换源——旧代码 split 跳过全部
    // disguise 补偿,split 出的逐箱体 OBJ 留在 fix_root 帧(对 disguise 含
    // det=−1 反射的镜像手性),disguise 内刚体摆位救不回。
    let disguise = target_enum == TargetSoftware::Disguise;
    // align report 已被 sidecar 的 Procrustes 摆进 nominal 设计帧（+Y up / +Z outward /
    // rows-up：row0 在底部）。它**已经是** fix_root 经 flipY 后要达到的那个朝向,所以
    // disguise 这条不能再套 flipY(会上下行颠倒,Codex P1),也不能强制贴地(破坏设计帧绝对
    // 位置)。flipY 的补偿(winding swap + UV cell V 翻)同样只对非 align 路径做(见下)。
    let canonical_disguise = !align && root.is_none() && disguise;
    let disguise_compensate = disguise && !align;
    if canonical_disguise {
        apply_canonical_frame(&mut panels, cols)?;
    } else if align {
        if ground {
            ground_shift(&mut panels, root);
        }
    } else {
        if disguise {
            for (_, _, _, cs) in panels.iter_mut() {
                for p in cs.iter_mut() {
                    p[1] = -p[1];
                }
            }
        }
        if ground || disguise {
            ground_shift(&mut panels, root);
        }
    }

    // 每块 → 1×1 surface（格子 UV）→ MeshOutput（Neutral 原样，weld 0）。
    let unit_array = CabinetArray::rectangle(1, 1, [1.0, 1.0]);

    if split {
        // --split: each cabinet is an independent OBJ with full [0,1] UV.
        // Geometry shares the merged path's transforms (FIX-13 ①), including
        // the disguise winding swap + in-cell V flip.
        let out_dir = out_file;
        std::fs::create_dir_all(out_dir)?;
        let mut files = Vec::with_capacity(panels.len());
        for (cid, col, row, cs) in &panels {
            let surface = panel_surface(cid, cs, [0.0, 1.0, 0.0, 1.0], disguise_compensate);
            let mut mesh = surface_to_mesh_output(
                &surface, &unit_array, TargetSoftware::Neutral, 0.0)?;
            if disguise_compensate {
                for t in mesh.triangles.iter_mut() {
                    t.swap(1, 2);
                }
            }
            let safe_name = format!("V{col:03}_R{row:03}.obj");
            let obj_path = out_dir.join(&safe_name);
            write_obj(&mesh, &obj_path)?;
            files.push(obj_path.display().to_string());
        }
        Ok(ExportPoseObjResult {
            target: target.to_string(),
            cabinet_count: panels.len(),
            file: out_dir.display().to_string(),
            files,
        })
    } else {
        // Merge all cabinets into a single OBJ (UV atlas + disguise compensation).
        // FIX-13 ③: UV cell 默认均匀 cols×rows 网格;给了 screen_mapping 时按
        // input_rect_px 的实际画布矩形(非均匀布局,如带 y 间隙的 monitor bench)。
        let mapping_cells = match screen_mapping {
            Some(path) => Some(load_screen_mapping_cells(path, &panels)?),
            None => None,
        };
        let mut merge_meshes = Vec::with_capacity(panels.len());
        for (cid, col, row, cs) in &panels {
            let cell = match &mapping_cells {
                Some(cells) => cells[&(*col, *row)],
                None => {
                    // Cabinet row 0 = screen top, but UV V=0 = screen bottom.
                    let v_row = rows - 1 - *row;
                    [
                        *col as f64 / cols as f64,
                        (*col + 1) as f64 / cols as f64,
                        v_row as f64 / rows as f64,
                        (v_row + 1) as f64 / rows as f64,
                    ]
                },
            };
            let surface = panel_surface(cid, cs, cell, disguise_compensate);
            let mut mesh = surface_to_mesh_output(
                &surface, &unit_array, TargetSoftware::Neutral, 0.0)?;
            if disguise_compensate {
                for t in mesh.triangles.iter_mut() {
                    t.swap(1, 2);
                }
            }
            merge_meshes.push(mesh);
        }
        let combined = merge_mesh_outputs(TargetSoftware::Neutral, &merge_meshes);
        let out = ensure_obj_extension(out_file);
        if let Some(parent) = out.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        write_obj(&combined, &out)?;
        Ok(ExportPoseObjResult {
            target: target.to_string(),
            cabinet_count: panels.len(),
            file: out.display().to_string(),
            files: vec![],
        })
    }
}

/// FIX-13 ②: pose-obj 不支持 unreal——pose-report 帧（+Y up / +Z outward）
/// 没有对账验证过的 UE 适配；core 的 `adapt_to_target` 假设的是 model 帧
/// （+Z up / +Y normal），直接套会静默产出错轴错单位的文件。宁可拒绝。
fn reject_unreal_pose_obj(target: TargetSoftware) -> VoloResult<()> {
    if target == TargetSoftware::Unreal {
        return Err(VoloError::InvalidInput(
            "pose-obj does not support target 'unreal' (no verified pose-report→UE \
             frame adaptation; refusing to emit a silently-wrong file). Export \
             'neutral' and convert in your DCC, or use `lmt export obj <run_id> unreal` \
             for surface-run exports"
                .into(),
        ));
    }
    Ok(())
}

/// FIX-13 ③: 读 screen_mapping.json,把每个 panel 的 `input_rect_px` 换算成
/// 整画布归一化 UV cell `[u0, u1, v0, v1]`。画布尺寸 = 所有 rect 的包络
/// （max(x+w) × max(y+h)）。校验:每个 panel 在 mapping 里有对应 rect、
/// rect 非退化、坐标非负。V 方向与均匀网格一致(row0 矩形 → V 低端),
/// 均匀布局的 mapping 退化为与默认网格 UV 完全相同。
fn load_screen_mapping_cells(
    path: &Path,
    panels: &[(String, u32, u32, [[f64; 3]; 4])],
) -> VoloResult<std::collections::HashMap<(u32, u32), [f64; 4]>> {
    let mapping: volo_shared::dto::ScreenMappingFile =
        serde_json::from_slice(&std::fs::read(path)?)?;
    let mut rects: std::collections::HashMap<(u32, u32), [i64; 4]> =
        std::collections::HashMap::new();
    let (mut canvas_w, mut canvas_h) = (0i64, 0i64);
    for cab in &mapping.cabinets {
        let (col, row) = parse_cabinet_col_row(&cab.cabinet_id).ok_or_else(|| {
            VoloError::InvalidInput(format!(
                "screen_mapping cabinet_id {:?} not parseable as V<col>_R<row>",
                cab.cabinet_id
            ))
        })?;
        let [x, y, w, h] = cab.input_rect_px;
        if x < 0 || y < 0 || w <= 0 || h <= 0 {
            return Err(VoloError::InvalidInput(format!(
                "screen_mapping cabinet {:?} has degenerate input_rect_px {:?}",
                cab.cabinet_id, cab.input_rect_px
            )));
        }
        canvas_w = canvas_w.max(x + w);
        canvas_h = canvas_h.max(y + h);
        rects.insert((col, row), cab.input_rect_px);
    }
    let mut cells = std::collections::HashMap::new();
    for (cid, col, row, _) in panels {
        let [x, y, w, h] = *rects.get(&(*col, *row)).ok_or_else(|| {
            VoloError::InvalidInput(format!(
                "pose-report cabinet {cid:?} (V{col:03}_R{row:03}) has no \
                 input_rect_px entry in the screen_mapping"
            ))
        })?;
        // input_rect_px y is top-down (pixel coords), UV V is bottom-up.
        cells.insert(
            (*col, *row),
            [
                x as f64 / canvas_w as f64,
                (x + w) as f64 / canvas_w as f64,
                (canvas_h - (y + h)) as f64 / canvas_h as f64,
                (canvas_h - y) as f64 / canvas_h as f64,
            ],
        );
    }
    Ok(cells)
}

/// Dry-run pre-flight for [`run_export_pose_obj`]: the pose report must be
/// readable, non-empty, ids 可解析,(若 `root` 给了)含该 cabinet,且
/// (disguise 无 root 时)标准摆法能定向 —— 使 `--dry-run` 不放行 execute 会拒的导出。
pub fn check_pose_obj_inputs(
    pose_report_path: &Path,
    target: &str,
    root: Option<&str>,
    split: bool,
    screen_mapping: Option<&Path>,
) -> VoloResult<()> {
    // dry-run 与 execute 对齐:unreal 假出口拒绝(FIX-13 ②)。
    reject_unreal_pose_obj(parse_target(target)?)?;
    if split && screen_mapping.is_some() {
        return Err(VoloError::InvalidInput(
            "--screen-mapping shapes the merged UV atlas; --split files each carry \
             their own full [0,1] UV (disguise assigns per-cabinet feed rects natively) \
             — drop one of the two flags"
                .into(),
        ));
    }
    let report: CabinetPoseReportFile =
        serde_json::from_slice(&std::fs::read(pose_report_path)?)?;
    if report.cabinet_poses.is_empty() {
        return Err(VoloError::InvalidInput(
            "pose report has no cabinet_poses".into(),
        ));
    }
    // dry-run 与 execute 对齐：align_to_nominal report 拒 --root。
    if report.frame.gauge_strategy == PoseReportGauge::AlignToNominal && root.is_some() {
        return Err(VoloError::InvalidInput(
            "align_to_nominal report is already in the design frame; --root would override it".into(),
        ));
    }
    // dry-run 与 execute 对齐：不可解析的 cabinet_id 现在就拒。
    let ids: Vec<&str> = report
        .cabinet_poses
        .iter()
        .map(|c| c.cabinet_id.as_str())
        .collect();
    let (cols, _rows) = infer_grid_dims(&ids)?;
    if let Some(rid) = root {
        if !report.cabinet_poses.iter().any(|c| c.cabinet_id == rid) {
            return Err(VoloError::NotFound(format!(
                "--root cabinet '{rid}' not in pose report"
            )));
        }
    }
    // dry-run 与 execute 对齐：disguise 无 root 走标准摆法,这里预检能否定向
    // (退化墙 execute 会 InvalidInput,dry-run 必须同样拒)。
    if root.is_none() && target == "disguise" {
        let panels: Vec<(String, u32, u32, [[f64; 3]; 4])> = report
            .cabinet_poses
            .iter()
            .filter_map(|c| {
                parse_cabinet_col_row(&c.cabinet_id)
                    .map(|(col, row)| (c.cabinet_id.clone(), col, row, c.corners_mm))
            })
            .collect();
        if center_column_forward(&panels, cols).is_none() {
            return Err(VoloError::InvalidInput(
                "cannot auto-orient: wall normal near-vertical or no usable cabinets; pass --root <cabinet_id>".into(),
            ));
        }
    }
    // dry-run 与 execute 对齐:screen_mapping 可读、覆盖全部 pose 箱体、rect 非退化。
    if let Some(mapping_path) = screen_mapping {
        let panels: Vec<(String, u32, u32, [[f64; 3]; 4])> = report
            .cabinet_poses
            .iter()
            .filter_map(|c| {
                parse_cabinet_col_row(&c.cabinet_id)
                    .map(|(col, row)| (c.cabinet_id.clone(), col, row, c.corners_mm))
            })
            .collect();
        load_screen_mapping_cells(mapping_path, &panels)?;
    }
    Ok(())
}

/// A cabinet's local frame derived from its 4 world corners (BL,BR,TR,TL).
/// Origin = panel center; +x = width (BL→BR); +z = outward (x × BL→TL); +y = z×x.
/// `world_to_local` maps a world point (mm) into this orthonormal RH frame.
struct CabinetFrame {
    center: Vector3<f64>,
    x: Vector3<f64>,
    y: Vector3<f64>,
    z: Vector3<f64>,
}

impl CabinetFrame {
    /// `None` if the panel is degenerate (coincident/collinear corners), where
    /// `normalize()` would yield non-finite components and poison the geometry.
    fn from_corners(c: &[[f64; 3]; 4]) -> Option<Self> {
        let v = |i: usize| Vector3::new(c[i][0], c[i][1], c[i][2]);
        let (bl, br, tl) = (v(0), v(1), v(3));
        let center = (v(0) + v(1) + v(2) + v(3)) / 4.0;
        let x = (br - bl).normalize();
        let z = x.cross(&(tl - bl)).normalize();
        let y = z.cross(&x);
        let finite = |a: &Vector3<f64>| a.x.is_finite() && a.y.is_finite() && a.z.is_finite();
        if !(finite(&x) && finite(&y) && finite(&z)) {
            return None;
        }
        Some(Self { center, x, y, z })
    }
    fn world_to_local(&self, p: &[f64; 3]) -> [f64; 3] {
        let d = Vector3::new(p[0], p[1], p[2]) - self.center;
        [self.x.dot(&d), self.y.dot(&d), self.z.dot(&d)]
    }
}

/// 从 cabinet_id 解析末尾的 `V<col>_R<row>`（如 "V012_R007" → (12,7)）。
/// 容忍前缀（"MAIN_V012_R007" 也可）。不匹配返回 None。
fn parse_cabinet_col_row(cabinet_id: &str) -> Option<(u32, u32)> {
    let (head, row_str) = cabinet_id.rsplit_once("_R")?;
    let (_, col_str) = head.rsplit_once('V')?;
    Some((col_str.parse().ok()?, row_str.parse().ok()?))
}

/// 总列/行数 = max(col)+1 / max(row)+1。任一 id 不可解析 → InvalidInput。
/// 越界 index（≥ MAX_GRID_DIM）也拒：既防 `max+1` 溢出（pose report 是外部文件，
/// 可含 `V4294967295_R000` 这类极值），又与 GridTopology 的 cols/rows 上限一致。
fn infer_grid_dims(ids: &[&str]) -> VoloResult<(u32, u32)> {
    let mut max_col = 0u32;
    let mut max_row = 0u32;
    for id in ids {
        let (c, r) = parse_cabinet_col_row(id).ok_or_else(|| {
            VoloError::InvalidInput(format!("cabinet_id {id:?} not parseable as V<col>_R<row>"))
        })?;
        if c >= MAX_GRID_DIM || r >= MAX_GRID_DIM {
            return Err(VoloError::InvalidInput(format!(
                "cabinet_id {id:?} grid index out of range (must be < {MAX_GRID_DIM})"
            )));
        }
        max_col = max_col.max(c);
        max_row = max_row.max(r);
    }
    Ok((max_col + 1, max_row + 1))
}

/// 把每块 cabinet 的 MeshOutput 拼成一个（顶点不去重=不焊接，三角面索引按累计偏移）。
fn merge_mesh_outputs(target: TargetSoftware, meshes: &[MeshOutput]) -> MeshOutput {
    let mut vertices = Vec::new();
    let mut triangles = Vec::new();
    let mut uv_coords = Vec::new();
    for m in meshes {
        let offset = vertices.len() as u32;
        vertices.extend_from_slice(&m.vertices);
        uv_coords.extend_from_slice(&m.uv_coords);
        for t in &m.triangles {
            triangles.push([t[0] + offset, t[1] + offset, t[2] + offset]);
        }
    }
    MeshOutput { target, vertices, triangles, uv_coords }
}

/// 墙中心列在位箱体的平均发光面外法向,取归一化水平分量。
/// 中心列 = round((cols-1)/2);该列空则取最近非空列。Path A 弧中点 θ_mid 的稳健类比:
/// ≥180° 包角墙(全墙平均法向会抵消)用中心列仍能定出明确前向。
/// 水平分量近 0(墙面朝上/下等病态)→ None。
fn center_column_forward(
    panels: &[(String, u32, u32, [[f64; 3]; 4])],
    cols: u32,
) -> Option<Vector3<f64>> {
    if panels.is_empty() || cols == 0 {
        return None;
    }
    let c_mid = cols / 2; // = round((cols-1)/2);偶数列取上中列(与 spec 一致,非 floor)
    let present: std::collections::BTreeSet<u32> = panels.iter().map(|(_, c, _, _)| *c).collect();
    let target_col = if present.contains(&c_mid) {
        c_mid
    } else {
        *present
            .iter()
            .min_by_key(|&&c| (c as i64 - c_mid as i64).abs())?
    };
    let mut sum = Vector3::zeros();
    let mut n = 0u32;
    for (_, c, _, cs) in panels.iter() {
        if *c == target_col {
            if let Some(f) = CabinetFrame::from_corners(cs) {
                sum += f.z;
                n += 1;
            }
        }
    }
    if n == 0 {
        return None;
    }
    let avg = sum / n as f64;
    let n_h = Vector3::new(avg.x, 0.0, avg.z);
    if n_h.norm() < 1e-6 {
        return None;
    }
    Some(n_h.normalize())
}

/// 标准摆法:中心列前向绕 +Y 转到 +Z + 贴地(min Y=0)+ 居中(水平质心→原点)。
/// 只转 yaw、保 +Y up —— 真实倾斜(roll/pitch)刻意保留(保真,见 spec §3)。
/// 整组刚性变换,逐箱体相对几何不变。无法定向(中心列水平法向≈0)→ InvalidInput。
fn apply_canonical_frame(
    panels: &mut [(String, u32, u32, [[f64; 3]; 4])],
    cols: u32,
) -> VoloResult<()> {
    let fwd = center_column_forward(panels, cols).ok_or_else(|| {
        VoloError::InvalidInput(
            "cannot auto-orient: wall normal near-vertical or no usable cabinets; pass --root <cabinet_id>".into(),
        )
    })?;
    // 对账已验证的 disguise 实拍模型(lmt_test_v02)反算出的变换:
    //   recon → disguise = R_y(θ) · diag(1,-1,1)   (Kabsch det<0 反射 + ~6° yaw,残差 3mm)
    // 即 ① flipY:recon 帧 +Y 来自屏内容 v 向(物理下)→ disguise +Y up;
    //    ② yaw 把中心列发光面外法向带到 +Z(列不翻;旧代码的 180° yaw 会把 X/列翻掉)。
    // winding 由调用方(disguise 分支)反转,补偿 flipY 反射,使发光面落 +Z。
    let theta = -fwd.x.atan2(fwd.z); // yaw 把 fwd 带到 +Z
    let (s, c) = theta.sin_cos();
    for (_, _, _, cs) in panels.iter_mut() {
        for p in cs.iter_mut() {
            let (x, z) = (p[0], p[2]);
            p[0] = x * c + z * s; // R_y(θ)
            p[1] = -p[1]; // flipY
            p[2] = -x * s + z * c;
        }
    }
    // 贴地 + 居中(全顶点)。
    let mut min_y = f64::INFINITY;
    let (mut sum_x, mut sum_z, mut n) = (0.0, 0.0, 0u32);
    for (_, _, _, cs) in panels.iter() {
        for p in cs.iter() {
            min_y = min_y.min(p[1]);
            sum_x += p[0];
            sum_z += p[2];
            n += 1;
        }
    }
    let (mean_x, mean_z) = (sum_x / n as f64, sum_z / n as f64);
    for (_, _, _, cs) in panels.iter_mut() {
        for p in cs.iter_mut() {
            p[0] -= mean_x;
            p[1] -= min_y;
            p[2] -= mean_z;
        }
    }
    Ok(())
}

/// 贴地:所有顶点 Y 减去基准块的最低 Y(基准=root 块,无 root 时整体最低)。
fn ground_shift(panels: &mut [(String, u32, u32, [[f64; 3]; 4])], root: Option<&str>) {
    let min_y = panels
        .iter()
        .filter(|(id, _, _, _)| root.map_or(true, |r| id == r))
        .flat_map(|(_, _, _, cs)| cs.iter().map(|c| c[1]))
        .fold(f64::INFINITY, f64::min);
    if min_y.is_finite() {
        for (_, _, _, cs) in panels.iter_mut() {
            for c in cs.iter_mut() {
                c[1] -= min_y;
            }
        }
    }
}

/// 一块 cabinet 的 4 个世界系角点（mm，BL,BR,TR,TL）→ 1×1 ReconstructedSurface（米，原样）。
/// 顶点行主序 [(0,0),(1,0),(0,1),(1,1)]=[BL,BR,TL,TR]，故把 [BL,BR,TR,TL] 重排为索引 0,1,3,2。
/// UV：把 1×1 单位 UV 重映射到 `cell = [u0, u1, v0, v1]`（均匀网格格子、
/// screen_mapping 矩形、或 split 模式的整张 [0,1]，由调用方决定 — FIX-13 ③）。
fn panel_surface(
    cabinet_id: &str,
    corners_mm: &[[f64; 3]; 4],
    cell: [f64; 4],
    flip_v: bool,
) -> ReconstructedSurface {
    let m = |i: usize| {
        Vector3::new(
            corners_mm[i][0] / 1000.0,
            corners_mm[i][1] / 1000.0,
            corners_mm[i][2] / 1000.0,
        )
    };
    let topology = GridTopology { cols: 1, rows: 1 };
    let uv_coords = compute_grid_uv(topology)
        .into_iter()
        .map(|uv| {
            // flip_v:几何被 flipY 竖直翻转时,cell 内 V 跟着翻,内容才不上下颠倒。
            let vy = if flip_v { 1.0 - uv.y } else { uv.y };
            nalgebra::Vector2::new(
                cell[0] + uv.x * (cell[1] - cell[0]),
                cell[2] + vy * (cell[3] - cell[2]),
            )
        })
        .collect();
    ReconstructedSurface {
        screen_id: cabinet_id.to_string(),
        uv_coords,
        vertices: vec![m(0), m(1), m(3), m(2)],
        topology,
        quality_metrics: QualityMetrics {
            method: "pose_report_quad".into(),
            measured_count: 4,
            expected_count: 4,
            ..Default::default()
        },
        scatter_fit: None,
        vertex_provenance: vec![],
    }
}

/// Append `.obj` if the path doesn't already end with that extension
/// (case-insensitive). Users who skip the dialog's filter and type
/// `mymesh` should still get a usable OBJ file.
///
/// `pub` 让 volo-cli 的 dry-run preview 跟 execute 一样的路径补全。
pub fn ensure_obj_extension(p: &Path) -> PathBuf {
    match p.extension() {
        Some(ext) if ext.eq_ignore_ascii_case("obj") => p.to_path_buf(),
        _ => {
            let mut buf = p.as_os_str().to_os_string();
            buf.push(".obj");
            PathBuf::from(buf)
        }
    }
}

/// 决定一次 OBJ 导出的最终绝对路径。run_export 与 volo-cli 的 dry-run
/// preview 共享这一份解析,避免 dry-run 报错的目标。
///
/// - 给定 `dst_abs_path` 时:用 [`ensure_obj_extension`] 补 .obj 扩展名。
/// - 缺省时:回退到旧的 `<project>/output/<screen>_<target>_run<id>.obj`。
pub fn resolve_export_dst(
    project_root: &Path,
    screen_id: &str,
    target: &str,
    run_id: i64,
    dst_abs_path: Option<&Path>,
) -> PathBuf {
    match dst_abs_path {
        Some(p) => ensure_obj_extension(p),
        None => project_root
            .join("output")
            .join(format!("{screen_id}_{target}_run{run_id}.obj")),
    }
}

/// 从 reconstruction_runs 表读 `(project_path, screen_id)`,供 dry-run
/// 在不读 report.json 的情况下解析默认导出路径。
pub fn lookup_run_paths(db: Db, run_id: i64) -> VoloResult<(String, String)> {
    let conn = db.lock().unwrap();
    conn.query_row(
        "SELECT project_path, screen_id FROM reconstruction_runs WHERE id = ?1",
        [run_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .map_err(|_| VoloError::NotFound(format!("run id {run_id}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use volo_shared::dto::{ScreenConfig, ShapeMode, ShapePriorConfig};

    fn default_screen_cfg() -> ScreenConfig {
        ScreenConfig {
            cabinet_count: [1, 1],
            cabinet_size_mm: [500.0, 500.0],
            pixels_per_cabinet: None,
            shape_prior: ShapePriorConfig::Flat,
            shape_mode: ShapeMode::Rectangle,
            irregular_mask: vec![],
            bottom_completion: None,
            position_m: [0.0, 0.0, 0.0],
            yaw_deg: 0.0,
        }
    }

    #[test]
    fn apply_world_transform_identity_is_noop() {
        let cfg = default_screen_cfg();
        let mut verts = vec![Vector3::new(1.0, 2.0, 3.0)];
        apply_world_transform(&mut verts, &cfg);
        assert_eq!(verts[0], Vector3::new(1.0, 2.0, 3.0));
    }

    #[test]
    fn apply_world_transform_rotates_about_z_then_translates() {
        let mut cfg = default_screen_cfg();
        cfg.yaw_deg = 90.0;
        cfg.position_m = [10.0, 0.0, 0.0];
        // +X axis point, yawed 90° about +Z (x' = x·c + y·s, y' = -x·s + y·c)
        // → lands on -Y, then offset by position_m. Z (the row/vertical axis)
        // is untouched by yaw.
        let mut verts = vec![Vector3::new(1.0, 0.0, 5.0)];
        apply_world_transform(&mut verts, &cfg);
        assert!((verts[0].x - 10.0).abs() < 1e-9, "got {:?}", verts[0]);
        assert!((verts[0].y - (-1.0)).abs() < 1e-9, "got {:?}", verts[0]);
        assert!((verts[0].z - 5.0).abs() < 1e-9, "row axis should be unaffected by yaw, got {:?}", verts[0]);
    }

    fn panel(col: u32, row: u32, corners: [[f64; 3]; 4]) -> (String, u32, u32, [[f64; 3]; 4]) {
        (format!("V{col:03}_R{row:03}"), col, row, corners)
    }
    /// 一块面向给定水平法向、竖直站立的箱体角点(BL,BR,TR,TL,mm)。
    fn facing_panel(col: u32, row: u32, nx: f64, nz: f64) -> (String, u32, u32, [[f64; 3]; 4]) {
        // right = up(+Y) × normal;normal=(nx,0,nz)
        let n = Vector3::new(nx, 0.0, nz).normalize();
        let up = Vector3::new(0.0, 1.0, 0.0);
        let right = up.cross(&n).normalize(); // 沿底边方向
        let (hw, hh) = (300.0, 170.0);
        let c = Vector3::new(col as f64 * 700.0, 0.0, 0.0); // 任意横向铺开
        let bl = c - right * hw - up * hh;
        let br = c + right * hw - up * hh;
        let tr = c + right * hw + up * hh;
        let tl = c - right * hw + up * hh;
        let v = |p: Vector3<f64>| [p.x, p.y, p.z];
        (format!("V{col:03}_R{row:03}"), col, row, [v(bl), v(br), v(tr), v(tl)])
    }

    #[test]
    fn center_column_forward_flat_wall() {
        // 3 列平墙全朝 +X → 中心列(col1)前向 ≈ +X
        let panels = vec![
            facing_panel(0, 0, 1.0, 0.0),
            facing_panel(1, 0, 1.0, 0.0),
            facing_panel(2, 0, 1.0, 0.0),
        ];
        let f = center_column_forward(&panels, 3).unwrap();
        assert!((f - Vector3::new(1.0, 0.0, 0.0)).norm() < 1e-6, "got {f:?}");
    }

    #[test]
    fn center_column_forward_handles_wraparound() {
        // 模拟 ≥180° 包角:法向铺满,平均会接近 0,但中心列(col1)朝 +Z 明确
        let panels = vec![
            facing_panel(0, 0, -1.0, 0.0),
            facing_panel(1, 0, 0.0, 1.0), // 中心列朝 +Z
            facing_panel(2, 0, 1.0, 0.0),
        ];
        let f = center_column_forward(&panels, 3).unwrap();
        assert!((f - Vector3::new(0.0, 0.0, 1.0)).norm() < 1e-6, "got {f:?}");
    }

    #[test]
    fn center_column_forward_degenerate_returns_none() {
        // 墙面朝上(法向≈+Y)→ 水平分量≈0 → None
        let flat_up = [[-300.0, 0.0, -170.0], [300.0, 0.0, -170.0], [300.0, 0.0, 170.0], [-300.0, 0.0, 170.0]];
        let panels = vec![panel(0, 0, flat_up)];
        assert!(center_column_forward(&panels, 1).is_none());
    }

    #[test]
    fn center_column_forward_even_width_rounds_up_center_column() {
        // 偶数列(cols=2):中心列 = cols/2 = 1(上中列,round),非 floor 的 0。
        // col0 朝 +X、col1 朝 +Z → 取 col1 → 前向 ≈ +Z(若 floor 会得 +X)。
        let panels = vec![facing_panel(0, 0, 1.0, 0.0), facing_panel(1, 0, 0.0, 1.0)];
        let f = center_column_forward(&panels, 2).unwrap();
        assert!(
            (f - Vector3::new(0.0, 0.0, 1.0)).norm() < 1e-6,
            "even-width center col should round up to col1 (+Z), got {f:?}"
        );
    }

    #[test]
    fn check_pose_obj_inputs_disguise_rejects_degenerate_but_neutral_ok() {
        let dir = tempdir().unwrap();
        let rp = dir.path().join("degenerate.json");
        // 两块都躺平(法向≈+Y)→ disguise 无法定向
        std::fs::write(
            &rp,
            r#"{"schema_version":"visual_pose_report.v1","frame":{},"cabinet_poses":[
 {"cabinet_id":"V000_R000","corners_mm":[[-300,0,-170],[300,0,-170],[300,0,170],[-300,0,170]]},
 {"cabinet_id":"V001_R000","corners_mm":[[400,0,-170],[1000,0,-170],[1000,0,170],[400,0,170]]}]}"#,
        )
        .unwrap();
        // disguise 无 root → 预检拒(与 execute 的 apply_canonical_frame 一致)
        assert!(matches!(
            check_pose_obj_inputs(&rp, "disguise", None, false, None),
            Err(VoloError::InvalidInput(_))
        ));
        // neutral 不走标准摆法 → 放行
        assert!(check_pose_obj_inputs(&rp, "neutral", None, false, None).is_ok());
        // disguise + 显式 --root → 放行(手动模式,不自动定向)
        assert!(check_pose_obj_inputs(&rp, "disguise", Some("V000_R000"), false, None).is_ok());
    }

    /// 把整组 panel 角点施加任意 yaw(绕Y)+ 平移(模拟不同架站/根箱体)。
    fn perturb_yaw_translate(
        panels: &[(String, u32, u32, [[f64; 3]; 4])],
        yaw: f64,
        t: [f64; 3],
    ) -> Vec<(String, u32, u32, [[f64; 3]; 4])> {
        let (s, c) = yaw.sin_cos();
        panels
            .iter()
            .map(|(id, col, row, cs)| {
                let nc = cs.map(|p| {
                    let (x, z) = (p[0], p[2]);
                    [x * c - z * s + t[0], p[1] + t[1], x * s + z * c + t[2]]
                });
                (id.clone(), *col, *row, nc)
            })
            .collect()
    }

    #[test]
    fn apply_canonical_frame_flipy_grounded_centered() {
        // 平墙朝 +X → 标准摆法后:贴地(min Y=0)、水平质心=0,且 flipY 把发光面摆到 +Z。
        // 注意 center_column_forward 用角点叉积算法向,flipY 是反射会把它翻成 -Z;
        // 真实 mesh 发光面 +Z 由 run_export_pose_obj 的 winding 反转保证(见
        // export_pose_obj_disguise_matches_v02_conventions)。这里 -Z 即是 flipY 已生效的证据。
        let mut panels = vec![
            facing_panel(0, 0, 1.0, 0.0),
            facing_panel(1, 0, 1.0, 0.0),
            facing_panel(2, 0, 1.0, 0.0),
        ];
        apply_canonical_frame(&mut panels, 3).unwrap();
        // flipY 后角点叉积法向 → -Z(发光面经 winding 反转后落 +Z)
        let f = center_column_forward(&panels, 3).unwrap();
        assert!((f - Vector3::new(0.0, 0.0, -1.0)).norm() < 1e-6, "facing {f:?}");
        // 贴地 + 居中
        let all: Vec<[f64; 3]> = panels.iter().flat_map(|(_, _, _, cs)| cs.iter().copied()).collect();
        let min_y = all.iter().map(|p| p[1]).fold(f64::INFINITY, f64::min);
        let mean_x = all.iter().map(|p| p[0]).sum::<f64>() / all.len() as f64;
        let mean_z = all.iter().map(|p| p[2]).sum::<f64>() / all.len() as f64;
        assert!(min_y.abs() < 1e-6, "min_y {min_y}");
        assert!(mean_x.abs() < 1e-6 && mean_z.abs() < 1e-6, "centroid ({mean_x},{mean_z})");
    }

    #[test]
    fn apply_canonical_frame_invariant_under_yaw_translation() {
        let base = vec![
            facing_panel(0, 0, 0.3, 1.0),
            facing_panel(1, 0, 0.0, 1.0),
            facing_panel(2, 0, -0.3, 1.0),
        ];
        let mut a = base.clone();
        apply_canonical_frame(&mut a, 3).unwrap();
        // 叠加任意 yaw + 平移后再标准摆法 → 与 a 逐顶点一致
        let mut b = perturb_yaw_translate(&base, 1.2345, [123.0, -45.0, 67.0]);
        apply_canonical_frame(&mut b, 3).unwrap();
        for ((_, _, _, ca), (_, _, _, cb)) in a.iter().zip(b.iter()) {
            for (pa, pb) in ca.iter().zip(cb.iter()) {
                for k in 0..3 {
                    assert!((pa[k] - pb[k]).abs() < 1e-6, "yaw+translate not invariant: {pa:?} vs {pb:?}");
                }
            }
        }
    }

    #[test]
    fn apply_canonical_frame_preserves_relative_geometry() {
        // 两块成已知夹角 → 标准摆法(刚性)后夹角不变
        let mut panels = vec![facing_panel(0, 0, 1.0, 0.0), facing_panel(1, 0, 0.0, 1.0)];
        let ang = |cs: &[[f64; 3]; 4]| CabinetFrame::from_corners(cs).unwrap().z;
        let before = ang(&panels[0].3).dot(&ang(&panels[1].3));
        apply_canonical_frame(&mut panels, 2).unwrap();
        let after = ang(&panels[0].3).dot(&ang(&panels[1].3));
        assert!((before - after).abs() < 1e-6, "relative angle changed: {before} -> {after}");
    }

    #[test]
    fn apply_canonical_frame_degenerate_errors() {
        // 墙面朝上 → 无法定向 → InvalidInput(不 panic)
        let flat_up = [[-300.0, 0.0, -170.0], [300.0, 0.0, -170.0], [300.0, 0.0, 170.0], [-300.0, 0.0, 170.0]];
        let mut panels = vec![panel(0, 0, flat_up)];
        assert!(matches!(apply_canonical_frame(&mut panels, 1), Err(VoloError::InvalidInput(_))));
    }

    const BENCH_REPORT: &str = r#"{
          "schema_version": "visual_pose_report.v1",
          "frame": {},
          "cabinet_poses": [
            {"cabinet_id":"V000_R000",
             "corners_mm":[[-300,-170,0],[300,-170,0],[300,170,0],[-300,170,0]]},
            {"cabinet_id":"V000_R001",
             "corners_mm":[[321,-391,-4],[793,-376,-1117],[803,303,-1104],[331,289,8]]}
          ]
        }"#;

    #[test]
    fn export_pose_obj_writes_single_merged_obj_with_grid_uv() {
        let dir = tempdir().unwrap();
        let rp = dir.path().join("BENCH_cabinet_pose_report.json");
        std::fs::write(&rp, BENCH_REPORT).unwrap();
        let out = dir.path().join("wall.obj");

        let res = run_export_pose_obj(&rp, "neutral", &out, None, false, false, None).unwrap();
        assert_eq!(res.cabinet_count, 2);
        assert!(out.is_file());

        let text = std::fs::read_to_string(&out).unwrap();
        // 2 块 × 4 顶点 = 8 个 v；2 块 × 2 三角 = 4 个 f
        assert_eq!(text.lines().filter(|l| l.starts_with("v ")).count(), 8);
        assert_eq!(text.lines().filter(|l| l.starts_with("f ")).count(), 4);
        // neutral = 原样世界坐标（米）→ V000_R000 的 BL (-0.3,-0.17,0)
        assert!(text.contains("v -0.3 -0.17 0"), "got:\n{text}");

        // UV 是整体网格：BENCH 两块=V000_R000/V000_R001 → cols=1,rows=2
        // 不同 U 值 = cols+1 = 2；不同 V 值 = rows+1 = 3
        let us: std::collections::BTreeSet<String> = text
            .lines()
            .filter_map(|l| l.strip_prefix("vt "))
            .map(|l| l.split_whitespace().next().unwrap().to_string())
            .collect();
        let vs: std::collections::BTreeSet<String> = text
            .lines()
            .filter_map(|l| l.strip_prefix("vt "))
            .map(|l| l.split_whitespace().nth(1).unwrap().to_string())
            .collect();
        assert_eq!(us.len(), 2, "distinct U should be cols+1=2: {us:?}");
        assert_eq!(vs.len(), 3, "distinct V should be rows+1=3: {vs:?}");
    }

    #[test]
    fn export_pose_obj_disguise_applies_canonical_placement() {
        let dir = tempdir().unwrap();
        let rp = dir.path().join("BENCH_cabinet_pose_report.json");
        std::fs::write(&rp, BENCH_REPORT).unwrap();
        let out = dir.path().join("wall_disguise.obj");

        let res = run_export_pose_obj(&rp, "disguise", &out, None, false, false, None).unwrap();
        assert_eq!(res.cabinet_count, 2);

        let text = std::fs::read_to_string(&out).unwrap();
        let verts: Vec<[f64; 3]> = text
            .lines()
            .filter_map(|l| l.strip_prefix("v "))
            .map(|l| {
                let n: Vec<f64> = l.split_whitespace().map(|t| t.parse().unwrap()).collect();
                [n[0], n[1], n[2]]
            })
            .collect();
        assert_eq!(verts.len(), 8);
        // 标准摆法:贴地 + 水平居中
        let min_y = verts.iter().map(|v| v[1]).fold(f64::INFINITY, f64::min);
        let mean_x = verts.iter().map(|v| v[0]).sum::<f64>() / 8.0;
        let mean_z = verts.iter().map(|v| v[2]).sum::<f64>() / 8.0;
        assert!(min_y.abs() < 1e-6, "grounded: min_y={min_y}");
        assert!(mean_x.abs() < 1e-6 && mean_z.abs() < 1e-6, "centered: ({mean_x},{mean_z})");
        // 不再是原始帧(原始 V000_R000 的 BL 是 -0.3,-0.17,0)
        assert!(!text.contains("v -0.3 -0.17 0"), "disguise should be canonical, not raw:\n{text}");
    }

    #[test]
    fn export_pose_obj_disguise_matches_v02_conventions() {
        // 对账已验证的 disguise 实拍模型 lmt_test_v02 反算出的约定:
        //   ① 列不翻(col0 在左,X 不镜像) ② flipY(content row0 落几何底部)
        //   ③ 发光面 winding 法向落 +Z。
        // 输入:recon 帧(+X 宽 / +Y=屏内容 v 向 / +Z outward)的 3 块平墙,全朝 +Z。
        let dir = tempdir().unwrap();
        let rp = dir.path().join("CONV_cabinet_pose_report.json");
        std::fs::write(
            &rp,
            r#"{"schema_version":"visual_pose_report.v1","frame":{},"cabinet_poses":[
 {"cabinet_id":"V000_R000","corners_mm":[[-200,-170,0],[200,-170,0],[200,170,0],[-200,170,0]]},
 {"cabinet_id":"V001_R000","corners_mm":[[300,-170,0],[700,-170,0],[700,170,0],[300,170,0]]},
 {"cabinet_id":"V000_R001","corners_mm":[[-200,-670,0],[200,-670,0],[200,-330,0],[-200,-330,0]]}]}"#,
        )
        .unwrap();
        let out = dir.path().join("conv.obj");
        run_export_pose_obj(&rp, "disguise", &out, None, false, false, None).unwrap();
        let text = std::fs::read_to_string(&out).unwrap();

        let verts: Vec<[f64; 3]> = text
            .lines()
            .filter_map(|l| l.strip_prefix("v "))
            .map(|l| {
                let n: Vec<f64> = l.split_whitespace().map(|t| t.parse().unwrap()).collect();
                [n[0], n[1], n[2]]
            })
            .collect();
        assert_eq!(verts.len(), 12, "3 cabinets × 4 verts");
        // cabinet i = verts[4i..4i+4]，顺序同 pose report:0=V000_R000,1=V001_R000,2=V000_R001
        let cen = |i: usize| {
            let s = &verts[4 * i..4 * i + 4];
            [
                s.iter().map(|v| v[0]).sum::<f64>() / 4.0,
                s.iter().map(|v| v[1]).sum::<f64>() / 4.0,
                s.iter().map(|v| v[2]).sum::<f64>() / 4.0,
            ]
        };
        // ① col0(cab0) 在 col1(cab1) 左边
        assert!(cen(0)[0] < cen(1)[0], "col0 must be left of col1: {} vs {}", cen(0)[0], cen(1)[0]);
        // ② flipY:content row0(cab0) 落在 row1(cab2) 下方(更小 Y)
        assert!(cen(0)[1] < cen(2)[1], "row0 must be below row1 (flipY): {} vs {}", cen(0)[1], cen(2)[1]);
        // ③ 第一块第一三角的 winding 法向落 +Z(发光面朝观众)
        let face0: Vec<usize> = text
            .lines()
            .find(|l| l.starts_with("f "))
            .unwrap()
            .split_whitespace()
            .skip(1)
            .map(|t| t.split('/').next().unwrap().parse::<usize>().unwrap() - 1)
            .collect();
        let v = |i: usize| Vector3::new(verts[i][0], verts[i][1], verts[i][2]);
        let n = (v(face0[1]) - v(face0[0])).cross(&(v(face0[2]) - v(face0[0]))).normalize();
        assert!(n.z > 0.9, "disguise lit face winding normal must be +Z, got {n:?}");

        // ④ cell 内 V 跟几何竖直对齐:flipY 后,几何更高(Y 大)的顶点 UV-V 也更大,
        // 否则每块内容上下颠倒(整墙横条错位)。取 cab0 的 vt,比最高/最低顶点的 V。
        let uvs: Vec<[f64; 2]> = text
            .lines()
            .filter_map(|l| l.strip_prefix("vt "))
            .map(|l| {
                let n: Vec<f64> = l.split_whitespace().map(|t| t.parse().unwrap()).collect();
                [n[0], n[1]]
            })
            .collect();
        // 顶点 i -> vt 索引(从 f 行)
        let mut vt_of = std::collections::HashMap::new();
        for l in text.lines().filter(|l| l.starts_with("f ")) {
            for tok in l.split_whitespace().skip(1) {
                let mut it = tok.split('/');
                let vi: usize = it.next().unwrap().parse::<usize>().unwrap() - 1;
                let ti: usize = it.next().unwrap().parse::<usize>().unwrap() - 1;
                vt_of.insert(vi, ti);
            }
        }
        let top = (0..4).max_by(|&a, &b| verts[a][1].total_cmp(&verts[b][1])).unwrap();
        let bot = (0..4).min_by(|&a, &b| verts[a][1].total_cmp(&verts[b][1])).unwrap();
        assert!(
            uvs[vt_of[&top]][1] > uvs[vt_of[&bot]][1],
            "UV V must follow geometry up: top vert V {} should exceed bottom vert V {}",
            uvs[vt_of[&top]][1],
            uvs[vt_of[&bot]][1]
        );
    }

    // ── align_to_nominal (Task 3): 跳过 canonical 猜测,复用已验证 disguise 约定 ──
    fn parse_obj_verts(text: &str) -> Vec<[f64; 3]> {
        text.lines()
            .filter_map(|l| l.strip_prefix("v "))
            .map(|l| {
                let n: Vec<f64> = l.split_whitespace().map(|t| t.parse().unwrap()).collect();
                [n[0], n[1], n[2]]
            })
            .collect()
    }

    #[test]
    fn export_pose_obj_align_neutral_is_passthrough() {
        // align_to_nominal report → neutral → 几何原样(米),不猜/不居中/不 yaw。
        let dir = tempdir().unwrap();
        let rp = dir.path().join("ALIGN_cabinet_pose_report.json");
        std::fs::write(
            &rp,
            r#"{"schema_version":"visual_pose_report.v1",
            "frame":{"gauge_strategy":"align_to_nominal"},
            "cabinet_poses":[
            {"cabinet_id":"V000_R000","corners_mm":[[100,-170,50],[500,-170,50],[500,170,-30],[100,170,-30]]}]}"#,
        )
        .unwrap();
        let out = dir.path().join("a.obj");
        run_export_pose_obj(&rp, "neutral", &out, None, false, false, None).unwrap();
        let verts = parse_obj_verts(&std::fs::read_to_string(&out).unwrap());
        assert_eq!(verts.len(), 4);
        // 顺序无关地断言输入 4 角(米)原样出现(passthrough)。
        let expect = [
            [0.1, -0.17, 0.05],
            [0.5, -0.17, 0.05],
            [0.5, 0.17, -0.03],
            [0.1, 0.17, -0.03],
        ];
        for e in expect {
            assert!(
                verts.iter().any(|v| (v[0] - e[0]).abs() < 1e-9
                    && (v[1] - e[1]).abs() < 1e-9
                    && (v[2] - e[2]).abs() < 1e-9),
                "expected passthrough vertex {e:?} in {verts:?}"
            );
        }
    }

    #[test]
    fn export_pose_obj_align_disguise_skips_canonical_center() {
        // 一面 X 偏移到 ~+1m 的平墙。canonical 会把 XZ 质心移到 0;align 必须保留偏移
        // (只 flipY+贴地,不 yaw/不居中)。
        let dir = tempdir().unwrap();
        let rp = dir.path().join("ALIGND_cabinet_pose_report.json");
        std::fs::write(
            &rp,
            r#"{"schema_version":"visual_pose_report.v1",
            "frame":{"gauge_strategy":"align_to_nominal"},
            "cabinet_poses":[
            {"cabinet_id":"V000_R000","corners_mm":[[800,0,0],[1200,0,0],[1200,400,0],[800,400,0]]}]}"#,
        )
        .unwrap();
        let out = dir.path().join("ad.obj");
        run_export_pose_obj(&rp, "disguise", &out, None, false, false, None).unwrap();
        let verts = parse_obj_verts(&std::fs::read_to_string(&out).unwrap());
        let cx = verts.iter().map(|v| v[0]).sum::<f64>() / verts.len() as f64;
        assert!(cx > 0.9, "align must NOT recenter X (canonical would → 0): cx={cx}");
        // disguise 约定:flipY + 贴地 → Y 落 [0, 0.4]。
        let ymin = verts.iter().map(|v| v[1]).fold(f64::INFINITY, f64::min);
        let ymax = verts.iter().map(|v| v[1]).fold(f64::NEG_INFINITY, f64::max);
        assert!(ymin.abs() < 1e-9 && (ymax - 0.4).abs() < 1e-9, "grounded Y [0,0.4]: [{ymin},{ymax}]");
    }

    #[test]
    fn export_pose_obj_align_rejects_root() {
        let dir = tempdir().unwrap();
        let rp = dir.path().join("ALIGNR_cabinet_pose_report.json");
        std::fs::write(
            &rp,
            r#"{"schema_version":"visual_pose_report.v1",
            "frame":{"gauge_strategy":"align_to_nominal"},
            "cabinet_poses":[
            {"cabinet_id":"V000_R000","corners_mm":[[0,0,0],[400,0,0],[400,400,0],[0,400,0]]}]}"#,
        )
        .unwrap();
        let out = dir.path().join("ar.obj");
        let err = run_export_pose_obj(&rp, "neutral", &out, Some("V000_R000"), false, false, None).unwrap_err();
        assert!(matches!(err, VoloError::InvalidInput(_)), "align + --root must be rejected, got {err:?}");
        // dry-run 必须同样拒(parity)。
        let derr = check_pose_obj_inputs(&rp, "neutral", Some("V000_R000"), false, None).unwrap_err();
        assert!(matches!(derr, VoloError::InvalidInput(_)), "dry-run must also reject align + --root, got {derr:?}");
    }

    #[test]
    fn export_pose_obj_align_disguise_preserves_row_order_and_lit_face() {
        // 2 行 1 列。align report 已在 nominal 设计帧（rows-up：row0 低 Y / row1 高 Y，
        // row0 在物理底部）。disguise **不得再 flipY**，否则上下行垂直颠倒（Codex P1）。
        let dir = tempdir().unwrap();
        let rp = dir.path().join("ALIGN2_cabinet_pose_report.json");
        std::fs::write(
            &rp,
            r#"{"schema_version":"visual_pose_report.v1",
            "frame":{"gauge_strategy":"align_to_nominal"},
            "cabinet_poses":[
            {"cabinet_id":"V000_R000","corners_mm":[[0,0,0],[400,0,0],[400,400,0],[0,400,0]]},
            {"cabinet_id":"V000_R001","corners_mm":[[0,400,0],[400,400,0],[400,800,0],[0,800,0]]}]}"#,
        )
        .unwrap();
        let out = dir.path().join("a2.obj");
        run_export_pose_obj(&rp, "disguise", &out, None, false, false, None).unwrap();
        let text = std::fs::read_to_string(&out).unwrap();
        let verts = parse_obj_verts(&text);
        assert_eq!(verts.len(), 8, "2 cabinets × 4 verts");
        // pose 顺序 0=V000_R000(row0), 1=V000_R001(row1)
        let cen = |i: usize| {
            let s = &verts[4 * i..4 * i + 4];
            [
                s.iter().map(|v| v[0]).sum::<f64>() / 4.0,
                s.iter().map(|v| v[1]).sum::<f64>() / 4.0,
                s.iter().map(|v| v[2]).sum::<f64>() / 4.0,
            ]
        };
        // ① 行序保持：row0 几何 Y < row1 几何 Y（align 不翻转；bug 会让 row0 跑到顶部）。
        assert!(cen(0)[1] < cen(1)[1], "row0 must stay below row1 (no flipY): {} vs {}", cen(0)[1], cen(1)[1]);
        // ② 发光面 winding 法向落 +Z（朝观众；与 v02 disguise 约定一致）。
        let face0: Vec<usize> = text
            .lines()
            .find(|l| l.starts_with("f "))
            .unwrap()
            .split_whitespace()
            .skip(1)
            .map(|t| t.split('/').next().unwrap().parse::<usize>().unwrap() - 1)
            .collect();
        let v = |i: usize| Vector3::new(verts[i][0], verts[i][1], verts[i][2]);
        let n = (v(face0[1]) - v(face0[0])).cross(&(v(face0[2]) - v(face0[0]))).normalize();
        assert!(n.z > 0.9, "align disguise lit face winding normal must be +Z, got {n:?}");
    }

    #[test]
    fn export_pose_obj_disguise_root_keeps_conventions() {
        // disguise --root 也必须满足 disguise 约定(发光面 +Z、内容正向、Y up):
        // re-root 是 canonical 的镜像,补 flipY + winding + V翻后两条路一致。
        let dir = tempdir().unwrap();
        let rp = dir.path().join("CONV_cabinet_pose_report.json");
        std::fs::write(
            &rp,
            r#"{"schema_version":"visual_pose_report.v1","frame":{},"cabinet_poses":[
 {"cabinet_id":"V000_R000","corners_mm":[[-200,-170,0],[200,-170,0],[200,170,0],[-200,170,0]]},
 {"cabinet_id":"V001_R000","corners_mm":[[300,-170,0],[700,-170,0],[700,170,0],[300,170,0]]},
 {"cabinet_id":"V000_R001","corners_mm":[[-200,-670,0],[200,-670,0],[200,-330,0],[-200,-330,0]]}]}"#,
        )
        .unwrap();
        let out = dir.path().join("conv_root.obj");
        run_export_pose_obj(&rp, "disguise", &out, Some("V000_R000"), false, false, None).unwrap();
        let text = std::fs::read_to_string(&out).unwrap();

        let verts: Vec<[f64; 3]> = text
            .lines()
            .filter_map(|l| l.strip_prefix("v "))
            .map(|l| {
                let n: Vec<f64> = l.split_whitespace().map(|t| t.parse().unwrap()).collect();
                [n[0], n[1], n[2]]
            })
            .collect();
        let uvs: Vec<[f64; 2]> = text
            .lines()
            .filter_map(|l| l.strip_prefix("vt "))
            .map(|l| {
                let n: Vec<f64> = l.split_whitespace().map(|t| t.parse().unwrap()).collect();
                [n[0], n[1]]
            })
            .collect();
        let mut vt_of = std::collections::HashMap::new();
        for l in text.lines().filter(|l| l.starts_with("f ")) {
            for tok in l.split_whitespace().skip(1) {
                let mut it = tok.split('/');
                let vi: usize = it.next().unwrap().parse::<usize>().unwrap() - 1;
                let ti: usize = it.next().unwrap().parse::<usize>().unwrap() - 1;
                vt_of.insert(vi, ti);
            }
        }
        // ① 发光面 winding 法向 +Z(cab0 第一三角)
        let face0: Vec<usize> = text
            .lines()
            .find(|l| l.starts_with("f "))
            .unwrap()
            .split_whitespace()
            .skip(1)
            .map(|t| t.split('/').next().unwrap().parse::<usize>().unwrap() - 1)
            .collect();
        let v = |i: usize| Vector3::new(verts[i][0], verts[i][1], verts[i][2]);
        let n = (v(face0[1]) - v(face0[0])).cross(&(v(face0[2]) - v(face0[0]))).normalize();
        assert!(n.z > 0.9, "disguise --root lit face must be +Z, got {n:?}");
        // ② 内容正向:cab0 几何更高的顶点 UV-V 更大
        let top = (0..4).max_by(|&a, &b| verts[a][1].total_cmp(&verts[b][1])).unwrap();
        let bot = (0..4).min_by(|&a, &b| verts[a][1].total_cmp(&verts[b][1])).unwrap();
        assert!(
            uvs[vt_of[&top]][1] > uvs[vt_of[&bot]][1],
            "disguise --root: UV V must follow geometry up (content upright)"
        );
        // ③ Y up:content row0(cab0)落在 row1(cab2)下方
        let cy = |i: usize| verts[4 * i..4 * i + 4].iter().map(|v| v[1]).sum::<f64>() / 4.0;
        assert!(cy(0) < cy(2), "disguise --root: row0 must be below row1 (Y up)");
    }

    /// FIX-13 ① 验收:--split 出的单箱体 OBJ 与合并导出中对应箱体逐顶点一致
    /// (旧代码 split 跳过 disguise 全部补偿 → 镜像手性)。
    #[test]
    fn export_pose_obj_split_disguise_matches_merged_vertices_and_winding() {
        let dir = tempdir().unwrap();
        let rp = dir.path().join("CONV_cabinet_pose_report.json");
        std::fs::write(
            &rp,
            r#"{"schema_version":"visual_pose_report.v1","frame":{},"cabinet_poses":[
 {"cabinet_id":"V000_R000","corners_mm":[[-200,-170,0],[200,-170,0],[200,170,0],[-200,170,0]]},
 {"cabinet_id":"V001_R000","corners_mm":[[300,-170,0],[700,-170,0],[700,170,0],[300,170,0]]},
 {"cabinet_id":"V000_R001","corners_mm":[[-200,-670,0],[200,-670,0],[200,-330,0],[-200,-330,0]]}]}"#,
        )
        .unwrap();
        let merged_out = dir.path().join("merged.obj");
        run_export_pose_obj(&rp, "disguise", &merged_out, None, false, false, None).unwrap();
        let merged = std::fs::read_to_string(&merged_out).unwrap();
        let merged_verts = parse_obj_verts(&merged);

        let split_dir = dir.path().join("split");
        let res =
            run_export_pose_obj(&rp, "disguise", &split_dir, None, false, true, None).unwrap();
        assert_eq!(res.files.len(), 3);

        // pose 顺序 = merged 顶点顺序:0=V000_R000,1=V001_R000,2=V000_R001。
        for (i, name) in ["V000_R000", "V001_R000", "V000_R001"].iter().enumerate() {
            let text =
                std::fs::read_to_string(split_dir.join(format!("{name}.obj"))).unwrap();
            let verts = parse_obj_verts(&text);
            assert_eq!(verts.len(), 4);
            for (j, v) in verts.iter().enumerate() {
                let m = merged_verts[4 * i + j];
                for k in 0..3 {
                    assert!(
                        (v[k] - m[k]).abs() < 1e-9,
                        "split {name} vert {j} axis {k}: {} vs merged {}",
                        v[k],
                        m[k]
                    );
                }
            }
            // winding 补偿同样生效:发光面法向 +Z。
            let face0: Vec<usize> = text
                .lines()
                .find(|l| l.starts_with("f "))
                .unwrap()
                .split_whitespace()
                .skip(1)
                .map(|t| t.split('/').next().unwrap().parse::<usize>().unwrap() - 1)
                .collect();
            let v = |i: usize| Vector3::new(verts[i][0], verts[i][1], verts[i][2]);
            let n = (v(face0[1]) - v(face0[0]))
                .cross(&(v(face0[2]) - v(face0[0])))
                .normalize();
            assert!(n.z > 0.9, "split {name} lit face must be +Z, got {n:?}");
        }
    }

    /// FIX-13 ② 验收:pose-obj 的 unreal 是假出口 → 显式 InvalidInput(exit 2),
    /// execute 与 dry-run 一致。
    #[test]
    fn export_pose_obj_rejects_unreal_target() {
        let dir = tempdir().unwrap();
        let rp = dir.path().join("BENCH_cabinet_pose_report.json");
        std::fs::write(&rp, BENCH_REPORT).unwrap();
        let out = dir.path().join("u.obj");
        let err =
            run_export_pose_obj(&rp, "unreal", &out, None, false, false, None).unwrap_err();
        assert!(matches!(err, VoloError::InvalidInput(_)), "got {err:?}");
        assert!(err.to_string().contains("unreal"));
        let derr = check_pose_obj_inputs(&rp, "unreal", None, false, None).unwrap_err();
        assert!(matches!(derr, VoloError::InvalidInput(_)), "dry-run parity: {derr:?}");
    }

    /// FIX-13 ③:均匀布局的 screen_mapping 必须复现默认网格 UV(回归锚),
    /// 非均匀偏移(y 间隙)按画布矩形出 UV;缺箱体 / split+mapping → 拒。
    #[test]
    fn export_pose_obj_screen_mapping_uv_cells() {
        let dir = tempdir().unwrap();
        let rp = dir.path().join("BENCH_cabinet_pose_report.json");
        std::fs::write(&rp, BENCH_REPORT).unwrap(); // V000_R000 + V000_R001 → 1×2
        let vt_set = |text: &str| -> std::collections::BTreeSet<String> {
            text.lines()
                .filter(|l| l.starts_with("vt "))
                .map(|l| l.to_string())
                .collect()
        };

        // 均匀 mapping(1080×1080 块,y 连续堆叠)→ 与无 mapping 输出 UV 完全一致。
        let sm_uniform = dir.path().join("sm_uniform.json");
        std::fs::write(
            &sm_uniform,
            r#"{"screen_id":"BENCH","cabinets":[
 {"cabinet_id":"V000_R000","input_rect_px":[0,0,1080,1080]},
 {"cabinet_id":"V000_R001","input_rect_px":[0,1080,1080,1080]}]}"#,
        )
        .unwrap();
        let out_plain = dir.path().join("plain.obj");
        let out_mapped = dir.path().join("mapped.obj");
        run_export_pose_obj(&rp, "neutral", &out_plain, None, false, false, None).unwrap();
        run_export_pose_obj(&rp, "neutral", &out_mapped, None, false, false, Some(&sm_uniform))
            .unwrap();
        assert_eq!(
            vt_set(&std::fs::read_to_string(&out_plain).unwrap()),
            vt_set(&std::fs::read_to_string(&out_mapped).unwrap()),
            "uniform screen_mapping must reproduce the default grid UV"
        );

        // 非均匀:row1 的 rect 带 120px y 间隙 → V cell 偏移可见。
        let sm_gap = dir.path().join("sm_gap.json");
        std::fs::write(
            &sm_gap,
            r#"{"screen_id":"BENCH","cabinets":[
 {"cabinet_id":"V000_R000","input_rect_px":[0,0,1080,1080]},
 {"cabinet_id":"V000_R001","input_rect_px":[0,1200,1080,1080]}]}"#,
        )
        .unwrap();
        let out_gap = dir.path().join("gap.obj");
        run_export_pose_obj(&rp, "neutral", &out_gap, None, false, false, Some(&sm_gap))
            .unwrap();
        let gap_text = std::fs::read_to_string(&out_gap).unwrap();
        // 画布高 2280:row0 V ∈ [0, 1080/2280],row1 V ∈ [1200/2280, 1]。
        let vts: Vec<f64> = gap_text
            .lines()
            .filter_map(|l| l.strip_prefix("vt "))
            .map(|l| l.split_whitespace().nth(1).unwrap().parse().unwrap())
            .collect();
        let expect_v0 = 1080.0 / 2280.0;
        let expect_v1 = 1200.0 / 2280.0;
        assert!(
            vts.iter().any(|v| (v - expect_v0).abs() < 1e-4),
            "expected V={expect_v0} in {vts:?}"
        );
        assert!(
            vts.iter().any(|v| (v - expect_v1).abs() < 1e-4),
            "expected V={expect_v1} in {vts:?}"
        );

        // mapping 缺 pose 箱体 → InvalidInput;--split 与 --screen-mapping 互斥。
        let sm_missing = dir.path().join("sm_missing.json");
        std::fs::write(
            &sm_missing,
            r#"{"cabinets":[{"cabinet_id":"V000_R000","input_rect_px":[0,0,1080,1080]}]}"#,
        )
        .unwrap();
        let err = run_export_pose_obj(
            &rp, "neutral", &dir.path().join("m.obj"), None, false, false, Some(&sm_missing),
        )
        .unwrap_err();
        assert!(matches!(err, VoloError::InvalidInput(_)), "got {err:?}");
        let err = run_export_pose_obj(
            &rp, "neutral", &dir.path().join("s"), None, false, true, Some(&sm_uniform),
        )
        .unwrap_err();
        assert!(matches!(err, VoloError::InvalidInput(_)), "split+mapping: {err:?}");
    }

    #[test]
    fn export_pose_obj_rejects_unparseable_cabinet_id() {
        // 单文件下 cabinet_id 不再是文件名；不可解析为 V<col>_R<row> 的 id → InvalidInput。
        for bad_id in &["../escape", "a/b", "", "V000", "RandomName"] {
            let dir = tempdir().unwrap();
            let report = format!(
                r#"{{
                  "schema_version": "visual_pose_report.v1",
                  "frame": {{}},
                  "cabinet_poses": [
                    {{"cabinet_id":{},
                     "corners_mm":[[-300,-170,0],[300,-170,0],[300,170,0],[-300,170,0]]}}
                  ]
                }}"#,
                serde_json::to_string(bad_id).unwrap()
            );
            let rp = dir.path().join("pose_report.json");
            std::fs::write(&rp, &report).unwrap();
            let out = dir.path().join("wall.obj");

            let result = run_export_pose_obj(&rp, "neutral", &out, None, false, false, None);
            assert!(
                matches!(result, Err(VoloError::InvalidInput(_))),
                "expected InvalidInput for cabinet_id={bad_id:?}, got {result:?}"
            );
        }
    }

    #[test]
    fn export_pose_obj_root_makes_reference_axis_aligned_and_grounded() {
        let dir = tempdir().unwrap();
        let rp = dir.path().join("BENCH_cabinet_pose_report.json");
        std::fs::write(&rp, BENCH_REPORT).unwrap();
        let out = dir.path().join("wall.obj");

        let res = run_export_pose_obj(&rp, "neutral", &out, Some("V000_R001"), true, false, None).unwrap();
        assert_eq!(res.cabinet_count, 2);

        let text = std::fs::read_to_string(&out).unwrap();
        let verts: Vec<[f64; 3]> = text
            .lines()
            .filter_map(|l| l.strip_prefix("v "))
            .map(|l| {
                let n: Vec<f64> = l.split_whitespace().map(|t| t.parse().unwrap()).collect();
                [n[0], n[1], n[2]]
            })
            .collect();
        assert_eq!(verts.len(), 8, "2 cabinets × 4 verts");
        // 基准块（V000_R001）re-root 后落在 XY 平面 → 取 z≈0 的 4 个顶点
        let refp: Vec<[f64; 3]> = verts.into_iter().filter(|v| v[2].abs() < 1e-3).collect();
        assert_eq!(refp.len(), 4, "reference panel should be the 4 z≈0 verts: {refp:?}");
        // ground：基准块底边 y=0
        let min_y = refp.iter().map(|v| v[1]).fold(f64::INFINITY, f64::min);
        assert!(min_y.abs() < 1e-3, "ground: ref min y should be 0, got {min_y}");
        // 高 ≈ 0.680 m
        let max_y = refp.iter().map(|v| v[1]).fold(f64::NEG_INFINITY, f64::max);
        assert!((max_y - 0.680).abs() < 0.01, "height ≈ 0.68m, got {max_y}");

        // 未知 --root → NotFound
        let err = run_export_pose_obj(&rp, "neutral", &out, Some("V999_R999"), false, false, None).unwrap_err();
        assert!(matches!(err, VoloError::NotFound(_)), "got {err:?}");
    }

    #[test]
    fn parse_cabinet_col_row_extracts_indices() {
        assert_eq!(parse_cabinet_col_row("V000_R000"), Some((0, 0)));
        assert_eq!(parse_cabinet_col_row("V012_R007"), Some((12, 7)));
        assert_eq!(parse_cabinet_col_row("V120_R024"), Some((120, 24)));
        // 不匹配 → None
        assert_eq!(parse_cabinet_col_row("../escape"), None);
        assert_eq!(parse_cabinet_col_row("a/b"), None);
        assert_eq!(parse_cabinet_col_row(""), None);
        assert_eq!(parse_cabinet_col_row("V000"), None);
    }

    #[test]
    fn infer_grid_dims_takes_max_plus_one() {
        let ids = ["V000_R000", "V000_R001"];
        assert_eq!(infer_grid_dims(&ids).unwrap(), (1, 2));
        let ids = ["V000_R000", "V002_R000", "V001_R001"];
        assert_eq!(infer_grid_dims(&ids).unwrap(), (3, 2));
        let ids = ["V000_R000", "bad"];
        assert!(matches!(infer_grid_dims(&ids), Err(VoloError::InvalidInput(_))));
    }

    #[test]
    fn infer_grid_dims_handles_absent_cells() {
        // 缺 V001_R000：dims 仍按 max+1 推（2 列 × 2 行）
        let ids = ["V000_R000", "V000_R001", "V001_R001"];
        assert_eq!(infer_grid_dims(&ids).unwrap(), (2, 2));
    }

    #[test]
    fn infer_grid_dims_rejects_out_of_range_index() {
        // u32::MAX 可解析但 max+1 会溢出 → 必须先拒（外部 pose report 是系统边界）。
        assert!(matches!(
            infer_grid_dims(&["V4294967295_R000"]),
            Err(VoloError::InvalidInput(_))
        ));
        // index == MAX_GRID_DIM 越界（合法上限是 < MAX_GRID_DIM）。
        assert!(matches!(
            infer_grid_dims(&["V000_R10000"]),
            Err(VoloError::InvalidInput(_))
        ));
    }

    #[test]
    fn merge_mesh_outputs_concatenates_and_offsets_indices() {
        use mesh_core::surface::MeshOutput;
        let mk = |x: f64| MeshOutput {
            target: TargetSoftware::Neutral,
            vertices: vec![
                Vector3::new(x, 0.0, 0.0),
                Vector3::new(x + 1.0, 0.0, 0.0),
                Vector3::new(x, 1.0, 0.0),
                Vector3::new(x + 1.0, 1.0, 0.0),
            ],
            triangles: vec![[0, 1, 3], [0, 3, 2]],
            uv_coords: vec![
                nalgebra::Vector2::new(0.0, 0.0),
                nalgebra::Vector2::new(1.0, 0.0),
                nalgebra::Vector2::new(0.0, 1.0),
                nalgebra::Vector2::new(1.0, 1.0),
            ],
        };
        let merged = merge_mesh_outputs(TargetSoftware::Neutral, &[mk(0.0), mk(10.0)]);
        assert_eq!(merged.vertices.len(), 8);
        assert_eq!(merged.uv_coords.len(), 8);
        assert_eq!(merged.triangles.len(), 4);
        assert_eq!(merged.triangles[2], [4, 5, 7]);
        assert_eq!(merged.triangles[3], [4, 7, 6]);
        assert_eq!(merged.vertices[4].x, 10.0);
    }

    #[test]
    fn path_a_disguise_front_face_is_minus_z() {
        // Path A model frame: 凸法向 +Y、列 +X、高 +Z。构一块平 1×1 panel(y=0 平面)。
        use mesh_core::export::build::surface_to_mesh_output;
        use mesh_core::surface::{GridTopology, QualityMetrics, ReconstructedSurface};
        let topo = GridTopology { cols: 1, rows: 1 };
        let surface = ReconstructedSurface {
            screen_id: "A".into(),
            topology: topo,
            // 行主序 (0,0),(1,0),(0,1),(1,1);y=0 → 法向 ±Y(凸=+Y)
            vertices: vec![
                Vector3::new(0.0, 0.0, 0.0),
                Vector3::new(1.0, 0.0, 0.0),
                Vector3::new(0.0, 0.0, 1.0),
                Vector3::new(1.0, 0.0, 1.0),
            ],
            uv_coords: compute_grid_uv(topo),
            quality_metrics: QualityMetrics::default(),
            scatter_fit: None,
            vertex_provenance: vec![],
        };
        let array = CabinetArray::rectangle(1, 1, [1.0, 1.0]);
        let mesh = surface_to_mesh_output(&surface, &array, TargetSoftware::Disguise, 0.0).unwrap();
        // 三角面 0 の几何法向(按 winding)= 发光/前面方向。
        let t = mesh.triangles[0];
        let v = |i: u32| mesh.vertices[i as usize];
        let nrm = (v(t[1]) - v(t[0])).cross(&(v(t[2]) - v(t[0]))).normalize();
        assert!(nrm.z < -0.9, "Path A disguise front face must be -Z, got {nrm:?}");
    }
}
