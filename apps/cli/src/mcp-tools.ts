import fs from 'node:fs';
import path from 'node:path';
import {
  compareStrings,
  diagnosticText,
  EDGE_KINDS,
  NODE_KIND_LABELS_EN,
  NODE_KINDS,
  RASTRO_VERSION,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  type UnresolvedReason,
} from '@rastro/core';
import {
  findPaths,
  findPossiblePath,
  routesAndTests,
  type GraphIndex,
  type ImpactEntry,
  type PathResult,
} from '@rastro/graph';
import { collectChanges } from './git.js';
import { getLang, setLang } from './i18n.js';
import { changesWithImpact, mdCode } from './impact.js';
import type { Snapshot } from './mcp-project.js';
import { readSource } from './server.js';
import { safeText } from './term.js';

/**
 * As ferramentas do `rastro mcp`: consultas ao grafo com respostas em texto compacto
 * (Markdown) para agentes de IA. Regras de todas elas:
 * - nunca inventam relações: o que é comprovado (resolvido, com arquivo:linha) fica separado
 *   do que é possível (não resolvido, com candidatos) e do que é externo;
 * - listas têm limite e dizem quantos itens ficaram de fora;
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
        `unknown argument \`${clip(key, 60)}\` (accepted: ${Object.keys(schema.properties).join(', ') || 'none'})`,
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
        return `must be one of: ${spec.enum.join(', ')} (got ${JSON.stringify(clip(value, 40))})`;
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
const TOP = 10;

const clip = (s: string, max = 120) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** Texto do projeto (nomes, caminhos, código) em código inline: sem quebras, controles ou Markdown solto. */
const tick = (s: string, max = 120) => mdCode(clip(s, max));
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

/** `arquivo:linha` de onde a entidade começa (só o caminho para arquivos; vazio para pastas e pacotes). */
function whereOf(n: GraphNode): string {
  if (n.kind === 'file' || n.kind === 'module' || n.kind === 'package') return '';
  return n.location ? safeText(`${n.location.file}:${n.location.startLine}`) : '';
}

/** `` `Classe.metodo` method · src/a.ts:12 `` */
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
  if (e.meta?.typeOnly) notes.push('type-only');
  if (e.meta?.viaDeclaration) notes.push('via .d.ts');
  return notes.length ? ` (${notes.join(', ')})` : '';
}

/** Evidência: `src/a.ts:8 \`linha de código\`` (+ quantos outros lugares). */
function evidenceOf(e: GraphEdge): string {
  const first = e.evidence[0];
  if (!first) return '';
  const snippet = first.snippet ? ` ${tick(first.snippet, 140)}` : '';
  const total = Math.max(e.meta?.count ?? 0, e.evidence.length);
  const more = total > 1 ? ` (+${total - 1} more ${total - 1 === 1 ? 'site' : 'sites'})` : '';
  return `${safeText(first.file)}:${first.line}${snippet}${more}`;
}

class Out {
  readonly lines: string[] = [];
  push(...lines: string[]): this {
    this.lines.push(...lines);
    return this;
  }
  section(title: string): this {
    if (this.lines.length) this.lines.push('');
    this.lines.push(`## ${title}`);
    return this;
  }
  /** Até `limit` itens, e uma linha dizendo quantos ficaram de fora. */
  list<T>(items: readonly T[], limit: number, render: (item: T) => string, hint: string): this {
    for (const item of items.slice(0, limit)) this.lines.push(`- ${render(item)}`);
    if (items.length > limit) this.lines.push(`- … ${items.length - limit} more (${hint})`);
    return this;
  }
  toString(): string {
    const text = this.lines.join('\n');
    if (text.length <= MAX_OUTPUT) return text;
    const cut = text.lastIndexOf('\n', MAX_OUTPUT);
    return `${text.slice(0, cut > 0 ? cut : MAX_OUTPUT)}\n… output truncated at ${MAX_OUTPUT} characters (lower \`limit\` or narrow the query)`;
  }
}

const RAISE = 'raise `limit`';

// ---------------------------------------------------------------------------
// resolução de nomes

const SYMBOLS = new Set<NodeKind>(['function', 'class', 'method', 'route']);

/** Caminho como o grafo usa: relativo à raiz, com `/`, sem `./` nem `/` no fim. */
function normalizePath(raw: string, root: string): string {
  let p = raw.replace(/\\/g, '/');
  const rootPosix = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (p === rootPosix) return '.';
  if (p.startsWith(`${rootPosix}/`)) p = p.slice(rootPosix.length + 1);
  p = p.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return p || '.';
}

/** A entidade mais interna que contém a linha (ou o próprio arquivo). */
function entityAtLine(index: GraphIndex, file: GraphNode, line: number): GraphNode {
  let best: GraphNode | undefined;
  for (const n of index.descendants(file.id)) {
    const loc = n.location;
    if (!SYMBOLS.has(n.kind) || !loc || line < loc.startLine || line > loc.endLine) continue;
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

/** Quando nada foi encontrado: o que tentar (busca aproximada). */
function notFound(index: GraphIndex, query: string): ToolError {
  const out = new Out().push(`No entity matches ${tick(query)}.`);
  const words = query.split(/[\s#:/.]+/).filter((w) => w.length > 1);
  const seen = new Set<string>();
  const close = [query, ...words.reverse()]
    .flatMap((q) => index.search(q, 8).map((r) => r.node))
    .filter((n) => n.kind !== 'unresolved' && !seen.has(n.id) && seen.add(n.id))
    .slice(0, 8);
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
    out.list(close, 8, (n) => `${describe(n)} · id ${tick(n.id, 200)}`, '');
  }
  out.push(
    '',
    'A target can be an id (`fn:src/a.ts#name`), a name or qualified name (`Class.method`), a file path relative to the project root (`src/a.ts`), a folder (`src/lib`) or `path:line`. Use rastro_search to explore.',
  );
  return new ToolError(out.toString());
}

/**
 * Encontra a entidade pedida: id, `arquivo:linha`, caminho de arquivo ou pasta, sufixo de id
 * (`src/a.ts#nome`), nome qualificado ou nome (com e sem diferenciar maiúsculas). Se mais de
 * uma combina, lista os candidatos e pede um id; se nenhuma, sugere nomes parecidos.
 */
export function resolveTarget(snapshot: Snapshot, raw: string): GraphNode {
  const { index } = snapshot;
  const query = raw.trim();
  if (!query) throw new ToolError('The target is empty.');
  const exact = index.node(query);
  if (exact) return exact;

  const p = normalizePath(query, snapshot.graph.project.root);
  const atLine = /^(.+):(\d+)$/.exec(p);
  if (atLine) {
    const file = index.node(`file:${atLine[1]}`);
    if (file) return entityAtLine(index, file, Number(atLine[2]));
  }
  const pathMatch = index.node(`file:${p}`) ?? index.node(`module:${p}`);
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
    out.list(list, 20, (n) => `${tick(n.id, 200)} — ${describe(n)}`, 'narrow the name');
    throw new ToolError(out.toString());
  };

  if (query.includes('#')) {
    const bySuffix = all.filter((n) => n.id.slice(n.id.indexOf(':') + 1) === query);
    const found = pick(bySuffix);
    if (found) return found;
  }
  const byName = (same: (a: string, b: string) => boolean) =>
    all.filter(
      (n) =>
        n.kind !== 'module' &&
        (same(n.qualifiedName ?? '', query) ||
          same(n.name, query) ||
          (n.kind === 'route' && same(routeLabel(n), query))),
    );
  return (
    pick(byName((a, b) => a === b)) ??
    pick(byName((a, b) => a.toLowerCase() === b.toLowerCase())) ??
    (() => {
      throw notFound(index, query);
    })()
  );
}

// ---------------------------------------------------------------------------
// relações

interface Reached {
  node: GraphNode;
  depth: number;
  edge: GraphEdge;
}

interface Neighborhood {
  proven: Reached[];
  external: Reached[];
  /** Relações não resolvidas (só a partir da própria entidade). */
  unresolved: Reached[];
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
      const edges = direction === 'in' ? index.incoming(id, kinds) : index.outgoing(id, kinds);
      const other = (e: GraphEdge) => (direction === 'in' ? e.source : e.target);
      for (const edge of [...edges].sort((a, b) => compareStrings(other(a), other(b)))) {
        const node = index.node(other(edge));
        if (!node) continue;
        if (edge.resolution === 'resolved') {
          if (visited.has(node.id)) continue;
          visited.add(node.id);
          result.proven.push({ node, depth: d, edge });
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

/** Quem chama a entidade por meio de uma chamada não resolvida que a tem como candidata. */
function possibleCallers(
  index: GraphIndex,
  id: string,
): Array<{ caller: GraphNode; via: GraphNode; edge: GraphEdge }> {
  const found: Array<{ caller: GraphNode; via: GraphNode; edge: GraphEdge }> = [];
  for (const via of index.possibleCallSites(id))
    for (const edge of index.incoming(via.id, ['calls'])) {
      const caller = index.node(edge.source);
      if (caller) found.push({ caller, via, edge });
    }
  return found.sort((a, b) => compareStrings(a.caller.id, b.caller.id));
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
  const tail = evidence ? ` — ${evidence}` : '';
  if (direction === 'in') {
    const target = index.node(r.edge.target);
    return `${depth}${describe(r.node)} ${verb} ${tick(target ? nameOf(target) : r.edge.target)}${tail}`;
  }
  const source = index.node(r.edge.source);
  return `${depth}${tick(source ? nameOf(source) : r.edge.source)} ${verb} ${describe(r.node)}${tail}`;
}

/** Uma referência não resolvida: o texto, o motivo e os alvos possíveis. */
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

/** Handlers da rota: funções ligadas pelo framework, ou o handler inline (o que ele chama). */
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
  return calls.length
    ? `inline function (calls ${calls
        .slice(0, 4)
        .map((t) => tick(nameOf(t)))
        .join(', ')}${calls.length > 4 ? ', …' : ''})`
    : 'inline function';
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
// ferramentas

const target = (description: string): StringSchema => ({
  type: 'string',
  minLength: 1,
  maxLength: 500,
  description,
});
const TARGET_HELP =
  'Entity: an id (`fn:src/a.ts#name`), a name or qualified name (`Class.method`), a file path relative to the project root, a folder, or `path:line`.';
const limit = (max: number, fallback: number): IntegerSchema => ({
  type: 'integer',
  minimum: 1,
  maximum: max,
  default: fallback,
  description: `Maximum items per list (default ${fallback}).`,
});
const num = (args: Args, key: string, fallback: number) =>
  typeof args[key] === 'number' ? (args[key] as number) : fallback;

// ---- overview

function overview(_args: Args, ctx: ToolContext): string {
  const { graph, index } = ctx.snapshot;
  const s = graph.stats;
  const out = new Out().push(`# ${clip(graph.project.name, 80)} — Rastro code graph`);
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
  const r = s.edgesByResolution;
  out.push(
    `Relationships: ${r.resolved ?? 0} proven · ${r.external ?? 0} to external packages · ${r.unresolved ?? 0} unresolved (target unknown or only possible)`,
    `By kind: ${(['calls', 'imports', 'exports', 'extends'] as const).map((k) => `${k} ${s.edgesByKind[k] ?? 0}`).join(' · ')}`,
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
      `HTTP routes: ${routes.length} (${frameworks.join(', ')}) — list them with rastro_routes`,
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
    for (const n of [...internal.slice(0, 5), ...exported.slice(0, 3)])
      out.push(`- ${describe(n)}`);
  }
  if (!insights.mostCalled.length && !insights.mostImported.length)
    out.push('No proven calls or imports between project files yet.');

  const warnings = graph.diagnostics.filter((d) => d.level !== 'info');
  out.section('Analysis');
  out.push(
    `Diagnostics: ${plural(warnings.length, 'warning')}, ${graph.diagnostics.length - warnings.length} info`,
  );
  for (const d of warnings.slice(0, 5))
    out.push(
      `- ${d.file ? `${tick(`${d.file}${d.line ? `:${d.line}` : ''}`)} — ` : ''}${clip(diagnosticText(d, 'en'), 300)}`,
    );
  if (warnings.length > 5) out.push(`- … ${warnings.length - 5} more`);
  if (skipped.length && warnings.length <= 5) {
    // os ignorados de nível info (links simbólicos) também contam como fora da análise
    for (const d of skipped.filter((d) => d.level === 'info').slice(0, 3))
      out.push(`- ${tick(d.file ?? '?')} — ${clip(diagnosticText(d, 'en'), 200)}`);
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
        : 'watching files by polling (every 1.5 s): edits are re-analyzed before the next answer';
  return `_Analysis #${snap.sequence}: ${ago}s ago, took ${snap.wallMs} ms (TypeScript ${snap.graph.analyzer.typescriptVersion}) · ${watch} · Rastro ${RASTRO_VERSION}_`;
}

// ---- search

function search(args: Args, ctx: ToolContext): string {
  const { index } = ctx.snapshot;
  const query = String(args.query);
  const max = num(args, 'limit', 20);
  const kind = args.kind as NodeKind | undefined;
  const results = index.search(query, Number.MAX_SAFE_INTEGER, kind ? new Set([kind]) : undefined);
  if (!results.length)
    return `No ${kind ? `${kind} ` : ''}entity matches ${tick(query)}. Search covers names, qualified names (\`Class.method\`) and file paths, case-insensitively; it does not search code text (use grep for literals and comments).`;
  const out = new Out().push(
    `${plural(results.length, 'match', 'matches')} for ${tick(query)}${kind ? ` (kind: ${kind})` : ''}${results.length > max ? `, showing ${max}` : ''}:`,
  );
  out.list(results, max, (r) => `${describe(r.node)} · id ${tick(r.node.id, 200)}`, RAISE);
  return out.toString();
}

// ---- entity

function entity(args: Args, ctx: ToolContext): string {
  const { index } = ctx.snapshot;
  const node = resolveTarget(ctx.snapshot, String(args.target));
  const out = new Out().push(
    `# ${tick(nameOf(node))} — ${kindOf(node)}`,
    `id: ${tick(node.id, 200)}`,
  );
  const loc = node.location;
  if (loc && node.kind !== 'module')
    out.push(
      `Location: ${safeText(loc.file)}:${loc.startLine}${loc.endLine !== loc.startLine ? `-${loc.endLine}` : ''}`,
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
  if (exportedAs.length) out.push(`Exported as: ${exportedAs.slice(0, 5).join('; ')}`);

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
  out.list(reached, TOP, (r) => relationLine(index, r, direction, false), 'use rastro_references');
}

function symbolDetails(index: GraphIndex, node: GraphNode, out: Out): void {
  const callKinds: EdgeKind[] = ['calls'];
  let usedOutside = 0;
  if (node.kind === 'route') {
    const m = node.meta ?? {};
    out.section('HTTP route');
    out.push(
      `${tick(routeLabel(node))} · framework ${m.framework ?? 'unknown'}${m.routeKind ? ` · ${m.routeKind}` : ''}`,
    );
    const note = routePathNote(node);
    if (note) out.push(note);
    out.push(`Handler: ${routeHandler(index, node)}`);
  }
  if (node.kind === 'class') {
    const members = index.children(node.id).filter((c) => c.kind === 'method');
    if (members.length) {
      out.section(`Members (${members.length})`);
      out.list(
        members,
        25,
        (c) => `${tick(c.name)} ${kindOf(c)}${c.meta?.static ? ' (static)' : ''} · ${whereOf(c)}`,
        'use rastro_search',
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
          .join('; ')}`,
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
  topRelations(
    index,
    out,
    node.kind === 'class'
      ? 'Instantiated or called directly by (new, super) (proven)'
      : 'Called by (proven)',
    callers.proven,
    'in',
  );
  topRelations(index, out, 'Calls (proven)', callees.proven, 'out');
  if (!callers.proven.length && !usedOutside && node.kind !== 'route')
    out.push('', 'No proven callers. Dynamic or callback-based use cannot be ruled out.');
  const possible = possibleCallers(index, node.id);
  const unresolved = callees.unresolved;
  if (possible.length || unresolved.length) {
    out.section('Possible (unproven) relationships');
    out.list(
      possible,
      TOP,
      (p) =>
        `may be called by ${describe(p.caller)} via ${tick(p.via.meta?.reference ?? p.via.name)} (1 of ${p.via.meta?.candidates?.length ?? '?'} possible implementations) — ${evidenceOf(p.edge)}`,
      'use rastro_references',
    );
    out.list(unresolved, TOP, (r) => unresolvedLine(index, r), 'use rastro_references');
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
              .join(', ')}${m.exportNames.length > 15 ? ', …' : ''}`
          : ''
      }`,
    );
    const contained = index.descendants(node.id).filter((d) => SYMBOLS.has(d.kind));
    if (contained.length) {
      const counts = new Map<string, number>();
      for (const d of contained) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
      out.section(`Contains (${[...counts].map(([k, n]) => `${n} ${k}`).join(', ')})`);
      const top = contained.filter((d) => index.node(d.parent ?? '')?.kind === 'file');
      out.list(top, 20, (d) => `${describe(d)}`, 'use rastro_search');
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
    out.list(imports.unresolved, TOP, (r) => unresolvedLine(index, r), 'use rastro_references');
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
        .join(', ')}`,
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
      TOP,
      (x) =>
        `${tick(nameOf(x.other))} (${plural(x.e.meta?.count ?? x.e.evidence.length, 'import')}) — e.g. ${evidenceOf(x.e)}`,
      'use rastro_references',
    );
  }
  if (in1.length) {
    out.section(`Folders that depend on it (${in1.length})`);
    out.list(
      in1,
      TOP,
      (x) =>
        `${tick(nameOf(x.other))} (${plural(x.e.meta?.count ?? x.e.evidence.length, 'import')})`,
      'use rastro_references',
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
  out.list(
    importers,
    20,
    (x) => `${tick(nameOf(x.from))}${qualifier(x.e)} — ${evidenceOf(x.e)}`,
    'use rastro_references',
  );
}

function unresolvedDetails(index: GraphIndex, node: GraphNode, out: Out): void {
  const m = node.meta ?? {};
  out.push(
    `Reference as written: ${tick(m.reference ?? node.name)}`,
    `Why it is unresolved: ${m.reason ? REASONS[m.reason] : 'unknown'}`,
  );
  const candidates = (m.candidates ?? [])
    .map((id) => index.node(id))
    .filter((n): n is GraphNode => !!n);
  if (candidates.length) {
    out.section(`Possible targets (${candidates.length}; only one runs, decided at runtime)`);
    out.list(candidates, 20, describe, 'narrow with rastro_search');
  }
  const from = index.incoming(node.id).filter((e) => e.kind !== 'contains');
  out.section(`Referenced from (${from.length})`);
  out.list(
    from,
    TOP,
    (e) =>
      `${index.node(e.source) ? describe(index.node(e.source)!) : tick(e.source)} — ${evidenceOf(e)}`,
    'use rastro_references',
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
    // caracteres de controle do arquivo não vão para a resposta
    .map((line, i) => `${String(first + i).padStart(width)}  ${safeText(line)}`);
  const longest = Math.max(2, ...lines.map((l) => (/`{3,}/.exec(l)?.[0].length ?? 0) + 1));
  const fence = '`'.repeat(Math.max(3, longest));
  out.push(
    `${safeText(loc.file)} lines ${first}-${shownLast}${shownLast < last ? ` of ${first}-${last} (truncated to ${MAX_SOURCE_LINES} lines; ask for a narrower entity, e.g. a method)` : ''}:`,
  );
  out.push(`${fence}${node.location?.file.match(/\.([cm]?[jt]sx?)$/)?.[1] ?? ''}`, ...lines, fence);
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
  const max = num(args, 'limit', 30);
  const out = new Out().push(
    `# References of ${describe(node)}`,
    `id: ${tick(node.id, 200)} · direction: ${direction} · kinds: ${kinds.join(', ')} · depth: ${depth}`,
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
    out.list(found.proven, max, (r) => relationLine(index, r, dir, depth > 1), RAISE);
    if (found.external.length) {
      out.section(`${label} — external (${found.external.length})`);
      out.list(found.external, max, (r) => externalLine(r, dir, index), RAISE);
    }
    if (found.unresolved.length || possible.length) {
      out.section(
        `${label} — possible / unresolved (${found.unresolved.length + possible.length}; NOT proven)`,
      );
      out.list(found.unresolved, max, (r) => unresolvedLine(index, r), RAISE);
      out.list(
        possible,
        max,
        (p) =>
          `${describe(p.caller)} may call it via ${tick(p.via.meta?.reference ?? p.via.name)} (1 of ${p.via.meta?.candidates?.length ?? '?'} possible implementations) — ${evidenceOf(p.edge)}`,
        RAISE,
      );
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

function impact(args: Args, ctx: ToolContext): string {
  const { index, graph } = ctx.snapshot;
  const max = num(args, 'limit', 30);
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
    out.push(`# Impact of changing ${starts.map((n) => tick(nameOf(n))).join(', ')}`);
    out.push(
      `Summary: ${plural(impacted.length, 'entity', 'entities')} could be affected · ${plural(routes.length, 'HTTP route')} · ${plural(tests.length, 'test file')}`,
    );
    out.section(`Targets (${starts.length})`);
    out.list(starts, max, describe, RAISE);
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
      throw new ToolError(`Could not read the git changes: ${(err as Error).message}`);
    }
    const label =
      changes.baseLabel === 'HEAD'
        ? 'uncommitted changes (vs HEAD, including untracked files)'
        : `changes since ${tick(changes.baseLabel)} (merge base ${changes.base.slice(0, 10)}, including uncommitted and untracked files)`;
    out.push(`# Impact of ${label}`);
    if (!changes.files.length) {
      out.push('No changed files.');
      return out.toString();
    }
    const result = changesWithImpact(index, changes);
    starts = result.changed;
    impacted = result.impact.impacted;
    routes = result.impact.routes;
    tests = result.impact.tests;
    const s = result.impact;
    out.push(
      `Summary: ${plural(changes.files.length, 'changed file')} · ${plural(s.changedEntities.length, 'changed entity', 'changed entities')} · ${impacted.length} could be affected · ${plural(routes.length, 'HTTP route')} · ${plural(tests.length, 'test file')}`,
    );
    out.section(`Changed (${starts.length})`);
    out.list(
      starts,
      max,
      (n) =>
        n.kind === 'file'
          ? `${tick(nameOf(n))} file (top-level code, new or renamed file)`
          : describe(n),
      RAISE,
    );
    if (s.outsideGraph.length) {
      out.section(
        `Changed outside the graph (${s.outsideGraph.length}: deleted, not JS/TS, or not analyzed)`,
      );
      out.list(s.outsideGraph, max, (f) => `${tick(f.file)} (${f.status})`, RAISE);
    }
  }

  out.section(
    `Could be affected (${impacted.length}) — by distance, proven calls/imports/inheritance only`,
  );
  if (!impacted.length) out.push('Nothing known depends on it through proven relationships.');
  out.list(
    impacted,
    max,
    (i) => {
      const via = index.node(i.via.target);
      return `[d${i.depth}] ${describe(i.node)} — ${VERBS[i.via.kind]}${qualifier(i.via)} ${tick(via ? nameOf(via) : i.via.target)} at ${evidenceOf(i.via)}`;
    },
    RAISE,
  );
  if (routes.length) {
    out.section(`HTTP routes involved (${routes.length})`);
    out.list(
      routes,
      max,
      (n) =>
        `${tick(routeLabel(n))} · ${whereOf(n)}${n.meta?.fullPath ? '' : ' (full path unknown)'}`,
      RAISE,
    );
  }
  if (tests.length) {
    out.section(`Test files to run (${tests.length})`);
    out.list(tests, max, (n) => tick(nameOf(n)), RAISE);
  }
  // chamadas por interface ou método abstrato que podem cair no que mudou
  const seeds = new Set<string>();
  for (const n of starts) {
    seeds.add(n.id);
    if (n.kind === 'file' || n.kind === 'class' || n.kind === 'module')
      for (const d of index.descendants(n.id)) seeds.add(d.id);
  }
  const possible = [...seeds].flatMap((id) =>
    possibleCallers(index, id).map((p) => ({ ...p, target: id })),
  );
  if (possible.length) {
    out.section(
      `Possibly affected (${possible.length}; NOT proven — calls through interfaces/abstract methods that may dispatch to it)`,
    );
    out.list(
      possible,
      max,
      (p) =>
        `${describe(p.caller)} via ${tick(p.via.meta?.reference ?? p.via.name)} → maybe ${tick(nameOf(index.node(p.target)!))} — ${evidenceOf(p.edge)}`,
      RAISE,
    );
  }
  out.push(
    '',
    '_Unresolved references (callbacks, dynamic calls, untyped receivers) are not followed: something may depend on this without appearing here._',
  );
  return out.toString();
}

// ---- path

function pathTool(args: Args, ctx: ToolContext): string {
  const { index } = ctx.snapshot;
  const from = resolveTarget(ctx.snapshot, String(args.from));
  const to = resolveTarget(ctx.snapshot, String(args.to));
  const max = num(args, 'limit', 3);
  const out = new Out().push(`# Paths from ${describe(from)} to ${describe(to)}`);
  if (from.id === to.id) return out.push('Both arguments are the same entity.').toString();
  const search = findPaths(index, from.id, to.id, { limit: max });
  const render = (p: PathResult, n: number) => {
    out.push('', `Path ${n} (${plural(p.edges.length, 'step')}):`);
    p.edges.forEach((e, i) => {
      const a = index.node(e.source);
      const b = index.node(e.target);
      out.push(
        `${i + 1}. ${a ? tick(nameOf(a)) : tick(e.source)} ${VERBS[e.kind]}${qualifier(e)} ${b ? describe(b) : tick(e.target)} — ${evidenceOf(e)}`,
      );
    });
  };
  if (search.paths.length && !search.reversed) {
    out.push(
      `${plural(search.paths.length, 'proven path')} (calls, imports and inheritance; shortest first):`,
    );
    search.paths.forEach((p, i) => render(p, i + 1));
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
  return out.toString();
}

// ---- routes

const FRAMEWORKS = ['express', 'fastify', 'hono', 'nestjs', 'next'] as const;

function routes(args: Args, ctx: ToolContext): string {
  const { index } = ctx.snapshot;
  const filter = typeof args.filter === 'string' ? args.filter.toLowerCase() : '';
  const method = typeof args.method === 'string' ? args.method.toUpperCase() : undefined;
  const framework = args.framework as string | undefined;
  const max = num(args, 'limit', 100);
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
    method && `method ${method}`,
    framework && `framework ${framework}`,
  ].filter(Boolean);
  const out = new Out().push(
    `# HTTP routes: ${matches.length} of ${all.length}${filters.length ? ` (${filters.join(', ')})` : ''}`,
  );
  if (!matches.length) return out.push('No route matches.').toString();
  out.list(
    matches,
    max,
    (n) => {
      const note = routePathNote(n);
      return `${tick(routeLabel(n))} — ${n.meta?.framework ?? '?'}${n.meta?.routeKind ? ` ${n.meta.routeKind}` : ''} · defined at ${whereOf(n)} · handler: ${routeHandler(index, n)}${note ? ` · ${note}` : ''}`;
    },
    RAISE,
  );
  return out.toString();
}

// ---------------------------------------------------------------------------

export const TOOLS: ToolDefinition[] = [
  {
    name: 'rastro_overview',
    title: 'Project overview',
    description:
      'Summary of the analyzed JavaScript/TypeScript project: size, entity counts, main folders, HTTP routes, the most called functions, central files, possibly unused code, analysis diagnostics and freshness. Call this first to get oriented in an unfamiliar codebase.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: overview,
  },
  {
    name: 'rastro_search',
    title: 'Search entities',
    description:
      'Find functions, classes, methods, files, folders, HTTP routes and external packages by name, qualified name (`Class.method`) or file path (case-insensitive; exact names rank first). Returns ids and file:line to pass to the other rastro tools. It searches names, not code text: use grep for string literals and comments.',
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
      'Everything Rastro knows about one entity: kind, location, parent chain, export status, members, proven callers and callees (counts and top entries with file:line evidence), imports and importers for files, inheritance, HTTP route details, and possible (unproven) relationships listed separately. Set `source: true` to include its code (up to 120 lines, read from the analyzed file on disk).',
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
      'Who uses an entity and what it uses — callers/callees, importers/imports, exports, subclasses — each with evidence (file:line and the line of code). Grouped into PROVEN (resolved by the TypeScript checker or a framework rule), EXTERNAL (packages outside the project) and POSSIBLE (unresolved calls through interfaces, abstract methods or callbacks, with candidate targets: not facts). `direction`: incoming (default: who calls/imports it), outgoing (what it calls/imports) or both. `depth` 2-3 follows proven relationships transitively.',
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
      'What could break: the blast radius of a change. Pass `targets` (entities you plan to change), or omit them to use git: uncommitted changes (default) or, with `since` (e.g. `main`), everything changed since the current branch forked from that ref. Returns the changed entities, what depends on them by distance (each with the proven relationship and the file:line that links it), HTTP routes involved, test files to run, and callers that may be affected through interfaces (marked as unproven).',
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
        limit: limit(200, 30),
      },
      additionalProperties: false,
    },
    run: impact,
  },
  {
    name: 'rastro_path',
    title: 'How A reaches B',
    description:
      'How does A reach B? Shortest chains of proven calls, imports and inheritance from `from` to `to` (up to `limit` alternatives), each step with file:line evidence. When there is no proven path it says so, and reports a path in the opposite direction, a file-level import path, or a possible path through unresolved interface calls (clearly marked as unproven).',
    inputSchema: {
      type: 'object',
      properties: {
        from: target(`Start. ${TARGET_HELP}`),
        to: target(`Destination. ${TARGET_HELP}`),
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
          default: 3,
          description: 'Alternative paths (default 3).',
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
      'HTTP routes found in the code (Express, Fastify, Hono, NestJS, Next.js): method, full path (or why it is unknown, e.g. an unproven mount prefix), framework, handler and file:line. Filter by substring (`filter`, matched against path, handler and file), `method` or `framework`.',
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
      },
      additionalProperties: false,
    },
    run: routes,
  },
];
