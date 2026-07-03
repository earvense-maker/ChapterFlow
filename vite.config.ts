import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const devPort = Number(process.env.VITE_DEV_PORT ?? 5173);
const apiPort = Number(process.env.PORT ?? 3001);

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
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
