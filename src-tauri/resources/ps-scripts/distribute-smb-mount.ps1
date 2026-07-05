# Shared SMB mount helpers for distribute-*.ps1 (runs as uecm-svc over SSH).
# Mode B: net use with HOST\svc + password (qualified user from Rust).
# Mode A: AllowInsecureGuestAuth + net use "" /user:HOST\Guest (same as modea-guest-connect.ps1).

function Enable-GuestSmbAuth {
    $lw = 'HKLM:\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters'
    if ((Get-ItemProperty -Path $lw -Name 'AllowInsecureGuestAuth' -ErrorAction SilentlyContinue).AllowInsecureGuestAuth -ne 1) {
        New-ItemProperty -Path $lw -Name 'AllowInsecureGuestAuth' -PropertyType DWord -Value 1 -Force | Out-Null
    }
}

function Mount-DistributeSourceShare {
    param(
        [Parameter(Mandatory)][string]$ShareRoot,
        [string]$SmbUser,
        [string]$SmbPass,
        [bool]$UseGuest
    )
    cmd.exe /c "net use `"$ShareRoot`" /delete /y" 2>&1 | Out-Null
    if (-not [string]::IsNullOrEmpty($SmbUser) -and -not [string]::IsNullOrEmpty($SmbPass)) {
        $netOut = ((cmd.exe /c "net use `"$ShareRoot`" `"$SmbPass`" /user:$SmbUser /persistent:no" 2>&1) | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            throw "net use $ShareRoot failed: $netOut"
        }
        return $true
    }
    if ($UseGuest) {
        Enable-GuestSmbAuth
        $h = if ($ShareRoot -match '^\\\\([^\\]+)\\') { $Matches[1] } else { $ShareRoot }
        $netOut = ((cmd.exe /c "net use `"$ShareRoot`" `"`" /user:$h\Guest /persistent:no" 2>&1) | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            throw "net use guest $ShareRoot failed: $netOut"
        }
        return $true
    }
    return $false
}

function Unmount-DistributeSourceShare {
    param([Parameter(Mandatory)][string]$ShareRoot)
    cmd.exe /c "net use `"$ShareRoot`" /delete /y" 2>&1 | Out-Null
}
