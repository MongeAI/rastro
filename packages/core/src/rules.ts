import type { Lang } from './labels.js';

/**
 * Regras de arquitetura (`rastro.rules.json`): o que cada parte do projeto pode ou não usar.
 *
 * O arquivo é JSON puro (nunca código do projeto é executado). Cada regra vale para os
 * arquivos de `from` (menos os de `except`) e é de um tipo:
 * - `deny`: esses arquivos não podem depender dos arquivos ou pacotes listados;
 * - `allow`: só podem depender dos listados (e dos próprios arquivos de `from`);
 * - `noCycles`: não pode haver ciclo de importação entre eles.
 *
 * Padrões de caminho são relativos à pasta analisada: `*` (qualquer coisa menos `/`), `**`
 * (qualquer número de pastas), `?` e `{a,b}`. Colchetes são literais (`app/[id]/page.tsx`
 * do Next.js). Um caminho sem curinga vale para o arquivo ou para tudo dentro da pasta
 * (`src/db` = `src/db/**`). Pacotes começam com `pkg:` (`pkg:pg`, `pkg:@aws-sdk/*`,
 * `pkg:node:*` para os módulos nativos do Node.js).
 */
export interface RuleSpec {
  /** Nome curto, mostrado em cada violação. Único no arquivo. */
  name: string;
  /** Arquivos a que a regra se aplica (padrão: todos). */
  from?: string | string[];
  /** Arquivos de `from` que ficam de fora (ex.: testes). */
  except?: string | string[];
  deny?: string | string[];
  allow?: string | string[];
  noCycles?: boolean;
  /** `deny`/`allow`: imports só de tipo (`import type`) não contam. */
  ignoreTypeImports?: boolean;
  /** `error` (padrão) reprova o `rastro check`; `warning` só avisa. */
  severity?: RuleSeverity;
  /** Por quê, ou o que fazer em vez disso (mostrado junto das violações). */
  because?: string;
}

export type RuleSeverity = 'error' | 'warning';

export interface RulesConfig {
  $schema?: string;
  rules: RuleSpec[];
}

/** Uma regra já conferida, com listas no lugar de valores soltos. */
export interface Rule {
  name: string;
  kind: 'deny' | 'allow' | 'cycles';
  from: string[];
  except: string[];
  /** Os padrões de `deny` ou de `allow` (vazio em `noCycles`). */
  targets: string[];
  ignoreTypeImports: boolean;
  severity: RuleSeverity;
  because?: string;
}

/** Nome do arquivo de regras procurado na raiz da pasta analisada. */
export const RULES_FILE = 'rastro.rules.json';

const RULE_TEXTS = {
  'invalid-json': {
    pt: (p) => `JSON inválido: ${p.message}`,
    en: (p) => `Invalid JSON: ${p.message}`,
  },
  'not-object': {
    pt: () => 'O arquivo de regras precisa ser um objeto JSON com a lista "rules".',
    en: () => 'The rules file must be a JSON object with a "rules" list.',
  },
  'rules-missing': {
    pt: () => 'Falta a lista "rules".',
    en: () => 'The "rules" list is missing.',
  },
  'not-list': {
    pt: (p) => `${p.field} deve ser uma lista.`,
    en: (p) => `${p.field} must be a list.`,
  },
  'not-object-rule': {
    pt: (p) => `${p.field} deve ser um objeto.`,
    en: (p) => `${p.field} must be an object.`,
  },
  'unknown-key': {
    pt: (p) => `${p.field}: campo desconhecido.`,
    en: (p) => `${p.field}: unknown field.`,
  },
  'no-name': {
    pt: (p) => `${p.field}.name é obrigatório (um nome curto para a regra).`,
    en: (p) => `${p.field}.name is required (a short name for the rule).`,
  },
  'duplicate-name': {
    pt: (p) => `${p.field}.name: já existe uma regra chamada "${p.name}".`,
    en: (p) => `${p.field}.name: there is already a rule named "${p.name}".`,
  },
  'no-kind': {
    pt: (p) => `${p.field} precisa de "deny", "allow" ou "noCycles": true.`,
    en: (p) => `${p.field} needs "deny", "allow" or "noCycles": true.`,
  },
  'many-kinds': {
    pt: (p) => `${p.field} deve ter só um entre "deny", "allow" e "noCycles".`,
    en: (p) => `${p.field} must have only one of "deny", "allow" and "noCycles".`,
  },
  'not-patterns': {
    pt: (p) => `${p.field} deve ser um padrão ou uma lista não vazia de padrões.`,
    en: (p) => `${p.field} must be a pattern or a non-empty list of patterns.`,
  },
  'bad-pattern': {
    pt: (p) =>
      `${p.field}: padrão inválido "${p.pattern}" (${p.reason === 'braces' ? 'chaves sem par ou aninhadas' : p.reason === 'complex' ? 'longo demais ou com alternativas demais' : 'vazio'}).`,
    en: (p) =>
      `${p.field}: invalid pattern "${p.pattern}" (${p.reason === 'braces' ? 'unbalanced or nested braces' : p.reason === 'complex' ? 'too long or too many alternatives' : 'empty'}).`,
  },
  'package-in-from': {
    pt: (p) =>
      `${p.field}: "${p.pattern}" é um pacote; "from" e "except" escolhem arquivos do projeto.`,
    en: (p) => `${p.field}: "${p.pattern}" is a package; "from" and "except" pick project files.`,
  },
  'not-boolean': {
    pt: (p) => `${p.field} deve ser true ou false.`,
    en: (p) => `${p.field} must be true or false.`,
  },
  'not-string': {
    pt: (p) => `${p.field} deve ser um texto.`,
    en: (p) => `${p.field} must be a string.`,
  },
  'bad-severity': {
    pt: (p) => `${p.field} deve ser "error" ou "warning".`,
    en: (p) => `${p.field} must be "error" or "warning".`,
  },
  'not-applicable': {
    pt: (p) =>
      `${p.field} não vale para regras "noCycles" (imports só de tipo nunca formam ciclos).`,
    en: (p) =>
      `${p.field} does not apply to "noCycles" rules (type-only imports never form cycles).`,
  },
} satisfies Record<string, Record<Lang, (p: Record<string, string | number>) => string>>;

export type RuleIssueCode = keyof typeof RULE_TEXTS;

/** Um problema no arquivo de regras, independente de idioma (veja `ruleIssueText`). */
export interface RuleIssue {
  code: RuleIssueCode;
  params: Record<string, string | number>;
}

/** Texto de um problema do arquivo de regras no idioma pedido. */
export function ruleIssueText(issue: RuleIssue, lang: Lang): string {
  const texts = Object.hasOwn(RULE_TEXTS, issue.code) ? RULE_TEXTS[issue.code] : undefined;
  return texts ? texts[lang](issue.params) : issue.code;
}

const RULE_KEYS = new Set([
  'name',
  'from',
  'except',
  'deny',
  'allow',
  'noCycles',
  'ignoreTypeImports',
  'severity',
  'because',
]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Confere o conteúdo de um arquivo de regras (já lido como JSON). Campo desconhecido é erro:
 * um `"form"` no lugar de `"from"` faria a regra valer para o projeto inteiro em silêncio.
 * Só devolve as regras quando não há nenhum problema.
 */
export function parseRules(data: unknown): { rules?: Rule[]; issues: RuleIssue[] } {
  const issues: RuleIssue[] = [];
  const issue = (code: RuleIssueCode, params: Record<string, string | number> = {}) =>
    issues.push({ code, params });
  if (!isObject(data)) {
    issue('not-object');
    return { issues };
  }
  for (const key of Object.keys(data))
    if (key !== 'rules' && key !== '$schema') issue('unknown-key', { field: key });
  if (data.$schema !== undefined && typeof data.$schema !== 'string')
    issue('not-string', { field: '$schema' });
  if (data.rules === undefined) {
    issue('rules-missing');
    return { issues };
  }
  if (!Array.isArray(data.rules)) {
    issue('not-list', { field: 'rules' });
    return { issues };
  }
  const rules: Rule[] = [];
  const names = new Set<string>();
  data.rules.forEach((raw: unknown, i) => {
    const field = `rules[${i}]`;
    if (!isObject(raw)) return void issue('not-object-rule', { field });
    for (const key of Object.keys(raw))
      if (!RULE_KEYS.has(key)) issue('unknown-key', { field: `${field}.${key}` });

    let name = '';
    if (typeof raw.name !== 'string' || !raw.name.trim()) issue('no-name', { field });
    else {
      name = raw.name.trim();
      if (names.has(name)) issue('duplicate-name', { field, name });
      names.add(name);
    }

    const patterns = (key: string): string[] | undefined => {
      const value = raw[key];
      if (value === undefined) return undefined;
      const list = typeof value === 'string' ? [value] : value;
      if (
        !Array.isArray(list) ||
        !list.length ||
        list.some((p: unknown) => typeof p !== 'string')
      ) {
        issue('not-patterns', { field: `${field}.${key}` });
        return [];
      }
      for (const pattern of list as string[]) {
        const reason = patternProblem(pattern);
        if (reason) issue('bad-pattern', { field: `${field}.${key}`, pattern, reason });
      }
      return list as string[];
    };
    const from = patterns('from');
    const except = patterns('except');
    for (const [key, list] of [
      ['from', from],
      ['except', except],
    ] as const)
      for (const pattern of list ?? [])
        if (pattern.startsWith(PACKAGE_PREFIX))
          issue('package-in-from', { field: `${field}.${key}`, pattern });
    const deny = patterns('deny');
    const allow = patterns('allow');

    if (raw.noCycles !== undefined && typeof raw.noCycles !== 'boolean')
      issue('not-boolean', { field: `${field}.noCycles` });
    if (raw.ignoreTypeImports !== undefined && typeof raw.ignoreTypeImports !== 'boolean')
      issue('not-boolean', { field: `${field}.ignoreTypeImports` });
    const noCycles = raw.noCycles === true;
    const kinds = [deny, allow, noCycles || undefined].filter((k) => k !== undefined).length;
    if (kinds === 0) issue('no-kind', { field });
    if (kinds > 1) issue('many-kinds', { field });
    if (noCycles && raw.ignoreTypeImports !== undefined)
      issue('not-applicable', { field: `${field}.ignoreTypeImports` });

    if (raw.severity !== undefined && raw.severity !== 'error' && raw.severity !== 'warning')
      issue('bad-severity', { field: `${field}.severity` });
    if (raw.because !== undefined && typeof raw.because !== 'string')
      issue('not-string', { field: `${field}.because` });

    rules.push({
      name,
      kind: deny ? 'deny' : allow ? 'allow' : 'cycles',
      from: from ?? ['**'],
      except: except ?? [],
      targets: deny ?? allow ?? [],
      ignoreTypeImports: raw.ignoreTypeImports === true,
      severity: raw.severity === 'warning' ? 'warning' : 'error',
      ...(typeof raw.because === 'string' && raw.because.trim()
        ? { because: raw.because.trim() }
        : {}),
    });
  });
  return issues.length ? { issues } : { rules, issues };
}

// ---------------------------------------------------------------------------------------------
// Padrões de caminho
//
// O arquivo de regras pode vir de um pull request (no CI): os padrões nunca viram expressões
// regulares (um `*a*a*a*a…` travaria o CI por backtracking). O casamento é por programação
// dinâmica, em tempo proporcional a (tamanho do padrão × tamanho do caminho), e as chaves
// são expandidas antes, com limite.

export const PACKAGE_PREFIX = 'pkg:';

const MAX_PATTERN = 500;
const MAX_ALTERNATIVES = 64;

class PatternError extends Error {
  constructor(readonly reason: 'braces' | 'complex') {
    super(reason);
  }
}

function patternProblem(pattern: string): 'empty' | 'braces' | 'complex' | undefined {
  const body = pattern.startsWith(PACKAGE_PREFIX) ? pattern.slice(PACKAGE_PREFIX.length) : pattern;
  if (!normalizePattern(body)) return 'empty';
  try {
    globMatcher(body);
  } catch (err) {
    return err instanceof PatternError ? err.reason : 'braces';
  }
  return undefined;
}

/** Tira `./` e `/` do começo e barras repetidas; `pasta/` vira `pasta/**`. */
function normalizePattern(pattern: string): string {
  let p = pattern.trim().replace(/\/{2,}/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/^\/+/, '');
  if (p.endsWith('/')) p = `${p}**`;
  return p === '.' ? '**' : p;
}

/** Um pedaço do padrão já interpretado. */
type Token =
  | { t: 'lit'; c: string }
  /** `?`: um caractere que não é `/`. */
  | { t: 'one' }
  /** `*`: qualquer sequência sem `/`. */
  | { t: 'star' }
  /** `**` seguido de `/`: zero ou mais pastas inteiras (`a/`, `a/b/`...). */
  | { t: 'dirs' }
  /** `/**` no fim: nada, ou `/` e qualquer coisa (a pasta e tudo dentro). */
  | { t: 'tail' }
  /** `**` sozinho: qualquer caminho. */
  | { t: 'all' };

/** `{a,b}` vira uma lista de padrões sem chaves (chaves aninhadas ou sem par são erro). */
function expandBraces(p: string): string[] {
  let open = -1;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '\\') i++;
    else if (p[i] === '{') {
      open = i;
      break;
    }
  }
  if (open < 0) return [p];
  let close = -1;
  for (let i = open + 1; i < p.length; i++) {
    if (p[i] === '\\') i++;
    else if (p[i] === '{') throw new PatternError('braces');
    else if (p[i] === '}') {
      close = i;
      break;
    }
  }
  if (close < 0) throw new PatternError('braces');
  const alternatives: string[] = [];
  let current = '';
  for (let i = open + 1; i < close; i++) {
    if (p[i] === '\\' && i + 1 < close) current += p[i]! + p[++i]!;
    else if (p[i] === ',') {
      alternatives.push(current);
      current = '';
    } else current += p[i];
  }
  alternatives.push(current);
  const head = p.slice(0, open);
  const rest = expandBraces(p.slice(close + 1));
  const result: string[] = [];
  for (const alt of alternatives)
    for (const tail of rest) {
      result.push(`${head}${alt}${tail}`);
      if (result.length > MAX_ALTERNATIVES) throw new PatternError('complex');
    }
  return result;
}

function tokenize(p: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '\\' && i + 1 < p.length) {
      tokens.push({ t: 'lit', c: p[++i]! });
    } else if (c === '*') {
      let j = i;
      while (p[j + 1] === '*') j++;
      const startsSegment = i === 0 || p[i - 1] === '/';
      const endsSegment = j + 1 >= p.length || p[j + 1] === '/';
      if (j > i && startsSegment && endsSegment) {
        if (j + 1 >= p.length) {
          // `x/**`: a pasta e tudo dentro; `**` sozinho: qualquer caminho
          const last = tokens[tokens.length - 1];
          if (last?.t === 'lit' && last.c === '/') tokens[tokens.length - 1] = { t: 'tail' };
          else tokens.push({ t: 'all' });
          i = j;
        } else {
          // `**/` repetido equivale a um só
          if (tokens[tokens.length - 1]?.t !== 'dirs') tokens.push({ t: 'dirs' });
          i = j + 1;
        }
      } else {
        if (tokens[tokens.length - 1]?.t !== 'star') tokens.push({ t: 'star' });
        i = j;
      }
    } else if (c === '?') {
      tokens.push({ t: 'one' });
    } else {
      tokens.push({ t: 'lit', c });
    }
  }
  return tokens;
}

/** O caminho inteiro casa com os pedaços? Programação dinâmica: cada estado é visto uma vez. */
function matchTokens(tokens: Token[], path: string): boolean {
  const P = tokens.length;
  const L = path.length;
  // 0 = não visto, 1 = casa, 2 = não casa
  const memo = new Uint8Array((P + 1) * (L + 1));
  const go = (i: number, j: number): boolean => {
    const key = i * (L + 1) + j;
    if (memo[key]) return memo[key] === 1;
    let ok = false;
    if (i === P) ok = j === L;
    else {
      const token = tokens[i]!;
      switch (token.t) {
        case 'lit':
          ok = path[j] === token.c && go(i + 1, j + 1);
          break;
        case 'one':
          ok = j < L && path[j] !== '/' && go(i + 1, j + 1);
          break;
        case 'star':
          ok = go(i + 1, j) || (j < L && path[j] !== '/' && go(i, j + 1));
          break;
        case 'dirs':
          ok = go(i + 1, j);
          for (let k = j; !ok && k < L; k++) if (path[k] === '/') ok = go(i + 1, k + 1);
          break;
        case 'tail':
          ok = j === L || (path[j] === '/' && i + 1 === P) || go(i + 1, j);
          break;
        case 'all':
          ok = i + 1 === P || go(i + 1, j);
          for (let k = j; !ok && k < L; k++) ok = go(i + 1, k + 1);
          break;
      }
    }
    memo[key] = ok ? 1 : 2;
    return ok;
  };
  return go(0, 0);
}

/**
 * Compila um padrão num teste do caminho inteiro (relativo, com `/`). Sem curinga, vale para
 * o próprio caminho e para tudo dentro dele (é uma pasta ou um arquivo). Lança erro para
 * chaves sem par ou aninhadas e para padrões grandes demais.
 */
export function globMatcher(pattern: string): (path: string) => boolean {
  const p = normalizePattern(pattern);
  if (p.length > MAX_PATTERN) throw new PatternError('complex');
  if (!/[*?{]/.test(p.replace(/\\./g, ''))) {
    const literal = p.replace(/\\(.)/g, '$1');
    return (path) => path === literal || path.startsWith(`${literal}/`);
  }
  const variants = expandBraces(p).map(tokenize);
  return (path) => variants.some((tokens) => matchTokens(tokens, path));
}

/**
 * Padrões de arquivos e de pacotes já compilados (por `compilePatterns`), com cache: as
 * mesmas regras são testadas contra cada relação do projeto.
 */
export interface PatternSet {
  files: Array<(path: string) => boolean>;
  packages: Array<(name: string) => boolean>;
  cache: Map<string, boolean>;
}

export function compilePatterns(patterns: string[]): PatternSet {
  const set: PatternSet = { files: [], packages: [], cache: new Map() };
  for (const pattern of patterns) {
    if (pattern.startsWith(PACKAGE_PREFIX))
      set.packages.push(globMatcher(pattern.slice(PACKAGE_PREFIX.length)));
    else set.files.push(globMatcher(pattern));
  }
  return set;
}

export function matchesFile(set: PatternSet, file: string): boolean {
  const key = `f${file}`;
  let hit = set.cache.get(key);
  if (hit === undefined) {
    hit = set.files.some((match) => match(file));
    set.cache.set(key, hit);
  }
  return hit;
}

export function matchesPackage(set: PatternSet, name: string): boolean {
  const key = `p${name}`;
  let hit = set.cache.get(key);
  if (hit === undefined) {
    hit = set.packages.some((match) => match(name));
    set.cache.set(key, hit);
  }
  return hit;
}
