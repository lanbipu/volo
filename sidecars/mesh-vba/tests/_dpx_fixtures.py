"""Test-only: synthesize disguise-style 10-bit Method-A DPX frames.

Single source of truth for the DPX byte layout exercised by the SL DPX tests
(verified against a real disguise sample: LE magic XPDS, data offset 8192,
descriptor 50=RGB, bit depth 10, packing 1=Method A, R/G/B at bits 22/12/2,
2 pad bits at LSB). NOT part of the shipped package. Standalone: numpy + cv2
only (no lmt_vba_sidecar import) so it also runs as a CLI converter.
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

import cv2
import numpy as np

DPX_HEADER_SIZE = 8192  # disguise: pixel data starts at 0x2000

_SRC_EXTS = (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff")


def write_dpx(path, gray_u8, *, endian: str = "<") -> None:
    """Write an (H, W) uint8 grayscale image as a 10-bit RGB Method-A DPX
    (R=G=B=gray<<2). `endian` is "<" (LE, disguise default) or ">" (BE)."""
    assert endian in ("<", ">"), endian
    g = np.asarray(gray_u8)
    assert g.dtype == np.uint8 and g.ndim == 2, "gray_u8 must be (H, W) uint8"
    h, w = int(g.shape[0]), int(g.shape[1])

    v10 = g.astype(np.uint32) << 2  # 8-bit -> top 8 of 10 bits
    word = (v10 << 22) | (v10 << 12) | (v10 << 2)  # R/G/B slots, pad bits = LSB 0
    pixels = word.astype(endian + "u4").tobytes()

    hdr = bytearray(DPX_HEADER_SIZE)
    hdr[0:4] = b"XPDS" if endian == "<" else b"SDPX"
    struct.pack_into(endian + "I", hdr, 4, DPX_HEADER_SIZE)              # image data offset
    hdr[8:12] = b"V1.0"
    struct.pack_into(endian + "I", hdr, 24, DPX_HEADER_SIZE + len(pixels))  # total size (honest)
    struct.pack_into(endian + "H", hdr, 768, 0)                         # orientation
    struct.pack_into(endian + "H", hdr, 770, 1)                         # number of image elements
    struct.pack_into(endian + "I", hdr, 772, w)                         # PixelsPerLine
    struct.pack_into(endian + "I", hdr, 776, h)                         # LinesPerElement
    hdr[800] = 50                                                       # descriptor = RGB
    hdr[803] = 10                                                       # bit depth
    struct.pack_into(endian + "H", hdr, 804, 1)                         # packing = Method A
    struct.pack_into(endian + "H", hdr, 806, 0)                         # encoding = none
    struct.pack_into(endian + "I", hdr, 808, DPX_HEADER_SIZE)           # element data offset

    Path(path).write_bytes(bytes(hdr) + pixels)


def write_dpx10(path, gray_u10, *, endian: str = "<") -> None:
    """Write an (H, W) array of TRUE 10-bit values (0..1023, any int dtype) as a
    10-bit RGB Method-A DPX (R=G=B=v10). FIX-14 companion: lets tests exercise
    sub-8-bit gradations the 8-bit writer cannot express."""
    assert endian in ("<", ">"), endian
    g = np.asarray(gray_u10)
    assert g.ndim == 2 and int(g.max()) <= 1023 and int(g.min()) >= 0
    h, w = int(g.shape[0]), int(g.shape[1])
    v10 = g.astype(np.uint32)
    word = (v10 << 22) | (v10 << 12) | (v10 << 2)
    pixels = word.astype(endian + "u4").tobytes()
    hdr = bytearray(DPX_HEADER_SIZE)
    hdr[0:4] = b"XPDS" if endian == "<" else b"SDPX"
    struct.pack_into(endian + "I", hdr, 4, DPX_HEADER_SIZE)
    hdr[8:12] = b"V1.0"
    struct.pack_into(endian + "I", hdr, 24, DPX_HEADER_SIZE + len(pixels))
    struct.pack_into(endian + "H", hdr, 768, 0)
    struct.pack_into(endian + "H", hdr, 770, 1)
    struct.pack_into(endian + "I", hdr, 772, w)
    struct.pack_into(endian + "I", hdr, 776, h)
    hdr[800] = 50
    hdr[803] = 10
    struct.pack_into(endian + "H", hdr, 804, 1)
    struct.pack_into(endian + "H", hdr, 806, 0)
    struct.pack_into(endian + "I", hdr, 808, DPX_HEADER_SIZE)
    Path(path).write_bytes(bytes(hdr) + pixels)


def convert_dir_to_dpx(src_dir, dst_dir) -> int:
    """Read every image in src_dir (sorted) as grayscale and write a matching
    frameNNNN.dpx into dst_dir. Returns the count written."""
    src, dst = Path(src_dir), Path(dst_dir)
    dst.mkdir(parents=True, exist_ok=True)
    files = sorted(f for f in src.iterdir() if f.suffix.lower() in _SRC_EXTS)
    for i, f in enumerate(files):
        g = cv2.imread(str(f), cv2.IMREAD_GRAYSCALE)
        if g is None:
            raise ValueError(f"could not read {f}")
        write_dpx(dst / f"frame{i:04d}.dpx", g)
    return len(files)


if __name__ == "__main__":
    n = convert_dir_to_dpx(sys.argv[1], sys.argv[2])
    print(n)
