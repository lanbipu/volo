# Keyer Lab v2 使用与验证

> Module: `src/volo/keyer/` + `src/volo/pages/toolsKeyer.tsx`
> Algorithm/porting truth source: `docs/architecture/chroma-keyer-spec.md`

## 1. Basic workflow

1. Open a PNG/JPEG or H.264/HEVC/ProRes file.
2. Click a clean screen pixel to sample `keyColor`, or press **自动 Key**.
3. Inspect **结果 / matte / 源 / 对比 / plate / raw matte**.
4. Tune only what the diagnostic view shows is necessary; export produces a straight-alpha PNG from the internal premultiplied foreground.

**自动 Key** performs screen sampling and plate estimation. Screen sampling scans a 16×16 grid of the current frame in one readback and picks the block with the highest green dominance (`d = g − mix(r, b, 0.5)`) as the key color, so it no longer assumes the top-left corner is screen; it falls back to the fixed `(10,10)` sample only when no block is green-dominant. For a still it selects an estimated static plate (`plateMode=1`); for video it enables per-frame dynamic plate (`plateMode=2`). Dynamic mode freezes its background model when visible-screen coverage is too low. (The benchmark page keeps the fixed `(10,10)` sample so its numbers stay comparable to the reference.)

## 2. Plate controls

- **加载 plate**: use a clean frame from the same view; this is the highest-confidence fixed-camera path.
- **估计 plate**: one-shot half-resolution pull-push from the current frame.
- **自动 Key** on video: per-frame pull-push + coverage-gated EMA.
- **清除**: return to sampled Color Key (`plateMode=0`).

The status Tag distinguishes `plate · 已加载`, `plate · 已估计`, and `plate · 动态`. The **plate** diagnostic view must track camera/image motion in dynamic mode; **raw matte** shows pre-clip alpha and is the quickest way to diagnose bad screen normalization.

## 3. v2 knobs

| knob | practical use | default |
|---|---|---:|
| 色差平衡 | shift Vlahos R/B weighting | 0.5 |
| 黑位 / 白位 | linear matte clip; do not use as an S-curve | 0.03 / 0.95 |
| 边缘软度 | gamma after linear clip | 1.0 |
| 收缩 | limited erode/dilate mix | 0 |
| 羽化 | fixed-1px Gaussian amount, range 0–1.5 | 0 |
| 去孤点 | optional 3x3 median blend; keep 0 for fine hair | 0 |
| despill 强度 / 平衡 | residual premult spill cleanup after plate un-mix | 0.8 / 0.5 |
| 降噪 | temporal + luma-guided chroma denoise | 0.4 |
| matte 稳定 | neighborhood-clamped history | 0.5 |

`去孤点` replaces v1's always-on median. Raising it can remove isolated compression defects, but also removes one-pixel hair; use the matte/raw views at 100–400% before changing it.

## 4. Test set v2

Generate deterministic fixtures (seed 7):

```bash
python3 scripts/keyer/gen_testset.py --out testdata/keyer/testset
```

All composites are formed in scene-linear light and then encoded to sRGB. Every case has canonical `.gt.png` and `.fgpre.png`; multi-frame cases also have per-frame GT.

| case | target |
|---|---|
| `case01_disc` | hard-edge sanity |
| `case02_hair` | one-pixel/partial-alpha hair |
| `case03_bottle` | neutral transparent gradient |
| `case04_uneven` | hair on spatially uneven screen |
| `case05_noise` | eight-frame sensor-noise stability |
| `case06_spill` | spill on uneven screen |
| `case07_motion` | eight-frame fast motion + shutter blur |
| `case08_blonde` | blonde hair with positive foreground color difference |
| `case09_glass` | colored semi-transparent glass |
| `case10_pan` | moving screen features; no supplied plate; dynamic mode |
| `case11_chroma420` | simulated 4:2:0 chroma down/up sampling |
| `case12_greenish` | same-color foreground guard gate |

`manifest.json` controls frame count, whether a plate is supplied, dynamic mode, and per-case parameter overrides. The bench must not infer those choices from aggregate behavior.

## 5. Reference and objective metrics

```bash
python3 scripts/keyer/ref_pipeline.py --mode v1 --report scripts/keyer/report-v1-algo-ref.json
python3 scripts/keyer/ref_pipeline.py --mode v2 --report scripts/keyer/report-v2-ref.json
python3 scripts/keyer/check_report.py scripts/keyer/report-v2-ref.json scripts/keyer/baseline.json
```

The v2 gate checks every case independently for:

- alpha MAD;
- Sobel-like gradient error;
- Edge-band SAD;
- premultiplied scene-linear foreground error (`fgErr`);
- Background Residue;
- Core Leakage;
- alpha flicker after subtracting intentional GT frame change.

`baseline.json` currently records the NumPy reference baseline and says so in `source`. Replace it with two bit-identical native GPU bench runs before using the numbers as a release claim.

In development builds, **自动加载测试集** uses the generated manifest and bypasses the file dialog. Manual loading still accepts selecting all fixture PNGs. Bench image decoding always sets `colorSpaceConversion: "none"`.

## 6. Real-footage validation

Synthetic GT is necessary but not sufficient. Validate at normal playback speed and at 400% on at least:

- backlit fine hair against both bright and dark replacement backgrounds;
- colored glass/fabric with genuinely partial transmission;
- fast limbs/hair with the production shutter angle;
- a camera pan with uneven, marked screen texture.

Check result and matte together: `bgResidue` should appear as no colored checker contamination; core must remain solid; motion must not trail; plate view must follow the current frame. Tiny-alpha straight RGB noise is expected, so judge edge color in premultiplied composition, not by un-premultiplying a single hair pixel.

## 7. Video fixture

The v2 H.264 fixture is regenerated from a scene-linear composite:

```bash
python3 scripts/keyer/gen_video.py | ffmpeg -y \
  -f rawvideo -pix_fmt rgb24 -s 1920x1080 -r 60 -i - \
  -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p \
  testdata/keyer/greenscreen_1080p60_h264.mp4
```

HEVC/ProRes files from v1 are intentionally not regenerated and must be labelled as v1-physics codec fixtures.

Performance acceptance remains native-app 1080p60 HUD `>=58fps`. If dynamic plate misses budget, degrade in this order: update plate every other frame, then keep conditional refine disabled. Never reintroduce per-frame texture allocation.

## 8. Build verification

```bash
pnpm exec tsc --noEmit
pnpm exec vite build
```

When a worktree has no local `node_modules`, use the main repository binaries. A sandbox that cannot write the shared Vite `.vite-temp` may use `vite build --configLoader runner`; this changes config loading only, not the production bundle.
