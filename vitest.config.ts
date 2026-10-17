import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@teia/core': src('./packages/core/src/index.ts'),
      '@teia/graph': src('./packages/graph/src/index.ts'),
      '@teia/analyzer': src('./packages/analyzer/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/cli/test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
