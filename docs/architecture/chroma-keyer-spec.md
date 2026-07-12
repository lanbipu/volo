# Chroma Keyer v2 算法规格（UE/HLSL 移植真相源）

> 实现：`src/volo/keyer/`（WGSL + strict TypeScript）。本档与代码同步维护。
> 定位：Clean-Plate-First 实时 keyer；重点验收发丝、半透明、快速运动和 image-based 动态 plate。

## ① 管线图（v2 实况）

```text
<video>/<img> ──copyExternalImageToTexture──▶ srcTex (rgba8unorm-srgb; sample -> scene-linear)
  P1 denoise_temporal : srcTex + hist[1-p] ─▶ hist[p] (rgba16f, a=relative-motion)
  P2 denoise_spatial  : hist[p] ─▶ dn (rgba16f, luma-guided YCoCg chroma bilateral)
  P0 dynamic plate    : dn ─▶ 1/2 mask/pull-push ─▶ plate EMA ping-pong ─▶ plateFull
  P3 key v2           : dn + plate ─▶ matteRaw (rg16f: r=linear-clipped soft, g=raw)
  P4 matte_post v2    : matteRaw + matte history + motion ─▶ matteTex + mHist[p] (r16f MRT)
  P6 despill v2       : dn + matteTex + plate ─▶ fgTex (rgba16f premultiplied)
  P7 composite        : fg/matte/dn/plate/raw ─▶ canvas
```

- 工作空间统一为 scene-linear；内部 foreground 为 premultiplied。
- v1 的 1/4-res `edge_pre/edge_extend` core 借色链被条件跳过：reference 评审未证明收益，且会破坏发丝颜色。
- 动态 plate 的所有纹理、pipeline 和 bind group 在尺寸变化时一次预分配；逐帧只编码 pass，不创建纹理。
- `plateMode=2` 每帧执行半分辨率 pull-push。最粗 1x1 alpha 是背景覆盖率；覆盖率 `<0.08` 时冻结 plate history。
- video 继续由 `requestVideoFrameCallback` 驱动；`resetHistory()` 用于 case/scene-cut 隔离。

## ② Params / cbuffer（固定 80B）

`packParams()` 顺序 = WGSL `Params` = UE/HLSL cbuffer；不得插队重排。

| index | field | range | default | semantics |
|---:|---|---:|---:|---|
| 0–2 | `keyColor` | — | `(0.15,0.6,0.15)` | scene-linear sampled screen color |
| 3 | `balance` | 0–1 | 0.5 | Vlahos R/B balance |
| 4 | `blackClip` | 0–0.5 | **0.03** | linear soft matte black clip |
| 5 | `whiteClip` | 0.5–1 | **0.95** | linear soft matte white clip |
| 6 | `softness` | 0.4–3 | 1 | gamma only; does not replace linear clip |
| 7 | `shrink` | -3–3 | 0 | matte erode/dilate mix |
| 8 | `feather` | 0–1.5 | **0** | fixed-1px Gaussian mix; motion adds up to 0.75 |
| 9 | `despillStrength` | 0–1 | 0.8 | residual spill suppression |
| 10 | `despillBalance` | 0–1 | 0.5 | residual spill R/B balance |
| 11 | `lumaRestore` | 0–1 | 0.5 | neutral premult luma restore |
| 12 | `denoise` | 0–1 | 0.4 | temporal/spatial denoise |
| 13 | `matteStab` | 0–1 | 0.5 | clamped-history weight |
| 14 | `plateMode` | 0/1/2 | 0 | keyColor / static-or-estimated / dynamic |
| 15 | `viewMode` | 0–5 | 0 | result / matte / source / wipe / plate / raw |
| 16 | `wipe` | 0–1 | 0.5 | wipe position |
| 17 (`_p0`) | `despot` | 0–1 | **0** | optional 3x3 median blend |
| 18 (`_p1`) | `conditionalStrength` | 0–1 | **0** | reserved refine/guard hook; both candidates rejected (see below) |
| 19 (`_p2`) | padding | — | 0 | 80B alignment |

Defaults come from the aligned v2 linear-light 12-case NumPy scan (`blackClip 0.03`, `whiteClip 0.95`). Both conditional candidates were **re-evaluated after fixing the refine core-color estimate** (the old `soft>0.92` mask collapsed to empty on `case08` → the refine branch was a silent no-op; now the estimate is a `min3(hardClip(raw))`-weighted spatial mean with an empty-weight no-op fallback) and rejected on real data:

- **refine (two-pass re-solve):** now genuinely fixes opaque-core cases (`case08_blonde` mad 0.0075→0.0021, coreLeak 0.055→0.00002; `case12_greenish` mad 0.045→0.015; `case07_motion` edge 0.138→0.106) — but **catastrophically breaks genuinely transparent foregrounds** (`case03_bottle` mad/edge ~8×, `case09_glass` ~5×), because re-solving alpha from an estimated opaque foreground color destroys real partial-alpha gradients. Fails per-case non-regression.
- **guard (same-color residual):** at every scanned threshold (`0.035/0.10`, `0.05/0.15`, `0.07/0.2`) it fixes only `case12_greenish` while regressing 10–11 of the other cases 2–20× (edge/flicker especially). The same-color guard cannot separate `case12`'s greenish subject from legitimate green content without per-case tuning.

Both stay disabled (`conditionalStrength=0`); `_p1` remains a reserved slot for a future per-region (not global) gate.

## ③ Pass 数学定义

### P1 relative-motion temporal denoise

```text
Y = dot(cur, Rec.709)
relative = distance(cur, hist) / (Y + 0.05)
motion = smoothstep(0.04, 0.22, relative)
blend = max(1 - denoise*0.9, motion)
out = mix(hist, cur, blend)
```

The alpha channel carries `motion` into P4. Relative distance avoids the v1 fixed-linear threshold failing in dark pixels.

### P2 luma-guided chroma reconstruction

Y is preserved. Co/Cg use a 3x3 joint bilateral:

```text
w = chromaWeight(deltaCoCg, 0.08*denoise)
  * lumaWeight(deltaY, 0.025 + 0.08*denoise)
```

This is the deterministic 4:2:2/4:2:0 edge-reconstruction path; it does not claim to undo all codec loss.

### P3 Clean-Plate-First linear key

`d(c)=c.g-mix(c.r,c.b,balance)`.

```text
dKey = d(keyColor)
dPlate = d(plate(uv))
plateConfidence = clamp((dPlate - 0.15*dKey)/(0.35*dKey), 0, 1)
dRef = mix(dKey, dPlate, plateConfidence)
raw = 1 - clamp(d(src)/max(dRef,1e-4), 0, 1)
soft = clamp((raw-blackClip)/(whiteClip-blackClip), 0, 1)^softness
```

`plateConfidence` provides per-pixel Color Key fallback when a plate pixel is invalid/suspicious. `smoothstep` is deliberately absent so mixed-pixel alpha remains linear.

### P4 soft/core + TAA-clamped matte

- soft base is the untouched P3 `soft`; median enters only through `despot` (`_p0`, default 0).
- taps are fixed at 1px and independent from feather.
- core is an eroded hard clip of `raw`, attenuated by `(1-motion)` so it cannot fill fast-motion soft coverage.
- `final=max(soft,core)`; core fills opaque interiors but cannot replace trustworthy soft edges.
- feather is a fixed 3x3 Gaussian mix, `clamp(feather + 0.75*motion,0,1.5)`.
- history is clamped to the current 3x3 min/max before EMA; disoccluded/moving structure therefore cannot leave an unconstrained trail.

### P6 plate un-mix despill

```text
B = confident plate pixel, otherwise keyColor
t = min(1-a, C.g/max(B.g,epsilon))
fgPre = max(C - t*B, 0)
fgPre *= step(epsilon,a)
```

Residual green above the R/B limit is then suppressed in premultiplied space and neutral luma is restored. The alpha-zero gate is mandatory: without it, plate mismatch leaks colored residue into transparent background.

### P0 dynamic plate

1. half-resolution green-dominant mask, premultiplied by validity;
2. downsample to 1x1 coverage, then pull-push fill back to half resolution;
3. ping-pong EMA: coverage `<0.08` freezes; otherwise a **per-pixel** rate — pixels with `relativeChange>0.01` track immediately (rate 1.0), stable pixels rise with local change as `clamp(0.08+relativeChange*4, 0.08, 0.25)` (ref and WGSL share this exact formula);
4. bilinear upsample to `plateFull`, consumed by P3/P6/P7 in the same command encoder.

## ④ WGSL → HLSL / UE notes

- `matteRaw` is `rg16float` (`r=soft`, `g=raw`); preserve both channels in RDG.
- sRGB input sampling must decode to linear; do not composite or solve alpha in encoded RGB.
- `Params` remains an 80-byte cbuffer. `_p0` and `_p1` are real data slots, not new fields appended after the buffer.
- dynamic plate histories map to persistent external RDG textures. Rebind key/despill/composite whenever the active static texture changes.
- alpha-zero un-mix gating and neighborhood history clamp are correctness requirements, not optional optimizations.
- UV origin is top-left in this implementation; preserve orientation when porting the fullscreen triangle.

## ⑤ Diagnostics and verification

`viewMode`: `0 result`, `1 matte`, `2 source`, `3 wipe`, `4 plate`, `5 raw matte`.

Objective files:

- generator: `scripts/keyer/gen_testset.py` (12 cases, scene-linear compositing, `fgpre` GT);
- reference: `scripts/keyer/ref_pipeline.py`;
- gate: `scripts/keyer/check_report.py` (per-case × per-metric);
- current baseline: `scripts/keyer/baseline.json`.

Metrics are MAD, gradient error, Edge-band SAD, premult scene-linear `fgErr`, Background Residue, Core Leakage, and motion-compensated alpha flicker.

## ⑥ Known boundaries / backlog

- Current `baseline.json` is transparently marked `numpy-ref-v2`; native GPU automation was unavailable when v2 was authored. Replace it with the reproducible GPU report before claiming production quality parity.
- Dynamic plate is image-based. Long-lived occlusion is inferred/frozen, not ground truth; tracked 3D Cyclorama projection remains phase two.
- `case12_greenish` remains a documented weakness: the same-color guard was re-scanned across three thresholds and rejected each time (fixes only `case12`, regresses 10–11 other cases). A global guard cannot solve it; a per-region gate is the open path.
- Transparent foregrounds (`case03_bottle`, `case09_glass`) are a documented refine boundary: the two-pass re-solve that fixes opaque-core cases destroys their partial-alpha gradients, so refine is not globally safe and stays disabled.
- AI uncertain-band refinement, Shadow Matte, OCIO, SDI/NDI, 4K60 and 8h soak remain backlog.
- 8-bit PNG introduces an approximately 0.001–0.002 metric floor; tiny-alpha straight RGB is inherently noisy, so validation uses premult `fgErr`.
- HEVC/ProRes fixture files remain v1-physics artifacts; only H.264 is regenerated for v2.
