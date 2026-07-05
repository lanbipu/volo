# Robocopy a PSO cache file pattern from a source SMB share into a local dir.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "SourceUnc","TargetLocal","FileName",["SourceSmbUser","SourceSmbPass"],["PreflightOnly":bool] }
#   FileName = robocopy file pattern, e.g. "*.upipelinecache" or "*.stablepc.csv"
# Output: JSON { ok, exit_code, bytes_copied, stdout_tail, [message] }
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $SourceUnc = $p.SourceUnc
    $TargetLocal = $p.TargetLocal
    $FileName = $p.FileName
    $SmbUser = $p.SourceSmbUser
    $SmbPass = $p.SourceSmbPass
    $PreflightOnly = [bool]$p.PreflightOnly
    if ([string]::IsNullOrWhiteSpace($SourceUnc) -or [string]::IsNullOrWhiteSpace($TargetLocal) -or
        [string]::IsNullOrWhiteSpace($FileName)) {
        throw "SourceUnc, TargetLocal, FileName are required"
    }

    if (-not (Test-Path -LiteralPath $TargetLocal)) {
        New-Item -Path $TargetLocal -ItemType Directory -Force | Out-Null
    }
    $driveName = "uecmsrc$PID"
    $mounted = $false
    $guestMountedRoot = $null
    try {
        if (-not [string]::IsNullOrEmpty($SmbUser) -and -not [string]::IsNullOrEmpty($SmbPass)) {
            $secure = ConvertTo-SecureString -String $SmbPass -AsPlainText -Force
            $smbCred = New-Object System.Management.Automation.PSCredential($SmbUser, $secure)
            New-PSDrive -Name $driveName -PSProvider FileSystem -Root $SourceUnc -Credential $smbCred -ErrorAction Stop | Out-Null
            $mounted = $true
        }
        # -ErrorAction SilentlyContinue on every UNC probe: under EAP=Stop an
        # access-denied SMB response makes Test-Path THROW ("Access is denied")
        # instead of returning $false, which would skip the guest mount / the
        # specific throw messages below entirely.
        elseif (-not (Test-Path -LiteralPath $SourceUnc -ErrorAction SilentlyContinue)) {
            # Open (Mode A) share, no forwarded cred: under an SSH network
            # logon the implicit NULL session is rejected (Access is denied) —
            # an explicit guest mount of the share root works where anonymous
            # does not. Mount failure is non-fatal; the checks below report
            # the specific cause.
            $rootMatch = [regex]::Match($SourceUnc, '^\\\\[^\\]+\\[^\\]+')
            if ($rootMatch.Success) {
                $shareRoot = $rootMatch.Value
                # argv form (no cmd /c string interpolation); literal '""' is
                # the empty guest password — a bare '' arg is dropped by 5.1.
                # try/catch: under EAP=Stop, redirected native stderr can throw
                # (NativeCommandError) and mount failure must stay non-fatal.
                try { & net.exe use $shareRoot '""' /user:guest 2>&1 | Out-Null } catch {}
                if ($LASTEXITCODE -eq 0) { $guestMountedRoot = $shareRoot }
            }
        }
        if (-not (Test-Path -LiteralPath $SourceUnc -ErrorAction SilentlyContinue)) {
            throw "source UNC unreachable: $SourceUnc"
        }
        if ($PreflightOnly) {
            @{ ok = $true; exit_code = "0"; bytes_copied = "0"; stdout_tail = "preflight ok"; preflight = $true } | ConvertTo-Json -Compress
            return
        }
        # Direct argv invocation: Start-Process -ArgumentList joins args with
        # spaces WITHOUT quoting, so a path like "D:\Unreal Projects\..." got
        # split into two robocopy parameters (exit 16, Invalid Parameter). `&`
        # passes each argument intact. EAP=Continue around it: robocopy's
        # occasional stderr lines must not become terminating errors.
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $stdout = (& robocopy.exe $SourceUnc $TargetLocal $FileName /E /R:3 /W:5 /NP /NDL /NJH /NJS /BYTES 2>&1 | Out-String)
        $code = $LASTEXITCODE
        $ErrorActionPreference = $prevEap
        $bytesCopied = 0
        try {
            $m = [regex]::Matches($stdout, 'Bytes\s*:\s*(\d+)')
            if ($m.Count -gt 0) { $bytesCopied = [long]$m[0].Groups[1].Value }
        } catch {}
        $tail = if ($stdout) { ($stdout -split "`n" | Select-Object -Last 30) -join "`n" } else { "" }
        @{ ok = ($code -lt 8); exit_code = "$code"; bytes_copied = "$bytesCopied"; stdout_tail = "$tail"; preflight = $false } | ConvertTo-Json -Compress
    }
    finally {
        if ($mounted) { Remove-PSDrive -Name $driveName -Force -ErrorAction SilentlyContinue }
        if ($guestMountedRoot) { try { & net.exe use $guestMountedRoot /delete /y 2>&1 | Out-Null } catch {} }
    }
}
catch {
    @{ ok = $false; exit_code = "-1"; bytes_copied = "0"; stdout_tail = ""; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}
