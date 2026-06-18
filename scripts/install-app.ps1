# Installs the freshly-built standalone Droolcat Agent exe to a stable location
# and (re)creates the desktop shortcut. Run after `tauri build --debug --no-bundle`
# (or use `npm run shortcut`, which does the build first).
$ErrorActionPreference = "Stop"
$root   = Split-Path -Parent $PSScriptRoot
$exeSrc = Join-Path $root "src-tauri\target\debug\droolcat-agent.exe"
if (-not (Test-Path $exeSrc)) { throw "exe not found at $exeSrc - run `npm run app:build` or `tauri build --debug --no-bundle` first" }

$appDir = Join-Path $env:LOCALAPPDATA "Droolcat Agent"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
$exeDst = Join-Path $appDir "Droolcat Agent.exe"
Copy-Item $exeSrc $exeDst -Force

$icoSrc = Join-Path $root "src-tauri\icons\icon.ico"
$icoDst = Join-Path $appDir "droolcat.ico"
if (Test-Path $icoSrc) { Copy-Item $icoSrc $icoDst -Force }

$desktop = [Environment]::GetFolderPath("Desktop")
$lnk = Join-Path $desktop "Droolcat Agent.lnk"
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = $exeDst
$sc.WorkingDirectory = $appDir
$sc.IconLocation = if (Test-Path $icoDst) { $icoDst } else { "$exeDst,0" }
$sc.Description = "Droolcat Agent - Claude Code as a live graph"
$sc.Save()

Write-Output "Installed: $exeDst"
Write-Output "Shortcut:  $lnk"
