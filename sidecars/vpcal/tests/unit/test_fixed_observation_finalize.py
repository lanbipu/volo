"""Producer-side convention guarantee for fixed-observation artifacts.

``_finalize_fixed_observation_result`` (shared by the VP-QSP and structured-light
fixed-observation commands) must normalise ``camera_from_stage.matrix_4x4`` to
the same Stage←VoloCamera convention as ``tracker-free pose`` — i.e. the
translation column is the camera's position in the Stage frame (``position_mm``),
NOT the raw OpenCV ``tvec``. Otherwise the sole consumer
(``opencv_T_from_stage_pose``) misreads the matrix and projects every grid point
behind the camera, yielding an empty AR overlay.

A minimal stub result is used deliberately: constructing a full
``FixedObservationResult`` is expensive and unnecessary — the enrichment only
touches ``camera_from_stage`` plus a few scalar fields for persistence.
"""
from __future__ import annotations

import cv2
import numpy as np

from vpcal.cli.tracker_free import _finalize_fixed_observation_result


class _StubResult:
    def __init__(self, camera_from_stage):
        self.camera_from_stage = camera_from_stage
        self.formal = False
        self.qualification = {"passed": True}
        self.session_lens = None
        self.solve_kind = "fixed_extrinsics_only"
        self.rms_reprojection_px = 0.64
        self.model_level = "L2"
        self.mode_resolved = "known-lens"

    def to_dict(self):
        return {"camera_from_stage": self.camera_from_stage}


def test_finalize_normalises_matrix_translation_to_position_mm(tmp_path):
    # Non-trivial rotation so tvec != position_mm and the bug would be visible.
    rvec = np.array([0.1, -0.2, 0.3], dtype=np.float64)
    R, _ = cv2.Rodrigues(rvec)
    tvec = np.array([120.0, -45.0, 3200.0], dtype=np.float64)
    position_mm = (-R.T @ tvec).tolist()

    result = _StubResult(
        {
            "rvec": rvec.tolist(),
            "tvec": tvec.tolist(),
            "position_mm": position_mm,
            # Raw solver value: OpenCV camera←Stage [R|t] with tvec in the column.
            "matrix_4x4": np.block(
                [[R, tvec.reshape(3, 1)], [np.zeros((1, 3)), np.ones((1, 1))]]
            ).tolist(),
        }
    )

    out_path = str(tmp_path / "fixed_observation_result.json")
    _finalize_fixed_observation_result(
        result,
        command_label="test",
        out_path=out_path,
        stage_pose_out=None,
        fallback_image_size=(1920, 1080),
    )

    M = np.asarray(result.camera_from_stage["matrix_4x4"], dtype=np.float64)
    assert M.shape == (4, 4)
    # Translation column is now the camera's Stage position, not tvec.
    assert np.allclose(M[:3, 3], np.asarray(position_mm), atol=1e-9)
    assert not np.allclose(M[:3, 3], tvec, atol=1e-3)
    assert np.allclose(M[3], [0.0, 0.0, 0.0, 1.0], atol=1e-12)
    # rvec/tvec must be left untouched (OpenCV semantics preserved).
    assert result.camera_from_stage["rvec"] == rvec.tolist()
    assert result.camera_from_stage["tvec"] == tvec.tolist()
