# Build a single-file Windows x86_64 executable with PyInstaller.
#
# Usage: pwsh -File build_exe.ps1
# Output: target\sidecar-vendor\windows-x86_64\vpcal.exe
#
# The output platform dir must match src-tauri/src/commands/sidecars.rs
# platform_dir() so the Rust locator finds the vendored binary.
$ErrorActionPreference = 'Stop'

$root = Resolve-Path "$PSScriptRoot/../.."
$venv = "$PSScriptRoot/.venv"
$pyinstaller = Join-Path $venv 'Scripts/pyinstaller.exe'

if (-not (Test-Path $pyinstaller)) {
    Write-Error @"
$pyinstaller not found.
Install the dev and ndi extras into the sidecar venv first, e.g.:
  python -m venv $venv; & '$venv/Scripts/pip.exe' install -e '$PSScriptRoot[dev,ndi]'
"@
}

$out = Join-Path $root 'target/sidecar-vendor/windows-x86_64'
$work = Join-Path $PSScriptRoot 'build/pyinstaller'

if (Test-Path $work) { Remove-Item -Recurse -Force $work }
$exe = Join-Path $out 'vpcal.exe'
if (Test-Path $exe) { Remove-Item -Force $exe }
New-Item -ItemType Directory -Force -Path $out | Out-Null
New-Item -ItemType Directory -Force -Path $work | Out-Null

# cyndilib bundles Processing.NDI.Lib.x64.dll under wrapper/bin. Collecting
# the whole package keeps that runtime beside the frozen Python modules.
& $pyinstaller `
    --onefile `
    --name vpcal `
    --distpath $out `
    --workpath $work `
    --specpath $work `
    --collect-all cyndilib `
    --collect-all cv2 `
    --collect-submodules scipy `
    --collect-submodules vpcal `
    --paths "$PSScriptRoot/src" `
    "$PSScriptRoot/src/vpcal/cli/main.py"

Write-Host "Built: $exe"
