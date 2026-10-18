import fs from 'node:fs';
import path from 'node:path';
import { RASTRO_VERSION, type RastroGraph } from '@rastro/core';
import { getLang, t } from './i18n.js';

/**
 * Relatório HTML único e offline: a mesma interface do `rastro <pasta>`, num arquivo só,
 * que abre direto do disco (file://), sem servidor e sem internet.
 *
 * - O JS e o CSS compilados da interface são embutidos na página; as fontes viram data: URLs.
 * - O grafo vai em `<script id="rastro-graph" type="application/json">`, que a interface lê
 *   antes de tentar `/api/graph`.
 * - Navegadores não criam Web Workers a partir de file://. O código do worker do ELK (layout
 *   hierárquico) vai embutido como texto em `window.__RASTRO_ELK_WORKER_SOURCE__`, e a
 *   interface o carrega por um Blob URL.
 * - Uma CSP no próprio HTML proíbe qualquer acesso à rede: o relatório não chama nada de fora,
 *   mesmo se um nome no grafo tentar.
 */

const MIME: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Sem servidor, não há cabeçalhos: a política vai no HTML. Scripts inline são o próprio app. */
export const REPORT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  'worker-src blob:',
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * JSON seguro dentro de `<script>`: `<`, `>` e `&` viram escapes `<`... (um nome como
 * `</script>` não fecha a tag), assim como U+2028/U+2029.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * Código JS embutido em `<script>`: `</script` dentro de textos do bundle fecharia a tag.
 * `<\/script` e `<\!--` são equivalentes dentro de strings, templates e comentários.
 */
function inlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Monta o relatório a partir da interface compilada (`dist/web`). */
export function buildHtmlReport(graph: RastroGraph, webRoot: string): string {
  const root = path.resolve(webRoot);
  const indexFile = path.join(root, 'index.html');
  if (!fs.existsSync(indexFile)) throw new Error(t().serve.webNotBuilt);
  const index = fs.readFileSync(indexFile, 'utf8');

  /** Caminho de um arquivo da interface (`/assets/x.js`), sem sair da pasta. */
  const asset = (ref: string): string => {
    const clean = ref.split(/[?#]/)[0]!.replace(/^\.?\/+/, '');
    const file = path.resolve(root, clean);
    if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file))
      throw new Error(t().report.assetNotFound(ref));
    return file;
  };
  const dataUrl = (file: string) =>
    `data:${MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'};base64,${fs
      .readFileSync(file)
      .toString('base64')}`;

  const scripts = [...index.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)].map(
    (m) => m[1]!,
  );
  const styles = [
    ...index.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g),
  ].map((m) => m[1]!);
  const icon = /<link\b[^>]*\brel="icon"[^>]*\bhref="([^"]+)"[^>]*>/.exec(index)?.[1];
  if (scripts.length !== 1) throw new Error(t().report.scriptNotFound);
  const entry = asset(scripts[0]!);
  const js = fs.readFileSync(entry, 'utf8');

  const assetsDir = path.dirname(entry);
  const assetFiles = fs.readdirSync(assetsDir);
  const workerName = assetFiles.find((f) => /^elk-worker.*\.js$/.test(f));
  if (!workerName) throw new Error(t().report.elkWorkerMissing);
  // a interface precisa caber num único bundle (mais o worker): pedaços carregados sob demanda
  // não existiriam no relatório
  for (const f of assetFiles)
    if (f.endsWith('.js') && f !== path.basename(entry) && f !== workerName && js.includes(f))
      throw new Error(t().report.lazyChunk(f));
  const worker = fs.readFileSync(path.join(assetsDir, workerName), 'utf8');

  // fontes e imagens do CSS viram data: URLs (nada é buscado fora do arquivo)
  const css = styles
    .map((ref) =>
      fs
        .readFileSync(asset(ref), 'utf8')
        .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, _q: string, url: string) =>
          /^(data:|#)/.test(url) ? match : `url("${dataUrl(asset(url))}")`,
        ),
    )
    .join('\n')
    .replace(/<\/(style)/gi, '<\\/$1');

  const title = `${graph.project.name} · Rastro`;
  return `<!doctype html>
<html lang="${getLang() === 'pt' ? 'pt-BR' : 'en'}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark light" />
    <meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}" />
    <meta name="referrer" content="no-referrer" />
    <meta name="generator" content="Rastro ${RASTRO_VERSION}" />
    <title>${escapeHtml(title)}</title>
${icon ? `    <link rel="icon" type="image/svg+xml" href="${dataUrl(asset(icon))}" />\n` : ''}    <style>
${css}
    </style>
    <script id="rastro-graph" type="application/json">${jsonForScript(graph)}</script>
    <script>
      window.__RASTRO_ELK_WORKER_SOURCE__ = ${jsonForScript(worker)};
    </script>
    <script type="module">
${inlineScript(js)}
    </script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;
}
