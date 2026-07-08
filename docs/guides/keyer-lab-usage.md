# Keyer Lab 使用手册（键控模块 + 测试素材 + 验证方法）

> 模块代码：`src/volo/keyer/` + `src/volo/pages/toolsKeyer.tsx`（分支 feat/keyer-lab）。
> 算法/移植规格见 `docs/architecture/chroma-keyer-spec.md`，本档只讲**怎么用、怎么验**。
> 运行环境：原生 app（`pnpm tauri dev`）。浏览器打开 devUrl 会被 `isTauri()` gate 拦下；且模块要求 WebGPU，探测失败页面会显示红色 InlineAlert 并停用一切操作。

## 一、模块入口

左侧导航 **键控** 类目下两个页面：

| 页面 | 用途 |
|---|---|
| **抠像实验台**（keyer_lab） | 交互调参、实时预览、性能观测、导出抠像结果 |
| **基准测试**（keyer_bench） | 跑 6 case 客观指标（MAD / 梯度误差），导出 report JSON 做回归判定 |

## 二、抠像实验台

### 2.1 基本流程

1. **打开素材** —— 顶栏「打开素材」选择图片（PNG/JPEG）或视频（H.264 / HEVC / ProRes，见素材支持矩阵）。视频加载后出现「播放 / 暂停」按钮，按 rVFC 逐帧驱动管线。
2. **采样主色** —— 直接**点击画布**上的幕布区域，取样点 3×3 均值作为 keyColor（sRGB→线性）。右侧参数面板也有 hex 输入框（`#26a626`）手动兜底。
3. **调参** —— 右侧 Inspector 10 个旋钮（黑位 / 白位 / 边缘软度 / 收缩 / 羽化 / despill 强度 / despill 平衡 / 降噪 / matte 稳定 / 色差平衡），语义与范围见 spec ②的 Params 表。「重置默认」一键回到 DEFAULTS。
4. **看结果** —— 画布上方视图分段：**结果 / matte / 源 / 对比**。对比模式出现 wipe 拖杆，左源右结果。
5. **导出** —— 「导出」输出 straight-alpha PNG（前景 un-premultiply + matte），Tauri WKWebView 下直接落 `~/Downloads`。

### 2.2 plate（不均匀幕补偿）

顶栏三个按钮：

- **加载 plate**：选一张与素材同机位的「净幕板」（无前景的幕布照片），key pass 逐像素用 plate 色差做参考，打光不匀被除掉。
- **估计 plate**：没有净幕板时，从当前帧用 pull-push 补洞估计一张（前景区域由邻域幕色填充）。对静帧效果好；前景占比过大时估计质量下降。
- **清除**：回到全局 keyColor 模式。

状态 Tag 显示 `plate · 已加载` / `plate · 已估计`。

### 2.3 HUD 与性能

画布角落 HUD 显示 `xx.x fps · x.xx ms`（EMA 平滑，每 10 帧刷新）。1080p60 素材验收线 **≥58fps**；若掉到恰好 ~30fps，通常是单帧超 16.6ms 被 vsync 量化——排查思路见 spec ⑥性能教训。

### 2.4 预设

Inspector 底部可将当前整组参数存为命名预设（localStorage `volo-keyer-presets`），「加载」一键切换。换素材类型（发丝 / 玻璃 / 均匀幕）时用。

## 三、测试素材（`testdata/keyer/`，git 已 ignore）

本地生成的合成素材，**自带真值**，与基准基线同源（seed=7）。丢失可随时重新生成。

### 3.1 静帧测试集 `testset/`（生成器 `scripts/keyer/gen_testset.py`）

```bash
python3 scripts/keyer/gen_testset.py --out testdata/keyer/testset   # seed 默认 7，勿改（改了基线失效）
```

6 个 case，每个 case 三类文件：

| 文件 | 内容 |
|---|---|
| `caseNN_xxx.input.png`（case05 为 `_f00..07` 8 帧） | 合成输入帧 `fg·a + screen·(1−a)` |
| `caseNN_xxx.gt.png` | 真值 matte（灰度 = alpha） |
| `caseNN_xxx.plate.png` | 净幕板（可喂「加载 plate」） |

case 难点覆盖：`disc` 硬边基线 / `hair` 600 根发丝 / `bottle` 半透明渐变+高光 / `uneven` 不均匀幕(径向增益+皱褶) / `noise` 8 帧传感器噪声序列(测时域降噪) / `spill` 边缘溢绿。

### 3.2 动态视频（生成器 `testdata/keyer/gen_video.py`）

10 秒 1080p60 合成场景，把 6 个静帧 case 的难点揉进一条：摆动人形 + 800 根摆动发丝 + 半透明摆动瓶 + 不均匀幕 + 噪声 + 溢绿。

| 文件 | 用途 |
|---|---|
| `greenscreen_1080p60_h264.mp4` | 主力：性能实测 + 交互调参 |
| `greenscreen_1080p60_hevc10.mp4`（hvc1 10bit） | 解码矩阵复测（Windows WebView2 上线前必测） |
| `greenscreen_1080p60_prores.mov`（422 HQ，421MB） | 同上；不用可删 |

重新生成 / 改参数（时长、分辨率在脚本头部常量）：

```bash
python3 testdata/keyer/gen_video.py | ffmpeg -y -f rawvideo -pix_fmt rgb24 -s 1920x1080 -r 60 -i - \
  -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p testdata/keyer/greenscreen_1080p60_h264.mp4
```

## 四、验证方法

### 4.1 主观验收（抠像实验台）

用 h264 视频走一遍 §2.1 流程（点幕布采样即可，默认参数就应可用），检查：

- **matte 视图**：纯幕区应为纯黑（点击画布任意幕区，底部像素读数 α≤0.01；实测 0.000），人物核心纯白，发丝呈灰度过渡（不是硬边也不是整体发灰——整体发灰是历史 YCoCg bug 的症状）。
- **结果视图**：checker 背景上边缘无绿边（despill 生效）、发暗可调 lumaRestore；半透明瓶能透出 checker。
- **对比视图**：拖 wipe 杆目检边缘。
- **HUD**：播放中稳定 ≥58fps。
- **plate 对照**：`case04_uneven.input.png` 载入后先不加 plate（暗角处 matte 发灰），再「加载 plate」喂 `case04_uneven.plate.png`，暗角应立刻变干净——这是 plate 通路的最直观验证。

### 4.2 客观回归（基准测试页）

1. 「加载测试集」→ 文件对话框进入 `testdata/keyer/testset/`，**Cmd+A 全选**所有 PNG（文件名正则匹配分组，manifest.json 会被忽略，不用剔除）。
2. 自动逐 case 跑：复位默认参数 → 喂 plate → 左上角 (10,10) 自动采样 → 单帧 case 渲染 8 次收敛时域项 / 多帧 case 顺序喂 → 回读 matte 与 GT 算 MAD + Sobel 梯度误差，表格实时出行。
3. 「导出报告」→ `~/Downloads/keyer-report.json`。
4. 回归判定：

```bash
python3 scripts/keyer/check_report.py ~/Downloads/keyer-report.json scripts/keyer/baseline.json
# 输出 ΔMAD / Δgrad；MAD 恶化 >0.002 或 grad >0.004 → exit 1
```

基线数值（aggregate MAD 0.0122 / grad 0.0225，逐 case 见 spec ⑥）。**改动任何 WGSL / params 打包 / 引擎编排后，必须复跑此链路且 exit 0。**

### 4.3 构建验证

```bash
pnpm exec tsc --noEmit && pnpm exec vite build   # 零错误
```

（worktree 内 vite 需直调主仓 `node_modules/.bin/vite`，除非该 worktree 已 `pnpm install`。）

## 五、已知边界速查

- 摄像机实时通路是阶段二，当前素材入口仅文件。
- 镜面反射抠成透明，不承诺镜内虚拟反射。
- 静帧导出时 matteStab 未收敛会轻微压低半透明 alpha：导出前多渲染几次或临时把「matte 稳定」归零。
- Windows（WebView2）的解码矩阵与性能均未实测。
