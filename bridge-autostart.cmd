@echo off
rem zcode-free bridge hidden starter (invoked by bridge-autostart.vbs)
cd /d D:\workplace\dsh-zcode-free
"C:\Program Files\nodejs\node.exe" "D:\workplace\dsh-zcode-free\bin\zcode-free-serve.mjs" --port 11451 > D:\workplace\dsh-zcode-free\bridge-autostart.log 2>&1
