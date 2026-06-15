"""Typed error hierarchy for vpcal.

Core SDK functions raise these exceptions instead of calling ``sys.exit`` or
``print`` (per CLI_DESIGN_SPEC §1.3).  Each error carries the metadata the CLI
adapter needs to build an error envelope (§4.2) and choose a process exit code
(§5 / spec §12):

    exit_code  — POSIX process exit code (coarse classification)
    code       — fine-grained business error code string (envelope ``error.code``)
    retryable  — whether an agent can usefully retry after fixing inputs
    details    — optional structured context for the envelope ``error.details``
"""

from __future__ import annotations

from typing import Any


class VpcalError(Exception):
    """Base class for all vpcal domain errors.

    Adapters (CLI/MCP/HTTP) translate this into the shared error envelope and
    the process exit code.  Never raised directly — use a concrete subclass.
    """

    exit_code: int = 1
    code: str = "RUNTIME_ERROR"
    retryable: bool = False

    def __init__(
        self,
        message: str,
        *,
        details: dict[str, Any] | None = None,
        retryable: bool | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}
        if retryable is not None:
            self.retryable = retryable


class RuntimeFailure(VpcalError):
    """Unclassified runtime / internal error (exit 1)."""

    exit_code = 1
    code = "RUNTIME_ERROR"


class ArgumentError(VpcalError):
    """CLI usage / argument syntax / schema validation error (exit 2)."""

    exit_code = 2
    code = "ARG_VALIDATION"


class ConfigError(VpcalError):
    """Config file missing, malformed, or semantically invalid (exit 3)."""

    exit_code = 3
    code = "CONFIG_ERROR"


class ResourceNotFoundError(VpcalError):
    """A referenced input file/directory does not exist (exit 5)."""

    exit_code = 5
    code = "RESOURCE_NOT_FOUND"


class PreconditionError(VpcalError):
    """A precondition for the operation failed (exit 6).

    vpcal cases: too few poses (<3), no usable observations, image-tracking
    frame alignment failure, unsupported lens model (k4/k5/k6).
    """

    exit_code = 6
    code = "PRECONDITION_FAILED"


class SolverTimeoutError(VpcalError):
    """Solver exceeded its configured time budget (exit 7)."""

    exit_code = 7
    code = "TIMEOUT"
    retryable = True


class PartialFailure(VpcalError):
    """Operation completed but the result is low-confidence (exit 9).

    vpcal case: solver converged but total observations < 50.
    """

    exit_code = 9
    code = "PARTIAL_FAILURE"


__all__ = [
    "VpcalError",
    "RuntimeFailure",
    "ArgumentError",
    "ConfigError",
    "ResourceNotFoundError",
    "PreconditionError",
    "SolverTimeoutError",
    "PartialFailure",
]
