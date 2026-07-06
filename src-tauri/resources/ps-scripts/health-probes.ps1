# Runs 13 health probes locally on the target. Node-pure (shipped + executed via SSH -File).
# Layer assignment lives in src-tauri/src/core/probe_keys.rs -- this file MUST stay in
# sync (drift test: cargo test core::probe_keys::tests::powershell_script_results_hashtable_matches_registry).
#
# stdin: JSON { ShareUnc, SvcUsername, ExpectedSharedDataCachePath, ExpectedLocalDataCachePath }
# Output: JSON { ok, results: { <key>: {status, message, sample, remediation}, ... }, message }
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $ShareUnc                    = if ($p.ShareUnc) { "$($p.ShareUnc)" } else { "" }
    $SvcUsername                 = if ($p.SvcUsername) { "$($p.SvcUsername)" } else { "" }
    $ExpectedSharedDataCachePath = if ($p.ExpectedSharedDataCachePath) { "$($p.ExpectedSharedDataCachePath)" } else { "" }
    $ExpectedLocalDataCachePath  = if ($p.ExpectedLocalDataCachePath) { "$($p.ExpectedLocalDataCachePath)" } else { "" }

        function Probe-Firewall445 {
            try {
                # Stable rule Name (NOT DisplayName -- DisplayName is localized).
                $rule = Get-NetFirewallRule -Name 'FPS-SMB-In-TCP' -ErrorAction SilentlyContinue
                if (-not $rule) {
                    return @{ status='warning'; message='FPS-SMB-In-TCP rule not found'; sample='';
                              remediation='Re-run `uecm-cli winrm bootstrap <host>` to recreate the rule.' }
                }
                $enabled = $rule.Enabled -eq 'True'
                @{ status = ($(if ($enabled) {'healthy'} else {'critical'}));
                   message = "FPS-SMB-In-TCP enabled = $enabled"; sample = $rule.DisplayName;
                   remediation = ($(if ($enabled) {''} else {'Enable-NetFirewallRule -Name FPS-SMB-In-TCP (or re-run `uecm-cli winrm bootstrap <host>`).'})) }
            } catch {
                @{ status='warning'; message=$_.Exception.Message; sample='';
                   remediation='Inspect firewall manually: Get-NetFirewallRule -Name FPS-SMB-In-TCP.' }
            }
        }

        function Probe-LocalAccountTokenFilter {
            try {
                $v = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' `
                                      -Name 'LocalAccountTokenFilterPolicy' -ErrorAction Stop
                $val = [int]$v.LocalAccountTokenFilterPolicy
                if ($val -eq 1) {
                    @{ status='healthy'; message="LATFP=$val"; sample="$val"; remediation='' }
                } else {
                    @{ status='critical'; message="LATFP=$val (need 1 for remote local-admin token elevation)";
                       sample="$val";
                       remediation='Re-run `uecm-cli winrm bootstrap <host>` (default flow sets LATFP=1).' }
                }
            } catch {
                @{ status='critical'; message='LATFP registry value missing'; sample='';
                   remediation='Re-run `uecm-cli winrm bootstrap <host>` (default flow sets LATFP=1).' }
            }
        }

        function Probe-LongPathsEnabled {
            try {
                $v = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `
                                      -Name 'LongPathsEnabled' -ErrorAction Stop
                $val = [int]$v.LongPathsEnabled
                if ($val -eq 1) {
                    @{ status='healthy'; message="LongPathsEnabled=$val"; sample="$val"; remediation='' }
                } else {
                    @{ status='warning'; message="LongPathsEnabled=$val (UE asset paths > 260 chars will fail)";
                       sample="$val";
                       remediation='Re-run `uecm-cli winrm bootstrap <host>` (default flow sets LongPathsEnabled=1).' }
                }
            } catch {
                @{ status='warning'; message='LongPathsEnabled registry value missing'; sample='';
                   remediation='Re-run `uecm-cli winrm bootstrap <host>` (default flow sets LongPathsEnabled=1).' }
            }
        }

        function Probe-LanmanServer {
            try {
                $svc = Get-Service -Name LanmanServer -ErrorAction Stop
                $running = $svc.Status -eq 'Running'
                @{ status = ($(if ($running) {'healthy'} else {'critical'}));
                   message = "LanmanServer = $($svc.Status)"; sample = $svc.Status.ToString();
                   remediation = ($(if ($running) {''} else {'Run `uecm-cli winrm bootstrap <host>` (starts LanmanServer + sets Automatic).'})) }
            } catch {
                @{ status='critical'; message=$_.Exception.Message; sample='';
                   remediation='LanmanServer missing -- re-run `uecm-cli winrm bootstrap <host>`.' }
            }
        }

        function Probe-ShareReachable {
            if ([string]::IsNullOrEmpty($ShareUnc)) {
                return @{ status='na'; message='no share configured'; sample=''; remediation='' }
            }
            try {
                $ok = Test-Path $ShareUnc -ErrorAction Stop
                @{ status = ($(if ($ok) {'healthy'} else {'critical'}));
                   message = "Test-Path returned $ok"; sample = $ShareUnc;
                   remediation = ($(if ($ok) {''} else {'Create the SMB share on the host: `uecm-cli share create --host <hostHostingShare>`.'})) }
            } catch {
                @{ status='critical'; message=$_.Exception.Message; sample=$ShareUnc;
                   remediation='Verify share exists and current cred has read access: `uecm-cli share list`.' }
            }
        }

        function Probe-NtfsPerm {
            if ([string]::IsNullOrEmpty($ShareUnc) -or [string]::IsNullOrEmpty($SvcUsername)) {
                return @{ status='na'; message='only meaningful for managed shares with svc account'; sample=''; remediation='' }
            }
            try {
                $share = Get-SmbShare -Name (Split-Path $ShareUnc -Leaf) -ErrorAction SilentlyContinue
                if (-not $share) { return @{ status='na'; message='not the host'; sample=''; remediation='' } }
                $acl = Get-Acl $share.Path
                $hasSvc = $acl.Access | Where-Object { $_.IdentityReference -match $SvcUsername }
                @{ status = ($(if ($hasSvc) {'healthy'} else {'critical'}));
                   message = "ACL on $($share.Path) for $SvcUsername"; sample = ($acl.Owner);
                   remediation = ($(if ($hasSvc) {''} else {"Grant ACL: icacls `"$($share.Path)`" /grant ${SvcUsername}:(OI)(CI)F"})) }
            } catch {
                @{ status='warning'; message=$_.Exception.Message; sample='';
                   remediation='Inspect NTFS ACL: Get-Acl <sharePath>.' }
            }
        }

        function Probe-CredUser {
            if ([string]::IsNullOrEmpty($SvcUsername)) {
                return @{ status='na'; message='no managed share'; sample=''; remediation='' }
            }
            try {
                $out = & cmdkey.exe /list 2>&1 | Out-String
                $hasIt = $out -match [regex]::Escape($SvcUsername)
                @{ status = ($(if ($hasIt) {'healthy'} else {'critical'}));
                   message = "cmdkey /list contains $SvcUsername = $hasIt"; sample = '';
                   remediation = ($(if ($hasIt) {''} else {'Run `uecm-cli share inject-system-cred --host <host>` to write the svc credential to user + SYSTEM stores.'})) }
            } catch {
                @{ status='critical'; message=$_.Exception.Message; sample='';
                   remediation='cmdkey unavailable -- verify Windows is not in a broken state.' }
            }
        }

        function Probe-CredSystem {
            if ([string]::IsNullOrEmpty($SvcUsername)) {
                return @{ status='na'; message='no managed share'; sample=''; remediation='' }
            }
            $vendor = Join-Path $env:ProgramData 'UECM\PsExec64.exe'
            if (-not (Test-Path $vendor)) {
                return @{ status='warning'; message='PsExec64 not staged on machine; cannot verify SYSTEM cred'; sample='';
                          remediation='Re-run UECM-Bootstrap.cmd on this node (installs PsExec64 to %ProgramData%\UECM). If AV/AppLocker blocks PsExec, exempt %ProgramData%\UECM\PsExec64.exe.' }
            }
            try {
                # Read the SYSTEM cmdkey list via a file, not PsExec's stdout pipe:
                # over non-interactive SSH PsExec does not relay the child's stdout
                # back, so a direct capture comes back empty and a present cred reads
                # as missing. Have the SYSTEM cmd redirect to a file and read that.
                # The cmd string has no user input (fixed `cmdkey /list` + a PID-named
                # path under ProgramData), so there is nothing to inject.
                $listFile = Join-Path $env:ProgramData ("UECM\uecm-health-cmdkey-{0}.txt" -f $PID)
                Remove-Item -LiteralPath $listFile -ErrorAction SilentlyContinue
                & $vendor -accepteula -nobanner -s cmd.exe /c "cmdkey /list > `"$listFile`" 2>&1" 2>$null | Out-Null
                $out = if (Test-Path -LiteralPath $listFile) { Get-Content -LiteralPath $listFile -Raw -ErrorAction SilentlyContinue } else { "" }
                Remove-Item -LiteralPath $listFile -ErrorAction SilentlyContinue
                $hasIt = $out -match [regex]::Escape($SvcUsername)
                @{ status = ($(if ($hasIt) {'healthy'} else {'critical'}));
                   message = "SYSTEM cmdkey /list contains $SvcUsername = $hasIt"; sample = '';
                   remediation = ($(if ($hasIt) {''} else {'Run `uecm-cli share inject-system-cred --host <host>` to push cred into SYSTEM credential store.'})) }
            } catch {
                @{ status='warning'; message=$_.Exception.Message; sample='';
                   remediation='PsExec invocation failed -- check %ProgramData%\UECM\PsExec64.exe integrity and AV/AppLocker exclusions.' }
            }
        }

        function Probe-EnvVars {
            $shared = [Environment]::GetEnvironmentVariable('UE-SharedDataCachePath', 'Machine')
            if ([string]::IsNullOrEmpty($ExpectedSharedDataCachePath)) {
                if ([string]::IsNullOrEmpty($shared)) {
                    @{ status='warning'; message='UE-SharedDataCachePath is empty'; sample='';
                       remediation='Set UE-SharedDataCachePath system env var: `uecm-cli env set --name UE-SharedDataCachePath --value <UNC>`.' }
                } else {
                    @{ status='healthy'; message="UE-SharedDataCachePath = $shared"; sample="$shared"; remediation='' }
                }
            } else {
                $match = $shared -eq $ExpectedSharedDataCachePath
                @{ status = ($(if ($match) {'healthy'} else {'critical'}));
                   message = "expected $ExpectedSharedDataCachePath, got $shared"; sample = "$shared";
                   remediation = ($(if ($match) {''} else {"Set system env: ``uecm-cli env set --name UE-SharedDataCachePath --value `"$ExpectedSharedDataCachePath`"``."})) }
            }
        }

        function Probe-EnvShared {
            $value = [Environment]::GetEnvironmentVariable('UE-SharedDataCachePath', 'Machine')
            if ([string]::IsNullOrEmpty($ExpectedSharedDataCachePath)) {
                $status = if ($value) { 'healthy' } else { 'warning' }
                return @{ status = $status; message = "UE-SharedDataCachePath = $value"; sample = "$value"; remediation = '' }
            }
            $match = $value -eq $ExpectedSharedDataCachePath
            @{ status = ($(if ($match) {'healthy'} else {'critical'}));
               message = "expected $ExpectedSharedDataCachePath, got $value"; sample = "$value";
               remediation = ($(if ($match) {''} else {"Set system env: ``uecm-cli env set --name UE-SharedDataCachePath --value `"$ExpectedSharedDataCachePath`"``."})) }
        }

        function Probe-EnvLocal {
            $value = [Environment]::GetEnvironmentVariable('UE-LocalDataCachePath', 'Machine')
            if ([string]::IsNullOrEmpty($ExpectedLocalDataCachePath)) {
                $status = if ($value) { 'healthy' } else { 'warning' }
                return @{ status = $status; message = "UE-LocalDataCachePath = $value"; sample = "$value"; remediation = '' }
            }
            $match = $value -eq $ExpectedLocalDataCachePath
            @{ status = ($(if ($match) {'healthy'} else {'critical'}));
               message = "expected $ExpectedLocalDataCachePath, got $value"; sample = "$value";
               remediation = ($(if ($match) {''} else {"Set system env: ``uecm-cli env set --name UE-LocalDataCachePath --value `"$ExpectedLocalDataCachePath`"``."})) }
        }

        function Probe-SystemWrite {
            if ([string]::IsNullOrEmpty($ShareUnc)) {
                return @{ status='na'; message='no share configured'; sample=''; remediation='' }
            }
            $vendor = Join-Path $env:ProgramData 'UECM\PsExec64.exe'
            if (-not (Test-Path $vendor)) {
                return @{ status='warning'; message='PsExec64 not staged; cannot SYSTEM-write probe'; sample='';
                          remediation='Re-run UECM-Bootstrap.cmd on this node (installs PsExec64 into %ProgramData%\UECM).' }
            }
            try {
                $probe = "uecm-probe-$(Get-Random).txt"
                $cmd = "echo healthcheck > `"$ShareUnc\$probe`""
                & $vendor -accepteula -nobanner -s -i 0 cmd /c $cmd 2>&1 | Out-Null
                $exists = Test-Path "$ShareUnc\$probe"
                if ($exists) { Remove-Item "$ShareUnc\$probe" -Force -ErrorAction SilentlyContinue }
                @{ status = ($(if ($exists) {'healthy'} else {'critical'}));
                   message = "SYSTEM wrote probe file = $exists"; sample = $probe;
                   remediation = ($(if ($exists) {''} else {'SYSTEM cannot write to share -- verify cred_system probe AND that NTFS ACL grants ddc-svc write.'})) }
            } catch {
                @{ status='critical'; message=$_.Exception.Message; sample='';
                   remediation='SYSTEM-write probe threw -- inspect PsExec64 + share NTFS ACL.' }
            }
        }

        function Probe-Winmgmt {
            try {
                $svc = Get-Service -Name Winmgmt -ErrorAction Stop
                $running = $svc.Status -eq 'Running'
                @{ status = ($(if ($running) {'healthy'} else {'critical'}));
                   message = "Winmgmt = $($svc.Status)"; sample = $svc.Status.ToString();
                   remediation = ($(if ($running) {''} else {'Run `uecm-cli winrm bootstrap <host>` (sets Winmgmt Automatic+Running; required by machine refresh GPU detection).'})) }
            } catch {
                @{ status='critical'; message=$_.Exception.Message; sample='';
                   remediation='Winmgmt service missing -- re-run `uecm-cli winrm bootstrap <host>`.' }
            }
        }

        $results = @{
            firewall_445               = (Probe-Firewall445)
            local_account_token_filter = (Probe-LocalAccountTokenFilter)
            long_paths_enabled         = (Probe-LongPathsEnabled)
            lanman_server              = (Probe-LanmanServer)
            share_reachable            = (Probe-ShareReachable)
            ntfs_perm                  = (Probe-NtfsPerm)
            cred_user                  = (Probe-CredUser)
            cred_system                = (Probe-CredSystem)
            env_vars                   = (Probe-EnvVars)
            env_local                  = (Probe-EnvLocal)
            env_shared                 = (Probe-EnvShared)
            system_write               = (Probe-SystemWrite)
            winmgmt                    = (Probe-Winmgmt)
        }

    @{ ok = $true; results = $results; message = '' } | ConvertTo-Json -Compress -Depth 6
}
catch {
    @{ ok = $false; results = @{}; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
