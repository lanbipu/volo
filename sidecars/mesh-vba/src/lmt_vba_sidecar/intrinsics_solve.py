"""Pure SL intrinsics solver (no IPC, no file IO) shared by calibrate-structured-light
and reconstruct-structured-light's --intrinsics auto. Gate failures raise
IntrinsicsRefused(code, msg); callers translate to an ErrorEvent or re-raise."""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from lmt_vba_sidecar.calibrate import FOCAL_BOUNDS_FRACTION

# Gate constants (mirror calibrate_sl.py:42-60 so behavior is unchanged after extraction).
COVERAGE_MIN_FRAC = 0.20
COPLANAR_RATIO_MIN = 1e-3
POSE_ROT_DIVERSITY_DEG = 5.0
PP_STDDEV_MAX_PX = 3.0
FOCAL_STDDEV_MAX_FRAC = 0.005
MIN_DOTS_PER_POSE = 4

# Anti-absorption cross-check tolerances (spec A.1.3 / P6). Compare auto-K to an
# independent anchor on THREE axes so each screen pitch/1:1 error class is caught:
FOCAL_CROSSCHECK_MAX_FRAC = 0.02      # |fx - anchor_fx| / anchor_fx  (class a: isotropic scale)
ASPECT_CROSSCHECK_MAX = 0.01          # |fx/fy - anchor_fx/anchor_fy| (class b: anisotropic)
DISTORTION_CROSSCHECK_MAX_PX = 1.5    # radial-displacement gap at the corner (class c: smooth remap)
TANGENTIAL_CROSSCHECK_MAX_PX = 1.5    # tangential (decentering) gap at the corner (class c': p1/p2)
_CORNER_R_NORM = 0.6                  # representative normalized radius (wide-lens corner-ish)


class IntrinsicsRefused(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class IntrinsicsResult:
    K: np.ndarray
    dist: np.ndarray
    rms: float
    focal_stddev_px: tuple[float, float]
    pp_stddev_px: tuple[float, float]
    distortion_model: str          # "radial2" | "full"
    coplanar_ratio: float
    rvecs: list


def _coplanarity_ratio(pts: np.ndarray) -> float:
    if len(pts) < 3:
        return 0.0
    s = np.linalg.svd(pts - pts.mean(axis=0), compute_uv=False)
    return float(s[-1] / s[0]) if s[0] > 0 else 0.0


def _max_pairwise_view_axis_deg(rvecs) -> float:
    """Max pairwise angle between VIEW AXES (the optical axis expressed in the
    target frame): arccos(Rrel[2,2]), Rrel = Ra^T Rb.

    FIX-5: the old metric used the TOTAL relative rotation angle (trace
    formula), which counts roll about the optical axis — but on a planar
    target a pure-roll view set is a Zhang degeneracy (focal unobservable):
    roll+translation captures sailed through every gate (rot "diversity" read
    100 deg, rms 0.000px, formal stddevs ~0) while fx came out +100% wrong.
    Only out-of-axis tilt (pitch/yaw relative to the target) makes focal
    observable, so only that component may satisfy the gate."""
    Rs = [cv2.Rodrigues(np.asarray(r))[0] for r in rvecs]
    best = 0.0
    for a in range(len(Rs)):
        for b in range(a + 1, len(Rs)):
            cos = float((Rs[a].T @ Rs[b])[2, 2])
            best = max(best, float(np.degrees(np.arccos(np.clip(cos, -1.0, 1.0)))))
    return best


def _coverage_frac(image_points, image_size) -> float:
    allpts = np.concatenate([np.asarray(p).reshape(-1, 2) for p in image_points], axis=0)
    w = (allpts[:, 0].max() - allpts[:, 0].min()) / image_size[0]
    h = (allpts[:, 1].max() - allpts[:, 1].min()) / image_size[1]
    return float(min(w, h))


def solve_sl_intrinsics(object_points, image_points, image_size, *, max_rms_px: float,
                        allow_full_distortion: bool = False,
                        max_pp_std_px: float | None = None,
                        max_focal_std_frac: float | None = None,
                        try_zero_distortion: bool = False) -> IntrinsicsResult:
    """Solve K + distortion from per-pose (object_points, image_points). Raises
    IntrinsicsRefused on any gate. With allow_full_distortion the model is solved
    with k3 + tangential freed and ACCEPTED only when those extra coefficients are
    observable (|coeff| > its stddev) and RMS did not worsen; otherwise it falls
    back to the radial k1,k2 model (distortion_model = 'radial2' | 'full')."""
    if len(object_points) < 1:
        raise IntrinsicsRefused("observability_failed", f"no pose has >= {MIN_DOTS_PER_POSE} dots")
    all_obj = np.concatenate(object_points, axis=0)
    ratio = _coplanarity_ratio(all_obj)
    # FIX-27: single pose on a shallow-relief wall (ratio ~1e-3) looks non-coplanar
    # but cannot constrain focal length. Require genuinely 3D structure (ratio >= 0.1)
    # for single-pose, or >= 2 diverse views for near-planar targets.
    if len(object_points) == 1 and ratio < 0.1:
        raise IntrinsicsRefused(
            "observability_failed",
            f"single pose on a near-planar target (depth/width ratio={ratio:.2e}) "
            "cannot constrain focal length — capture at least 2 views with "
            ">= 15° pitch/yaw variation between them")
    if ratio < COPLANAR_RATIO_MIN and len(object_points) < 3:
        raise IntrinsicsRefused("observability_failed",
                                f"near-coplanar target (ratio={ratio:.2e}) with only {len(object_points)} pose(s)")
    cover = _coverage_frac(image_points, image_size)
    if cover < COVERAGE_MIN_FRAC:
        raise IntrinsicsRefused("observability_failed", f"image coverage {cover:.2f} < {COVERAGE_MIN_FRAC}")

    long_dim = max(image_size)
    K0 = np.array([[1.2 * long_dim, 0.0, image_size[0] / 2.0],
                   [0.0, 1.2 * long_dim, image_size[1] / 2.0],
                   [0.0, 0.0, 1.0]])

    def _solve(full: bool):
        if full:
            f = cv2.CALIB_USE_INTRINSIC_GUESS                         # free k1,k2,k3,p1,p2
        else:
            f = cv2.CALIB_USE_INTRINSIC_GUESS | cv2.CALIB_ZERO_TANGENT_DIST | cv2.CALIB_FIX_K3
        # cv2.calibrateCameraExtended MUTATES the guess in place and returns the SAME
        # object, so pass a fresh copy per call — otherwise the full probe overwrites
        # the radial K that a fallback must keep (K would then mismatch radial dist/rms).
        return cv2.calibrateCameraExtended(
            object_points, image_points, image_size, K0.copy(), np.zeros(5), flags=f)

    model = "radial2"
    try:
        # Zero-distortion probe: for well-corrected lenses (normal–tele), fixing
        # dist=0 avoids absorbing per-cabinet physical-dimension errors into k1/k2.
        # Accept if RMS is within 10% of the freed-distortion RMS (i.e. distortion
        # was negligible). If RMS is measurably worse, fall through to radial2.
        if try_zero_distortion:
            zf = (cv2.CALIB_USE_INTRINSIC_GUESS | cv2.CALIB_FIX_K1 | cv2.CALIB_FIX_K2 |
                  cv2.CALIB_ZERO_TANGENT_DIST | cv2.CALIB_FIX_K3)
            r0, K0z, d0, rv0, _t0, si0, _se0, _pv0 = cv2.calibrateCameraExtended(
                object_points, image_points, image_size, K0.copy(), np.zeros(5), flags=zf)
            r_free, *_ = _solve(full=False)
            if r0 <= r_free * 1.10:
                rms, K, dist, rvecs, std_int, model = r0, K0z, d0, rv0, si0, "zero_dist"

        if model != "zero_dist":
            rms, K, dist, rvecs, _tvecs, std_int, _std_ext, _pv = _solve(full=False)
        if allow_full_distortion:
            r2, K2, d2, rv2, _t2, si2, _se2, _pv2 = _solve(full=True)
            s2 = np.asarray(si2).flatten()
            # Accept full if it did not worsen RMS and AT LEAST ONE extra coeff is
            # observable (stddev < |coeff|). k3 and the tangential pair are independent
            # DOF, so OR them, not AND: a lens with real k3 but a centered sensor
            # (p1=p2~0, the common case) would otherwise drop its observable k3 and fall
            # back to radial2. Unobservable extra coeffs come out ~0 and are harmless.
            k3_ok = abs(d2.flatten()[4]) > s2[8] if len(s2) > 8 else False
            tan_ok = (abs(d2.flatten()[2]) > s2[6] and abs(d2.flatten()[3]) > s2[7]
                      if len(s2) > 7 else False)
            if r2 <= rms * 1.05 and (k3_ok or tan_ok):
                rms, K, dist, rvecs, std_int, model = r2, K2, d2, rv2, si2, "full"
    except cv2.error as e:
        raise IntrinsicsRefused("intrinsics_invalid", f"calibrateCamera failed: {e}")

    if len(rvecs) >= 2 and _max_pairwise_view_axis_deg(rvecs) < POSE_ROT_DIVERSITY_DEG:
        raise IntrinsicsRefused("observability_failed",
                                f"pose view-axis diversity < {POSE_ROT_DIVERSITY_DEG} deg: no out-of-axis "
                                f"tilt between captures (pure roll/translation sets are Zhang-degenerate "
                                f"on a planar target — add >= 15 deg pitch/yaw variation)")
    if not (np.isfinite(K).all() and np.isfinite(dist).all() and np.isfinite(rms)):
        raise IntrinsicsRefused("intrinsics_invalid", f"calibration produced non-finite values (rms={rms})")
    fx, fy, cx, cy = float(K[0, 0]), float(K[1, 1]), float(K[0, 2]), float(K[1, 2])
    f_lo, f_hi = FOCAL_BOUNDS_FRACTION
    if not (f_lo * long_dim < fx < f_hi * long_dim) or not (f_lo * long_dim < fy < f_hi * long_dim):
        raise IntrinsicsRefused("intrinsics_invalid", f"focal ({fx:.1f},{fy:.1f}) outside plausible range")
    if not (0 < cx < image_size[0]) or not (0 < cy < image_size[1]):
        raise IntrinsicsRefused("intrinsics_invalid", f"principal point ({cx:.1f},{cy:.1f}) outside image")
    if rms > max_rms_px:
        raise IntrinsicsRefused("intrinsics_invalid", f"reproj RMS {rms:.2f}px exceeds gate {max_rms_px}px")
    std = np.asarray(std_int).flatten()
    pp_std = (float(std[2]), float(std[3]))
    foc_std = (float(std[0]), float(std[1]))
    pp_gate = max_pp_std_px if max_pp_std_px is not None else PP_STDDEV_MAX_PX
    if max(pp_std) > pp_gate:
        raise IntrinsicsRefused("observability_failed", f"principal-point std {pp_std} px > {pp_gate}")
    foc_gate = max_focal_std_frac if max_focal_std_frac is not None else FOCAL_STDDEV_MAX_FRAC
    if max(foc_std) > foc_gate * fx:
        raise IntrinsicsRefused("observability_failed", f"focal std {foc_std} px > {foc_gate*100:.1f}%")

    return IntrinsicsResult(K=K, dist=dist, rms=float(rms), focal_stddev_px=foc_std,
                            pp_stddev_px=pp_std, distortion_model=model,
                            coplanar_ratio=ratio, rvecs=list(rvecs))


def _radial_disp_px(dist, fx) -> float:
    """SIGNED radial distortion displacement (px) at the representative corner radius.
    The smooth-remap class lands in k1,k2,k3 and does NOT move fx/aspect, so this term
    is what catches it (spec A.1.3 '畸变量级'). The sign is kept (no abs on the
    polynomial) so the cross-check can tell barrel (k1<0) from pincushion (k1>0): two
    equal-magnitude opposite-sign distortions must NOT difference to zero."""
    d = np.asarray(dist, float).flatten()
    k1 = d[0] if len(d) > 0 else 0.0
    k2 = d[1] if len(d) > 1 else 0.0
    k3 = d[4] if len(d) > 4 else 0.0
    r = _CORNER_R_NORM
    return abs(fx) * (r * (k1 * r**2 + k2 * r**4 + k3 * r**6))


def _tangential_disp_px(dist, fx) -> tuple[float, float]:
    """SIGNED tangential (decentering) displacement VECTOR (px) at the representative
    corner. Tangential distortion is ASYMMETRIC — a screen shear/decentering absorbed
    into p1/p2 moves the image here even when focal, aspect, and radial all match the
    anchor, so the radial-only term misses it (Codex P2). The vector (not a magnitude)
    is returned so an opposite-direction p1/p2 cannot difference to zero, mirroring the
    signed-radial barrel/pincushion guard."""
    d = np.asarray(dist, float).flatten()
    p1 = d[2] if len(d) > 2 else 0.0
    p2 = d[3] if len(d) > 3 else 0.0
    r = _CORNER_R_NORM
    x = y = r / np.sqrt(2.0)                       # a corner point with |(x, y)| = r
    r2 = x * x + y * y
    dx = 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x)
    dy = p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y
    return abs(fx) * dx, abs(fx) * dy


def intrinsics_K_problem(K) -> str | None:
    """Return a human reason if K is not a usable camera matrix — must be a FINITE 3x3 with
    POSITIVE fx/fy — else None. Shared by the anti-absorption anchor check AND the
    file-intrinsics loader so every user-supplied K is rejected by the same rule: a non-3x3
    array IndexErrors downstream, and a negative focal silently flips projection handedness
    (mirror-image reconstruction) instead of failing."""
    aK = np.asarray(K, float)
    if aK.shape != (3, 3) or not np.isfinite(aK).all():
        return "K must be a finite 3x3 matrix"
    if float(aK[0, 0]) <= 0.0 or float(aK[1, 1]) <= 0.0:
        return "K must have positive fx/fy"
    return None


def crosscheck_intrinsics(res: IntrinsicsResult, *, anchor_K, anchor_dist=None) -> IntrinsicsRefused | None:
    """Anti-absorption guard (spec P6/A.1.3). Compares THREE things vs an independent
    anchor — focal (class a), fx/fy aspect (class b), and distortion magnitude (class c).
    Returns IntrinsicsRefused to REFUSE, or None to proceed. A None with no anchor on a
    non-coplanar target means the caller SHOULD emit WarningEvent(code='no_intrinsics_anchor')."""
    fx, fy = float(res.K[0, 0]), float(res.K[1, 1])
    if anchor_K is not None:
        # The anchor is a user-supplied file. A malformed K would otherwise either throw
        # IndexError out of the 2-D indexing below (escaping as internal_error, not the
        # advertised invalid_input — 1-D / non-3x3), or SILENTLY pass the guard: a NaN makes
        # every `> threshold` False, and a NEGATIVE focal makes `focal_dev = abs(fx-afx)/afx`
        # divide by a negative afx so the result is < the threshold while a sign-symmetric
        # aspect/distortion still matches. Reject via the shared K validator up front.
        aK = np.asarray(anchor_K, float)
        a_dist = np.zeros(5) if anchor_dist is None else np.asarray(anchor_dist, float)
        prob = intrinsics_K_problem(aK)
        if prob is not None or not np.isfinite(a_dist).all():
            return IntrinsicsRefused(
                "invalid_input",
                f"crosscheck anchor malformed: {prob or 'dist must be finite'}")
        afx, afy = float(aK[0, 0]), float(aK[1, 1])
        focal_dev = abs(fx - afx) / afx if afx else 1.0
        aspect_dev = abs((fx / fy) - (afx / afy)) if (fy and afy) else 1.0
        disp_dev_px = abs(_radial_disp_px(res.dist, fx) - _radial_disp_px(a_dist, afx))
        # Tangential is the noisiest distortion term: a RADIAL-ONLY anchor (p1=p2=0) cannot
        # validate a lens that genuinely has tangential, so this term can refuse an otherwise
        # good self-cal there. That conservative refusal is intentional (spec P6: refuse rather
        # than ship a possibly-absorbed K — provide a full anchor to clear it), not a bug.
        tan_res, tan_anc = _tangential_disp_px(res.dist, fx), _tangential_disp_px(a_dist, afx)
        tan_dev_px = float(np.hypot(tan_res[0] - tan_anc[0], tan_res[1] - tan_anc[1]))
        if focal_dev > FOCAL_CROSSCHECK_MAX_FRAC or aspect_dev > ASPECT_CROSSCHECK_MAX \
                or disp_dev_px > DISTORTION_CROSSCHECK_MAX_PX \
                or tan_dev_px > TANGENTIAL_CROSSCHECK_MAX_PX:
            return IntrinsicsRefused(
                "observability_failed",
                f"auto intrinsics deviate from anchor (focal {focal_dev*100:.1f}%, "
                f"aspect {aspect_dev:.3f}, distortion radial {disp_dev_px:.2f}px "
                f"tangential {tan_dev_px:.2f}px) — suspected screen pitch/1:1 absorbed into K")
        return None
    if res.coplanar_ratio < COPLANAR_RATIO_MIN:
        return IntrinsicsRefused(
            "observability_failed",
            "flat wall + no independent intrinsics anchor; cannot separate screen "
            "pitch/1:1 from intrinsics — pass an anchor via --intrinsics-crosscheck")
    return None
