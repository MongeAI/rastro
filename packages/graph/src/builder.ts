import {
  compareStrings,
  edgeId,
  nodeId,
  type DiscoveryMethod,
  type EdgeKind,
  type EdgeMeta,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type GraphStats,
  type Resolution,
} from '@teia/core';
import { stronglyConnectedComponents } from './cycles.js';

/** Máximo de evidências guardadas por relação; o total fica em `meta.count`. */
export const MAX_EVIDENCE_PER_EDGE = 20;

export interface EdgeInput {
  kind: EdgeKind;
  source: string;
  target: string;
  resolution: Resolution;
  discovery: DiscoveryMethod;
  evidence?: Evidence;
  meta?: EdgeMeta;
}

export interface FinalizedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  importCycles: string[][];
  nodesByKind: GraphStats['nodesByKind'];
  edgesByKind: GraphStats['edgesByKind'];
  edgesByResolution: GraphStats['edgesByResolution'];
}

/**
 * Acumula nós e relações, removendo duplicatas e mesclando evidências.
 * É independente de linguagem: qualquer analisador futuro (Python, Go...) pode alimentá-lo.
 */
export class GraphBuilder {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** Adiciona um nó. Se já existir, mescla os metadados e mantém o primeiro registro. */
  addNode(node: GraphNode): GraphNode {
    const existing = this.nodes.get(node.id);
    if (existing) {
      if (node.meta) existing.meta = { ...node.meta, ...existing.meta };
      return existing;
    }
    this.nodes.set(node.id, node);
    return node;
  }

  /**
   * Garante que existam nós de módulo para o diretório e todos os seus ancestrais,
   * ligados por relações `contains`. Retorna o id do módulo do diretório.
   */
  ensureModule(dir: string): string {
    const id = nodeId.module(dir);
    if (this.nodes.has(id)) return id;
    const parts = dir === '' ? [] : dir.split('/');
    const parentDir = parts.slice(0, -1).join('/');
    const parent = dir === '' ? undefined : this.ensureModule(parentDir);
    this.addNode({
      id,
      kind: 'module',
      name: dir === '' ? '(raiz)' : (parts[parts.length - 1] ?? dir),
      qualifiedName: dir === '' ? '.' : dir,
      ...(parent ? { parent } : {}),
    });
    if (parent) {
      this.addEdge({
        kind: 'contains',
        source: parent,
        target: id,
        resolution: 'resolved',
        discovery: 'derived',
      });
    }
    return id;
  }

  /** Adiciona (ou mescla) uma relação. Relações iguais acumulam evidências e contagem. */
  addEdge(input: EdgeInput): GraphEdge {
    const id = edgeId(input.kind, input.source, input.target);
    const existing = this.edges.get(id);
    if (existing) {
      const meta = (existing.meta ??= {});
      meta.count = (meta.count ?? existing.evidence.length) + 1;
      if (input.evidence && existing.evidence.length < MAX_EVIDENCE_PER_EDGE) {
        const dup = existing.evidence.some(
          (e) =>
            e.file === input.evidence!.file &&
            e.line === input.evidence!.line &&
            e.column === input.evidence!.column,
        );
        if (!dup) existing.evidence.push(input.evidence);
      }
      if (input.meta?.names?.length) {
        meta.names = [...new Set([...(meta.names ?? []), ...input.meta.names])];
      }
      // um import "de valor" prevalece sobre um "import type" na mesma relação
      if (meta.typeOnly && input.meta && !input.meta.typeOnly) meta.typeOnly = false;
      // uma prova pelo verificador de tipos é mais forte do que a leitura sintática
      if (input.discovery === 'static-typecheck') existing.discovery = 'static-typecheck';
      return existing;
    }
    const edge: GraphEdge = {
      id,
      kind: input.kind,
      source: input.source,
      target: input.target,
      resolution: input.resolution,
      discovery: input.discovery,
      evidence: input.evidence ? [input.evidence] : [],
      ...(input.meta ? { meta: { ...input.meta, count: 1 } } : { meta: { count: 1 } }),
    };
    this.edges.set(id, edge);
    return edge;
  }

  /**
   * Fecha o grafo: deriva dependências entre módulos, detecta ciclos de importação,
   * calcula estatísticas e ordena tudo de forma determinística.
   */
  finalize(): FinalizedGraph {
    this.deriveModuleDependencies();
    const importCycles = this.markImportCycles();

    const nodes = [...this.nodes.values()].sort((a, b) => compareStrings(a.id, b.id));
    const edges = [...this.edges.values()].sort((a, b) => compareStrings(a.id, b.id));
    for (const edge of edges) {
      edge.evidence.sort(
        (a, b) => compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column,
      );
    }

    const nodesByKind: FinalizedGraph['nodesByKind'] = {};
    for (const n of nodes) nodesByKind[n.kind] = (nodesByKind[n.kind] ?? 0) + 1;
    const edgesByKind: FinalizedGraph['edgesByKind'] = {};
    const edgesByResolution: FinalizedGraph['edgesByResolution'] = {};
    for (const e of edges) {
      edgesByKind[e.kind] = (edgesByKind[e.kind] ?? 0) + 1;
      edgesByResolution[e.resolution] = (edgesByResolution[e.resolution] ?? 0) + 1;
    }
    return { nodes, edges, importCycles, nodesByKind, edgesByKind, edgesByResolution };
  }

  private fileModule(fileNodeId: string): string | undefined {
    return this.nodes.get(fileNodeId)?.parent;
  }

  private deriveModuleDependencies(): void {
    const imports = [...this.edges.values()].filter(
      (e) => e.kind === 'imports' && e.resolution === 'resolved',
    );
    for (const edge of imports) {
      const from = this.fileModule(edge.source);
      const to = this.fileModule(edge.target);
      if (!from || !to || from === to) continue;
      for (const evidence of edge.evidence.length ? edge.evidence : [undefined]) {
        this.addEdge({
          kind: 'depends_on',
          source: from,
          target: to,
          resolution: 'resolved',
          discovery: 'derived',
          ...(evidence ? { evidence } : {}),
        });
      }
    }
  }

  private markImportCycles(): string[][] {
    const adjacency = new Map<string, string[]>();
    for (const edge of this.edges.values()) {
      // imports só de tipo somem na execução: não formam ciclos reais
      if (edge.kind !== 'imports' || edge.resolution !== 'resolved' || edge.meta?.typeOnly)
        continue;
      if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
      adjacency.get(edge.source)!.push(edge.target);
    }
    const cycles = stronglyConnectedComponents(adjacency).filter(
      (scc) => scc.length > 1 || (scc.length === 1 && adjacency.get(scc[0]!)?.includes(scc[0]!)),
    );
    for (const cycle of cycles) {
      for (const id of cycle) {
        const node = this.nodes.get(id);
        if (node) node.meta = { ...node.meta, inCycle: true };
      }
    }
    return cycles.map((c) => [...c].sort()).sort((a, b) => compareStrings(a[0]!, b[0]!));
  }
}
