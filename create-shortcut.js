import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const targetPath = resolve(projectRoot, 'start-chapterflow.bat');
const iconPath = resolve(projectRoot, 'build', 'icon.ico');
const psString = (value) => `'${value.replace(/'/g, "''")}'`;

const script = `
$Desktop = [Environment]::GetFolderPath('Desktop');
$WshShell = New-Object -ComObject WScript.Shell;
$Shortcut = $WshShell.CreateShortcut((Join-Path $Desktop 'ChapterFlow.lnk'));
$Shortcut.TargetPath = ${psString(targetPath)};
$Shortcut.WorkingDirectory = ${psString(projectRoot)};
$Shortcut.Description = 'Start the ChapterFlow development server';
$Shortcut.IconLocation = ${psString(`${iconPath},0`)};
$Shortcut.Save();
`;

execSync(`powershell -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`, {
  stdio: 'inherit',
});
console.log('Desktop shortcut created.');
