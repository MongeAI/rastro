#!/usr/bin/env node
// Ponto de entrada do comando `teia`. Fica fora de dist/ para que o npm consiga
// criar o atalho do comando já no `npm install`, antes do build.
import { existsSync } from 'node:fs';

const entry = new URL('../dist/index.js', import.meta.url);
if (!existsSync(entry)) {
  console.error('O Teia ainda não foi compilado. Rode "npm run build" na raiz do repositório.');
  process.exit(1);
}
await import(entry.href);
