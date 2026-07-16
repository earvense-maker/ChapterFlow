Set WshShell = WScript.CreateObject("WScript.Shell")
Set FileSystem = WScript.CreateObject("Scripting.FileSystemObject")
ScriptDir = FileSystem.GetParentFolderName(WScript.ScriptFullName)
Set Shortcut = WshShell.CreateShortcut(FileSystem.BuildPath(WshShell.SpecialFolders("Desktop"), "ChapterFlow.lnk"))
Shortcut.TargetPath = FileSystem.BuildPath(ScriptDir, "start-chapterflow.bat")
Shortcut.WorkingDirectory = ScriptDir
Shortcut.Description = "Launch ChapterFlow dev server"
Shortcut.IconLocation = FileSystem.BuildPath(FileSystem.BuildPath(ScriptDir, "build"), "icon.ico") & ",0"
Shortcut.Save
