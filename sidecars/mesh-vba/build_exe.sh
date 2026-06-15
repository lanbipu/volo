#!/usr/bin/env bash
# Build a single-file macOS arm64 executable with PyInstaller.
#
# Usage: ./build_exe.sh
# Output: target/sidecar-vendor/darwin-arm64/lmt-vba-sidecar
#
# The output platform dir must match crates/adapter-visual-ba/src/locate.rs
# platform_dir() so the Rust locator finds the vendored binary.
#
# Uses the sidecar's own .venv (which carries the `dev` extra, including
# pyinstaller>=6.0). Re-runnable: stale build/spec dirs are wiped first.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV="$SCRIPT_DIR/.venv"

if [[ ! -x "$VENV/bin/pyinstaller" ]]; then
    echo "error: $VENV/bin/pyinstaller not found." >&2
    echo "Install the dev extra into the sidecar venv first, e.g.:" >&2
    echo "  python3.12 -m venv $VENV && $VENV/bin/pip install -e '$SCRIPT_DIR[dev]'" >&2
    exit 1
fi

case "$(uname -m)" in
    arm64) PLATFORM="darwin-arm64" ;;
    x86_64) PLATFORM="darwin-x86_64" ;;
    *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

OUT="$ROOT/target/sidecar-vendor/$PLATFORM"
# Keep PyInstaller's intermediate build + spec out of the source tree.
WORK="$SCRIPT_DIR/build"

# Re-runnable: clean stale outputs so a rebuild never picks up old graph state.
rm -rf "$WORK"
rm -f "$OUT/lmt-vba-sidecar"
mkdir -p "$OUT" "$WORK"

# Hidden imports / data collection notes:
#   --collect-all cv2          : opencv-contrib ships native .so + cv2.aruco
#                                submodules PyInstaller's graph misses.
#   --collect-submodules scipy : scipy.optimize / scipy.sparse (+ their
#                                C-extension validation helpers) are imported
#                                lazily and must be force-collected.
#   --collect-submodules lmt_vba_sidecar : our own subcommand modules are
#                                imported via importlib at runtime, so the
#                                static graph never sees them.
"$VENV/bin/pyinstaller" \
    --onefile \
    --name lmt-vba-sidecar \
    --distpath "$OUT" \
    --workpath "$WORK" \
    --specpath "$WORK" \
    --collect-all cv2 \
    --collect-submodules scipy \
    --collect-submodules lmt_vba_sidecar \
    --paths "$SCRIPT_DIR/src" \
    "$SCRIPT_DIR/src/lmt_vba_sidecar/__main__.py"

echo "Built: $OUT/lmt-vba-sidecar"
