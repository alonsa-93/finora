# Installs Finora for daily use OUTSIDE OneDrive:
#   %LOCALAPPDATA%\Programs\Finora\app\      - electron\, server\ (no tests), web\, package.json and
#                                                the PRODUCTION node_modules only
#   %LOCALAPPDATA%\Programs\Finora\node\     - (from a release package) the signed Node.js that runs it
#   %LOCALAPPDATA%\Programs\Finora\runtime\  - (from the project folder) the stock Electron runtime,
#                                                optional: the shortcut uses Node.js + an Edge window
# The folder gets a protected ACL (current user + SYSTEM + Administrators, no inherited entries), and
# the Desktop / Start-menu shortcuts are (re)created to point there. Your data stays where it is
# (%LOCALAPPDATA%\Finora) and is not touched by this script.
#
# Two sources, same result:
#   - the project folder: powershell -ExecutionPolicy Bypass -File scripts\install-local.ps1
#   - a release package made by scripts\package.ps1 (it holds app\finora-payload.json): its
#     "Install Finora" file runs this same script from the package's files\scripts folder.
# Options: -Destination <dir>  -NoShortcuts  -ShortcutDir <dir>  (for a trial install somewhere else)
#          -NoRuntime  (project folder only: leave out the Electron runtime; package.ps1 uses it)
param(
  [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Programs\Finora'),
  [switch]$NoShortcuts,
  [string]$ShortcutDir = '',
  [switch]$NoRuntime
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sys = Join-Path $env:SystemRoot 'System32'
$defaultDestination = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\Finora'))

function Test-UnderOneDrive([string]$p) {
  $full = [IO.Path]::GetFullPath($p).TrimEnd('\') + '\'
  foreach ($k in 'OneDrive', 'OneDriveConsumer', 'OneDriveCommercial') {
    $r = [Environment]::GetEnvironmentVariable($k)
    if ($r -and $full.StartsWith(([IO.Path]::GetFullPath($r).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $full -match '\\OneDrive( - [^\\]+)?\\'
}

# A release package carries a ready app\ (and node\); the project folder is copied from source.
$payload = Join-Path $root 'app'
$fromPackage = Test-Path -LiteralPath (Join-Path $payload 'finora-payload.json')

$Destination = [IO.Path]::GetFullPath($Destination)
if (Test-UnderOneDrive $Destination) { throw "The destination must not be inside OneDrive: $Destination" }
if ($fromPackage) {
  # Windows tools stop at 260 characters: a destination that deep would leave files out.
  $manifest = Get-Content -LiteralPath (Join-Path $payload 'finora-payload.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $longest = ($manifest.files | ForEach-Object { $_.path.Length } | Measure-Object -Maximum).Maximum
  if ("$Destination.new\".Length + $longest -ge 255) { throw "The destination path is too long for Windows: $Destination. Choose a shorter folder." }
}
$electronDist = Join-Path $root 'node_modules\electron\dist'
if (-not $fromPackage -and -not $NoRuntime -and -not (Test-Path (Join-Path $electronDist 'electron.exe'))) { throw "Electron runtime not found. Run 'npm ci' in $root first." }

# Refuse to replace files of a running install: the Electron window, or the Node.js server of the
# shortcut (node.exe in the install folder, or any node.exe running the installed server\index.js).
$destSlash = $Destination.TrimEnd('\') + '\'
$running = Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='node.exe'" |
  Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($destSlash, [StringComparison]::OrdinalIgnoreCase)) -or
                 ($_.CommandLine -and $_.CommandLine.IndexOf($destSlash, [StringComparison]::OrdinalIgnoreCase) -ge 0) }
if ($running) { throw 'Finora is running from the install folder. Close its window, wait for a sync to finish, and run this again.' }

# The app was called MoneyCash before 1.1. Its install is removed after a successful install below;
# it must not be running now (it would also keep the data folder from moving to its new name).
$legacy = Join-Path $env:LOCALAPPDATA 'Programs\MoneyCash'
$legacyRunning = Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='node.exe'" |
  Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($legacy, [StringComparison]::OrdinalIgnoreCase)) -or
                 ($_.CommandLine -and $_.CommandLine.IndexOf($legacy, [StringComparison]::OrdinalIgnoreCase) -ge 0) }
if ($legacyRunning) { throw 'MoneyCash (the earlier name of Finora) is running. Close its window and run this again.' }

if (-not $fromPackage) {
  # Production dependency list straight from npm (no dev packages, no electron-builder).
  Push-Location $root
  try {
    $prod = & npm ls --omit=dev --all --parseable 2>$null | Where-Object { $_ -and ($_ -ne $root) }
    if ($LASTEXITCODE -ne 0 -or -not $prod) { throw "'npm ls --omit=dev' failed; run 'npm ci' first." }
  } finally { Pop-Location }
}

# Folders this script may delete: absent, empty, an earlier install (app\finora-install.json), or
# the staging folder it created itself (marked with $stageMark). Anything else stops the script.
$stageMark = '.finora-staging'
function Assert-SafeToReplace([string]$dir, [switch]$Stage) {
  if (-not (Test-Path -LiteralPath $dir)) { return }
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "Refusing to replace '$dir': it is a file, not a Finora folder." }
  if (-not (Get-ChildItem -LiteralPath $dir -Force | Select-Object -First 1)) { return }
  if (Test-Path -LiteralPath (Join-Path $dir 'app\finora-install.json')) { return }
  if ($Stage -and (Test-Path -LiteralPath (Join-Path $dir $stageMark))) { return }
  throw "Refusing to delete '$dir': it is not empty and is not a Finora install. Choose another -Destination or empty it yourself."
}

$stage = "$Destination.new"
Assert-SafeToReplace $stage -Stage
Assert-SafeToReplace $Destination
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $stage 'app') | Out-Null
New-Item -ItemType File -Path (Join-Path $stage $stageMark) | Out-Null

if ($fromPackage) {
  Write-Output 'Copying the app...'
  & "$sys\robocopy.exe" $payload (Join-Path $stage 'app') /E /XF 'finora-payload.json' /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy (app) failed: $LASTEXITCODE" }
  $nodeSrc = Join-Path $root 'node'
  if (Test-Path -LiteralPath (Join-Path $nodeSrc 'node.exe')) {
    Write-Output 'Copying Node.js...'
    & "$sys\robocopy.exe" $nodeSrc (Join-Path $stage 'node') /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy (node) failed: $LASTEXITCODE" }
  }
  # The package lists every file it holds with its SHA-256: a copy that differs stops the install.
  $bad = @()
  foreach ($f in $manifest.files) {
    $p = Join-Path $stage $f.path
    if (-not (Test-Path -LiteralPath $p) -or (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -ne $f.sha256) { $bad += $f.path }
  }
  if ($bad.Count) { throw "$($bad.Count) file(s) did not copy correctly, e.g. $($bad[0]). Nothing was changed." }
  Write-Output "Checked $(@($manifest.files).Count) files."
} else {
  if (-not $NoRuntime) {
    Write-Output 'Copying the Electron runtime...'
    # A plain copy (never a hard link): the install must not share files with the checkout.
    & "$sys\robocopy.exe" $electronDist (Join-Path $stage 'runtime') /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy (runtime) failed: $LASTEXITCODE" }
  }

  Write-Output 'Copying the app...'
  foreach ($d in 'electron', 'server', 'web') {
    & "$sys\robocopy.exe" (Join-Path $root $d) (Join-Path $stage "app\$d") /E /XD test /XF '*.md' /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy ($d) failed: $LASTEXITCODE" }
  }
  Copy-Item (Join-Path $root 'package.json') (Join-Path $stage 'app\package.json')
  Copy-Item (Join-Path $root 'package-lock.json') (Join-Path $stage 'app\package-lock.json')

  Write-Output "Copying $(@($prod).Count) production packages..."
  foreach ($pkg in $prod) {
    $rel = $pkg.Substring($root.Length).TrimStart('\')          # node_modules\x\node_modules\y
    $src = Join-Path $root $rel
    $dst = Join-Path (Join-Path $stage 'app') $rel
    # Copy the package without its nested node_modules (those are listed separately when needed).
    & "$sys\robocopy.exe" $src $dst /E /XD (Join-Path $src 'node_modules') /XF '*.map' '*.ts' '*.cts' '*.mts' /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy ($rel) failed: $LASTEXITCODE" }
  }
}
# Install marker: developer mode (--dev / FINORA_DEV=1) is refused wherever this file exists
# (server/devmode.js), so the installed copy can never be switched into dev mode.
$marker = @{ installedBy = 'install-local.ps1'; installedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $stage 'app\finora-install.json'), $marker, (New-Object Text.UTF8Encoding $false))
# The uninstaller lives in the install folder (it never touches the data folder).
$uninst = Join-Path $PSScriptRoot 'uninstall-local.ps1'
if (Test-Path -LiteralPath $uninst) { Copy-Item -LiteralPath $uninst (Join-Path $stage 'uninstall.ps1') }

# Swap in the new version.
Remove-Item -LiteralPath (Join-Path $stage $stageMark) -Force
Assert-SafeToReplace $Destination
if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
Move-Item -LiteralPath $stage -Destination $Destination

# Protected ACL: current user + SYSTEM + Administrators only, no inherited entries.
# Set on the folder only: the (OI)(CI) entries are inherited by every file and subfolder. Do NOT add
# /T - it would also strip inheritance from each file, where (OI)(CI) grants do not apply, leaving
# every file with an empty ACL (unreadable, so node.exe / electron.exe cannot start).
$sid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
& "$sys\icacls.exe" $Destination /inheritance:r /grant:r "*${sid}:(OI)(CI)F" /grant:r '*S-1-5-18:(OI)(CI)F' /grant:r '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed: $LASTEXITCODE" }
# Fail loudly if a file did not end up readable.
try { [IO.File]::OpenRead((Join-Path $Destination 'app\server\index.js')).Close() } catch { throw "The installed files are not readable after setting permissions: $($_.Exception.Message)" }

# The Electron runtime is optional: the shortcut uses signed Node.js + an Edge app window
# (create-shortcut.ps1), because Smart App Control may refuse the unsigned electron.exe. Report only.
$exe = Join-Path $Destination 'runtime\electron.exe'
if (Test-Path -LiteralPath $exe) {
  try {
    $p = Start-Process -FilePath $exe -ArgumentList '--version' -NoNewWindow -Wait -PassThru -ErrorAction Stop
    Write-Output "Electron runtime: starts (exit $($p.ExitCode))"
  } catch {
    Write-Output 'Electron runtime: blocked by Smart App Control (not needed: the shortcut uses Node.js + Edge).'
  }
}

if (-not $NoShortcuts) {
  $sc = @{ InstallDir = $Destination }
  if ($ShortcutDir) { $sc.ShortcutDir = $ShortcutDir }
  & (Join-Path $PSScriptRoot 'create-shortcut.ps1') @sc
}

# Remove the pre-1.1 install (MoneyCash), its shortcuts and its "Start with Windows" entry: only for
# the real install location (a trial install elsewhere leaves them alone). Only a folder this script
# created (it holds app\moneycash-install.json) is deleted.
if ($Destination -eq $defaultDestination) {
  if (Test-Path -LiteralPath (Join-Path $legacy 'app\moneycash-install.json')) {
    Remove-Item -LiteralPath $legacy -Recurse -Force
    Write-Output "Removed the earlier install: $legacy"
  }
  $oldLinks = @((Join-Path ([Environment]::GetFolderPath('Programs')) 'MoneyCash.lnk'),
                (Join-Path ([Environment]::GetFolderPath('Desktop')) 'MoneyCash.lnk'))
  foreach ($l in $oldLinks) { if (Test-Path -LiteralPath $l) { Remove-Item -LiteralPath $l -Force } }
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  if (Get-ItemProperty -Path $runKey -Name 'MoneyCash' -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -Path $runKey -Name 'MoneyCash'
    Write-Output 'The old "Start with Windows" entry was removed. Turn it on again in Settings if you want it.'
  }
}
Write-Output "Installed to $Destination"
