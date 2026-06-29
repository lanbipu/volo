# Mode A (open/guest) CLIENT teardown — undo what prepare-open-share-client.ps1 did
# for ONE share, so leaving / tearing down a share stops the client auto-reconnecting
# to a (possibly decommissioned) host at every logon.
#
# Removes the per-share targets file + both scheduled tasks (keyed on the primary
# UNC host), and drops any live guest net use sessions to the share UNCs.
#
# stdin: JSON { "TargetUncs": ["\\\\HOST\\Share", "\\\\10.0.0.1\\Share"] }
# Output: JSON { ok, message }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-UncHost([string]$u) {
    if ($u -match '^\\\\([^\\]+)\\') { return $Matches[1] } else { return $null }
}

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $targets = @($p.TargetUncs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if (-not $targets.Count) { throw 'TargetUncs is required (at least one \\HOST\Share UNC)' }

    $base = 'C:\ProgramData\UECM'
    $primaryHost = Get-UncHost $targets[0]
    if (-not $primaryHost) { throw "cannot parse host from primary UNC '$($targets[0])'" }
    $key = ($primaryHost -replace '[^A-Za-z0-9]', '_')

    $steps = New-Object System.Collections.Generic.List[string]

    foreach ($t in @("UECM-ModeA-Guest-$key-Now", "UECM-ModeA-Guest-$key")) {
        if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
            $steps.Add("removed task $t") | Out-Null
        }
    }

    $targetsFile = Join-Path $base ("modea-targets-$key.json")
    if (Test-Path -LiteralPath $targetsFile) {
        Remove-Item -LiteralPath $targetsFile -Force -ErrorAction SilentlyContinue
        $steps.Add("removed $([System.IO.Path]::GetFileName($targetsFile))") | Out-Null
    }

    # Drop live guest sessions (uecm-svc context here; SYSTEM via PsExec). The
    # interactive user's current /persistent:no session dies at next logoff and,
    # with the OnLogon task gone, is never recreated.
    $psexec = Join-Path $base 'PsExec64.exe'
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    foreach ($u in $targets) {
        cmd.exe /c "net use `"$u`" /delete /y" 2>&1 | Out-Null
        if (Test-Path -LiteralPath $psexec) {
            & $psexec -accepteula -nobanner -s cmd.exe /c "net use `"$u`" /delete /y >nul 2>&1" 2>&1 | Out-Null
        }
    }
    $ErrorActionPreference = $eap
    $steps.Add('net use sessions removed') | Out-Null

    @{ ok = $true; message = ($steps -join '; ') } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
