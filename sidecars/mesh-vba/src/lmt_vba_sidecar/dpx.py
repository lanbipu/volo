"""Read disguise 10-bit Method-A DPX frames -> 10-bit grayscale (uint16, 0..1023).

Pure numpy + cv2 (no extra deps, PyInstaller-safe, no runtime ffmpeg). Scoped to
the disguise variant verified against a real sample; raises ValueError on anything
else rather than silently misdecoding. Unpack formula verified pixel-exact vs
ffmpeg: R=(w>>22)&0x3FF, G=(w>>12)&0x3FF, B=(w>>2)&0x3FF (2 pad bits at LSB).

FIX-14: the old reader truncated to 8-bit with `>>2` — TRUNCATION (not
rounding), a systematic ~3/1023 downward bias, and a 4x quantisation step that
threw away the precision the SL centroid weighting feeds on. The full 10 bits
are now preserved (luma in float, rounded to uint16); the transfer
characteristic header byte (offset 801) is validated — anything other than
user-defined(0)/linear(2) (e.g. logarithmic) raises ValueError per this file's
"unsupported variants must fail loud" contract.
"""
from __future__ import annotations

import struct
from pathlib import Path

import cv2
import numpy as np

_DESCRIPTOR_RGB = 50
_PACKING_METHOD_A = 1
_ENCODING_NONE = 0
_BIT_DEPTH = 10
_TRANSFER_USER_DEFINED = 0
_TRANSFER_LINEAR = 2
_MIN_HEADER = 812  # last field we read is element data offset at 808..812


def read_dpx_gray10(path) -> np.ndarray:
    """Return an (H, W) uint16 grayscale frame (full 10-bit range, 0..1023) from
    a disguise 10-bit RGB Method-A DPX. Raises ValueError on any non-disguise
    variant (including non-linear transfer characteristics) or truncation."""
    raw = Path(path).read_bytes()
    if len(raw) < _MIN_HEADER:
        raise ValueError(f"{path}: file too small to be a DPX ({len(raw)} bytes)")

    magic = raw[:4]
    if magic == b"XPDS":
        end = "<"
    elif magic == b"SDPX":
        end = ">"
    else:
        raise ValueError(f"{path}: not a DPX (magic {magic!r})")

    data_off = struct.unpack_from(end + "I", raw, 4)[0]
    width = struct.unpack_from(end + "I", raw, 772)[0]
    height = struct.unpack_from(end + "I", raw, 776)[0]
    descriptor = raw[800]
    transfer = raw[801]
    bit_depth = raw[803]
    packing = struct.unpack_from(end + "H", raw, 804)[0]
    encoding = struct.unpack_from(end + "H", raw, 806)[0]

    if bit_depth != _BIT_DEPTH:
        raise ValueError(f"{path}: unsupported DPX bit depth {bit_depth} (only 10 supported)")
    if descriptor != _DESCRIPTOR_RGB:
        raise ValueError(f"{path}: unsupported DPX descriptor {descriptor} (only 50=RGB supported)")
    if transfer not in (_TRANSFER_USER_DEFINED, _TRANSFER_LINEAR):
        raise ValueError(
            f"{path}: unsupported DPX transfer characteristic {transfer} "
            f"(only 0=user-defined / 2=linear supported; log-encoded DPX would "
            f"silently corrupt SL intensity centroids)")
    if packing != _PACKING_METHOD_A:
        raise ValueError(f"{path}: unsupported DPX packing {packing} (only 1=Method A supported)")
    if encoding != _ENCODING_NONE:
        raise ValueError(f"{path}: RLE-encoded DPX not supported (encoding={encoding})")
    if width == 0 or height == 0:
        raise ValueError(f"{path}: bad DPX dimensions {width}x{height}")

    need = width * height * 4  # Method A: one 32-bit word per RGB pixel
    if len(raw) < data_off + need:
        raise ValueError(
            f"{path}: truncated DPX pixel data (need {data_off + need} bytes, have {len(raw)})"
        )

    words = np.frombuffer(raw[data_off:data_off + need], dtype=end + "u4").reshape(height, width)
    r = ((words >> 22) & 0x3FF).astype(np.float64)
    g = ((words >> 12) & 0x3FF).astype(np.float64)
    b = ((words >> 2) & 0x3FF).astype(np.float64)
    # BT.601 luma (same weights cv2 uses for IMREAD_GRAYSCALE), full 10-bit.
    luma = 0.299 * r + 0.587 * g + 0.114 * b
    return np.clip(np.round(luma), 0, 1023).astype(np.uint16)
