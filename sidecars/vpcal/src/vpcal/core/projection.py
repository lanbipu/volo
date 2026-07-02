"""Brown-Conrady camera projection model (spec §5.5).

Pixel convention: origin at the top-left, ``(0, 0)`` is the centre of the first
pixel, ``u`` increases right, ``v`` increases down — identical to OpenCV.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

Array = NDArray[np.float64]


@dataclass(frozen=True)
class CameraIntrinsics:
    """Camera intrinsics (pixels) + Brown-Conrady distortion coefficients."""

    fx: float
    fy: float
    cx: float
    cy: float
    k1: float = 0.0
    k2: float = 0.0
    k3: float = 0.0
    p1: float = 0.0
    p2: float = 0.0
    width: float = 0.0
    height: float = 0.0
    """Image dimensions (px).  0 means unknown → callers fall back to 2·cx/2·cy,
    which is only correct when the principal point is centred."""
    entrance_pupil_offset_mm: float = 0.0
    """Fixed shift along the camera-frame optical axis (architecture §4.3), applied
    before the perspective divide.  0.0 (default) reproduces pre-W8 behaviour
    exactly.  See :attr:`vpcal.models.lens.LensProfile.entrance_pupil_offset_mm`."""

    @classmethod
    def from_lens(cls, lens) -> "CameraIntrinsics":  # type: ignore[no-untyped-def]
        """Build from a :class:`vpcal.models.lens.LensProfile`."""
        d = lens.distortion
        return cls(
            fx=lens.fx,
            fy=lens.fy,
            cx=lens.cx,
            cy=lens.cy,
            k1=d.k1,
            k2=d.k2,
            k3=d.k3,
            p1=d.p1,
            p2=d.p2,
            width=float(lens.image_width_px),
            height=float(lens.image_height_px),
            entrance_pupil_offset_mm=lens.entrance_pupil_offset_mm or 0.0,
        )

    @property
    def image_size(self) -> tuple[float, float]:
        """(width, height) in px; falls back to 2·cx/2·cy if dimensions unset."""
        return (self.width or 2.0 * self.cx, self.height or 2.0 * self.cy)


def distort_normalized(xn: Array, yn: Array, intr: CameraIntrinsics) -> tuple[Array, Array]:
    """Apply Brown-Conrady distortion to normalised image coordinates."""
    r2 = xn * xn + yn * yn
    radial = 1.0 + r2 * (intr.k1 + r2 * (intr.k2 + r2 * intr.k3))
    xd = xn * radial + 2.0 * intr.p1 * xn * yn + intr.p2 * (r2 + 2.0 * xn * xn)
    yd = yn * radial + intr.p1 * (r2 + 2.0 * yn * yn) + 2.0 * intr.p2 * xn * yn
    return xd, yd


def project_points(points_cam: Array, intr: CameraIntrinsics) -> Array:
    """Project camera-frame points to pixels.

    ``points_cam`` is ``(N, 3)`` in the OpenCV camera frame (nominal reference
    plane, i.e. the ``T_C_from_B`` origin); returns ``(N, 2)`` pixel
    coordinates.  Points with ``Z <= 0`` are behind the camera; their pixels
    are still computed (the caller decides whether to cull).

    When ``intr.entrance_pupil_offset_mm`` is non-zero, the point is shifted
    along the optical axis (Z) before the perspective divide, matching
    OpenLensIO eq. (1): ``z_p = z - z_epd`` (transverse entrance-pupil offsets
    are assumed negligible, per spec).  X/Y are unaffected.
    """
    pts = np.atleast_2d(np.asarray(points_cam, dtype=np.float64))
    z = pts[:, 2] - intr.entrance_pupil_offset_mm
    # Z<=0 (behind/at camera) yields inf/NaN; keep the whole computation under
    # errstate so the non-finite arithmetic doesn't leak RuntimeWarnings.
    with np.errstate(divide="ignore", invalid="ignore"):
        xn = pts[:, 0] / z
        yn = pts[:, 1] / z
        xd, yd = distort_normalized(xn, yn, intr)
        u = intr.fx * xd + intr.cx
        v = intr.fy * yd + intr.cy
    return np.column_stack([u, v])


def project_point(point_cam: Array, intr: CameraIntrinsics) -> Array:
    """Project a single camera-frame point to a ``(2,)`` pixel coordinate."""
    return project_points(np.asarray(point_cam, dtype=np.float64).reshape(1, 3), intr)[0]


def unproject_pixel(uv: Array, intr: CameraIntrinsics, *, iterations: int = 20) -> Array:
    """Invert the projection: pixel → unit-depth normalised ray ``(xn, yn, 1)``.

    Iteratively removes Brown-Conrady distortion (fixed-point), matching the
    OpenCV ``undistortPoints`` approach.  Returns the normalised undistorted
    coordinates with ``z = 1``.
    """
    uv = np.asarray(uv, dtype=np.float64).reshape(2)
    xd = (uv[0] - intr.cx) / intr.fx
    yd = (uv[1] - intr.cy) / intr.fy
    xn, yn = xd, yd
    for _ in range(iterations):
        r2 = xn * xn + yn * yn
        radial = 1.0 + r2 * (intr.k1 + r2 * (intr.k2 + r2 * intr.k3))
        dx = 2.0 * intr.p1 * xn * yn + intr.p2 * (r2 + 2.0 * xn * xn)
        dy = intr.p1 * (r2 + 2.0 * yn * yn) + 2.0 * intr.p2 * xn * yn
        xn = (xd - dx) / radial
        yn = (yd - dy) / radial
    return np.array([xn, yn, 1.0], dtype=np.float64)
