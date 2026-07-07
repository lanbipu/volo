# Chroma Keyer 算法规格（UE/HLSL 移植真相源）

> 实现：`src/volo/keyer/`（WGSL + 纯函数 TS）。本档与代码同步维护；移植 UE 时以本档 + WGSL 注释块为准。
> 效果基准：实时硬件级 keyer（Ultimatte 12 / Zero Density 档）；1080p60 实测达标（Mac M3 Max 原生 app 58.7–59.1fps 全管线），按 4K60 可达设计。

## ① 管线图（最终实况）

```
<video>/<img> ──copyExternalImageToTexture──▶ srcTex (rgba8unorm-srgb, 采样即线性)
  P1 denoise_temporal : srcTex + hist[1-p] ─▶ hist[p] (rgba16f, a=motion)   [ping-pong 双缓冲]
  P2 denoise_spatial  : hist[p] ─▶ dn (rgba16f, YCoCg 色度 range-bilateral, Y/a 直通)
  P0' plate（按需非逐帧）: dn ─▶ plateFull (加载 copyExternalImage 或 pull-push 估计管线)
  P3 key              : dn + plate ─▶ matteRaw (r16f)
  P4 matte_post       : matteRaw + mHist[1-p] + dn.a ─▶ matteTex + mHist[p] (r16f, MRT 双写)
  P5 edge_pre (1/4)   : dn×matte 内联预乘 + 高斯 H ─▶ qTexA (rgba16f)
  P5' edge_extend(1/4): qTexA 高斯 V ─▶ qTexB = coreTex
  P6 despill          : dn + matteTex + coreTex ─▶ fgTex (rgba16f, premultiplied)
  P7 composite        : fgTex + matteTex + dn ─▶ canvas (viewMode 0结果/1matte/2源/3wipe)
```

- 全分辨率 pass 共 6 个（P1/P2/P3/P4/P6/P7），P5/P5' 为 1/4 分辨率。
- 工作空间：线性光。srgb 纹理采样自动线性化；composite 写 `getPreferredCanvasFormat()`。
- 时域历史（hist / mHist）各两张 ping-pong，parity 逐帧翻转；不做全幅拷贝。
- 静止素材（单帧图片）时域项按渲染次数收敛：`a_n = (1-k)a_true + k·a_{n-1}`，基准测试对单帧 case 重复渲染 8 次再测。

## ② Params / cbuffer 布局（与 `params.ts` 逐字段一致，顺序即布局，不得插队重排）

Uniform buffer 80 字节 = 20 × f32；`packParams()` 打包顺序如下（HLSL 侧即 cbuffer 成员顺序，`keyColor` 3 floats + `balance` 恰好补齐 16B 对齐）：

| # | 字段 | 旋钮 | 范围 | 默认 | 语义 |
|---|---|---|---|---|---|
| 0-2 | `keyColor: vec3f` | 主色（画面点击采样 / hex 兜底，非滑杆） | — | (0.15, 0.6, 0.15) | 幕布参考色（线性光） |
| 3 | `balance` | 色差平衡 | 0–1 | 0.5 | 色差公式中 R↔B 权重 |
| 4 | `blackClip` | 黑位 | 0–0.5 | 0.05 | matte 黑位裁剪 |
| 5 | `whiteClip` | 白位 | 0.5–1 | 0.95 | matte 白位裁剪 |
| 6 | `softness` | 边缘软度 | 0.4–3 | 1.0 | matte γ 曲线 |
| 7 | `shrink` | 收缩 | -3–3 | 0 | matte 收缩/扩张 px（负=扩张） |
| 8 | `feather` | 羽化 | 0–5 | 1.0 | matte 羽化 px |
| 9 | `despillStrength` | despill 强度 | 0–1 | 0.8 | 溢色压制强度 |
| 10 | `despillBalance` | despill 平衡 | 0–1 | 0.5 | 溢色上限 R↔B 权重 |
| 11 | `lumaRestore` | —（暂无独立旋钮，随 despill 组） | 0–1 | 0.5 | 溢色压制后的亮度中性回填 |
| 12 | `denoise` | 降噪 | 0–1 | 0.4 | 时域+空域降噪联动强度 |
| 13 | `matteStab` | matte 稳定 | 0–1 | 0.5 | matte 时域稳定强度 |
| 14 | `plateMode` | —（由 plate 三按钮驱动） | 0/1 | 0 | 0=全局 keyColor；1=plateTex 逐像素参考 |
| 15 | `viewMode` | 视图 seg | 0–3 | 0 | 0 结果 / 1 matte / 2 源 / 3 AB wipe |
| 16 | `wipe` | wipe 拖杆 | 0–1 | 0.5 | 对比分割线位置 |
| 17-19 | `_p0.._p2` | — | — | 0 | padding 至 80B |

## ③ 各 pass 数学定义

**色差（Vlahos 系）**：`d(c) = c.g − mix(c.r, c.b, balance)`。

**P3 key（+ IBK 系屏幕均衡化）**：
- 参考色差 `dRef = d(keyColor)`；plateMode=1 时 `dRef = d(plate(uv))`（逐像素，打光不匀被除掉）。
- `a = 1 − clamp(d(src)/max(dRef, 1e-4), 0, 1)`，再 `smoothstep(blackClip, whiteClip, a)`，再 `pow(a, softness)`。

**P0' plate 估计（pull-push 简化版）**：mask pass 通过绿主导像素（`step(0.5·dRef_key, d)`，premult 记有效性）→ 6 级 1/2 降采样（premult 域双线性一次采样即 4-tap alpha 加权均值）→ 6 级上采样补洞（当级 `a>0.05` 保留 un-premult 值，否则取更粗一级）→ 全幅 plateFull。

**P1 时域降噪（运动自适应 EMA）**：
`motion = smoothstep(0.015, 0.10, ‖cur − hist‖)`；`blend = max(1 − denoise·0.9, motion)`；`out = mix(hist, cur, blend)`，a 通道带出 motion。denoise=0 → 直通。

**P2 空域降噪（YCoCg range-bilateral）**：Y/motion 直通，Co/Cg 走 3×3 双边：权重 `w = 1/(1 + ‖Δchroma‖²/(2σ²))`（exp 的有理近似），σ = 0.08·denoise。
YCoCg：`Y=.25r+.5g+.25b, Co=r−b, Cg=−.25r+.5g−.25b`；逆变换 `r=Y+Co/2−Cg, g=Y+Cg, b=Y−Co/2−Cg`。
⚠️ 计划稿原逆变换 y.z 项减半是错的（色度整体去饱和 → matte 灰化），已修正——移植时照本节公式。

**P4 matte 后处理（单 pass）**：3×3（步长 feather px）取 min/max/blur/中值（中值用 19 次 min/max 排序网络，**不要**用动态下标数组——Metal 上寄存器溢出导致 1080p 掉帧）；
`shrink>0 → mix(median, min, shrink/3)`；`shrink<0 → mix(median, max, −shrink/3)`；`feather → mix(a, blur, feather/5·0.6)`；
时域稳定 `a = mix(a, hist, matteStab·0.85·(1−motion))`。MRT 双写 matteTex + mHist[p]。

**P5 边缘核心色**：1/4 分辨率，H 轮内联预乘（`rgb=dn·a, a=a`）+ 9-tap 高斯（W = .227 .1946 .1216 .0541 .0162），V 轮同权重，产出模糊核心前景色 coreTex。

**P6 despill**：
① `lim = mix(r, b, despillBalance)`；`spill = max(g − lim, 0)·despillStrength`；`g −= spill`。
② 亮度回填 `c += spill·lumaRestore`（中性，防边缘发暗）。
③ 边缘借色：`a<0.9` 时以 coreTex（un-premult）按当前 luma 重标定后 `mix(borrowed, c, smoothstep(0, 0.9, a))`。
输出 premultiplied `vec4(c·a, a)`。

**P7 composite**：结果 = `fg + checker·(1−a)`；matte = `vec3(a)`；源 = dn；wipe = `uv.x < wipe ? 源 : 结果`。

## ④ WGSL → HLSL 移植注意点

- **uv 原点左上**：fullscreen 三角形 `uv = (xy.x, 1−xy.y)`；HLSL SV_Position/纹理坐标同为左上原点，直接对应；等价 `SV_VertexID` 全屏三角形。
- **srgb 采样**：WebGPU `rgba8unorm-srgb` 采样自动线性化 = DXGI `*_SRGB` 格式；UE 里源纹理走 sRGB 采样即可，全管线线性光。
- **函数对应**：`smoothstep/select/mix` → `smoothstep/(cond?b:a)/lerp`；`textureSampleLevel(t,s,uv,0)` → `t.SampleLevel(s,uv,0)`；`textureDimensions` → `GetDimensions`（或 cbuffer 传尺寸）。
- **Params 即 cbuffer**：布局见②，`vec3f+f32` 恰好 16B 对齐，HLSL `float3+float` 同构。
- **双缓冲在 UE RDG**：hist / mHist ping-pong 对应 RDG 的 persistent external texture（`RegisterExternalTexture` + 每帧交换）；MRT 双写对应双 RenderTarget。
- **中值网络**：照③抄 min/max 排序网络，勿用循环+动态下标数组（同样规避 GPR 溢出）。
- **plateMode==0**：plateTex 绑 1×1 白占位，不做分支采样优化（占位不会被读到有效分支）。

## ⑤ 素材支持矩阵（Task 3 原生 app 实测，Mac WKWebView `<video>` 路径）

| 编码 | 容器 | 解码 | 全管线帧率（1080p60） |
|---|---|---|---|
| H.264 (yuv420p) | .mp4 | ✔ | 58.7–59.1 fps |
| ProRes 422 HQ | .mov | ✔ | 59.8 fps（blit 阶段实测） |
| HEVC 10bit (hvc1) | .mp4 | ✔ | 59.2 fps（blit 阶段实测） |
| PNG / JPEG 静帧 | — | ✔（createImageBitmap） | 单帧渲染 |

注：Windows WebView2 的编解码矩阵未实测（ProRes 预计不可用），上线 Windows 前需复测。

## ⑥ 已知边界

- **镜子**：抠成透明；不承诺镜内虚拟反射（grill 共识）。
- **摄像机高质量彩色帧通路**：阶段二，不在本实现；当前素材入口仅文件（图/视频）。
- **首版基准基线**（`scripts/keyer/baseline.json`，默认参数 + 自动左上角取样 + plate 喂入）：

| case | MAD | grad |
|---|---|---|
| case01_disc | 0.0012 | 0.0031 |
| case02_hair | 0.0133 | 0.0325 |
| case03_bottle | 0.0197 | 0.0040 |
| case04_uneven | 0.0133 | 0.0323 |
| case05_noise | 0.0131 | 0.0325 |
| case06_spill | 0.0123 | 0.0308 |
| **aggregate** | **0.0122** | **0.0225** |

  回归判定：`scripts/keyer/check_report.py report.json baseline.json`（MAD 恶化 >0.002 或 grad >0.004 → exit 1）。
- **性能教训**（1080p60 预算 16.6ms，超过即被 vsync 量化到 30fps）：动态下标数组中值（Metal GPR 溢出）与逐帧 React setState 是两个已踩过的坑；HUD 已节流至每 10 帧。
- 静帧导出时 matteStab 未完全收敛会轻微压低半透明 alpha；导出前多渲染几次或将 matteStab 归零可规避。
