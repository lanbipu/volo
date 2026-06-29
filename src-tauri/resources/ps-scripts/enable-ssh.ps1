# Enables Windows OpenSSH Server for UECM SSH transport onboarding.
# Run locally on the target as Administrator. Idempotent; safe to re-run.
# Emits JSON { ok, changes, message } and exits 0 (ok) / 1 (failed).
#
# SSH is the UECM transport; this is the standalone node onboarder.
# during migration (WinRM is removed in a later phase).
param(
    [string]$PublicKeyPath = '',
    [string]$UecmPublicKey = '',
    [string]$StagingSourceDir = '',
    [switch]$CheckOnly,
    # --- node prep (folded from enable-winrm.ps1; off by default) ---
    [switch]$CreateLocalAdmin,
    [string]$LocalAdminName = 'uecm-svc',
    [string]$LocalAdminPassword = '',
    [switch]$EnableSmbServer,
    [switch]$EnableWmi,
    [switch]$EnableLongPaths,
    [switch]$AllowInsecureSmbGuest,
    [ValidateSet('HighPerformance', 'Balanced', 'Skip')]
    [string]$PowerProfile = 'Skip',
    [ValidateSet('RemoteSigned', 'Bypass', 'Skip')]
    [string]$SetExecutionPolicy = 'Skip'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$changes = New-Object System.Collections.ArrayList
function Note($m) { [void]$changes.Add($m) }
$adminKeys = 'C:\ProgramData\ssh\administrators_authorized_keys'
$uecmDir = 'C:\ProgramData\UECM'
$staging = 'C:\ProgramData\UECM\ps-scripts'

# --- node-prep functions (verbatim from enable-winrm.ps1; enable-ssh is standalone after P5) ---
function Test-UecmAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Add-UecmChange {
    param(
        [System.Collections.Generic.List[string]]$Changes,
        [string]$Message
    )
    if (-not [string]::IsNullOrWhiteSpace($Message)) {
        $Changes.Add($Message) | Out-Null
    }
}

function Get-UecmRegistryDword {
    param(
        [string]$Path,
        [string]$Name
    )
    try {
        $value = Get-ItemProperty -Path $Path -Name $Name -ErrorAction Stop
        return [int]$value.$Name
    }
    catch {
        return $null
    }
}
function Enable-UecmLocalAdmin {
    param([System.Collections.Generic.List[string]]$Changes)

    if (-not $CreateLocalAdmin) {
        Add-UecmChange $Changes 'local admin account creation skipped (pass -CreateLocalAdmin to enable)'
        return
    }

    $name = $LocalAdminName
    if ([string]::IsNullOrWhiteSpace($name)) {
        throw 'CreateLocalAdmin requested but -LocalAdminName is empty'
    }
    # UECM's SshExecutor always logs in as 'uecm-svc' (the per-node ssh_user is
    # not yet plumbed through), so onboarding any other account name would create
    # a node that reports ready here but is unreachable for every migrated SSH
    # operation. Reject a non-uecm-svc name rather than producing that mismatch.
    if ($name -ne 'uecm-svc') {
        throw "LocalAdminName must be 'uecm-svc' (UECM connects as uecm-svc); got '$name'"
    }
    if ([string]::IsNullOrWhiteSpace($LocalAdminPassword)) {
        throw "CreateLocalAdmin requested but -LocalAdminPassword is empty for account '$name'"
    }
    $secure = ConvertTo-SecureString $LocalAdminPassword -AsPlainText -Force

    $existing = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
    if ($existing) {
        Set-LocalUser -Name $name -Password $secure -PasswordNeverExpires $true -AccountNeverExpires -ErrorAction Stop
        if (-not $existing.Enabled) {
            Enable-LocalUser -Name $name -ErrorAction Stop
            Add-UecmChange $Changes "enabled existing local account '$name'"
        }
        Add-UecmChange $Changes "reset password for existing local account '$name'"
    } else {
        New-LocalUser -Name $name -Password $secure `
            -FullName 'UECM Service Account' `
            -Description 'UECM remote management service account' `
            -PasswordNeverExpires -AccountNeverExpires -ErrorAction Stop | Out-Null
        Add-UecmChange $Changes "created local admin account '$name'"
    }

    # Resolve the Administrators group by its well-known SID S-1-5-32-544 - on a
    # localized Windows the group DisplayName is translated (zh-CN: "管理员") but the
    # SID is invariant, so a hard-coded 'Administrators' name would silently fail there.
    # Add the member by the LOCAL account's SID (not the bare name): on a domain-joined
    # box a domain principal of the same name could otherwise be resolved and granted
    # admin instead of this local SAM account. Get-LocalUser only returns local accounts.
    $localSid = (Get-LocalUser -Name $name -ErrorAction Stop).SID.Value
    $adminGroup = (Get-LocalGroup -SID 'S-1-5-32-544' -ErrorAction Stop).Name
    try {
        Add-LocalGroupMember -Group $adminGroup -Member $localSid -ErrorAction Stop
        Add-UecmChange $Changes "added '$name' to local '$adminGroup' group"
    } catch {
        if ($_.FullyQualifiedErrorId -match 'MemberExists') {
            Add-UecmChange $Changes "'$name' already in local '$adminGroup' group"
        } else {
            throw
        }
    }
}
function Enable-UecmSmbServer {
    param([System.Collections.Generic.List[string]]$Changes)
    if (-not $EnableSmbServer) { return }

    $svc = Get-Service -Name LanmanServer -ErrorAction SilentlyContinue
    if (-not $svc) {
        Add-UecmChange $Changes 'WARNING: LanmanServer service not present; SMB share creation will fail'
        return
    }

    try {
        $startMode = (Get-CimInstance Win32_Service -Filter "Name='LanmanServer'" -ErrorAction Stop).StartMode
    } catch {
        $startMode = $svc.StartType.ToString()
    }
    if ($startMode -ne 'Auto' -and $startMode -ne 'Automatic') {
        Set-Service -Name LanmanServer -StartupType Automatic -ErrorAction Stop
        Add-UecmChange $Changes 'LanmanServer startup type set to Automatic'
    }
    if ($svc.Status -ne 'Running') {
        Start-Service -Name LanmanServer -ErrorAction Stop
        Add-UecmChange $Changes 'LanmanServer service started'
    }

    # UECM only needs SMB-In (TCP 445). Enabling the full 'File and Printer Sharing'
    # group would also open NetBIOS 137-139, LLMNR/mDNS, Spooler RPC etc - unnecessary
    # attack surface.
    #
    # Use the stable rule Name 'FPS-SMB-In-TCP' (NOT DisplayName which is localized -
    # on zh-CN Windows the DisplayName is "文件和打印机共享(SMB-入站)" and a
    # DisplayName-based lookup would silently fail and leave SMB 445 closed).
    $smbRule = $null
    try {
        $smbRule = Get-NetFirewallRule -Name 'FPS-SMB-In-TCP' -ErrorAction Stop
    } catch {
        # Fallback: enumerate inbound TCP Allow rules with LocalPort 445.
        # MUST filter by Protocol=TCP + Action=Allow - otherwise we could pick a
        # disabled Block rule and "enable" it, which would silently block SMB
        # while reporting success.
        try {
            $candidateRules = @(
                Get-NetFirewallRule -Direction Inbound -Action Allow -ErrorAction SilentlyContinue |
                    Where-Object {
                        try {
                            $port = $_ | Get-NetFirewallPortFilter -ErrorAction Stop
                            ($port.Protocol -eq 'TCP') -and ($port.LocalPort -contains '445')
                        } catch { $false }
                    }
            )
            # Prefer a currently-disabled rule (need to enable it); otherwise any match.
            $smbRule = $candidateRules | Where-Object { $_.Enabled -eq 'False' } | Select-Object -First 1
            if (-not $smbRule) {
                $smbRule = $candidateRules | Select-Object -First 1
            }
        } catch {
            $smbRule = $null
        }
    }

    if (-not $smbRule) {
        Add-UecmChange $Changes 'WARNING: SMB-In firewall rule (FPS-SMB-In-TCP / TCP 445 inbound) not found on this machine; share creation may fail'
        return
    }

    try {
        $smbRule | Enable-NetFirewallRule -ErrorAction Stop
        $ruleId = if ($smbRule.Name) { $smbRule.Name } else { $smbRule.DisplayName }
        Add-UecmChange $Changes "SMB-In firewall rule enabled (rule: $ruleId, TCP 445 only)"
    } catch {
        Add-UecmChange $Changes "WARNING: could not enable SMB-In firewall rule: $($_.Exception.Message)"
    }
}

function Enable-UecmWmi {
    param([System.Collections.Generic.List[string]]$Changes)
    if (-not $EnableWmi) { return }

    $svc = Get-Service -Name Winmgmt -ErrorAction SilentlyContinue
    if (-not $svc) {
        Add-UecmChange $Changes 'WARNING: Winmgmt service not present; UECM machine refresh will fail'
        return
    }

    try {
        $startMode = (Get-CimInstance Win32_Service -Filter "Name='Winmgmt'" -ErrorAction Stop).StartMode
    } catch {
        $startMode = $svc.StartType.ToString()
    }
    if ($startMode -ne 'Auto' -and $startMode -ne 'Automatic') {
        Set-Service -Name Winmgmt -StartupType Automatic -ErrorAction Stop
        Add-UecmChange $Changes 'Winmgmt startup type set to Automatic'
    }
    if ($svc.Status -ne 'Running') {
        Start-Service -Name Winmgmt -ErrorAction Stop
        Add-UecmChange $Changes 'Winmgmt service started'
    }
}

function Set-UecmLocalExecutionPolicy {
    param([System.Collections.Generic.List[string]]$Changes)
    if ($SetExecutionPolicy -eq 'Skip') { return }

    $current = Get-ExecutionPolicy -Scope LocalMachine -ErrorAction SilentlyContinue
    if ("$current" -eq $SetExecutionPolicy) {
        Add-UecmChange $Changes "LocalMachine execution policy already $SetExecutionPolicy"
        return
    }
    try {
        Set-ExecutionPolicy -ExecutionPolicy $SetExecutionPolicy -Scope LocalMachine -Force -ErrorAction Stop
        Add-UecmChange $Changes "LocalMachine execution policy set to $SetExecutionPolicy (was $current)"
    } catch {
        # GPO may override LocalMachine - record but do not fail bootstrap.
        Add-UecmChange $Changes "WARNING: could not set LocalMachine execution policy (likely GPO-managed): $($_.Exception.Message)"
    }
}

function Enable-UecmLongPaths {
    param([System.Collections.Generic.List[string]]$Changes)
    if (-not $EnableLongPaths) { return }

    $path = 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem'
    $current = Get-UecmRegistryDword -Path $path -Name 'LongPathsEnabled'
    if ($current -eq 1) {
        Add-UecmChange $Changes 'LongPathsEnabled already 1'
        return
    }
    New-ItemProperty -Path $path -Name 'LongPathsEnabled' -PropertyType DWord -Value 1 -Force | Out-Null
    Add-UecmChange $Changes 'LongPathsEnabled set to 1 (effective after reboot for some processes)'
}

function Enable-UecmInsecureSmbGuest {
    param([System.Collections.Generic.List[string]]$Changes)
    if (-not $AllowInsecureSmbGuest) { return }

    # CLIENT side (LanmanWorkstation) - mirror of the LanmanServer prep above.
    # Windows 10/11 default AllowInsecureGuestAuth=0 (or absent), which makes the
    # client refuse anonymous/guest SMB and pop a "enter network credentials"
    # prompt when mounting an open (Mode A / guest) UNC share. Setting it to 1
    # lets the client connect to a guest share without a credential prompt.
    $path = 'HKLM:\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters'
    $current = Get-UecmRegistryDword -Path $path -Name 'AllowInsecureGuestAuth'
    if ($current -eq 1) {
        Add-UecmChange $Changes 'AllowInsecureGuestAuth already 1'
        return
    }
    New-ItemProperty -Path $path -Name 'AllowInsecureGuestAuth' -PropertyType DWord -Value 1 -Force | Out-Null
    Add-UecmChange $Changes 'AllowInsecureGuestAuth set to 1 (insecure SMB guest logon allowed for open shares)'
}

function Set-UecmPowerPlan {
    param([System.Collections.Generic.List[string]]$Changes)
    if ($PowerProfile -eq 'Skip') { return }

    $guidMap = @{
        'HighPerformance' = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'
        'Balanced'        = '381b4222-f694-41f0-9685-ff5bb260df2e'
    }
    $guid = $guidMap[$PowerProfile]

    # Power plan restoration is idempotent across reruns:
    #   1. Built-in GUID present in list → use it directly.
    #   2. Built-in GUID hidden but we previously duplicated it (named "UECM-<Profile>")
    #      → reuse that GUID, do NOT duplicate again.
    #   3. Truly missing → /duplicatescheme + /changename to a stable UECM-* tag so
    #      the next run finds it via case 2.
    # This prevents each bootstrap rerun from creating yet another power scheme.
    $list = (& powercfg /list 2>&1) -join "`n"
    $activeGuid = $null
    $uecmPlanTag = "UECM-$PowerProfile"
    $guidRegex = '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'

    if ($list -match [regex]::Escape($guid)) {
        # Case 1: built-in scheme is still visible.
        $activeGuid = $guid
    } else {
        # Case 2: look for a prior UECM-tagged duplicate.
        foreach ($line in ($list -split "`r?`n")) {
            if ($line -match ($guidRegex + '.*\(\s*' + [regex]::Escape($uecmPlanTag) + '\s*\)')) {
                $activeGuid = $matches[1]
                Add-UecmChange $Changes "reusing existing $uecmPlanTag power plan (GUID: $activeGuid)"
                break
            }
        }
    }

    if (-not $activeGuid) {
        # Case 3: actually missing - duplicate, capture new GUID, rename for next-run match.
        $dupOutput = (& powercfg /duplicatescheme $guid 2>&1) -join "`n"
        if ($LASTEXITCODE -ne 0) {
            Add-UecmChange $Changes "WARNING: power plan $PowerProfile GUID not found and duplicatescheme failed; keeping current plan"
            return
        }
        if ($dupOutput -match $guidRegex) {
            $activeGuid = $matches[1]
            & powercfg /changename $activeGuid $uecmPlanTag "Created by UECM bootstrap" 2>&1 | Out-Null
            Add-UecmChange $Changes "$PowerProfile power plan restored via duplicatescheme, tagged $uecmPlanTag (new GUID: $activeGuid)"
        } else {
            Add-UecmChange $Changes "WARNING: duplicatescheme ran but new GUID could not be parsed; keeping current plan"
            return
        }
    }

    & powercfg /setactive $activeGuid 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Add-UecmChange $Changes "WARNING: powercfg setactive returned exit code $LASTEXITCODE; current plan unchanged"
        return
    }
    Add-UecmChange $Changes "active power plan set to $PowerProfile (active GUID: $activeGuid)"
}

try {
    if (-not $StagingSourceDir) { $StagingSourceDir = Split-Path -Parent $PSCommandPath }
    # Defense: a caller (e.g. an unpatched UECM-Bootstrap.cmd passing "%SCRIPT_DIR%"
    # with a trailing backslash -> \" command-line trap) may hand us a path with a
    # stray trailing quote/backslash. Normalize it so Join-Path / Test-Path below
    # never choke with "Illegal characters in path." and abort onboarding.
    $StagingSourceDir = $StagingSourceDir.Trim().Trim('"').TrimEnd('\')
    if (-not $PublicKeyPath) { $PublicKeyPath = Join-Path $StagingSourceDir 'uecm.pub' }

    # 1. resolve UECM public key
    $pub = ''
    if ($UecmPublicKey) { $pub = $UecmPublicKey.Trim() }
    elseif (Test-Path $PublicKeyPath) { $pub = (Get-Content -Raw $PublicKeyPath).Trim() }
    if (-not $pub) { throw "no UECM public key (set -UecmPublicKey or place uecm.pub at $PublicKeyPath)" }
    if ($pub -notmatch '^ssh-(ed25519|rsa) ') { throw "value does not look like an OpenSSH public key" }

    # 2. OpenSSH Server capability
    $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' -ErrorAction SilentlyContinue
    $capInstalled = ($cap -and $cap.State -eq 'Installed')
    if ($cap -and -not $capInstalled) {
        if (-not $CheckOnly) {
            Add-WindowsCapability -Online -Name $cap.Name | Out-Null
            $capInstalled = $true
        }
        Note "installed OpenSSH.Server"
    }
    elseif (-not $cap) {
        Note "WARNING: OpenSSH.Server capability not found (older Windows: install Win32-OpenSSH manually)"
    }

    # 3. services + firewall
    if (-not $CheckOnly) {
        Set-Service -Name sshd -StartupType Automatic -ErrorAction SilentlyContinue
        Set-Service -Name ssh-agent -StartupType Automatic -ErrorAction SilentlyContinue
        Start-Service sshd -ErrorAction SilentlyContinue
        $fw = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
        if (-not $fw) {
            New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' `
                -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
            Note "added firewall rule TCP/22"
        }
        elseif ($fw.Enabled -ne 'True') {
            Enable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' | Out-Null
            Note "enabled existing firewall rule TCP/22"
        }
    }

    # 4. authorize UECM pubkey in administrators_authorized_keys
    #    (uecm-svc is a local admin, so Windows OpenSSH uses this shared file,
    #     not per-user ~/.ssh/authorized_keys). Only enforce the strict ACL on a
    #     freshly created file; never rewrite an existing one (avoids clobbering
    #     a working file's ACL and locking out other authorized keys).
    if (-not $CheckOnly) {
        $keyFileExisted = Test-Path $adminKeys
        $existing = if ($keyFileExisted) { Get-Content $adminKeys } else { @() }
        if ($existing -notcontains $pub) {
            Add-Content -Path $adminKeys -Value $pub -Encoding ascii
            Note "authorized UECM key"
        }
        if (-not $keyFileExisted) {
            icacls $adminKeys /setowner 'BUILTIN\Administrators' | Out-Null
        }
        # Windows OpenSSH ignores admin key files with loose ACLs, so always enforce
        # the canonical secure ACL (SYSTEM + Administrators only) on both fresh and
        # existing files. Single atomic icacls (one DACL write); /grant:r governs file
        # permissions only and never invalidates keys already inside the file.
        icacls $adminKeys /inheritance:r /grant:r 'SYSTEM:(F)' 'BUILTIN\Administrators:(F)' | Out-Null
        Note "enforced authorized_keys ACL"
    }

    # 5. staging dir + copy node scripts (exclude enable-* and self)
    if (-not $CheckOnly) {
        if (-not (Test-Path $staging)) { New-Item -ItemType Directory -Path $staging -Force | Out-Null }
        Get-ChildItem -Path $StagingSourceDir -Filter '*.ps1' -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notlike 'enable-*' -and $_.FullName -ne $PSCommandPath } |
            ForEach-Object { Copy-Item $_.FullName -Destination $staging -Force }
        Note "staged node scripts -> $staging"
    }

    # 6. install PsExec64 (required by inject-system-credential.ps1 to write the
    #    SYSTEM-account cmdkey). It ships in the bootstrap package next to this
    #    script; copy it to the machine-wide UECM dir so node-pure scripts resolve
    #    it deterministically at C:\ProgramData\UECM\PsExec64.exe. Missing PsExec
    #    does not fail onboarding (SSH itself is up); inject fails with a clear
    #    message later if it was never staged.
    if (-not $CheckOnly) {
        # PsExec is non-load-bearing for SSH itself (only SYSTEM cmdkey injection
        # needs it). Any failure here -- incl. a polluted StagingSourceDir yielding
        # an illegal path -- must degrade to a WARNING, never abort onboarding.
        try {
            $psexecSrc = Join-Path $StagingSourceDir 'PsExec64.exe'
            $psexecDst = Join-Path $uecmDir 'PsExec64.exe'
            if (Test-Path -LiteralPath $psexecSrc) {
                if (-not (Test-Path $uecmDir)) { New-Item -ItemType Directory -Path $uecmDir -Force | Out-Null }
                # Staging from C:\ProgramData\UECM itself makes src == dst; Copy-Item
                # -Force errors on copy-onto-itself, so skip when paths resolve equal
                # (keeps re-runs idempotent for that valid layout).
                if ([System.IO.Path]::GetFullPath($psexecSrc) -ieq [System.IO.Path]::GetFullPath($psexecDst)) {
                    Note "PsExec64 already at $uecmDir (staging source is the UECM dir); skipped copy"
                }
                else {
                    Copy-Item -LiteralPath $psexecSrc -Destination $psexecDst -Force
                    Note "installed PsExec64 -> $uecmDir"
                }
            }
            else {
                Note "WARNING: PsExec64.exe not in bootstrap package; SYSTEM credential injection unavailable until staged"
            }
        }
        catch {
            Note "WARNING: PsExec64 install skipped: $($_.Exception.Message)"
        }
    }

    # 7. node prep (folded from enable-winrm.ps1). Idempotent; off unless the
    #    matching switch is passed. Per-step try/catch so prep failure degrades
    #    to a WARNING note instead of aborting onboarding (SSH itself is already
    #    up). Bridges the prep functions' Generic.List into the $changes ArrayList.
    $localAdminOk = $true
    if (-not $CheckOnly) {
        $prep = New-Object 'System.Collections.Generic.List[string]'
        try { Enable-UecmLocalAdmin -Changes $prep }        catch { $localAdminOk = $false; Note "WARNING: local admin prep: $($_.Exception.Message)" }
        try { Enable-UecmSmbServer  -Changes $prep }        catch { Note "WARNING: smb prep: $($_.Exception.Message)" }
        try { Enable-UecmWmi        -Changes $prep }        catch { Note "WARNING: wmi prep: $($_.Exception.Message)" }
        try { Enable-UecmLongPaths  -Changes $prep }        catch { Note "WARNING: longpaths prep: $($_.Exception.Message)" }
        try { Enable-UecmInsecureSmbGuest -Changes $prep }  catch { Note "WARNING: smb guest prep: $($_.Exception.Message)" }
        try { Set-UecmLocalExecutionPolicy -Changes $prep } catch { Note "WARNING: execpolicy prep: $($_.Exception.Message)" }
        try { Set-UecmPowerPlan     -Changes $prep }        catch { Note "WARNING: power prep: $($_.Exception.Message)" }
        foreach ($m in $prep) { Note $m }
    }

    # Readiness reflects ACTUAL prerequisites (correct for -CheckOnly too, which
    # mutates nothing): OpenSSH installed + sshd running + UECM key authorized.
    $sshd = Get-Service sshd -ErrorAction SilentlyContinue
    $sshdRunning = ($sshd -and $sshd.Status -eq 'Running')
    $keyAuthorized = (Test-Path $adminKeys) -and ((Get-Content $adminKeys) -contains $pub)
    # When -CreateLocalAdmin was requested, the uecm-svc account is load-bearing:
    # SshExecutor logs in AS uecm-svc, and Windows OpenSSH only honors the shared
    # administrators_authorized_keys for accounts that are LOCAL ADMINS. So a
    # failed/partial account prep must drag readiness to NOT ready (the prep step
    # only WARNs on failure; this end-state probe is the hard gate). Verify the
    # actual end state: exists + enabled + in Administrators (SID S-1-5-32-544).
    # SshExecutor ALWAYS logs in as 'uecm-svc', so readiness must verify that
    # account exists + is enabled + is a local admin UNCONDITIONALLY -- even when
    # this run didn't create it (-CreateLocalAdmin omitted, e.g. empty
    # UECM_LOCAL_ADMIN_PASSWORD, or -CheckOnly). Otherwise the script could report
    # ok for a node UECM can never SSH into.
    $svcAccountReady = $false
    try {
        $svcUser = Get-LocalUser -Name 'uecm-svc' -ErrorAction SilentlyContinue
        $svcInAdmins = $false
        if ($svcUser) {
            $svcInAdmins = [bool](@(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction SilentlyContinue) |
                Where-Object { $_.SID -eq $svcUser.SID })
        }
        # $localAdminOk folds in this run's prep STEP (it stays true when prep was
        # skipped): if Enable-UecmLocalAdmin threw (e.g. Set-LocalUser -Password
        # failed on an existing account due to password policy / min-age), the
        # recorded password may never have been applied -> not ready.
        $svcAccountReady = [bool]($localAdminOk -and $svcUser -and $svcUser.Enabled -and $svcInAdmins)
    } catch { $svcAccountReady = $false }
    $ok = $capInstalled -and $sshdRunning -and $keyAuthorized -and $svcAccountReady
    if ($ok) {
        $msg = "SSH onboarding complete"
    }
    else {
        $missing = @()
        if (-not $capInstalled) { $missing += 'OpenSSH.Server not installed' }
        if (-not $sshdRunning) { $missing += 'sshd not running' }
        if (-not $keyAuthorized) { $missing += 'UECM key not authorized' }
        if (-not $svcAccountReady) { $missing += "$LocalAdminName account not ready (must exist + be enabled + be in Administrators)" }
        $msg = "not ready: " + ($missing -join '; ')
    }
    @{ ok = $ok; changes = $changes; message = $msg; svc_account_ready = $svcAccountReady } | ConvertTo-Json -Depth 6 -Compress
    exit $(if ($ok) { 0 } else { 1 })
}
catch {
    @{ ok = $false; changes = $changes; message = $_.Exception.Message } | ConvertTo-Json -Depth 6 -Compress
    exit 1
}
