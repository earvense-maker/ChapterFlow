Set WshShell = WScript.CreateObject("WScript.Shell")
Set Shortcut = WshShell.CreateShortcut("C:\Users\Yuhei\Desktop\Yumeweaving.lnk")
Shortcut.TargetPath = "C:\Users\Yuhei\Desktop\Yumeweaving\start-yumeweaving.bat"
Shortcut.WorkingDirectory = "C:\Users\Yuhei\Desktop\Yumeweaving"
Shortcut.Description = "Launch Yumeweaving dev server"
Shortcut.Save
