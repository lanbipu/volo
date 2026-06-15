# Creates a USB-friendly UECM SSH bootstrap package.
# The package contains:
# - UECM-Bootstrap.cmd        (双击入口，自提权，纯 SSH 纳管)
# - README.txt                (中文使用说明)
# - enable-ssh.ps1            (节点开 OpenSSH + 授权 UECM 公钥 + 节点 prep + 装 PsExec64)
# - uecm.pub                  (UECM 传输公钥，明文随包)
# - PsExec64.exe              (SYSTEM cmdkey 注入用，enable-ssh.ps1 装到节点)
#
# Replaces package-winrm-bootstrap.ps1 (SSH migration P5a): remote WinRM push is
# retired, so the package no longer ships enable-winrm.ps1 / UECM-Bootstrap-WinRM.ps1.

param(
    [string]$OutputDirectory = (Join-Path (Get-Location) 'UECM-SSH-Bootstrap'),
    [string]$LocalAdminName = '',
    [string]$LocalAdminPassword = '',
    # Path to the UECM transport public key (keystore's uecm_ed25519.pub). REQUIRED:
    # the package onboards SSH transport (enable-ssh.ps1 + uecm.pub), the transport
    # for every UECM command. NOT a [Parameter(Mandatory)] on purpose: that
    # prompts/errors during parameter binding BEFORE the try/catch, so a
    # non-interactive caller would hang instead of getting the parseable JSON error
    # from the explicit empty-check below.
    [string]$UecmPublicKeyPath = ''
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { chcp 65001 | Out-Null } catch {}

$ErrorActionPreference = 'Stop'

try {
    $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
    $sourceCmd = Join-Path $scriptRoot 'UECM-Bootstrap.cmd'
    $sourceReadme = Join-Path $scriptRoot 'uecm-bootstrap-readme.zh-CN.txt'
    $sourceSshPs1 = Join-Path $scriptRoot 'enable-ssh.ps1'
    if (-not (Test-Path $sourceCmd)) {
        throw "UECM-Bootstrap.cmd not found at $sourceCmd"
    }
    if (-not (Test-Path $sourceReadme)) {
        throw "uecm-bootstrap-readme.zh-CN.txt not found at $sourceReadme"
    }
    if (-not (Test-Path $sourceSshPs1)) {
        throw "enable-ssh.ps1 not found at $sourceSshPs1"
    }
    if ([string]::IsNullOrWhiteSpace($UecmPublicKeyPath)) {
        throw "-UecmPublicKeyPath is required (the package onboards SSH transport)"
    }
    if (-not (Test-Path $UecmPublicKeyPath)) {
        throw "UECM public key not found at $UecmPublicKeyPath"
    }

    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

    $targetCmd = Join-Path $OutputDirectory 'UECM-Bootstrap.cmd'
    Copy-Item -Path $sourceCmd -Destination $targetCmd -Force

    # Optionally bake the local-admin credential into the packaged .cmd so the USB
    # package is one-double-click ready (operator presets it once at package time).
    # String.Replace (NOT -replace) so a password with regex/$ chars stays literal.
    # Write UTF-8 WITHOUT BOM - a BOM on the first line would break cmd's @echo off.
    # Name and password are independent: an operator may preset just the name and let
    # on-site staff fill the password into the .cmd later, so do NOT gate the name
    # replacement on a password.
    if ((-not [string]::IsNullOrWhiteSpace($LocalAdminName)) -or (-not [string]::IsNullOrEmpty($LocalAdminPassword))) {
        # cmd.exe does percent-expansion and quote parsing on the .cmd at run time, so
        # a baked password containing % " or ^ would reach PowerShell mangled - the
        # created account password would not match what the operator recorded. Refuse
        # rather than silently bake a wrong credential.
        if ($LocalAdminPassword -match '[%"^]') {
            throw 'LocalAdminPassword contains % " or ^, which cmd.exe mangles in the packaged .cmd. Use a password without those characters, or extract the package and fill the password into UECM-Bootstrap.cmd by hand.'
        }
        $enc = New-Object System.Text.UTF8Encoding $false
        $cmdText = [System.IO.File]::ReadAllText($targetCmd, $enc)
        if (-not [string]::IsNullOrWhiteSpace($LocalAdminName)) {
            $cmdText = $cmdText.Replace('set "UECM_LOCAL_ADMIN=uecm-svc"', 'set "UECM_LOCAL_ADMIN=' + $LocalAdminName + '"')
        }
        if (-not [string]::IsNullOrEmpty($LocalAdminPassword)) {
            $cmdText = $cmdText.Replace('set "UECM_LOCAL_ADMIN_PASSWORD="', 'set "UECM_LOCAL_ADMIN_PASSWORD=' + $LocalAdminPassword + '"')
        }
        [System.IO.File]::WriteAllText($targetCmd, $cmdText, $enc)
    }

    # README is a separate UTF-8 file (NOT inline heredoc) to avoid the Windows
    # PowerShell 5.1 mojibake trap: when the host code page is not UTF-8, PS 5.1
    # re-encodes the .ps1 source through the ANSI code page during parse, which
    # corrupts CJK characters before they ever reach the file writer. Binary
    # Copy-Item bypasses all string parsing.
    $targetReadme = Join-Path $OutputDirectory 'README.txt'
    Copy-Item -Path $sourceReadme -Destination $targetReadme -Force

    # SSH transport onboarding files.
    Copy-Item -Path $sourceSshPs1 -Destination (Join-Path $OutputDirectory 'enable-ssh.ps1') -Force
    $pub = (Get-Content -Raw $UecmPublicKeyPath).Trim()
    $encNoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'uecm.pub'), $pub + "`n", $encNoBom)
    # PsExec64 is required by inject-system-credential.ps1 to write the SYSTEM
    # cmdkey; enable-ssh.ps1 installs it on the node from this package dir.
    $sourcePsExec = Join-Path (Split-Path -Parent $scriptRoot) 'vendor\PsExec64.exe'
    if (-not (Test-Path $sourcePsExec)) { throw "PsExec64.exe not found at $sourcePsExec (needed for SSH SYSTEM-cred injection)" }
    Copy-Item -Path $sourcePsExec -Destination (Join-Path $OutputDirectory 'PsExec64.exe') -Force

    $files = New-Object System.Collections.ArrayList
    [void]$files.AddRange(@('UECM-Bootstrap.cmd', 'README.txt', 'enable-ssh.ps1', 'uecm.pub', 'PsExec64.exe'))

    @{
        ok = $true
        message = 'UECM SSH bootstrap package created'
        output_directory = (Resolve-Path $OutputDirectory).Path
        files = $files
        local_admin_baked = (-not [string]::IsNullOrEmpty($LocalAdminPassword))
    } | ConvertTo-Json -Compress
    exit 0
}
catch {
    @{
        ok = $false
        message = $_.Exception.Message
        output_directory = $OutputDirectory
        files = @()
    } | ConvertTo-Json -Compress
    exit 1
}
