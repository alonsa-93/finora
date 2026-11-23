# Removes a Finora install made by install-local.ps1: its folder, its "Finora" shortcuts and its
# "Start with Windows" entry. NEVER the data: %LOCALAPPDATA%\Finora (connections, encrypted data,
# the data key, backups) stays as it is, so installing again continues where you left off.
# install-local.ps1 copies this file into the install folder as uninstall.ps1.
# Options: -InstallDir <dir> (default: the folder this script is in, if it is an install; otherwise
#          %LOCALAPPDATA%\Programs\Finora)  -ShortcutDir <dir> (a trial install's shortcut folder)
param(
  [string]$InstallDir = '',
  [string]$ShortcutDir = ''
)
$ErrorActionPreference = 'Stop'
if (-not $InstallDir) {
  $InstallDir = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'app\finora-install.json')) { $PSScriptRoot }
                else { Join-Path $env:LOCALAPPDATA 'Programs\Finora' }
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'app\finora-install.json'))) {
  throw "No Finora install in $InstallDir (app\finora-install.json is missing). Nothing was removed."
}
$dataDir = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Finora')).TrimEnd('\')
if ($InstallDir -eq $dataDir) { throw 'Refusing: that is the data folder, not an install.' }

$slash = "$InstallDir\"
$running = Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='node.exe'" |
  Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($slash, [StringComparison]::OrdinalIgnoreCase)) -or
                 ($_.CommandLine -and $_.CommandLine.IndexOf($slash, [StringComparison]::OrdinalIgnoreCase) -ge 0) }
if ($running) { throw 'Finora is running. Close its window, wait for a sync to finish, and run this again.' }

# Shortcuts named Finora that point into this install only.
$shell = New-Object -ComObject WScript.Shell
$links = if ($ShortcutDir) { @((Join-Path $ShortcutDir 'Finora.lnk')) }
         else { @((Join-Path ([Environment]::GetFolderPath('Programs')) 'Finora.lnk'),
                  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Finora.lnk')) }
foreach ($l in $links) {
  if (-not (Test-Path -LiteralPath $l)) { continue }
  $s = $shell.CreateShortcut($l)
  if ("$($s.TargetPath) $($s.Arguments)".IndexOf($slash, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    Remove-Item -LiteralPath $l -Force
    Write-Output "Removed $l"
  }
}
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$run = (Get-ItemProperty -Path $runKey -Name 'Finora' -ErrorAction SilentlyContinue).Finora
if ($run -and $run.IndexOf($slash, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
  Remove-ItemProperty -Path $runKey -Name 'Finora'
  Write-Output 'Removed the "Start with Windows" entry.'
}

Set-Location -LiteralPath $env:TEMP   # not inside the folder being removed
Remove-Item -LiteralPath $InstallDir -Recurse -Force
Write-Output "Removed $InstallDir"
Write-Output "Your data was kept: $dataDir"
