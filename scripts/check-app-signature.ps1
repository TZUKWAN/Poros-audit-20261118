param([Parameter(Mandatory=$true)][string]$File)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -Force
(Get-AuthenticodeSignature -LiteralPath ([IO.Path]::GetFullPath($File))).Status.ToString()
