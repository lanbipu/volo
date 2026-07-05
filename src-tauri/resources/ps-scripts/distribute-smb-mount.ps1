# Shared SMB mount helpers for distribute-*.ps1 (runs as uecm-svc over SSH).
# Mode B: net use with HOST\svc + password (qualified user from Rust).
# Mode A: AllowInsecureGuestAuth + net use "" /user:HOST\Guest (same as modea-guest-connect.ps1).

function Enable-GuestSmbAuth {
    $lw = 'HKLM:\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters'
    if ((Get-ItemProperty -Path $lw -Name 'AllowInsecureGuestAuth' -ErrorAction SilentlyContinue).AllowInsecureGuestAuth -ne 1) {
        New-ItemProperty -Path $lw -Name 'AllowInsecureGuestAuth' -PropertyType DWord -Value 1 -Force | Out-Null
    }
    $sysPol = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
    if ((Get-ItemProperty -Path $sysPol -Name 'EnableLinkedConnections' -ErrorAction SilentlyContinue).EnableLinkedConnections -ne 1) {
        New-ItemProperty -Path $sysPol -Name 'EnableLinkedConnections' -PropertyType DWord -Value 1 -Force | Out-Null
    }
}

function Get-UncHost([string]$u) {
    if ($u -match '^\\\\([^\\]+)\\') { return $Matches[1] }
    return $null
}

function Test-ShareReachable([string]$ShareRoot) {
    return [bool](Test-Path -LiteralPath $ShareRoot -ErrorAction SilentlyContinue)
}

function Mount-OneShareRoot {
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
        if (-not (Test-ShareReachable $ShareRoot)) {
            throw "net use $ShareRoot succeeded but share root is unreachable"
        }
        return $ShareRoot
    }
    if ($UseGuest) {
        Enable-GuestSmbAuth
        $h = Get-UncHost $ShareRoot
        if (-not $h) { throw "cannot parse host from share root '$ShareRoot'" }
        $netOut = ((cmd.exe /c "net use `"$ShareRoot`" `"`" /user:$h\Guest /persistent:no" 2>&1) | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            throw "net use guest $ShareRoot failed: $netOut"
        }
        if (-not (Test-ShareReachable $ShareRoot)) {
            throw "net use guest $ShareRoot succeeded but share root is unreachable"
        }
        return $ShareRoot
    }
    return $null
}

function Mount-DistributeSourceShare {
    param(
        [string]$ShareRoot,
        [string[]]$ShareRoots,
        [string]$SmbUser,
        [string]$SmbPass,
        [bool]$UseGuest
    )
    $candidates = @()
    if ($ShareRoots) { $candidates += @($ShareRoots | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) }
    if (-not [string]::IsNullOrWhiteSpace($ShareRoot)) { $candidates += $ShareRoot }
    $seen = @{}
    $ordered = @()
    foreach ($u in $candidates) {
        $key = $u.ToLowerInvariant()
        if (-not $seen.ContainsKey($key)) {
            $seen[$key] = $true
            $ordered += $u
        }
    }
    if (-not $ordered.Count) {
        throw 'ShareRoot or SourceShareRoots is required'
    }

    $errors = New-Object System.Collections.Generic.List[string]
    foreach ($root in $ordered) {
        try {
            $mounted = Mount-OneShareRoot -ShareRoot $root -SmbUser $SmbUser -SmbPass $SmbPass -UseGuest $UseGuest
            if ($mounted) { return $mounted }
        } catch {
            $errors.Add($_.Exception.Message) | Out-Null
        }
    }
    if ($UseGuest -or (-not [string]::IsNullOrEmpty($SmbUser) -and -not [string]::IsNullOrEmpty($SmbPass))) {
        throw ($errors -join '; ')
    }
    return $null
}

function Unmount-DistributeSourceShare {
    param([Parameter(Mandatory)][string]$ShareRoot)
    cmd.exe /c "net use `"$ShareRoot`" /delete /y" 2>&1 | Out-Null
}
