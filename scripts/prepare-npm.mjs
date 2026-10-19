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
// imagens e links da tag desta versão (v0.2.0): o que está na main muda nas versões seguintes
// e a página de uma versão antiga no npm continuaria apontando para lá. As imagens aparecem
// assim que a tag é enviada ao GitHub (logo depois do npm publish).
const { version } = JSON.parse(fs.readFileSync(new URL('package.json', cli), 'utf8'));
const ref = `v${version}`;
const raw = `https://raw.githubusercontent.com/MongeAI/rastro/${ref}`;
const readme = fs
  .readFileSync(new URL('README.md', root), 'utf8')
  // imagens e srcset relativos → raw.githubusercontent
  .replace(/(src|srcset)="(?!https?:)([^"]+)"/g, (_, attr, p) => `${attr}="${raw}/${p}"`)
  // links markdown relativos → página no GitHub
  .replace(/\]\((?!https?:|#)([^)]+)\)/g, (_, p) => `](${repo}/blob/${ref}/${p})`)
  // links HTML relativos
  .replace(/href="(?!https?:|#)([^"]+)"/g, (_, p) => `href="${repo}/blob/${ref}/${p}"`);
fs.writeFileSync(new URL('README.md', cli), readme);
fs.copyFileSync(new URL('LICENSE', root), new URL('LICENSE', cli));
// os JSON Schemas vão no pacote: o "$schema" do rastro.rules.json aponta para o unpkg
fs.mkdirSync(new URL('schema/', cli), { recursive: true });
for (const schema of ['rastro-graph.schema.json', 'rastro-rules.schema.json'])
  fs.copyFileSync(
    new URL(`packages/core/schema/${schema}`, root),
    new URL(`schema/${schema}`, cli),
  );
console.log('README, LICENSE e JSON Schemas preparados para o pacote npm.');
