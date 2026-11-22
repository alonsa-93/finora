# Installs MoneyCash for daily use OUTSIDE OneDrive:
#   %LOCALAPPDATA%\Programs\MoneyCash\runtime\  - the stock Electron runtime (electron.exe), used by the
#                                                Electron window and "Start with Windows"
#   %LOCALAPPDATA%\Programs\MoneyCash\app\      - electron\, server\ (no tests), web\, package.json and
#                                                the PRODUCTION node_modules only
# The folder gets a protected ACL (current user + SYSTEM + Administrators, no inherited entries), and
# the Desktop / Start-menu shortcuts are (re)created to point there. Your data stays where it is
# (%LOCALAPPDATA%\MoneyCash) and is not touched by this script.
#
# Usage (from the project folder):
#   powershell -ExecutionPolicy Bypass -File scripts\install-local.ps1
# Options: -Destination <dir>  -NoShortcuts  (for a trial install somewhere else)
param(
  [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Programs\MoneyCash'),
  [switch]$NoShortcuts
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sys = Join-Path $env:SystemRoot 'System32'

function Test-UnderOneDrive([string]$p) {
  $full = [IO.Path]::GetFullPath($p).TrimEnd('\') + '\'
  foreach ($k in 'OneDrive', 'OneDriveConsumer', 'OneDriveCommercial') {
    $r = [Environment]::GetEnvironmentVariable($k)
    if ($r -and $full.StartsWith(([IO.Path]::GetFullPath($r).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $full -match '\\OneDrive( - [^\\]+)?\\'
}

$Destination = [IO.Path]::GetFullPath($Destination)
if (Test-UnderOneDrive $Destination) { throw "The destination must not be inside OneDrive: $Destination" }
$electronDist = Join-Path $root 'node_modules\electron\dist'
if (-not (Test-Path (Join-Path $electronDist 'electron.exe'))) { throw "Electron runtime not found. Run 'npm ci' in $root first." }

# Refuse to replace files of a running local install.
$running = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Destination, [StringComparison]::OrdinalIgnoreCase) }
if ($running) { throw 'MoneyCash is running from the install folder. Quit it (tray icon > Exit) and run this again.' }

# Production dependency list straight from npm (no dev packages, no electron-builder).
Push-Location $root
try {
  $prod = & npm ls --omit=dev --all --parseable 2>$null | Where-Object { $_ -and ($_ -ne $root) }
  if ($LASTEXITCODE -ne 0 -or -not $prod) { throw "'npm ls --omit=dev' failed; run 'npm ci' first." }
} finally { Pop-Location }

# Folders this script may delete: absent, empty, an earlier install (app\moneycash-install.json), or
# the staging folder it created itself (marked with $stageMark). Anything else stops the script.
$stageMark = '.moneycash-staging'
function Assert-SafeToReplace([string]$dir, [switch]$Stage) {
  if (-not (Test-Path -LiteralPath $dir)) { return }
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "Refusing to replace '$dir': it is a file, not a MoneyCash folder." }
  if (-not (Get-ChildItem -LiteralPath $dir -Force | Select-Object -First 1)) { return }
  if (Test-Path -LiteralPath (Join-Path $dir 'app\moneycash-install.json')) { return }
  if ($Stage -and (Test-Path -LiteralPath (Join-Path $dir $stageMark))) { return }
  throw "Refusing to delete '$dir': it is not empty and is not a MoneyCash install. Choose another -Destination or empty it yourself."
}

$stage = "$Destination.new"
Assert-SafeToReplace $stage -Stage
Assert-SafeToReplace $Destination
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $stage 'app') | Out-Null
New-Item -ItemType File -Path (Join-Path $stage $stageMark) | Out-Null

Write-Output 'Copying the Electron runtime...'
# A plain copy (never a hard link): the install must not share files with the checkout.
& "$sys\robocopy.exe" $electronDist (Join-Path $stage 'runtime') /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy (runtime) failed: $LASTEXITCODE" }

Write-Output 'Copying the app...'
foreach ($d in 'electron', 'server', 'web') {
  & "$sys\robocopy.exe" (Join-Path $root $d) (Join-Path $stage "app\$d") /E /XD test /XF '*.md' /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy ($d) failed: $LASTEXITCODE" }
}
Copy-Item (Join-Path $root 'package.json') (Join-Path $stage 'app\package.json')
Copy-Item (Join-Path $root 'package-lock.json') (Join-Path $stage 'app\package-lock.json')
# Install marker: developer mode (--dev / MONEYCASH_DEV=1) is refused wherever this file exists
# (server/devmode.js), so the installed copy can never be switched into dev mode.
$marker = @{ installedBy = 'install-local.ps1'; installedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $stage 'app\moneycash-install.json'), $marker, (New-Object Text.UTF8Encoding $false))

Write-Output "Copying $(@($prod).Count) production packages..."
$nmRoot = Join-Path $root 'node_modules'
foreach ($pkg in $prod) {
  $rel = $pkg.Substring($root.Length).TrimStart('\')          # node_modules\x\node_modules\y
  $src = Join-Path $root $rel
  $dst = Join-Path (Join-Path $stage 'app') $rel
  # Copy the package without its nested node_modules (those are listed separately when needed).
  & "$sys\robocopy.exe" $src $dst /E /XD (Join-Path $src 'node_modules') /XF '*.map' '*.ts' '*.cts' '*.mts' /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy ($rel) failed: $LASTEXITCODE" }
}

# Swap in the new version.
Remove-Item -LiteralPath (Join-Path $stage $stageMark) -Force
Assert-SafeToReplace $Destination
if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
Move-Item -LiteralPath $stage -Destination $Destination

# Protected ACL: current user + SYSTEM + Administrators only, no inherited entries.
# Set on the folder only: the (OI)(CI) entries are inherited by every file and subfolder. Do NOT add
# /T - it would also strip inheritance from each file, where (OI)(CI) grants do not apply, leaving
# every file with an empty ACL (unreadable, so electron.exe cannot start).
$sid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
& "$sys\icacls.exe" $Destination /inheritance:r /grant:r "*${sid}:(OI)(CI)F" /grant:r '*S-1-5-18:(OI)(CI)F' /grant:r '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed: $LASTEXITCODE" }
# Fail loudly if a file did not end up readable.
try { [IO.File]::OpenRead((Join-Path $Destination 'runtime\electron.exe')).Close() } catch { throw "The installed files are not readable after setting permissions: $($_.Exception.Message)" }

# The Electron runtime is optional: the shortcut uses signed Node.js + an Edge app window
# (create-shortcut.ps1), because Smart App Control may refuse the unsigned electron.exe. Report only.
$exe = Join-Path $Destination 'runtime\electron.exe'
try {
  $p = Start-Process -FilePath $exe -ArgumentList '--version' -NoNewWindow -Wait -PassThru -ErrorAction Stop
  Write-Output "Electron runtime: starts (exit $($p.ExitCode))"
} catch {
  Write-Output 'Electron runtime: blocked by Smart App Control (not needed: the shortcut uses Node.js + Edge).'
}

if (-not $NoShortcuts) { & (Join-Path $PSScriptRoot 'create-shortcut.ps1') -InstallDir $Destination }
Write-Output "Installed to $Destination"
