#!/usr/bin/env node
// Ponto de entrada do comando `rastro`. Fica fora de dist/ para que o npm consiga
// criar o atalho do comando já no `npm install`, antes do build.
import { existsSync } from 'node:fs';

const entry = new URL('../dist/rastro.mjs', import.meta.url);
if (!existsSync(entry)) {
  // roda antes do bundle (sem o catálogo da CLI): mesmas regras de idioma, em miniatura —
  // --lang, depois RASTRO_LANG, depois LC_ALL/LC_MESSAGES/LANG começando com "pt"; senão inglês
  const args = process.argv.slice(2);
  const flagAt = args.indexOf('--lang');
  const flag = args.find((a) => a.startsWith('--lang='))?.slice('--lang='.length);
  const pick = (v) =>
    /^pt(?:[-_.@]|$)/i.test(v ?? '') ? 'pt' : /^en(?:[-_.@]|$)/i.test(v ?? '') ? 'en' : undefined;
  const { RASTRO_LANG, LC_ALL, LC_MESSAGES, LANG } = process.env;
  const locale = [LC_ALL, LC_MESSAGES, LANG].find((v) => v?.trim());
  const lang =
    pick(flag ?? (flagAt >= 0 ? args[flagAt + 1] : undefined)) ??
    pick(RASTRO_LANG?.trim()) ??
    (locale?.trim().toLowerCase().startsWith('pt') ? 'pt' : 'en');
  console.error(
    lang === 'pt'
      ? 'O Rastro ainda não foi compilado. Rode "npm run build" na raiz do repositório.'
      : 'Rastro has not been built yet. Run "npm run build" at the root of the repository.',
  );
  process.exit(1);
}
await import(entry.href);
