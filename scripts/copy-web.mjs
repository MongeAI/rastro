// Copia a interface compilada (apps/web/dist) para dentro da CLI (apps/cli/dist/web).
import fs from 'node:fs';

const from = new URL('../apps/web/dist/', import.meta.url);
const to = new URL('../apps/cli/dist/web/', import.meta.url);

if (!fs.existsSync(new URL('index.html', from))) {
  console.error('apps/web/dist/index.html não existe. Rode "npm run build -w @teia/web" antes.');
  process.exit(1);
}
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
console.log('Interface copiada para apps/cli/dist/web');
