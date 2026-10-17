// Remove saídas de build (dist e .tsbuildinfo) de todos os pacotes.
import fs from 'node:fs';

for (const dir of [
  'packages/core',
  'packages/graph',
  'packages/analyzer',
  'apps/cli',
  'apps/web',
]) {
  fs.rmSync(new URL(`../${dir}/dist`, import.meta.url), { recursive: true, force: true });
  for (const f of fs.readdirSync(new URL(`../${dir}`, import.meta.url))) {
    if (f.endsWith('.tsbuildinfo')) fs.rmSync(new URL(`../${dir}/${f}`, import.meta.url));
  }
}
console.log('Builds removidos.');
