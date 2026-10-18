import {
  DISCOVERY_METHODS,
  EDGE_KINDS,
  NODE_KINDS,
  RESOLUTIONS,
  SCHEMA_VERSION,
  type RastroGraph,
} from './model.js';
import type { Lang } from './labels.js';

export interface ValidationResult {
  valid: boolean;
  /** Os problemas encontrados, em texto (português por padrão; veja `ValidateOptions.lang`). */
  errors: string[];
}

/**
 * Textos dos problemas de validação em português e inglês, montados a partir do código e dos
 * parâmetros. `field` é o caminho do campo no JSON (ex.: `nodes[3].kind`), igual nos dois
 * idiomas. Quem precisa trocar de idioma depois (a interface) guarda os problemas de
 * `graphIssues` e chama `validationText`.
 */
const VALIDATION_TEXTS = {
  'not-object-graph': {
    pt: () => 'O grafo precisa ser um objeto JSON.',
    en: () => 'The graph must be a JSON object.',
  },
  'schema-version': {
    pt: (p) => `schemaVersion deve ser "${p.expected}" (recebido: ${p.received}).`,
    en: (p) => `schemaVersion must be "${p.expected}" (got: ${p.received}).`,
  },
  required: {
    pt: (p) => `${p.field} é obrigatório.`,
    en: (p) => `${p.field} is required.`,
  },
  'not-list': {
    pt: (p) => `${p.field} deve ser uma lista.`,
    en: (p) => `${p.field} must be a list.`,
  },
  'not-counts': {
    pt: (p) => `${p.field} deve ser um objeto de contagens.`,
    en: (p) => `${p.field} must be an object of counts.`,
  },
  'not-list-of-lists': {
    pt: (p) => `${p.field} deve ser uma lista de listas.`,
    en: (p) => `${p.field} must be a list of lists.`,
  },
  'not-non-negative-int': {
    pt: (p) => `${p.field} deve ser um inteiro não negativo.`,
    en: (p) => `${p.field} must be a non-negative integer.`,
  },
  'not-non-negative-number': {
    pt: (p) => `${p.field} deve ser um número não negativo.`,
    en: (p) => `${p.field} must be a non-negative number.`,
  },
  'not-positive-int': {
    pt: (p) => `${p.field} deve ser um inteiro positivo.`,
    en: (p) => `${p.field} must be a positive integer.`,
  },
  'not-boolean': {
    pt: (p) => `${p.field} deve ser verdadeiro ou falso.`,
    en: (p) => `${p.field} must be true or false.`,
  },
  'invalid-item': {
    pt: (p) => `${p.field} inválido.`,
    en: (p) => `${p.field} is invalid.`,
  },
  'invalid-changes': {
    pt: () => 'changes inválido (precisa de base, baseLabel, includesUntracked e files).',
    en: () => 'changes is invalid (it needs base, baseLabel, includesUntracked and files).',
  },
  'not-object': {
    pt: (p) => `${p.field} não é um objeto.`,
    en: (p) => `${p.field} is not an object.`,
  },
  missing: {
    pt: (p) => `${p.field} ausente.`,
    en: (p) => `${p.field} is missing.`,
  },
  'duplicate-id': {
    pt: (p) => `${p.field} duplicado: ${p.id}`,
    en: (p) => `duplicate ${p.field}: ${p.id}`,
  },
  'invalid-value': {
    pt: (p) => `${p.field} inválido: ${p.value}`,
    en: (p) => `invalid ${p.field}: ${p.value}`,
  },
  'invalid-resolution': {
    pt: (p) => `${p.field} inválida: ${p.value}`,
    en: (p) => `invalid ${p.field}: ${p.value}`,
  },
  'must-be-object': {
    pt: (p) => `${p.field} deve ser um objeto.`,
    en: (p) => `${p.field} must be an object.`,
  },
  'invalid-location': {
    pt: (p) => `${p.field} inválida em ${p.id}.`,
    en: (p) => `invalid ${p.field} in ${p.id}.`,
  },
  'not-string-list': {
    pt: (p) => `${p.field} deve ser uma lista de textos.`,
    en: (p) => `${p.field} must be a list of strings.`,
  },
  'missing-node': {
    pt: (p) => `${p.field} aponta para nó inexistente: ${p.id}`,
    en: (p) => `${p.field} points to a node that does not exist: ${p.id}`,
  },
  'parent-cycle': {
    pt: (p) => `ciclo na hierarquia (parent) envolvendo ${p.id}.`,
    en: (p) => `cycle in the hierarchy (parent) involving ${p.id}.`,
  },
  'missing-endpoint': {
    pt: (p) => `${p.field} inexistente: ${p.id}`,
    en: (p) => `${p.field} does not exist: ${p.id}`,
  },
  'invalid-evidence': {
    pt: (p) => `${p.field} contém item inválido (${p.id}).`,
    en: (p) => `${p.field} has an invalid item (${p.id}).`,
  },
} satisfies Record<string, Record<Lang, (p: Record<string, string | number>) => string>>;

export type ValidationCode = keyof typeof VALIDATION_TEXTS;

/** Um problema encontrado pela validação, independente de idioma. */
export interface ValidationIssue {
  code: ValidationCode;
  params: Record<string, string | number>;
}

/** Texto de um problema de validação no idioma pedido. */
export function validationText(issue: ValidationIssue, lang: Lang): string {
  const texts = Object.hasOwn(VALIDATION_TEXTS, issue.code)
    ? VALIDATION_TEXTS[issue.code]
    : undefined;
  return texts ? texts[lang](issue.params) : issue.code;
}

export interface ValidateOptions {
  /** Máximo de problemas guardados (padrão: 50). */
  maxErrors?: number;
  /** Idioma de `errors` (padrão: português, como sempre foi). */
  lang?: Lang;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isPositiveInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 1;

const DIAGNOSTIC_LEVELS = new Set(['info', 'warning', 'error']);
const CHANGE_STATUSES = new Set(['added', 'modified', 'deleted', 'renamed']);

/**
 * Valida a estrutura de um grafo e sua integridade referencial
 * (toda relação aponta para nós existentes, ids são únicos, localizações são coerentes).
 * Complementa o JSON Schema em `schema/rastro-graph.schema.json`, que não consegue
 * expressar regras entre nós e relações. Devolve os problemas como códigos e parâmetros;
 * `validateGraph` devolve os mesmos problemas já em texto.
 */
export function graphIssues(
  input: unknown,
  maxErrors = 50,
): { valid: boolean; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  // separado da lista: com `maxErrors` 0 nada é guardado, mas o grafo continua inválido
  let failed = false;
  const fail = (code: ValidationCode, params: Record<string, string | number> = {}) => {
    failed = true;
    if (issues.length < maxErrors) issues.push({ code, params });
  };

  if (!isObject(input)) {
    fail('not-object-graph');
    return { valid: false, issues };
  }
  if (input.schemaVersion !== SCHEMA_VERSION)
    fail('schema-version', {
      expected: SCHEMA_VERSION,
      received: String(JSON.stringify(input.schemaVersion)),
    });
  if (typeof input.generatedAt !== 'string') fail('required', { field: 'generatedAt' });
  // `tool` e `analyzer` sempre foram gravados (desde a 0.1.0); sem eles, `compare` e a
  // interface quebravam ao ler a versão
  if (!isObject(input.tool)) fail('required', { field: 'tool' });
  else {
    if (input.tool.name !== 'rastro')
      fail('invalid-value', { field: 'tool.name', value: String(JSON.stringify(input.tool.name)) });
    if (typeof input.tool.version !== 'string') fail('required', { field: 'tool.version' });
  }
  if (!isObject(input.project) || typeof input.project.name !== 'string')
    fail('required', { field: 'project.name' });
  if (!isObject(input.project) || typeof input.project.root !== 'string')
    fail('required', { field: 'project.root' });
  if (!isObject(input.analyzer)) fail('required', { field: 'analyzer' });
  else {
    const analyzer = input.analyzer;
    for (const key of ['name', 'version', 'typescriptVersion'])
      if (typeof analyzer[key] !== 'string') fail('required', { field: `analyzer.${key}` });
    if (!isObject(analyzer.options)) fail('required', { field: 'analyzer.options' });
    else {
      const options = analyzer.options;
      if (!Array.isArray(options.exclude) || !options.exclude.every((e) => typeof e === 'string'))
        fail('not-string-list', { field: 'analyzer.options.exclude' });
      if (typeof options.respectGitignore !== 'boolean')
        fail('not-boolean', { field: 'analyzer.options.respectGitignore' });
      for (const key of ['maxFiles', 'maxFileSizeBytes'])
        if (!isPositiveInt(options[key]))
          fail('not-positive-int', { field: `analyzer.options.${key}` });
    }
  }
  if (!Array.isArray(input.nodes)) fail('not-list', { field: 'nodes' });
  if (!Array.isArray(input.edges)) fail('not-list', { field: 'edges' });
  if (!isObject(input.stats)) fail('required', { field: 'stats' });
  else {
    const stats = input.stats;
    for (const key of ['nodesByKind', 'edgesByKind', 'edgesByResolution'])
      if (!isObject(stats[key]) || !Object.values(stats[key]).every((v) => Number.isInteger(v)))
        fail('not-counts', { field: `stats.${key}` });
    if (!Array.isArray(stats.importCycles) || !stats.importCycles.every((c) => Array.isArray(c)))
      fail('not-list-of-lists', { field: 'stats.importCycles' });
    for (const key of [
      'files',
      'externalCallsSkipped',
      'unknownReceiverCalls',
      'computedCalls',
      'localCalls',
    ])
      if (!Number.isInteger(stats[key]) || (stats[key] as number) < 0)
        fail('not-non-negative-int', { field: `stats.${key}` });
    // a duração é número (não precisa ser inteiro), como no JSON Schema
    if (
      typeof stats.durationMs !== 'number' ||
      !Number.isFinite(stats.durationMs) ||
      stats.durationMs < 0
    )
      fail('not-non-negative-number', { field: 'stats.durationMs' });
  }
  if (!Array.isArray(input.diagnostics)) fail('not-list', { field: 'diagnostics' });
  else
    for (const [i, d] of input.diagnostics.entries())
      if (
        !isObject(d) ||
        typeof d.code !== 'string' ||
        typeof d.message !== 'string' ||
        !DIAGNOSTIC_LEVELS.has(d.level as string) ||
        (d.params !== undefined &&
          (!isObject(d.params) ||
            !Object.values(d.params).every((v) => typeof v === 'string' || typeof v === 'number')))
      )
        fail('invalid-item', { field: `diagnostics[${i}]` });
  if (input.changes !== undefined) {
    const changes = input.changes;
    if (
      !isObject(changes) ||
      typeof changes.base !== 'string' ||
      typeof changes.baseLabel !== 'string' ||
      typeof changes.includesUntracked !== 'boolean' ||
      !Array.isArray(changes.files)
    )
      fail('invalid-changes');
    else
      for (const [i, f] of changes.files.entries())
        if (
          !isObject(f) ||
          typeof f.file !== 'string' ||
          !CHANGE_STATUSES.has(f.status as string) ||
          (f.previous !== undefined && typeof f.previous !== 'string') ||
          !Array.isArray(f.ranges) ||
          !f.ranges.every(
            (r) =>
              Array.isArray(r) &&
              r.length === 2 &&
              isPositiveInt(r[0]) &&
              isPositiveInt(r[1]) &&
              (r[0] as number) <= (r[1] as number),
          ) ||
          (f.deletionsAt !== undefined &&
            (!Array.isArray(f.deletionsAt) || !f.deletionsAt.every(isPositiveInt)))
        )
          fail('invalid-item', { field: `changes.files[${i}]` });
  }
  if (!isObject(input.project) || !Array.isArray(input.project.languages))
    fail('not-list', { field: 'project.languages' });
  if (failed) return { valid: false, issues };

  const graph = input as unknown as RastroGraph;
  const ids = new Set<string>();
  const nodeKinds = new Set<string>(NODE_KINDS);

  for (const [i, node] of graph.nodes.entries()) {
    const at = `nodes[${i}]`;
    if (!isObject(node)) {
      fail('not-object', { field: at });
      continue;
    }
    if (typeof node.id !== 'string' || !node.id) fail('missing', { field: `${at}.id` });
    else if (ids.has(node.id)) fail('duplicate-id', { field: `${at}.id`, id: node.id });
    else ids.add(node.id);
    if (!nodeKinds.has(node.kind))
      fail('invalid-value', { field: `${at}.kind`, value: String(node.kind) });
    if (typeof node.name !== 'string') fail('missing', { field: `${at}.name` });
    if (node.meta !== undefined && !isObject(node.meta))
      fail('must-be-object', { field: `${at}.meta` });
    if (node.location !== undefined) {
      const loc = node.location;
      if (
        !isObject(loc) ||
        typeof loc.file !== 'string' ||
        !isPositiveInt(loc.startLine) ||
        !isPositiveInt(loc.endLine) ||
        !isPositiveInt(loc.startColumn) ||
        !isPositiveInt(loc.endColumn) ||
        loc.endLine < loc.startLine
      )
        fail('invalid-location', { field: `${at}.location`, id: String(node.id) });
    }
  }

  // candidatos possíveis (chamadas por interface) também precisam apontar para nós existentes
  for (const [i, node] of graph.nodes.entries()) {
    if (!isObject(node) || !isObject(node.meta)) continue;
    for (const key of ['candidates', 'implements', 'abstractMembers'] as const) {
      const list = node.meta[key];
      if (list !== undefined && (!Array.isArray(list) || !list.every((c) => typeof c === 'string')))
        fail('not-string-list', { field: `nodes[${i}].meta.${key}` });
    }
    for (const candidate of Array.isArray(node.meta.candidates) ? node.meta.candidates : [])
      if (typeof candidate === 'string' && !ids.has(candidate))
        fail('missing-node', { field: `nodes[${i}].meta.candidates`, id: candidate });
  }

  const parentOf = new Map<string, string>();
  for (const [i, node] of graph.nodes.entries()) {
    if (!isObject(node) || node.parent === undefined) continue;
    if (!ids.has(node.parent))
      fail('missing-node', { field: `nodes[${i}].parent`, id: String(node.parent) });
    else parentOf.set(node.id, node.parent);
  }
  // a hierarquia precisa ser uma árvore: um ciclo de "parent" travaria quem percorre ancestrais
  const checked = new Set<string>();
  for (const start of parentOf.keys()) {
    const path = new Set<string>();
    for (let cur: string | undefined = start; cur && !checked.has(cur); cur = parentOf.get(cur)) {
      if (path.has(cur)) {
        fail('parent-cycle', { id: cur });
        break;
      }
      path.add(cur);
    }
    for (const id of path) checked.add(id);
  }

  const edgeIds = new Set<string>();
  const edgeKinds = new Set<string>(EDGE_KINDS);
  const resolutions = new Set<string>(RESOLUTIONS);
  const discoveries = new Set<string>(DISCOVERY_METHODS);

  for (const [i, edge] of graph.edges.entries()) {
    const at = `edges[${i}]`;
    if (!isObject(edge)) {
      fail('not-object', { field: at });
      continue;
    }
    if (typeof edge.id !== 'string' || !edge.id) fail('missing', { field: `${at}.id` });
    else if (edgeIds.has(edge.id)) fail('duplicate-id', { field: `${at}.id`, id: edge.id });
    else edgeIds.add(edge.id);
    if (!edgeKinds.has(edge.kind))
      fail('invalid-value', { field: `${at}.kind`, value: String(edge.kind) });
    if (edge.meta !== undefined && !isObject(edge.meta))
      fail('must-be-object', { field: `${at}.meta` });
    if (!ids.has(edge.source))
      fail('missing-endpoint', { field: `${at}.source`, id: String(edge.source) });
    if (!ids.has(edge.target))
      fail('missing-endpoint', { field: `${at}.target`, id: String(edge.target) });
    if (!resolutions.has(edge.resolution))
      fail('invalid-resolution', { field: `${at}.resolution`, value: String(edge.resolution) });
    if (!discoveries.has(edge.discovery))
      fail('invalid-value', { field: `${at}.discovery`, value: String(edge.discovery) });
    if (!Array.isArray(edge.evidence)) fail('not-list', { field: `${at}.evidence` });
    else
      for (const ev of edge.evidence)
        if (
          !isObject(ev) ||
          typeof ev.file !== 'string' ||
          !isPositiveInt(ev.line) ||
          !isPositiveInt(ev.column)
        )
          fail('invalid-evidence', { field: `${at}.evidence`, id: String(edge.id) });
  }

  return { valid: !failed, issues };
}

/**
 * Valida um grafo (veja `graphIssues`) e devolve os problemas em texto. O segundo argumento
 * aceita o máximo de problemas (como antes) ou `{ maxErrors, lang }`.
 */
export function validateGraph(
  input: unknown,
  options: number | ValidateOptions = {},
): ValidationResult {
  const { maxErrors = 50, lang = 'pt' } =
    typeof options === 'number' ? { maxErrors: options } : options;
  const { valid, issues } = graphIssues(input, maxErrors);
  return { valid, errors: issues.map((issue) => validationText(issue, lang)) };
}

/** Lê e valida um grafo vindo de JSON, lançando erro descritivo se for inválido. */
export function parseGraph(json: string): RastroGraph {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error(`JSON inválido: ${(err as Error).message}`, { cause: err });
  }
  const result = validateGraph(data);
  if (!result.valid) {
    throw new Error(`Grafo inválido:\n- ${result.errors.join('\n- ')}`);
  }
  return data as RastroGraph;
}
