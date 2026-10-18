import fs from 'node:fs';
import path from 'node:path';
import {
  compareStrings,
  diagnosticText,
  EDGE_KINDS,
  NODE_KIND_LABELS_EN,
  NODE_KINDS,
  RASTRO_VERSION,
  type ChangedFile,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  type UnresolvedReason,
} from '@rastro/core';
import {
  findPathBetween,
  findPaths,
  findPossiblePath,
  routesAndTests,
  type BrokenReference,
  type GraphIndex,
  type ImpactEntry,
  type PathResult,
} from '@rastro/graph';
import { collectChanges } from './git.js';
import { getLang, setLang } from './i18n.js';
import { changesWithImpact, mdCode } from './impact.js';
import type { Snapshot } from './mcp-project.js';
import { readSource } from './server.js';

/**
 * As ferramentas do `rastro mcp`: consultas ao grafo com respostas em texto compacto
 * (Markdown) para agentes de IA. Regras de todas elas:
 * - nunca inventam relações: o que é comprovado (resolvido, com arquivo:linha) fica separado
 *   do que é possível (não resolvido, com candidatos) e do que é externo;
 * - listas têm limite, dizem quantos itens foram mostrados de quantos e como ver o resto;
 * - texto vindo do projeto (nomes, caminhos, ids, trechos) nunca quebra linha nem vira
 *   Markdown: caracteres de controle e separadores de linha viram escapes visíveis (`\n`), e
 *   os ids escritos assim voltam a funcionar como alvo;
 * - caminhos são relativos à raiz do projeto; o texto vem em inglês (é lido por agentes).
 */

// ---------------------------------------------------------------------------
// esquemas de entrada (um subconjunto de JSON Schema, conferido aqui mesmo)

type StringSchema = {
  type: 'string';
  description?: string;
  minLength?: number;
  maxLength?: number;
  enum?: readonly string[];
};
type IntegerSchema = {
  type: 'integer';
  description?: string;
  minimum: number;
  maximum: number;
  default?: number;
};
type BooleanSchema = { type: 'boolean'; description?: string; default?: boolean };
type ArraySchema = {
  type: 'array';
  description?: string;
  items: StringSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
};
type PropertySchema = StringSchema | IntegerSchema | BooleanSchema | ArraySchema;

export interface ObjectSchema {
  type: 'object';
  properties: Record<string, PropertySchema>;
  required?: string[];
  additionalProperties: false;
}

type Args = Record<string, unknown>;

/** Erro previsto de uma ferramenta: vira um resultado com `isError` e esta mensagem. */
export class ToolError extends Error {}

/** Confere os argumentos contra o esquema; devolve a lista de problemas (vazia = válido). */
export function checkArgs(schema: ObjectSchema, args: Args): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(args))
    if (!Object.hasOwn(schema.properties, key))
      problems.push(
        `unknown argument ${tick(key, 60)} (accepted: ${Object.keys(schema.properties).join(', ') || 'none'})`,
      );
  for (const key of schema.required ?? [])
    if (args[key] === undefined) problems.push(`\`${key}\` is required`);
  for (const [key, spec] of Object.entries(schema.properties)) {
    const value = args[key];
    if (value === undefined) continue;
    const problem = checkValue(spec, value);
    if (problem) problems.push(`\`${key}\` ${problem}`);
  }
  return problems;
}

function checkValue(spec: PropertySchema, value: unknown): string | undefined {
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') return `must be a string`;
      if (spec.minLength !== undefined && value.length < spec.minLength)
        return spec.minLength === 1 ? 'must not be empty' : `is too short`;
      if (spec.maxLength !== undefined && value.length > spec.maxLength)
        return `is too long (max ${spec.maxLength} characters)`;
      if (spec.enum && !spec.enum.includes(value))
        return `must be one of: ${spec.enum.join(', ')} (got ${tick(JSON.stringify(clip(value, 40)))})`;
      return undefined;
    }
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value))
        return `must be an integer between ${spec.minimum} and ${spec.maximum}`;
      if (value < spec.minimum || value > spec.maximum)
        return `must be between ${spec.minimum} and ${spec.maximum} (got ${value})`;
      return undefined;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'must be true or false';
    case 'array': {
      if (!Array.isArray(value)) return 'must be an array';
      if (spec.minItems !== undefined && value.length < spec.minItems)
        return `needs at least ${spec.minItems} item(s)`;
      if (spec.maxItems !== undefined && value.length > spec.maxItems)
        return `accepts at most ${spec.maxItems} items`;
      for (const item of value) {
        const problem = checkValue(spec.items, item);
        if (problem) return `has an invalid item: each item ${problem}`;
      }
      if (spec.uniqueItems && new Set(value).size !== value.length) return 'must not repeat items';
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// contexto e definição

export interface ToolContext {
  snapshot: Snapshot;
  /** `rastro mcp --trust-git-config`: libera o git em repositórios com comandos no .git/config. */
  trustGitConfig: boolean;
  /** Observação de arquivos: `live`, `polling` ou `off` (`--no-watch`). */
  watchMode: 'live' | 'polling' | 'off';
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: ObjectSchema;
  run(args: Args, ctx: ToolContext): string;
}

// ---------------------------------------------------------------------------
// formatação

/** Limite do texto devolvido (clientes guardam em arquivo respostas acima de ~50 mil caracteres). */
const MAX_OUTPUT = 40_000;
const MAX_SOURCE_LINES = 120;
/** Linha de código mais longa mostrada (arquivos minificados têm linhas de centenas de KB). */
const MAX_SOURCE_LINE = 400;
const TOP = 10;

const clip = (s: string, max = 120) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * Caracteres de controle (C0, DEL, C1, que inclui U+0085) e os separadores U+2028/U+2029: num
 * nome de arquivo ou num texto do projeto, quebrariam a linha da resposta e deixariam o projeto
 * escrever Markdown (títulos, instruções falsas) no que o agente lê.
 */
// eslint-disable-next-line no-control-regex -- é exatamente o que queremos escapar
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// eslint-disable-next-line no-control-regex -- no código-fonte (em bloco cercado), o tab fica
const UNSAFE_IN_CODE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/g;
const ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const escapeChar = (c: string) =>
  ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** Texto do projeto numa linha só: controles e separadores viram escapes visíveis (`\n`, `\u2028`). */
export const plain = (s: string) => s.replace(UNSAFE, escapeChar);

/** O inverso de `plain` (para aceitar de volta um id ou caminho escrito com escapes). */
function unescapeText(s: string): string {
  return s.replace(/\\(n|r|t|u[0-9a-fA-F]{4})/g, (_, e: string) =>
    e === 'n'
      ? '\n'
      : e === 'r'
        ? '\r'
        : e === 't'
          ? '\t'
          : String.fromCharCode(parseInt(e.slice(1), 16)),
  );
}

/** Texto do projeto (nomes, caminhos, código) em código inline, numa linha, sem Markdown solto. */
const tick = (s: string, max = 120) => mdCode(clip(plain(s), max));
/** Um id inteiro (sem cortar), para ser passado de volta como alvo. */
const idText = (id: string) => mdCode(plain(id));
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

const REASONS: Record<UnresolvedReason, string> = {
  'module-not-found': 'the imported file was not found in the project',
  'undeclared-package':
    'looks like a package, but it is not in package.json or node_modules (or an unresolved alias)',
  'symbol-not-found': 'no known declaration for this name in the analyzed code',
  'indirect-call':
    'call through a variable, parameter or interface: the real target is only known at runtime',
  'dynamic-import': 'the module path is computed at runtime',
  'unknown-base-class': 'the base class could not be located',
  'not-analyzed': 'the target is in a project file left out of the analysis',
};

const VERBS: Record<EdgeKind, string> = {
  calls: 'calls',
  imports: 'imports',
  exports: 'exports',
  extends: 'extends',
  depends_on: 'depends on',
  contains: 'contains',
};

/** O que não vira entidade no Rastro (para explicar buscas sem resultado). */
const NOT_MODELED =
  'Rastro models top-level functions (including `const f = () => …`), classes, class members with a body (methods, constructors, getters/setters, arrow-function properties), files, folders, HTTP routes and packages. NOT entities: interfaces, type aliases, enums, plain variables/constants, functions declared inside other functions, object-literal methods, abstract methods and overload signatures (no body). For those, use grep or the enclosing entity (`path:line`).';

/** Nome exibido: `Classe.metodo`, `GET /x`, caminho do arquivo ou da pasta. */
function nameOf(n: GraphNode): string {
  if (n.kind === 'module')
    return !n.qualifiedName || n.qualifiedName === '.' ? '(project root)' : `${n.qualifiedName}/`;
  if (n.kind === 'file') return n.qualifiedName ?? n.name;
  if (n.kind === 'route' || n.kind === 'package' || n.kind === 'unresolved') return n.name;
  return n.qualifiedName ?? n.name;
}

function kindOf(n: GraphNode): string {
  if (n.kind === 'method' && n.meta?.memberKind && n.meta.memberKind !== 'method')
    return n.meta.memberKind;
  if (n.kind === 'unresolved') return 'unresolved reference';
  if (n.kind === 'package' && n.meta?.builtin) return 'Node.js built-in module';
  return NODE_KIND_LABELS_EN[n.kind].toLowerCase();
}

/** `arquivo:linha` (em código) de onde a entidade começa; vazio para arquivos, pastas e pacotes. */
function whereOf(n: GraphNode): string {
  if (n.kind === 'file' || n.kind === 'module' || n.kind === 'package') return '';
  return n.location ? tick(`${n.location.file}:${n.location.startLine}`, 300) : '';
}

/** `` `Classe.metodo` method · `src/a.ts:12` `` */
function describe(n: GraphNode): string {
  const where = whereOf(n);
  return `${tick(nameOf(n))} ${kindOf(n)}${where ? ` · ${where}` : ''}`;
}

/** Detalhes da relação que mudam a leitura (new, JSX, handler de rota, import de tipo...). */
function qualifier(e: GraphEdge): string {
  const notes: string[] = [];
  const callKind = e.meta?.callKind;
  if (callKind === 'new') notes.push('new');
  else if (callKind === 'jsx') notes.push('JSX');
  else if (callKind === 'route-handler') notes.push('route handler');
  const importKind = e.meta?.importKind;
  if (importKind === 'dynamic') notes.push('dynamic import');
  else if (importKind === 'require') notes.push('require');
  else if (importKind === 're-export') notes.push('re-export');
  if (e.meta?.typeOnly) notes.push('type-only: compile time only');
  if (e.meta?.viaDeclaration) notes.push('via .d.ts');
  return notes.length ? ` (${notes.join(', ')})` : '';
}

/** Evidência: `` `src/a.ts:8` `linha de código` `` (+ quantos outros lugares). */
function evidenceOf(e: GraphEdge): string {
  const first = e.evidence[0];
  if (!first) return '';
  const snippet = first.snippet ? ` ${tick(first.snippet, 140)}` : '';
  const total = Math.max(e.meta?.count ?? 0, e.evidence.length);
  const more = total > 1 ? ` (+${total - 1} more ${total - 1 === 1 ? 'site' : 'sites'})` : '';
  return `${tick(`${first.file}:${first.line}`, 300)}${snippet}${more}`;
}

// ---- saída com orçamento

interface ListOptions {
  limit: number;
  /** Primeiro item mostrado (paginação). */
  offset?: number;
  /** A ferramenta aceita `offset` para esta lista. */
  pageable?: boolean;
  /** Maior `limit` aceito (para não sugerir aumentar o que já está no máximo). */
  maxLimit?: number;
  /** Como ver o resto quando não há paginação (ex.: "use rastro_references"). */
  hint?: string;
}

interface ListBlock extends ListOptions {
  /** Itens da página, já formatados (cada um pode ter mais de uma linha, mas nunca é partido). */
  items: string[];
  total: number;
}

/**
 * Resposta montada em blocos: linhas e listas. Se passar do limite, cada lista mostra menos
 * itens (o mesmo máximo para todas, o maior que cabe), sempre itens inteiros e com a linha
 * "N shown of M" dizendo como pedir o resto: nenhuma seção some e nada é cortado no meio.
 */
class Out {
  private readonly blocks: Array<string | ListBlock> = [];

  push(...lines: string[]): this {
    this.blocks.push(...lines);
    return this;
  }

  section(title: string): this {
    if (this.blocks.length) this.blocks.push('');
    this.blocks.push(`## ${title}`);
    return this;
  }

  list<T>(items: readonly T[], render: (item: T) => string, options: ListOptions): this {
    const offset = options.offset ?? 0;
    this.blocks.push({
      ...options,
      offset,
      items: items.slice(offset, offset + options.limit).map((item) => `- ${render(item)}`),
      total: items.length,
    });
    return this;
  }

  private render(cap: number): string[] {
    const lines: string[] = [];
    for (const block of this.blocks) {
      if (typeof block === 'string') {
        lines.push(block);
        continue;
      }
      const offset = block.offset ?? 0;
      if (offset && offset >= block.total && block.total) {
        lines.push(`- (\`offset: ${offset}\` is past the end: ${plural(block.total, 'item')})`);
        continue;
      }
      const shown = Math.min(block.items.length, cap);
      lines.push(...block.items.slice(0, shown));
      const end = offset + shown;
      if (end >= block.total) continue;
      const range = offset ? `items ${offset + 1}-${end}` : `${shown}`;
      const how: string[] = [];
      if (shown < block.items.length) {
        // cortado pelo tamanho da resposta
        how.push(
          block.pageable
            ? `response size limit: continue with \`offset: ${end}\``
            : `response size limit: ${block.hint ?? 'narrow the query'}`,
        );
      } else {
        if (block.pageable) how.push(`\`offset: ${end}\` for the next page`);
        if (block.maxLimit && block.limit < block.maxLimit)
          how.push(`raise \`limit\` (max ${block.maxLimit})`);
        if (!how.length && block.hint) how.push(block.hint);
      }
      lines.push(
        `- … ${block.total - end} more (${range} shown of ${block.total}${how.length ? `; ${how.join(' or ')}` : ''})`,
      );
    }
    return lines;
  }

  toString(): string {
    const fits = (cap: number) => this.render(cap).join('\n');
    const full = fits(Infinity);
    if (full.length <= MAX_OUTPUT) return full;
    // o maior número de itens por lista que cabe (busca binária)
    const most = Math.max(
      0,
      ...this.blocks.map((b) => (typeof b === 'string' ? 0 : b.items.length)),
    );
    let low = 0;
    let high = most;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (fits(mid).length <= MAX_OUTPUT) low = mid;
      else high = mid - 1;
    }
    const text = fits(low);
    if (text.length <= MAX_OUTPUT) return text;
    // só texto fixo grande demais (não acontece com as ferramentas atuais): corta numa linha
    const cut = text.lastIndexOf('\n', MAX_OUTPUT - 200);
    return `${text.slice(0, cut > 0 ? cut : MAX_OUTPUT - 200)}\n… output truncated at ${MAX_OUTPUT} characters (narrow the query)`;
  }
}

/** Numa lista em linha cortada: `` (5 shown of 9; dica)``; vazio se coube inteira. */
const shownOf = (shown: number, total: number, hint?: string) =>
  total > shown ? ` (${shown} shown of ${total}${hint ? `; ${hint}` : ''})` : '';

/** Opções de lista com paginação (`limit` e `offset` da ferramenta). */
const paged = (args: Args, fallback: number, maxLimit: number): ListOptions => ({
  limit: num(args, 'limit', fallback),
  offset: num(args, 'offset', 0),
  pageable: true,
  maxLimit,
});

// ---------------------------------------------------------------------------
// resolução de nomes

const SYMBOLS = new Set<NodeKind>(['function', 'class', 'method', 'route']);

/** Caminho como o grafo usa: relativo à raiz, com `/`, sem `./` nem `/` no fim. */
function normalizePath(raw: string, root: string): string {
  let p = raw.replace(/\\(?![nrt]|u[0-9a-fA-F]{4})/g, '/');
  const rootPosix = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (p === rootPosix) return '.';
  if (p.startsWith(`${rootPosix}/`)) p = p.slice(rootPosix.length + 1);
  p = p.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return p || '.';
}

/** Extensão escrita num import ESM (`./a.js`) → extensões do código-fonte que o TypeScript aceita no lugar. */
const SOURCE_FOR: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.jsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/** O arquivo do caminho, aceitando o especificador ESM (`src/a.js` para `src/a.ts`). */
function fileAt(index: GraphIndex, p: string): GraphNode | undefined {
  const exact = index.node(`file:${p}`);
  if (exact) return exact;
  const ext = /\.[cm]?jsx?$/.exec(p)?.[0];
  if (!ext) return undefined;
  for (const source of SOURCE_FOR[ext] ?? []) {
    const found = index.node(`file:${p.slice(0, -ext.length)}${source}`);
    if (found) return found;
  }
  return undefined;
}

/** A entidade mais interna que contém as linhas `[first, last]` (ou o próprio arquivo). */
function entityAtLines(index: GraphIndex, file: GraphNode, first: number, last = first): GraphNode {
  let best: GraphNode | undefined;
  for (const n of index.descendants(file.id)) {
    const loc = n.location;
    if (!SYMBOLS.has(n.kind) || !loc || first < loc.startLine || last > loc.endLine) continue;
    const span = loc.endLine - loc.startLine;
    const bestSpan = best ? best.location!.endLine - best.location!.startLine : Infinity;
    if (span < bestSpan || (span === bestSpan && compareStrings(n.id, best!.id) < 0)) best = n;
  }
  return best ?? file;
}

/** Distância de edição (Levenshtein), parando cedo acima de `max` (devolve `max + 1`). */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      best = Math.min(best, current[j]!);
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length]!;
}

const looksLikePath = (q: string) => q.includes('/') || /\.[cm]?[jt]sx?$/.test(q);

/**
 * Arquivos e pastas parecidos com um caminho, do mais parecido ao menos: o nome do arquivo
 * (sem extensão) igual ou a poucas letras de distância pesa mais; partes do caminho em comum
 * contam pelo quanto são raras no projeto (`src` e `ts` aparecem em todo lugar e não dizem nada).
 */
function similarPaths(index: GraphIndex, query: string): GraphNode[] {
  const parts = (p: string) => [
    ...new Set(
      p
        .toLowerCase()
        .split(/[/._-]+/)
        .filter(Boolean),
    ),
  ];
  const stem = (p: string) =>
    (p.toLowerCase().replace(/\/+$/, '').split('/').pop() ?? '').replace(/\.[^.]*$/, '');
  const candidates = [...index.nodes.values()].filter(
    (n) => (n.kind === 'file' || n.kind === 'module') && (n.qualifiedName ?? '.') !== '.',
  );
  const frequency = new Map<string, number>();
  for (const n of candidates)
    for (const part of parts(n.qualifiedName ?? n.name))
      frequency.set(part, (frequency.get(part) ?? 0) + 1);
  const wantedParts = parts(query);
  const wantedStem = stem(query);
  const scored: Array<{ node: GraphNode; score: number }> = [];
  for (const n of candidates) {
    const p = n.qualifiedName ?? n.name;
    const own = new Set(parts(p));
    let score = 0;
    for (const part of wantedParts)
      if (own.has(part)) score += Math.log(candidates.length / (frequency.get(part) ?? 1));
    const d = wantedStem ? editDistance(wantedStem, stem(p), 2) : 3;
    if (d === 0) score += 6;
    else if (d <= 2) score += 4 - d;
    if (score > 0) scored.push({ node: n, score });
  }
  scored.sort((a, b) => b.score - a.score || compareStrings(a.node.id, b.node.id));
  const best = scored[0]?.score ?? 0;
  return scored
    .filter((x) => x.score >= best / 2)
    .slice(0, 8)
    .map((x) => x.node);
}

/** Quando nada foi encontrado: o que tentar (busca aproximada) e o que o Rastro não modela. */
function notFound(index: GraphIndex, query: string): ToolError {
  const out = new Out().push(`No entity matches ${tick(query)}.`);
  // `Classe.metodo` abstrato: existe, mas sem corpo (não é entidade)
  const member = /^([\w$]+)\.([\w$]+)$/.exec(query);
  if (member) {
    const [, className, method] = member as unknown as [string, string, string];
    for (const cls of index.nodes.values()) {
      if (cls.kind !== 'class' || cls.name !== className) continue;
      if (!cls.meta?.abstractMembers?.includes(method)) continue;
      const implementations = [...index.nodes.values()].filter(
        (n) =>
          n.kind === 'method' &&
          n.name === method &&
          !!n.parent &&
          inheritsFrom(index, n.parent, cls.id),
      );
      out.push(
        `${tick(`${className}.${method}`)} is an abstract method of ${describe(cls)}: it has no body, so it is not an entity. Calls to it are unresolved, with the implementations as POSSIBLE targets.`,
      );
      if (implementations.length) {
        out.push('Implementations in subclasses:');
        out.list(implementations, (n) => `${describe(n)} · id ${idText(n.id)}`, {
          limit: 10,
          hint: 'use rastro_search',
        });
      }
      return new ToolError(out.toString());
    }
  }
  const seen = new Set<string>();
  const close = looksLikePath(query)
    ? similarPaths(index, query)
    : (() => {
        const words = query.split(/[\s#:/.]+/).filter((w) => w.length > 1);
        return [query, ...words.reverse()]
          .flatMap((q) => index.search(q, 8).map((r) => r.node))
          .filter((n) => n.kind !== 'unresolved' && !seen.has(n.id) && seen.add(n.id))
          .slice(0, 8);
      })();
  if (!close.length) {
    // erro de digitação: nomes a poucas letras de distância
    const wanted = query.toLowerCase();
    const max = Math.min(3, Math.max(1, Math.round(wanted.length / 4)));
    const scored: Array<{ node: GraphNode; d: number }> = [];
    for (const n of index.nodes.values()) {
      if (n.kind === 'unresolved' || n.kind === 'module') continue;
      const names = [n.name, n.qualifiedName ?? ''].map((x) => x.toLowerCase());
      const d = Math.min(...names.map((x) => editDistance(wanted, x, max)));
      if (d <= max) scored.push({ node: n, d });
    }
    scored.sort((a, b) => a.d - b.d || compareStrings(a.node.id, b.node.id));
    close.push(...scored.slice(0, 8).map((x) => x.node));
  }
  if (close.length) {
    out.push('Close matches:');
    out.list(close, (n) => `${describe(n)} · id ${idText(n.id)}`, { limit: 8 });
  }
  out.push(
    '',
    'A target can be an id (`fn:src/a.ts#name`), a name or qualified name (`Class.method`), a file path relative to the project root (`src/a.ts`, or the `.js` specifier of a `.ts` file), a folder (`src/lib`), `path:line`, `path:line:column` or `path:start-end`. Use rastro_search to explore.',
    '',
    NOT_MODELED,
  );
  return new ToolError(out.toString());
}

/** A classe `id` estende `base` (direta ou indiretamente, por herança comprovada)? */
function inheritsFrom(index: GraphIndex, id: string, base: string): boolean {
  const seen = new Set<string>();
  let level = [id];
  while (level.length) {
    const next: string[] = [];
    for (const cls of level)
      for (const e of index.outgoing(cls, ['extends'])) {
        if (e.resolution !== 'resolved' || seen.has(e.target)) continue;
        if (e.target === base) return true;
        seen.add(e.target);
        next.push(e.target);
      }
    level = next;
  }
  return false;
}

/** Arquivo:linha fora do arquivo: erro claro em vez de devolver o arquivo inteiro. */
function checkLines(file: GraphNode, first: number, last: number): void {
  const lines = file.meta?.lines ?? file.location?.endLine;
  const name = tick(nameOf(file), 300);
  if (first < 1) throw new ToolError(`Line ${first} does not exist: lines start at 1 (${name}).`);
  if (last < first)
    throw new ToolError(
      `Invalid line range ${first}-${last} in ${name}: the end comes before the start.`,
    );
  if (lines !== undefined && last > lines)
    throw new ToolError(`Line ${last} is out of range: ${name} has ${plural(lines, 'line')}.`);
}

/**
 * Encontra a entidade pedida: id, `arquivo:linha` (também `:linha:coluna` e `:início-fim`),
 * caminho de arquivo (também o especificador `.js` de um `.ts`) ou pasta, sufixo de id
 * (`src/a.ts#nome`, com `./` ou caminho absoluto), nome qualificado ou nome (com e sem
 * diferenciar maiúsculas; entre crases ou com `()` também). Se mais de uma combina, lista os
 * candidatos e pede um id; se nenhuma, sugere nomes parecidos.
 */
export function resolveTarget(snapshot: Snapshot, raw: string): GraphNode {
  const { index } = snapshot;
  let query = raw.trim();
  // `sum`, `` `sum` ``: as crases do Markdown não fazem parte do nome
  if (/^`+[^`]+`+$/.test(query)) query = query.replace(/^`+|`+$/g, '').trim();
  if (!query) throw new ToolError('The target is empty.');
  const found = lookup(snapshot, query);
  if (found) return found;
  // id ou caminho escrito com escapes (`\n`) como as respostas mostram
  const unescaped = unescapeText(query);
  if (unescaped !== query) {
    const again = lookup(snapshot, unescaped);
    if (again) return again;
  }
  throw notFound(index, query);
}

function lookup(snapshot: Snapshot, input: string): GraphNode | undefined {
  const { index } = snapshot;
  const exact = index.node(input);
  if (exact) return exact;
  // `sum()`, `Classe.metodo(a, b)`: os parênteses da chamada não fazem parte do nome
  const call = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(.*\)$/s.exec(input);
  const query = call ? call[1]! : input;

  const p = normalizePath(query, snapshot.graph.project.root);
  const atLine = /^(.+?):(\d+)(?:-(\d+)|:(\d+))?$/.exec(p);
  if (atLine) {
    const file = fileAt(index, atLine[1]!);
    if (file) {
      const first = Number(atLine[2]);
      const last = atLine[3] ? Number(atLine[3]) : first;
      checkLines(file, first, last);
      return entityAtLines(index, file, first, last);
    }
  }
  const pathMatch = fileAt(index, p) ?? index.node(`module:${p}`);
  if (pathMatch) return pathMatch;

  const all = [...index.nodes.values()];
  const pick = (matches: GraphNode[]): GraphNode | undefined => {
    if (!matches.length) return undefined;
    // um nome que também é uma referência não resolvida: a entidade real vem primeiro
    const real = matches.filter((n) => n.kind !== 'unresolved');
    const list = (real.length ? real : matches).sort((a, b) => compareStrings(a.id, b.id));
    if (list.length === 1) return list[0];
    const out = new Out().push(
      `${tick(query)} is ambiguous: ${plural(list.length, 'entity', 'entities')} match. Retry with one of these ids (or a \`path:line\`):`,
    );
    out.list(list, (n) => `${idText(n.id)} — ${describe(n)}`, {
      limit: 20,
      hint: 'narrow the name',
    });
    throw new ToolError(out.toString());
  };

  const hash = p.indexOf('#');
  if (hash > 0) {
    // `src/a.ts#nome` (também `./src/a.ts#nome`, o caminho absoluto ou `src/a.js#nome`)
    const file = fileAt(index, p.slice(0, hash));
    const suffix = `${file ? (file.qualifiedName ?? file.name) : p.slice(0, hash)}${p.slice(hash)}`;
    const found = pick(all.filter((n) => n.id.slice(n.id.indexOf(':') + 1) === suffix));
    if (found) return found;
  }
  const byName = (same: (a: string, b: string) => boolean, includeUnresolved: boolean) =>
    all.filter(
      (n) =>
        n.kind !== 'module' &&
        (includeUnresolved || n.kind !== 'unresolved') &&
        (same(n.qualifiedName ?? '', query) ||
          same(n.name, query) ||
          (n.kind === 'route' && same(routeLabel(n), query))),
    );
  // sem diferenciar maiúsculas, só entidades reais: `Animal.sound` não pode virar a chamada
  // `animal.sound` (uma referência não resolvida qualquer)
  return (
    pick(byName((a, b) => a === b, true)) ??
    pick(byName((a, b) => a.toLowerCase() === b.toLowerCase(), false))
  );
}

// ---------------------------------------------------------------------------
// relações

interface Reached {
  node: GraphNode;
  depth: number;
  edge: GraphEdge;
  /** Observação da relação (ex.: o `new` de uma subclasse que roda este construtor). */
  note?: string;
}

interface Neighborhood {
  proven: Reached[];
  external: Reached[];
  /** Relações não resolvidas (só a partir da própria entidade). */
  unresolved: Reached[];
}

/**
 * Relações que chegam num nó. Para um construtor, também os `new` comprovados da classe e de
 * subclasses sem construtor próprio (que rodam este construtor).
 */
function incomingOf(index: GraphIndex, id: string, kinds: readonly EdgeKind[]): GraphEdge[] {
  const edges = index.incoming(id, kinds);
  return kinds.includes('calls') ? [...edges, ...index.constructionSites(id)] : edges;
}

/**
 * Relações a partir da entidade, num sentido, até `depth` passos. No primeiro passo entram
 * todas (comprovadas, externas e não resolvidas); a partir do segundo, só as comprovadas
 * (uma cadeia só é prova se todos os passos forem).
 */
function walk(
  index: GraphIndex,
  start: GraphNode,
  direction: 'in' | 'out',
  kinds: readonly EdgeKind[],
  depth: number,
): Neighborhood {
  const result: Neighborhood = { proven: [], external: [], unresolved: [] };
  const visited = new Set([start.id]);
  let frontier = [start.id];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const edges = direction === 'in' ? incomingOf(index, id, kinds) : index.outgoing(id, kinds);
      const other = (e: GraphEdge) => (direction === 'in' ? e.source : e.target);
      for (const edge of [...edges].sort((a, b) => compareStrings(other(a), other(b)))) {
        const node = index.node(other(edge));
        if (!node) continue;
        if (edge.resolution === 'resolved') {
          if (visited.has(node.id)) continue;
          visited.add(node.id);
          const owner = index.node(id)?.parent;
          const inherited =
            direction === 'in' &&
            edge.target !== id &&
            edge.meta?.callKind === 'new' &&
            edge.target !== owner;
          result.proven.push({
            node,
            depth: d,
            edge,
            ...(inherited
              ? {
                  note: `${tick(nameOf(index.node(edge.target) ?? node))} has no constructor of its own: \`new\` runs this inherited one`,
                }
              : {}),
          });
          next.push(node.id);
        } else if (d === 1) {
          (edge.resolution === 'external' ? result.external : result.unresolved).push({
            node,
            depth: d,
            edge,
          });
        }
      }
    }
    frontier = next;
  }
  return result;
}

/** Quem talvez chame a entidade: por interface/método abstrato ou por sobrescrita (despacho). */
interface PossibleCaller {
  caller: GraphNode;
  edge: GraphEdge;
  /** Como a chamada pode chegar aqui (já formatado). */
  how: string;
  /** A entidade que talvez seja chamada. */
  target: string;
}

function possibleCallers(index: GraphIndex, id: string): PossibleCaller[] {
  const found: PossibleCaller[] = [];
  for (const via of index.possibleCallSites(id))
    for (const edge of index.incoming(via.id, ['calls'])) {
      const caller = index.node(edge.source);
      if (caller)
        found.push({
          caller,
          edge,
          how: `via ${tick(via.meta?.reference ?? via.name)} (1 of ${via.meta?.candidates?.length ?? '?'} possible implementations)`,
          target: id,
        });
    }
  const self = index.node(id);
  const owner = self?.parent ? index.node(self.parent) : undefined;
  for (const { edge, base } of index.dispatchCalls(id)) {
    const caller = index.node(edge.source);
    if (caller)
      found.push({
        caller,
        edge,
        how: `via ${tick(nameOf(base))} (overridden here: runs this method when the object is ${owner ? `a ${tick(nameOf(owner))}` : 'of this class'})`,
        target: id,
      });
  }
  return found.sort(
    (a, b) => compareStrings(a.caller.id, b.caller.id) || compareStrings(a.edge.id, b.edge.id),
  );
}

/** Linha de uma relação a partir da entidade: quem fica do outro lado e a evidência. */
function relationLine(
  index: GraphIndex,
  r: Reached,
  direction: 'in' | 'out',
  showDepth: boolean,
): string {
  const depth = showDepth ? `[d${r.depth}] ` : '';
  const verb = `${VERBS[r.edge.kind]}${qualifier(r.edge)}`;
  const evidence = evidenceOf(r.edge);
  const tail = `${evidence ? ` — ${evidence}` : ''}${r.note ? ` (${r.note})` : ''}`;
  if (direction === 'in') {
    const target = index.node(r.edge.target);
    return `${depth}${describe(r.node)} ${verb} ${tick(target ? nameOf(target) : r.edge.target)}${tail}`;
  }
  const source = index.node(r.edge.source);
  return `${depth}${tick(source ? nameOf(source) : r.edge.source)} ${verb} ${describe(r.node)}${tail}`;
}

/** Uma referência não resolvida: o texto, o motivo e os alvos possíveis (um item, nunca partido). */
function unresolvedLine(index: GraphIndex, r: Reached): string {
  const target = r.node;
  const reason = target.meta?.reason ? REASONS[target.meta.reason] : 'target not resolved';
  const candidates = (target.meta?.candidates ?? [])
    .map((id) => index.node(id))
    .filter((n): n is GraphNode => !!n);
  const evidence = evidenceOf(r.edge);
  let line = `${VERBS[r.edge.kind]}${qualifier(r.edge)} ${tick(target.meta?.reference ?? target.name)} — unresolved: ${reason}${evidence ? ` — ${evidence}` : ''}`;
  if (candidates.length)
    line += `\n  possible targets (${candidates.length}, runtime decides): ${candidates
      .slice(0, 6)
      .map(describe)
      .join('; ')}${candidates.length > 6 ? `; … ${candidates.length - 6} more` : ''}`;
  return line;
}

function externalLine(r: Reached, direction: 'in' | 'out', index: GraphIndex): string {
  const verb = `${VERBS[r.edge.kind]}${qualifier(r.edge)}`;
  const evidence = evidenceOf(r.edge);
  if (direction === 'in') return `${describe(r.node)} ${verb} it — ${evidence}`;
  const source = index.node(r.edge.source);
  return `${tick(source ? nameOf(source) : r.edge.source)} ${verb} ${describe(r.node)}${evidence ? ` — ${evidence}` : ''}`;
}

const possibleLine = (p: PossibleCaller) =>
  `${describe(p.caller)} may call it ${p.how} — ${evidenceOf(p.edge)}`;

// ---------------------------------------------------------------------------
// rotas

function routeLabel(n: GraphNode): string {
  const m = n.meta ?? {};
  return `${m.httpMethod ?? '?'} ${m.fullPath ?? m.routePath ?? n.name}`;
}

/** Caminho completo, ou por que ele não é conhecido. */
function routePathNote(n: GraphNode): string {
  const m = n.meta ?? {};
  if (m.fullPath) return '';
  if (m.mountedAt?.length)
    return `full path unknown: router mounted at ${m.mountedAt.map((p) => tick(p)).join(', ')} (path in code ${tick(m.routePath ?? '')})`;
  return 'full path unknown (no proven mount prefix; path as written in code)';
}

/**
 * Handlers da rota: funções ligadas pelo framework, o handler inline (e o que ele chama) ou,
 * quando nenhum dos dois, que o handler não foi identificado (nunca "inline" sem saber).
 */
function routeHandler(index: GraphIndex, n: GraphNode): string {
  const out = index.outgoing(n.id, ['calls']);
  const handlers = out.filter((e) => e.meta?.callKind === 'route-handler');
  if (handlers.length)
    return handlers
      .map((e) => {
        const target = index.node(e.target);
        if (!target) return tick(e.target);
        return target.kind === 'unresolved'
          ? `${tick(target.meta?.reference ?? target.name)} (unresolved: ${target.meta?.reason ? REASONS[target.meta.reason] : 'not found'})`
          : describe(target);
      })
      .join(', ');
  const calls = out
    .map((e) => index.node(e.target))
    .filter((t): t is GraphNode => !!t && t.kind !== 'unresolved');
  const callList = calls
    .slice(0, 4)
    .map((t) => tick(nameOf(t)))
    .join(', ');
  const more = calls.length > 4 ? ', …' : '';
  if (n.meta?.inlineHandler)
    return calls.length ? `inline function (calls ${callList}${more})` : 'inline function';
  return calls.length
    ? `handler not identified (code attributed to the route calls ${callList}${more})`
    : 'handler not identified (not a function Rastro can follow statically, e.g. a value returned by a library call)';
}

// ---------------------------------------------------------------------------
// git (só leitura de arquivos, sem rodar o git)

/** Branch atual lendo `.git/HEAD` (sobe pastas; segue o `gitdir:` de worktrees e submódulos). */
export function gitBranch(root: string): string | undefined {
  const read = (file: string) => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 4096) throw new Error('not a small regular file');
    return fs.readFileSync(file, 'utf8').trim();
  };
  try {
    for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
      const dotGit = path.join(dir, '.git');
      const stat = fs.lstatSync(dotGit, { throwIfNoEntry: false });
      if (stat) {
        let gitDir = dotGit;
        if (stat.isFile()) {
          const pointer = /^gitdir:\s*(.+)$/m.exec(read(dotGit))?.[1];
          if (!pointer) return undefined;
          gitDir = path.resolve(dir, pointer.trim());
        }
        const head = read(path.join(gitDir, 'HEAD'));
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
        if (ref) return ref;
        return /^[0-9a-f]{7,64}$/i.test(head) ? `detached at ${head.slice(0, 7)}` : undefined;
      }
      if (path.dirname(dir) === dir) return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Mensagens da CLI usadas dentro das ferramentas (erros do git) sempre em inglês. */
function inEnglish<T>(fn: () => T): T {
  const previous = getLang();
  setLang('en');
  try {
    return fn();
  } finally {
    setLang(previous);
  }
}

// ---------------------------------------------------------------------------
// análise parcial

/** Diagnósticos que deixam parte do projeto fora da análise. */
const PARTIAL_CODES = new Set([
  'max-files-reached',
  'file-too-large',
  'parse-failed',
  'unreadable-directory',
  'analysis-failed',
  'next-routes-skipped',
]);

/** Uma linha de aviso, em toda resposta, enquanto a análise está incompleta. */
export function partialNote(snapshot: Snapshot): string | undefined {
  const { graph } = snapshot;
  const count = (code: string) => graph.diagnostics.filter((d) => d.code === code).length;
  if (!graph.diagnostics.some((d) => PARTIAL_CODES.has(d.code))) return undefined;
  const parts: string[] = [];
  if (count('max-files-reached'))
    parts.push(
      `file limit reached (${graph.analyzer.options.maxFiles}): files beyond it were not analyzed`,
    );
  const skipped = count('file-too-large') + count('parse-failed');
  if (skipped) parts.push(`${plural(skipped, 'file')} skipped (too large or unreadable)`);
  if (count('unreadable-directory'))
    parts.push(`${plural(count('unreadable-directory'), 'folder')} could not be read`);
  if (count('analysis-failed'))
    parts.push(`${plural(count('analysis-failed'), 'analysis step')} failed`);
  if (count('next-routes-skipped')) parts.push('some Next.js routes were not detected');
  return `> ⚠ Partial analysis: ${parts.join('; ')}. Relationships with the code left out are missing (details in rastro_overview).`;
}

// ---------------------------------------------------------------------------
// ferramentas

const target = (description: string): StringSchema => ({
  type: 'string',
  minLength: 1,
  maxLength: 500,
  description,
});
const TARGET_HELP =
  'Entity: an id (`fn:src/a.ts#name`), a name or qualified name (`Class.method`), a file path relative to the project root (the `.js` specifier of a `.ts` file also works), a folder, `path:line`, `path:line:column` or `path:start-end`.';
const limit = (max: number, fallback: number): IntegerSchema => ({
  type: 'integer',
  minimum: 1,
  maximum: max,
  default: fallback,
  description: `Maximum items per list (default ${fallback}, max ${max}).`,
});
const offset = (what: string): IntegerSchema => ({
  type: 'integer',
  minimum: 0,
  maximum: 1_000_000,
  default: 0,
  description: `Skip this many items of ${what} (pagination; the answer says which offset comes next).`,
});
const num = (args: Args, key: string, fallback: number) =>
  typeof args[key] === 'number' ? (args[key] as number) : fallback;

// ---- overview

/** Relações por tipo e resolução (pares distintos; `meta.count` guarda as ocorrências). */
function relationshipCounts(index: GraphIndex) {
  const counts = new Map<
    EdgeKind,
    { resolved: number; external: number; unresolved: number; possible: number }
  >();
  for (const kind of EDGE_KINDS)
    counts.set(kind, { resolved: 0, external: 0, unresolved: 0, possible: 0 });
  for (const e of index.edges.values()) {
    const c = counts.get(e.kind)!;
    c[e.resolution]++;
    if (e.resolution === 'unresolved' && index.node(e.target)?.meta?.candidates?.length)
      c.possible++;
  }
  return counts;
}

function overview(_args: Args, ctx: ToolContext): string {
  const { graph, index } = ctx.snapshot;
  const s = graph.stats;
  const out = new Out().push(`# ${tick(graph.project.name, 80)} — Rastro code graph`);
  const skipped = graph.diagnostics.filter((d) =>
    ['file-too-large', 'parse-failed', 'symlink-skipped'].includes(d.code),
  );
  const limited = graph.diagnostics.some((d) => d.code === 'max-files-reached');
  out.push(
    `Files: ${s.files} analyzed${skipped.length ? ` · ${skipped.length} skipped (see diagnostics)` : ''}${limited ? ` · file limit reached (${graph.analyzer.options.maxFiles}): the rest of the project was NOT analyzed` : ''} · languages: ${graph.project.languages.join(', ') || 'none'}`,
  );
  const kinds = (['function', 'class', 'method', 'route', 'package', 'unresolved'] as const)
    .filter((k) => s.nodesByKind[k])
    .map((k) =>
      k === 'unresolved'
        ? plural(s.nodesByKind[k]!, 'unresolved reference')
        : k === 'package'
          ? plural(s.nodesByKind[k]!, 'external package')
          : k === 'class'
            ? plural(s.nodesByKind[k]!, 'class', 'classes')
            : plural(s.nodesByKind[k]!, k),
    );
  out.push(`Entities: ${kinds.join(' · ') || 'none'}`);
  const c = relationshipCounts(index);
  const calls = c.get('calls')!;
  const imports = c.get('imports')!;
  const ext = c.get('extends')!;
  out.push(
    'Relationships (distinct pairs; repeated occurrences are evidence of the same pair):',
    `- Calls: ${calls.resolved} proven · ${calls.unresolved} unresolved (${calls.possible} of them with POSSIBLE targets, e.g. interface calls)`,
    `- Imports: ${imports.resolved} proven (project files) · ${imports.external} to external packages · ${imports.unresolved} unresolved`,
    `- Inheritance (extends): ${ext.resolved} proven · ${ext.external} from external classes · ${ext.unresolved} unresolved`,
    `- Structural, not usage: ${c.get('exports')!.resolved} exports · ${c.get('depends_on')!.resolved} folder dependencies (depends_on, derived from imports)`,
  );
  const unknown = s.unknownReceiverCalls + s.computedCalls;
  if (unknown)
    out.push(
      `Not attributable statically: ${plural(unknown, 'call')} on receivers of unknown type or computed members (\`obj[x]()\`) — these never become relationships.`,
    );
  if (s.importCycles.length)
    out.push(
      `Import cycles: ${s.importCycles.length} (e.g. ${s.importCycles[0]!.slice(0, 4)
        .map((id) => tick(id.replace(/^file:/, '')))
        .join(' → ')}${s.importCycles[0]!.length > 4 ? ' → …' : ''})`,
    );

  // pastas com mais arquivos (até dois níveis)
  const filesIn = new Map<string, number>();
  for (const n of index.nodes.values()) {
    if (n.kind !== 'file' || n.meta?.analyzed === false) continue;
    const parts = (n.qualifiedName ?? n.name).split('/').slice(0, -1);
    for (let i = 1; i <= Math.min(2, parts.length); i++) {
      const dir = parts.slice(0, i).join('/');
      filesIn.set(dir, (filesIn.get(dir) ?? 0) + 1);
    }
  }
  const folders = [...filesIn.entries()]
    .sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))
    .slice(0, 8);
  if (folders.length)
    out.push(`Top folders: ${folders.map(([dir, n]) => `${tick(`${dir}/`)} (${n})`).join(' · ')}`);

  const routes = [...index.nodes.values()].filter((n) => n.kind === 'route');
  if (routes.length) {
    const frameworks = [...new Set(routes.map((n) => n.meta?.framework ?? '?'))].sort();
    out.push(
      `HTTP routes: ${routes.length} (${frameworks.map((f) => plain(f)).join(', ')}) — list them with rastro_routes`,
    );
  }

  const insights = ctx.snapshot.insights();
  out.section('Where to look first (proven relationships only)');
  if (insights.mostCalled.length)
    out.push(
      `Most called: ${insights.mostCalled
        .slice(0, 5)
        .map((x) => `${describe(x.node)} (${plural(x.value, 'caller')})`)
        .join('; ')}`,
    );
  if (insights.mostImported.length)
    out.push(
      `Central files (most imported): ${insights.mostImported
        .slice(0, 5)
        .map((x) => `${tick(nameOf(x.node))} (${plural(x.value, 'importer')})`)
        .join('; ')}`,
    );
  if (insights.mostCalling.length)
    out.push(
      `Orchestrators (call the most): ${insights.mostCalling
        .slice(0, 3)
        .map((x) => `${describe(x.node)} (${plural(x.value, 'callee')})`)
        .join('; ')}`,
    );
  const { internal, exported } = insights.unused;
  if (internal.length || exported.length) {
    out.push(
      `Possibly unused (no proven caller and the name appears only at its declaration; dynamic use is still possible): ${internal.length} internal, ${exported.length} exported (may be public API)`,
    );
    const hint = 'not listed here; find them with rastro_search or rastro_references';
    if (internal.length) out.push('Internal:');
    out.list(internal, describe, { limit: 5, hint });
    if (exported.length) out.push('Exported:');
    out.list(exported, describe, { limit: 3, hint });
  }
  if (!insights.mostCalled.length && !insights.mostImported.length)
    out.push('No proven calls or imports between project files yet.');

  const warnings = graph.diagnostics.filter((d) => d.level !== 'info');
  out.section('Analysis');
  out.push(
    `Diagnostics: ${plural(warnings.length, 'warning')}, ${graph.diagnostics.length - warnings.length} info`,
  );
  const diagLine = (d: (typeof graph.diagnostics)[number], max: number) =>
    `${d.file ? `${tick(`${d.file}${d.line ? `:${d.line}` : ''}`, 300)} — ` : ''}${plain(clip(diagnosticText(d, 'en'), max))}`;
  out.list(warnings, (d) => diagLine(d, 300), {
    limit: 5,
    hint: 'see the Rastro web UI or `rastro analyze`',
  });
  if (skipped.length && warnings.length <= 5) {
    // os ignorados de nível info (links simbólicos) também contam como fora da análise
    for (const d of skipped.filter((d) => d.level === 'info').slice(0, 3))
      out.push(`- ${diagLine(d, 200)}`);
  }
  const branch = gitBranch(graph.project.root);
  if (branch) out.push(`Git branch: ${tick(branch)}`);
  out.push('', freshness(ctx));
  return out.toString();
}

function freshness(ctx: ToolContext): string {
  const snap = ctx.snapshot;
  const ago = Math.max(0, Math.round((Date.now() - snap.finishedAt) / 1000));
  const watch =
    ctx.watchMode === 'off'
      ? 'not watching files (--no-watch): restart the server to see edits'
      : ctx.watchMode === 'live'
        ? 'watching files: edits are re-analyzed before the next answer'
        : 'watching files by polling: edits are re-analyzed before the next answer';
  return `_Analysis #${snap.sequence}: ${ago}s ago, took ${snap.wallMs} ms (TypeScript ${plain(snap.graph.analyzer.typescriptVersion)}) · ${watch} · Rastro ${RASTRO_VERSION}_`;
}

// ---- search

function search(args: Args, ctx: ToolContext): string {
  const { index } = ctx.snapshot;
  const query = String(args.query);
  const kind = args.kind as NodeKind | undefined;
  const results = index.search(query, Number.MAX_SAFE_INTEGER, kind ? new Set([kind]) : undefined);
  if (!results.length) {
    const out = new Out().push(
      `No ${kind ? `${kind} ` : ''}entity matches ${tick(query)}. Search covers names, qualified names (\`Class.method\`) and file paths, case-insensitively; it does not search code text (use grep for literals and comments).`,
    );
    if (looksLikePath(query)) {
      const close = similarPaths(index, query);
      if (close.length) {
        out.push('Similar paths:');
        out.list(close, (n) => `${describe(n)} · id ${idText(n.id)}`, { limit: 8 });
      }
    }
    out.push('', NOT_MODELED);
    return out.toString();
  }
  const out = new Out().push(
    `${plural(results.length, 'match', 'matches')} for ${tick(query)}${kind ? ` (kind: ${kind})` : ''}:`,
  );
  out.list(results, (r) => `${describe(r.node)} · id ${idText(r.node.id)}`, paged(args, 20, 100));
  return out.toString();
}

// ---- entity

function entity(args: Args, ctx: ToolContext): string {
  const { index } = ctx.snapshot;
  const node = resolveTarget(ctx.snapshot, String(args.target));
  const out = new Out().push(`# ${tick(nameOf(node))} — ${kindOf(node)}`, `id: ${idText(node.id)}`);
  const loc = node.location;
  if (loc && node.kind !== 'module')
    out.push(
      `Location: ${tick(`${loc.file}:${loc.startLine}${loc.endLine !== loc.startLine ? `-${loc.endLine}` : ''}`, 300)}`,
    );
  const chain = index
    .ancestors(node.id)
    .filter((a) => !(a.kind === 'module' && (a.qualifiedName ?? '.') === '.'))
    .reverse();
  if (chain.length)
    out.push(`Inside: ${chain.map((a) => `${tick(nameOf(a))} ${kindOf(a)}`).join(' › ')}`);

  const m = node.meta ?? {};
  const flags: string[] = [];
  if (m.exported !== undefined) flags.push(m.exported ? 'exported' : 'not exported');
  if (m.defaultExport) flags.push('default export');
  if (m.async) flags.push('async');
  if (m.static) flags.push('static');
  if (m.language) flags.push(`language ${m.language}`);
  if (m.mentions !== undefined)
    flags.push(`name appears ${plural(m.mentions, 'time')} in analyzed code`);
  if (flags.length) out.push(`Facts: ${flags.join(' · ')}`);
  const exportedAs = index
    .incoming(node.id, ['exports'])
    .filter((e) => e.resolution === 'resolved')
    .map(
      (e) =>
        `${tick(e.meta?.exportedAs ?? node.name)} by ${tick(index.node(e.source) ? nameOf(index.node(e.source)!) : e.source)}`,
    );
  if (exportedAs.length)
    out.push(`Exported as: ${exportedAs.slice(0, 5).join('; ')}${shownOf(5, exportedAs.length)}`);

  switch (node.kind) {
    case 'file':
      fileDetails(index, node, out);
      break;
    case 'module':
      moduleDetails(index, node, out);
      break;
    case 'package':
      packageDetails(index, node, out);
      break;
    case 'unresolved':
      unresolvedDetails(index, node, out);
      break;
    default:
      symbolDetails(index, node, out);
  }

  if (args.source === true) sourceSection(ctx.snapshot, node, out);
  out.push(
    '',
    '_Next: rastro_references for every relationship with evidence; rastro_impact for the transitive blast radius._',
  );
  return out.toString();
}

/** Lista curta de relações comprovadas (para o `entity`). */
function topRelations(
  index: GraphIndex,
  out: Out,
  title: string,
  reached: Reached[],
  direction: 'in' | 'out',
): void {
  if (!reached.length) return;
  out.section(`${title} (${reached.length})`);
  out.list(reached, (r) => relationLine(index, r, direction, false), {
    limit: TOP,
    hint: 'use rastro_references',
  });
}

function symbolDetails(index: GraphIndex, node: GraphNode, out: Out): void {
  const callKinds: EdgeKind[] = ['calls'];
  let usedOutside = 0;
  if (node.kind === 'route') {
    const m = node.meta ?? {};
    out.section('HTTP route');
    out.push(
      `${tick(routeLabel(node))} · framework ${plain(m.framework ?? 'unknown')}${m.routeKind ? ` · ${m.routeKind}` : ''}`,
    );
    const note = routePathNote(node);
    if (note) out.push(note);
    out.push(`Handler: ${routeHandler(index, node)}`);
  }
  if (node.kind === 'class') {
    const members = index.children(node.id).filter((c) => c.kind === 'method');
    const abstract = node.meta?.abstractMembers ?? [];
    if (members.length || abstract.length) {
      out.section(`Members (${members.length})`);
      out.list(
        members,
        (c) => `${tick(c.name)} ${kindOf(c)}${c.meta?.static ? ' (static)' : ''} · ${whereOf(c)}`,
        { limit: 25, hint: 'use rastro_search' },
      );
      if (abstract.length)
        out.push(
          `Abstract (no body, so not entities; calls to them are POSSIBLE calls to the implementations): ${abstract.map((a) => tick(a)).join(', ')}`,
        );
    }
    const ext = walk(index, node, 'out', ['extends'], 1);
    for (const r of ext.proven) out.push(`Extends: ${describe(r.node)} — ${evidenceOf(r.edge)}`);
    for (const r of [...ext.unresolved, ...ext.external])
      out.push(
        `Extends (not in the project or unresolved): ${tick(r.node.meta?.reference ?? r.node.name)}`,
      );
    if (node.meta?.implements?.length)
      out.push(
        `Implements (as written; interfaces are not graph nodes): ${node.meta.implements.map((i) => tick(i)).join(', ')}`,
      );
    const subclasses = walk(index, node, 'in', ['extends'], 1).proven;
    if (subclasses.length)
      out.push(
        `Extended by: ${subclasses
          .slice(0, TOP)
          .map((r) => describe(r.node))
          .join(
            '; ',
          )}${shownOf(TOP, subclasses.length, 'use rastro_references with kinds ["extends"]')}`,
      );
    // quem usa a classe de fora: `new`, chamadas aos membros
    const inside = new Set([node.id, ...index.descendants(node.id).map((d) => d.id)]);
    const users = new Set<string>();
    for (const id of inside)
      for (const e of index.incoming(id, ['calls']))
        if (e.resolution === 'resolved' && !inside.has(e.source)) users.add(e.source);
    out.push(
      `Used from outside the class: ${plural(users.size, 'distinct caller')} (instantiation or member calls; query a member for its own callers)`,
    );
    usedOutside = users.size;
  }
  const callers = walk(index, node, 'in', callKinds, 1);
  const callees = walk(index, node, 'out', callKinds, 1);
  const overridden = index.overriddenMethods(node.id);
  if (overridden.length) out.push(`Overrides: ${overridden.map((b) => describe(b)).join('; ')}`);
  topRelations(
    index,
    out,
    node.kind === 'class'
      ? 'Instantiated or called directly by (new, super) (proven)'
      : node.meta?.memberKind === 'constructor'
        ? 'Runs on (new of the class or of subclasses without a constructor, super) (proven)'
        : 'Called by (proven)',
    callers.proven,
    'in',
  );
  topRelations(index, out, 'Calls (proven)', callees.proven, 'out');
  const possible = possibleCallers(index, node.id);
  if (!callers.proven.length && !usedOutside && node.kind !== 'route')
    out.push(
      '',
      possible.length
        ? 'No proven callers; possible callers (through interfaces or overriding) are listed below. Dynamic or callback-based use cannot be ruled out.'
        : 'No proven callers. Dynamic or callback-based use cannot be ruled out.',
    );
  const unresolved = callees.unresolved;
  if (possible.length || unresolved.length) {
    out.section('Possible (unproven) relationships');
    out.list(
      possible,
      (p) => `may be called by ${describe(p.caller)} ${p.how} — ${evidenceOf(p.edge)}`,
      { limit: TOP, hint: 'use rastro_references' },
    );
    out.list(unresolved, (r) => unresolvedLine(index, r), {
      limit: TOP,
      hint: 'use rastro_references',
    });
  }
}

function fileDetails(index: GraphIndex, node: GraphNode, out: Out): void {
  const m = node.meta ?? {};
  if (m.analyzed === false) {
    out.push(
      'Not analyzed: referenced by an import, but it is not JS/TS code that Rastro reads (e.g. CSS or JSON).',
    );
  } else {
    out.push(
      `Lines: ${m.lines ?? '?'}${m.inCycle ? ' · part of an import cycle' : ''}${
        m.exportNames?.length
          ? ` · exports: ${m.exportNames
              .slice(0, 15)
              .map((e) => tick(e, 60))
              .join(', ')}${shownOf(15, m.exportNames.length)}`
          : ''
      }`,
    );
    const contained = index.descendants(node.id).filter((d) => SYMBOLS.has(d.kind));
    if (contained.length) {
      const counts = new Map<string, number>();
      for (const d of contained) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
      out.section(`Contains (${[...counts].map(([k, n]) => `${n} ${k}`).join(', ')})`);
      const top = contained.filter((d) => index.node(d.parent ?? '')?.kind === 'file');
      out.list(top, describe, { limit: 20, hint: 'use rastro_search' });
    }
    // código no topo do módulo (fora de funções e classes): o que ele chama
    const topLevel = walk(index, node, 'out', ['calls'], 1);
    topRelations(index, out, 'Top-level code calls (proven)', topLevel.proven, 'out');
    if (topLevel.unresolved.length) {
      out.section(`Top-level code: unresolved calls (${topLevel.unresolved.length})`);
      out.list(topLevel.unresolved, (r) => unresolvedLine(index, r), {
        limit: TOP,
        hint: 'use rastro_references with direction outgoing',
      });
    }
  }
  const imports = walk(index, node, 'out', ['imports'], 1);
  const importers = walk(index, node, 'in', ['imports'], 1);
  topRelations(index, out, 'Imports (project files)', imports.proven, 'out');
  if (imports.external.length) {
    out.section(`External packages imported (${imports.external.length})`);
    out.push(imports.external.map((r) => `${tick(r.node.name)}${qualifier(r.edge)}`).join(', '));
  }
  if (imports.unresolved.length) {
    out.section(`Unresolved imports (${imports.unresolved.length})`);
    out.list(imports.unresolved, (r) => unresolvedLine(index, r), {
      limit: TOP,
      hint: 'use rastro_references',
    });
  }
  topRelations(index, out, 'Imported by', importers.proven, 'in');
  if (!importers.proven.length)
    out.push(
      '',
      'No project file imports this file (it may be an entry point, a test or loaded dynamically).',
    );
}

function moduleDetails(index: GraphIndex, node: GraphNode, out: Out): void {
  const files = index
    .descendants(node.id)
    .filter((d) => d.kind === 'file' && d.meta?.analyzed !== false);
  const subfolders = index.children(node.id).filter((c) => c.kind === 'module');
  out.push(
    `Files: ${files.length} analyzed (recursively) · ${plural(subfolders.length, 'subfolder')}`,
  );
  if (subfolders.length)
    out.push(
      `Subfolders: ${subfolders
        .slice(0, 15)
        .map((c) => tick(nameOf(c)))
        .join(', ')}${shownOf(15, subfolders.length)}`,
    );
  const deps = (dir: 'in' | 'out') =>
    (dir === 'out'
      ? index.outgoing(node.id, ['depends_on'])
      : index.incoming(node.id, ['depends_on'])
    )
      .map((e) => ({ e, other: index.node(dir === 'out' ? e.target : e.source) }))
      .filter((x): x is { e: GraphEdge; other: GraphNode } => !!x.other)
      .sort((a, b) => (b.e.meta?.count ?? 0) - (a.e.meta?.count ?? 0));
  const out1 = deps('out');
  const in1 = deps('in');
  if (out1.length) {
    out.section(`Depends on folders (${out1.length}, derived from imports)`);
    out.list(
      out1,
      (x) =>
        `${tick(nameOf(x.other))} (${plural(x.e.meta?.count ?? x.e.evidence.length, 'import')}) — e.g. ${evidenceOf(x.e)}`,
      { limit: TOP, hint: 'use rastro_references' },
    );
  }
  if (in1.length) {
    out.section(`Folders that depend on it (${in1.length})`);
    out.list(
      in1,
      (x) =>
        `${tick(nameOf(x.other))} (${plural(x.e.meta?.count ?? x.e.evidence.length, 'import')})`,
      { limit: TOP, hint: 'use rastro_references' },
    );
  }
}

function packageDetails(index: GraphIndex, node: GraphNode, out: Out): void {
  const m = node.meta ?? {};
  out.push(
    `External to the project${m.builtin ? ' (Node.js built-in)' : m.declared ? ' (declared in package.json)' : m.outsideRoot ? ' (resolved outside the analyzed folder)' : ''}. Its code is not analyzed.`,
  );
  const importers = index
    .incoming(node.id, ['imports'])
    .map((e) => ({ e, from: index.node(e.source) }))
    .filter((x): x is { e: GraphEdge; from: GraphNode } => !!x.from)
    .sort((a, b) => compareStrings(a.from.id, b.from.id));
  out.section(`Imported by (${importers.length} files)`);
  out.list(importers, (x) => `${tick(nameOf(x.from))}${qualifier(x.e)} — ${evidenceOf(x.e)}`, {
    limit: 20,
    hint: 'use rastro_references',
  });
}

function unresolvedDetails(index: GraphIndex, node: GraphNode, out: Out): void {
  const m = node.meta ?? {};
  out.push(
    `Reference as written: ${tick(m.reference ?? node.name)}`,
    `Why it is unresolved: ${m.reason ? REASONS[m.reason] : 'unknown'}`,
  );
  if (m.receiverFile)
    out.push(
      `The receiver's type is declared in ${tick(m.receiverFile, 300)} and has no such member (a compile error).`,
    );
  const candidates = (m.candidates ?? [])
    .map((id) => index.node(id))
    .filter((n): n is GraphNode => !!n);
  if (candidates.length) {
    out.section(`Possible targets (${candidates.length}; only one runs, decided at runtime)`);
    out.list(candidates, describe, { limit: 20, hint: 'narrow with rastro_search' });
  }
  const from = index.incoming(node.id).filter((e) => e.kind !== 'contains');
  out.section(`Referenced from (${from.length})`);
  out.list(
    from,
    (e) =>
      `${index.node(e.source) ? describe(index.node(e.source)!) : tick(e.source)} — ${evidenceOf(e)}`,
    { limit: TOP, hint: 'use rastro_references' },
  );
}

function sourceSection(snapshot: Snapshot, node: GraphNode, out: Out): void {
  const loc = node.location;
  out.section('Source');
  if (!loc || node.kind === 'module' || node.kind === 'package') {
    out.push('No source for this kind of entity.');
    return;
  }
  const result = readSource(snapshot.graph.project.root, loc.file, snapshot.analyzedFiles);
  if (result.status !== 200 || result.body.content === undefined) {
    const why: Record<number, string> = {
      403: 'outside the project or not a JS/TS file',
      404: 'not an analyzed file, or no longer on disk',
      413: 'file too large',
    };
    out.push(`Source not available: ${why[result.status] ?? 'could not be read'}.`);
    return;
  }
  const all = result.body.content.split(/\r?\n/);
  if (all.length > 1 && all[all.length - 1] === '') all.pop();
  const first = node.kind === 'file' ? 1 : loc.startLine;
  const last = node.kind === 'file' ? all.length : Math.min(loc.endLine, all.length);
  const shownLast = Math.min(last, first + MAX_SOURCE_LINES - 1);
  const width = String(shownLast).length;
  const lines = all
    .slice(first - 1, shownLast)
    // caracteres de controle e separadores de linha do arquivo viram escapes; linhas enormes
    // (código minificado) são cortadas
    .map(
      (line, i) =>
        `${String(first + i).padStart(width)}  ${clip(line.replace(UNSAFE_IN_CODE, escapeChar), MAX_SOURCE_LINE)}`,
    );
  // a cerca é mais longa que qualquer sequência de crases do trecho: nada nele a fecha
  let longest = 0;
  for (const l of lines)
    for (const run of l.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  out.push(
    `${tick(loc.file, 300)} lines ${first}-${shownLast}${shownLast < last ? ` of ${first}-${last} (truncated to ${MAX_SOURCE_LINES} lines; ask for a narrower entity, e.g. a method)` : ''}:`,
  );
  out.push(`${fence}${loc.file.match(/\.([cm]?[jt]sx?)$/)?.[1] ?? ''}`, lines.join('\n'), fence);
}

// ---- references

/** Relações de uso (sem as estruturais `contains` e `exports`, que só se pedem explicitamente). */
const DEFAULT_KINDS: EdgeKind[] = ['calls', 'imports', 'extends', 'depends_on'];

function references(args: Args, ctx: ToolContext): string {
  const { index } = ctx.snapshot;
  const node = resolveTarget(ctx.snapshot, String(args.target));
  const direction = (args.direction as 'incoming' | 'outgoing' | 'both' | undefined) ?? 'incoming';
  const kinds = (args.kinds as EdgeKind[] | undefined) ?? DEFAULT_KINDS;
  const depth = num(args, 'depth', 1);
  const page = paged(args, 30, 200);
  const out = new Out().push(
    `# References of ${describe(node)}`,
    `id: ${idText(node.id)} · direction: ${direction} · kinds: ${kinds.join(', ')} · depth: ${depth}${page.offset ? ` · offset: ${page.offset}` : ''}`,
  );
  let total = 0;
  const side = (dir: 'in' | 'out') => {
    const label = dir === 'in' ? 'Incoming' : 'Outgoing';
    const found = walk(index, node, dir, kinds, depth);
    const possible = dir === 'in' && kinds.includes('calls') ? possibleCallers(index, node.id) : [];
    total +=
      found.proven.length + found.external.length + found.unresolved.length + possible.length;
    out.section(`${label} — proven (${found.proven.length})`);
    if (!found.proven.length) out.push('none');
    out.list(found.proven, (r) => relationLine(index, r, dir, depth > 1), page);
    if (found.external.length) {
      out.section(`${label} — external (${found.external.length})`);
      out.list(found.external, (r) => externalLine(r, dir, index), page);
    }
    if (found.unresolved.length || possible.length) {
      out.section(
        `${label} — possible / unresolved (${found.unresolved.length + possible.length}; NOT proven)`,
      );
      out.list(found.unresolved, (r) => unresolvedLine(index, r), page);
      out.list(possible, possibleLine, page);
    }
  };
  if (direction !== 'outgoing') side('in');
  if (direction !== 'incoming') side('out');
  if (node.kind === 'class' || node.kind === 'file' || node.kind === 'module')
    out.push(
      '',
      `_Only relationships of the ${node.kind === 'module' ? 'folder' : node.kind} itself; its members have their own (query them, or use rastro_impact for everything that depends on its contents)._`,
    );
  if (!total)
    out.push(
      '',
      'Nothing found. Absence of a proven relationship does not prove absence of use: callbacks, dynamic calls, reflection and code outside the analyzed folder are invisible to static analysis.',
    );
  return out.toString();
}

// ---- impact

const IMPACT_FORMATS = ['full', 'summary', 'tests'] as const;

const brokenWhy: Record<BrokenReference['why'], string> = {
  'file-deleted': 'the file was deleted',
  'file-renamed': 'the file was renamed or moved',
  'not-exported': 'the changed file does not export that name',
  'member-missing': 'the type, declared in the changed file, has no such member',
};

function brokenLine(b: BrokenReference): string {
  const where = b.evidence
    ? `${tick(`${b.evidence.file}:${b.evidence.line}`, 300)}${b.evidence.snippet ? ` ${tick(b.evidence.snippet, 140)}` : ''}`
    : '';
  const verb = b.kind === 'import' ? 'imports' : 'calls';
  return `${describe(b.from)} ${verb} ${tick(b.reference)} → ${tick(b.target, 300)}: ${brokenWhy[b.why]}${b.count > 1 ? ` (${b.count} sites)` : ''}${where ? ` — ${where}` : ''}`;
}

function impact(args: Args, ctx: ToolContext): string {
  const { index, graph } = ctx.snapshot;
  const page = paged(args, 30, 200);
  const max = page.limit;
  const format = (args.format as (typeof IMPACT_FORMATS)[number] | undefined) ?? 'full';
  const targets = args.targets as string[] | undefined;
  if (targets && (args.since !== undefined || args.changes !== undefined))
    throw new ToolError('Use either `targets` or the git mode (`changes` / `since`), not both.');
  if (args.changes === false && args.since === undefined && !targets)
    throw new ToolError(
      'Pass `targets`, or set `changes: true` (uncommitted changes) or `since` (a git ref).',
    );

  const out = new Out();
  let starts: GraphNode[];
  let impacted: ImpactEntry[];
  let routes: GraphNode[];
  let tests: GraphNode[];
  let broken: BrokenReference[] = [];
  let title: string;
  let summary: string;
  /** Seção "o que mudou" (só aparece no formato completo, depois das rotas e dos testes). */
  let changedSection: () => void;

  if (targets) {
    starts = targets.map((t) => resolveTarget(ctx.snapshot, t));
    starts = [...new Map(starts.map((n) => [n.id, n])).values()];
    impacted = index.impactOfAll(starts.map((n) => n.id));
    const inside = starts.flatMap((n) =>
      n.kind === 'file' || n.kind === 'class' || n.kind === 'module'
        ? index.descendants(n.id).filter((d) => SYMBOLS.has(d.kind) || d.kind === 'file')
        : [],
    );
    ({ routes, tests } = routesAndTests(index, [
      ...starts,
      ...inside,
      ...impacted.map((i) => i.node),
    ]));
    title = `# Impact of changing ${starts.map((n) => tick(nameOf(n))).join(', ')}`;
    summary = `Summary: ${plural(impacted.length, 'entity', 'entities')} could be affected · ${plural(routes.length, 'HTTP route')} · ${plural(tests.length, 'test file')}`;
    const shown = starts;
    changedSection = () => {
      out.section(`Targets (${shown.length})`);
      out.list(shown, describe, { limit: max, maxLimit: 200 });
    };
  } else {
    const since = typeof args.since === 'string' ? args.since : undefined;
    let changes;
    try {
      changes = inEnglish(() =>
        collectChanges(graph.project.root, {
          ...(since ? { since } : {}),
          trustConfig: ctx.trustGitConfig,
        }),
      );
    } catch (err) {
      throw new ToolError(`Could not read the git changes: ${plain((err as Error).message)}`);
    }
    const label =
      changes.baseLabel === 'HEAD'
        ? 'uncommitted changes (vs HEAD, including untracked files)'
        : `changes since ${tick(changes.baseLabel)} (merge base ${changes.base.slice(0, 10)}, including uncommitted and untracked files)`;
    title = `# Impact of ${label}`;
    if (!changes.files.length) return out.push(title, 'No changed files.').toString();
    const result = changesWithImpact(index, changes);
    starts = result.changed;
    impacted = result.impact.impacted;
    routes = result.impact.routes;
    tests = result.impact.tests;
    broken = result.impact.broken;
    const s = result.impact;
    const byStatus = new Map<string, ChangedFile>(changes.files.map((f) => [f.file, f]));
    const statusCounts = (['added', 'modified', 'renamed', 'deleted'] as const)
      .map((st) => [st, changes.files.filter((f) => f.status === st).length] as const)
      .filter(([, n]) => n)
      .map(([st, n]) => `${n} ${st === 'added' ? 'new' : st}`);
    const fileLevel = starts.filter((n) => n.kind === 'file');
    summary = `Summary: ${plural(changes.files.length, 'changed file')} (${statusCounts.join(', ')}) · ${plural(starts.length, 'changed item')} (${plural(s.changedEntities.length, 'entity', 'entities')}${fileLevel.length ? ` + ${plural(fileLevel.length, 'file')} changed at file level` : ''}) · ${impacted.length} could be affected · ${plural(routes.length, 'HTTP route')} · ${plural(tests.length, 'test file')}${broken.length ? ` · ${plural(broken.length, 'reference')} possibly broken` : ''}`;
    const fileLabel = (n: GraphNode): string => {
      const change = byStatus.get(n.qualifiedName ?? n.name);
      if (change?.status === 'added') return 'new file';
      if (change?.status === 'renamed')
        return change.previous ? `file renamed from ${tick(change.previous, 300)}` : 'renamed file';
      return 'file (top-level code changed, outside any function or class)';
    };
    changedSection = () => {
      out.section(
        `Changed (${s.changedEntities.length} ${s.changedEntities.length === 1 ? 'entity' : 'entities'}${fileLevel.length ? ` + ${plural(fileLevel.length, 'file')}` : ''})`,
      );
      out.list(
        starts,
        (n) => (n.kind === 'file' ? `${tick(nameOf(n))} ${fileLabel(n)}` : describe(n)),
        { limit: max, maxLimit: 200 },
      );
      if (s.outsideGraph.length) {
        out.section(
          `Changed outside the graph (${s.outsideGraph.length}: deleted, not JS/TS, or not analyzed)`,
        );
        out.list(
          s.outsideGraph,
          (f) =>
            `${tick(f.file, 300)} (${f.status === 'added' ? 'new' : f.status}${f.previous ? ` from ${tick(f.previous, 300)}` : ''})`,
          { limit: max, maxLimit: 200 },
        );
      }
    };
  }

  // chamadas por interface, método abstrato ou sobrescrita que podem cair no que mudou
  const seeds = new Set<string>();
  for (const n of starts) {
    seeds.add(n.id);
    if (n.kind === 'file' || n.kind === 'class' || n.kind === 'module')
      for (const d of index.descendants(n.id)) seeds.add(d.id);
  }
  const possible = [...seeds].flatMap((id) => possibleCallers(index, id));

  if (format === 'tests') {
    out.push(
      `${title} — tests to run`,
      `${plural(tests.length, 'test file')} changed or depend (through proven relationships) on what changed${tests.length ? ':' : '.'}`,
    );
    out.list(tests, (n) => tick(nameOf(n), 300), page);
    out.push(
      '',
      `_Tests reaching the change only through unresolved calls (callbacks, dynamic calls) are not listed${possible.length || broken.length ? `; ${plural(possible.length, 'possible caller')} and ${plural(broken.length, 'possibly broken reference')} are in \`format: "full"\`` : ''}._`,
    );
    return out.toString();
  }

  out.push(title, summary);
  // o que o agente mais quer primeiro: rotas e testes
  if (routes.length) {
    out.section(`HTTP routes involved (${routes.length})`);
    out.list(
      routes,
      (n) =>
        `${tick(routeLabel(n))} · ${whereOf(n)}${n.meta?.fullPath ? '' : ' (full path unknown)'}`,
      { limit: max, maxLimit: 200 },
    );
  }
  out.section(`Test files to run (${tests.length})`);
  if (!tests.length) out.push('No test file is linked to the change by proven relationships.');
  out.list(tests, (n) => tick(nameOf(n), 300), {
    limit: max,
    maxLimit: 200,
    hint: '`format: "tests"` lists them all (with `offset`)',
  });
  if (broken.length) {
    out.section(
      `Possibly broken by this change (${broken.length}; references to what changed that do not resolve in the current code — they may have been broken before)`,
    );
    out.list(broken, brokenLine, { limit: max, maxLimit: 200 });
  }

  if (format === 'summary') {
    out.push(
      '',
      `_Summary format: ${plural(impacted.length, 'affected entity', 'affected entities')}${possible.length ? `, ${plural(possible.length, 'possible caller')}` : ''} and the changed items are listed with \`format: "full"\`._`,
    );
    return out.toString();
  }

  changedSection();
  out.section(
    `Could be affected (${impacted.length}) — by distance, proven calls/imports/inheritance only`,
  );
  if (!impacted.length) out.push('Nothing known depends on it through proven relationships.');
  out.list(
    impacted,
    (i) => {
      const via = index.node(i.via.target);
      return `[d${i.depth}] ${describe(i.node)} — ${VERBS[i.via.kind]}${qualifier(i.via)} ${tick(via ? nameOf(via) : i.via.target)} at ${evidenceOf(i.via)}`;
    },
    page,
  );
  if (possible.length) {
    out.section(
      `Possibly affected (${possible.length}; NOT proven — calls through interfaces, abstract or overridden methods that may dispatch to what changed)`,
    );
    out.list(
      possible,
      (p) =>
        `${describe(p.caller)} ${p.how} → maybe ${tick(nameOf(index.node(p.target)!))} — ${evidenceOf(p.edge)}`,
      { limit: max, maxLimit: 200 },
    );
  }
  out.push(
    '',
    '_Unresolved references (callbacks, dynamic calls, untyped receivers) are not followed: something may depend on this without appearing here._',
  );
  return out.toString();
}

// ---- path

/** Pastas viram o que há dentro (arquivos e entidades); pacotes só servem de destino. */
function pathEnds(index: GraphIndex, node: GraphNode, role: 'from' | 'to'): string[] {
  if (node.kind === 'unresolved')
    throw new ToolError(
      `${describe(node)} is an unresolved reference, not an entity: rastro_path follows proven relationships between functions, classes, methods, routes, files, folders and (as destination) packages. Use rastro_entity on it to see where it is referenced and its possible targets.`,
    );
  if (node.kind === 'package' && role === 'from')
    throw new ToolError(
      `${describe(node)} is external: its code is not analyzed, so nothing goes out of it. Swap \`from\` and \`to\` to see how the project reaches it.`,
    );
  if (node.kind === 'module')
    return index
      .descendants(node.id)
      .filter((d) => d.kind === 'file' || SYMBOLS.has(d.kind))
      .map((d) => d.id);
  return [node.id];
}

function pathTool(args: Args, ctx: ToolContext): string {
  const { index } = ctx.snapshot;
  const from = resolveTarget(ctx.snapshot, String(args.from));
  const to = resolveTarget(ctx.snapshot, String(args.to));
  const max = num(args, 'limit', 3);
  const out = new Out().push(`# Paths from ${describe(from)} to ${describe(to)}`);
  if (from.id === to.id) return out.push('Both arguments are the same entity.').toString();
  let compileOnly = false;
  const render = (p: PathResult, n: number) => {
    out.push('', `Path ${n} (${plural(p.edges.length, 'step')}):`);
    p.edges.forEach((e, i) => {
      const a = index.node(e.source);
      const b = index.node(e.target);
      if (e.meta?.typeOnly) compileOnly = true;
      out.push(
        `${i + 1}. ${a ? tick(nameOf(a)) : tick(e.source)} ${VERBS[e.kind]}${qualifier(e)} ${b ? describe(b) : tick(e.target)} — ${evidenceOf(e)}`,
      );
    });
  };
  const compileNote = () => {
    if (compileOnly)
      out.push(
        '',
        '_Steps marked type-only exist only at compile time (`import type` or types from a `.d.ts`): they are not a runtime link._',
      );
  };

  // pastas e pacotes: o menor caminho de qualquer coisa de dentro até qualquer coisa de dentro
  if (from.kind === 'module' || to.kind === 'module' || to.kind === 'package') {
    const sources = pathEnds(index, from, 'from');
    const destinations = new Set(pathEnds(index, to, 'to'));
    if (sources.some((id) => destinations.has(id)) || destinations.has(from.id))
      return out
        .push('One is inside the other: pick entities or folders that do not overlap.')
        .toString();
    if (to.kind === 'package' && from.kind !== 'module' && from.kind !== 'file') {
      // só arquivos importam pacotes: o caminho sai do arquivo da entidade
      const file = index.fileOf(from.id);
      if (file) sources.push(file.id);
    }
    const found = findPathBetween(index, sources, destinations, {
      external: to.kind === 'package',
    });
    const what = [
      from.kind === 'module' ? `anything in ${tick(nameOf(from))}` : tick(nameOf(from)),
      to.kind === 'module' ? `anything in ${tick(nameOf(to))}` : tick(nameOf(to)),
    ];
    if (!found) {
      out.push(
        `No proven path from ${what[0]} to ${what[1]} through calls, imports and inheritance (up to 12 steps).`,
      );
      const reverse =
        to.kind !== 'package'
          ? findPathBetween(index, pathEnds(index, to, 'from'), new Set(sources))
          : null;
      if (reverse) {
        out.push('', `But ${what[1]} reaches ${what[0]} (opposite direction):`);
        render(reverse, 1);
      }
      out.push(
        '',
        'Callbacks, event emitters, dependency injection and dynamic calls are not followed, so a runtime link may still exist.',
      );
      compileNote();
      return out.toString();
    }
    out.push(
      `Shortest proven path from ${what[0]} to ${what[1]} (calls, imports and inheritance${to.kind === 'package' ? '; the last step is the import of the package' : ''}):`,
    );
    render(found, 1);
    const start = index.node(found.nodes[0]!);
    if (to.kind === 'package' && start && start.id !== from.id && from.kind !== 'module')
      out.push(
        '',
        `_The path starts at ${tick(nameOf(start))}, the file of ${tick(nameOf(from))}: a file-level import chain does not prove that ${tick(nameOf(from))} itself uses the package._`,
      );
    if (from.kind === 'module' && to.kind === 'module') {
      const dep = index.outgoing(from.id, ['depends_on']).find((e) => e.target === to.id);
      if (dep)
        out.push(
          '',
          `Folder dependency (derived from imports): ${tick(nameOf(from))} depends on ${tick(nameOf(to))} (${plural(dep.meta?.count ?? dep.evidence.length, 'import')}) — e.g. ${evidenceOf(dep)}`,
        );
    }
    compileNote();
    return out.toString();
  }
  pathEnds(index, from, 'from');
  pathEnds(index, to, 'to');

  const search = findPaths(index, from.id, to.id, { limit: max });
  if (search.paths.length && !search.reversed) {
    out.push(
      `${plural(search.paths.length, 'proven path')} (calls, imports and inheritance; shortest first):`,
    );
    search.paths.forEach((p, i) => render(p, i + 1));
    compileNote();
    return out.toString();
  }
  out.push(
    `No proven path from ${tick(nameOf(from))} to ${tick(nameOf(to))} through calls, imports and inheritance (up to 12 steps).`,
  );
  if (search.reversed) {
    out.push('', `But ${tick(nameOf(to))} reaches ${tick(nameOf(from))} (opposite direction):`);
    search.paths.forEach((p, i) => render(p, i + 1));
  }
  const possible = findPossiblePath(index, from.id, to.id);
  if (possible) {
    out.push(
      '',
      'A POSSIBLE (unproven) path exists if calls through interfaces/abstract methods dispatch to these implementations:',
    );
    possible.forEach((step, i) => {
      const a = index.node(step.edge.source);
      const b = index.node(step.to);
      const via = index.node(step.edge.target);
      if (step.edge.meta?.typeOnly) compileOnly = true;
      out.push(
        step.possible
          ? `${i + 1}. ${tick(a ? nameOf(a) : step.edge.source)} calls ${tick(via?.meta?.reference ?? via?.name ?? step.edge.target)} → maybe ${b ? describe(b) : tick(step.to)} (POSSIBLE, 1 of ${via?.meta?.candidates?.length ?? '?'}) — ${evidenceOf(step.edge)}`
          : `${i + 1}. ${tick(a ? nameOf(a) : step.edge.source)} ${VERBS[step.edge.kind]}${qualifier(step.edge)} ${b ? describe(b) : tick(step.to)} — ${evidenceOf(step.edge)}`,
      );
    });
  }
  // entre símbolos de arquivos diferentes: o caminho pelos imports dos arquivos
  const fromFile = index.fileOf(from.id);
  const toFile = index.fileOf(to.id);
  if (
    !search.paths.length &&
    fromFile &&
    toFile &&
    fromFile.id !== toFile.id &&
    (fromFile.id !== from.id || toFile.id !== to.id)
  ) {
    const files = findPaths(index, fromFile.id, toFile.id, { limit: 1, kinds: ['imports'] });
    if (files.paths.length && !files.reversed) {
      out.push(
        '',
        `At the file level, ${tick(nameOf(fromFile))} reaches ${tick(nameOf(toFile))} through imports (this does not prove the entities call each other):`,
      );
      render(files.paths[0]!, 1);
    }
  }
  if (!search.paths.length && !possible)
    out.push(
      '',
      'Callbacks, event emitters, dependency injection and dynamic calls are not followed, so a runtime link may still exist.',
    );
  compileNote();
  return out.toString();
}

// ---- routes

const FRAMEWORKS = ['express', 'fastify', 'hono', 'nestjs', 'next'] as const;

function routes(args: Args, ctx: ToolContext): string {
  const { index } = ctx.snapshot;
  const filter = typeof args.filter === 'string' ? args.filter.toLowerCase() : '';
  const method = typeof args.method === 'string' ? args.method.toUpperCase() : undefined;
  const framework = args.framework as string | undefined;
  const all = [...index.nodes.values()].filter((n) => n.kind === 'route');
  const matches = all
    .filter(
      (n) =>
        !method || n.meta?.httpMethod?.toUpperCase() === method || n.meta?.httpMethod === 'ALL',
    )
    .filter((n) => !framework || n.meta?.framework === framework)
    .filter((n) => {
      if (!filter) return true;
      const handlers = index
        .outgoing(n.id, ['calls'])
        .map((e) => index.node(e.target))
        .map((t) => (t ? nameOf(t) : ''));
      return [
        routeLabel(n),
        n.meta?.routePath ?? '',
        n.location?.file ?? '',
        ...handlers,
        ...(n.meta?.mountedAt ?? []),
      ].some((text) => text.toLowerCase().includes(filter));
    })
    .sort(
      (a, b) =>
        compareStrings(
          a.meta?.fullPath ?? a.meta?.routePath ?? '',
          b.meta?.fullPath ?? b.meta?.routePath ?? '',
        ) ||
        compareStrings(a.meta?.httpMethod ?? '', b.meta?.httpMethod ?? '') ||
        compareStrings(a.id, b.id),
    );
  if (!all.length)
    return 'No HTTP routes were found. Rastro recognizes Express, Fastify, Hono, NestJS and Next.js (App and Pages Router) routes declared in code it can follow statically.';
  const filters = [
    filter && `filter ${tick(filter)}`,
    method && `method ${tick(method)}`,
    framework && `framework ${framework}`,
  ].filter(Boolean);
  const out = new Out().push(
    `# HTTP routes: ${matches.length} of ${all.length}${filters.length ? ` (${filters.join(', ')})` : ''}`,
  );
  if (!matches.length) return out.push('No route matches.').toString();
  out.list(
    matches,
    (n) => {
      const note = routePathNote(n);
      return `${tick(routeLabel(n))} — ${plain(n.meta?.framework ?? '?')}${n.meta?.routeKind ? ` ${n.meta.routeKind}` : ''} · defined at ${whereOf(n)} · handler: ${routeHandler(index, n)}${note ? ` · ${note}` : ''}`;
    },
    paged(args, 100, 500),
  );
  return out.toString();
}

// ---------------------------------------------------------------------------

/** Toda resposta (e todo erro previsto) começa com o aviso de análise parcial, quando houver. */
function withPartialNote(
  run: (args: Args, ctx: ToolContext) => string,
): (args: Args, ctx: ToolContext) => string {
  return (args, ctx) => {
    const note = partialNote(ctx.snapshot);
    if (!note) return run(args, ctx);
    try {
      return `${note}\n\n${run(args, ctx)}`;
    } catch (err) {
      if (err instanceof ToolError) throw new ToolError(`${note}\n\n${err.message}`);
      throw err;
    }
  };
}

const TOOL_LIST: ToolDefinition[] = [
  {
    name: 'rastro_overview',
    title: 'Project overview',
    description:
      'Summary of the analyzed JavaScript/TypeScript project: size, entity counts, proven/unresolved relationships per kind, main folders, HTTP routes, the most called functions, central files, possibly unused code, analysis diagnostics and freshness. Call this first to get oriented in an unfamiliar codebase.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: overview,
  },
  {
    name: 'rastro_search',
    title: 'Search entities',
    description:
      'Find functions, classes, methods, files, folders, HTTP routes and external packages by name, qualified name (`Class.method`) or file path (case-insensitive; exact names rank first). Returns ids and file:line to pass to the other rastro tools. It searches names, not code text: use grep for string literals and comments. Interfaces, type aliases, enums and plain variables are not entities.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Name, part of a name, `Class.method` or a path fragment.',
        },
        kind: {
          type: 'string',
          enum: NODE_KINDS,
          description:
            'Only this kind of entity (`module` = folder, `package` = external package).',
        },
        limit: limit(100, 20),
        offset: offset('the matches'),
      },
      required: ['query'],
      additionalProperties: false,
    },
    run: search,
  },
  {
    name: 'rastro_entity',
    title: 'Entity details',
    description:
      'Everything Rastro knows about one entity: kind, location, parent chain, export status, members (abstract ones listed apart), proven callers and callees (counts and top entries with file:line evidence; a constructor also runs on `new` of its class and of subclasses without a constructor), methods it overrides, imports, importers and top-level calls for files, inheritance, HTTP route details, and possible (unproven) relationships listed separately — calls through interfaces and calls to an overridden base method that may dispatch here. Set `source: true` to include its code (up to 120 lines, read from the analyzed file on disk).',
    inputSchema: {
      type: 'object',
      properties: {
        target: target(TARGET_HELP),
        source: {
          type: 'boolean',
          default: false,
          description: 'Include the source code of the entity (up to 120 lines).',
        },
      },
      required: ['target'],
      additionalProperties: false,
    },
    run: entity,
  },
  {
    name: 'rastro_references',
    title: 'References with evidence',
    description:
      'Who uses an entity and what it uses — callers/callees, importers/imports, exports, subclasses — each with evidence (file:line and the line of code). Grouped into PROVEN (resolved by the TypeScript checker or a framework rule), EXTERNAL (packages outside the project) and POSSIBLE (unresolved calls through interfaces, abstract methods or callbacks with candidate targets, and calls to an overridden base method that may dispatch here: not facts). `direction`: incoming (default: who calls/imports it), outgoing (what it calls/imports) or both. `depth` 2-3 follows proven relationships transitively. Long lists are paginated with `limit` and `offset`.',
    inputSchema: {
      type: 'object',
      properties: {
        target: target(TARGET_HELP),
        direction: {
          type: 'string',
          enum: ['incoming', 'outgoing', 'both'],
          description: 'Default: incoming.',
        },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: EDGE_KINDS },
          minItems: 1,
          uniqueItems: true,
          description:
            'Relationship kinds (default: calls, imports, extends, depends_on; `exports` and `contains` are structural and only included when asked).',
        },
        depth: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
          default: 1,
          description: 'Transitive levels of proven relationships (default 1).',
        },
        limit: limit(200, 30),
        offset: offset('each list'),
      },
      required: ['target'],
      additionalProperties: false,
    },
    run: references,
  },
  {
    name: 'rastro_impact',
    title: 'Impact of a change',
    description:
      'What could break: the blast radius of a change. Pass `targets` (entities you plan to change), or omit them to use git: uncommitted changes (default) or, with `since` (e.g. `main`), everything changed since the current branch forked from that ref. Answers, in this order: a summary, HTTP routes involved, test files to run, references POSSIBLY BROKEN by the change (git mode: imports of deleted/renamed files, names no longer exported, missing members — they do not resolve in the current code), what changed, what depends on it by distance (each with the proven relationship and the file:line that links it), and callers that may be affected through interfaces or overriding (marked as unproven). `format: "tests"` returns only the test files to run; `format: "summary"` stops after routes, tests and possibly broken references.',
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: target('Entity'),
          minItems: 1,
          maxItems: 20,
          uniqueItems: true,
          description: `Entities to analyze. ${TARGET_HELP}`,
        },
        changes: {
          type: 'boolean',
          description: 'Use the uncommitted git changes (the default when `targets` is omitted).',
        },
        since: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            'Git ref (branch, tag or commit): changes since the current branch forked from it, plus uncommitted ones.',
        },
        format: {
          type: 'string',
          enum: IMPACT_FORMATS,
          description:
            '`full` (default), `summary` (summary, routes, tests, possibly broken) or `tests` (only the test files to run).',
        },
        limit: limit(200, 30),
        offset: offset('the "could be affected" list (and the test list with `format: "tests"`)'),
      },
      additionalProperties: false,
    },
    run: impact,
  },
  {
    name: 'rastro_path',
    title: 'How A reaches B',
    description:
      'How does A reach B? Shortest chains of proven calls, imports and inheritance from `from` to `to` (up to `limit` alternatives), each step with file:line evidence; type-only steps are marked as compile-time only. A folder stands for everything inside it; `to` can be an external package (the last step is the import). When there is no proven path it says so, and reports a path in the opposite direction, a file-level import path, or a possible path through unresolved interface calls (clearly marked as unproven).',
    inputSchema: {
      type: 'object',
      properties: {
        from: target(`Start. ${TARGET_HELP}`),
        to: target(`Destination (an external package is accepted here). ${TARGET_HELP}`),
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
          default: 3,
          description: 'Alternative paths (default 3; folders and packages give the shortest one).',
        },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    run: pathTool,
  },
  {
    name: 'rastro_routes',
    title: 'HTTP routes',
    description:
      'HTTP routes found in the code (Express, Fastify, Hono, NestJS, Next.js): method, full path (or why it is unknown, e.g. an unproven mount prefix), framework, handler (or "handler not identified") and file:line. Filter by substring (`filter`, matched against path, handler and file), `method` or `framework`; paginate with `limit` and `offset`.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          maxLength: 200,
          description: 'Substring of the path, handler name or file (case-insensitive).',
        },
        method: {
          type: 'string',
          maxLength: 10,
          description: 'HTTP method, e.g. GET (routes for ALL methods always match).',
        },
        framework: {
          type: 'string',
          enum: FRAMEWORKS,
          description: 'Only routes of this framework.',
        },
        limit: limit(500, 100),
        offset: offset('the routes'),
      },
      additionalProperties: false,
    },
    run: routes,
  },
];

export const TOOLS: ToolDefinition[] = TOOL_LIST.map((tool) => ({
  ...tool,
  run: withPartialNote(tool.run),
}));
