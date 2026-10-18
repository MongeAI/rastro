/**
 * Markdown seguro para comentários públicos (pull request, resumo do job) e respostas do MCP:
 * o texto do projeto analisado sempre vai como código, e os links `arquivo:linha` são
 * codificados parte por parte. Usado pelo `rastro impact` e pelo `rastro check`.
 */

export interface RenderOptions {
  /** Base dos links `arquivo:linha` no Markdown (ex.: https://github.com/org/repo/blob/<commit>). */
  link?: string;
  /** Máximo de itens por lista no texto e no Markdown (o JSON vem completo). */
  limit?: number;
}

/**
 * Texto vindo do projeto analisado (nomes, caminhos) em um trecho de código: nada de links,
 * imagens, menções ou HTML injetados num comentário público. Caracteres de controle e quebras
 * de linha viram espaço; em tabelas, `|` é escapado (o GitHub exige até dentro de código).
 */
export function mdCode(text: string, inTable = false): string {
  // eslint-disable-next-line no-control-regex -- é exatamente o que queremos remover
  let clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  if (inTable) clean = clean.replace(/\|/g, '\\|');
  const longest = Math.max(0, ...[...clean.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = clean.startsWith('`') || clean.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${clean}${pad}${fence}`;
}

/** `arquivo:linha` em código e, com `link`, como link para a linha no repositório. */
export function fileLink(
  file: string | undefined,
  line: number | undefined,
  options: RenderOptions,
  inTable = false,
): string {
  if (!file) return '';
  const label = mdCode(`${file}${line ? `:${line}` : ''}`, inTable);
  if (!options.link) return label;
  // encodeURIComponent deixa ( ) ! * ' ~ como estão: um ")" sem par num nome de arquivo
  // fecharia o link antes da hora e o resto viraria Markdown solto no comentário
  const encode = (segment: string) =>
    encodeURIComponent(segment).replace(
      /[!'()*~]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  const url =
    `${options.link.replace(/\/+$/, '')}/` +
    file.split('/').map(encode).join('/') +
    (line ? `#L${line}` : '');
  return `[${label}](${url})`;
}
