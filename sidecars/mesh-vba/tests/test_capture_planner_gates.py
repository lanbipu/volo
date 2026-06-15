import inspect
import re
from pathlib import Path

from lmt_vba_sidecar import reconstruct
from lmt_vba_sidecar.observability import check_observability
from lmt_vba_sidecar.capture_planner import gates
from lmt_vba_sidecar.ipc import PlanCaptureInput


def test_gate_constants_mirror_reconstruct():
    # PnP corner floor and quality-view threshold are importable module
    # constants in reconstruct.py — assert exact mirror.
    assert gates.MIN_PNP_CORNERS == reconstruct.MIN_PNP_CORNERS
    assert gates.QUALITY_MIN_VIEWS == reconstruct.QUALITY_MIN_VIEWS


def test_plan_capture_min_views_default_mirrors_gate():
    # The plan-capture REQUEST default must equal the reconstruct observation gate, or the
    # planner would advertise reconstructability at a looser bar than reconstruct enforces.
    # Pins the literal-2 pydantic default (and, by contract, the Rust default + capture-card
    # literal) so a future gates.MIN_VIEWS bump forces this default to be updated too.
    assert PlanCaptureInput.model_fields["min_views"].default == gates.MIN_VIEWS


def test_gate_constants_mirror_check_observability_call_sites():
    # The OPERATIVE gate is the explicit call-site arguments in reconstruct.py
    # (e.g. `check_observability(..., min_views=2, min_points=8)`), which
    # override the function defaults. Asserting against the defaults would miss
    # a drift where someone tightens the call site but leaves the default — so
    # scrape the actual reconstruct.py call sites and assert every one matches.
    src = Path(reconstruct.__file__).read_text()
    # non-comment lines that call check_observability with both kwargs
    call_re = re.compile(
        r"check_observability\([^)]*min_views=(\d+)[^)]*min_points=(\d+)[^)]*\)")
    sites = [
        call_re.search(line)
        for line in src.splitlines()
        if "check_observability(" in line and not line.lstrip().startswith("#")
    ]
    sites = [m for m in sites if m]
    assert sites, "no check_observability(min_views=, min_points=) call site found"
    for m in sites:
        assert int(m.group(1)) == gates.MIN_VIEWS
        assert int(m.group(2)) == gates.MIN_POINTS_PER_CABINET

    # And the defaults still agree (belt-and-suspenders).
    sig = inspect.signature(check_observability)
    assert gates.MIN_VIEWS == sig.parameters["min_views"].default
    assert gates.MIN_POINTS_PER_CABINET == sig.parameters["min_points"].default
