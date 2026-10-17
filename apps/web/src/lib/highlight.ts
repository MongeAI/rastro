/**
 * Realce de sintaxe mínimo para JS/TS (comentários, textos, palavras-chave e números).
 * Não é um parser: serve apenas para facilitar a leitura do trecho na interface.
 * Comentários de bloco que atravessam linhas são acompanhados por `highlightLines`.
 */
export type Token = { text: string; cls?: 'kw' | 'str' | 'com' | 'num' | 'fn' };

const KEYWORDS = new Set(
  (
    'import export from as default function return const let var class extends new this super if else for while do ' +
    'switch case break continue try catch finally throw async await yield typeof instanceof in of void delete ' +
    'interface type enum implements public private protected readonly static get set declare namespace module require true false null undefined'
  ).split(' '),
);

const PATTERN =
  /(\/\/.*$)|(\/\*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)n?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g;

/** Realça uma linha; `inComment` indica se a linha começa dentro de um comentário de bloco. */
export function highlightLine(
  line: string,
  inComment = false,
): { tokens: Token[]; inComment: boolean } {
  const tokens: Token[] = [];
  let pos = 0;
  if (inComment) {
    const end = line.indexOf('*/');
    if (end === -1) return { tokens: [{ text: line, cls: 'com' }], inComment: true };
    tokens.push({ text: line.slice(0, end + 2), cls: 'com' });
    pos = end + 2;
  }
  PATTERN.lastIndex = pos;
  let last = pos;
  let match: RegExpExecArray | null;
  while ((match = PATTERN.exec(line))) {
    const index = match.index;
    if (index > last) tokens.push({ text: line.slice(last, index) });
    const [text, lineComment, blockStart, str, num, fn, word] = match;
    if (blockStart) {
      const end = line.indexOf('*/', index + 2);
      if (end === -1) {
        tokens.push({ text: line.slice(index), cls: 'com' });
        return { tokens, inComment: true };
      }
      tokens.push({ text: line.slice(index, end + 2), cls: 'com' });
      last = PATTERN.lastIndex = end + 2;
      continue;
    }
    if (lineComment) tokens.push({ text, cls: 'com' });
    else if (str) tokens.push({ text, cls: 'str' });
    else if (num) tokens.push({ text, cls: 'num' });
    else if (fn) tokens.push({ text, cls: KEYWORDS.has(fn) ? 'kw' : 'fn' });
    else if (word) tokens.push({ text, cls: KEYWORDS.has(word) ? 'kw' : undefined });
    else tokens.push({ text });
    last = index + text.length;
    if (text.length === 0) PATTERN.lastIndex++;
  }
  if (last < line.length) tokens.push({ text: line.slice(last) });
  return { tokens, inComment: false };
}

/** Realça várias linhas, carregando o estado de comentário de bloco de uma para a outra. */
export function highlightLines(lines: readonly string[]): Token[][] {
  let inComment = false;
  return lines.map((line) => {
    const result = highlightLine(line, inComment);
    inComment = result.inComment;
    return result.tokens;
  });
}
