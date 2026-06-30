# Injects an SMB credential into THIS node's SYSTEM-account Credential Manager
# (and the current SSH user's), so LocalSystem services (UE engine /
# RenderStream Service) can transparently authenticate to a Mode B share.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# Writing SYSTEM's credential vault requires running cmdkey AS SYSTEM, which we
# do via PsExec64 -s. PsExec64.exe is installed at onboarding (enable-ssh.ps1)
# to C:\ProgramData\UECM\PsExec64.exe.
#
# stdin: JSON { "TargetHost", "SvcUsername", "SvcPassword" }
#   TargetHost  = the SMB host the credential authenticates to (cmdkey /add target)
#   SvcUsername = the share service account, e.g. "ddc-svc"
#   SvcPassword = its password
# Output: JSON { ok, message }

[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $TargetHost  = $p.TargetHost
    $SvcServerName = if ($p.SvcServerName) { [string]$p.SvcServerName } else { '' }
    $SvcUsername = $p.SvcUsername
    $SvcPassword = $p.SvcPassword
    if ([string]::IsNullOrWhiteSpace($TargetHost) -or
        [string]::IsNullOrWhiteSpace($SvcUsername) -or
        [string]::IsNullOrEmpty($SvcPassword)) {
        throw "TargetHost, SvcUsername, SvcPassword are required"
    }
    # Remote Mode B shares authenticate as SERVER\ddc-svc (local account on the host).
    $CredUser = if (-not [string]::IsNullOrWhiteSpace($SvcServerName)) { "$SvcServerName\$SvcUsername" } else { $SvcUsername }
    # TargetHost is interpolated into a `cmd.exe /c` string for the SYSTEM /list
    # verify, so restrict it to hostname/IP characters — this blocks cmd
    # metacharacters (& | > < ^ " % ...) that would otherwise run as SYSTEM on
    # the node. A real SMB host is always within this set.
    if ($TargetHost -notmatch '^[A-Za-z0-9.:_-]+$') {
        throw "TargetHost '$TargetHost' has invalid characters (expected a hostname or IP)"
    }

    $psexec = Join-Path $env:ProgramData 'UECM\PsExec64.exe'
    if (-not (Test-Path -LiteralPath $psexec)) {
        @{ ok = $false; message = "PsExec64.exe not found at $psexec; re-run UECM-Bootstrap.cmd on this node to install it" } | ConvertTo-Json -Compress
        exit 1
    }

    # cmdkey + PsExec are native exes that write status to stderr; with
    # $ErrorActionPreference='Stop' PowerShell turns native stderr into a
    # terminating error, so drop to 'Continue' around these calls.
    #
    # Verify the SYSTEM cmdkey by FILE, not by capturing PsExec's stdout. When the
    # parent runs non-interactively (over SSH), PsExec does not relay the child
    # cmdkey's stdout back through our pipe (verified on a real node: the capture
    # came back empty), so we have the SYSTEM cmd redirect `cmdkey /list` to a file
    # and read that. This code ran under WinRM Invoke-Command before, where the
    # pipe relay worked, which hid the gap. The svc username is ASCII, so it
    # matches even when the surrounding cmdkey text is in the console CJK codepage.
    $listFile = Join-Path $env:ProgramData ("UECM\uecm-cmdkey-list-{0}.txt" -f $PID)
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        cmdkey.exe "/add:$TargetHost" "/user:$CredUser" "/pass:$SvcPassword" 2>&1 | Out-Null
        & $psexec -accepteula -nobanner -s cmdkey.exe "/add:$TargetHost" "/user:$CredUser" "/pass:$SvcPassword" 2>&1 | Out-Null
        Remove-Item -LiteralPath $listFile -ErrorAction SilentlyContinue
        & $psexec -accepteula -nobanner -s cmd.exe /c "cmdkey /list:$TargetHost > `"$listFile`" 2>&1" 2>$null | Out-Null
        $listOut = if (Test-Path -LiteralPath $listFile) { Get-Content -LiteralPath $listFile -Raw -ErrorAction SilentlyContinue } else { "" }
        Remove-Item -LiteralPath $listFile -ErrorAction SilentlyContinue
    }
    finally {
        $ErrorActionPreference = $prevPref
    }

    if ([string]::IsNullOrEmpty($listOut) -or ($listOut -notmatch [regex]::Escape($CredUser))) {
        throw "SYSTEM cred verify failed; cmdkey /list under SYSTEM did not show '$CredUser'. Got: $listOut"
    }
    @{ ok = $true; message = "user + SYSTEM creds injected for $TargetHost as $CredUser" } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
