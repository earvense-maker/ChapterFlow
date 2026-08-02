import { spawn } from 'node:child_process';

// NOTE: Plain `npm run dev` should keep using repository fixtures. External env,
// such as the bat files or Playwright, stays authoritative.
// CHAPTERFLOW_USE_DEFAULT_DATA_DIR=1 (set by the user-facing bat launchers) skips the
// fixture fallback so config.ts resolveDefaultDataDir picks the real Documents folder
// — the bat must not duplicate that folder-priority logic in cmd syntax.
if (
  !process.env.CHAPTERFLOW_DATA_DIR?.trim() &&
  !process.env.YUMEWEAVING_DATA_DIR?.trim() &&
  process.env.CHAPTERFLOW_USE_DEFAULT_DATA_DIR !== '1'
) {
  process.env.CHAPTERFLOW_DATA_DIR = 'data';
}

// NOTE: 生成の詳細診断（telemetry と推論本文スナップショット）はソースから起動する
// 開発版だけで有効にする。配布 exe は dist/electron/main.js を直接起動しこの経路を
// 通らないので、リリース版へ紛れ込まない。明示指定があればそれを尊重する（0 で無効化可）。
process.env.CHAPTERFLOW_DEV_DIAGNOSTICS ??= '1';

const child = spawn('tsx', ['watch', 'src/server/index.ts'], {
  shell: true,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('[dev-server] Failed to start server:', err);
  process.exit(1);
});
