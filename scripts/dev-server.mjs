import { spawn } from 'node:child_process';

// NOTE: Plain `npm run dev` should keep using repository fixtures. External env,
// such as the bat files or Playwright, stays authoritative.
if (!process.env.YUMEWEAVING_DATA_DIR?.trim()) {
  process.env.YUMEWEAVING_DATA_DIR = 'data';
}

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
