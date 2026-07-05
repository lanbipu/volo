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

function Remove-SmbConnectionBestEffort([string]$ShareRoot) {
    # `net use /delete` returns 2250 when no session exists. Under Windows
    # PowerShell 5.1 its stderr can become a terminating ErrorRecord while the
    # caller uses ErrorActionPreference=Stop, aborting before the real mount.
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = ((cmd.exe /c "net use `"$ShareRoot`" /delete /y" 2>&1) | Out-String).Trim()
        return [ordered]@{ code = $LASTEXITCODE; output = $output }
    }
    finally {
        $ErrorActionPreference = $oldPreference
    }
}

function Mount-OneShareRoot {
    param(
        [Parameter(Mandatory)][string]$ShareRoot,
        [string]$SmbUser,
        [string]$SmbPass,
        [bool]$UseGuest
    )
    $deleteResult = Remove-SmbConnectionBestEffort $ShareRoot
    if (-not [string]::IsNullOrEmpty($SmbUser) -and -not [string]::IsNullOrEmpty($SmbPass)) {
        $netOut = ((cmd.exe /c "net use `"$ShareRoot`" `"$SmbPass`" /user:$SmbUser /persistent:no" 2>&1) | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            throw "net use $ShareRoot failed (exit $LASTEXITCODE; output: $netOut)"
        }
        if (-not (Test-ShareReachable $ShareRoot)) {
            throw "net use $ShareRoot exited 0 but share root is unreachable (output: $netOut)"
        }
        return $ShareRoot
    }
    if ($UseGuest) {
        try { Enable-GuestSmbAuth }
        catch { throw "guest SMB client policy setup failed as $(whoami): $($_.Exception.Message)" }
        $h = Get-UncHost $ShareRoot
        if (-not $h) { throw "cannot parse host from share root '$ShareRoot'" }
        $netOut = ((cmd.exe /c "net use `"$ShareRoot`" `"`" /user:$h\Guest /persistent:no" 2>&1) | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            throw "net use guest $ShareRoot failed (exit $LASTEXITCODE; output: $netOut)"
        }
        if (-not (Test-ShareReachable $ShareRoot)) {
            throw "net use guest $ShareRoot exited 0 but share root is unreachable (output: $netOut)"
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
        $roots = ($ordered -join ', ')
        $detail = if ($errors.Count) { ($errors -join '; ') } else { 'no mount attempts recorded' }
        throw "SMB mount failed for share root(s) [$roots]: $detail"
    }
    return $null
}

function Unmount-DistributeSourceShare {
    param([Parameter(Mandatory)][string]$ShareRoot)
    $null = Remove-SmbConnectionBestEffort $ShareRoot
}
