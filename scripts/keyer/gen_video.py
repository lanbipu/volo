#!/usr/bin/env python3
"""Stream deterministic 1080p60 Keyer footage as rgb24 for ffmpeg.

The composite is formed in scene-linear light, then encoded to sRGB.  This is
the v2 replacement for the old gamma-domain synthetic video.
"""

import cv2
import numpy as np
import sys

W, H, FPS, SEC = 1920, 1080, 60, 10
rng = np.random.default_rng(7)


def srgb_to_linear(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(x):
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1.0 / 2.4) - 0.055)


y, x = np.mgrid[0:H, 0:W]
gain = 0.6 + 0.5 * np.exp(-(((x - W * 0.4) / (W * 0.5)) ** 2 + ((y - H * 0.45) / (H * 0.5)) ** 2))
wrinkle = 1 + 0.08 * np.sin(x / 37.0) * np.sin(y / 53.0 + 1.3)
screen_srgb = np.clip((np.full((H, W, 3), (30, 160, 40), np.float32) / 255) * (gain * wrinkle)[..., None], 0, 1)
screen_linear = srgb_to_linear(screen_srgb)
hairs = [(rng.uniform(0, 2 * np.pi), rng.uniform(15, 130), rng.normal(0, 0.08), rng.uniform(0.3, 1.0)) for _ in range(800)]


def frame_alpha_fg(t):
    alpha = np.zeros((H, W), np.float32)
    cx = int(W / 2 + 260 * np.sin(t * 0.9))
    cy = int(H / 2 - 60 + 40 * np.sin(t * 2.3))
    cv2.circle(alpha, (cx, cy), 170, 1.0, -1)
    cv2.rectangle(alpha, (cx - 130, cy + 150), (cx + 130, H), 1.0, -1)
    alpha = cv2.GaussianBlur(alpha, (0, 0), 1.5)
    for th0, length, dth, opacity in hairs:
        th = th0 + 0.15 * np.sin(t * 3 + th0 * 5)
        p0 = (int(cx + 170 * np.cos(th)), int(cy + 170 * np.sin(th)))
        p1 = (int(cx + (170 + length) * np.cos(th + dth)), int(cy + (170 + length) * np.sin(th + dth)))
        cv2.line(alpha, p0, p1, opacity, 1, cv2.LINE_AA)
    fg_srgb = np.full((H, W, 3), (60, 45, 40), np.float32) / 255
    face = np.zeros((H, W), np.float32)
    cv2.circle(face, (cx, cy), 140, 1.0, -1)
    face = cv2.GaussianBlur(face, (0, 0), 8)
    fg_srgb = fg_srgb * (1 - face[..., None]) + (np.array((205, 165, 140), np.float32) / 255) * face[..., None]
    bx = int(W * 0.22 + 60 * np.sin(t * 1.4))
    bottle_alpha = np.zeros((H, W), np.float32)
    cv2.rectangle(bottle_alpha, (bx - 60, H // 2 - 180), (bx + 60, H // 2 + 180), 1.0, -1)
    bottle_alpha[H // 2 - 180:H // 2 + 180, bx - 60:bx + 60] *= np.linspace(0.15, 0.5, 360)[:, None]
    cv2.line(bottle_alpha, (bx - 35, H // 2 - 170), (bx - 35, H // 2 + 170), 1.0, 6, cv2.LINE_AA)
    fg_srgb = np.where(bottle_alpha[..., None] > alpha[..., None], np.full((H, W, 3), (210, 215, 220), np.float32) / 255, fg_srgb)
    alpha = np.maximum(alpha, bottle_alpha)
    fg_linear = srgb_to_linear(fg_srgb)
    fg_linear[..., 1] += (1 - alpha) * 0.12 * (alpha > 0.02)
    return np.clip(fg_linear, 0, 1), np.clip(alpha, 0, 1)


out = sys.stdout.buffer
for frame in range(FPS * SEC):
    fg_linear, alpha = frame_alpha_fg(frame / FPS)
    composite_linear = fg_linear * alpha[..., None] + screen_linear * (1 - alpha[..., None])
    composite_linear += rng.normal(0, 1.5 / 255, composite_linear.shape)
    out.write(np.round(linear_to_srgb(composite_linear) * 255).astype(np.uint8).tobytes())
