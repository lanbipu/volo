//! Clap-derived CLI surface.
//!
//! 子命令一对一映射 lmt-app 的 use case,方便日后被 MCP wrapper 平移成 tool。

use clap::{Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, ValueEnum)]
#[value(rename_all = "lowercase")]
pub enum OutputFormat {
    Text,
    Json,
    Ndjson,
}

/// disguise 图像序列(.seq)输出策略,用于 generate-structured-light。
#[derive(Debug, Clone, Copy, ValueEnum)]
#[value(rename_all = "lowercase")]
pub enum SeqFormat {
    /// 当 project output.target == "disguise" 时产出 TIFF .seq,否则不产(默认)。
    Auto,
    /// 不产出 image sequence(仅 PNG 帧 + mp4)。
    None,
    /// 强制产出 disguise 规范的 TIFF .seq。
    Tiff,
}

#[derive(Debug, Parser)]
#[command(
    name = "lmt",
    version,
    about = "LED Mesh Toolkit CLI",
    long_about = "Agent-friendly CLI. Use --json for machine-stable envelope output."
)]
pub struct Cli {
    /// 输出格式:text(人类,默认)/ json(单 envelope)/ ndjson(每行一事件)。
    #[arg(long, short = 'o', global = true, value_enum)]
    pub output: Option<OutputFormat>,

    /// [别名] 等价 `--output json`。保留兼容旧脚本。
    #[arg(long, global = true)]
    pub json: bool,

    /// 禁用 ANSI 颜色(human 模式当前本就无色,接受为 no-op 以满足契约)。
    #[arg(long, global = true)]
    pub no_color: bool,

    /// 拒绝任何交互提示(本 CLI 不发起交互,destructive 仍需 --yes;
    /// 接受此 flag 让 agent 调用显式无人值守)。
    #[arg(long, global = true)]
    pub no_input: bool,

    /// 显式 DB 路径。优先级:--db > LMT_DB_PATH env > OS 标准位置
    /// (即 Tauri GUI 用的 lmt.sqlite,默认共用)。
    ///
    /// 测试 / CI / 隔离运行务必显式指定,避免污染默认 DB。
    #[arg(long, global = true, env = "LMT_DB_PATH")]
    pub db: Option<PathBuf>,

    /// 破坏性操作的 dry-run 预演。具体命令的语义见各自 --help。
    #[arg(long, global = true)]
    pub dry_run: bool,

    /// 破坏性操作的确认开关。当 --dry-run 不在,某些命令仍要求 --yes
    /// 显式确认。
    #[arg(long, global = true)]
    pub yes: bool,

    /// 单条命令的总超时(秒)。
    ///
    /// **v0 暂未实现**——传任何值都会立刻被 dispatch 拒绝并报 `unsupported`,
    /// 而不是默默忽略让 agent 误以为有上限。flag 保留是为了未来加上时不需要
    /// 改 CLI surface。Native PDF render 在 src-tauri 内有 30s 内置超时,但
    /// 本 CLI 不暴露 PDF。
    #[arg(long, global = true, value_name = "SECS")]
    pub timeout: Option<u64>,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// 项目元数据 / project.yaml / recent_projects 管理。
    #[command(subcommand)]
    Project(ProjectCmd),

    /// measured.yaml 读取。
    #[command(subcommand)]
    Measurements(MeasurementsCmd),

    /// M1 全站仪 CSV adapter:导入 + 指引卡 HTML 输出。不暴露 PDF。
    #[command(name = "total-station", subcommand)]
    TotalStation(TotalStationCmd),

    /// 几何重建 + run 历史查询。
    #[command(subcommand)]
    Reconstruct(ReconstructCmd),

    /// run 导出为 OBJ。
    #[command(subcommand)]
    Export(ExportCmd),

    /// dump lmt-shared 全部公开 DTO / error / envelope 的 JSON Schema。
    Schema,

    /// dump Contract Manifest —— 全部 operation 的清单(operation_id / cli / side_effect)。
    Manifest,

    /// 机器可读版本元信息(--version 是纯文本简版)。
    Version,

    /// 生成 shell 补全脚本到 stdout(bash / zsh / fish / powershell / elvish)。
    Completion {
        /// 目标 shell。
        shell: clap_complete::Shell,
    },

    /// 把内置 example(curved-flat / curved-arc)拷贝到目标目录。
    /// side_effect: destructive(写文件,需 --yes 或 --dry-run)。
    #[command(name = "seed-example")]
    SeedExample {
        /// example 名:curved-flat / curved-arc。
        name: String,
        /// 目标父目录;会在其下创建 <name>/ 子目录。
        dst: std::path::PathBuf,
    },

    /// 相机视觉测量(零全站仪):标定 / 生成 pattern / 重建 / 合成台。
    #[command(subcommand)]
    Visual(VisualCmd),
}

#[derive(Debug, Subcommand)]
pub enum ProjectCmd {
    /// 列出 recent_projects 表内全部条目(按 last_opened_at desc)。
    /// side_effect: read_only
    ListRecent,

    /// upsert 一条 recent_projects 记录,返回完整行。
    /// side_effect: write_safe
    AddRecent {
        /// 项目绝对路径,作为 conflict key。
        abs_path: String,
        /// 显示用名字。
        display_name: String,
    },

    /// 删除 recent_projects 内 id == ID 的行。不存在则 no-op。
    /// side_effect: destructive(需要 --yes 或 --dry-run)
    RemoveRecent {
        /// recent_projects 表的主键。
        id: i64,
    },

    /// 读取 `<dir>/project.yaml`,输出 ProjectConfig。
    /// side_effect: read_only
    Load {
        /// 项目根目录(包含 project.yaml 的目录)。
        abs_path: String,
    },

    /// 把 ProjectConfig(从 stdin / --input 文件读 YAML 或 JSON)atomic
    /// 写到 `<dir>/project.yaml`。
    /// side_effect: destructive(需要 --yes 或 --dry-run)
    Save {
        /// 项目根目录,会被创建出来。
        abs_path: String,
        /// ProjectConfig YAML/JSON 文件路径;省略走 stdin。
        #[arg(long, value_name = "PATH")]
        input: Option<PathBuf>,
    },
}

#[derive(Debug, Subcommand)]
pub enum MeasurementsCmd {
    /// 读 measured.yaml,输出 MeasuredPoints。
    /// side_effect: read_only
    Load {
        /// measured.yaml 绝对路径。
        path: String,
    },
}

/// 采样模式：网格命名（grid，默认）或曲面拟合（scatter）。
#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum ImportMode {
    /// 标准网格 CSV（SOP 校验 + 网格命名）。
    Grid,
    /// 散点 CSV（跳过 SOP，直接存原始坐标，reconstruct 走曲面拟合）。
    Scatter,
}

#[derive(Debug, Subcommand)]
pub enum TotalStationCmd {
    /// 把 Trimble CSV 导入 `<project>/measurements/measured.yaml`(+ import_report.json)。
    /// 已有 measured.yaml 会被 rename 成 .bak。失败时回滚。
    /// side_effect: destructive(需要 --yes 或 --dry-run)
    Import {
        /// 项目根目录。
        project_abs_path: String,
        /// 要导入的 screen id。
        screen_id: String,
        /// Trimble CSV 绝对路径。
        csv_path: String,
        /// 采样模式：grid（默认，网格命名）或 scatter（曲面拟合）。
        #[arg(long, value_enum, default_value_t = ImportMode::Grid)]
        mode: ImportMode,
        /// scatter 模式列映射，1-based，形如 `x=3,y=4,z=5[,label=1]`。
        /// 省略则自动推断末尾 3 数值列。
        #[arg(long)]
        columns: Option<String>,
    },

    /// 渲染指引卡 HTML(给 iframe 预览或外部 PDF 工具)。不输出 PDF。
    /// side_effect: read_only
    InstructionCard {
        /// 项目根目录。
        project_abs_path: String,
        /// screen id。
        screen_id: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum ReconstructCmd {
    /// 重建表面,写 report.json + 记录 reconstruction_runs DB 行。
    /// side_effect: destructive(写文件 + DB 行,需要 --yes 或 --dry-run)
    Surface {
        /// 项目根目录。
        project_path: String,
        /// screen id。
        screen_id: String,
        /// measured.yaml 相对 project 的路径,通常是
        /// `measurements/measured.yaml`。
        measurements_path: String,
    },

    /// 列出某项目 / screen 的全部 reconstruction_runs。
    /// side_effect: read_only
    ListRuns {
        /// 项目根目录。
        project_path: String,
        /// 仅列某个 screen,不传则列全部。
        #[arg(long)]
        screen_id: Option<String>,
    },

    /// 读取某条 run 的完整 report.json(原始 JSON,不重新序列化)。
    /// side_effect: read_only
    GetRunReport {
        /// reconstruction_runs.id。
        run_id: i64,
    },
}

#[derive(Debug, Subcommand)]
pub enum ExportCmd {
    /// 把某条 run 导出为 OBJ。
    /// side_effect: destructive(写文件,需要 --yes 或 --dry-run)
    Obj {
        /// reconstruction_runs.id。
        run_id: i64,
        /// target software: disguise / unreal / neutral。
        target: String,
        /// 目标 OBJ 绝对路径;省略走默认 `<project>/output/<screen>_<target>_run<id>.obj`。
        #[arg(long, value_name = "PATH")]
        dst: Option<PathBuf>,
    },

    /// 把 cabinet_pose_report.json 的所有箱体合并导出成一个世界坐标 OBJ。
    /// side_effect: destructive(写文件,需要 --yes 或 --dry-run)
    #[command(name = "pose-obj")]
    PoseObj {
        /// cabinet_pose_report.json 路径。
        pose_report: String,
        /// target software: disguise / neutral。unreal 显式拒绝(FIX-13:
        /// pose-report 帧无已验证 UE 适配;用 neutral 自行转换,或表面 run
        /// 走 `lmt export obj <run_id> unreal`)。
        target: String,
        /// 输出路径。默认(合并模式)为 OBJ 文件路径;--split 模式为输出目录,
        /// 每个 cabinet 生成独立的 <cabinet_id>.obj。
        #[arg(long, value_name = "PATH")]
        out: PathBuf,
        /// 以该 cabinet_id 为基准:把整个场景重定位到它的局部系(它轴对齐落在原点),
        /// 其余屏保持真实相对位姿。不传则用重建根 cabinet 的世界系。
        #[arg(long, value_name = "CABINET_ID")]
        root: Option<String>,
        /// 让下边缘贴地(最低 Y = 0),而非以中心为原点。给了 --root 时以基准屏下沿
        /// 为 0,其余屏保持真实相对高度(物理更低的屏可能 y<0)。
        #[arg(long)]
        ground: bool,
        /// 每个 cabinet 导出为独立 OBJ 文件(--out 为输出目录)。
        /// 所有文件共享同一世界坐标系与 disguise 补偿(与合并导出逐顶点一致),
        /// 仅 UV 改为每文件独立 [0,1]。
        #[arg(long)]
        split: bool,
        /// screen_mapping.json 路径:按各 cabinet 的 input_rect_px 生成非均匀
        /// UV(默认假设均匀 cols×rows 画布)。与 --split 互斥。
        #[arg(long, value_name = "PATH")]
        screen_mapping: Option<PathBuf>,
    },
}

#[derive(Debug, Subcommand)]
pub enum VisualCmd {
    /// 棋盘格图像 → intrinsics.json。side_effect: destructive
    Calibrate {
        /// 项目根目录。
        project_path: String,
        /// screen id。
        screen_id: String,
        /// 棋盘格图像目录(png/jpg)。
        checkerboard_dir: String,
        /// 棋盘格方格边长(毫米)。
        #[arg(long, default_value_t = 20.0)]
        square_mm: f64,
        /// 棋盘格内角点数,格式 WxH,如 `9x9`。
        #[arg(long, default_value = "9x9")]
        inner: String,
    },
    /// 生成 pattern 三件套(cabinets/ + full_screen.png + pattern_meta.json)。side_effect: destructive
    #[command(name = "generate-pattern")]
    GeneratePattern {
        /// 项目根目录。
        project_path: String,
        /// screen id。
        screen_id: String,
        /// Pattern 方法:vpqsp(默认,自编码 marker,无字典容量上限)/ charuco(legacy)。
        #[arg(long, default_value = "vpqsp")]
        method: String,
        /// VP-QSP 数值 screen id(0-15),写入每个 marker;多屏 Volume 每屏取不同值。
        #[arg(long, default_value_t = 0)]
        screen_id_code: u8,
        /// 可选 screen_mapping.json:提供后按每箱体尺寸/点间距生成专属图案
        /// (支持非正方形 / 不等尺寸箱体),而非均匀网格。相对路径按项目根解析。
        #[arg(long)]
        screen_mapping: Option<String>,
    },
    /// 生成结构光点阵序列(帧 PNG + sequence.mp4 + sl_meta.json)。side_effect: destructive
    #[command(name = "generate-structured-light")]
    GenerateStructuredLight {
        /// 项目根目录。
        project_path: String,
        /// screen id。
        screen_id: String,
        /// 点间距(像素)。不传则按箱体分辨率自动推导(约 1/8 箱体短边)。
        #[arg(long)]
        dot_spacing: Option<u32>,
        /// 点半径(像素)。
        #[arg(long, default_value_t = 6)]
        dot_radius: u32,
        /// 点到箱体边缘留白(像素)。不传则自动推导(约 1/16 箱体短边,铺满整箱)。
        #[arg(long)]
        margin: Option<u32>,
        /// disguise 序列输出:auto(默认,target=disguise 时出 TIFF .seq)/ none / tiff。
        #[arg(long, value_enum, default_value_t = SeqFormat::Auto)]
        seq_format: SeqFormat,
        /// 可选 screen_mapping.json:按每箱体 input_rect_px 放点(支持非均匀/缺失箱体)。
        /// 相对路径按项目根解析。
        #[arg(long)]
        screen_mapping: Option<String>,
    },
    /// 解码结构光录像 → 屏幕↔相机对应文件(带 provenance)。side_effect: destructive
    #[command(name = "decode-structured-light")]
    DecodeStructuredLight {
        /// 录像视频文件或帧图片目录。
        input_path: String,
        /// sl_meta.json 路径(generate-structured-light 产出)。
        sl_meta: String,
        /// 输出的对应文件 corr.json 路径。
        #[arg(long)]
        out: String,
        /// 全白哨兵帧判定阈值(整帧均值/255,范围 0–1)。不传=0.85。
        /// 屏幕没填满画面或背景非黑(如可视化器灰底)时调低(如 0.4)。
        #[arg(long)]
        sentinel_threshold: Option<f64>,
        /// 手动屏幕 ROI,格式 `X,Y,W,H`(像素)。不传=从全片时序活动图自动推导。
        /// 自动失败(只有屏外细长运动、无实心矩形)时用它兜底。
        #[arg(long)]
        screen_roi: Option<String>,
        /// 额外写出 `<out>.debug.png`:Pass 3 seed 的纯黑底+白点掩膜,供肉眼核对。
        #[arg(long)]
        emit_debug_image: bool,
    },
    /// 多机位结构光对应文件 → cabinet_pose_report.json(不再写 measured.yaml,FIX-13)
    /// (model-constrained BA,复用 charuco 重建内核)。side_effect: destructive
    #[command(name = "reconstruct-structured-light")]
    ReconstructStructuredLight {
        /// 项目根目录。
        project_path: String,
        /// screen id。
        screen_id: String,
        /// sl_meta.json 路径(generate-structured-light 产出)。
        #[arg(long)]
        sl_meta: String,
        /// intrinsics.json 路径(visual calibrate 产出);保留字 `auto` = 用同一组 corr 内联自标定。
        #[arg(long)]
        intrinsics: String,
        /// 每个机位一个 corr.json(decode-structured-light 产出);重复传入 >=2 个。
        #[arg(long = "corr", required = true, num_args = 1.., action = clap::ArgAction::Append)]
        correspondences: Vec<String>,
        /// 内参 anchor JSON 路径(独立棋盘格标定),仅 --intrinsics auto 时用于防吸收交叉校验。
        #[arg(long = "intrinsics-crosscheck")]
        intrinsics_crosscheck: Option<String>,
    },
    /// 结构光白点 + nominal 设计墙(3D 靶) → <screen_id>_sl_intrinsics.json
    /// (cv2.calibrateCamera,病态拒标)。side_effect: destructive
    #[command(name = "calibrate-structured-light")]
    CalibrateStructuredLight {
        /// 项目根目录。
        project_path: String,
        /// screen id。
        screen_id: String,
        /// sl_meta.json 路径(generate-structured-light 产出)。
        #[arg(long)]
        sl_meta: String,
        /// 同一台相机每个机位一个 corr.json(decode-structured-light 产出);重复传入。
        #[arg(long = "corr", required = true, num_args = 1.., action = clap::ArgAction::Append)]
        correspondences: Vec<String>,
        /// 内参输出路径(默认 <project>/calibration/<screen_id>_sl_intrinsics.json)。
        #[arg(long)]
        out: Option<String>,
        /// 覆盖已存在的内参文件(否则拒绝,以免覆盖可信棋盘格标定)。
        #[arg(long)]
        force: bool,
        /// reproj RMS 门槛(px)。
        #[arg(long = "max-rms-px", default_value_t = 1.5)]
        max_rms_px: f64,
        /// 内参 anchor JSON 路径,启用防吸收交叉校验(平面墙无 anchor 将被拒)。
        #[arg(long = "intrinsics-crosscheck")]
        intrinsics_crosscheck: Option<String>,
    },
    /// 多视角照片 → cabinet_pose_report.json(不再写 measured.yaml,FIX-13)。side_effect: destructive
    Reconstruct {
        /// 项目根目录。
        project_path: String,
        /// screen id。
        screen_id: String,
        /// capture manifest JSON 路径(与 --images 二选一)。
        #[arg(long)]
        capture_manifest: Option<String>,
        /// 图像目录(便利参数,暂未实现;请用 --capture-manifest)。
        #[arg(long)]
        images: Option<String>,
        /// 重建方法:vpqsp(默认)/ charuco。实际方法以 capture manifest 的 method 为准。
        #[arg(long, default_value = "vpqsp")]
        method: String,
        /// intrinsics.json 路径,或保留字 `auto` = 从拍摄的 VP-QSP marker 内联自标定(仅 vpqsp 方法)。
        /// 省略则用 capture manifest 的 `intrinsics` 字段。
        #[arg(long)]
        intrinsics: Option<String>,
        /// 内参 anchor JSON 路径(独立标定),仅 --intrinsics auto 时用于防吸收交叉校验。
        #[arg(long = "intrinsics-crosscheck")]
        intrinsics_crosscheck: Option<String>,
    },
    /// 合成数据集生成。side_effect: destructive
    Simulate {
        /// simulate config JSON 文件路径。
        config: String,
        /// 输出目录。
        #[arg(long)]
        out: String,
    },
    /// 方法 vs 真值评估。side_effect: write_safe
    Eval {
        /// 数据集目录。
        dataset: String,
        /// 评估方法(目前只支持 charuco)。
        #[arg(long, default_value = "charuco")]
        method: String,
        /// 评估用的 seed 列表(逗号分隔或重复传 --seed-matrix)。默认 [0]。
        #[arg(long, value_delimiter = ',', default_values_t = vec![0i64])]
        seed_matrix: Vec<i64>,
        /// BA 初始化: near_truth(默认, Phase-0 近真值) / cold(生产初始化路径:
        /// 传递桥接 + nominal fallback + Stage-B; 需数据集 meta.json 含设计信息)。
        #[arg(long, default_value = "near_truth")]
        init: String,
    },
    /// 重建 pose report 对账已知监视器几何(尺寸/距离/角度误差)。side_effect: write_safe
    #[command(name = "compare-known")]
    CompareKnown {
        /// cabinet_pose_report.json 路径(reconstruct 输出)。
        report: String,
        /// known_geometry.json 路径(用户填的真值)。
        known: String,
        /// size 误差阈值(mm),覆盖默认 2.0。
        #[arg(long = "max-size-mm")]
        max_size_mm: Option<f64>,
        /// 间距误差阈值(mm),覆盖默认 3.0。
        #[arg(long = "max-dist-mm")]
        max_dist_mm: Option<f64>,
        /// 夹角误差阈值(deg),覆盖默认 0.3。
        #[arg(long = "max-angle-deg")]
        max_angle_deg: Option<f64>,
    },
    /// 采集指导:几何 + 内参 → 推荐机位 plan(逐箱体覆盖/残差)。side_effect: write_safe
    #[command(name = "plan-capture")]
    PlanCapture {
        /// 项目根目录。
        project_path: String,
        /// screen id。
        screen_id: String,
        /// 传感器分辨率 WxH,例如 3840x2160。
        #[arg(long = "image-size")]
        image_size: String,
        /// 水平 FOV(度);与 --vfov-deg 二选一。
        #[arg(long = "hfov-deg")]
        hfov_deg: Option<f64>,
        /// 垂直 FOV(度);与 --hfov-deg 二选一。
        #[arg(long = "vfov-deg")]
        vfov_deg: Option<f64>,
        /// 后退距离区间 MIN..MAX(mm),例如 3000..12000。
        #[arg(long)]
        standoff: String,
        /// 架高区间 MIN..MAX(mm),例如 400..3000。
        #[arg(long)]
        height: String,
        /// 每箱体 p95 3D 残差目标(mm)。
        #[arg(long = "target-mm", default_value_t = 3.0)]
        target_mm: f64,
        /// Monte-Carlo 试验次数。
        #[arg(long, default_value_t = 20)]
        trials: u32,
        /// RNG 种子。
        #[arg(long, default_value_t = 0)]
        seed: u32,
        /// 每箱体最少覆盖视角数(精准档传 3)。省略 = 用 sidecar 默认(gates.MIN_VIEWS,
        /// 与 reconstruct 观测门同源)——不在 CLI 侧硬编码默认值,避免与 gate 漂移。
        #[arg(long = "min-views")]
        min_views: Option<u32>,
    },
    /// 采集指导可视化:渲染自包含 HTML 指导卡(俯视机位图 + 正视覆盖热力图 + 机位清单)。
    /// human 模式 stdout 出 HTML(`... > card.html`);--json 包 `{html_content}`。side_effect: read_only
    #[command(name = "capture-card")]
    CaptureCard {
        /// 项目根目录。
        project_path: String,
        /// screen id。
        screen_id: String,
        /// 传感器分辨率 WxH,例如 3840x2160。
        #[arg(long = "image-size")]
        image_size: String,
        /// 水平 FOV(度);与 --vfov-deg 二选一。
        #[arg(long = "hfov-deg")]
        hfov_deg: Option<f64>,
        /// 垂直 FOV(度);与 --hfov-deg 二选一。
        #[arg(long = "vfov-deg")]
        vfov_deg: Option<f64>,
        /// 后退距离区间 MIN..MAX(mm)。
        #[arg(long)]
        standoff: String,
        /// 架高区间 MIN..MAX(mm)。
        #[arg(long)]
        height: String,
        /// 每箱体 p95 3D 残差目标(mm)。
        #[arg(long = "target-mm", default_value_t = 3.0)]
        target_mm: f64,
        /// Monte-Carlo 试验次数。
        #[arg(long, default_value_t = 20)]
        trials: u32,
        /// RNG 种子。
        #[arg(long, default_value_t = 0)]
        seed: u32,
    },
}

impl Cli {
    /// 综合 --output / --json 别名解析最终输出模式。
    /// 优先级:--output > --json > 默认 text。
    pub fn resolved_format(&self) -> OutputFormat {
        match self.output {
            Some(f) => f,
            None if self.json => OutputFormat::Json,
            None => OutputFormat::Text,
        }
    }
}
