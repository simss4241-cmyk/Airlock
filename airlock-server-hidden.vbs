' Starts the Airlock server with no console window.
' Resolves its own folder, so it survives being moved (same rule as the .bat launchers).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "node server.js", 0, False
