# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`tracksim` is a **camera-tracking signal simulator**: it synthesizes a virtual camera pose (from an Xbox controller, a scripted/procedural motion, or a fixed value) and emits it live over UDP/serial in two protocols — **FreeD** (29-byte D1 message) and **OpenTrackIO** (OTrk-framed JSON/CBOR) — so render targets like Unreal Engine / Disguise can be tested without real tracking hardware. Only **Phase 1 (CLI)** exists; it is fully built and merged.

This is the **producer** counterpart to the rest of the parent VP-calibration workspace: `../opentrackio-cpp` is the *consumer*, `../ris-osvp-metadata-camdkit` (camdkit) is the *data-model authority*, and the authoritative specs live in `../docs/` (`freed-doc.md` Appendix A/B for the FreeD encoder, `OpenTrackIO.md` / `OpenTrackIO_JSON_schema.json`, and `CLI_DESIGN_SPEC.md` — the house CLI standard this project obeys).

Unlike its sibling sub-projects, **`tracksim` is its own git repo** (`github.com/lanbipu/tracksim`, branch `main`); the parent workspace's "not under git" note does not apply here.

## Build, test, run

Python **≥ 3.11** (`tomllib`, PEP 604 unions). The suite relies on an **editable install** — `conftest.py` deliberately does no `sys.path` hacking, and `test_install_smoke.py` asserts the package is genuinely installed.

```bash
pip install -e ".[dev]"           # runtime deps + pytest, jsonschema. REQUIRED before anything works.
pytest                            # full suite — run from the repo ROOT (so `from tests.fakes import …` resolves)
pytest tests/test_simulator_run.py::test_run_emits_started_ticks_stopped_in_order   # single test
pytest tests/test_cli_conformance.py -q   # black-box subprocess conformance (localhost UDP loopback; SDL cases auto-skip)
pytest -k fix38                   # one adversarial-review regression guard

tracksim --help                   # console-script entry (project.scripts: tracksim = tracksim.cli.main:main)
python -m tracksim --help         # module entry (__main__.py)
AI_AGENT=1 tracksim version       # agent profile: output defaults to JSON without --output
tracksim send --protocol freed --pan 10 -o json    # one-shot discrete send (the primary CI / agent entry; no controller)
tracksim run --source script --rate 20 --duration 0.1 -o ndjson   # bounded streaming run
```

There is **no `[tool.pytest.ini_options]`** and no fixtures in `conftest.py`. SDL3-dependent tests `pytest.importorskip("sdl3")` and skip when the SDL3 runtime is absent.

`docs/tracksim-CLI-运行流程.md` walks every command in user-flow order with expected outputs and verification checks — the reference for exercising or validating the CLI by hand.

## Architecture

A textbook **hexagonal / ports-and-adapters** layout, governed by `../docs/CLI_DESIGN_SPEC.md` (AI-Native App Interface Spec). Dependency rule is strictly inward: `domain/` depends on nothing → `ports/` (the IO seams) → adapters (`infra/`, `sources/`, `emitters/`, `transports/`) → `cli/` is the composition root. **`cli/` is the only adapter today**; MCP/GUI are reserved later phases — so keep protocol/business logic out of `cli/` and IO out of everything except ports/adapters.

**Layers and the seams (`ports/` — five `typing.Protocol`s, NOT ABCs; adapters satisfy them structurally, never subclass):**

| Port | Contract | Adapters |
|------|----------|----------|
| `PoseSource` | `next(dt) -> CameraPose`, `close()` | `sources/`: `Static`, `Scripted` (orbit/sine/sweep + keyframe lerp), `Controller` |
| `Emitter` | `name: str`, `emit(pose)`, `close()` (owns one `Transport`) | `emitters/`: `FreeDEmitter`, `OpenTrackIOEmitter` |
| `Transport` | `send(bytes)`, `close()` | `transports/`: `UdpTransport` (uni/multi/broadcast), `SerialTransport` |
| `Clock` | `now()`, `sleep()` | `infra/clock.py`: `WallClock`, `FakeClock` (sleep advances virtual time — the test determinism seam) |
| `ControllerInput` | `list_devices/open/poll/close` | `infra/sdl_controller.py`: `SDLControllerInput` only |

**Domain — `CameraPose` (`domain/pose.py`):** the single canonical pose (physical units: pan/tilt/roll °, x/y/z m, focal_length mm, focus_distance m, optional iris/entrance_pupil, plus frame/timestamp/rate). Plain **Pydantic v2 `BaseModel`** — *not* camdkit's `CompatibleBaseModel`; this is a standalone project. Validators reject NaN/±inf on all required floats. Both encoders consume this one object.

**Services — `Simulator` (`simulator.py`):** a generator `run()` yielding a tagged union `SimStarted | SimTick | SimWarning | SimStopped`. Each tick: `source.next(1/rate)` → `_emit_all(pose)` fans the same pose to every emitter → `clock.sleep(dt)`. `_emit_all` catches **only `TransportError`** per-emitter: with `fail_fast=False` (the default) a dead sink degrades to a `SimWarning` and the loop continues. The simulator never bounds itself — boundedness is imposed externally (see `run --duration` / signals below).

**The central tension and its resolution:** `CLI_DESIGN_SPEC` is built for *discrete* operations (one input → one output envelope), but a simulator is a *long-running stream* (30–60 Hz). Resolution: **`run` and `controllers monitor` split by output format.** Only `--output ndjson` (alias `stream-json`) streams live sequenced lines via `render.NdjsonWriter` (start/progress/warning/result). Under `--output json|text` the stream functions get `writer=None`, write **nothing** mid-run, accumulate a summary, and `main` emits exactly **one** envelope. Every other command is one-shot.

**The contract spine (`envelope.py`):** every command function returns `(operation_id, data)`; `main` wraps it via `success_envelope` / `error_envelope`. Success = `{schema_version, status:"ok", operation_id, data, meta:{request_id, duration_ms, timestamp}}`; error swaps `data` for `error:{code, exit_code, message, retryable, details}`. `request_id`/`timestamp` are minted once in `main` and threaded through every line.

**Error model is data-driven:** every domain error subclasses `TracksimError` (`domain/errors.py`) carrying class attrs `code` / `exit_code` / `retryable`. `main` has a single `except TracksimError` → `emit_error` → `return exc.exit_code`. Adding an error type = new subclass with the right attrs; `main` needs no change. `EXIT_*` constants in `envelope.py` mirror those exit codes (2 usage, 3 config, 6 conflict, 10 no-controller, 11 transport*, 12 unsupported, 13 invalid-input, 130 SIGINT). `TransportError` is the only `retryable=True`.

**Wiring seam — `cli/commands/factory.py`:** `build_emitters` / `build_source` map `Config` + protocol strings to concrete adapters, closing partially-built objects on failure (no leaked sockets/serial handles). `validate_config_enums()` is the **single** enum/range validation stage, called by *both* `build_emitters` and `config validate`. The factory is deliberately **device-agnostic** — it knows only `static`/`script`; `run --source controller` is special-cased in `main._dispatch` (it opens SDL itself) so the factory stays hardware-free and testable.

**Config (`config.py`):** nested Pydantic models, loaded by `load_config` as `defaults < file < overrides` deep-merge, dispatching on extension (`.toml`/`.yaml`/`.json`). Pydantic checks **types only** — valid *values* are checked separately by `validate_config_enums`, so a config that loads can still be rejected at build time.

**The two emitters (the workspace protocol theme, concrete):**
- **FreeD** (`emitters/freed.py`): fixed **29-byte type-`0xD1`** message, big-endian; three s24 angles, three s24 positions, u24 zoom+focus, u16 spare, checksum `[28] = (0x40 - Σ bytes[0:28]) & 0xFF`. Angles ×`32768/deg`, positions ×`64000/m` (config `[freed].scaling`). **zoom/focus are derived from the pose's lens fields**: `zoom_raw = round(pose.focal_length[mm] × zoom_lsb_per_mm)`, `focus_raw = round(pose.focus_distance[m] × focus_lsb_per_m)`, saturated to u24 (config `[freed].scaling`, default lsb `1000`; set an lsb to `0` to disable that field / restore the old always-zero behavior). The lsb defaults are calibration starting points — tune against the receiver's lens calibration (Unreal/Disguise).
- **OpenTrackIO** (`emitters/opentrackio.py`): builds a plain dict conforming to the SMPTE schema (`PROTOCOL_VERSION = [1,0,1]`), serialized JSON (`0x01`) or CBOR (`0x02`), then framed by `build_packets()` in the **16-byte `OTrk` UDP header** + **Fletcher-16** (`checksum.py`), auto-segmenting at 1484 bytes. `sampleId`/`sourceId` are deterministic UUIDv5.

## Gotchas

- **Three independent version numbers.** `SCHEMA_VERSION` (envelope shape) and `CONTRACT_VERSION` (CLI surface + exit semantics) are both `"1.0"` in `envelope.py` but are *not* the same thing — don't collapse them. The package version is a third value: `"0.1.0"` (`pyproject` / `tracksim.__version__` / `meta.py::VERSION`). README.md and CHANGELOG.md are tested to literally contain the string `contract_version 1.0` — don't remove it.
- **`tracksim` does NOT depend on camdkit.** Runtime deps are only `pydantic, pysdl3, pyserial, cbor2, pyyaml`. The OTrk header and `fletcher16` were *copied/ported* from camdkit's reference (`opentrackio_sender`/`opentrackio_lib`), and the OpenTrackIO sample is a hand-built dict validated against the **vendored** `tests/resources/OpenTrackIO_JSON_schema.json`. (The design doc's "use camdkit Clip as a dependency" describes intent, not the shipped code.)
- **Error envelopes go to STDOUT, not stderr.** Only the human log line goes to stderr. Consumers read stdout for both success and error JSON.
- **Streaming is ndjson-only, for `run` and `controllers monitor` only.** Under `--output json` those commands must still emit a **single** JSON object (`json.loads(stdout)` must not raise) — regression guard F2. `writer is None` ⇒ buffer-and-summarize.
- **Global flags are dual-mounted** (real defaults on root parser + an `argparse.SUPPRESS` copy on every subparser via `parents=[gp]`) so `--output`/`--dry-run`/`--config` work *before or after* the subcommand without clobbering already-parsed values. This is the documented argparse `parents` footgun (fix F1) — don't "simplify" away the suppress copy.
- **Frame counts use `math.ceil`, not `round`** (`max(1, ceil(duration*rate))`) so any positive `--duration` sends ≥ 1 frame (fix F8).
- **OTrk `sequence` increments per-packet, not per-sample** — `emit()` advances by `len(packets)`; camdkit receivers dedupe by sequence (fix F6).
- **SDL is quarantined.** `infra/sdl_controller.py` is the *only* module allowed to `import sdl3`, deferred inside `_ensure_sdl()` so the package imports fine without PySDL3. Controller logic is otherwise tested via `tests/fakes.py`. `run --source controller` with no device must exit **10** (NO_CONTROLLER), not 12 — it must reach SDL, not fall through the factory (fix F5). **Microsoft GameInput was explicitly rejected** as the primary backend (no macOS, no Python bindings); don't re-propose it except as a future Windows-only backend behind the port.
- **The `tests/test_fixN_*.py` files (1–38) are immutable behavioral contracts** — one adversarial-review (Codex) finding each, usually pinned to an exact exit code. Don't merge or "simplify" them.
- **No test touches the network.** "Network" in the conformance suite is `127.0.0.1` UDP loopback; the schema is read from disk (no `$ref`/HTTPS resolution). This differs from sibling `opentrackio-cpp`, whose tests *do* hit live SMPTE over HTTPS.
- **Cross-test imports are `from tests.fakes import …`** — requires running pytest from the repo root (the `tests/` package has `__init__.py`). When monkeypatching, patch in the *consumer* namespace: `tracksim.cli.main.load_config`, not `tracksim.config.load_config`.
- **The operation registry is hand-maintained in three places that must stay in sync:** `manifest.py::_OPERATIONS`, `main.py::_operation_id_for`, and the argparse tree in `build_parser`.
- **Three values were deliberately left un-pinned** (design §13) and may need confirming against the live target: FreeD scaling constants (vs Unreal Live Link FreeD; config offers `native`/`radamec`), OpenTrackIO multicast-vs-unicast + JSON-vs-CBOR, and the default controller axis/button mapping.

## Source of truth

`docs/superpowers/specs/2026-06-02-tracksim-design.md` (the design contract — purpose, layering, the SDL3 decision + GameInput rejection, encoding details, exit-code table, config sections, §13 open items) and `docs/superpowers/plans/2026-06-02-tracksim-phase1.md` (the ~46-task TDD plan with full per-module code and the F1–F8 fix log). TDD (red → green → commit) is the mandated workflow for this project.
