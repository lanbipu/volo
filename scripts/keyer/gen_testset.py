#!/usr/bin/env python3
"""GT 测试集生成器 — keyer 客观验收轨。合成公式 input = fg*a + screen*(1-a)。"""
import cv2, numpy as np, json, argparse, pathlib

W, H = 1280, 720
def screen_uniform(rng):   # 均匀好幕
    return np.full((H, W, 3), (30, 160, 40), np.float32) / 255
def screen_uneven(rng):    # 径向 0.6–1.1 增益 + 皱褶带（case04/06 用）
    y, x = np.mgrid[0:H, 0:W]
    gain = 0.6 + 0.5 * np.exp(-(((x - W*0.4)/(W*0.5))**2 + ((y - H*0.45)/(H*0.5))**2))
    wrinkle = 1 + 0.08 * np.sin(x / 37.0) * np.sin(y / 53.0 + 1.3)
    return screen_uniform(rng) * (gain * wrinkle)[..., None]
def fg_disc(rng):          # 实心圆 + 硬边
    a = np.zeros((H, W), np.float32); cv2.circle(a, (W//2, H//2), 180, 1.0, -1)
    a = cv2.GaussianBlur(a, (0, 0), 1.2)
    rgb = np.full((H, W, 3), (200, 150, 120), np.float32) / 255
    return rgb, a
def fg_hair(rng):          # 发丝：600 条 1px 抗锯齿弧线从头形边缘放射
    a = np.zeros((H, W), np.float32); cv2.circle(a, (W//2, H//2 - 40), 120, 1.0, -1)
    for _ in range(600):
        th = rng.uniform(0, 2*np.pi); r0 = 120; r1 = r0 + rng.uniform(10, 90)
        p0 = (int(W/2 + r0*np.cos(th)), int(H/2 - 40 + r0*np.sin(th)))
        p1 = (int(W/2 + r1*np.cos(th + rng.normal(0, .08))), int(H/2 - 40 + r1*np.sin(th + rng.normal(0, .08))))
        cv2.line(a, p0, p1, rng.uniform(0.3, 1.0), 1, cv2.LINE_AA)
    rgb = np.full((H, W, 3), (60, 45, 40), np.float32) / 255
    return rgb, np.clip(a, 0, 1)
def fg_bottle(rng):        # 透明渐变（矿泉水瓶类比：alpha 0.15–0.5 渐变 + 高光条 a=1）
    a = np.zeros((H, W), np.float32)
    cv2.rectangle(a, (W//2-70, H//2-200), (W//2+70, H//2+200), 1.0, -1)
    grad = np.linspace(0.15, 0.5, 400)[None, :].T
    a[H//2-200:H//2+200, W//2-70:W//2+70] *= grad
    cv2.line(a, (W//2-40, H//2-190), (W//2-40, H//2+190), 1.0, 6, cv2.LINE_AA)
    rgb = np.full((H, W, 3), (210, 215, 220), np.float32) / 255
    return rgb, a
def add_spill(rgb, a):     # 边缘沾绿：半透明带 g += (1-a)*0.12
    out = rgb.copy(); out[..., 1] += (1 - a) * 0.12 * (a > 0.02); return np.clip(out, 0, 1)

CASES = [
    ("case01_disc",    fg_disc,   screen_uniform, dict()),
    ("case02_hair",    fg_hair,   screen_uniform, dict()),
    ("case03_bottle",  fg_bottle, screen_uniform, dict()),
    ("case04_uneven",  fg_hair,   screen_uneven,  dict()),
    ("case05_noise",   fg_hair,   screen_uniform, dict(noise=2.0, frames=8)),
    ("case06_spill",   fg_hair,   screen_uneven,  dict(spill=True)),
]

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default=str(pathlib.Path(__file__).parent / "testset"))
    args = ap.parse_args(); rng = np.random.default_rng(args.seed)
    out = pathlib.Path(args.out); out.mkdir(parents=True, exist_ok=True)
    manifest = []
    for name, fg_fn, sc_fn, opt in CASES:
        rgb, a = fg_fn(rng); screen = sc_fn(rng)
        if opt.get("spill"): rgb = add_spill(rgb, a)
        frames = opt.get("frames", 1)
        for f in range(frames):
            comp = rgb * a[..., None] + screen * (1 - a[..., None])
            if opt.get("noise"): comp = np.clip(comp + rng.normal(0, opt["noise"]/255, comp.shape), 0, 1)
            suffix = f"_f{f:02d}" if frames > 1 else ""
            cv2.imwrite(str(out / f"{name}{suffix}.input.png"), (comp[..., ::-1] * 255).astype(np.uint8))
        cv2.imwrite(str(out / f"{name}.gt.png"), (a * 255).astype(np.uint8))
        cv2.imwrite(str(out / f"{name}.plate.png"), (np.clip(screen, 0, 1)[..., ::-1] * 255).astype(np.uint8))
        manifest.append({"id": name, "frames": frames, **{k: v for k, v in opt.items()}})
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"testset → {out} ({len(CASES)} cases)")

if __name__ == "__main__": main()
