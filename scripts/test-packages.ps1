# End-to-end test of the two release packages made by scripts\package.ps1, entirely inside a lab
# folder: the user's real data folder and real install are never touched. Every Finora process this
# script starts gets LOCALAPPDATA pointed into the lab, so even a mistake could only reach lab data.
#
# Checks: package contents and SHA-256 lists, every tracked source file and production package
# present (and nothing else), signed Node.js, script syntax; install / update / refusals / corrupt
# package / uninstall through the same front end the user double-clicks (setup-ui.ps1 -Quiet);
# the installed copy refuses developer mode and AI-tool sandboxes; the exact packaged files serve
# the dashboard and the whole API on demo data; the unit tests pass on the packaged files with the
# packaged Node.js; the Start-menu shortcut and the portable launcher really start Finora (an Edge
# window opens briefly); the first start of a new version backs the data up; one Finora at a time.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\test-packages.ps1 -Out <package folder> -Lab <empty lab folder>
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Lab,
  [int]$Port = 4691
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$setup = Join-Path $Out "Finora-$version-setup"
$portable = Join-Path $Out "Finora-$version-portable"
$Lab = [IO.Path]::GetFullPath($Lab)
if (Test-Path -LiteralPath $Lab) { throw "$Lab already exists. Give an empty lab folder." }
New-Item -ItemType Directory $Lab | Out-Null
$labLocal = Join-Path $Lab 'LocalAppData'
$labData = Join-Path $labLocal 'Finora'
$dest = Join-Path $labLocal 'Programs\Finora'
$links = Join-Path $Lab 'Shortcuts'
New-Item -ItemType Directory $labLocal, $links | Out-Null

$script:pass = 0; $script:fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Output "PASS  $name" }
  else { $script:fail++; Write-Output "FAIL  $name $detail" }
}
function Hash([string]$p) { if (Test-Path -LiteralPath $p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash } else { 'missing' } }
$ui = Join-Path $setup 'files\scripts\setup-ui.ps1'
# Native programs: stderr is expected output here, not a script error (Windows PowerShell 5.1).
function Invoke-Native([string]$exe, [string[]]$a) {
  $ErrorActionPreference = 'Continue'
  $o = & $exe @a 2>&1 | ForEach-Object { "$_" } | Out-String
  return @{ code = $LASTEXITCODE; out = $o }
}
function Invoke-Ui([string[]]$a) { Invoke-Native 'powershell.exe' (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ui) + $a) }
# Child processes: lab LOCALAPPDATA, no AI-tool markers unless asked, a free port.
function Set-ChildEnv([switch]$KeepAgent) {
  $script:saved = @{ L = $env:LOCALAPPDATA; C = $env:CLAUDECODE; E = $env:CLAUDE_CODE_ENTRYPOINT; P = $env:PORT; D = $env:FINORA_DATA_DIR }
  $env:LOCALAPPDATA = $labLocal; $env:PORT = "$Port"; $env:FINORA_DATA_DIR = $null
  if (-not $KeepAgent) { $env:CLAUDECODE = $null; $env:CLAUDE_CODE_ENTRYPOINT = $null } else { $env:CLAUDECODE = '1' }
}
function Restore-Env {
  $env:LOCALAPPDATA = $saved.L; $env:CLAUDECODE = $saved.C; $env:CLAUDE_CODE_ENTRYPOINT = $saved.E; $env:PORT = $saved.P; $env:FINORA_DATA_DIR = $saved.D
}
function Get-LabProcs([string]$under) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='msedge.exe' OR Name='conhost.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine.IndexOf($under, [StringComparison]::OrdinalIgnoreCase) -ge 0) }
}
function Stop-Lab {
  foreach ($p in @(Get-LabProcs $Lab) + @(Get-LabProcs $Out)) { Invoke-Native 'taskkill.exe' @('/PID', "$($p.ProcessId)", '/T', '/F') | Out-Null }
  Start-Sleep -Milliseconds 800
}
function Wait-Port([int]$seconds) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) {
    try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $Port); $c.Close(); return $true } catch { Start-Sleep -Milliseconds 300 }
  }
  return $false
}
function Wait-Edge([string]$profileUnder, [int]$seconds) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) {
    if (Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($profileUnder, [StringComparison]::OrdinalIgnoreCase) -ge 0 }) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

try {
  # ---------------------------------------------------------------- 1. package contents
  Check 'setup package exists' (Test-Path -LiteralPath $setup)
  Check 'portable package exists' (Test-Path -LiteralPath $portable)
  Check 'setup: install and uninstall launchers' (@(Get-ChildItem -LiteralPath $setup -Filter '*.cmd').Count -eq 2)
  foreach ($pk in $setup, $portable) {
    $g = @(Get-ChildItem -LiteralPath $pk -Filter '*.html')
    $gt = if ($g.Count -eq 1) { [IO.File]::ReadAllText($g[0].FullName, [Text.Encoding]::UTF8) } else { '' }
    Check "$(Split-Path $pk -Leaf): user guide, version filled in" ($g.Count -eq 1 -and $gt.Contains("Finora</span> $version") -and -not $gt.Contains('{{') -and $gt.Contains('dir="rtl"'))
  }
  Check 'portable: launcher' (@(Get-ChildItem -LiteralPath $portable -Filter '*.cmd').Count -eq 1)
  foreach ($s in 'install-local.ps1', 'create-shortcut.ps1', 'uninstall-local.ps1', 'setup-ui.ps1') {
    $p = Join-Path $setup "files\scripts\$s"
    $errs = $null; [void][Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$errs)
    Check "setup: $s parses" ((Test-Path $p) -and -not $errs) "$errs"
  }
  $bom = [IO.File]::ReadAllBytes($ui)[0..2] -join ','
  Check 'setup-ui.ps1 has a UTF-8 BOM (Hebrew in PowerShell 5.1)' ($bom -eq '239,187,191')
  Check 'portable: developer mode locked (install marker)' (Test-Path (Join-Path $portable 'app\finora-install.json'))

  foreach ($pkg in @(@{ n = 'setup'; base = (Join-Path $setup 'files') }, @{ n = 'portable'; base = $portable })) {
    $mPath = Join-Path $pkg.base 'app\finora-payload.json'
    $m = Get-Content -LiteralPath $mPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Check "$($pkg.n): manifest is for $version" ($m.version -eq $version)
    $bad = @($m.files | Where-Object { -not (Test-Path -LiteralPath (Join-Path $pkg.base $_.path)) -or (Hash (Join-Path $pkg.base $_.path)) -ne $_.sha256 })
    Check "$($pkg.n): all $(@($m.files).Count) files match their SHA-256" ($bad.Count -eq 0) "first: $($bad[0].path)"
    $listed = @{}; foreach ($f in $m.files) { $listed[$f.path.ToLower()] = 1 }
    $prefix = $pkg.base.TrimEnd('\').Length + 1
    $extra = @(Get-ChildItem -LiteralPath (Join-Path $pkg.base 'app'), (Join-Path $pkg.base 'node') -Recurse -File -Force |
      Where-Object { $_.Name -ne 'finora-payload.json' -and -not $listed.ContainsKey($_.FullName.Substring($prefix).ToLower()) })
    Check "$($pkg.n): no unlisted files" ($extra.Count -eq 0) "first: $($extra[0].FullName)"
    $nodeExe = Join-Path $pkg.base 'node\node.exe'
    Check "$($pkg.n): Node.js is validly signed" ((Get-AuthenticodeSignature $nodeExe).Status -eq 'Valid')
    $nv = (& $nodeExe --version).Trim()
    Check "$($pkg.n): Node.js $nv is 26 or newer" ([int]$nv.TrimStart('v').Split('.')[0] -ge 26)

    # Every tracked source file (no tests, no .md) is there, byte for byte; nothing untracked is.
    $app = Join-Path $pkg.base 'app'
    Push-Location $root
    $tracked = @(git ls-files electron server web | Where-Object { $_ -notmatch '^server/test/' -and $_ -notmatch '\.md$' })
    $tracked += 'package.json', 'package-lock.json'
    Pop-Location
    $missing = @($tracked | Where-Object { $p = Join-Path $app $_; -not (Test-Path -LiteralPath $p) -or (Hash $p) -ne (Hash (Join-Path $root $_)) })
    Check "$($pkg.n): all $($tracked.Count) source files present and identical to the project" ($missing.Count -eq 0) "first: $($missing[0])"
    $set = @{}; foreach ($t in $tracked) { $set[$t.Replace('/', '\').ToLower()] = 1 }
    $aprefix = $app.TrimEnd('\').Length + 1
    $stray = @(Get-ChildItem -LiteralPath (Join-Path $app 'electron'), (Join-Path $app 'server'), (Join-Path $app 'web') -Recurse -File -Force |
      Where-Object { -not $set.ContainsKey($_.FullName.Substring($aprefix).ToLower()) })
    Check "$($pkg.n): no untracked or test files in the app" ($stray.Count -eq 0) "first: $($stray[0].FullName)"
    Push-Location $root
    $prod = @(npm ls --omit=dev --all --parseable 2>$null | Where-Object { $_ -and $_ -ne $root } | ForEach-Object { $_.Substring($root.Length).TrimStart('\') })
    Pop-Location
    $noPkg = @($prod | Where-Object { -not (Test-Path -LiteralPath (Join-Path $app "$_\package.json")) })
    Check "$($pkg.n): all $($prod.Count) production packages present" ($noPkg.Count -eq 0) "first: $($noPkg[0])"
    Check "$($pkg.n): no development packages (electron, electron-builder)" (-not (Test-Path (Join-Path $app 'node_modules\electron')) -and -not (Test-Path (Join-Path $app 'node_modules\electron-builder')))
  }

  # ---------------------------------------------------------------- 2. install through the front end
  $r = Invoke-Ui @('-Action', 'install', '-Quiet', '-Destination', $dest, '-ShortcutDir', $links)
  Check 'install: succeeds' ($r.code -eq 0) $r.out
  Check 'install: marker, uninstaller, Node.js, app' ((Test-Path "$dest\app\finora-install.json") -and (Test-Path "$dest\uninstall.ps1") -and (Test-Path "$dest\node\node.exe") -and (Test-Path "$dest\app\server\index.js"))
  Check 'install: no package manifest left in the install' (-not (Test-Path "$dest\app\finora-payload.json"))
  $m = Get-Content -LiteralPath (Join-Path $setup 'files\app\finora-payload.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $bad = @($m.files | Where-Object { (Hash (Join-Path $dest $_.path)) -ne $_.sha256 })
  Check 'install: every installed file matches the package' ($bad.Count -eq 0) "first: $($bad[0].path)"
  $acl = Get-Acl -LiteralPath $dest
  Check 'install: protected folder permissions (no inheritance)' ($acl.AreAccessRulesProtected)
  $lnkPath = Join-Path $links 'Finora.lnk'
  $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($lnkPath)
  Check 'install: shortcut runs the installed Node.js headless with --app-window' ((Test-Path $lnkPath) -and $lnk.TargetPath -like '*\conhost.exe' -and $lnk.Arguments.Contains("$dest\node\node.exe") -and $lnk.Arguments.Contains("$dest\app\server\index.js") -and $lnk.Arguments.Contains('--app-window')) "$($lnk.TargetPath) $($lnk.Arguments)"
  Check 'install: shortcut icon exists' (Test-Path ($lnk.IconLocation -replace ',\d+$', ''))
  Check 'install: data folder untouched by the installer' (-not (Test-Path $labData))

  $r = Invoke-Ui @('-Action', 'install', '-Quiet', '-Destination', $dest, '-ShortcutDir', $links)
  Check 'update over an existing install: succeeds' ($r.code -eq 0) $r.out

  $other = Join-Path $Lab 'NotFinora'; New-Item -ItemType Directory $other | Out-Null
  Set-Content -LiteralPath "$other\keep.txt" 'keep'
  $r = Invoke-Ui @('-Action', 'install', '-Quiet', '-Destination', $other, '-ShortcutDir', $links)
  Check 'refuses to replace a folder that is not a Finora install' ($r.code -ne 0 -and (Test-Path "$other\keep.txt"))
  $od = Join-Path $Lab 'OneDrive\Programs\Finora'
  $r = Invoke-Ui @('-Action', 'install', '-Quiet', '-Destination', $od, '-ShortcutDir', $links)
  Check 'refuses to install into OneDrive' ($r.code -ne 0 -and -not (Test-Path $od))

  $deep = Join-Path $Lab ('d' * 120 + '\Finora')
  $r = Invoke-Ui @('-Action', 'install', '-Quiet', '-Destination', $deep, '-ShortcutDir', $links)
  Check 'refuses a destination path too long for Windows (nothing copied)' ($r.code -ne 0 -and -not (Test-Path $deep)) $r.out

  $bent = Join-Path $Lab 'CorruptPackage'
  & robocopy.exe $setup $bent /E /NFL /NDL /NJH /NJS /NP | Out-Null
  Add-Content -LiteralPath (Join-Path $bent 'files\app\server\dates.js') '// changed'
  $cdest = Join-Path $Lab 'CorruptInstall'
  $r = Invoke-Native 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $bent 'files\scripts\setup-ui.ps1'), '-Action', 'install', '-Quiet', '-Destination', $cdest, '-ShortcutDir', $Lab)
  Check 'a damaged package stops the install and leaves nothing installed' ($r.code -ne 0 -and -not (Test-Path "$cdest\app")) $r.out

  # ---------------------------------------------------------------- 3. the installed copy refuses unsafe starts
  $node = "$dest\node\node.exe"
  Set-ChildEnv -KeepAgent
  $r = Invoke-Native $node @("$dest\app\server\index.js", '--app-window'); $o = $r.out; $code = $r.code
  Restore-Env
  Check 'installed: refuses to open real data from an AI coding tool' ($code -ne 0 -and $o -match 'Claude Code') $o
  Set-ChildEnv -KeepAgent
  $r = Invoke-Native $node @("$dest\app\server\index.js", '--dev', '--no-open'); $o = $r.out; $code = $r.code
  Restore-Env
  Check 'installed: developer mode is refused' ($code -ne 0 -and $o -match 'developer mode is available only from the source folder') $o
  Check 'installed: refusals created no data folder' (-not (Test-Path $labData))

  # ---------------------------------------------------------------- 4. the packaged files serve everything (demo data)
  $devApp = Join-Path $Lab 'DevCopy\app'
  & robocopy.exe "$dest\app" $devApp /E /NFL /NDL /NJH /NJS /NP | Out-Null
  Remove-Item "$devApp\finora-install.json"; New-Item -ItemType Directory "$devApp\.git" | Out-Null
  $devData = Join-Path $Lab 'DevData'
  Set-ChildEnv
  $env:FINORA_DATA_DIR = $devData
  $stdout = Join-Path $Lab 'dev-stdout.txt'; $stderr = Join-Path $Lab 'dev-stderr.txt'
  $proc = Start-Process -FilePath $node -ArgumentList "`"$devApp\server\index.js`"", '--dev', '--no-open' -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -WindowStyle Hidden
  Restore-Env
  $up = Wait-Port 60
  Check 'packaged server starts' $up (Get-Content $stderr -Raw -ErrorAction SilentlyContinue)
  if ($up) {
    Start-Sleep -Milliseconds 500
    $url = (Get-Content $stdout -Raw) -replace '(?s).*?(http://127\.0\.0\.1:\d+/auth#\S+).*', '$1'
    $token = $url.Split('#')[1]
    $base = "http://127.0.0.1:$Port"
    $ws = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $s = Invoke-RestMethod "$base/api/session" -Method Post -WebSession $ws -ContentType 'application/json' -Headers @{ 'X-Finora' = '1' } -Body (@{ token = $token } | ConvertTo-Json)
    Check 'sign-in with the one-time link' ([bool]$s.apiToken)
    $h = @{ 'X-Finora' = $s.apiToken }
    $null = Invoke-RestMethod "$base/api/demo" -Method Post -WebSession $ws -ContentType 'application/json' -Headers $h -Body '{"enabled":true}'
    $st = Invoke-RestMethod "$base/api/status" -WebSession $ws -Headers $h
    Check "API status: version $($st.version), demo mode" ($st.version -eq $version -or -not $st.version) ($st | ConvertTo-Json -Compress -Depth 2)
    foreach ($ep in 'companies', 'connections', 'accounts', 'categories', 'transactions', 'summary', 'position', 'insights', 'annual', 'annual/insights', 'price-trends', 'recurring', 'business', 'sync/status', 'sheets') {
      try { $resp = Invoke-WebRequest "$base/api/$ep" -WebSession $ws -Headers $h -UseBasicParsing; $ok = $resp.StatusCode -eq 200 -and $resp.Content.Length -gt 1 } catch { $ok = $false; $err = $_.Exception.Message }
      Check "API /$ep answers" $ok $err
    }
    $tx = Invoke-RestMethod "$base/api/transactions" -WebSession $ws -Headers $h
    $n = if ($tx.items) { @($tx.items).Count } elseif ($tx.rows) { @($tx.rows).Count } else { @($tx).Count }
    Check "demo data loaded ($n transactions on the first page)" ($n -gt 0)
    $denied = try { Invoke-WebRequest "$base/api/status" -UseBasicParsing | Out-Null; $false } catch { $_.Exception.Response.StatusCode.value__ -eq 401 }
    Check 'API refuses a request without the session' $denied
    $page = Invoke-WebRequest "$base/" -UseBasicParsing
    Check 'dashboard page loads' ($page.StatusCode -eq 200 -and $page.Content -match '<html')
    $assets = [regex]::Matches($page.Content, '(?:src|href)="(/?[^":#?]+\.(?:js|css|svg|png|ico|woff2?))"') | ForEach-Object { '/' + $_.Groups[1].Value.TrimStart('/') } | Sort-Object -Unique
    $badAssets = @($assets | Where-Object { try { (Invoke-WebRequest "$base$_" -UseBasicParsing).StatusCode -ne 200 } catch { $true } })
    Check "all $(@($assets).Count) page assets load" ($badAssets.Count -eq 0) "first: $($badAssets[0])"
  }
  Invoke-Native 'taskkill.exe' @('/PID', "$($proc.Id)", '/T', '/F') | Out-Null
  Start-Sleep -Milliseconds 800

  # ---------------------------------------------------------------- 5. unit tests on the packaged files
  & robocopy.exe (Join-Path $root 'server\test') "$devApp\server\test" /E /NFL /NDL /NJH /NJS /NP | Out-Null
  Push-Location $devApp
  Set-ChildEnv
  $r = Invoke-Native $node @('--test', 'server/test/*.test.js'); $t = $r.out; $code = $r.code
  Restore-Env
  Pop-Location
  $sum = ([regex]::Match($t, 'ℹ pass (\d+)')).Groups[1].Value
  if (-not $sum) { $sum = ([regex]::Match($t, '# pass (\d+)')).Groups[1].Value }
  Check "unit tests pass on the packaged files with the packaged Node.js ($sum passed)" ($code -eq 0) ($t.Substring([Math]::Max(0, $t.Length - 1500)))

  # ---------------------------------------------------------------- 6. real starts: shortcut, then portable
  Set-ChildEnv
  Start-Process -FilePath $lnkPath
  Restore-Env
  $up = Wait-Port 60
  $edge = Wait-Edge (Join-Path $labData 'edge-window') 30
  Check 'Start-menu shortcut starts Finora (server up)' $up
  Check 'Start-menu shortcut opens the Edge app window' $edge
  Start-Sleep -Seconds 3
  $v = try { (Get-Content (Join-Path $labData 'version.json') -Raw | ConvertFrom-Json).version } catch { '' }
  Check "first start records version $version" ($v -eq $version)
  Check 'first start created the data key' (Test-Path (Join-Path $labData 'keys\dek.json'))

  $r = Invoke-Ui @('-Action', 'install', '-Quiet', '-Destination', $dest, '-ShortcutDir', $links)
  Check 'update is refused while Finora runs from the install (nothing replaced)' ($r.code -ne 0 -and $r.out -match 'Finora is running' -and (Test-Path "$dest\app\server\index.js")) $r.out

  # One Finora at a time: the portable launch hands over to the running one and exits.
  $launcher = (Get-ChildItem -LiteralPath $portable -Filter '*.cmd' | Select-Object -First 1).FullName
  Set-ChildEnv
  Start-Process -FilePath $launcher -WindowStyle Hidden
  Restore-Env
  Start-Sleep -Seconds 8
  $pn = @(Get-LabProcs $portable | Where-Object { $_.Name -eq 'node.exe' })
  $inst = @(Get-LabProcs $dest | Where-Object { $_.Name -eq 'node.exe' })
  $handed = (Get-Content (Join-Path $labData 'logs\finora.log') -Raw -ErrorAction SilentlyContinue) -match 'another Finora is running: it opens the window'
  Check 'second launch (portable) hands over and exits; the first keeps running' ($handed -and $pn.Count -eq 0 -and $inst.Count -ge 1)
  Stop-Lab

  # Upgrade: data from an earlier version is backed up on the first start of this one.
  Set-Content -LiteralPath (Join-Path $labData 'version.json') '{"version":"1.1.1"}'
  Set-ChildEnv
  Start-Process -FilePath $launcher -WindowStyle Hidden
  Restore-Env
  $up = Wait-Port 60
  $edge = Wait-Edge (Join-Path $labData 'edge-window') 30
  Check 'portable launcher starts Finora (server up)' $up
  Check 'portable launcher opens the Edge app window' $edge
  Check 'portable runs its own Node.js' (@(Get-LabProcs $portable | Where-Object { $_.Name -eq 'node.exe' -and $_.ExecutablePath -like "$portable\node\node.exe" }).Count -ge 1)
  Start-Sleep -Seconds 3
  $b = @(Get-ChildItem -LiteralPath (Join-Path $labData 'backups') -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*-1.1.1-to-$version" })
  Check 'upgrade from 1.1.1: connections backed up before anything else' ($b.Count -eq 1 -and (Test-Path (Join-Path $b[0].FullName 'keys\dek.json')))
  $v = try { (Get-Content (Join-Path $labData 'version.json') -Raw | ConvertFrom-Json).version } catch { '' }
  Check "version mark moved to $version" ($v -eq $version)
  Stop-Lab
  $logs = Get-ChildItem -LiteralPath (Join-Path $labData 'logs') -File -ErrorAction SilentlyContinue | Get-Content -ErrorAction SilentlyContinue | Where-Object { $_ -match '\b(ERROR|error|fatal|FATAL)\b' -and $_ -notmatch 'did not answer|taskkill' }
  Check 'no errors in the Finora logs' (@($logs).Count -eq 0) (@($logs) -join ' | ')

  # ---------------------------------------------------------------- 7. uninstall
  $r = Invoke-Ui @('-Action', 'uninstall', '-Quiet', '-Destination', $dest, '-ShortcutDir', $links)
  Check 'uninstall: succeeds' ($r.code -eq 0) $r.out
  Check 'uninstall: install folder and shortcut removed' (-not (Test-Path $dest) -and -not (Test-Path $lnkPath))
  Check 'uninstall: data folder kept (key, version, backups)' ((Test-Path (Join-Path $labData 'keys\dek.json')) -and (Test-Path (Join-Path $labData 'backups')))
  $r = Invoke-Ui @('-Action', 'uninstall', '-Quiet', '-Destination', $dest, '-ShortcutDir', $links)
  Check 'uninstall when nothing is installed: clear refusal' ($r.code -ne 0)
} finally {
  Stop-Lab
}
Write-Output ''
Write-Output "Result: $script:pass passed, $script:fail failed"
if ($script:fail) { exit 1 }
