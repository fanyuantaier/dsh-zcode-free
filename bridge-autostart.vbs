' zcode-free bridge (:11451) hidden autostart launcher.
' Invoked by HKCU Run entry "ZCodeFreeBridge".
' Real work happens in bridge-autostart.cmd; node output goes to bridge-autostart.log.
' NOTE: keep this file ASCII-only - ANSI codepage (GBK) parses VBS on this box.
Set sh = CreateObject("WScript.Shell")
sh.Run "D:\workplace\dsh-zcode-free\bridge-autostart.cmd", 0, False
