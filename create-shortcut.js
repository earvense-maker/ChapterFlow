import { execSync } from 'node:child_process';

const script = `
$WshShell = New-Object -ComObject WScript.Shell;
$Shortcut = $WshShell.CreateShortcut('C:\\Users\\Yuhei\\Desktop\\Yumeweaving.lnk');
$Shortcut.TargetPath = 'C:\\Users\\Yuhei\\Desktop\\Yumeweaving\\start-yumeweaving.bat';
$Shortcut.WorkingDirectory = 'C:\\Users\\Yuhei\\Desktop\\Yumeweaving';
$Shortcut.Description = 'Start the Yumeweaving development server';
$Shortcut.Save();
`;

execSync(`powershell -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`, {
  stdio: 'inherit',
});
console.log('Desktop shortcut created.');
