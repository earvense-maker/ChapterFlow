import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    globalSetup: ['./tests/globalSetup.ts'],
    // NOTE: サービス層のテストは実ファイルI/Oとバックグラウンドの非同期処理を待つ。
    // 既定の5秒はワーカー並列時のWindowsで不足し、処理速度を検証していない
    // テスト（storyStateのrefresh待ちなど）が散発的にタイムアウトしていた。
    testTimeout: 20_000,
    // NOTE: 大規模スイートを既定並列度で動かすと、Windowsでworker forkが稀に
    // 異常終了する。4並列なら全テストの所要時間を保ちつつ安定して完走できる。
    maxWorkers: 4,
    include: [
      'tests/unit/**/*.test.ts',
      'tests/unit/**/*.test.tsx',
      'tests/integration/**/*.test.ts',
      // NOTE: 公開Web版のテスト。CIでは npm run web:test で単独実行し、Electron版の
      // ジョブと独立して成否が出るようにしている（設計書 4.1）。
      'tests/web/**/*.test.ts',
    ],
    exclude: ['node_modules', 'dist', 'tests/e2e/**'],
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
});
