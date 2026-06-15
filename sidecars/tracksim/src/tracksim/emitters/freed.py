from dataclasses import dataclass

from tracksim.domain.pose import CameraPose
from tracksim.ports.transport import Transport


@dataclass
class FreeDScaling:
    variant: str = "native"
    angle_lsb_per_deg: float = 32768.0
    pos_lsb_per_m: float = 64000.0
    # zoom/focus 是 24-bit 原始镜头编码器值，由 pose 的镜头字段线性映射而来：
    #   zoom_raw  = round(pose.focal_length[mm] * zoom_lsb_per_mm)
    #   focus_raw = round(pose.focus_distance[m] * focus_lsb_per_m)
    # 默认值是「能动起来」的标定起点，需对着接收端（Unreal/Disguise 的镜头标定表）微调；
    # 设为 0 即关闭该字段（恒发 0），保留旧行为。
    zoom_lsb_per_mm: float = 1000.0
    focus_lsb_per_m: float = 1000.0


def _pack_s24(value: int) -> bytes:
    """Pack a signed integer as 24-bit two's-complement big-endian."""
    v = int(value) & 0xFFFFFF
    return bytes([(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF])


def _pack_u24(value: int) -> bytes:
    """Pack an unsigned integer as 24-bit big-endian."""
    v = int(value) & 0xFFFFFF
    return bytes([(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF])


def encode_d1(pose: CameraPose, *, camera_id: int, scaling: FreeDScaling) -> bytes:
    """Encode a CameraPose as a 29-byte FreeD type-0xD1 message.

    Layout (Vinten free-d v1.0, Appendix A.3.2 / Appendix B):
      [0]   0xD1 message type
      [1]   camera id
      [2:5]   pan  (24-bit signed, 1/angle_lsb_per_deg degree)
      [5:8]   tilt
      [8:11]  roll
      [11:14] X-position (24-bit signed, 1/pos_lsb_per_m metre)
      [14:17] Y-position
      [17:20] Z-position (height)
      [20:23] zoom  (24-bit unsigned raw, = focal_length * zoom_lsb_per_mm, saturated to u24)
      [23:26] focus (24-bit unsigned raw, = focus_distance * focus_lsb_per_m, saturated to u24)
      [26:28] spare (16 bits)
      [28]    checksum = (0x40 - sum(first 28 bytes)) & 0xFF
    """
    body = bytearray()
    body.append(0xD1)
    body.append(camera_id & 0xFF)
    body += _pack_s24(round(pose.pan * scaling.angle_lsb_per_deg))
    body += _pack_s24(round(pose.tilt * scaling.angle_lsb_per_deg))
    body += _pack_s24(round(pose.roll * scaling.angle_lsb_per_deg))
    body += _pack_s24(round(pose.x * scaling.pos_lsb_per_m))
    body += _pack_s24(round(pose.y * scaling.pos_lsb_per_m))
    body += _pack_s24(round(pose.z * scaling.pos_lsb_per_m))
    zoom_raw = min(0xFFFFFF, max(0, round(pose.focal_length * scaling.zoom_lsb_per_mm)))
    focus_raw = min(0xFFFFFF, max(0, round(pose.focus_distance * scaling.focus_lsb_per_m)))
    body += _pack_u24(zoom_raw)
    body += _pack_u24(focus_raw)
    body += b"\x00\x00"  # spare
    checksum = (0x40 - sum(body)) & 0xFF
    body.append(checksum)
    return bytes(body)


class FreeDEmitter:
    name = "freed"

    def __init__(
        self,
        transport: Transport,
        *,
        camera_id: int = 0,
        scaling: FreeDScaling | None = None,
    ) -> None:
        self._transport = transport
        self._camera_id = camera_id
        if scaling is None:
            scaling = FreeDScaling()
        self._scaling = scaling

    def emit(self, pose: CameraPose) -> None:
        self._transport.send(
            encode_d1(pose, camera_id=self._camera_id, scaling=self._scaling)
        )

    def close(self) -> None:
        self._transport.close()
