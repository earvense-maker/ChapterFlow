Set WshShell = WScript.CreateObject("WScript.Shell")
Set FileSystem = WScript.CreateObject("Scripting.FileSystemObject")
ScriptDir = FileSystem.GetParentFolderName(WScript.ScriptFullName)
Set Shortcut = WshShell.CreateShortcut(FileSystem.BuildPath(WshShell.SpecialFolders("Desktop"), "Yumeweaving.lnk"))
Shortcut.TargetPath = FileSystem.BuildPath(ScriptDir, "start-yumeweaving.bat")
Shortcut.WorkingDirectory = ScriptDir
Shortcut.Description = "Launch Yumeweaving dev server"
Shortcut.Save
