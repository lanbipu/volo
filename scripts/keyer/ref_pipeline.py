#!/usr/bin/env python3
"""NumPy/OpenCV reference for the Keyer v1/v2 deterministic pass chain.

This is intentionally image-oriented and slow.  It mirrors the shader math,
produces per-case objective reports, scans v2 clip defaults, and evaluates the
two gated Phase 3 options before WGSL porting.
"""

from __future__ import annotations

import argparse
import json
import pathlib
from dataclasses import dataclass, replace

import cv2
import numpy as np


def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, np.float32)
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def read_rgb(path: pathlib.Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise FileNotFoundError(path)
    return srgb_to_linear(image[..., ::-1].astype(np.float32) / 255.0)


def read_alpha(path: pathlib.Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise FileNotFoundError(path)
    return image.astype(np.float32) / 255.0


def write_rgb(path: pathlib.Path, linear: np.ndarray) -> None:
    x = np.clip(linear, 0.0, 1.0)
    srgb = np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)
    cv2.imwrite(str(path), np.round(srgb[..., ::-1] * 255).astype(np.uint8))


def write_alpha(path: pathlib.Path, alpha: np.ndarray) -> None:
    cv2.imwrite(str(path), np.round(np.clip(alpha, 0, 1) * 255).astype(np.uint8))


def cdiff(rgb: np.ndarray, balance: float) -> np.ndarray:
    return rgb[..., 1] - ((1 - balance) * rgb[..., 0] + balance * rgb[..., 2])


def shift_edge(x: np.ndarray, dx: int, dy: int) -> np.ndarray:
    # 采样偏移 (dx,dy)∈{-1,0,1}，边界 replicate（对齐 GPU sampler clamp-to-edge，非 np.roll wrap）。
    pad = [(1, 1), (1, 1)] + [(0, 0)] * (x.ndim - 2)
    padded = np.pad(x, pad, mode="edge")
    return padded[1 - dy:1 - dy + x.shape[0], 1 - dx:1 - dx + x.shape[1]]


def min3(x: np.ndarray) -> np.ndarray:
    return cv2.erode(x, np.ones((3, 3), np.uint8), borderType=cv2.BORDER_REPLICATE)


def max3(x: np.ndarray) -> np.ndarray:
    return cv2.dilate(x, np.ones((3, 3), np.uint8), borderType=cv2.BORDER_REPLICATE)


def median3(x: np.ndarray) -> np.ndarray:
    return cv2.medianBlur(x.astype(np.float32), 3)


def tent3(x: np.ndarray) -> np.ndarray:
    # 3×3 tent 核 1-2-1/16，对齐 matte_post.wgsl 的 gaussian（对 soft 邻域，非融合后 matte）。
    kernel = np.asarray([[1, 2, 1], [2, 4, 2], [1, 2, 1]], np.float32) / 16.0
    return cv2.filter2D(x, -1, kernel, borderType=cv2.BORDER_REPLICATE)


@dataclass(frozen=True)
class Params:
    key_color: tuple[float, float, float] = (0.15, 0.6, 0.15)
    balance: float = 0.5
    black_clip: float = 0.03
    white_clip: float = 0.95
    softness: float = 1.0
    shrink: float = 0.0
    feather: float = 0.0
    despill_strength: float = 0.8
    despill_balance: float = 0.5
    luma_restore: float = 0.5
    denoise: float = 0.4
    matte_stab: float = 0.5
    despot: float = 0.0
    guard: float = 0.0
    refine: float = 0.0


class RefKeyer:
    def __init__(self, params: Params, mode: str = "v2") -> None:
        self.p = params
        self.mode = mode
        self.color_history: np.ndarray | None = None
        self.matte_history: np.ndarray | None = None
        self.dynamic_plate: np.ndarray | None = None

    def reset(self) -> None:
        self.color_history = None
        self.matte_history = None
        self.dynamic_plate = None

    def denoise_temporal(self, current: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        if self.color_history is None:
            history = np.zeros_like(current)
        else:
            history = self.color_history
        delta = np.linalg.norm(current - history, axis=2)
        if self.mode == "v2":
            y = current @ np.asarray([0.2126, 0.7152, 0.0722], np.float32)
            relative = delta / (y + 0.05)
            motion = np.clip((relative - 0.04) / 0.18, 0, 1)
        else:
            motion = np.clip((delta - 0.015) / 0.085, 0, 1)
        motion = motion * motion * (3 - 2 * motion)
        blend = np.maximum(1 - self.p.denoise * 0.9, motion)[..., None]
        output = history * (1 - blend) + current * blend
        self.color_history = output
        return output, motion

    def denoise_spatial(self, src: np.ndarray) -> np.ndarray:
        y = 0.25 * src[..., 0] + 0.5 * src[..., 1] + 0.25 * src[..., 2]
        co = src[..., 0] - src[..., 2]
        cg = -0.25 * src[..., 0] + 0.5 * src[..., 1] - 0.25 * src[..., 2]
        sigma = max(0.08 * self.p.denoise, 1e-3)
        acc_co = np.zeros_like(co)
        acc_cg = np.zeros_like(cg)
        weights = np.zeros_like(y)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                yi, coi, cgi = (shift_edge(v, dx, dy) for v in (y, co, cg))
                chroma_d2 = (coi - co) ** 2 + (cgi - cg) ** 2
                weight = 1 / (1 + chroma_d2 / (2 * sigma * sigma))
                if self.mode == "v2":
                    # Luma guidance preserves chroma discontinuities at hair/codec edges.
                    luma_sigma = 0.025 + 0.08 * self.p.denoise
                    weight *= 1 / (1 + (yi - y) ** 2 / (2 * luma_sigma * luma_sigma))
                acc_co += coi * weight
                acc_cg += cgi * weight
                weights += weight
        mix_amount = float(self.p.denoise >= 0.01)
        co = co * (1 - mix_amount) + (acc_co / np.maximum(weights, 1e-6)) * mix_amount
        cg = cg * (1 - mix_amount) + (acc_cg / np.maximum(weights, 1e-6)) * mix_amount
        return np.stack((y + 0.5 * co - cg, y + cg, y - 0.5 * co - cg), axis=2)

    def estimate_dynamic_plate(self, src: np.ndarray) -> np.ndarray:
        h, w = src.shape[:2]
        half = cv2.resize(src, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
        d = cdiff(half, self.p.balance)
        d_key = cdiff(np.asarray(self.p.key_color, np.float32)[None, None], self.p.balance).item()
        valid = (d >= 0.5 * d_key).astype(np.float32)
        premult = half * valid[..., None]
        weight = valid
        levels: list[tuple[np.ndarray, np.ndarray]] = [(premult, weight)]
        while min(levels[-1][0].shape[:2]) > 12 and len(levels) < 7:
            ph, pw = levels[-1][0].shape[:2]
            levels.append((
                cv2.resize(levels[-1][0], (max(1, pw // 2), max(1, ph // 2)), interpolation=cv2.INTER_AREA),
                cv2.resize(levels[-1][1], (max(1, pw // 2), max(1, ph // 2)), interpolation=cv2.INTER_AREA),
            ))
        coarse_pre, coarse_w = levels[-1]
        fill = coarse_pre / np.maximum(coarse_w[..., None], 1e-4)
        coverage = float(np.mean(coarse_w))
        for fine_pre, fine_w in reversed(levels[:-1]):
            up = cv2.resize(fill, (fine_pre.shape[1], fine_pre.shape[0]), interpolation=cv2.INTER_LINEAR)
            fine = fine_pre / np.maximum(fine_w[..., None], 1e-4)
            fill = np.where((fine_w > 0.05)[..., None], fine, up)
        full = cv2.resize(fill, (w, h), interpolation=cv2.INTER_LINEAR)
        if self.dynamic_plate is None:
            self.dynamic_plate = full
        elif coverage >= 0.08:
            # 逐像素速率（对齐 plate_ema.wgsl）：distance/L2 归一 mean(abs)，运动像素立即跟随、稳定像素走 EMA。
            relative_change = np.linalg.norm(full - self.dynamic_plate, axis=2) / (np.mean(np.abs(full), axis=2) + 0.05)
            rate = np.where(relative_change > 0.01, 1.0, np.clip(0.08 + relative_change * 4.0, 0.08, 0.25))[..., None]
            self.dynamic_plate = self.dynamic_plate * (1 - rate) + full * rate
        return self.dynamic_plate

    def key(self, src: np.ndarray, plate: np.ndarray | None) -> tuple[np.ndarray, np.ndarray]:
        d_src = cdiff(src, self.p.balance)
        key_color = np.asarray(self.p.key_color, np.float32)
        d_key = float(cdiff(key_color[None, None], self.p.balance).item())
        if plate is None:
            d_ref = np.full(d_src.shape, d_key, np.float32)
        else:
            d_plate = cdiff(plate, self.p.balance)
            # Suspicious/invalid plate pixels continuously fall back to the sampled color.
            confidence = np.clip((d_plate - 0.15 * d_key) / max(0.35 * d_key, 1e-4), 0, 1)
            d_ref = d_key * (1 - confidence) + d_plate * confidence
        raw = 1 - np.clip(d_src / np.maximum(d_ref, 1e-4), 0, 1)
        if self.mode == "v1":
            t = np.clip((raw - 0.05) / 0.9, 0, 1)
            soft = t * t * (3 - 2 * t)
        else:
            soft = np.clip((raw - self.p.black_clip) / max(self.p.white_clip - self.p.black_clip, 1e-4), 0, 1)
        soft = np.power(soft, self.p.softness)
        if self.mode == "v2" and self.p.guard > 0 and plate is not None:
            eps = 1e-4
            src_sum = np.sum(src, axis=2) + eps
            plate_sum = np.sum(plate, axis=2) + eps
            src_chroma = src / src_sum[..., None]
            plate_chroma = plate / plate_sum[..., None]
            chroma_residual = np.linalg.norm(src_chroma - plate_chroma, axis=2)
            luma_ratio = np.sum(src, axis=2) / np.maximum(np.sum(plate, axis=2), eps)
            non_shading = chroma_residual * np.exp(-np.abs(np.log(np.maximum(luma_ratio, eps))) * 0.5)
            guard = np.clip((non_shading - 0.035) / 0.10, 0, 1) * self.p.guard
            soft = np.maximum(soft, guard)
        if self.mode == "v2" and self.p.refine > 0 and plate is not None:
            # 核心色估计：hardClip-core 加权空间均值（权重 = min3(hardClip(raw))，替代此前塌缩的 soft>0.92 全局阈值）。
            hard = np.clip((raw - max(self.p.black_clip * 2, 0.03)) / max(0.72 - self.p.black_clip * 2, 1e-4), 0, 1)
            core_weight = min3(hard)
            weight_sum = float(np.sum(core_weight))
            if weight_sum >= 1.0:  # 权重和 <1（空/不足核心）→ 保持 no-op 回退
                fg_color = np.sum(src * core_weight[..., None], axis=(0, 1)) / weight_sum
                d_fg = float(cdiff(fg_color[None, None], self.p.balance).item())
                denom = d_ref - d_fg
                refined = np.where(np.abs(denom) > 0.08 * np.maximum(np.abs(d_ref), 1e-4), (d_ref - d_src) / denom, raw)
                refined = np.clip((refined - self.p.black_clip) / max(self.p.white_clip - self.p.black_clip, 1e-4), 0, 1)
                soft = soft * (1 - self.p.refine) + refined * self.p.refine
        return np.clip(soft, 0, 1), np.clip(raw, 0, 1)

    def matte_post(self, soft: np.ndarray, raw: np.ndarray, motion: np.ndarray) -> np.ndarray:
        if self.mode == "v1":
            matte = median3(soft)
            if self.p.shrink > 0:
                matte = matte * (1 - self.p.shrink / 3) + min3(matte) * (self.p.shrink / 3)
            elif self.p.shrink < 0:
                matte = matte * (1 + self.p.shrink / 3) + max3(matte) * (-self.p.shrink / 3)
            matte = matte * (1 - self.p.feather / 5 * 0.6) + cv2.blur(matte, (3, 3)) * (self.p.feather / 5 * 0.6)
        else:
            matte = soft * (1 - self.p.despot) + median3(soft) * self.p.despot
            hard = np.clip((raw - max(self.p.black_clip * 2, 0.03)) / max(0.72 - self.p.black_clip * 2, 1e-4), 0, 1)
            core = min3(hard) * (1 - motion)
            matte = np.maximum(matte, core)
            if self.p.shrink > 0:
                matte = matte * (1 - self.p.shrink / 3) + min3(matte) * (self.p.shrink / 3)
            elif self.p.shrink < 0:
                matte = matte * (1 + self.p.shrink / 3) + max3(matte) * (-self.p.shrink / 3)
            feather = np.clip(self.p.feather + 0.75 * motion, 0, 1.5)
            # 羽化源对齐 WGSL：融合方向为 soft 邻域的 1-2-1 tent（非融合后 matte 的高斯）。
            matte = matte * (1 - feather * 0.5) + tent3(soft) * (feather * 0.5)
        if self.matte_history is not None:
            if self.mode == "v2":
                # TAA 钳制边界取裁剪前 soft 的 3×3 min/max（对齐 WGSL matteRaw.r 邻域）。
                local_min = min3(soft)
                local_max = max3(soft)
                history = np.clip(self.matte_history, local_min, local_max)
                history_weight = self.p.matte_stab * 0.65 * (1 - motion)
            else:
                history = self.matte_history
                history_weight = self.p.matte_stab * 0.85 * (1 - motion)
            matte = matte * (1 - history_weight) + history * history_weight
        self.matte_history = matte
        return np.clip(matte, 0, 1)

    def despill(self, src: np.ndarray, alpha: np.ndarray, plate: np.ndarray | None) -> np.ndarray:
        if self.mode == "v1":
            color = src.copy()
            limit = (1 - self.p.despill_balance) * color[..., 0] + self.p.despill_balance * color[..., 2]
            spill = np.maximum(color[..., 1] - limit, 0) * self.p.despill_strength
            color[..., 1] -= spill
            color += spill[..., None] * self.p.luma_restore
            return color * alpha[..., None]
        background = plate if plate is not None else np.broadcast_to(np.asarray(self.p.key_color, np.float32), src.shape)
        d_key = float(cdiff(np.asarray(self.p.key_color, np.float32)[None, None], self.p.balance).item())
        if plate is not None:
            confidence = np.clip((cdiff(plate, self.p.balance) - 0.15 * d_key) / max(0.35 * d_key, 1e-4), 0, 1)
            fallback = np.broadcast_to(np.asarray(self.p.key_color, np.float32), src.shape)
            background = fallback * (1 - confidence[..., None]) + plate * confidence[..., None]
        transmission = np.minimum(1 - alpha, src[..., 1] / np.maximum(background[..., 1], 1e-4))
        fg_pre = np.maximum(src - transmission[..., None] * background, 0)
        fg_pre *= (alpha > 1e-4)[..., None]
        limit = (1 - self.p.despill_balance) * fg_pre[..., 0] + self.p.despill_balance * fg_pre[..., 2]
        spill = np.maximum(fg_pre[..., 1] - limit, 0) * self.p.despill_strength
        fg_pre[..., 1] -= spill
        fg_pre += spill[..., None] * self.p.luma_restore
        return np.maximum(fg_pre, 0)

    def process(self, src: np.ndarray, plate: np.ndarray | None, dynamic: bool = False) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        temporal, motion = self.denoise_temporal(src)
        dn = self.denoise_spatial(temporal)
        if dynamic:
            plate = self.estimate_dynamic_plate(dn)
        soft, raw = self.key(dn, plate)
        matte = self.matte_post(soft, raw, motion)
        foreground = self.despill(dn, matte, plate)
        return matte, foreground, raw, plate if plate is not None else np.broadcast_to(np.asarray(self.p.key_color), src.shape)


def mad(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(np.abs(a - b)))


def grad_error(a: np.ndarray, b: np.ndarray) -> float:
    ax = np.roll(a, -1, 1) - np.roll(a, 1, 1)
    ay = np.roll(a, -1, 0) - np.roll(a, 1, 0)
    bx = np.roll(b, -1, 1) - np.roll(b, 1, 1)
    by = np.roll(b, -1, 0) - np.roll(b, 1, 0)
    return float(np.mean(np.hypot(ax - bx, ay - by)))


def edge_sad(a: np.ndarray, gt: np.ndarray) -> float:
    edge = ((gt > 1 / 255) & (gt < 254 / 255)) | ((max3(gt) - min3(gt)) > 1 / 255)
    return float(np.mean(np.abs(a[edge] - gt[edge]))) if np.any(edge) else 0.0


def metrics(alpha: np.ndarray, gt: np.ndarray, fg: np.ndarray, gt_fg: np.ndarray) -> dict[str, float]:
    bg = gt <= 1 / 255
    core = gt >= 254 / 255
    return {
        "mad": mad(alpha, gt),
        "grad": grad_error(alpha, gt),
        "edge": edge_sad(alpha, gt),
        "fgErr": mad(fg, gt_fg),
        "bgResidue": float(np.mean(alpha[bg])) if np.any(bg) else 0.0,
        "coreLeak": float(np.mean(1 - alpha[core])) if np.any(core) else 0.0,
        "flicker": 0.0,
    }


def sample_key(src: np.ndarray) -> tuple[float, float, float]:
    return tuple(float(x) for x in np.mean(src[9:12, 9:12], axis=(0, 1)))


def run_suite(root: pathlib.Path, mode: str, params: Params, output_dir: pathlib.Path | None = None) -> dict[str, object]:
    manifest = json.loads((root / "manifest.json").read_text())
    cases = []
    for entry in manifest:
        keyer = RefKeyer(params, mode)
        frames = entry.get("frames", 1)
        inputs = [read_rgb(root / (f"{entry['id']}_f{i:02d}.input.png" if frames > 1 else f"{entry['id']}.input.png")) for i in range(frames)]
        keyer.p = replace(keyer.p, key_color=sample_key(inputs[0]))
        plate_path = root / f"{entry['id']}.plate.png"
        plate = read_rgb(plate_path) if entry.get("feed_plate", True) and plate_path.exists() else None
        pred_sequence = []
        gt_sequence = []
        result = None
        iterations = max(8, frames)
        for i in range(iterations):
            index = min(i, frames - 1)
            result = keyer.process(inputs[index], plate, bool(entry.get("dynamic_plate", False) and mode == "v2"))
            if frames > 1:
                pred_sequence.append(result[0].copy())
                gt_sequence.append(read_alpha(root / f"{entry['id']}_f{index:02d}.gt.png"))
        assert result is not None
        alpha, fg, raw, used_plate = result
        gt = read_alpha(root / f"{entry['id']}.gt.png")
        gt_fg = read_rgb(root / f"{entry['id']}.fgpre.png")
        row = {"id": entry["id"], **metrics(alpha, gt, fg, gt_fg)}
        if len(pred_sequence) > 1:
            diffs = [np.mean(np.abs((pred_sequence[i] - pred_sequence[i - 1]) - (gt_sequence[i] - gt_sequence[i - 1]))) for i in range(1, len(pred_sequence))]
            row["flicker"] = float(np.mean(diffs))
        cases.append(row)
        if output_dir is not None:
            output_dir.mkdir(parents=True, exist_ok=True)
            write_alpha(output_dir / f"{entry['id']}.matte.png", alpha)
            write_alpha(output_dir / f"{entry['id']}.raw.png", raw)
            write_rgb(output_dir / f"{entry['id']}.fgpre.png", fg)
            write_rgb(output_dir / f"{entry['id']}.plate.png", used_plate)
    keys = ("mad", "grad", "edge", "fgErr", "bgResidue", "coreLeak", "flicker")
    aggregate = {key: float(np.mean([case[key] for case in cases])) for key in keys}
    return {"version": 2, "source": f"numpy-ref-{mode}", "params": params.__dict__, "cases": cases, "aggregate": aggregate}


def scan_clips(root: pathlib.Path, base: Params) -> Params:
    best = None
    for black in (0.0, 0.005, 0.01, 0.015, 0.02, 0.03):
        for white in (0.82, 0.86, 0.90, 0.92, 0.95, 0.98):
            report = run_suite(root, "v2", replace(base, black_clip=black, white_clip=white, matte_stab=0.0))
            score = report["aggregate"]["mad"] + 0.5 * report["aggregate"]["edge"]
            # Gate on individual regressions instead of allowing the aggregate to hide one.
            worst = max(case["mad"] for case in report["cases"])
            candidate = (score + 0.1 * worst, black, white)
            if best is None or candidate < best:
                best = candidate
    assert best is not None
    return replace(base, black_clip=best[1], white_clip=best[2])


def evaluate_conditions(root: pathlib.Path, base: Params) -> dict[str, object]:
    variants = {
        "base": base,
        "refine": replace(base, refine=1.0),
        "guard": replace(base, guard=1.0),
        "refine_guard": replace(base, refine=1.0, guard=1.0),
    }
    result = {}
    for name, params in variants.items():
        report = run_suite(root, "v2", params)
        selected = {case["id"]: case for case in report["cases"] if case["id"] in ("case08_blonde", "case12_greenish")}
        result[name] = {"aggregate": report["aggregate"], "cases": selected}
    return result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--testset", type=pathlib.Path, default=pathlib.Path("testdata/keyer/testset"))
    ap.add_argument("--mode", choices=("v1", "v2"), default="v2")
    ap.add_argument("--report", type=pathlib.Path)
    ap.add_argument("--output-dir", type=pathlib.Path)
    ap.add_argument("--scan", action="store_true")
    ap.add_argument("--evaluate-conditions", action="store_true")
    args = ap.parse_args()
    params = Params()
    if args.mode == "v1":
        params = replace(params, black_clip=0.05, white_clip=0.95, feather=1.0, matte_stab=0.5)
    if args.scan:
        params = scan_clips(args.testset, params)
        print(json.dumps({"selected": params.__dict__}, indent=2))
    report = run_suite(args.testset, args.mode, params, args.output_dir)
    if args.evaluate_conditions:
        report["conditional_review"] = evaluate_conditions(args.testset, params)
    payload = json.dumps(report, indent=2)
    if args.report:
        args.report.write_text(payload + "\n")
        print(f"report -> {args.report}")
    else:
        print(payload)


if __name__ == "__main__":
    main()
