# lmt-vba-sidecar

Visual back-calculation sidecar for LED Mesh Toolkit M2.
Spawned as a one-shot subprocess by `lmt-adapter-visual-ba`.

## Subcommands
- `calibrate` — checkerboard images → intrinsics.json
- `generate_pattern` — project YAML → per-cabinet PNG + assembled PNG + meta JSON
- `reconstruct` — images + intrinsics → MeasuredPoints (NDJSON on stdout)

## Dev usage

Requires Python ≥3.10, <3.13 (pinned in `pyproject.toml`).
On macOS install via Homebrew: `brew install python@3.12`.

```bash
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e .[dev]
pytest
```

CI uses Python 3.11 on the matrix (`ubuntu-22.04`, `macos-14`,
`windows-latest`), see `.github/workflows/m2-sidecar-build.yml`.

## IPC

stdin: one-shot JSON command. stdout: NDJSON event stream
(`progress` / `warning` / `result` / `error`). Schema:
`schema/ipc.schema.json`.
