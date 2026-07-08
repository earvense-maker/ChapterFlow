import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(projectRoot, 'release');
const packageJsonPath = path.join(projectRoot, 'package.json');
const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
const version = sanitizeVersion(packageJson.version ?? '0.0.0');
const packageName = `yumeweaving-v${version}`;
const stageDir = path.join(releaseDir, packageName);
const zipPath = path.join(releaseDir, `${packageName}.zip`);
const userGuidePath = 'docs\\UserGuide.md';

await fs.rm(path.join(projectRoot, 'dist'), { recursive: true, force: true });
runNpmScript('build');

await fs.mkdir(releaseDir, { recursive: true });
await fs.rm(stageDir, { recursive: true, force: true });
await fs.rm(zipPath, { force: true });
await fs.mkdir(stageDir, { recursive: true });

await copyRequired('dist', 'dist');
await copyRequired('presets', 'presets');
await copyRequired('LICENSE', 'LICENSE');
await copyRequired('package.json', 'package.json');
await copyRequired('package-lock.json', 'package-lock.json');
await copyRequired('open-app-window.js', 'open-app-window.js');
await copyRequired(path.join('scripts', 'start-lan.mjs'), path.join('scripts', 'start-lan.mjs'));
await copyRequired(path.join('docs', '利用ガイド.md'), path.join('docs', 'UserGuide.md'));

await writeText(
  path.join(stageDir, 'Start-Yumeweaving.bat'),
  createStartBat({
    introLines: [],
    launchLines: [
      'start "" /b node open-app-window.js http://localhost:3001',
      'node dist\\server\\index.js',
    ],
    failTitle: 'Yumeweaving startup failed',
  })
);
await writeText(
  path.join(stageDir, 'Start-Yumeweaving-LAN.bat'),
  createStartBat({
    introLines: [
      'echo [Yumeweaving LAN] スマホ用のトークン付きURLが起動ログに表示されます。',
      'echo [Yumeweaving LAN] Windows ファイアウォールはプライベートネットワークだけ許可してください。',
    ],
    launchLines: ['node scripts\\start-lan.mjs'],
    failTitle: 'Yumeweaving LAN startup failed',
  })
);

run('tar.exe', ['-a', '-cf', zipPath, packageName], { cwd: releaseDir });
verifyZipEntryNamesAreAscii(zipPath);

console.log(`[package] Created ${zipPath}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}\n${result.stderr ?? ''}`
    );
  }
  return result.stdout ?? '';
}

function runNpmScript(scriptName) {
  if (process.platform === 'win32') {
    run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm run ${scriptName}`]);
    return;
  }
  run('npm', ['run', scriptName]);
}

async function copyRequired(from, to) {
  const source = path.join(projectRoot, from);
  const destination = path.join(stageDir, to);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true });
}

async function writeText(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text.replace(/\n/g, '\r\n'), 'utf-8');
}

function sanitizeVersion(value) {
  return String(value).replace(/[^a-zA-Z0-9.-]/g, '-');
}

function createStartBat({ introLines, launchLines, failTitle }) {
  return `@echo off
chcp 65001 > nul
cd /d "%~dp0"
set "YUMEWEAVING_DATA_DIR=%USERPROFILE%\\Documents\\Yumeweaving"

call :check_node
if errorlevel 1 exit /b 1
call :install_deps
if errorlevel 1 goto fail

${introLines.join('\n')}
${launchLines.join('\n')}
if errorlevel 1 goto fail
goto :eof

:check_node
where node > nul 2> nul
if errorlevel 1 (
  echo [Yumeweaving] Node.js 20+ をインストールしてください。
  echo ${userGuidePath} の「必要なもの」を確認してください。
  pause
  exit /b 1
)
for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%v"
if "%NODE_MAJOR%"=="" goto node_version_fail
if %NODE_MAJOR% LSS 20 goto node_version_fail
exit /b 0

:node_version_fail
echo [Yumeweaving] Node.js 20+ が必要です。現在のバージョン:
node -v
pause
exit /b 1

:install_deps
for /f "usebackq delims=" %%h in (\`node -e "const fs=require('fs');const crypto=require('crypto');const h=crypto.createHash('sha256');for (const f of ['package.json','package-lock.json']) h.update(fs.readFileSync(f));process.stdout.write(h.digest('hex'))"\`) do set "YUMEWEAVING_DEPS_HASH=%%h"
set "YUMEWEAVING_INSTALL_STAMP=node_modules\\.yumeweaving-install-ok"
set "YUMEWEAVING_INSTALL_OK="
if exist "%YUMEWEAVING_INSTALL_STAMP%" (
  set /p YUMEWEAVING_INSTALLED_HASH=<"%YUMEWEAVING_INSTALL_STAMP%"
  if "%YUMEWEAVING_INSTALLED_HASH%"=="%YUMEWEAVING_DEPS_HASH%" set "YUMEWEAVING_INSTALL_OK=1"
)
if not defined YUMEWEAVING_INSTALL_OK (
  echo [Yumeweaving] 初回起動または前回の中断から復旧するため、依存パッケージを取得しています。
  echo [Yumeweaving] 数分かかることがあります。このウィンドウを閉じずにお待ちください。
  call npm ci --omit=dev
  if errorlevel 1 exit /b 1
  > "%YUMEWEAVING_INSTALL_STAMP%" echo %YUMEWEAVING_DEPS_HASH%
  if errorlevel 1 exit /b 1
)
exit /b 0

:fail
echo.
echo [${failTitle}]
echo ポート3001が使用中、または依存パッケージの取得に失敗した可能性があります。
echo 詳しくは ${userGuidePath} のトラブルシューティングを確認してください。
pause
exit /b 1
`;
}

function verifyZipEntryNamesAreAscii(filePath) {
  const entries = runCapture('tar.exe', ['-tf', filePath], { cwd: releaseDir })
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const invalid = entries.filter((entry) => !/^[\x20-\x7e]+$/.test(entry));
  if (invalid.length > 0) {
    throw new Error(
      `Package contains non-ASCII zip entries:\n${invalid.map((entry) => `  ${entry}`).join('\n')}`
    );
  }
}
