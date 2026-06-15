"""FreeD D1 protocol codec (remediation C1.1).

Self-contained decoder for the FreeD ``0xD1`` camera-tracking datagram (29 bytes,
big-endian 24-bit fixed-point) — the common on-set tracking wire format.  Matches
the canonical layout (angle 32768 LSB/deg, position 64000 LSB/m, checksum
``(0x40 - Σ first 28 bytes) & 0xFF``).  An encoder is provided for tests/loopback.

Decoded units: pan/tilt/roll in **degrees**, x/y/z in **metres** (callers convert
to vpcal's internal mm).
"""

from __future__ import annotations

from dataclasses import dataclass

ANGLE_LSB_PER_DEG = 32768.0
POS_LSB_PER_M = 64000.0
FREED_D1_LEN = 29


@dataclass
class FreeDPose:
    camera_id: int
    pan: float
    tilt: float
    roll: float
    x: float  # metres
    y: float
    z: float
    zoom_raw: int
    focus_raw: int


def _pack_s24(v: int) -> bytes:
    v &= 0xFFFFFF
    return bytes([(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF])


def _unpack_s24(buf: bytes) -> int:
    v = (buf[0] << 16) | (buf[1] << 8) | buf[2]
    if v & 0x800000:
        v -= 0x1000000
    return v


def _checksum(body: bytes) -> int:
    return (0x40 - sum(body)) & 0xFF


def decode_freed_d1(data: bytes) -> FreeDPose:
    """Decode a 29-byte FreeD D1 datagram. Raises ValueError on malformed input."""
    if len(data) != FREED_D1_LEN:
        raise ValueError(f"FreeD packet must be {FREED_D1_LEN} bytes, got {len(data)}")
    if data[0] != 0xD1:
        raise ValueError(f"unsupported FreeD message type: 0x{data[0]:02X}")
    if _checksum(data[:28]) != data[28]:
        raise ValueError("FreeD checksum mismatch")
    return FreeDPose(
        camera_id=data[1],
        pan=_unpack_s24(data[2:5]) / ANGLE_LSB_PER_DEG,
        tilt=_unpack_s24(data[5:8]) / ANGLE_LSB_PER_DEG,
        roll=_unpack_s24(data[8:11]) / ANGLE_LSB_PER_DEG,
        x=_unpack_s24(data[11:14]) / POS_LSB_PER_M,
        y=_unpack_s24(data[14:17]) / POS_LSB_PER_M,
        z=_unpack_s24(data[17:20]) / POS_LSB_PER_M,
        zoom_raw=(data[20] << 16) | (data[21] << 8) | data[22],
        focus_raw=(data[23] << 16) | (data[24] << 8) | data[25],
    )


def encode_freed_d1(pose: FreeDPose) -> bytes:
    """Encode a :class:`FreeDPose` to a 29-byte D1 datagram (for tests/loopback)."""
    body = bytes([0xD1, pose.camera_id & 0xFF])
    body += _pack_s24(round(pose.pan * ANGLE_LSB_PER_DEG))
    body += _pack_s24(round(pose.tilt * ANGLE_LSB_PER_DEG))
    body += _pack_s24(round(pose.roll * ANGLE_LSB_PER_DEG))
    body += _pack_s24(round(pose.x * POS_LSB_PER_M))
    body += _pack_s24(round(pose.y * POS_LSB_PER_M))
    body += _pack_s24(round(pose.z * POS_LSB_PER_M))
    body += bytes([(pose.zoom_raw >> 16) & 0xFF, (pose.zoom_raw >> 8) & 0xFF, pose.zoom_raw & 0xFF])
    body += bytes([(pose.focus_raw >> 16) & 0xFF, (pose.focus_raw >> 8) & 0xFF, pose.focus_raw & 0xFF])
    body += bytes([0x00, 0x00])  # spare
    return body + bytes([_checksum(body)])
