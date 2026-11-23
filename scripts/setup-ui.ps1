# The double-click front end of a release package (scripts\package.ps1): runs install-local.ps1 or
# the installed uninstall.ps1 and reports the result in a Hebrew message box. UTF-8 with BOM
# (Windows PowerShell 5.1 reads a BOM-less file as ANSI and would garble the Hebrew).
# -Quiet: no message boxes (automated tests); the result goes to the output and the exit code.
param(
  [ValidateSet('install', 'uninstall')][string]$Action = 'install',
  [switch]$Quiet,
  # Trial runs only: install somewhere else, with the shortcut in a folder of your choice.
  [string]$Destination = '',
  [string]$ShortcutDir = ''
)
$trial = @{}
if ($Destination) { $trial.Destination = $Destination }
if ($ShortcutDir) { $trial.ShortcutDir = $ShortcutDir }
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

function Show-Message([string]$text, [string]$icon = 'Information', [string]$buttons = 'OK') {
  if ($Quiet) { Write-Host $text; return 'Yes' }
  $rtl = [System.Windows.Forms.MessageBoxOptions]::RtlReading -bor [System.Windows.Forms.MessageBoxOptions]::RightAlign
  return [string][System.Windows.Forms.MessageBox]::Show($text, 'Finora', $buttons, $icon, 'Button1', $rtl)
}

$dataDir = Join-Path $env:LOCALAPPDATA 'Finora'
try {
  if ($Action -eq 'install') {
    & (Join-Path $PSScriptRoot 'install-local.ps1') @trial
    Show-Message ("Finora הותקנה בהצלחה.`n`n" +
      "פותחים אותה מתפריט התחל: Finora.`n" +
      "החיבורים לבנקים ולכרטיסים והנתונים שלך לא השתנו (הם שמורים ב-$dataDir).") | Out-Null
  } else {
    $dir = if ($Destination) { $Destination } else { Join-Path $env:LOCALAPPDATA 'Programs\Finora' }
    $u = Join-Path $dir 'uninstall.ps1'
    if (-not (Test-Path -LiteralPath $u)) { throw 'Finora לא מותקנת במחשב הזה (לא נמצא קובץ הסרה).' }
    $ok = Show-Message ("להסיר את Finora מהמחשב?`n`n" +
      "יימחקו התוכנה וקיצורי הדרך שלה.`n" +
      "הנתונים והחיבורים לבנקים יישארו ב-$dataDir, כך שהתקנה מחדש תמשיך מאותו מקום.") 'Question' 'YesNo'
    if ($ok -ne 'Yes') { exit 0 }
    $u2 = @{}
    if ($ShortcutDir) { $u2.ShortcutDir = $ShortcutDir }
    & $u @u2
    Show-Message "Finora הוסרה. הנתונים שלך נשארו ב-$dataDir." | Out-Null
  }
} catch {
  $what = if ($Action -eq 'install') { 'ההתקנה לא הושלמה. הנתונים והחיבורים שלך לא נפגעו.' } else { 'ההסרה לא הושלמה.' }
  Show-Message ("$what`n`n$($_.Exception.Message)") 'Error' | Out-Null
  exit 1
}
