# Build a single-file Windows x86_64 executable with PyInstaller.
#
# Usage: pwsh -File build_exe.ps1
# Output: target\sidecar-vendor\windows-x86_64\lmt-vba-sidecar.exe
#
# The output platform dir must match crates/adapter-visual-ba/src/locate.rs
# platform_dir() so the Rust locator finds the vendored binary.
#
# Mirror of build_exe.sh: uses the sidecar's own .venv (carrying the `dev`
# extra, including pyinstaller>=6.0) and the same hidden-import flags.
# UNVERIFIED on macOS — exercised by Windows CI (Task 3.5).
$ErrorActionPreference = 'Stop'

$root = Resolve-Path "$PSScriptRoot/.."
$venv = "$PSScriptRoot/.venv"
$pyinstaller = Join-Path $venv 'Scripts/pyinstaller.exe'

if (-not (Test-Path $pyinstaller)) {
    # $ErrorActionPreference='Stop' makes Write-Error terminate the script.
    Write-Error @"
$pyinstaller not found.
Install the dev extra into the sidecar venv first, e.g.:
  python -m venv $venv; & '$venv/Scripts/pip.exe' install -e '$PSScriptRoot[dev]'
"@
}

$out = Join-Path $root 'target/sidecar-vendor/windows-x86_64'
# Keep PyInstaller's intermediate build + spec out of the source tree.
$work = Join-Path $PSScriptRoot 'build'

# Re-runnable: clean stale outputs so a rebuild never picks up old graph state.
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
$exe = Join-Path $out 'lmt-vba-sidecar.exe'
if (Test-Path $exe) { Remove-Item -Force $exe }
New-Item -ItemType Directory -Force -Path $out | Out-Null
New-Item -ItemType Directory -Force -Path $work | Out-Null

# Hidden imports / data collection notes (same rationale as build_exe.sh):
#   --collect-all cv2          : opencv-contrib native libs + cv2.aruco submodules.
#   --collect-submodules scipy : scipy.optimize / scipy.sparse + C-ext helpers.
#   --collect-submodules lmt_vba_sidecar : our subcommand modules load via importlib.
& $pyinstaller `
    --onefile `
    --name lmt-vba-sidecar `
    --distpath $out `
    --workpath $work `
    --specpath $work `
    --collect-all cv2 `
    --collect-submodules scipy `
    --collect-submodules lmt_vba_sidecar `
    --paths "$PSScriptRoot/src" `
    "$PSScriptRoot/src/lmt_vba_sidecar/__main__.py"

Write-Host "Built: $exe"
