# Install a file that was scp'd into the node's transfer staging dir.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# The SSH-push distribute flow is: operator preflights this script
# (PreflightOnly, which also creates StagingDir so the subsequent scp has a
# destination), scp-pushes the file into StagingDir, then runs this script
# again to verify size and move the file into place. Move-Item gives
# atomicity: a partial transfer never appears at the final path.
#
# stdin: JSON { "StagingDir","StagedName","TargetLocal","FileName",
#               "ExpectedSize",["PreflightOnly":bool] }
# Output: JSON { ok, exit_code, bytes_copied, stdout_tail, [message] }
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $StagingDir = $p.StagingDir
    $StagedName = $p.StagedName
    $TargetLocal = $p.TargetLocal
    $FileName = $p.FileName
    $ExpectedSize = [long]$p.ExpectedSize
    $PreflightOnly = [bool]$p.PreflightOnly
    if ([string]::IsNullOrWhiteSpace($StagingDir) -or [string]::IsNullOrWhiteSpace($StagedName) -or
        [string]::IsNullOrWhiteSpace($TargetLocal) -or [string]::IsNullOrWhiteSpace($FileName)) {
        throw "StagingDir, StagedName, TargetLocal, FileName are required"
    }

    if (-not (Test-Path -LiteralPath $StagingDir)) {
        New-Item -Path $StagingDir -ItemType Directory -Force | Out-Null
    }
    if (-not (Test-Path -LiteralPath $TargetLocal)) {
        New-Item -Path $TargetLocal -ItemType Directory -Force | Out-Null
    }

    if ($PreflightOnly) {
        # Write-probe the final dir so a permission problem surfaces before
        # the multi-GB transfer, not after it.
        $probe = Join-Path -Path $TargetLocal -ChildPath ".volo-write-probe-$PID"
        Set-Content -LiteralPath $probe -Value 'probe' -ErrorAction Stop
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        # Report the existing final file's size (if any) so the operator can
        # skip the transfer entirely when the target already holds an
        # identical-size copy — the robocopy path's same-file skip semantics.
        $existing = "-1"
        $final = Join-Path -Path $TargetLocal -ChildPath $FileName
        if (Test-Path -LiteralPath $final) { $existing = "$((Get-Item -LiteralPath $final).Length)" }
        @{ ok = $true; exit_code = "0"; bytes_copied = "0"; stdout_tail = "preflight ok"; preflight = $true; existing_size = $existing } | ConvertTo-Json -Compress
        return
    }

    $staged = Join-Path -Path $StagingDir -ChildPath $StagedName
    if (-not (Test-Path -LiteralPath $staged)) {
        throw "staged file missing: $staged"
    }
    $actual = (Get-Item -LiteralPath $staged).Length
    if ($ExpectedSize -gt 0 -and $actual -ne $ExpectedSize) {
        throw "staged file size mismatch: expected $ExpectedSize, got $actual (truncated transfer?)"
    }
    $dest = Join-Path -Path $TargetLocal -ChildPath $FileName
    Move-Item -LiteralPath $staged -Destination $dest -Force
    @{ ok = $true; exit_code = "0"; bytes_copied = "$actual"; stdout_tail = "installed $dest"; preflight = $false } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; exit_code = "-1"; bytes_copied = "0"; stdout_tail = ""; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}
