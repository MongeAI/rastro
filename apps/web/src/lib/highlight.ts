/**
 * Realce de sintaxe mínimo para JS/TS (comentários, textos, palavras-chave e números).
 * Não é um parser: serve apenas para facilitar a leitura do trecho na interface.
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
  /(\/\/.*$|\/\*.*?\*\/|\/\*.*$|^.*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g;

export function highlightLine(line: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const m of line.matchAll(PATTERN)) {
    const index = m.index ?? 0;
    if (index > last) tokens.push({ text: line.slice(last, index) });
    const [text, com, str, num, fn, word] = m;
    if (com) tokens.push({ text, cls: 'com' });
    else if (str) tokens.push({ text, cls: 'str' });
    else if (num) tokens.push({ text, cls: 'num' });
    else if (fn) tokens.push({ text, cls: KEYWORDS.has(fn) ? 'kw' : 'fn' });
    else if (word) tokens.push({ text, cls: KEYWORDS.has(word) ? 'kw' : undefined });
    else tokens.push({ text });
    last = index + text.length;
  }
  if (last < line.length) tokens.push({ text: line.slice(last) });
  return tokens;
}
