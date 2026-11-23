# Builds the two release packages of Finora that run on a PC with Smart App Control on (no unsigned
# .exe anywhere: Node.js is Authenticode-signed, the window is Microsoft Edge):
#   <Out>\Finora-<version>-setup\     the regular install: "התקנת Finora.cmd" installs into
#                                     %LOCALAPPDATA%\Programs\Finora with Start-menu and Desktop
#                                     shortcuts (install-local.ps1), "הסרת Finora.cmd" removes it
#   <Out>\Finora-<version>-portable\  the portable version: "הפעלת Finora.cmd" runs it from wherever
#                                     the folder is (not inside OneDrive); nothing is installed
# Both use the same data folder, %LOCALAPPDATA%\Finora, so they open the same connections, and the
# app keeps one Finora running at a time. Neither one ever touches that folder while installing.
# The app files come from install-local.ps1 itself (a trial install into <Out>\_build), so the
# packages hold exactly what a local install holds. Every file is listed with its SHA-256 in
# app\finora-payload.json; the installer checks each copy against it.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\package.ps1 -Out <folder outside OneDrive>
# UTF-8 with BOM (Hebrew file names).
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sys = Join-Path $env:SystemRoot 'System32'
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$Out = [IO.Path]::GetFullPath($Out)

$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path $node)) { throw 'Node.js is not installed in Program Files.' }
if ((Get-AuthenticodeSignature $node).Status -ne 'Valid') { throw "$node is not validly signed." }
$nodeVersion = (& $node --version).Trim()
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 26) { throw "Node.js $nodeVersion is too old (26 or newer)." }

$setup = Join-Path $Out "Finora-$version-setup"
$portable = Join-Path $Out "Finora-$version-portable"
$build = Join-Path $Out '_build'
foreach ($d in $setup, $portable) {
  if (Test-Path -LiteralPath $d) { throw "$d already exists. Choose an empty -Out folder." }
}

# 1. The app, exactly as install-local.ps1 installs it (no shortcuts, no Electron runtime).
& (Join-Path $PSScriptRoot 'install-local.ps1') -Destination $build -NoShortcuts -NoRuntime | Out-Host
$builtApp = Join-Path $build 'app'

function Copy-Tree([string]$from, [string]$to) {
  & "$sys\robocopy.exe" $from $to /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $from failed: $LASTEXITCODE" }
}
function Copy-Node([string]$to) {
  New-Item -ItemType Directory -Force $to | Out-Null
  Copy-Item -LiteralPath $node (Join-Path $to 'node.exe')
  $lic = Join-Path (Split-Path $node) 'LICENSE'
  if (Test-Path $lic) { Copy-Item -LiteralPath $lic (Join-Path $to 'LICENSE') }
}
# app\finora-payload.json: every file of app\ and node\ (paths relative to $base) with its SHA-256.
function Write-Manifest([string]$base) {
  $prefix = $base.TrimEnd('\').Length + 1
  $files = Get-ChildItem -LiteralPath (Join-Path $base 'app'), (Join-Path $base 'node') -Recurse -File -Force |
    Where-Object { $_.Name -ne 'finora-payload.json' } |
    Sort-Object FullName |
    ForEach-Object { [ordered]@{ path = $_.FullName.Substring($prefix); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } }
  $m = [ordered]@{ product = 'Finora'; version = $version; node = $nodeVersion; files = @($files) }
  [IO.File]::WriteAllText((Join-Path $base 'app\finora-payload.json'), ($m | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
}
$utf8 = New-Object Text.UTF8Encoding $false
function Write-Text([string]$path, [string]$text) { [IO.File]::WriteAllText($path, ($text -replace "`r?`n", "`r`n"), $utf8) }
# The user guide of each package: docs\guide-*.he.html with the version filled in.
function Write-Guide([string]$name, [string]$to) {
  $html = [IO.File]::ReadAllText((Join-Path $root "docs\$name"), [Text.Encoding]::UTF8)
  Write-Text $to ($html.Replace('{{VERSION}}', $version).Replace('{{NODE}}', $nodeVersion))
}
function Write-Cmd([string]$path, [string]$text) { [IO.File]::WriteAllText($path, ($text -replace "`r?`n", "`r`n"), [Text.Encoding]::ASCII) }

# 2. The regular install.
$files = Join-Path $setup 'files'
Copy-Tree $builtApp (Join-Path $files 'app')
Remove-Item -LiteralPath (Join-Path $files 'app\finora-install.json') -Force   # the installer writes its own
Copy-Node (Join-Path $files 'node')
New-Item -ItemType Directory -Force (Join-Path $files 'scripts') | Out-Null
foreach ($s in 'install-local.ps1', 'create-shortcut.ps1', 'uninstall-local.ps1', 'setup-ui.ps1') {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $s) (Join-Path $files "scripts\$s")
}
Write-Manifest $files
Write-Cmd (Join-Path $setup 'התקנת Finora.cmd') @'
@echo off
rem Installs Finora into %LOCALAPPDATA%\Programs\Finora (files\scripts\install-local.ps1).
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0files\scripts\setup-ui.ps1" -Action install
'@
Write-Cmd (Join-Path $setup 'הסרת Finora.cmd') @'
@echo off
rem Removes the installed Finora (its uninstall.ps1). The data folder is never touched.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0files\scripts\setup-ui.ps1" -Action uninstall
'@
Write-Guide 'guide-setup.he.html' (Join-Path $setup 'מדריך.html')

# 3. The portable version.
Copy-Tree $builtApp (Join-Path $portable 'app')   # keeps app\finora-install.json: no developer mode
Copy-Node (Join-Path $portable 'node')
Write-Manifest $portable
Write-Cmd (Join-Path $portable 'הפעלת Finora.cmd') @'
@echo off
rem Finora, portable: runs from this folder with its own signed Node.js and an Edge app window.
rem Data: %LOCALAPPDATA%\Finora (the same as the installed Finora). Not from a OneDrive folder.
echo %~dp0| "%SystemRoot%\System32\findstr.exe" /i /c:"\OneDrive" >nul
if not errorlevel 1 (
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('Finora cannot run from a OneDrive folder. Copy this folder to another place (for example C:\Finora or a USB drive) and run it from there.', 'Finora', 'OK', 'Warning')"
  exit /b 1
)
start "" "%SystemRoot%\System32\conhost.exe" --headless "%~dp0node\node.exe" "%~dp0app\server\index.js" --app-window
'@
Write-Guide 'guide-portable.he.html' (Join-Path $portable 'מדריך.html')

# 4. Clean up the trial install.
Remove-Item -LiteralPath $build -Recurse -Force
Write-Output "Built $setup"
Write-Output "Built $portable"
