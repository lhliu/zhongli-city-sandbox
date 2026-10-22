import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // `npm run pages:dev` 跑在 8788；前端開發時把 /api 轉過去
    proxy: { '/api': 'http://127.0.0.1:8788' },
  },
  build: { chunkSizeWarningLimit: 1500 },
});
