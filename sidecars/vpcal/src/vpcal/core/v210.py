"""v210 (10-bit YUV 4:2:2) unpacking and SMPTE BCD timecode parsing.

Pure-numpy synthetic layer for the DeckLink capture path (plan Phase 2a): the
C++ shim hands raw v210 row buffers across; the luma extraction and timecode
decode live here so they are unit-testable without a DeckLink SDK or card.

v210 layout (SMPTE / Blackmagic "10-bit YUV"): pixels are packed 6-to-a-16-byte
group as four little-endian 32-bit words, each word holding three 10-bit
components in bits 0–9, 10–19, 20–29:

    word 0:  Cb0  Y0   Cr0
    word 1:  Y1   Cb2  Y2
    word 2:  Cr2  Y3   Cb4
    word 3:  Y4   Cr4  Y5

Row stride is ``((width + 47) // 48) * 128`` bytes.
"""

from __future__ import annotations

import numpy as np


def v210_row_bytes(width: int) -> int:
    """Row stride in bytes for a v210 line of ``width`` pixels."""
    return ((width + 47) // 48) * 128


def v210_to_gray16(data: bytes | np.ndarray, width: int, height: int,
                   row_bytes: int | None = None) -> np.ndarray:
    """Extract the luma plane from a v210 buffer as left-aligned uint16.

    10-bit Y values are shifted left by 6 (``y << 6``) so downstream PNG
    writes preserve full precision in 16-bit files (precision red line #4).
    """
    stride = row_bytes if row_bytes is not None else v210_row_bytes(width)
    if stride % 16 != 0:
        raise ValueError(f"v210 row_bytes must be a multiple of 16, got {stride}")
    buf = np.frombuffer(data, dtype=np.uint8, count=stride * height)
    words = buf.reshape(height, stride // 4, 4).view(np.uint32).reshape(height, stride // 4)
    if words.shape[1] % 4 != 0:
        raise ValueError("v210 row does not contain a whole number of 4-word groups")
    groups = words.reshape(height, -1, 4)  # (h, n_groups, 4 words)
    # Luma positions per group: w0[10:20], w1[0:10], w1[20:30], w2[10:20],
    # w3[0:10], w3[20:30] → 6 Y samples.
    y = np.empty((height, groups.shape[1], 6), dtype=np.uint16)
    y[:, :, 0] = (groups[:, :, 0] >> 10) & 0x3FF
    y[:, :, 1] = groups[:, :, 1] & 0x3FF
    y[:, :, 2] = (groups[:, :, 1] >> 20) & 0x3FF
    y[:, :, 3] = (groups[:, :, 2] >> 10) & 0x3FF
    y[:, :, 4] = groups[:, :, 3] & 0x3FF
    y[:, :, 5] = (groups[:, :, 3] >> 20) & 0x3FF
    gray = y.reshape(height, -1)[:, :width]
    return (gray << 6).astype(np.uint16)


def gray10_to_v210(gray10: np.ndarray) -> bytes:
    """Pack a 10-bit luma plane into a v210 buffer (chroma = neutral 512).

    Test fixture generator — the inverse of :func:`v210_to_gray16` for
    synthetic round-trip tests (no SDK, no card).
    """
    if gray10.ndim != 2:
        raise ValueError("expected a 2-D luma plane")
    if gray10.max(initial=0) > 0x3FF:
        raise ValueError("luma values exceed 10 bits")
    h, w = gray10.shape
    stride = v210_row_bytes(w)
    n_groups = stride // 16
    y = np.zeros((h, n_groups * 6), dtype=np.uint32)
    y[:, :w] = gray10.astype(np.uint32)
    y = y.reshape(h, n_groups, 6)
    c = np.uint32(512)  # neutral chroma
    words = np.empty((h, n_groups, 4), dtype=np.uint32)
    words[:, :, 0] = c | (y[:, :, 0] << 10) | (c << 20)
    words[:, :, 1] = y[:, :, 1] | (c << 10) | (y[:, :, 2] << 20)
    words[:, :, 2] = c | (y[:, :, 3] << 10) | (c << 20)
    words[:, :, 3] = y[:, :, 4] | (c << 10) | (y[:, :, 5] << 20)
    return words.astype("<u4").tobytes()


def parse_bcd_timecode(bcd: int) -> str:
    """Decode a SMPTE ST 12 packed-BCD timecode word → ``HH:MM:SS:FF``.

    ``bcd`` is the 32-bit value as returned by DeckLink's
    ``IDeckLinkTimecode::GetBCD()``: bytes are hours/minutes/seconds/frames,
    two BCD digits each, with flag bits in the tens positions (drop-frame is
    bit 6 of the frames byte → ``;`` separator before frames).
    """
    frames_byte = bcd & 0xFF
    seconds_byte = (bcd >> 8) & 0xFF
    minutes_byte = (bcd >> 16) & 0xFF
    hours_byte = (bcd >> 24) & 0xFF
    drop = bool(frames_byte & 0x40)

    def digits(byte: int, tens_mask: int) -> int:
        tens = (byte >> 4) & tens_mask
        units = byte & 0x0F
        if units > 9:
            raise ValueError(f"invalid BCD digit in timecode byte 0x{byte:02X}")
        return tens * 10 + units

    hh = digits(hours_byte, 0x3)
    mm = digits(minutes_byte, 0x7)
    ss = digits(seconds_byte, 0x7)
    ff = digits(frames_byte, 0x3)
    sep = ";" if drop else ":"
    return f"{hh:02d}:{mm:02d}:{ss:02d}{sep}{ff:02d}"


__all__ = ["v210_row_bytes", "v210_to_gray16", "gray10_to_v210", "parse_bcd_timecode"]
