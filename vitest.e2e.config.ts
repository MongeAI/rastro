import { defineConfig } from 'vitest/config';

/** Testes de ponta a ponta da interface (Chrome headless + CLI empacotada). */
export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    testTimeout: 60_000,
    // uma pasta temporária por execução, apagada no fim (veja scripts/test-tmp.ts)
    globalSetup: ['./scripts/test-tmp.ts'],
    hookTimeout: 90_000,
    // um navegador só, testes em sequência: resultados estáveis
    fileParallelism: false,
  },
});
