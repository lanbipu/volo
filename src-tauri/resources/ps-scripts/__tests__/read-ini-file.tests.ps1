# Manual: run on a Windows box to verify tuple values survive parse.
$tempFile = [System.IO.Path]::GetTempFileName()
Set-Content -Path $tempFile -Value @"
[DerivedDataBackendGraph]
Shared=(Type=FileSystem, Path=\\NAS\DDC, ReadOnly=false)
"@ -Encoding UTF8
$out = & "$PSScriptRoot\..\read-ini-file.ps1" -HostName 'localhost' -FilePath $tempFile -Local | ConvertFrom-Json
$bg = $out.sections | Where-Object { $_.name -eq 'DerivedDataBackendGraph' }
$shared = $bg.keys | Where-Object { $_.name -eq 'Shared' }
if ($shared.value -notmatch '^\(') { throw "tuple value lost the leading paren" }
if ($shared.value -notmatch 'Type=FileSystem') { throw "tuple body lost Type" }
Remove-Item $tempFile
"OK"
