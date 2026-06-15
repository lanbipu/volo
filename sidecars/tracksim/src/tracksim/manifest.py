from __future__ import annotations

from typing import Any

from tracksim.envelope import CONTRACT_VERSION

_OPERATIONS: list[dict[str, str]] = [
    {"operation_id": "sim.run", "summary": "Stream camera poses to enabled protocols (long-running)"},
    {"operation_id": "sim.send", "summary": "Send a single frame or hold a fixed pose for a duration"},
    {"operation_id": "sim.convert", "summary": "Convert an FBX camera animation to track.json"},
    {"operation_id": "controllers.list", "summary": "Enumerate connected game controllers"},
    {"operation_id": "controllers.monitor", "summary": "Stream raw controller axis/button values"},
    {"operation_id": "config.init", "summary": "Generate a default configuration file"},
    {"operation_id": "config.show", "summary": "Show the effective merged configuration"},
    {"operation_id": "config.validate", "summary": "Validate a configuration file"},
    {"operation_id": "freed.decode", "summary": "Decode a FreeD packet into fields"},
    {"operation_id": "opentrackio.decode", "summary": "Decode an OpenTrackIO packet into fields"},
    {"operation_id": "meta.manifest", "summary": "Output the contract manifest"},
    {"operation_id": "meta.schema", "summary": "Output the CLI structure JSON schema"},
    {"operation_id": "meta.version", "summary": "Output version metadata"},
    {"operation_id": "meta.completion", "summary": "Output shell completion script"},
]


def build_manifest() -> dict[str, Any]:
    return {
        "contract_version": CONTRACT_VERSION,
        "operations": [dict(op) for op in _OPERATIONS],
    }
