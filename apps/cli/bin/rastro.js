#!/usr/bin/env node
// Ponto de entrada do comando `rastro`. Fica fora de dist/ para que o npm consiga
// criar o atalho do comando já no `npm install`, antes do build.
import { existsSync } from 'node:fs';

const entry = new URL('../dist/rastro.mjs', import.meta.url);
if (!existsSync(entry)) {
  console.error('O Rastro ainda não foi compilado. Rode "npm run build" na raiz do repositório.');
  process.exit(1);
}
await import(entry.href);
