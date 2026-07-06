# Creates a managed SMB share with a dedicated svc account (Mode B): the share
# is authorized only for that local account. Production-grade path.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "ShareName","LocalPath","SvcUsername","SvcPassword" }
# Output: JSON { ok, unc_path, message }
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $ShareName = $p.ShareName
    $LocalPath = $p.LocalPath
    $SvcUsername = $p.SvcUsername
    $SvcPassword = $p.SvcPassword
    if ([string]::IsNullOrWhiteSpace($ShareName) -or [string]::IsNullOrWhiteSpace($LocalPath) -or
        [string]::IsNullOrWhiteSpace($SvcUsername) -or [string]::IsNullOrWhiteSpace($SvcPassword)) {
        throw "ShareName, LocalPath, SvcUsername, SvcPassword are required"
    }

    if (-not (Test-Path -LiteralPath $LocalPath)) {
        New-Item -ItemType Directory -Path $LocalPath -Force | Out-Null
    }
    $svcSecure = ConvertTo-SecureString -String $SvcPassword -AsPlainText -Force
    if (Get-LocalUser -Name $SvcUsername -ErrorAction SilentlyContinue) {
        Set-LocalUser -Name $SvcUsername -Password $svcSecure -PasswordNeverExpires $true
    } else {
        New-LocalUser -Name $SvcUsername -Password $svcSecure -PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword -Description 'UECM share account (Mode B)' | Out-Null
        Add-LocalGroupMember -Group 'Users' -Member $SvcUsername -ErrorAction SilentlyContinue
    }
    icacls $LocalPath /grant "${SvcUsername}:(OI)(CI)F" | Out-Null
    if (Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue) {
        Remove-SmbShare -Name $ShareName -Force
    }
    New-SmbShare -Name $ShareName -Path $LocalPath -FullAccess $SvcUsername -Description 'UECM managed DDC share (Mode B)' | Out-Null
    $unc = "\\$($env:COMPUTERNAME)\$ShareName"
    @{ ok = $true; unc_path = $unc; message = "Mode B share created: $unc as $SvcUsername" } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; unc_path = ""; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}
