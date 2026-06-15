#!/usr/bin/env bash
# Build a single-file macOS executable for the `tracksim` sidecar with PyInstaller.
#
# Usage: ./build_exe.sh
# Output: <workspace-root>/target/sidecar-vendor/<platform>/tracksim
#
# Output dir MUST be the WORKSPACE-ROOT `target/sidecar-vendor/<platform>/` —
# the same layout src-tauri/src/commands/sidecars.rs::locate() searches.
# SCRIPT_DIR is `sidecars/tracksim`, so the workspace root is TWO levels up.
#
# Uses the sidecar's own .venv (which must carry the `dev` extra, incl.
# pyinstaller>=6.0). pysdl3 ships a bundled SDL3 native lib that PyInstaller's
# static graph misses, so it is force-collected. Re-runnable: stale build/spec
# dirs are wiped first.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VENV="$SCRIPT_DIR/.venv"

if [[ ! -x "$VENV/bin/pyinstaller" ]]; then
    echo "error: $VENV/bin/pyinstaller not found." >&2
    echo "Install the dev extra into the sidecar venv first, e.g.:" >&2
    echo "  python3.11 -m venv $VENV && $VENV/bin/pip install -e '$SCRIPT_DIR[dev]'" >&2
    exit 1
fi

case "$(uname -s)/$(uname -m)" in
    Darwin/arm64) PLATFORM="darwin-arm64" ;;
    Darwin/x86_64) PLATFORM="darwin-x86_64" ;;
    Linux/x86_64) PLATFORM="linux-x86_64" ;;
    *) echo "unsupported platform: $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac

OUT="$ROOT/target/sidecar-vendor/$PLATFORM"
WORK="$SCRIPT_DIR/build/pyinstaller"

rm -rf "$WORK"
rm -f "$OUT/tracksim"
mkdir -p "$OUT" "$WORK"

# Collection notes:
#   --collect-all sdl3         : pysdl3 bundles the SDL3 native lib + ctypes
#                                bindings the static graph misses.
#   --collect-submodules tracksim : argparse subcommands + protocol/controller
#                                modules are imported dynamically.
"$VENV/bin/pyinstaller" \
    --onefile \
    --name tracksim \
    --distpath "$OUT" \
    --workpath "$WORK" \
    --specpath "$WORK" \
    --collect-all sdl3 \
    --collect-submodules tracksim \
    --paths "$SCRIPT_DIR/src" \
    "$SCRIPT_DIR/src/tracksim/__main__.py"

echo "Built: $OUT/tracksim"
