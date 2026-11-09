# stop the SAMDEENIYOM bowl server and remove it from startup (orders are kept)
$AppDir = Join-Path $env:LOCALAPPDATA 'samdeeniyom-bowl'; $Startup = [Environment]::GetFolderPath('Startup')
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*samdeeniyom-bowl*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
Remove-Item (Join-Path $Startup 'samdeeniyom-bowl.lnk'), (Join-Path $Startup 'samdeeniyom-tunnel.lnk') -ErrorAction SilentlyContinue
Write-Host "[samdeeniyom] stopped. Program files: $AppDir (delete the folder to remove completely). Orders are kept."
