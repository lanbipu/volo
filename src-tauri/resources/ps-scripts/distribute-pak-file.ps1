# Robocopy a DDC pak set from a source SMB share into a local dir.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "SourceUnc","TargetLocal",["SourceSmbUser","SourceSmbPass"],["SourceSmbGuest":bool],["SourceShareRoots":[...]],["PreflightOnly":bool] }
# Output: JSON { ok, exit_code, bytes_copied, stdout_tail, [message] }
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'distribute-smb-mount.ps1')

function Test-UncReachable([string]$Path) {
    return [bool](Test-Path -LiteralPath $Path -ErrorAction SilentlyContinue)
}

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $SourceUnc = $p.SourceUnc
    $TargetLocal = $p.TargetLocal
    $SmbUser = $p.SourceSmbUser
    $SmbPass = $p.SourceSmbPass
    $ShareRoots = @($p.SourceShareRoots | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $UseGuest = if ($null -ne $p.SourceSmbGuest) {
        [bool]$p.SourceSmbGuest
    } else {
        [string]::IsNullOrEmpty($SmbUser) -and [string]::IsNullOrEmpty($SmbPass)
    }
    $PreflightOnly = [bool]$p.PreflightOnly
    if ([string]::IsNullOrWhiteSpace($SourceUnc) -or [string]::IsNullOrWhiteSpace($TargetLocal)) {
        throw "SourceUnc and TargetLocal are required"
    }

    if (-not (Test-Path -LiteralPath $TargetLocal)) {
        New-Item -Path $TargetLocal -ItemType Directory -Force | Out-Null
    }
    $shareRoot = if ($ShareRoots.Count -gt 0) { $ShareRoots[0] } else { $SourceUnc }
    if ($SourceUnc -match '^(\\\\[^\\]+\\[^\\]+)') { $shareRoot = $Matches[1] }
    $mounted = $false
    $mountedRoot = $null
    try {
        $mountedRoot = Mount-DistributeSourceShare -ShareRoot $shareRoot -ShareRoots $ShareRoots -SmbUser $SmbUser -SmbPass $SmbPass -UseGuest $UseGuest
        $mounted = -not [string]::IsNullOrWhiteSpace($mountedRoot)
        if ($mounted) { $shareRoot = $mountedRoot }
        # Exact-filename robocopy filter (see below) matches nothing and still
        # exits 0 if the source has no DDC.ddp — check the file directly (one
        # round-trip on the common/success path) and fail explicitly instead
        # of a silent "0 bytes copied" success; only re-probe the bare UNC on
        # failure to report the more specific "unreachable" cause.
        $FileName = 'DDC.ddp'
        $sourceFile = Join-Path -Path $SourceUnc -ChildPath $FileName
        if (-not (Test-UncReachable $sourceFile)) {
            if (-not (Test-UncReachable $SourceUnc)) {
                throw "source UNC unreachable: $SourceUnc"
            }
            throw "source has no $FileName to distribute: $sourceFile"
        }
        if ($PreflightOnly) {
            @{ ok = $true; exit_code = "0"; bytes_copied = "0"; stdout_tail = "preflight ok"; preflight = $true } | ConvertTo-Json -Compress
            return
        }
        $stdoutPath = Join-Path -Path $env:TEMP -ChildPath "robocopy-stdout-$PID.log"
        $stderrPath = Join-Path -Path $env:TEMP -ChildPath "robocopy-stderr-$PID.log"
        $roboArgs = @("$SourceUnc", "$TargetLocal", "$FileName", '/E', '/R:3', '/W:5', '/NP', '/NDL', '/NJH', '/NJS', '/BYTES')
        $proc = Start-Process -FilePath 'robocopy.exe' -ArgumentList $roboArgs -PassThru -Wait -NoNewWindow -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        $code = $proc.ExitCode
        $stdout = Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stdoutPath -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stderrPath -ErrorAction SilentlyContinue
        $bytesCopied = 0
        try {
            $m = [regex]::Matches($stdout, 'Bytes\s*:\s*(\d+)')
            if ($m.Count -gt 0) { $bytesCopied = [long]$m[0].Groups[1].Value }
        } catch {}
        $tail = if ($stdout) { ($stdout -split "`n" | Select-Object -Last 30) -join "`n" } else { "" }
        # robocopy exit < 8 = success (0-7 are informational/partial; >=8 = error)
        @{ ok = ($code -lt 8); exit_code = "$code"; bytes_copied = "$bytesCopied"; stdout_tail = "$tail"; preflight = $false } | ConvertTo-Json -Compress
    }
    finally {
        if ($mounted) { Unmount-DistributeSourceShare -ShareRoot $shareRoot }
    }
}
catch {
    @{ ok = $false; exit_code = "-1"; bytes_copied = "0"; stdout_tail = ""; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}
