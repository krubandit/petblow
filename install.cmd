@echo off
rem double-click to install the SAMDEENIYOM bowl server (add -Tunnel for a public link)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause
