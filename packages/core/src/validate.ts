import {
  DISCOVERY_METHODS,
  EDGE_KINDS,
  NODE_KINDS,
  RESOLUTIONS,
  SCHEMA_VERSION,
  type RastroGraph,
} from './model.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isPositiveInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 1;

/**
 * Valida a estrutura de um grafo e sua integridade referencial
 * (toda relação aponta para nós existentes, ids são únicos, localizações são coerentes).
 * Complementa o JSON Schema em `schema/rastro-graph.schema.json`, que não consegue
 * expressar regras entre nós e relações.
 */
export function validateGraph(input: unknown, maxErrors = 50): ValidationResult {
  const errors: string[] = [];
  const fail = (msg: string) => {
    if (errors.length < maxErrors) errors.push(msg);
  };

  if (!isObject(input)) return { valid: false, errors: ['O grafo precisa ser um objeto JSON.'] };
  if (input.schemaVersion !== SCHEMA_VERSION)
    fail(
      `schemaVersion deve ser "${SCHEMA_VERSION}" (recebido: ${JSON.stringify(input.schemaVersion)}).`,
    );
  if (!isObject(input.project) || typeof input.project.root !== 'string')
    fail('project.root é obrigatório.');
  if (!Array.isArray(input.nodes)) fail('nodes deve ser uma lista.');
  if (!Array.isArray(input.edges)) fail('edges deve ser uma lista.');
  if (!isObject(input.stats)) fail('stats é obrigatório.');
  else {
    const stats = input.stats;
    for (const key of ['nodesByKind', 'edgesByKind', 'edgesByResolution'])
      if (!isObject(stats[key]) || !Object.values(stats[key]).every((v) => Number.isInteger(v)))
        fail(`stats.${key} deve ser um objeto de contagens.`);
    if (!Array.isArray(stats.importCycles) || !stats.importCycles.every((c) => Array.isArray(c)))
      fail('stats.importCycles deve ser uma lista de listas.');
    for (const key of ['files', 'externalCallsSkipped', 'unknownReceiverCalls', 'computedCalls'])
      if (!Number.isInteger(stats[key]) || (stats[key] as number) < 0)
        fail(`stats.${key} deve ser um inteiro não negativo.`);
  }
  if (!Array.isArray(input.diagnostics)) fail('diagnostics deve ser uma lista.');
  else
    for (const [i, d] of input.diagnostics.entries())
      if (!isObject(d) || typeof d.code !== 'string' || typeof d.message !== 'string')
        fail(`diagnostics[${i}] inválido.`);
  if (input.changes !== undefined) {
    const changes = input.changes;
    if (!isObject(changes) || typeof changes.base !== 'string' || !Array.isArray(changes.files))
      fail('changes inválido (precisa de base e files).');
    else
      for (const [i, f] of changes.files.entries())
        if (
          !isObject(f) ||
          typeof f.file !== 'string' ||
          !Array.isArray(f.ranges) ||
          !f.ranges.every(
            (r) => Array.isArray(r) && r.length === 2 && isPositiveInt(r[0]) && isPositiveInt(r[1]),
          )
        )
          fail(`changes.files[${i}] inválido.`);
  }
  if (!isObject(input.project) || !Array.isArray(input.project.languages))
    fail('project.languages deve ser uma lista.');
  if (errors.length) return { valid: false, errors };

  const graph = input as unknown as RastroGraph;
  const ids = new Set<string>();
  const nodeKinds = new Set<string>(NODE_KINDS);

  for (const [i, node] of graph.nodes.entries()) {
    const at = `nodes[${i}]`;
    if (!isObject(node)) {
      fail(`${at} não é um objeto.`);
      continue;
    }
    if (typeof node.id !== 'string' || !node.id) fail(`${at}.id ausente.`);
    else if (ids.has(node.id)) fail(`${at}.id duplicado: ${node.id}`);
    else ids.add(node.id);
    if (!nodeKinds.has(node.kind)) fail(`${at}.kind inválido: ${String(node.kind)}`);
    if (typeof node.name !== 'string') fail(`${at}.name ausente.`);
    if (node.meta !== undefined && !isObject(node.meta)) fail(`${at}.meta deve ser um objeto.`);
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
        fail(`${at}.location inválida em ${node.id}.`);
    }
  }

  // candidatos possíveis (chamadas por interface) também precisam apontar para nós existentes
  for (const [i, node] of graph.nodes.entries()) {
    if (!isObject(node) || !isObject(node.meta)) continue;
    for (const key of ['candidates', 'implements'] as const) {
      const list = node.meta[key];
      if (list !== undefined && (!Array.isArray(list) || !list.every((c) => typeof c === 'string')))
        fail(`nodes[${i}].meta.${key} deve ser uma lista de textos.`);
    }
    for (const candidate of Array.isArray(node.meta.candidates) ? node.meta.candidates : [])
      if (typeof candidate === 'string' && !ids.has(candidate))
        fail(`nodes[${i}].meta.candidates aponta para nó inexistente: ${candidate}`);
  }

  const parentOf = new Map<string, string>();
  for (const [i, node] of graph.nodes.entries()) {
    if (!isObject(node) || node.parent === undefined) continue;
    if (!ids.has(node.parent))
      fail(`nodes[${i}].parent aponta para nó inexistente: ${node.parent}`);
    else parentOf.set(node.id, node.parent);
  }
  // a hierarquia precisa ser uma árvore: um ciclo de "parent" travaria quem percorre ancestrais
  const checked = new Set<string>();
  for (const start of parentOf.keys()) {
    const path = new Set<string>();
    for (let cur: string | undefined = start; cur && !checked.has(cur); cur = parentOf.get(cur)) {
      if (path.has(cur)) {
        fail(`ciclo na hierarquia (parent) envolvendo ${cur}.`);
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
      fail(`${at} não é um objeto.`);
      continue;
    }
    if (typeof edge.id !== 'string' || !edge.id) fail(`${at}.id ausente.`);
    else if (edgeIds.has(edge.id)) fail(`${at}.id duplicado: ${edge.id}`);
    else edgeIds.add(edge.id);
    if (!edgeKinds.has(edge.kind)) fail(`${at}.kind inválido: ${String(edge.kind)}`);
    if (edge.meta !== undefined && !isObject(edge.meta)) fail(`${at}.meta deve ser um objeto.`);
    if (!ids.has(edge.source)) fail(`${at}.source inexistente: ${edge.source}`);
    if (!ids.has(edge.target)) fail(`${at}.target inexistente: ${edge.target}`);
    if (!resolutions.has(edge.resolution))
      fail(`${at}.resolution inválida: ${String(edge.resolution)}`);
    if (!discoveries.has(edge.discovery))
      fail(`${at}.discovery inválido: ${String(edge.discovery)}`);
    if (!Array.isArray(edge.evidence)) fail(`${at}.evidence deve ser uma lista.`);
    else
      for (const ev of edge.evidence)
        if (
          !isObject(ev) ||
          typeof ev.file !== 'string' ||
          !isPositiveInt(ev.line) ||
          !isPositiveInt(ev.column)
        )
          fail(`${at}.evidence contém item inválido (${edge.id}).`);
  }

  return { valid: errors.length === 0, errors };
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
