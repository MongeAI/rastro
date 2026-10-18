import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@rastro/core': src('./packages/core/src/index.ts'),
      '@rastro/graph': src('./packages/graph/src/index.ts'),
      '@rastro/analyzer': src('./packages/analyzer/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/cli/test/**/*.test.ts',
      'apps/web/test/**/*.test.ts',
    ],
    testTimeout: 30_000,
  },
});
