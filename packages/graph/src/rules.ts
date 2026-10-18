import {
  compareStrings,
  compilePatterns,
  matchesFile,
  matchesPackage,
  parseRules,
  type ChangeSet,
  type EdgeKind,
  type Evidence,
  type GraphNode,
  type RastroGraph,
  type Rule,
  type RuleIssue,
  type RuleSpec,
} from '@rastro/core';
import { stronglyConnectedComponents } from './cycles.js';
import type { GraphIndex } from './query.js';

/**
 * Uma dependência entre arquivos que quebra uma regra: todas as relações de `from` para `to`
 * (import, chamada, herança), com as evidências. Num ciclo, `cycle` é o caminho que fecha.
 */
export interface RuleViolation {
  /** Arquivo de origem (relativo à raiz). */
  from: string;
  /** Arquivo ou pacote de destino. Num ciclo, o próprio `from`. */
  to: string;
  package: boolean;
  kinds: EdgeKind[];
  /** Onde aparece, em ordem de linha (até 20). */
  evidence: Evidence[];
  /** Quantas vezes aparece (pode passar do número de evidências). */
  count: number;
  /** Só imports de tipo (`import type`). */
  typeOnly: boolean;
  /**
   * Só existe por chamadas não resolvidas (por interface ou método abstrato) que _podem_ ir
   * para o destino: nunca reprova, é uma pista.
   */
  possible: boolean;
  /** Ids das relações do grafo que formam a violação (para destacar no mapa). */
  edges: string[];
  /** Num ciclo: cada arquivo e o import que leva ao próximo (o último volta ao primeiro). */
  cycle?: Array<{ file: string; evidence?: Evidence }>;
  /** Num ciclo: quantos arquivos dependem uns dos outros nele (pode ser mais que o caminho). */
  cycleSize?: number;
  /** Com mudanças do git: alguma evidência está numa linha alterada pela mudança. */
  introduced?: boolean;
}

export interface RuleOutcome {
  rule: Rule;
  violations: RuleViolation[];
  possible: RuleViolation[];
  /** Arquivos analisados a que a regra se aplica (zero costuma ser um padrão errado). */
  files: number;
}

export interface RulesCheck {
  outcomes: RuleOutcome[];
  /** Violações comprovadas de regras `error` e `warning`. */
  errors: number;
  warnings: number;
  /** Violações possíveis (chamadas não resolvidas), de qualquer regra. */
  possible: number;
  /** Com mudanças do git: as violações com evidência em linhas alteradas. */
  introduced?: { errors: number; warnings: number };
}

const DEPENDENCY_KINDS = new Set<EdgeKind>(['imports', 'calls', 'extends']);
const MAX_EVIDENCE = 20;
const KIND_ORDER: EdgeKind[] = ['imports', 'calls', 'extends'];

/** Caminho relativo de um nó de arquivo. */
export const filePathOf = (file: GraphNode) =>
  file.location?.file ?? file.qualifiedName ?? file.name;

/** Uma relação do grafo vista como dependência entre arquivos. */
interface DepEdge {
  from: string;
  to: string;
  package: boolean;
  kind: EdgeKind;
  typeOnly: boolean;
  possible: boolean;
  evidence: Evidence[];
  count: number;
  edge: string;
}

function dependencyEdges(index: GraphIndex): DepEdge[] {
  const list: DepEdge[] = [];
  for (const edge of index.edges.values()) {
    if (!DEPENDENCY_KINDS.has(edge.kind)) continue;
    const source = index.fileOf(edge.source);
    if (!source) continue;
    const from = filePathOf(source);
    const base = {
      from,
      kind: edge.kind,
      typeOnly: edge.kind === 'imports' && !!edge.meta?.typeOnly,
      evidence: edge.evidence,
      count: edge.meta?.count ?? Math.max(1, edge.evidence.length),
      edge: edge.id,
    };
    if (edge.resolution === 'resolved') {
      const target = index.fileOf(edge.target);
      if (!target) continue;
      const to = filePathOf(target);
      if (to !== from) list.push({ ...base, to, package: false, possible: false });
    } else if (edge.resolution === 'external') {
      const target = index.node(edge.target);
      if (target?.kind === 'package')
        list.push({ ...base, to: target.name, package: true, possible: false });
    } else {
      // chamada por interface/método abstrato: cada implementação possível é uma pista
      const seen = new Set<string>();
      for (const candidate of index.node(edge.target)?.meta?.candidates ?? []) {
        const target = index.fileOf(candidate);
        if (!target) continue;
        const to = filePathOf(target);
        if (to === from || seen.has(to)) continue;
        seen.add(to);
        list.push({ ...base, to, package: false, possible: true });
      }
    }
  }
  return list;
}

const byLine = (a: Evidence, b: Evidence) =>
  compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;

/** Junta as relações de cada par origem → destino numa violação. */
function group(edges: DepEdge[]): RuleViolation[] {
  const groups = new Map<string, RuleViolation>();
  for (const e of edges) {
    const key = `${e.possible ? 'p' : 'r'}\0${e.package ? 'p' : 'f'}\0${e.from}\0${e.to}`;
    let v = groups.get(key);
    if (!v) {
      v = {
        from: e.from,
        to: e.to,
        package: e.package,
        kinds: [],
        evidence: [],
        count: 0,
        typeOnly: true,
        possible: e.possible,
        edges: [],
      };
      groups.set(key, v);
    }
    if (!v.kinds.includes(e.kind)) v.kinds.push(e.kind);
    v.evidence.push(...e.evidence);
    v.count += e.count;
    v.typeOnly &&= e.typeOnly;
    v.edges.push(e.edge);
  }
  const result = [...groups.values()];
  for (const v of result) {
    v.evidence = dedupeEvidence(v.evidence).sort(byLine).slice(0, MAX_EVIDENCE);
    v.kinds.sort((x, y) => KIND_ORDER.indexOf(x) - KIND_ORDER.indexOf(y));
  }
  // o que já é comprovado não aparece de novo como possível
  const proven = new Set(result.filter((v) => !v.possible).map((v) => `${v.from}\0${v.to}`));
  return result
    .filter((v) => !v.possible || !proven.has(`${v.from}\0${v.to}`))
    .sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to));
}

function dedupeEvidence(list: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return list.filter((e) => {
    const key = `${e.file}:${e.line}:${e.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Lê e confere as regras guardadas no grafo (`undefined` quando o projeto não tem regras). */
export function graphRules(
  graph: RastroGraph,
): { rules?: Rule[]; issues: RuleIssue[] } | undefined {
  if (!graph.rules) return undefined;
  if (graph.rules.issues?.length) return { issues: graph.rules.issues };
  return parseRules(graph.rules.config);
}

/**
 * Confere as regras no grafo. Só relações comprovadas (resolvidas ou para pacotes externos)
 * reprovam; chamadas não resolvidas com implementações possíveis viram `possible`. Com as
 * mudanças do git, marca as violações com evidência numa linha alterada (`introduced`).
 */
export function checkRules(index: GraphIndex, rules: Rule[], changes?: ChangeSet): RulesCheck {
  const deps = dependencyEdges(index);
  const analyzed = [...index.nodes.values()]
    .filter((n) => n.kind === 'file' && n.meta?.analyzed !== false)
    .map(filePathOf);
  const changedLines = changes ? changedLineIndex(changes) : undefined;
  const isChanged = (e: Evidence | undefined) =>
    !!e && !!changedLines?.get(e.file)?.some(([a, b]) => e.line >= a && e.line <= b);

  const outcomes = rules.map((rule): RuleOutcome => {
    const from = compilePatterns(rule.from);
    const except = compilePatterns(rule.except);
    const memo = new Map<string, boolean>();
    const inScope = (file: string) => {
      let hit = memo.get(file);
      if (hit === undefined) {
        hit = matchesFile(from, file) && !matchesFile(except, file);
        memo.set(file, hit);
      }
      return hit;
    };
    const files = analyzed.filter(inScope).length;

    let found: RuleViolation[];
    if (rule.kind === 'cycles') {
      found = cycleViolations(deps, inScope, changedLines ? isChanged : undefined);
    } else {
      const targets = compilePatterns(rule.targets);
      const hits = deps.filter((e) => {
        if (!inScope(e.from) || (rule.ignoreTypeImports && e.typeOnly)) return false;
        const listed = e.package ? matchesPackage(targets, e.to) : matchesFile(targets, e.to);
        // allow: o que não está na lista nem é da própria regra (`from`) quebra a regra
        return rule.kind === 'deny' ? listed : !listed && (e.package || !inScope(e.to));
      });
      found = group(hits);
    }
    if (changedLines)
      for (const v of found)
        v.introduced ??=
          v.evidence.some(isChanged) || !!v.cycle?.some((s) => isChanged(s.evidence));
    return {
      rule,
      violations: found.filter((v) => !v.possible),
      possible: found.filter((v) => v.possible),
      files,
    };
  });

  const count = (severity: Rule['severity'], onlyIntroduced: boolean) =>
    outcomes
      .filter((o) => o.rule.severity === severity)
      .reduce((n, o) => n + o.violations.filter((v) => !onlyIntroduced || v.introduced).length, 0);
  return {
    outcomes,
    errors: count('error', false),
    warnings: count('warning', false),
    possible: outcomes.reduce((n, o) => n + o.possible.length, 0),
    ...(changes
      ? { introduced: { errors: count('error', true), warnings: count('warning', true) } }
      : {}),
  };
}

function changedLineIndex(changes: ChangeSet): Map<string, Array<[number, number]>> {
  const map = new Map<string, Array<[number, number]>>();
  for (const file of changes.files) if (file.status !== 'deleted') map.set(file.file, file.ranges);
  return map;
}

/**
 * Ciclos de importação entre os arquivos da regra (imports só de tipo não contam: somem na
 * execução). Cada grupo de arquivos que dependem uns dos outros é uma violação; o caminho
 * mostrado é o ciclo mais curto (passando por um import alterado, se houver).
 */
function cycleViolations(
  deps: DepEdge[],
  inScope: (file: string) => boolean,
  isChanged?: (e: Evidence | undefined) => boolean,
): RuleViolation[] {
  const step = new Map<string, DepEdge>();
  const adjacency = new Map<string, string[]>();
  for (const e of deps) {
    if (e.kind !== 'imports' || e.package || e.possible || e.typeOnly) continue;
    if (!inScope(e.from) || !inScope(e.to)) continue;
    const key = `${e.from}\0${e.to}`;
    if (step.has(key)) continue;
    step.set(key, e);
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from)!.push(e.to);
  }
  for (const list of adjacency.values()) list.sort(compareStrings);

  const violations: RuleViolation[] = [];
  for (const scc of stronglyConnectedComponents(adjacency)) {
    if (scc.length < 2) continue;
    const members = new Set(scc);
    // com mudanças: o ciclo mostrado passa pelo import alterado (o que provavelmente o criou)
    let closing: DepEdge | undefined;
    if (isChanged)
      closing = [...step.values()]
        .filter((e) => members.has(e.from) && members.has(e.to) && e.evidence.some(isChanged))
        .sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to))[0];
    const start = closing ? closing.to : [...scc].sort(compareStrings)[0]!;
    const end = closing ? closing.from : undefined;
    const path = shortestCycle(adjacency, members, start, end);
    if (!path) continue;
    const cycle = path.map((file, i) => {
      const next = path[(i + 1) % path.length]!;
      const evidence = step.get(`${file}\0${next}`)?.evidence[0];
      return { file, ...(evidence ? { evidence } : {}) };
    });
    const edges = path.map((file, i) => step.get(`${file}\0${path[(i + 1) % path.length]}`)!);
    violations.push({
      from: path[0]!,
      to: path[0]!,
      package: false,
      kinds: ['imports'],
      evidence: cycle.flatMap((s) => (s.evidence ? [s.evidence] : [])),
      count: path.length,
      typeOnly: false,
      possible: false,
      edges: edges.map((e) => e.edge),
      cycle,
      cycleSize: scc.length,
      ...(isChanged
        ? {
            introduced: [...step.values()].some(
              (e) => members.has(e.from) && members.has(e.to) && e.evidence.some(isChanged),
            ),
          }
        : {}),
    });
  }
  return violations.sort((a, b) => compareStrings(a.from, b.from));
}

/**
 * Caminho mais curto de `start` até voltar a ele, dentro do grupo. Com `end`, o caminho vai
 * de `start` até `end` (e o import `end → start` fecha o ciclo).
 */
function shortestCycle(
  adjacency: Map<string, string[]>,
  members: Set<string>,
  start: string,
  end?: string,
): string[] | undefined {
  const previous = new Map<string, string>();
  const seen = new Set([start]);
  const queue = [start];
  const pathTo = (node: string) => {
    const path = [node];
    for (let p = previous.get(node); p !== undefined; p = previous.get(p)) path.push(p);
    return path.reverse();
  };
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    if (end !== undefined && current === end) return pathTo(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!members.has(next)) continue;
      if (end === undefined && next === start) return pathTo(current);
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, current);
      queue.push(next);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Regras sugeridas a partir da arquitetura atual

/** Padrões dos arquivos de teste (os mesmos de `isTestFile`). */
export const TEST_PATTERNS = ['**/{__tests__,test,tests,spec,e2e}/**', '**/*.{test,spec,e2e}.*'];

export interface SuggestionNames {
  /** Nome da regra "a pasta `folder` não depende de `above`". */
  layer(folder: string, above: string[]): string;
  noCycles: string;
  tests: string;
}

/**
 * Regras que o projeto já cumpre hoje, para travar a arquitetura atual:
 * - camadas: entre as pastas principais, se A usa B (direta ou indiretamente) e B nunca usa A,
 *   B não pode passar a depender de A (o código de teste não conta); numa pasta que só agrupa
 *   outras (`packages/` de um monorepo), também entre as pastas de dentro;
 * - nenhum ciclo de importação, se não houver nenhum hoje;
 * - o código (fora dos testes) não depende de testes, se já for assim.
 * Toda regra sugerida é conferida: nenhuma começa violada.
 */
export function suggestRules(index: GraphIndex, names: SuggestionNames): RuleSpec[] {
  const files = [...index.nodes.values()]
    .filter((n) => n.kind === 'file' && n.meta?.analyzed !== false)
    .map(filePathOf)
    .sort(compareStrings);
  const tests = compilePatterns(TEST_PATTERNS);
  const isTest = (f: string) => matchesFile(tests, f);
  const specs: RuleSpec[] = [];

  // a base das camadas: desce enquanto todo o código (fora da raiz) está numa pasta só
  let base = '';
  for (;;) {
    const prefix = base ? `${base}/` : '';
    const children = new Set(
      files
        .filter((f) => f.startsWith(prefix) && f.slice(prefix.length).includes('/'))
        .map((f) => f.slice(prefix.length).split('/')[0]!),
    );
    if (children.size !== 1) break;
    base = `${prefix}${[...children][0]}`;
  }
  const production = files.filter((f) => !isTest(f));
  const deps = dependencyEdges(index).filter((e) => !e.package && !e.possible && !isTest(e.from));
  /** As pastas com código logo abaixo de `folder` (sem as de teste). */
  const childFolders = (folder: string) => {
    const prefix = folder ? `${folder}/` : '';
    return [
      ...new Set(
        production
          .filter((f) => f.startsWith(prefix) && f.slice(prefix.length).includes('/'))
          .map((f) => `${prefix}${f.slice(prefix.length).split('/')[0]}`),
      ),
    ]
      .filter((l) => !isTest(`${l}/x.ts`))
      .sort(compareStrings);
  };
  /** Camadas entre as pastas logo abaixo de `folder`: B não depende de quem já usa B. */
  const layersUnder = (folder: string) => {
    const layers = childFolders(folder);
    if (layers.length < 2) return;
    const prefix = folder ? `${folder}/` : '';
    const layerOf = (f: string) =>
      f.startsWith(prefix) && f.slice(prefix.length).includes('/')
        ? `${prefix}${f.slice(prefix.length).split('/')[0]}`
        : undefined;
    const uses = new Map(layers.map((l) => [l, new Set<string>()]));
    for (const e of deps) {
      const a = layerOf(e.from);
      const b = layerOf(e.to);
      if (a && b && a !== b && uses.has(a) && uses.has(b)) uses.get(a)!.add(b);
    }
    const reaches = new Map<string, Set<string>>();
    for (const layer of layers) {
      const seen = new Set<string>();
      const stack = [...uses.get(layer)!];
      while (stack.length) {
        const next = stack.pop()!;
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(...uses.get(next)!);
      }
      reaches.set(layer, seen);
    }
    for (const layer of layers) {
      const above = layers.filter(
        (other) =>
          other !== layer && reaches.get(other)!.has(layer) && !reaches.get(layer)!.has(other),
      );
      if (above.length)
        specs.push({
          name: names.layer(layer, above),
          from: layer,
          except: TEST_PATTERNS,
          deny: above,
        });
    }
    return layers;
  };
  const top = layersUnder(base) ?? [];
  // pastas que só agrupam outras (`packages/`, `apps/` num monorepo): as camadas de verdade
  // estão um nível abaixo
  for (const layer of top) {
    const direct = production.some(
      (f) => f.startsWith(`${layer}/`) && !f.slice(layer.length + 1).includes('/'),
    );
    if (!direct) layersUnder(layer);
  }
  specs.push({ name: names.noCycles, noCycles: true });
  if (files.some(isTest))
    specs.push({ name: names.tests, from: '**', except: TEST_PATTERNS, deny: TEST_PATTERNS });

  // só fica o que o código já cumpre
  const parsed = parseRules({ rules: specs });
  if (!parsed.rules) return [];
  const check = checkRules(index, parsed.rules);
  return specs.filter((_, i) => check.outcomes[i]!.violations.length === 0);
}
