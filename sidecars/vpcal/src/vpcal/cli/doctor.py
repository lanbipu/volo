"""Environment diagnostics for solver and capture backends."""

from __future__ import annotations

import importlib
import importlib.util
import platform
import sys

import click

from vpcal.cli._common import OperationOutput, common_options, run_operation


def _import_optional(name: str) -> tuple[object | None, str | None]:
    """Import one runtime dependency without aborting the diagnostic sweep."""

    try:
        return importlib.import_module(name), None
    except Exception as exc:  # noqa: BLE001 -- import failures are doctor output
        return None, str(exc) or exc.__class__.__name__


def collect_diagnostics() -> dict:
    cv2, cv2_error = _import_optional("cv2")
    scipy, scipy_error = _import_optional("scipy")
    ceres, ceres_error = _import_optional("vpcal._vpcal_solver")

    aruco = bool(
        cv2 is not None
        and hasattr(cv2, "aruco")
        and hasattr(cv2.aruco, "ArucoDetector")
    )
    ndi_binding = importlib.util.find_spec("cyndilib") is not None
    decklink = importlib.util.find_spec("vpcal._vpcal_capture") is not None
    checks = {
        "python": {
            "available": sys.version_info >= (3, 11),
            "version": platform.python_version(),
            "required": True,
        },
        "opencv": {
            "available": cv2 is not None,
            "version": getattr(cv2, "__version__", None),
            "aruco": aruco,
            "required": True,
            **({"error": cv2_error} if cv2_error else {}),
        },
        "solver_ceres": {
            "available": ceres is not None,
            "required": False,
            **({"error": ceres_error} if ceres_error else {}),
        },
        "solver_scipy": {
            "available": scipy is not None,
            "version": getattr(scipy, "__version__", None),
            "required": True,
            **({"error": scipy_error} if scipy_error else {}),
        },
        "capture_ndi": {"available": ndi_binding, "required": False},
        "capture_decklink": {"available": decklink, "required": False},
        "capture_uvc": {"available": True, "provider": "opencv", "required": False},
    }
    required_ok = all(
        bool(v.get("available")) and (k != "opencv" or bool(v.get("aruco")))
        for k, v in checks.items()
        if v.get("required")
    )
    solver = (
        "ceres"
        if checks["solver_ceres"]["available"]
        else "scipy"
        if checks["solver_scipy"]["available"]
        else None
    )
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
