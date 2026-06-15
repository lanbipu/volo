# Creates an open SMB share (Everyone:Full, Mode A) for trusted on-set networks.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "ShareName","LocalPath" }
# Output: JSON { ok, unc_path, message }
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $ShareName = $p.ShareName
    $LocalPath = $p.LocalPath
    if ([string]::IsNullOrWhiteSpace($ShareName) -or [string]::IsNullOrWhiteSpace($LocalPath)) {
        throw "ShareName and LocalPath are required"
    }

    if (-not (Test-Path -LiteralPath $LocalPath)) {
        New-Item -ItemType Directory -Path $LocalPath -Force | Out-Null
    }
    $guest = Get-LocalUser -Name 'Guest' -ErrorAction Stop
    if (-not $guest.Enabled) { Enable-LocalUser -Name 'Guest' }
    $regPath = 'HKLM:\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters'
    Set-ItemProperty -Path $regPath -Name 'AutoShareWks' -Value 1 -Type DWord -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $regPath -Name 'RestrictNullSessAccess' -Value 0 -Type DWord -ErrorAction SilentlyContinue
    if (Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue) {
        Remove-SmbShare -Name $ShareName -Force
    }
    New-SmbShare -Name $ShareName -Path $LocalPath -FullAccess 'Everyone' -Description 'UECM open DDC share (Mode A)' | Out-Null
    icacls $LocalPath /grant 'Everyone:(OI)(CI)F' | Out-Null
    $unc = "\\$($env:COMPUTERNAME)\$ShareName"
    @{ ok = $true; unc_path = $unc; message = "Mode A share created: $unc" } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; unc_path = ""; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}
