import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // 프론트(5173)에서 /api 호출 → 로컬 Worker(8787)로 프록시
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: { outDir: 'dist' },
});
