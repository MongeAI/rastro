import type { EdgeKind, GraphEdge, GraphNode, NodeKind, RastroGraph } from '@rastro/core';
import { compareStrings } from '@rastro/core';

export interface SearchResult {
  node: GraphNode;
  score: number;
}

export interface ImpactEntry {
  node: GraphNode;
  /** Distância (em relações) até a entidade alterada. */
  depth: number;
  /** Relação que levou até este nó. */
  via: GraphEdge;
}

/** Relações consideradas na análise de impacto: quem chama, importa ou estende. */
export const IMPACT_EDGE_KINDS: EdgeKind[] = ['calls', 'imports', 'extends'];

const SYMBOL_KINDS = new Set<NodeKind>(['function', 'class', 'method', 'route']);

/** Índices em memória para consultar o grafo rapidamente (usado pela CLI e pela interface). */
export class GraphIndex {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();
  private readonly out = new Map<string, GraphEdge[]>();
  private readonly in = new Map<string, GraphEdge[]>();
  private readonly childrenOf = new Map<string, GraphNode[]>();
  /** Candidato possível → nós não resolvidos (chamadas por interface) que o citam. */
  private readonly candidateIn = new Map<string, GraphNode[]>();

  constructor(readonly graph: RastroGraph) {
    for (const node of graph.nodes) {
      this.nodes.set(node.id, node);
      for (const candidate of node.meta?.candidates ?? []) {
        if (!this.candidateIn.has(candidate)) this.candidateIn.set(candidate, []);
        this.candidateIn.get(candidate)!.push(node);
      }
      if (node.parent) {
        if (!this.childrenOf.has(node.parent)) this.childrenOf.set(node.parent, []);
        this.childrenOf.get(node.parent)!.push(node);
      }
    }
    for (const edge of graph.edges) {
      this.edges.set(edge.id, edge);
      if (!this.out.has(edge.source)) this.out.set(edge.source, []);
      this.out.get(edge.source)!.push(edge);
      if (!this.in.has(edge.target)) this.in.set(edge.target, []);
      this.in.get(edge.target)!.push(edge);
    }
  }

  node(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  outgoing(id: string, kinds?: readonly EdgeKind[]): GraphEdge[] {
    const list = this.out.get(id) ?? [];
    return kinds ? list.filter((e) => kinds.includes(e.kind)) : list;
  }

  incoming(id: string, kinds?: readonly EdgeKind[]): GraphEdge[] {
    const list = this.in.get(id) ?? [];
    return kinds ? list.filter((e) => kinds.includes(e.kind)) : list;
  }

  /**
   * Chamadas não resolvidas (por interface ou método abstrato) que têm `id` como implementação
   * _possível_. Não são relações: servem para mostrar "talvez chamado por", nunca como prova.
   */
  possibleCallSites(id: string): GraphNode[] {
    return this.candidateIn.get(id) ?? [];
  }

  children(id: string): GraphNode[] {
    return this.childrenOf.get(id) ?? [];
  }

  /** Ancestrais (pai, avô...) de um nó, do mais próximo ao mais distante. */
  ancestors(id: string): GraphNode[] {
    const result: GraphNode[] = [];
    const seen = new Set<string>([id]);
    let current = this.nodes.get(id)?.parent;
    while (current && !seen.has(current)) {
      seen.add(current);
      const node = this.nodes.get(current);
      if (!node) break;
      result.push(node);
      current = node.parent;
    }
    return result;
  }

  /** Arquivo que contém o nó (ou o próprio nó, se for um arquivo). */
  fileOf(id: string): GraphNode | undefined {
    const node = this.nodes.get(id);
    if (!node) return undefined;
    if (node.kind === 'file') return node;
    return this.ancestors(id).find((a) => a.kind === 'file');
  }

  /** Todos os descendentes (filhos, netos...) de um nó. */
  descendants(id: string): GraphNode[] {
    const result: GraphNode[] = [...this.children(id)];
    for (let i = 0; i < result.length; i++) result.push(...this.children(result[i]!.id));
    return result;
  }

  /**
   * Vizinhança de um nó até `depth` relações de distância, nos dois sentidos.
   * Relações `contains` não são percorridas (a hierarquia é tratada à parte).
   */
  neighborhood(id: string, depth: number, kinds?: readonly EdgeKind[]): Set<string> {
    const allowed = (kinds ?? []).filter((k) => k !== 'contains');
    const visited = new Set<string>([id]);
    // lista explícita vazia = nenhuma relação habilitada: não percorre nada
    if (kinds && allowed.length === 0) return visited;
    let frontier = [id];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const e of this.outgoing(current, kinds ? allowed : undefined)) {
          if (e.kind === 'contains') continue;
          if (!visited.has(e.target)) {
            visited.add(e.target);
            next.push(e.target);
          }
        }
        for (const e of this.incoming(current, kinds ? allowed : undefined)) {
          if (e.kind === 'contains') continue;
          if (!visited.has(e.source)) {
            visited.add(e.source);
            next.push(e.source);
          }
        }
      }
      frontier = next;
    }
    return visited;
  }

  /**
   * Análise de impacto: quem pode ser afetado se esta entidade mudar.
   * Percorre no sentido inverso as relações de chamada, importação e herança.
   * Para arquivos, também considera quem usa os símbolos definidos nele.
   * Só usa relações resolvidas — referências não resolvidas não entram como fato.
   */
  impact(id: string, maxDepth = 6): ImpactEntry[] {
    const result = new Map<string, ImpactEntry>();
    const start = this.nodes.get(id);
    if (!start) return [];
    const seeds = [id];
    if (start.kind === 'file' || start.kind === 'class' || start.kind === 'module') {
      for (const d of this.descendants(id))
        if (SYMBOL_KINDS.has(d.kind) || d.kind === 'file') seeds.push(d.id);
    }
    const visited = new Set<string>(seeds);
    let frontier = seeds;
    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const edge of this.incoming(current, IMPACT_EDGE_KINDS)) {
          if (edge.resolution !== 'resolved' || visited.has(edge.source)) continue;
          visited.add(edge.source);
          const node = this.nodes.get(edge.source);
          if (!node) continue;
          result.set(node.id, { node, depth, via: edge });
          next.push(node.id);
        }
      }
      frontier = next;
    }
    return [...result.values()].sort(
      (a, b) => a.depth - b.depth || compareStrings(a.node.id, b.node.id),
    );
  }

  /** Busca por nome, nome qualificado ou caminho de arquivo (sem diferenciar maiúsculas). */
  search(query: string, limit = 30, kinds?: ReadonlySet<NodeKind>): SearchResult[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results: SearchResult[] = [];
    for (const node of this.nodes.values()) {
      if (kinds && !kinds.has(node.kind)) continue;
      const name = node.name.toLowerCase();
      const qualified = (node.qualifiedName ?? '').toLowerCase();
      const file = (node.location?.file ?? '').toLowerCase();
      let score = 0;
      if (name === q) score = 100;
      else if (name.startsWith(q)) score = 80;
      else if (name.includes(q)) score = 60;
      else if (qualified.includes(q)) score = 50;
      else if (file.includes(q)) score = 30;
      if (!score) continue;
      if (SYMBOL_KINDS.has(node.kind) || node.kind === 'file') score += 5;
      if (node.kind === 'unresolved') score -= 10;
      results.push({ node, score });
    }
    return results
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.node.name.length - b.node.name.length ||
          compareStrings(a.node.id, b.node.id),
      )
      .slice(0, limit);
  }
}
