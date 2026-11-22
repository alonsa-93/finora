# (Re)creates the "Finora" shortcuts on the Desktop and in the Start menu, pointing at the LOCAL
# install made by install-local.ps1 (%LOCALAPPDATA%\Programs\Finora). Never at the OneDrive project.
#
# The shortcut runs the server with the installed, Authenticode-signed Node.js and shows the dashboard
# in a Microsoft Edge app window (server/index.js --app-window). Smart App Control judges the
# unsigned electron.exe by reputation and can stop allowing it at any time; node.exe and msedge.exe
# are signed, so they keep starting. conhost --headless hides the console.
# A Desktop folder synced by OneDrive gets no shortcut (the Start-menu one is always created).
param([string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Finora'))
$ErrorActionPreference = 'Stop'
$app = Join-Path $InstallDir 'app'
$entry = Join-Path $app 'server\index.js'
$icon = Join-Path $app 'electron\assets\icon.ico'
if (-not (Test-Path $entry)) { throw "Finora is not installed in $InstallDir. Run scripts\install-local.ps1 first." }
if ($InstallDir -match '\\OneDrive( - [^\\]+)?\\') { throw 'Refusing to point shortcuts into OneDrive.' }

# The machine-wide Node.js (signed, under Program Files) only: never a per-user or project copy.
$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path $node)) { throw 'Node.js is not installed in Program Files. Install it from nodejs.org first.' }
if ((Get-AuthenticodeSignature $node).Status -ne 'Valid') { throw "$node is not validly signed." }
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'

# Same test as install-local.ps1.
function Test-UnderOneDrive([string]$p) {
  $full = [IO.Path]::GetFullPath($p).TrimEnd('\') + '\'
  foreach ($k in 'OneDrive', 'OneDriveConsumer', 'OneDriveCommercial') {
    $r = [Environment]::GetEnvironmentVariable($k)
    if ($r -and $full.StartsWith(([IO.Path]::GetFullPath($r).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $full -match '\\OneDrive( - [^\\]+)?\\'
}

$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$targets = @((Join-Path ([Environment]::GetFolderPath('Programs')) 'Finora.lnk'))
if (Test-UnderOneDrive $desktop) {
  Write-Output "Skipped the Desktop shortcut: $desktop is synced by OneDrive. Use the Start-menu shortcut."
} else {
  $targets += (Join-Path $desktop 'Finora.lnk')
}
foreach ($path in $targets) {
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $conhost
  $lnk.Arguments = "--headless `"$node`" `"$entry`" --app-window"
  $lnk.WorkingDirectory = $app
  $lnk.IconLocation = "$icon,0"
  $lnk.WindowStyle = 7   # minimized: nothing flashes even if conhost shows a frame
  $lnk.Description = 'Finora - All your money. One clear picture.'
  $lnk.Save()
  Write-Output "Created $path"
}
