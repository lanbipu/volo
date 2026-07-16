"""Environment diagnostics for solver and capture backends."""

from __future__ import annotations

import importlib.util
import platform
import sys

import click

from vpcal.cli._common import OperationOutput, common_options, run_operation


def collect_diagnostics() -> dict:
    import cv2
    import scipy

    from vpcal.core.solver import cpp_available

    aruco = hasattr(cv2, "aruco") and hasattr(cv2.aruco, "ArucoDetector")
    ndi_binding = importlib.util.find_spec("cyndilib") is not None
    decklink = importlib.util.find_spec("vpcal._vpcal_capture") is not None
    checks = {
        "python": {
            "available": sys.version_info >= (3, 11),
            "version": platform.python_version(),
            "required": True,
        },
        "opencv": {
            "available": True,
            "version": cv2.__version__,
            "aruco": aruco,
            "required": True,
        },
        "solver_ceres": {"available": cpp_available(), "required": False},
        "solver_scipy": {"available": True, "version": scipy.__version__, "required": True},
        "capture_ndi": {"available": ndi_binding, "required": False},
        "capture_decklink": {"available": decklink, "required": False},
        "capture_uvc": {"available": True, "provider": "opencv", "required": False},
    }
    required_ok = all(
        bool(v.get("available")) and (k != "opencv" or bool(v.get("aruco")))
        for k, v in checks.items()
        if v.get("required")
    )
    solver = "ceres" if checks["solver_ceres"]["available"] else "scipy"
    return {"ok": required_ok, "resolved_solver_backend": solver, "checks": checks}


@click.command()
@common_options
@click.pass_context
def doctor(ctx: click.Context, **flags: object) -> None:
    """Check required runtime capabilities and optional hardware backends."""

    def body() -> OperationOutput:
        data = collect_diagnostics()
        lines = [
            f"vpcal doctor: {'ok' if data['ok'] else 'missing required capability'}",
            f"  solver: {data['resolved_solver_backend']}",
        ]
        for name, check in data["checks"].items():
            state = "available" if check["available"] else "unavailable"
            suffix = " (required)" if check.get("required") else ""
            lines.append(f"  {name}: {state}{suffix}")
        return OperationOutput(data=data, text="\n".join(lines), exit_code=0 if data["ok"] else 6)

    run_operation("doctor", body, **flags)
