from __future__ import annotations

import json
import struct
from typing import Any

from tracksim.checksum import fletcher16
from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.emitters.freed import FreeDScaling
from tracksim.emitters.opentrackio import (
    ENCODING_CBOR,
    ENCODING_JSON,
    OTRK_HEADER_LENGTH,
    OTRK_IDENTIFIER,
)


def _unpack_s24(buf: bytes) -> int:
    v = (buf[0] << 16) | (buf[1] << 8) | buf[2]
    if v & 0x800000:
        v -= 0x1000000
    return v


def freed_decode(data: bytes, *, scaling: FreeDScaling = FreeDScaling()) -> tuple[str, dict[str, Any]]:
    if len(data) != 29:
        raise InvalidTrajectoryError(
            f"FreeD packet must be 29 bytes, got {len(data)}",
            details={"length": len(data)},
        )
    if data[0] != 0xD1:
        raise InvalidTrajectoryError(
            f"unsupported FreeD message type: 0x{data[0]:02X}",
            details={"message_type": data[0]},
        )
    expected = (0x40 - sum(data[:28])) & 0xFF
    checksum_valid = expected == data[28]
    if not checksum_valid:
        raise InvalidTrajectoryError(
            "FreeD checksum mismatch",
            details={"expected": expected, "actual": data[28]},
        )
    result = {
        "message_type": "0xD1",
        "camera_id": data[1],
        "pan": _unpack_s24(data[2:5]) / scaling.angle_lsb_per_deg,
        "tilt": _unpack_s24(data[5:8]) / scaling.angle_lsb_per_deg,
        "roll": _unpack_s24(data[8:11]) / scaling.angle_lsb_per_deg,
        "x": _unpack_s24(data[11:14]) / scaling.pos_lsb_per_m,
        "y": _unpack_s24(data[14:17]) / scaling.pos_lsb_per_m,
        "z": _unpack_s24(data[17:20]) / scaling.pos_lsb_per_m,
        "zoom_raw": (data[20] << 16) | (data[21] << 8) | data[22],
        "focus_raw": (data[23] << 16) | (data[24] << 8) | data[25],
        "checksum_valid": checksum_valid,
    }
    return "freed.decode", result


def opentrackio_decode(data: bytes) -> tuple[str, dict[str, Any]]:
    if len(data) < OTRK_HEADER_LENGTH:
        raise InvalidTrajectoryError(
            f"OpenTrackIO packet too short: {len(data)} bytes",
            details={"length": len(data)},
        )
    if data[0:4] != OTRK_IDENTIFIER:
        raise InvalidTrajectoryError(
            "OpenTrackIO identifier mismatch",
            details={"identifier": data[0:4].hex()},
        )
    encoding = data[5]
    sequence = struct.unpack("!H", data[6:8])[0]
    offset = struct.unpack("!I", data[8:12])[0]
    l_and_len = struct.unpack("!H", data[12:14])[0]
    last_segment = bool(l_and_len >> 15)
    payload_length = l_and_len & 0x7FFF
    expected_total = OTRK_HEADER_LENGTH + payload_length
    if len(data) != expected_total:
        raise InvalidTrajectoryError(
            f"OpenTrackIO datagram length mismatch: header claims {payload_length} payload bytes "
            f"but got {len(data) - OTRK_HEADER_LENGTH} (total {len(data)} vs expected {expected_total})",
            details={"claimed_payload_length": payload_length, "actual_total": len(data), "expected_total": expected_total},
        )
    stored_checksum = struct.unpack("!H", data[14:16])[0]
    payload = data[OTRK_HEADER_LENGTH : OTRK_HEADER_LENGTH + payload_length]
    computed = fletcher16(data[0:14] + payload)
    checksum_valid = computed == stored_checksum
    if not checksum_valid:
        raise InvalidTrajectoryError(
            "OpenTrackIO fletcher16 checksum mismatch",
            details={"expected": stored_checksum, "actual": computed},
        )
    if encoding not in (ENCODING_JSON, ENCODING_CBOR):
        raise InvalidTrajectoryError(
            f"unsupported OpenTrackIO encoding byte: 0x{encoding:02X}",
            details={"encoding": encoding},
        )
    if encoding == ENCODING_CBOR:
        import cbor2

        try:
            sample = cbor2.loads(payload)
        except Exception as exc:
            raise InvalidTrajectoryError(
                f"failed to decode CBOR payload: {exc}",
                details={"error": str(exc)},
            ) from exc
        encoding_name = "cbor"
    else:
        try:
            sample = json.loads(payload.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise InvalidTrajectoryError(
                f"failed to decode JSON payload: {exc}",
                details={"error": str(exc)},
            ) from exc
        encoding_name = "json"
    return "opentrackio.decode", {
        "encoding": encoding_name,
        "sequence": sequence,
        "segment_offset": offset,
        "last_segment": last_segment,
        "checksum_valid": checksum_valid,
        "sample": sample,
    }
