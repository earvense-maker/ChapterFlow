import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const devPort = Number(process.env.VITE_DEV_PORT ?? 5173);
// NOTE: 以前は process.env.PORT を参照していたが、Vite を起動する側（preview
// harness など）が PORT を Vite 自身のポートとして設定するケースがあり、
// その場合 proxy target が Vite 自身に向いてループ 500 になっていた。専用の
// CHAPTERFLOW_API_PORT に切り替えて衝突を回避する。旧名は互換用。
const apiPort = Number(
  process.env.CHAPTERFLOW_API_PORT ?? process.env.YUMEWEAVING_API_PORT ?? 3001
);

export default defineConfig({
  plugins: [react()],
  root: 'src/client',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  server: {
    port: devPort,
    // NOTE: 指定ポートが使用中でも黙って別ポートへ逃げない。逃げると open:app が
    // 古いインスタンス（別のデータディレクトリのことも）を開いてしまう。
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
