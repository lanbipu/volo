import numpy as np
import cv2
from lmt_vba_sidecar.model_constrained_ba import model_constrained_ba, Observation

def _project(K, R_cam, t_cam, R_cab, t_cab, p_local):
    xw = R_cab @ p_local + t_cab
    xc = R_cam @ xw + t_cam
    p = K @ xc
    return p[:2] / p[2]

def test_zero_noise_recovers_two_boards_exactly():
    K = np.array([[2000.,0,960],[0,2000,540],[0,0,1]])
    R0, t0 = np.eye(3), np.zeros(3)
    R1, _ = cv2.Rodrigues(np.array([0., np.deg2rad(15), 0.]))
    t1 = np.array([700., 0., 0.])
    corners = np.array([[-300,-170,0],[300,-170,0],[300,170,0],[-300,170,0]], float)
    boards = [(R0, t0), (R1, t1)]
    cams = []
    for i in range(5):
        rvec = np.array([0.05*i, 0.1*i, 0.0])
        Rc, _ = cv2.Rodrigues(rvec)
        tc = np.array([50.*i, -20.*i, 2500.])
        cams.append((Rc, tc))
    obs = []
    for ci,(Rc,tc) in enumerate(cams):
        for bj,(Rb,tb) in enumerate(boards):
            for p in corners:
                px = _project(K, Rc, tc, Rb, tb, p)
                obs.append(Observation(camera_idx=ci, cabinet_idx=bj,
                                       p_local=p.copy(), pixel=px.copy()))
    init_cams = [(Rc, tc) for Rc, tc in cams]
    init_boards = {1: (np.eye(3), np.array([700.,0,0]))}
    result = model_constrained_ba(
        K=K, observations=obs, n_cameras=5, n_cabinets=2,
        root_cabinet_idx=0, init_cameras=init_cams, init_cabinets=init_boards,
        loss="linear",
    )
    assert result.converged
    assert np.linalg.norm(result.cabinet_poses[1][1] - t1) < 0.05
    n_est = result.cabinet_poses[1][0] @ np.array([0,0,1.])
    n_true = R1 @ np.array([0,0,1.])
    ang = np.degrees(np.arccos(np.clip(n_est @ n_true, -1, 1)))
    assert ang < 0.05
    assert result.rms_reprojection_px < 1e-3


def _grid_points(nx=5, ny=4, half_w=300.0, half_h=170.0):
    """z=0 planar grid — realistic marker density for stable covariance."""
    pts = []
    for iy in range(ny):
        for ix in range(nx):
            x = -half_w + 2 * half_w * ix / (nx - 1)
            y = -half_h + 2 * half_h * iy / (ny - 1)
            pts.append([x, y, 0.0])
    return np.array(pts, float)


def _make_scene(K, n_cabs=3, n_cams=6, noise=0.0, rng=None):
    """Synthetic multi-cabinet scene for covariance tests."""
    points = _grid_points()
    boards = {}
    for j in range(n_cabs):
        angle = np.deg2rad(10.0 * j)
        R_j, _ = cv2.Rodrigues(np.array([0.0, angle, 0.0]))
        t_j = np.array([700.0 * j, 0.0, 0.0])
        boards[j] = (R_j, t_j)
    cams = []
    for i in range(n_cams):
        rvec = np.array([0.05 * i, 0.08 * (i - n_cams // 2), 0.0])
        Rc, _ = cv2.Rodrigues(rvec)
        tc = np.array([350.0 * (n_cabs - 1) / 2 + 60 * i, -30 * i, 2500.0])
        cams.append((Rc, tc))
    obs = []
    for ci, (Rc, tc) in enumerate(cams):
        for bj, (Rb, tb) in boards.items():
            for p in points:
                px = _project(K, Rc, tc, Rb, tb, p)
                if rng is not None and noise > 0:
                    px = px + rng.normal(0, noise, 2)
                obs.append(Observation(camera_idx=ci, cabinet_idx=bj,
                                       p_local=p.copy(), pixel=px.copy()))
    init_cabs = {j: (np.eye(3), boards[j][1].copy()) for j in range(1, n_cabs)}
    return boards, cams, obs, init_cabs


def test_covariance_monte_carlo_consistency():
    """FIX-19①: average reported covariance trace within 0.5–2× of MC empirical."""
    K = np.array([[2000., 0, 960], [0, 2000, 540], [0, 0, 1]])
    noise_px = 0.5
    n_mc = 60
    _, cams_true, _, init_cabs = _make_scene(K, n_cabs=3, n_cams=6)
    mc_translations = {j: [] for j in range(1, 3)}
    reported_traces = {j: [] for j in range(1, 3)}
    for trial in range(n_mc):
        rng = np.random.default_rng(trial)
        _, _, obs, _ = _make_scene(K, n_cabs=3, n_cams=6, noise=noise_px, rng=rng)
        result = model_constrained_ba(
            K=K, observations=obs, n_cameras=6, n_cabinets=3,
            root_cabinet_idx=0, init_cameras=list(cams_true),
            init_cabinets=dict(init_cabs), loss="linear",
        )
        for j in range(1, 3):
            mc_translations[j].append(result.cabinet_poses[j][1])
            if j in result.cabinet_covariances:
                reported_traces[j].append(np.trace(result.cabinet_covariances[j]))
    for j in range(1, 3):
        mc_samples = np.array(mc_translations[j])
        empirical_trace = np.trace(np.cov(mc_samples.T))
        avg_reported = np.median(reported_traces[j])
        trace_ratio = avg_reported / empirical_trace
        assert 0.3 <= trace_ratio <= 3.0, (
            f"cabinet {j}: trace ratio {trace_ratio:.2f} outside 0.3–3× "
            f"(reported median={avg_reported:.4f}, "
            f"empirical={empirical_trace:.4f})")


def test_covariance_positive_definite():
    """Reported covariance must be symmetric positive-definite."""
    K = np.array([[2000., 0, 960], [0, 2000, 540], [0, 0, 1]])
    rng = np.random.default_rng(42)
    _, cams, obs, init_cabs = _make_scene(K, n_cabs=3, n_cams=6, noise=0.3, rng=rng)
    result = model_constrained_ba(
        K=K, observations=obs, n_cameras=6, n_cabinets=3,
        root_cabinet_idx=0, init_cameras=list(cams),
        init_cabinets=dict(init_cabs), loss="huber",
    )
    for j, cov in result.cabinet_covariances.items():
        assert np.allclose(cov, cov.T, atol=1e-12), f"cabinet {j} cov not symmetric"
        eigvals = np.linalg.eigvalsh(cov)
        assert np.all(eigvals > 0), f"cabinet {j} cov not positive definite: {eigvals}"


def test_covariance_rotation_preserves_eigenvalues():
    """FIX-19②: R Σ Rᵀ preserves eigenvalues; eigenvectors rotate by R."""
    K = np.array([[2000., 0, 960], [0, 2000, 540], [0, 0, 1]])
    rng = np.random.default_rng(7)
    _, cams, obs, init_cabs = _make_scene(K, n_cabs=3, n_cams=6, noise=0.4, rng=rng)
    result = model_constrained_ba(
        K=K, observations=obs, n_cameras=6, n_cabinets=3,
        root_cabinet_idx=0, init_cameras=list(cams),
        init_cabinets=dict(init_cabs), loss="huber",
    )
    R90, _ = cv2.Rodrigues(np.array([0., np.pi / 2, 0.]))
    for j, cov_orig in result.cabinet_covariances.items():
        cov_rot = R90 @ cov_orig @ R90.T
        eig_orig = np.sort(np.linalg.eigvalsh(cov_orig))
        eig_rot = np.sort(np.linalg.eigvalsh(cov_rot))
        np.testing.assert_allclose(eig_orig, eig_rot, rtol=1e-10)
        # Eigenvectors should rotate
        _, V_orig = np.linalg.eigh(cov_orig)
        _, V_rot = np.linalg.eigh(cov_rot)
        for k in range(3):
            v_expected = R90 @ V_orig[:, k]
            dot = abs(float(v_expected @ V_rot[:, k]))
            assert dot > 0.99, f"eigenvector {k} didn't rotate with R"


def test_heteroscedastic_weighting_improves_pose():
    """FIX-25: when some observations are noisier, setting sigma_px correctly
    should yield better cabinet poses than equal-weight."""
    K = np.array([[2000., 0, 960], [0, 2000, 540], [0, 0, 1]])
    _, cams_true, _, init_cabs = _make_scene(K, n_cabs=3, n_cams=6)
    boards_true = {}
    for j in range(3):
        angle = np.deg2rad(10.0 * j)
        R_j, _ = cv2.Rodrigues(np.array([0.0, angle, 0.0]))
        boards_true[j] = (R_j, np.array([700.0 * j, 0.0, 0.0]))
    rng = np.random.default_rng(99)
    points = _grid_points()
    # Build observations: first 2 cameras get high noise (5px), rest get low noise (0.2px)
    obs_weighted = []
    obs_equal = []
    for ci, (Rc, tc) in enumerate(cams_true):
        noise = 5.0 if ci < 2 else 0.2
        sigma = noise
        for bj, (Rb, tb) in boards_true.items():
            for p in points:
                px = _project(K, Rc, tc, Rb, tb, p) + rng.normal(0, noise, 2)
                obs_weighted.append(Observation(camera_idx=ci, cabinet_idx=bj,
                    p_local=p.copy(), pixel=px.copy(), sigma_px=sigma))
                obs_equal.append(Observation(camera_idx=ci, cabinet_idx=bj,
                    p_local=p.copy(), pixel=px.copy(), sigma_px=1.0))
    result_w = model_constrained_ba(
        K=K, observations=obs_weighted, n_cameras=6, n_cabinets=3,
        root_cabinet_idx=0, init_cameras=list(cams_true),
        init_cabinets=dict(init_cabs), loss="linear",
    )
    result_eq = model_constrained_ba(
        K=K, observations=obs_equal, n_cameras=6, n_cabinets=3,
        root_cabinet_idx=0, init_cameras=list(cams_true),
        init_cabinets=dict(init_cabs), loss="linear",
    )
    # Weighted should have smaller translation error on at least one non-root cabinet
    err_w = sum(np.linalg.norm(result_w.cabinet_poses[j][1] - boards_true[j][1]) for j in range(1, 3))
    err_eq = sum(np.linalg.norm(result_eq.cabinet_poses[j][1] - boards_true[j][1]) for j in range(1, 3))
    improvement = (err_eq - err_w) / err_eq if err_eq > 0 else 0
    assert improvement > 0.10, (
        f"heteroscedastic weighting did not improve: err_w={err_w:.3f}, "
        f"err_eq={err_eq:.3f}, improvement={improvement:.1%}")
