# Creates a Airlock shortcut you can pin to the taskbar.
#
# Windows deliberately blocks programmatic taskbar pinning, so this gets you a proper
# shortcut with the right icon and command; the pin itself is one right-click.
#
#   Install:    powershell -ExecutionPolicy Bypass -File tools\install_shortcut.ps1
#   + desktop:  powershell -ExecutionPolicy Bypass -File tools\install_shortcut.ps1 -Desktop
#   Uninstall:  powershell -ExecutionPolicy Bypass -File tools\install_shortcut.ps1 -Remove

param([switch]$Desktop, [switch]$Remove)

$ErrorActionPreference = 'Stop'

$root    = Split-Path -Parent $PSScriptRoot
$vbs     = Join-Path $root 'airlock-launch.vbs'
$ico     = Join-Path $root 'public\icons\airlock.ico'
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Airlock.lnk'
$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Airlock.lnk'

if ($Remove) {
    foreach ($p in @($startMenu, $desktopLnk)) {
        if (Test-Path $p) { Remove-Item $p -Confirm:$false; Write-Output "Removed: $p" }
    }
    Write-Output 'If it was pinned, unpin it from the taskbar by hand — Windows owns that list.'
    return
}

if (-not (Test-Path $vbs)) { throw "Missing launcher: $vbs" }
if (-not (Test-Path $ico)) { throw "Missing icon: $ico  (run: python tools\make_icons.py)" }

$targets = @($startMenu)
if ($Desktop) { $targets += $desktopLnk }

$shell = New-Object -ComObject WScript.Shell

foreach ($path in $targets) {
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath       = "$env:WINDIR\System32\wscript.exe"
    $lnk.Arguments        = "`"$vbs`""
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation     = "$ico,0"
    $lnk.Description      = 'Airlock — local Muse Glimmer 30B chat and packet board'
    $lnk.WindowStyle      = 1
    $lnk.Save()
    Write-Output "Created: $path"
}

Write-Output ''
Write-Output 'To pin it: press Start, type "Airlock", right-click the result -> Pin to taskbar.'
Write-Output '(Windows blocks apps from pinning themselves, so that click has to be yours.)'
