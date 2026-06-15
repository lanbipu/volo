# Plan 7 T4.6 sidecar - drive a headless UE editor against a project that
# has `zen enable`d, watch the engine log for the ZenShared success line, kill
# the editor as soon as we see it.
#
# Purpose:
#   The matcher we are waiting for (see docs/research/zen-launch-mechanism.md §8.1):
#
#     LogDerivedDataCache: Display: ZenShared: Using ZenServer HTTP service at
#       <host> with namespace <ns> status: OK!
#
#   Constraint: UnrealEditor[-Cmd].exe with `-Unattended -Quit` does NOT exit
#   promptly. It reaches "Engine is initialized" then continues loading asset
#   registry / Python plugins / Pak mounts for ~3 minutes. We cannot wait for
#   process exit. Strategy is stream-tail-and-kill: redirect stdout to a temp
#   file, poll the file every 200 ms, kill the editor process tree as soon as
#   the regex matches (or timeout).
#
# Parameters:
#   -UeRoot           <path>  UE install root, e.g. "D:\Program Files\Epic Games\UE_5.7".
#                              Must contain Engine\Binaries\Win64\UnrealEditor-Cmd.exe.
#                              We use the -Cmd variant — UnrealEditor.exe is GUI-only
#                              and won't stream to stdout.
#   -UprojectPath     <path>  Absolute path to the .uproject file that has zen enabled.
#   -TimeoutSeconds   <int>   Max seconds to wait for the regex match. Default 300.
#   -ExpectedHost     <string> Optional: host string the matched line must contain
#                              (e.g. "127.0.0.1"). Mismatch -> ok=false.
#   -ExpectedPort     <int>    Optional: port to match. Mismatch -> ok=false.
#                              NOTE: the engine log format is
#                                `ZenShared: Using ZenServer HTTP service at <host> with namespace <ns> status: OK!`
#                              No explicit port in the line. We capture the port
#                              from the LogZenServiceInstance neighbour line
#                              `Unreal Zen Storage Server HTTP service at http://<host>:<port> status: OK!`
#                              When ExpectedPort > 0 and no observed port lands in
#                              the tail window, that's ok=false (the operator
#                              asked us to confirm a port we can't see — we don't
#                              silently pass). Leave ExpectedPort=0 / unset to
#                              skip the port assertion.
#   -ExpectedNamespace <string> Optional: namespace to match (default "ue.ddc").
#
# Output (single JSON object on stdout):
#   {
#     "ok": true,
#     "matched": true,
#     "match_line": "LogDerivedDataCache: Display: ZenShared: Using ZenServer HTTP service at 127.0.0.1 with namespace ue.ddc status: OK!",
#     "matched_host": "127.0.0.1",
#     "matched_port": 8558,        # null when not captured (only populated when
#                                  # the neighbouring LogZenServiceInstance line
#                                  # also lands in the tail window)
#     "matched_namespace": "ue.ddc",
#     "elapsed_sec": 47,
#     "editor_pid": 12345,
#     "killed": true,
#     "log_tail": ["last 50 log lines..."]
#   }
#
# Failure envelope (exit code still 0; ok=false is the signal):
#   { ok:false, matched:false, message:"timeout waiting for ZenShared OK line after 300s", ... }
#   { ok:false, matched:false, message:"editor process exited before match (exit code N)", exit_code:N, ... }
#   { ok:false, matched:false, message:"UE root missing UnrealEditor-Cmd.exe at <path>", ... }
#   { ok:false, matched:true,  message:"matched line host mismatch: expected=A got=B" } (semantic mismatch)
#
# Rust parser: core::zen::verify::parse_outcome_json (T4.4).
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File zen-verify-rules.ps1 `
#                  -UeRoot "D:\Program Files\Epic Games\UE_5.7" `
#                  -UprojectPath "E:\RenderStream Projects\test_0311\test_0311.uproject" `
#                  -TimeoutSeconds 300 -ExpectedHost "127.0.0.1" -ExpectedNamespace "ue.ddc"

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

# --- helpers ------------------------------------------------------------------

function Get-LogTail {
    param(
        [string]$Path,
        [int]$Lines = 50
    )
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    try {
        # -ReadCount 0 forces a single batch read so PowerShell doesn't stream
        # through the array; -Tail keeps the last N lines which is what the
        # caller wants for diagnostics.
        $tail = Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction SilentlyContinue
        if ($null -eq $tail) { return @() }
        # Normalize to array of plain strings. `Get-Content` attaches ETS
        # noteproperties (PSPath, PSDrive, ...) that ConvertTo-Json will
        # serialize on the returned strings, blowing up the envelope size
        # or (worse) emitting `null` for the field. Cast each line to a
        # bare System.String to strip the noteproperties before they reach
        # the consumer.
        return @($tail | ForEach-Object { [string]$_ })
    } catch {
        return @()
    }
}

function Stop-EditorTree {
    param(
        [System.Diagnostics.Process]$Proc
    )
    if ($null -eq $Proc) { return $false }
    $killed = $false
    try {
        if (-not $Proc.HasExited) {
            # taskkill /T sweeps child processes (crashreporter, shader compiler,
            # etc.) which UnrealEditor-Cmd.exe spawns. /F is forceful — the
            # editor can take >10s to honour a graceful shutdown and we already
            # decided to abandon the run.
            #
            # Codex P1: redirect taskkill's stdout+stderr through the
            # pipeline to Out-Null. `Start-Process -NoNewWindow` inherits
            # the parent console, so taskkill's `SUCCESS: ...` / `ERROR: ...`
            # lines would otherwise land on our WinRM stdout BEFORE the
            # final JSON envelope, breaking parse_outcome_json.
            & taskkill.exe /F /T /PID $Proc.Id 2>&1 | Out-Null
            $tkExit = [int]$LASTEXITCODE
            # Codex P3: native commands don't throw on non-zero, so we must
            # check $LASTEXITCODE ourselves. Without this, taskkill failing
            # (access denied, race) still marks `$killed=true` and skips
            # the `.Kill()` fallback, leaving the editor alive while we
            # report killed=true in the JSON envelope.
            if ($tkExit -eq 0) {
                $killed = $true
            } else {
                try { $Proc.Kill(); $killed = $true } catch { }
            }
        }
    } catch {
        # Fall back to .Kill() — even if taskkill failed, attempt direct.
        try { $Proc.Kill(); $killed = $true } catch { }
    }
    return $killed
}

# Matches the ZenShared success line. The interesting capture groups are
# `host` (free-form IPv4 / IPv6 / hostname) and `namespace`. UE 5.4+ format
# (verified on lanPC 5.7.4 — see zen-launch-mechanism.md §8.1):
#
#   LogDerivedDataCache: Display: ZenShared: Using ZenServer HTTP service at <host> with namespace <ns> status: OK!
#
# We accept either `Display:` or `Verbose:` between the cat and the message
# (different log verbosities prepend different severity labels). The `OK!.`
# tail is also accepted (some log builds emit a trailing period).
# Codex P2 fix: `[time]` prefix is optional. The canonical proof line
# recorded in zen-ini-rules.yaml verified_by has NO timestamp prefix,
# so requiring `^\[` makes the verifier miss the very log line the
# operator promised would appear. Match the prefix when present;
# accept its absence too.
$RegexZenShared = '(?:^\[\d[^\]]*\]\s*)?LogDerivedDataCache[^:]*:\s*(?:Display|Verbose|Log)?\s*:?\s*ZenShared:\s+Using\s+ZenServer\s+HTTP\s+service\s+at\s+(?<host>\S+?)\s+with\s+namespace\s+(?<namespace>\S+?)\s+status:\s+OK!\.?\s*$'

# Optional neighbour line that does include the port. We try to harvest it
# from log_tail so consumers can confirm port==expected:
#   LogZenServiceInstance: Display: Unreal Zen Storage Server HTTP service at http://[::1]:8558 status: OK!
$RegexZenInstancePort = 'Unreal\s+Zen\s+Storage\s+Server\s+HTTP\s+service\s+at\s+https?://(?<host>[^:\s]+|\[[^\]]+\]):(?<port>\d+)\s+status:\s+OK!'

# Codex P2: bind the port assertion to the matched ZenShared host. With
# multiple LogZenServiceInstance lines (local zen + shared upstream both
# starting), a blind "first match wins" would let unrelated services
# inject the wrong port. Three-tier strategy:
#   1. Parse port directly from `$MatchedHost` when it carries a port
#      suffix (formats: `host:port`, `127.0.0.1:port`, `[::1]:port`).
#   2. LogZenServiceInstance lines whose host equals `$MatchedHost`
#      (exact match — handles the explicit case codex flagged).
#   3. Fallback when no host-equal match was found: if the log has
#      EXACTLY ONE LogZenServiceInstance line, use its port. This
#      handles the common loopback-equivalence case where ZenShared
#      reports `127.0.0.1` (IPv4) but the local instance is bound to
#      `[::1]` (IPv6). The single-instance constraint preserves the
#      codex P2 protection — if multiple instances exist and none
#      match the host, ambiguity → return null.
# Returns the matched port (int) or $null when nothing maps cleanly.
function Find-MatchedPort {
    param(
        [string]$MatchedHost,
        [string[]]$Lines
    )
    if ([string]::IsNullOrEmpty($MatchedHost)) { return $null }
    # Bracketed IPv6 with port: `[::1]:8558`.
    if ($MatchedHost -match '^\[[^\]]+\]:(?<port>\d+)$') {
        return [int]$Matches['port']
    }
    # Hostname / IPv4 with port: `lanPC:8558`, `127.0.0.1:8558`. Codex P2:
    # the prefix must contain NO colon so a bare IPv6 literal like `::1`
    # doesn't get its `:1` suffix mistaken for port 1.
    if ($MatchedHost -match '^[^:]+:(?<port>\d+)$') {
        return [int]$Matches['port']
    }
    if ($null -eq $Lines) { return $null }
    # Two-pass over the InstancePort lines. Collect UNIQUE (host, port)
    # candidates — UE5 with `-log -stdout` writes each entry twice
    # (once in `[time][frame]` format, once in `time:` format), and
    # two identical-instance hits shouldn't count as "ambiguous". Then
    # prefer host-equal matches, fall back to single-instance.
    $seen = @{}
    $candidates = New-Object System.Collections.ArrayList
    foreach ($line in $Lines) {
        if ($line -match $RegexZenInstancePort) {
            $h = [string]$Matches['host']
            $p = [int]$Matches['port']
            $key = "$h|$p"
            if (-not $seen.ContainsKey($key)) {
                $seen[$key] = $true
                [void]$candidates.Add(@{ Host = $h; Port = $p })
            }
        }
    }
    foreach ($c in $candidates) {
        if ($c.Host -eq $MatchedHost) {
            return $c.Port
        }
    }
    # No host-equal match. Codex P2 protection still applies: only
    # auto-pick when there is no ambiguity (exactly one DISTINCT
    # InstancePort entry in the log).
    if ($candidates.Count -eq 1) {
        return $candidates[0].Port
    }
    return $null
}

# --- main ---------------------------------------------------------------------

$logFile = $null
$proc = $null
$startTime = Get-Date

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($p.UeRoot)) { throw "UeRoot is required" }
    if ([string]::IsNullOrWhiteSpace($p.UprojectPath)) { throw "UprojectPath is required" }
    $UeRoot = $p.UeRoot
    $UprojectPath = $p.UprojectPath
    $TimeoutSeconds = if ($null -ne $p.TimeoutSeconds) { [int]$p.TimeoutSeconds } else { 300 }
    $ExpectedHost = $p.ExpectedHost
    $ExpectedPort = if ($null -ne $p.ExpectedPort) { [int]$p.ExpectedPort } else { 0 }
    $ExpectedNamespace = if ($p.ExpectedNamespace) { $p.ExpectedNamespace } else { 'ue.ddc' }
    if ([string]::IsNullOrWhiteSpace($UeRoot)) {
        throw "UeRoot must be non-empty"
    }
    if ([string]::IsNullOrWhiteSpace($UprojectPath)) {
        throw "UprojectPath must be non-empty"
    }
    if ($TimeoutSeconds -le 0) {
        throw "TimeoutSeconds must be > 0"
    }

    $editorExe = Join-Path -Path $UeRoot -ChildPath 'Engine\Binaries\Win64\UnrealEditor-Cmd.exe'
    if (-not (Test-Path -LiteralPath $editorExe)) {
        @{
            ok = $false
            matched = $false
            message = "UE root missing UnrealEditor-Cmd.exe at $editorExe"
            elapsed_sec = 0
            killed = $false
            log_tail = @()
        } | ConvertTo-Json -Compress -Depth 6
        exit 0
    }
    if (-not (Test-Path -LiteralPath $UprojectPath)) {
        @{
            ok = $false
            matched = $false
            message = "uproject not found: $UprojectPath"
            elapsed_sec = 0
            killed = $false
            log_tail = @()
        } | ConvertTo-Json -Compress -Depth 6
        exit 0
    }

    $stamp = (Get-Date).ToString('yyyyMMddHHmmssfff')
    $logFile = Join-Path -Path $env:TEMP -ChildPath ("uecm-verify-{0}-{1}.log" -f $PID, $stamp)
    # Pre-create so polling never trips on "file not found yet" before the
    # editor has its first flush.
    New-Item -ItemType File -Path $logFile -Force | Out-Null

    # -log writes to stdout (and the Saved/Logs/<Project>.log), -stdout forces
    # stdout streaming, -nullrhi/-nosplash/-nosound suppress GUI bring-up, and
    # -unattended tells the editor not to prompt. We deliberately DO NOT pass
    # -Quit because per §8.3 it does not exit promptly anyway, and dropping it
    # avoids the slow tail of asset-registry shutdown work that would
    # otherwise eat into our timeout budget after the regex matches.
    $editorArgs = @(
        "`"$UprojectPath`"",
        '-log',
        '-unattended',
        '-stdout',
        '-nullrhi',
        '-nosplash',
        '-nosound'
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $editorExe
    $psi.Arguments = ($editorArgs -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.CreateNoWindow = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi

    # Hook stdout / stderr to append into $logFile. We use append-with-utf8
    # so the tail-poller sees the same bytes the editor wrote, with
    # newlines.
    #
    # Codex P2: don't silently swallow lines that lose the open race —
    # if the dropped line is the `ZenShared ... status: OK!` proof, the
    # verifier will time out despite a successful editor run. Open the
    # file with FileShare.ReadWrite so the tail-poller's reader doesn't
    # block writers, and retry the open on transient IO contention.
    $appendBlock = {
        if ($null -ne $EventArgs.Data) {
            $line = $EventArgs.Data + [Environment]::NewLine
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($line)
            $path = $Event.MessageData.Path
            $attempts = 0
            while ($attempts -lt 20) {
                try {
                    $fs = [System.IO.File]::Open(
                        $path,
                        [System.IO.FileMode]::Append,
                        [System.IO.FileAccess]::Write,
                        [System.IO.FileShare]::ReadWrite)
                    try {
                        $fs.Write($bytes, 0, $bytes.Length)
                    } finally {
                        $fs.Dispose()
                    }
                    break
                } catch {
                    $attempts++
                    if ($attempts -ge 20) {
                        # Truly stuck — surface via the catch in the main
                        # body would require event marshalling we don't
                        # have; intentionally accept the rare data loss
                        # only at the bounded retry ceiling (20 × 25ms =
                        # 500ms of contention).
                        break
                    }
                    Start-Sleep -Milliseconds 25
                }
            }
        }
    }
    $stdoutHandler = Register-ObjectEvent -InputObject $proc -EventName 'OutputDataReceived' `
        -Action $appendBlock -MessageData @{ Path = $logFile }
    $stderrHandler = Register-ObjectEvent -InputObject $proc -EventName 'ErrorDataReceived'  `
        -Action $appendBlock -MessageData @{ Path = $logFile }

    [void]$proc.Start()
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()
    $editorPid = $proc.Id

    $matched = $false
    $matchLine = $null
    $matchedHost = $null
    $matchedNamespace = $null
    $matchedPort = $null
    $deadline = $startTime.AddSeconds($TimeoutSeconds)

    # Stream the log: read whatever has been appended since the last poll and
    # apply the regex. We re-read from byte 0 every iteration but capped at
    # the file's current length; on a healthy run the file is bounded by
    # editor startup output (~10 MB upper bound), so the cost is negligible
    # compared to the editor's own work.
    $lastSize = 0L
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200

        # Editor exited before match — surface the exit code so callers know
        # this isn't a timeout. We only break out here; envelope writing
        # happens at the end so the same finally cleans up.
        if ($proc.HasExited) {
            Start-Sleep -Milliseconds 200   # let async handlers flush
            $finalCode = $proc.ExitCode
            # Codex P2: a 50-line tail can miss the ZenShared OK proof
            # when editor shutdown / crash appends a flood of trailing
            # lines after the match. Scan the FULL captured log first,
            # then keep the 50-line tail purely for the JSON envelope's
            # `log_tail` field (operator-readable context).
            $fullLog = @()
            try {
                if (Test-Path -LiteralPath $logFile -PathType Leaf) {
                    $fullLog = [System.IO.File]::ReadAllLines($logFile)
                }
            } catch {
                # Fall back to the tail if a full read fails (rare —
                # file already exists, we just opened it for write).
            }
            $tail = Get-LogTail -Path $logFile -Lines 50
            $scanLines = if ($fullLog.Count -gt 0) { $fullLog } else { $tail }
            foreach ($line in $scanLines) {
                if ($line -match $RegexZenShared) {
                    $matched = $true
                    # `Get-Content` / `ReadAllLines` attach ETS
                    # noteproperties (PSPath, PSDrive, ...) to each
                    # returned string. Assigning the raw value lets
                    # ConvertTo-Json serialize the noteproperties (or
                    # silently emit `null`), so cast to a plain string
                    # first.
                    $matchLine = [string]$line
                    $matchedHost = [string]$Matches['host']
                    $matchedNamespace = [string]$Matches['namespace']
                    break
                }
            }
            if ($matched) {
                # Tag log_tail with matched_port — bound to matched host
                # so unrelated LogZenServiceInstance lines don't inject
                # the wrong port. (See Find-MatchedPort docs.) Search the
                # full log so we don't miss the neighbour port line for
                # the same reason we widened the proof scan above.
                $matchedPort = Find-MatchedPort -MatchedHost $matchedHost -Lines $scanLines
                # Carry on into the success path below.
                break
            } else {
                @{
                    ok = $false
                    matched = $false
                    message = "editor process exited before match (exit code $finalCode)"
                    exit_code = $finalCode
                    elapsed_sec = [int]((Get-Date) - $startTime).TotalSeconds
                    editor_pid = $editorPid
                    killed = $false
                    log_tail = $tail
                } | ConvertTo-Json -Compress -Depth 6
                exit 0
            }
        }

        try {
            $info = Get-Item -LiteralPath $logFile -ErrorAction SilentlyContinue
            if ($null -eq $info) { continue }
            if ($info.Length -le $lastSize) { continue }

            # Cheap incremental read: tail the last ~1MB. We could track a
            # FileStream offset for exactness but a 1MB ring is plenty for
            # startup chatter and avoids opening the same file as the
            # writer event handler (which would race).
            #
            # Codex P2: capture the new file length BEFORE the read, but
            # only advance `$lastSize` AFTER a successful non-null read.
            # If Get-Content returns $null because of a transient sharing
            # lock, the previous code advanced $lastSize anyway — a fresh
            # `ZenShared OK!` line could land inside that window and never
            # be re-scanned, leaving the verifier to time out on a
            # successful editor.
            $observedSize = $info.Length
            $sliceLines = Get-Content -LiteralPath $logFile -ErrorAction SilentlyContinue

            if ($null -ne $sliceLines) {
                $lastSize = $observedSize
                foreach ($line in $sliceLines) {
                    if ($line -match $RegexZenShared) {
                        $matched = $true
                        # See note above on stripping ETS noteproperties.
                        $matchLine = [string]$line
                        $matchedHost = [string]$Matches['host']
                        $matchedNamespace = [string]$Matches['namespace']
                        break
                    }
                }
            }
            # else: read failed mid-write. Keep $lastSize where it was so
            # the next poll re-reads the same growth.
        } catch {
            # Polling failure is non-fatal — fall through and retry.
            # $lastSize intentionally unchanged on exception.
        }

        if ($matched) {
            # Bind matched port to the matched host — see Find-MatchedPort
            # docs for the Codex P2 rationale.
            $matchedPort = Find-MatchedPort -MatchedHost $matchedHost -Lines $sliceLines
            break
        }
    }

    # Whether matched or timed out, terminate the editor — we don't want the
    # ~3-minute asset-registry tail eating WinRM session time.
    $killed = Stop-EditorTree -Proc $proc
    $elapsed = [int]((Get-Date) - $startTime).TotalSeconds
    $tail = Get-LogTail -Path $logFile -Lines 50

    if (-not $matched) {
        @{
            ok = $false
            matched = $false
            message = "timeout waiting for ZenShared OK line after ${TimeoutSeconds}s"
            elapsed_sec = $elapsed
            editor_pid = $editorPid
            killed = $killed
            log_tail = $tail
        } | ConvertTo-Json -Compress -Depth 6
        exit 0
    }

    # Semantic assertions on the matched line.
    $assertionFailures = New-Object System.Collections.ArrayList
    if (-not [string]::IsNullOrEmpty($ExpectedHost)) {
        if ($matchedHost -ne $ExpectedHost) {
            [void]$assertionFailures.Add("host mismatch: expected=$ExpectedHost got=$matchedHost")
        }
    }
    if (-not [string]::IsNullOrEmpty($ExpectedNamespace)) {
        if ($matchedNamespace -ne $ExpectedNamespace) {
            [void]$assertionFailures.Add("namespace mismatch: expected=$ExpectedNamespace got=$matchedNamespace")
        }
    }
    # Port check: when caller explicitly supplied -ExpectedPort, lack of an
    # observed port is itself a failure (the ZenShared log line doesn't carry
    # the port, so we depend on the neighbouring LogZenServiceInstance line —
    # if it never lands in the tail window the operator can't confirm the
    # port is what they expect). Codex P2 fix: previously we silently passed
    # when $matchedPort was null and the caller had asked us to verify it.
    if ($ExpectedPort -gt 0) {
        if ($null -eq $matchedPort) {
            [void]$assertionFailures.Add("expected port=$ExpectedPort but no port was observed in the log tail (LogZenServiceInstance neighbour line missing)")
        } elseif ($matchedPort -ne $ExpectedPort) {
            [void]$assertionFailures.Add("port mismatch: expected=$ExpectedPort got=$matchedPort")
        }
    }

    if ($assertionFailures.Count -gt 0) {
        @{
            ok = $false
            matched = $true
            message = ($assertionFailures -join '; ')
            match_line = $matchLine
            matched_host = $matchedHost
            matched_port = $matchedPort
            matched_namespace = $matchedNamespace
            elapsed_sec = $elapsed
            editor_pid = $editorPid
            killed = $killed
            log_tail = $tail
        } | ConvertTo-Json -Compress -Depth 6
        exit 0
    }

    $payload = @{
        ok = $true
        matched = $true
        match_line = $matchLine
        matched_host = $matchedHost
        matched_port = $matchedPort
        matched_namespace = $matchedNamespace
        elapsed_sec = $elapsed
        editor_pid = $editorPid
        killed = $killed
        log_tail = $tail
    }
    if (-not [string]::IsNullOrEmpty($env:UECM_KEEP_VERIFY_LOG)) {
        $payload.temp_log_path = $logFile
    }
    $payload | ConvertTo-Json -Compress -Depth 6
}
catch {
    # Best-effort cleanup. If we got partway through ProcessStart, kill the
    # editor so the WinRM session doesn't leave it running.
    $killed = $false
    try { if ($null -ne $proc) { $killed = Stop-EditorTree -Proc $proc } } catch { }
    $tail = @()
    try { if ($null -ne $logFile) { $tail = Get-LogTail -Path $logFile -Lines 50 } } catch { }
    @{
        ok = $false
        matched = $false
        message = "verify-rules sidecar failed: $($_.Exception.Message)"
        elapsed_sec = [int]((Get-Date) - $startTime).TotalSeconds
        killed = $killed
        log_tail = $tail
    } | ConvertTo-Json -Compress -Depth 6
    exit 0
}
finally {
    # Tear down the event subscriptions. Diagnostic-preserve the temp log when
    # UECM_KEEP_VERIFY_LOG is set so operators can inspect why match_line /
    # log_tail came back empty without re-running the editor.
    try { if ($null -ne $stdoutHandler) { Unregister-Event -SourceIdentifier $stdoutHandler.Name -ErrorAction SilentlyContinue } } catch { }
    try { if ($null -ne $stderrHandler) { Unregister-Event -SourceIdentifier $stderrHandler.Name -ErrorAction SilentlyContinue } } catch { }
    if ($null -ne $logFile -and (Test-Path -LiteralPath $logFile)) {
        if ([string]::IsNullOrEmpty($env:UECM_KEEP_VERIFY_LOG)) {
            try { Remove-Item -LiteralPath $logFile -Force -ErrorAction SilentlyContinue } catch { }
        }
    }
}
