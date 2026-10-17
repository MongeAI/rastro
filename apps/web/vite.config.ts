import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@teia/core': src('../../packages/core/src/index.ts'),
      '@teia/graph': src('../../packages/graph/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    // em desenvolvimento, rode `teia <pasta> --port 4321 --no-open` em paralelo e abra uma vez
    // a URL com token que ele mostra (o cookie vale para 127.0.0.1 em qualquer porta)
    proxy: { '/api': { target: 'http://127.0.0.1:4321', changeOrigin: true } },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
});
