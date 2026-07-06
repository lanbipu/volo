# Tears down an SMB share previously created by setup-share-mode-{a,b}.ps1.
# Removes the SMB share (Remove-SmbShare) and, for Mode B, the dedicated svc
# local account (Remove-LocalUser). KeepFiles=true leaves the folder + cached
# files on disk (the default for "取消该服务器部署"); KeepFiles=false also
# deletes the local folder.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "ShareName","SvcUsername"|null,"LocalPath"|null,"KeepFiles":bool }
# Output: JSON { ok, message, removed_share, removed_user, removed_files }
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $ShareName = $p.ShareName
    $SvcUsername = $p.SvcUsername
    $LocalPath = $p.LocalPath
    $KeepFiles = [bool]$p.KeepFiles
    if ([string]::IsNullOrWhiteSpace($ShareName)) { throw "ShareName is required" }

    $removedShare = $false
    if (Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue) {
        Remove-SmbShare -Name $ShareName -Force
        $removedShare = $true
    }
    # Read-back: the share must actually be gone before we report success.
    if (Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue) {
        throw "share '$ShareName' still present after Remove-SmbShare"
    }

    # Mode B: drop the dedicated svc local account that locked the share —
    # but ONLY if no other share still grants it. The svc account name is a
    # fixed default (ddc-svc) shared across Mode B shares on this host, so an
    # unconditional Remove-LocalUser here orphans every other Mode B share's
    # ACL (root cause of the "joined but access denied" incident, 2026-07-06).
    $removedUser = $false
    $keptUserReason = $null
    if (-not [string]::IsNullOrWhiteSpace($SvcUsername)) {
        if (Get-LocalUser -Name $SvcUsername -ErrorAction SilentlyContinue) {
            $stillUsedBy = @(Get-SmbShare -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -ne $ShareName } |
                Where-Object {
                    @(Get-SmbShareAccess -Name $_.Name -ErrorAction SilentlyContinue |
                      Where-Object { $_.AccountName.Split('\')[-1] -eq $SvcUsername }).Count -gt 0
                } | ForEach-Object { $_.Name })
            if ($stillUsedBy.Count -gt 0) {
                $keptUserReason = "svc account '$SvcUsername' kept: still used by share(s) $($stillUsedBy -join ', ')"
            } else {
                Remove-LocalUser -Name $SvcUsername
                $removedUser = $true
            }
        }
    }

    # KeepFiles=false additionally removes the on-disk cache folder.
    $removedFiles = $false
    if (-not $KeepFiles -and -not [string]::IsNullOrWhiteSpace($LocalPath) -and (Test-Path -LiteralPath $LocalPath)) {
        Remove-Item -LiteralPath $LocalPath -Recurse -Force
        $removedFiles = $true
    }

    $msg = "share '$ShareName' torn down (keep_files=$KeepFiles)"
    if ($keptUserReason) { $msg = "$msg; $keptUserReason" }
    @{ ok = $true; removed_share = $removedShare; removed_user = $removedUser; removed_files = $removedFiles;
       message = $msg } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}
