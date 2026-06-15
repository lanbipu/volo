"""OpenCV-free shared helpers for the structured-light dot codec.

A dot's identity is carried in TIME (its on/off blink sequence), not appearance.
Each id is `data_bits` little-endian binary bits + one trailing even-parity bit.
The all-off codeword (id=0) is legal: the decoder seeds dot locations from a
full-on ANCHOR frame, so a dot dark in every code frame is still found.
"""
from __future__ import annotations

import math


def data_bits_for(n_dots: int) -> int:
    if n_dots <= 1:
        return 1
    return max(1, math.ceil(math.log2(n_dots)))


def even_parity(bits: list[int]) -> int:
    return sum(bits) & 1


def encode_id(dot_id: int, data_bits: int) -> list[int]:
    bits = [(dot_id >> b) & 1 for b in range(data_bits)]
    bits.append(even_parity(bits))
    return bits


def decode_bits(bits: list[int], data_bits: int) -> int | None:
    if len(bits) != data_bits + 1:
        return None
    data = bits[:data_bits]
    if even_parity(data) != bits[-1]:
        return None
    return sum(b << i for i, b in enumerate(data))


def build_dots_in_rect(*, rect: tuple[int, int, int, int], spacing_px: int,
                       margin_px: int, id_start: int) -> list[tuple[int, int, int]]:
    """Row-major dot centers inside one cabinet's placement rect [x,y,w,h],
    inset by margin_px. Returns [(id, u, v), ...] with ids from id_start."""
    x, y, w, h = rect
    us = list(range(x + margin_px, x + w - margin_px + 1, spacing_px))
    vs = list(range(y + margin_px, y + h - margin_px + 1, spacing_px))
    dots: list[tuple[int, int, int]] = []
    i = id_start
    for v in vs:
        for u in us:
            dots.append((i, u, v))
            i += 1
    return dots
