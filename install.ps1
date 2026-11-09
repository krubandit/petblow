# SAMDEENIYOM bowl server installer for Windows — no admin rights needed.
#   install.cmd            install / update and start (http://127.0.0.1:8787)
#   install.cmd -Tunnel    also open a free public link (Cloudflare quick tunnel)
param([switch]$Tunnel)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Say($m) { Write-Host "[samdeeniyom] $m" -ForegroundColor Magenta }
function WriteUtf8($path, $text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }

$Src    = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Join-Path $env:LOCALAPPDATA 'samdeeniyom-bowl'
$Startup = [Environment]::GetFolderPath('Startup')

# 0) stop a running copy
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*samdeeniyom-bowl*run-server.cmd*' -or $_.CommandLine -like '*samdeeniyom-bowl*server.mjs*' -or $_.CommandLine -like '*samdeeniyom-bowl*run-tunnel.cmd*' -or $_.CommandLine -like '*samdeeniyom-bowl*cloudflared*') } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }

# 1) copy files (keeps an existing .env and downloaded tools)
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
if ((Resolve-Path $Src).Path -ne (Resolve-Path $AppDir).Path) {
  Get-ChildItem -LiteralPath $Src -Force | Where-Object { $_.Name -notin @('.env', 'node', 'bin') } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $AppDir -Recurse -Force }
}
Set-Location $AppDir

# 2) Node.js >= 18 (system node if new enough, else a private copy in $AppDir\node)
$Node = $null
$sys = Get-Command node -ErrorAction SilentlyContinue
if ($sys) { $major = [int]((& $sys.Source -p "process.versions.node.split('.')[0]") | Out-String).Trim(); if ($major -ge 18) { $Node = $sys.Source } }
if (-not $Node -and (Test-Path "$AppDir\node\node.exe")) { $Node = "$AppDir\node\node.exe" }
if (-not $Node) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $v = 'v20.18.1'; $zip = Join-Path $env:TEMP "node-$v-win-$arch.zip"
  Say "downloading Node.js $v ($arch)..."
  Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$v/node-$v-win-$arch.zip" -OutFile $zip
  $tmp = Join-Path $env:TEMP 'samdeeniyom-node'; if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  if (Test-Path "$AppDir\node") { Remove-Item "$AppDir\node" -Recurse -Force }
  Move-Item -Path (Join-Path $tmp "node-$v-win-$arch") -Destination "$AppDir\node"
  Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
  $Node = "$AppDir\node\node.exe"
}
Say ("node: $Node (" + ((& $Node -v) | Out-String).Trim() + ")")

# 3) settings
$envFile = Join-Path $AppDir '.env'
if (-not (Test-Path $envFile)) {
  $pass = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 14 | ForEach-Object { [char]$_ })
  $orders = Join-Path $env:USERPROFILE 'samdeeniyom-orders'
  $t = (Get-Content -Raw -Encoding UTF8 "$AppDir\.env.example") -replace '(?m)^ADMIN_PASS=.*$', "ADMIN_PASS=$pass" -replace '(?m)^ORDERS_DIR=.*$', "ORDERS_DIR=$orders"
  WriteUtf8 $envFile $t
  Say 'created .env (admin password generated)'
}
$cfg = @{}; Get-Content -Encoding UTF8 $envFile | ForEach-Object { if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim() } }
$Port = if ($cfg['PORT']) { $cfg['PORT'] } else { '8787' }

if ($Tunnel) {   # behind the quick tunnel the visitor's address arrives in CF-Connecting-IP; without this every visitor would look like 127.0.0.1
  $t = Get-Content -Raw -Encoding UTF8 $envFile
  foreach ($kv in @('TRUST_PROXY=1', 'IP_HEADER=cf-connecting-ip')) { $k = $kv.Split('=')[0]; if ($t -match "(?m)^$k=") { $t = $t -replace "(?m)^$k=.*$", $kv } else { $t = $t.TrimEnd() + "`r`n$kv`r`n" } }
  WriteUtf8 $envFile $t
}

# 4) self-test
Say 'self-test...'
& $Node "$AppDir\selftest.mjs"
if ($LASTEXITCODE -ne 0) { throw 'self-test failed' }

# 5) background runner (auto-restart) + start at logon via the Startup folder
# launchers use paths relative to their own folder, so Thai/Unicode user names are safe
$NodeRef = if ($Node -like "$AppDir*") { '"%~dp0' + $Node.Substring($AppDir.Length + 1) + '"' } else { "`"$Node`"" }
WriteUtf8 "$AppDir\run-server.cmd" "@echo off`r`ncd /d `"%~dp0`"`r`n:loop`r`n$NodeRef server.mjs >> server.log 2>&1`r`ntimeout /t 3 /nobreak >nul`r`ngoto loop`r`n"
$vbs = "Set fso = CreateObject(`"Scripting.FileSystemObject`")`r`nd = fso.GetParentFolderName(WScript.ScriptFullName)`r`nCreateObject(`"WScript.Shell`").Run `"cmd /c `"`"`" & d & `"\{0}`"`"`", 0, False`r`n"
WriteUtf8 "$AppDir\start-samdeeniyom.vbs" ($vbs -f 'run-server.cmd')
function StartupLink($name, $vbsPath) { $sh = New-Object -ComObject WScript.Shell; $l = $sh.CreateShortcut((Join-Path $Startup $name)); $l.TargetPath = 'wscript.exe'; $l.Arguments = "`"$vbsPath`""; $l.WorkingDirectory = $AppDir; $l.Save() }
StartupLink 'samdeeniyom-bowl.lnk' "$AppDir\start-samdeeniyom.vbs"
Start-Process wscript.exe -ArgumentList "`"$AppDir\start-samdeeniyom.vbs`""
Say 'server started (and will start automatically when you log in)'

# 6) optional public link
$Url = $null
if ($Tunnel) {
  New-Item -ItemType Directory -Force -Path "$AppDir\bin" | Out-Null
  $cf = "$AppDir\bin\cloudflared.exe"
  if (-not (Test-Path $cf)) {
    $carch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
    Say 'downloading cloudflared...'
    Invoke-WebRequest -UseBasicParsing "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$carch.exe" -OutFile $cf
  }
  Set-Content -Path "$AppDir\tunnel.log" -Value '' -Encoding ASCII
  WriteUtf8 "$AppDir\run-tunnel.cmd" "@echo off`r`ncd /d `"%~dp0`"`r`n:loop`r`n`"%~dp0bin\cloudflared.exe`" tunnel --no-autoupdate --url http://127.0.0.1:$Port --logfile tunnel.log`r`ntimeout /t 5 /nobreak >nul`r`ngoto loop`r`n"
  WriteUtf8 "$AppDir\start-tunnel.vbs" ($vbs -f 'run-tunnel.cmd')
  StartupLink 'samdeeniyom-tunnel.lnk' "$AppDir\start-tunnel.vbs"
  Start-Process wscript.exe -ArgumentList "`"$AppDir\start-tunnel.vbs`""
  for ($i = 0; $i -lt 40 -and -not $Url; $i++) { Start-Sleep 1; $m = Select-String -Path "$AppDir\tunnel.log" -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($m) { $Url = $m.Matches[0].Value } }
}

# 7) summary
Start-Sleep 3
$base = "http://127.0.0.1:$Port"
try { Invoke-RestMethod "$base/api/health" -TimeoutSec 5 | Out-Null; Say "server OK -> $base" } catch { Say "server not answering yet - see $AppDir\server.log" }
$pub = if ($Url) { $Url } else { $base }
WriteUtf8 "$AppDir\LINKS.txt" "Shop page (customers): $pub/`r`nAdmin: $pub/admin   user: admin   pass: $($cfg['ADMIN_PASS'])`r`nOrders folder: $($cfg['ORDERS_DIR'])`r`n"
Say "Shop page (customers): $pub/"
Say "Admin:                 $pub/admin   user: admin   pass: $($cfg['ADMIN_PASS'])"
Say "Orders folder:         $($cfg['ORDERS_DIR'])"
Say "(saved in $AppDir\LINKS.txt)"
Start-Process "$base/admin"
