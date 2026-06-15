# Single-host snapshot of UE installs, RenderStream plugin version, default RHI,
# GPU/Driver, and project paths on common drives. JSON to stdout.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# Takes no args. Output: JSON { ok, data }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
# Best-effort snapshot: body uses -ErrorAction SilentlyContinue + try/catch and ran
# under the remote session's default 'Continue' before. Do NOT use 'Stop' here.
$ErrorActionPreference = 'Continue'

try {
    # UE installs: read registry
    $ueInstalls = @()
    $keyPaths = @('HKLM:\SOFTWARE\EpicGames\Unreal Engine', 'HKLM:\SOFTWARE\WOW6432Node\EpicGames\Unreal Engine')
    foreach ($p in $keyPaths) {
        if (Test-Path $p) {
            $versions = Get-ChildItem $p -ErrorAction SilentlyContinue
            foreach ($v in $versions) {
                $installed = (Get-ItemProperty -Path $v.PSPath -Name 'InstalledDirectory' -ErrorAction SilentlyContinue).InstalledDirectory
                if ($installed) {
                    $ueInstalls += [pscustomobject]@{
                        Version = $v.PSChildName
                        Path    = $installed
                    }
                }
            }
        }
    }

    # GPU/Driver from Win32_VideoController
    $gpu = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object -First 1
    $gpuInfo = if ($gpu) {
        [pscustomobject]@{
            Name = $gpu.Name; Driver = $gpu.DriverVersion; DriverDate = "$($gpu.DriverDate)"
        }
    } else { $null }

    # Default RHI from CurrentUser preference (best effort)
    $rhi = $null
    try {
        $defaultGraphicsRHI = Get-ItemProperty -Path 'HKCU:\Software\Epic Games\Unreal Engine\Settings' -Name 'DefaultGraphicsRHI' -ErrorAction SilentlyContinue
        if ($defaultGraphicsRHI) { $rhi = $defaultGraphicsRHI.DefaultGraphicsRHI }
    } catch {}

    # Project root candidates
    $projectDirs = @()
    foreach ($drive in @('C:', 'D:', 'E:', 'F:')) {
        $candidates = @("$drive\Projects", "$drive\RenderStream Projects", "$drive\Unreal Projects")
        foreach ($c in $candidates) {
            if (Test-Path -LiteralPath $c) {
                $children = Get-ChildItem -LiteralPath $c -Directory -ErrorAction SilentlyContinue | Select-Object -First 50
                foreach ($child in $children) {
                    $uproject = Get-ChildItem -LiteralPath $child.FullName -Filter '*.uproject' -ErrorAction SilentlyContinue | Select-Object -First 1
                    if ($uproject) {
                        $projectDirs += [pscustomobject]@{ Path = $child.FullName; UProject = $uproject.Name }
                    }
                }
            }
        }
    }

    # RenderStream plugin version (look for d3 install)
    $rsVersion = $null
    try {
        $d3 = Get-ItemProperty -Path 'HKLM:\SOFTWARE\d3 Technologies\d3 Production Suite' -ErrorAction SilentlyContinue
        if ($d3 -and $d3.Version) { $rsVersion = $d3.Version }
    } catch {}

    $data = @{
        ue_installs          = $ueInstalls
        gpu                  = $gpuInfo
        rhi                  = $rhi
        projects             = $projectDirs
        renderstream_version = $rsVersion
        host                 = $env:COMPUTERNAME
    }
    @{ ok = $true; data = $data } | ConvertTo-Json -Compress -Depth 6
}
catch {
    @{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
