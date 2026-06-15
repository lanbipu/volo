import pytest
from lmt_vba_sidecar.model_constrained_ba import Observation
import numpy as np
from lmt_vba_sidecar.observability import check_observability, ObservabilityError


def _obs(ci, bj):
    return Observation(camera_idx=ci, cabinet_idx=bj, p_local=np.zeros(3), pixel=np.zeros(2))


def test_connected_graph_passes():
    obs = [_obs(0, 0), _obs(0, 1), _obs(1, 1), _obs(1, 2)]  # 0-0,0-1,1-1,1-2 connected
    rep = check_observability(obs, n_cabinets=3, min_views=1, min_points=1)
    assert rep["connected"]


def test_disconnected_cabinet_raises():
    obs = [_obs(0, 0), _obs(0, 1), _obs(2, 2)]  # cabinet 2 only seen by cam2, isolated
    with pytest.raises(ObservabilityError):
        check_observability(obs, n_cabinets=3, min_views=2, min_points=1)


def test_disconnected_graph_raises_even_when_views_sufficient():
    # cab0 <-> cam0,cam1 ; cab1 <-> cam2,cam3 -- no shared camera, two components.
    # Every cabinet has 2 distinct views + 2 points (passes weak gate); only the
    # connectivity gate can catch the split.
    obs = [_obs(0, 0), _obs(0, 0), _obs(1, 0), _obs(1, 0),
           _obs(2, 1), _obs(2, 1), _obs(3, 1), _obs(3, 1)]
    with pytest.raises(ObservabilityError, match="isolated_cabinets"):
        check_observability(obs, n_cabinets=2, min_views=2, min_points=2)
