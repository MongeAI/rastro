import {
  compareStrings,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  type RastroGraph,
  type Resolution,
} from '@rastro/core';

/**
 * Diferença entre duas análises (ex.: antes e depois de um PR). Puro e sem APIs do Node,
 * para a interface poder reutilizar. Nós e relações são comparados pelo `id`, que é estável
 * entre análises (`fn:src/math.ts#sum`, `imports:file:a->file:b`).
 */

export interface DiffNode {
  id: string;
  kind: NodeKind;
  name: string;
  /** Nome qualificado (ex.: `UserService.create`) ou caminho, quando houver. */
  qualifiedName?: string;
  /** Arquivo onde o nó está (para arquivos e pastas, o próprio caminho). */
  file?: string;
}

export interface DiffEdge {
  id: string;
  kind: EdgeKind;
  source: string;
  target: string;
  resolution: Resolution;
}

export interface ResolutionChange extends Omit<DiffEdge, 'resolution'> {
  before: Resolution;
  after: Resolution;
}

export interface StatDelta {
  before: number;
  after: number;
  delta: number;
}

/** Números comparados entre as duas análises. */
export const COMPARED_STATS = [
  'files',
  'functions',
  'classes',
  'methods',
  'routes',
  'packages',
  'unresolved',
  'cycles',
  'nodes',
  'edges',
] as const;
export type ComparedStat = (typeof COMPARED_STATS)[number];

export interface GraphDiffSide {
  project: string;
  root: string;
  generatedAt: string;
  toolVersion: string;
}

export interface GraphDiff {
  before: GraphDiffSide;
  after: GraphDiffSide;
  nodes: { added: DiffNode[]; removed: DiffNode[] };
  edges: { added: DiffEdge[]; removed: DiffEdge[]; resolutionChanged: ResolutionChange[] };
  /** Ciclos de importação que surgiram ou deixaram de existir (listas de ids de arquivo). */
  cycles: { added: string[][]; removed: string[][] };
  stats: Record<ComparedStat, StatDelta>;
  /** Nenhum nó, relação ou ciclo entrou, saiu ou mudou. */
  identical: boolean;
}

export interface CompareOptions {
  /**
   * Inclui relações `contains` (hierarquia). Padrão: `false`, pois elas só repetem os nós
   * que entraram ou saíram.
   */
  includeContains?: boolean;
}

const byId = <T extends { id: string }>(a: T, b: T) => compareStrings(a.id, b.id);

function diffNode(node: GraphNode): DiffNode {
  const file =
    node.kind === 'file' || node.kind === 'module'
      ? (node.qualifiedName ?? node.name)
      : node.location?.file;
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    ...(node.qualifiedName ? { qualifiedName: node.qualifiedName } : {}),
    ...(file ? { file } : {}),
  };
}

const diffEdge = (e: GraphEdge): DiffEdge => ({
  id: e.id,
  kind: e.kind,
  source: e.source,
  target: e.target,
  resolution: e.resolution,
});

function statValues(g: RastroGraph): Record<ComparedStat, number> {
  // contados nos próprios nós (um JSON editado à mão pode ter `stats` desatualizado)
  const k: Partial<Record<NodeKind, number>> = {};
  for (const n of g.nodes) k[n.kind] = (k[n.kind] ?? 0) + 1;
  return {
    files: g.nodes.filter((n) => n.kind === 'file' && n.meta?.analyzed !== false).length,
    functions: k.function ?? 0,
    classes: k.class ?? 0,
    methods: k.method ?? 0,
    routes: k.route ?? 0,
    packages: k.package ?? 0,
    // referências que o Rastro não conseguiu comprovar (relações não resolvidas)
    unresolved: g.edges.filter((e) => e.resolution === 'unresolved').length,
    cycles: g.stats.importCycles.length,
    nodes: g.nodes.length,
    edges: g.edges.length,
  };
}

const side = (g: RastroGraph): GraphDiffSide => ({
  project: g.project.name,
  root: g.project.root,
  generatedAt: g.generatedAt,
  toolVersion: g.tool.version,
});

/** Compara duas análises: o que entrou, o que saiu e o que mudou de resolução. */
export function compareGraphs(
  before: RastroGraph,
  after: RastroGraph,
  options: CompareOptions = {},
): GraphDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));
  const nodesAdded = after.nodes.filter((n) => !beforeNodes.has(n.id)).map(diffNode);
  const nodesRemoved = before.nodes.filter((n) => !afterNodes.has(n.id)).map(diffNode);

  const counts = (e: GraphEdge) => options.includeContains || e.kind !== 'contains';
  const beforeEdges = new Map(before.edges.filter(counts).map((e) => [e.id, e]));
  const afterEdges = new Map(after.edges.filter(counts).map((e) => [e.id, e]));
  const edgesAdded: DiffEdge[] = [];
  const resolutionChanged: ResolutionChange[] = [];
  for (const edge of afterEdges.values()) {
    const old = beforeEdges.get(edge.id);
    if (!old) edgesAdded.push(diffEdge(edge));
    else if (old.resolution !== edge.resolution)
      resolutionChanged.push({
        id: edge.id,
        kind: edge.kind,
        source: edge.source,
        target: edge.target,
        before: old.resolution,
        after: edge.resolution,
      });
  }
  const edgesRemoved = [...beforeEdges.values()].filter((e) => !afterEdges.has(e.id)).map(diffEdge);

  const cycleKey = (c: string[]) => [...c].sort(compareStrings).join('\n');
  const beforeCycles = new Set(before.stats.importCycles.map(cycleKey));
  const afterCycles = new Set(after.stats.importCycles.map(cycleKey));
  const sortCycles = (list: string[][]) =>
    list
      .map((c) => [...c].sort(compareStrings))
      .sort((a, b) => compareStrings(a.join('\n'), b.join('\n')));
  const cyclesAdded = sortCycles(
    after.stats.importCycles.filter((c) => !beforeCycles.has(cycleKey(c))),
  );
  const cyclesRemoved = sortCycles(
    before.stats.importCycles.filter((c) => !afterCycles.has(cycleKey(c))),
  );

  const a = statValues(before);
  const b = statValues(after);
  const stats = {} as Record<ComparedStat, StatDelta>;
  for (const key of COMPARED_STATS)
    stats[key] = { before: a[key], after: b[key], delta: b[key] - a[key] };

  return {
    before: side(before),
    after: side(after),
    nodes: { added: nodesAdded.sort(byId), removed: nodesRemoved.sort(byId) },
    edges: {
      added: edgesAdded.sort(byId),
      removed: edgesRemoved.sort(byId),
      resolutionChanged: resolutionChanged.sort(byId),
    },
    cycles: { added: cyclesAdded, removed: cyclesRemoved },
    stats,
    identical:
      !nodesAdded.length &&
      !nodesRemoved.length &&
      !edgesAdded.length &&
      !edgesRemoved.length &&
      !resolutionChanged.length &&
      !cyclesAdded.length &&
      !cyclesRemoved.length,
  };
}
