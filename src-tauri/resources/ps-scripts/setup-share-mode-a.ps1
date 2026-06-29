# Creates an open SMB share (Everyone:Full, Mode A) for trusted on-set networks.
# Enables the Guest account AND relaxes the two default Windows policies that would
# otherwise refuse guest network logon (LimitBlankPasswordUse + the Guest entry in
# SeDenyNetworkLogonRight) — without those a Mode-A share is created but still prompts
# every client for credentials. Security trade-off is intentional for on-set LANs.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "ShareName","LocalPath" }
# Output: JSON { ok, unc_path, message }
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $ShareName = $p.ShareName
    $LocalPath = $p.LocalPath
    if ([string]::IsNullOrWhiteSpace($ShareName) -or [string]::IsNullOrWhiteSpace($LocalPath)) {
        throw "ShareName and LocalPath are required"
    }

    if (-not (Test-Path -LiteralPath $LocalPath)) {
        New-Item -ItemType Directory -Path $LocalPath -Force | Out-Null
    }
    $guest = Get-LocalUser -Name 'Guest' -ErrorAction Stop
    if (-not $guest.Enabled) { Enable-LocalUser -Name 'Guest' }
    $regPath = 'HKLM:\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters'
    Set-ItemProperty -Path $regPath -Name 'AutoShareWks' -Value 1 -Type DWord -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $regPath -Name 'RestrictNullSessAccess' -Value 0 -Type DWord -ErrorAction SilentlyContinue

    # --- make the Guest account actually usable over the network (this is the point of Mode A) ---
    # Enabling Guest + an Everyone:Full share ACL is NOT enough on a default Windows:
    # two more policies silently refuse guest network logon, so the share gets created
    # but every client still hits a credential prompt. Both must be relaxed for guest
    # SMB on a trusted on-set network (server-side mirror of the AllowInsecureGuestAuth=1
    # that enable-ssh.ps1 sets on the client):
    #   1) LimitBlankPasswordUse=1 (default) bars blank-password accounts (Guest has a
    #      blank password) from network logon -> client error 1326 ("用户名或密码不正确").
    #   2) "Deny access to this computer from the network" (SeDenyNetworkLogonRight)
    #      contains Guest by default            -> client error 1385.
    Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Lsa' -Name 'LimitBlankPasswordUse' -Value 0 -Type DWord

    # Remove ONLY Guest from SeDenyNetworkLogonRight, preserving any other denied
    # principal. No native cmdlet exists for user-rights assignment, so round-trip via
    # secedit (export -> drop Guest -> configure). Match Guest by SID (RID 501) so a
    # localized / renamed Guest display name is still caught. secedit /configure only
    # touches the rights present in the template, so other user rights are untouched.
    $guestSid = $guest.SID.Value
    $urExport = Join-Path $env:TEMP 'uecm_ur_export.inf'
    secedit /export /areas USER_RIGHTS /cfg $urExport | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "secedit /export (USER_RIGHTS) failed (exit $LASTEXITCODE)" }
    $denyLine = (Select-String -Path $urExport -Pattern '^SeDenyNetworkLogonRight\s*=' -ErrorAction SilentlyContinue).Line
    if ($denyLine) {
        $kept = @()
        foreach ($tok in (($denyLine -split '=', 2)[1] -split ',')) {
            $t = $tok.Trim(); if (-not $t) { continue }
            $bare = $t.TrimStart('*')
            $isGuest = ($bare -eq $guestSid)
            if (-not $isGuest -and ($bare -notlike 'S-1-*')) {
                try { $isGuest = ((New-Object System.Security.Principal.NTAccount($bare)).Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $guestSid) }
                catch { $isGuest = ($bare -eq 'Guest') }
            }
            if (-not $isGuest) { $kept += $t }
        }
        $urApply = Join-Path $env:TEMP 'uecm_ur_apply.inf'
        $urDb    = Join-Path $env:TEMP 'uecm_ur_apply.sdb'
        @('[Unicode]', 'Unicode=yes', '[Version]', 'signature="$CHICAGO$"', 'Revision=1',
          '[Privilege Rights]', ('SeDenyNetworkLogonRight = ' + ($kept -join ','))) |
            Set-Content -Path $urApply -Encoding Unicode
        secedit /configure /db $urDb /cfg $urApply /areas USER_RIGHTS | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "secedit /configure (SeDenyNetworkLogonRight) failed (exit $LASTEXITCODE)" }
        Remove-Item $urApply, $urDb -ErrorAction SilentlyContinue
    }
    Remove-Item $urExport -ErrorAction SilentlyContinue

    if (Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue) {
        Remove-SmbShare -Name $ShareName -Force
    }
    New-SmbShare -Name $ShareName -Path $LocalPath -FullAccess 'Everyone' -Description 'UECM open DDC share (Mode A)' | Out-Null
    icacls $LocalPath /grant 'Everyone:(OI)(CI)F' | Out-Null
    $unc = "\\$($env:COMPUTERNAME)\$ShareName"
    @{ ok = $true; unc_path = $unc; message = "Mode A share created: $unc" } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; unc_path = ""; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}
