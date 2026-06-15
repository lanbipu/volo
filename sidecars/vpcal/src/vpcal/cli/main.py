"""vpcal CLI — LED Virtual Production geometric/spatial calibration toolkit.

CLI adapter entry point.  Implements the mandatory self-describe commands
(`manifest`, `schema`, `completion`, `version`) and wires up the operation
subcommands.  See CLI_DESIGN_SPEC.md for the contract this adapter satisfies.
"""

from __future__ import annotations

import sys

import click

from vpcal import __version__
from vpcal.cli._common import OperationOutput, common_options, run_operation
from vpcal.cli.export import export
from vpcal.cli.pattern import pattern
from vpcal.cli.capture import capture
from vpcal.cli.quick import quick
from vpcal.cli.report import report
from vpcal.cli.screen import screen
from vpcal.cli.simulate import simulate
from vpcal.cli.tracker_free import tracker_free

_VERSION = __version__


@click.group()
@click.option(
    "--output",
    "-o",
    type=click.Choice(["text", "json", "ndjson", "stream-json"], case_sensitive=False),
    default=None,
    help="Default output format for subcommands.",
)
@click.option(
    "--log-level",
    type=click.Choice(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"], case_sensitive=False),
    default=None,
    help="Set the logging level.",
)
@click.option("--no-color", is_flag=True, help="Disable coloured output.")
@click.version_option(_VERSION, "--version", message="%(version)s")
@click.pass_context
def cli(ctx: click.Context, output: str | None, log_level: str | None, no_color: bool) -> None:
    """vpcal — Virtual Production spatial calibration toolkit."""
    ctx.ensure_object(dict)
    ctx.obj["output"] = output
    ctx.obj["log_level"] = log_level
    ctx.obj["no_color"] = no_color


# ── Operation subcommands ────────────────────────────────────────────
cli.add_command(quick)
cli.add_command(pattern)
cli.add_command(screen)
cli.add_command(simulate)
cli.add_command(report)
cli.add_command(export)
cli.add_command(tracker_free)
cli.add_command(capture)


# ── Self-describe / meta commands ────────────────────────────────────


@cli.command()
@common_options
@click.pass_context
def manifest(ctx: click.Context, **flags: object) -> None:
    """Emit the Contract Manifest JSON (canonical operation_id source)."""

    def body() -> OperationOutput:
        from vpcal.models.manifest import build_manifest

        data = build_manifest().model_dump(mode="json")
        ops = "\n".join(
            f"  {o['operation_id']:<22} {o['cli']['command']}" for o in data["operations"]
        )
        text = f"vpcal contract manifest (version {data['contract_version']})\n{ops}"
        return OperationOutput(data=data, text=text)

    run_operation("manifest", body, **flags)


@cli.command()
@common_options
@click.pass_context
def schema(ctx: click.Context, **flags: object) -> None:
    """Print JSON Schemas for the session config and calibration result."""

    def body() -> OperationOutput:
        from vpcal.models.calibration import CalibrationResult
        from vpcal.models.session import SessionConfig

        data = {
            "session_config": SessionConfig.model_json_schema(),
            "calibration_result": CalibrationResult.model_json_schema(),
        }
        text = "Schemas: session_config, calibration_result (use --output json for full JSON Schema)."
        return OperationOutput(data=data, text=text)

    run_operation("schema", body, **flags)


@cli.command()
@click.argument("shell", type=click.Choice(["bash", "zsh", "fish"]), required=False, default="bash")
@click.pass_context
def completion(ctx: click.Context, shell: str) -> None:
    """Generate a shell completion script (bash | zsh | fish)."""
    from click.shell_completion import get_completion_class

    comp_cls = get_completion_class(shell)
    if comp_cls is None:
        raise click.ClickException(f"Unsupported shell: {shell}")
    comp = comp_cls(cli, {}, "vpcal", "_VPCAL_COMPLETE")
    click.echo(comp.source())


@cli.command()
@common_options
@click.pass_context
def version(ctx: click.Context, **flags: object) -> None:
    """Print version information."""

    def body() -> OperationOutput:
        data = {"name": "vpcal", "version": _VERSION}
        return OperationOutput(data=data, text=f"vpcal {_VERSION}")

    run_operation("version", body, **flags)


def _argv_output_format(argv: list[str]) -> str:
    """Best-effort resolve --output for error reporting before click parses."""
    import os

    for i, a in enumerate(argv):
        if a in ("--output", "-o") and i + 1 < len(argv):
            return argv[i + 1].lower()
        if a.startswith("--output="):
            return a.split("=", 1)[1].lower()
    return "json" if os.environ.get("AI_AGENT") == "1" else "text"


def main(argv: list[str] | None = None) -> None:
    """Console entry point.

    Wraps click so that argument/usage errors (exit 2) still emit a valid JSON
    error envelope on stdout in json mode (CLI_DESIGN_SPEC §12.3 conformance).
    """
    import json
    import uuid
    from datetime import datetime, timezone

    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        # standalone_mode=False makes click *return* the exit code (from ctx.exit)
        # instead of calling sys.exit; propagate it as the process exit status.
        rv = cli.main(args=argv, standalone_mode=False)
        if isinstance(rv, int) and rv != 0:
            sys.exit(rv)
    except click.exceptions.Exit as exc:
        sys.exit(exc.exit_code)
    except click.exceptions.Abort:
        sys.exit(130)
    except click.UsageError as exc:
        fmt = _argv_output_format(argv)
        exit_code = exc.exit_code if exc.exit_code else 2
        if fmt in ("json", "ndjson", "stream-json"):
            envelope = {
                "schema_version": "1.0",
                "status": "error",
                "operation_id": "cli",
                "error": {
                    "code": "ARG_VALIDATION",
                    "exit_code": exit_code,
                    "message": exc.format_message(),
                    "retryable": False,
                    "details": {},
                },
                "meta": {
                    "request_id": str(uuid.uuid4()),
                    "duration_ms": 0,
                    "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                },
            }
            click.echo(json.dumps(envelope, ensure_ascii=False))
        else:
            click.echo(exc.format_message(), err=True)
        sys.exit(exit_code)


if __name__ == "__main__":
    main()
