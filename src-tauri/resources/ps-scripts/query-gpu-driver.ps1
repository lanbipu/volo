# Queries GPU model + driver version via WMI.
# Output: JSON array of { gpu_model, driver_version, vendor, vram_mb }
# Designed to run as a node-pure script over SSH.
#
# VRAM source order (closes Plan 2 lesson L7 - RTX 3080 reporting 4095 MB):
#   1. Display class registry HardwareInformation.qwMemorySize (REG_QWORD,
#      authoritative on modern drivers; not subject to WMI's 4 GB cap)
#   2. HardwareInformation.MemorySize (REG_DWORD, older driver fallback)
#   3. Win32_VideoController.AdapterRAM (last-resort, unsigned 32-bit so
#      capped at 4 GB; only used when registry lookup yields nothing)

[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null

$ErrorActionPreference = 'SilentlyContinue'

function Get-GpuVramMb {
    param([string]$DeviceID)
    if ([string]::IsNullOrEmpty($DeviceID)) { return $null }
    $classRoot = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
    if (-not (Test-Path $classRoot)) { return $null }
    $deviceIdLower = $DeviceID.ToLower()
    $hit = Get-ChildItem $classRoot -ErrorAction SilentlyContinue | ForEach-Object {
        $matching = (Get-ItemProperty $_.PSPath -Name 'MatchingDeviceId' -ErrorAction SilentlyContinue).MatchingDeviceId
        if ($matching -and $deviceIdLower.StartsWith($matching.ToLower())) {
            $qword = (Get-ItemProperty $_.PSPath -Name 'HardwareInformation.qwMemorySize' -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize'
            if ($qword -and $qword -gt 0) {
                return [int64]([math]::Round($qword / 1MB))
            }
            $dword = (Get-ItemProperty $_.PSPath -Name 'HardwareInformation.MemorySize' -ErrorAction SilentlyContinue).'HardwareInformation.MemorySize'
            if ($dword -and $dword -gt 0) {
                return [int64]([math]::Round($dword / 1MB))
            }
        }
    } | Select-Object -First 1
    if ($hit) { return $hit }
    return $null
}

$controllers = Get-CimInstance -ClassName Win32_VideoController

$results = @()
foreach ($c in $controllers) {
    $name = $c.Name
    $vendor = 'unknown'
    if ($name -match 'NVIDIA')   { $vendor = 'nvidia' }
    elseif ($name -match 'AMD' -or $name -match 'Radeon') { $vendor = 'amd' }
    elseif ($name -match 'Intel') { $vendor = 'intel' }

    $vramMb = Get-GpuVramMb -DeviceID $c.PNPDeviceID
    if (-not $vramMb) {
        $adapterRam = [int64]$c.AdapterRAM
        if ($adapterRam -gt 0) {
            $vramMb = [int64]([math]::Round($adapterRam / 1MB))
        }
    }

    $results += [PSCustomObject]@{
        gpu_model = $name
        driver_version = $c.DriverVersion
        vendor = $vendor
        vram_mb = $vramMb
    }
}

ConvertTo-Json -InputObject @($results) -Compress
