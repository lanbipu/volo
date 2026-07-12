#!/usr/bin/env python3
"""Generate the deterministic Keyer v2 ground-truth suite in scene-linear light."""

from __future__ import annotations

import argparse
import json
import pathlib
from dataclasses import dataclass, field

import cv2
import numpy as np

W, H = 1280, 720


def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, np.float32)
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(x: np.ndarray) -> np.ndarray:
    x = np.clip(np.asarray(x, np.float32), 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1.0 / 2.4) - 0.055)


def rgb8(rgb: tuple[int, int, int]) -> np.ndarray:
    return np.asarray(rgb, np.float32) / 255.0


def screen_uniform(_rng: np.random.Generator, frame: int = 0) -> np.ndarray:
    del frame
    return np.broadcast_to(rgb8((30, 160, 40)), (H, W, 3)).copy()


def screen_uneven(_rng: np.random.Generator, frame: int = 0) -> np.ndarray:
    del frame
    y, x = np.mgrid[0:H, 0:W]
    gain = 0.6 + 0.5 * np.exp(-(((x - W * 0.4) / (W * 0.5)) ** 2 + ((y - H * 0.45) / (H * 0.5)) ** 2))
    wrinkle = 1 + 0.08 * np.sin(x / 37.0) * np.sin(y / 53.0 + 1.3)
    return np.clip(screen_uniform(_rng) * (gain * wrinkle)[..., None], 0.0, 1.0)


def screen_pan(rng: np.random.Generator, frame: int = 0) -> np.ndarray:
    base = screen_uneven(rng)
    y, x = np.mgrid[0:H, 0:W]
    wave = np.sin(x / 90.0 + y / 150.0)
    feature = np.stack((0.12 * wave, 0.018 * np.sin(y / 95.0), -0.10 * wave), axis=-1)
    base = np.clip(base + feature, 0.0, 1.0)
    return np.roll(base, shift=(frame * 19, frame * 47), axis=(0, 1))


def solid_rgb(color: tuple[int, int, int]) -> np.ndarray:
    return np.broadcast_to(rgb8(color), (H, W, 3)).copy()


def fg_disc(_rng: np.random.Generator, frame: int = 0) -> tuple[np.ndarray, np.ndarray]:
    del frame
    a = np.zeros((H, W), np.float32)
    cv2.circle(a, (W // 2, H // 2), 180, 1.0, -1)
    return solid_rgb((200, 150, 120)), cv2.GaussianBlur(a, (0, 0), 1.2)


def hair_alpha(rng: np.random.Generator, center: tuple[int, int], color_alpha: bool = False) -> np.ndarray:
    a = np.zeros((H, W), np.float32)
    cv2.circle(a, center, 120, 1.0, -1)
    cx, cy = center
    for _ in range(600):
        th = rng.uniform(0, 2 * np.pi)
        r1 = 120 + rng.uniform(10, 90)
        p0 = (int(cx + 120 * np.cos(th)), int(cy + 120 * np.sin(th)))
        bend = th + rng.normal(0, 0.08)
        p1 = (int(cx + r1 * np.cos(bend)), int(cy + r1 * np.sin(bend)))
        opacity = rng.uniform(0.2 if color_alpha else 0.3, 1.0)
        cv2.line(a, p0, p1, float(opacity), 1, cv2.LINE_AA)
    return np.clip(a, 0.0, 1.0)


def fg_hair(rng: np.random.Generator, frame: int = 0) -> tuple[np.ndarray, np.ndarray]:
    del frame
    return solid_rgb((60, 45, 40)), hair_alpha(rng, (W // 2, H // 2 - 40))


def fg_bottle(_rng: np.random.Generator, frame: int = 0) -> tuple[np.ndarray, np.ndarray]:
    del frame
    a = np.zeros((H, W), np.float32)
    y0, y1, x0, x1 = H // 2 - 200, H // 2 + 200, W // 2 - 70, W // 2 + 70
    a[y0:y1, x0:x1] = np.linspace(0.15, 0.5, y1 - y0, dtype=np.float32)[:, None]
    cv2.line(a, (W // 2 - 40, y0 + 10), (W // 2 - 40, y1 - 10), 1.0, 6, cv2.LINE_AA)
    return solid_rgb((210, 215, 220)), a


def motion_subject(rng: np.random.Generator, frame: int) -> tuple[np.ndarray, np.ndarray]:
    # Five shutter samples produce physically meaningful coverage for the final fast-moving frame.
    accum_a = np.zeros((H, W), np.float32)
    accum_pre = np.zeros((H, W, 3), np.float32)
    color = srgb_to_linear(solid_rgb((185, 105, 70)))
    for sub in np.linspace(-0.5, 0.5, 5):
        cx = int(W * 0.28 + (frame + sub) * 92)
        cy = int(H * 0.5 + 24 * np.sin((frame + sub) * 0.8))
        a = np.zeros((H, W), np.float32)
        cv2.circle(a, (cx, cy), 105, 1.0, -1, cv2.LINE_AA)
        cv2.line(a, (cx - 65, cy - 78), (cx - 150, cy - 145), 0.45, 2, cv2.LINE_AA)
        accum_a += a / 5.0
        accum_pre += color * a[..., None] / 5.0
    a = np.clip(accum_a, 0.0, 1.0)
    fg_lin = np.divide(accum_pre, np.maximum(a[..., None], 1e-6), out=np.zeros_like(accum_pre), where=a[..., None] > 1e-6)
    return linear_to_srgb(fg_lin), a


def fg_blonde(rng: np.random.Generator, frame: int = 0) -> tuple[np.ndarray, np.ndarray]:
    del frame
    a = hair_alpha(rng, (W // 2, H // 2 - 35), color_alpha=True)
    y = np.linspace(0.82, 1.08, H, dtype=np.float32)[:, None, None]
    return np.clip(solid_rgb((196, 170, 78)) * y, 0.0, 1.0), a


def fg_glass(_rng: np.random.Generator, frame: int = 0) -> tuple[np.ndarray, np.ndarray]:
    del frame
    a = np.zeros((H, W), np.float32)
    center = (W // 2, H // 2)
    cv2.ellipse(a, center, (155, 230), 0, 0, 360, 0.22, -1, cv2.LINE_AA)
    cv2.ellipse(a, center, (155, 230), 0, 0, 360, 0.7, 5, cv2.LINE_AA)
    cv2.ellipse(a, (center[0] - 45, center[1]), (22, 185), -8, 0, 360, 0.9, -1, cv2.LINE_AA)
    rgb = solid_rgb((120, 165, 220))
    return rgb, np.clip(a, 0.0, 1.0)


def fg_greenish(_rng: np.random.Generator, frame: int = 0) -> tuple[np.ndarray, np.ndarray]:
    del frame
    a = np.zeros((H, W), np.float32)
    cv2.rectangle(a, (W // 2 - 220, H // 2 - 150), (W // 2 + 220, H // 2 + 150), 1.0, -1)
    a = cv2.GaussianBlur(a, (0, 0), 1.0)
    rgb = solid_rgb((30, 125, 112))
    stripe = ((np.arange(W) // 32) % 2).astype(np.float32)[None, :, None]
    rgb = np.clip(rgb + stripe * rgb8((10, 28, 18)), 0.0, 1.0)
    return rgb, a


def add_spill_linear(fg_linear: np.ndarray, alpha: np.ndarray, strength: float = 0.12) -> np.ndarray:
    out = fg_linear.copy()
    out[..., 1] += (1.0 - alpha) * strength * (alpha > 0.02)
    return np.clip(out, 0.0, 1.0)


def chroma_420(encoded: np.ndarray) -> np.ndarray:
    # BT.709-like encoded-domain chroma loss, matching the practical decoder artifact being tested.
    r, g, b = encoded[..., 0], encoded[..., 1], encoded[..., 2]
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    cb = (b - y) / 1.8556
    cr = (r - y) / 1.5748
    size = (W // 2, H // 2)
    cb = cv2.resize(cv2.resize(cb, size, interpolation=cv2.INTER_AREA), (W, H), interpolation=cv2.INTER_LINEAR)
    cr = cv2.resize(cv2.resize(cr, size, interpolation=cv2.INTER_AREA), (W, H), interpolation=cv2.INTER_LINEAR)
    out = np.stack((y + 1.5748 * cr, y - 0.1873 * cb - 0.4681 * cr, y + 1.8556 * cb), axis=-1)
    return np.clip(out, 0.0, 1.0)


@dataclass(frozen=True)
class Case:
    name: str
    fg: object
    screen: object = screen_uniform
    frames: int = 1
    spill: bool = False
    noise: float = 0.0
    chroma420: bool = False
    feed_plate: bool = True
    dynamic_plate: bool = False
    params: dict[str, float] = field(default_factory=dict)


CASES = [
    Case("case01_disc", fg_disc),
    Case("case02_hair", fg_hair),
    Case("case03_bottle", fg_bottle),
    Case("case04_uneven", fg_hair, screen_uneven),
    Case("case05_noise", fg_hair, screen_uniform, frames=8, noise=2.0),
    Case("case06_spill", fg_hair, screen_uneven, spill=True),
    Case("case07_motion", motion_subject, screen_uneven, frames=8, spill=True),
    Case("case08_blonde", fg_blonde, screen_uneven, spill=True),
    Case("case09_glass", fg_glass, screen_uneven, spill=True),
    Case("case10_pan", fg_disc, screen_pan, frames=8, feed_plate=False, dynamic_plate=True),
    Case("case11_chroma420", fg_hair, screen_uneven, chroma420=True, spill=True),
    Case("case12_greenish", fg_greenish, screen_uneven),
]


def write_rgb(path: pathlib.Path, rgb: np.ndarray) -> None:
    cv2.imwrite(str(path), np.round(np.clip(rgb[..., ::-1], 0.0, 1.0) * 255).astype(np.uint8))


def write_alpha(path: pathlib.Path, alpha: np.ndarray) -> None:
    cv2.imwrite(str(path), np.round(np.clip(alpha, 0.0, 1.0) * 255).astype(np.uint8))


def render_case(case: Case, rng: np.random.Generator, out: pathlib.Path) -> dict[str, object]:
    final_alpha = np.zeros((H, W), np.float32)
    final_fgpre = np.zeros((H, W, 3), np.float32)
    final_plate = np.zeros((H, W, 3), np.float32)
    for frame in range(case.frames):
        # Per-frame deterministic RNG keeps moving cases repeatable without re-randomizing hair topology.
        frame_rng = np.random.default_rng(rng.integers(0, 2**32 - 1) if case.frames == 1 else 7 + CASES.index(case) * 1000)
        fg_srgb, alpha = case.fg(frame_rng, frame)
        plate_srgb = case.screen(rng, frame)
        fg_clean_linear = srgb_to_linear(fg_srgb)
        fg_observed_linear = add_spill_linear(fg_clean_linear, alpha) if case.spill else fg_clean_linear
        plate_linear = srgb_to_linear(plate_srgb)
        comp_linear = fg_observed_linear * alpha[..., None] + plate_linear * (1.0 - alpha[..., None])
        if case.noise:
            comp_linear = comp_linear + rng.normal(0.0, case.noise / 255.0, comp_linear.shape).astype(np.float32)
        comp_srgb = linear_to_srgb(comp_linear)
        if case.chroma420:
            comp_srgb = chroma_420(comp_srgb)
        suffix = f"_f{frame:02d}" if case.frames > 1 else ""
        write_rgb(out / f"{case.name}{suffix}.input.png", comp_srgb)
        final_alpha = alpha
        final_fgpre = linear_to_srgb(fg_clean_linear * alpha[..., None])
        final_plate = plate_srgb
        if case.frames > 1:
            write_alpha(out / f"{case.name}{suffix}.gt.png", alpha)
            write_rgb(out / f"{case.name}{suffix}.fgpre.png", final_fgpre)
    write_alpha(out / f"{case.name}.gt.png", final_alpha)
    write_rgb(out / f"{case.name}.fgpre.png", final_fgpre)
    if case.feed_plate:
        write_rgb(out / f"{case.name}.plate.png", final_plate)
    return {
        "id": case.name,
        "frames": case.frames,
        "compare_frame": case.frames - 1,
        "feed_plate": case.feed_plate,
        "dynamic_plate": case.dynamic_plate,
        "params": case.params,
        "noise": case.noise,
        "spill": case.spill,
        "chroma420": case.chroma420,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default=str(pathlib.Path(__file__).parent / "testset"))
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("case*.png"):
        old.unlink()
    manifest = [render_case(case, rng, out) for case in CASES]
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"testset v2 -> {out} ({len(CASES)} cases, seed={args.seed})")


if __name__ == "__main__":
    main()
