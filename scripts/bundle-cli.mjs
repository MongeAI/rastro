// Gera apps/cli/dist/rastro.mjs: a CLI com os pacotes internos (@rastro/*) embutidos.
// Assim o pacote publicado no npm ("rastro") depende só de ts-morph e ignore.
import { rolldown } from 'rolldown';
import fs from 'node:fs';

const entry = new URL('../apps/cli/dist/index.js', import.meta.url);
if (!fs.existsSync(entry)) {
  console.error('apps/cli/dist/index.js não existe. Rode o build do TypeScript antes.');
  process.exit(1);
}
const bundle = await rolldown({
  input: entry.pathname,
  platform: 'node',
  external: (id) => id === 'ts-morph' || id === 'ignore' || id.startsWith('node:'),
  logLevel: 'warn',
});
await bundle.write({
  file: new URL('../apps/cli/dist/rastro.mjs', import.meta.url).pathname,
  format: 'esm',
});
await bundle.close();
const size = fs.statSync(new URL('../apps/cli/dist/rastro.mjs', import.meta.url)).size;
console.log(`CLI empacotada em apps/cli/dist/rastro.mjs (${Math.round(size / 1024)} KB)`);
