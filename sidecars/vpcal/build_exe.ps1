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
$solverDir = Join-Path $venv 'Lib/site-packages/vpcal'

if (-not (Test-Path $pyinstaller)) {
    Write-Error @"
$pyinstaller not found.
Install the dev and ndi extras into the sidecar venv first, e.g.:
  python -m venv $venv; & '$venv/Scripts/pip.exe' install -e '$PSScriptRoot[dev,ndi]'
"@
}

$solverModules = @(Get-ChildItem -LiteralPath $solverDir -Filter '_vpcal_solver*.pyd' -File -ErrorAction SilentlyContinue)
if ($solverModules.Count -ne 1) {
    Write-Error "Expected exactly one compiled vpcal solver in $solverDir; found $($solverModules.Count). Reinstall the sidecar before packaging."
}
$solverModule = $solverModules[0].FullName

$out = Join-Path $root 'target/sidecar-vendor/windows-x86_64'
$work = Join-Path $PSScriptRoot 'build/pyinstaller'

if (Test-Path $work) { Remove-Item -Recurse -Force $work }
$exe = Join-Path $out 'vpcal.exe'
if (Test-Path $exe) { Remove-Item -Force $exe }
New-Item -ItemType Directory -Force -Path $out | Out-Null
New-Item -ItemType Directory -Force -Path $work | Out-Null

# cyndilib bundles Processing.NDI.Lib.x64.dll under wrapper/bin. Collecting
# the whole package keeps that runtime beside the frozen Python modules.
# The editable install keeps the compiled solver under site-packages while
# --paths points PyInstaller at src, so include the extension explicitly.
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
    --add-binary "$solverModule;vpcal" `
    --paths "$PSScriptRoot/src" `
    "$PSScriptRoot/src/vpcal/cli/main.py"

Write-Host "Built: $exe"
