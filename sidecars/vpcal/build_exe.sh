#!/usr/bin/env bash
# Build a single-file macOS executable for the `vpcal` sidecar with PyInstaller.
#
# Usage: ./build_exe.sh
# Output: <workspace-root>/target/sidecar-vendor/<platform>/vpcal
#
# Output dir MUST be the WORKSPACE-ROOT `target/sidecar-vendor/<platform>/` —
# the same layout src-tauri/src/commands/sidecars.rs::locate() searches (and
# mesh-vba's build_exe.sh writes to). SCRIPT_DIR is `sidecars/vpcal`, so the
# workspace root is TWO levels up.
#
# Uses the sidecar's own .venv (which must carry the `dev` extra, incl.
# pyinstaller>=6.0). The compiled pybind11/Ceres module (if built) is collected
# from the installed `vpcal` package; absent it, vpcal falls back to scipy.
# Re-runnable: stale build/spec dirs are wiped first.
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
rm -f "$OUT/vpcal"
mkdir -p "$OUT" "$WORK"

# Collection notes:
#   --collect-all cv2          : opencv ships native .so PyInstaller's graph misses.
#   --collect-submodules scipy : scipy.optimize / scipy.sparse are imported lazily.
#   --collect-submodules vpcal : Click subcommands + the compiled solver module
#                                are imported dynamically, so force-collect them.
"$VENV/bin/pyinstaller" \
    --onefile \
    --name vpcal \
    --distpath "$OUT" \
    --workpath "$WORK" \
    --specpath "$WORK" \
    --collect-all cv2 \
    --collect-submodules scipy \
    --collect-submodules vpcal \
    --paths "$SCRIPT_DIR/src" \
    "$SCRIPT_DIR/src/vpcal/cli/main.py"

echo "Built: $OUT/vpcal"
