"""Gray-code frame-sequence tags for pattern playback sync (plan Phase 3b).

Pattern frames carry a corner tag encoding their sequence number so the
capture side can identify which pattern (and which polarity, normal vs
inverted) is currently displayed — the playback↔capture alignment stops
depending on file names or human bookkeeping (``c1-capture-service.md`` C1.3).

Tag format (one strip per corner, 4 copies for partial-view robustness)::

    [SYNC=1][SYNC=0][b7..b0 : 8 Gray-code data cells][PARITY]

- 11 square cells of ``cell_px`` pixels, laid out horizontally.
- SYNC pair provides the local white/black reference; on an *inverted*
  pattern frame every cell flips, so a decoded SYNC of (0, 1) simultaneously
  detects polarity — no separate signalling needed.
- Data cells carry ``gray_encode(frame_index)`` MSB-first (8 bits → 256
  frames per sequence, far above any VP-QSP pattern count).
- PARITY is the even parity of the 8 data bits.

The decoder here samples an axis-aligned (pixel-space) image — the direct
loopback / rectified case.  Camera-space decoding first rectifies via the
same contour machinery the VP-QSP detector uses, then calls this decoder;
until that lands, playback sync additionally rides the stdin
``pattern_shown`` acknowledgement (see ``cli/capture.py`` session command).
"""

from __future__ import annotations

import dataclasses

import numpy as np

TAG_DATA_BITS = 8
TAG_CELLS = 2 + TAG_DATA_BITS + 1  # sync pair + data + parity
CORNERS = ("tl", "tr", "bl", "br")


def gray_encode(n: int) -> int:
    return n ^ (n >> 1)


def gray_decode(g: int) -> int:
    n = 0
    while g:
        n ^= g
        g >>= 1
    return n


@dataclasses.dataclass
class DecodedTag:
    frame_index: int
    inverted: bool
    corner: str
    confidence: float  # sync-level separation, 0..1


def _tag_bits(frame_index: int) -> list[int]:
    if not 0 <= frame_index < (1 << TAG_DATA_BITS):
        raise ValueError(f"frame_index {frame_index} out of tag range 0..255")
    g = gray_encode(frame_index)
    data = [(g >> (TAG_DATA_BITS - 1 - i)) & 1 for i in range(TAG_DATA_BITS)]
    parity = sum(data) & 1
    return [1, 0, *data, parity]


def _corner_origin(shape: tuple[int, int], corner: str, cell_px: int, margin: int) -> tuple[int, int]:
    h, w = shape
    tag_w = TAG_CELLS * cell_px
    x0 = margin if corner in ("tl", "bl") else w - margin - tag_w
    y0 = margin if corner in ("tl", "tr") else h - margin - cell_px
    return y0, x0


def render_tags(img: np.ndarray, frame_index: int, *, cell_px: int = 24,
                margin: int = 8, lo: int | None = None, hi: int | None = None) -> np.ndarray:
    """Draw the frame tag into all four corners of ``img`` (in place, returned).

    ``lo``/``hi`` default to the dtype's black/white; pass pattern-specific
    levels if the pattern uses non-extreme values.
    """
    if img.ndim != 2:
        raise ValueError("expected a 2-D grayscale pattern image")
    white = hi if hi is not None else (255 if img.dtype == np.uint8 else 65535)
    black = lo if lo is not None else 0
    bits = _tag_bits(frame_index)
    for corner in CORNERS:
        y0, x0 = _corner_origin(img.shape[:2], corner, cell_px, margin)
        if y0 < 0 or x0 < 0:
            raise ValueError("image too small for tag layout")
        for i, bit in enumerate(bits):
            x = x0 + i * cell_px
            img[y0:y0 + cell_px, x:x + cell_px] = white if bit else black
    return img


def _sample_cells(img: np.ndarray, corner: str, cell_px: int, margin: int) -> np.ndarray | None:
    y0, x0 = _corner_origin(img.shape[:2], corner, cell_px, margin)
    if y0 < 0 or x0 < 0 or y0 + cell_px > img.shape[0] or x0 + TAG_CELLS * cell_px > img.shape[1]:
        return None
    # Sample the central half of each cell to tolerate mild misalignment/blur.
    q = cell_px // 4
    vals = np.empty(TAG_CELLS, dtype=np.float64)
    for i in range(TAG_CELLS):
        x = x0 + i * cell_px
        cell = img[y0 + q:y0 + cell_px - q, x + q:x + cell_px - q]
        vals[i] = float(cell.mean())
    return vals


def decode_tag(img: np.ndarray, *, cell_px: int = 24, margin: int = 8,
               min_separation: float = 0.15) -> DecodedTag | None:
    """Decode the frame tag from a pixel-aligned grayscale image.

    Tries each corner; returns the first decode whose parity checks and whose
    sync-level separation exceeds ``min_separation`` (fraction of dtype range).
    Returns ``None`` when no corner yields a valid tag.
    """
    if img.ndim != 2:
        raise ValueError("expected a 2-D grayscale image")
    full = 255.0 if img.dtype == np.uint8 else 65535.0
    for corner in CORNERS:
        vals = _sample_cells(img, corner, cell_px, margin)
        if vals is None:
            continue
        sync_a, sync_b = vals[0], vals[1]
        separation = abs(sync_a - sync_b) / full
        if separation < min_separation:
            continue
        inverted = bool(sync_a < sync_b)  # normal frames render SYNC as (white, black)
        threshold = (sync_a + sync_b) / 2.0
        raw = [1 if v > threshold else 0 for v in vals[2:]]
        if inverted:
            raw = [1 - b for b in raw]
        data, parity = raw[:TAG_DATA_BITS], raw[TAG_DATA_BITS]
        if (sum(data) & 1) != parity:
            continue
        g = 0
        for b in data:
            g = (g << 1) | b
        return DecodedTag(frame_index=gray_decode(g), inverted=inverted,
                          corner=corner, confidence=float(separation))
    return None


__all__ = ["TAG_DATA_BITS", "TAG_CELLS", "CORNERS", "DecodedTag",
           "gray_encode", "gray_decode", "render_tags", "decode_tag"]
