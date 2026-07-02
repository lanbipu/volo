"""Physical marker detection front-end (AR mode, plan Phase A2).

Detects ArUco / AprilTag markers with ``cv2.aruco`` (OpenCV >= 4.7 keeps
aruco in the main module; the pinned dependency is >= 4.8) and refines the
quad corners with ``cornerSubPix``.  Output is the same
:class:`~vpcal.core.observations.Detection` shape as the VP-QSP detector —
one detection per tag corner, identified by
:class:`~vpcal.core.observations.PhysicalMarkerId` — so the downstream
solve / QA pipeline is unchanged.

Markers detected but absent from the map are counted as warnings (never
enter the solve); map markers never detected surface in the coverage report.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
from numpy.typing import NDArray

from vpcal.core.errors import ConfigError
from vpcal.core.observations import Detection, PhysicalMarkerId
from vpcal.models.marker_map import MarkerMapDefinition

Array = NDArray[np.float64]


@dataclass
class PhysicalDetectorConfig:
    subpix_window: int = 5
    """Half-size (px) of the cornerSubPix search window."""
    subpix_iterations: int = 30
    subpix_epsilon: float = 0.01


def resolve_dictionary(name: str):
    """``"DICT_APRILTAG_36h11"`` → the cv2.aruco predefined dictionary.

    Availability is checked at call time (plan §9 unverified item #2): an
    unknown name raises :class:`ConfigError` listing the valid options.
    """
    attr = getattr(cv2.aruco, name, None)
    if attr is None:
        valid = sorted(n for n in dir(cv2.aruco) if n.startswith("DICT_"))
        raise ConfigError(
            f"unknown aruco dictionary {name!r} in this OpenCV build "
            f"(cv2 {cv2.__version__})",
            details={"available": valid},
        )
    return cv2.aruco.getPredefinedDictionary(attr)


def _tag_lookup(marker_map: MarkerMapDefinition) -> dict[str, dict[int, str]]:
    """dictionary name → {numeric tag id → marker_id} for detectable markers."""
    lookup: dict[str, dict[int, str]] = {}
    for m in marker_map.detectable_markers():
        if m.dictionary is None:
            continue
        tag = m.resolved_tag_id()
        if tag is None:
            continue
        lookup.setdefault(m.dictionary, {})[tag] = m.marker_id
    return lookup


def detect_physical_markers(
    image: NDArray[np.uint8],
    marker_map: MarkerMapDefinition,
    *,
    frame_id: int = 0,
    config: PhysicalDetectorConfig | None = None,
) -> tuple[list[Detection], dict]:
    """Detect the map's ArUco/AprilTag markers in one grayscale image.

    Returns ``(detections, counters)``: one :class:`Detection` per corner of
    each matched marker (corner order TL, TR, BR, BL in the tag's canonical
    orientation — matching ``SurveyedMarker.resolved_corners``), plus counters
    for QA (``detected_markers`` / ``unknown_markers``).
    """
    cfg = config or PhysicalDetectorConfig()
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = gray.astype(np.uint8)

    detections: list[Detection] = []
    detected = 0
    unknown = 0
    for dict_name, tag_to_id in _tag_lookup(marker_map).items():
        dictionary = resolve_dictionary(dict_name)
        params = cv2.aruco.DetectorParameters()
        params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
        params.cornerRefinementWinSize = cfg.subpix_window
        params.cornerRefinementMaxIterations = cfg.subpix_iterations
        params.cornerRefinementMinAccuracy = cfg.subpix_epsilon
        detector = cv2.aruco.ArucoDetector(dictionary, params)
        corners, ids, _rejected = detector.detectMarkers(gray)
        if ids is None:
            continue
        for quad, tag in zip(corners, ids.ravel()):
            marker_id = tag_to_id.get(int(tag))
            if marker_id is None:
                unknown += 1
                continue
            detected += 1
            pts = quad.reshape(4, 2).astype(np.float64)
            for k in range(4):
                detections.append(
                    Detection(
                        frame_id=frame_id,
                        marker_id=PhysicalMarkerId(marker_id, k),
                        pixel_u=float(pts[k, 0]),
                        pixel_v=float(pts[k, 1]),
                    )
                )
    counters = {"detected_markers": detected, "unknown_markers": unknown}
    return detections, counters
