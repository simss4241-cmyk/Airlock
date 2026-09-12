# Registers the Airlock server to start (hidden) at login, so the pinned taskbar
# icon always has something to connect to.
#
#   Install:    powershell -ExecutionPolicy Bypass -File tools\install_autostart.ps1
#   Uninstall:  powershell -ExecutionPolicy Bypass -File tools\install_autostart.ps1 -Remove

param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$root     = Split-Path -Parent $PSScriptRoot
$startup  = [Environment]::GetFolderPath('Startup')
$linkPath = Join-Path $startup 'Airlock Server.lnk'

if ($Remove) {
    if (Test-Path $linkPath) {
        Remove-Item $linkPath -Confirm:$false
        Write-Output "Removed: $linkPath"
    } else {
        Write-Output "Nothing to remove; no shortcut at $linkPath"
    }
    return
}

$vbs = Join-Path $root 'airlock-server-hidden.vbs'
$ico = Join-Path $root 'public\icons\airlock.ico'

if (-not (Test-Path $vbs)) { throw "Missing launcher: $vbs" }

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($linkPath)
$lnk.TargetPath       = "$env:WINDIR\System32\wscript.exe"
$lnk.Arguments        = "`"$vbs`""
$lnk.WorkingDirectory = $root
$lnk.Description      = 'Airlock local model server (port 8100)'
if (Test-Path $ico) { $lnk.IconLocation = $ico }
$lnk.Save()

Write-Output "Installed: $linkPath"
Write-Output "  -> wscript.exe `"$vbs`""
Write-Output "The server will start hidden at each login. Verify now with: .\airlock-server-hidden.vbs"
