// Executado no "prepack" de apps/cli: confere o build e copia README e LICENSE para o pacote.
// No npmjs.com, links relativos do README quebram; trocamos por URLs absolutas do GitHub.
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const cli = new URL('../apps/cli/', import.meta.url);
for (const required of ['dist/rastro.mjs', 'dist/web/index.html']) {
  if (!fs.existsSync(new URL(required, cli))) {
    console.error(`Falta apps/cli/${required}. Rode "npm run build" na raiz antes de publicar.`);
    process.exit(1);
  }
}
const repo = 'https://github.com/MongeAI/rastro';
const raw = 'https://raw.githubusercontent.com/MongeAI/rastro/main';
const readme = fs
  .readFileSync(new URL('README.md', root), 'utf8')
  // imagens e srcset relativos → raw.githubusercontent
  .replace(/(src|srcset)="(?!https?:)([^"]+)"/g, (_, attr, p) => `${attr}="${raw}/${p}"`)
  // links markdown relativos → página no GitHub
  .replace(/\]\((?!https?:|#)([^)]+)\)/g, (_, p) => `](${repo}/blob/main/${p})`)
  // links HTML relativos
  .replace(/href="(?!https?:|#)([^"]+)"/g, (_, p) => `href="${repo}/blob/main/${p}"`);
fs.writeFileSync(new URL('README.md', cli), readme);
fs.copyFileSync(new URL('LICENSE', root), new URL('LICENSE', cli));
console.log('README e LICENSE preparados para o pacote npm.');
