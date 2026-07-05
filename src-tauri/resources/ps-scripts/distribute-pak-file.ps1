# Robocopy a DDC pak set from a source SMB share into a local dir.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "SourceUnc","TargetLocal",["SourceSmbUser","SourceSmbPass"],["PreflightOnly":bool] }
# Output: JSON { ok, exit_code, bytes_copied, stdout_tail, [message] }
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $SourceUnc = $p.SourceUnc
    $TargetLocal = $p.TargetLocal
    $SmbUser = $p.SourceSmbUser
    $SmbPass = $p.SourceSmbPass
    $PreflightOnly = [bool]$p.PreflightOnly
    if ([string]::IsNullOrWhiteSpace($SourceUnc) -or [string]::IsNullOrWhiteSpace($TargetLocal)) {
        throw "SourceUnc and TargetLocal are required"
    }

    if (-not (Test-Path -LiteralPath $TargetLocal)) {
        New-Item -Path $TargetLocal -ItemType Directory -Force | Out-Null
    }
    $shareRoot = $SourceUnc
    if ($SourceUnc -match '^(\\\\[^\\]+\\[^\\]+)') { $shareRoot = $Matches[1] }
    $mounted = $false
    try {
        if (-not [string]::IsNullOrEmpty($SmbUser) -and -not [string]::IsNullOrEmpty($SmbPass)) {
            # net use with HOST\user (forwarded qualified by Rust) — New-PSDrive with a
            # bare local account name fails remote SMB with "Access is denied".
            cmd.exe /c "net use `"$shareRoot`" /delete /y" 2>&1 | Out-Null
            $netOut = ((cmd.exe /c "net use `"$shareRoot`" `"$SmbPass`" /user:$SmbUser /persistent:no" 2>&1) | Out-String).Trim()
            if ($LASTEXITCODE -ne 0) {
                throw "net use $shareRoot failed: $netOut"
            }
            $mounted = $true
        }
        # Exact-filename robocopy filter (see below) matches nothing and still
        # exits 0 if the source has no DDC.ddp — check the file directly (one
        # round-trip on the common/success path) and fail explicitly instead
        # of a silent "0 bytes copied" success; only re-probe the bare UNC on
        # failure to report the more specific "unreachable" cause.
        $FileName = 'DDC.ddp'
        $sourceFile = Join-Path -Path $SourceUnc -ChildPath $FileName
        if (-not (Test-Path -LiteralPath $sourceFile)) {
            if (-not (Test-Path -LiteralPath $SourceUnc)) {
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
        if ($mounted) { cmd.exe /c "net use `"$shareRoot`" /delete /y" 2>&1 | Out-Null }
    }
}
catch {
    @{ ok = $false; exit_code = "-1"; bytes_copied = "0"; stdout_tail = ""; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}
