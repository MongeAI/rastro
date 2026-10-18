import { compareStrings, type EdgeKind, type GraphEdge } from '@rastro/core';
import type { GraphIndex } from './query.js';

/** Relações percorridas ao procurar caminhos: só as que representam uso real. */
export const PATH_EDGE_KINDS: EdgeKind[] = ['calls', 'imports', 'extends'];

export interface PathResult {
  /** Ids dos nós, da origem ao destino. */
  nodes: string[];
  /** Relações usadas em cada passo (nodes.length - 1 itens). */
  edges: GraphEdge[];
}

export interface PathSearch {
  /** Caminhos encontrados, do menor para o maior. */
  paths: PathResult[];
  /** `true` quando só existe caminho no sentido inverso (o destino chega na origem). */
  reversed: boolean;
}

interface Options {
  /** Quantos caminhos alternativos devolver (padrão 3). */
  limit?: number;
  /** Maior número de passos considerado (padrão 12). */
  maxDepth?: number;
  kinds?: readonly EdgeKind[];
}

/**
 * Menor caminho por relações resolvidas (BFS, sem pesos), com desvios proibidos para
 * permitir o cálculo de alternativas.
 */
function bfs(
  index: GraphIndex,
  from: string,
  to: string,
  kinds: readonly EdgeKind[],
  maxDepth: number,
  bannedNodes: ReadonlySet<string>,
  bannedEdges: ReadonlySet<string>,
): PathResult | null {
  if (from === to) return { nodes: [from], edges: [] };
  const previous = new Map<string, GraphEdge>();
  const depth = new Map<string, number>([[from, 0]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    const d = depth.get(current)!;
    if (d >= maxDepth) continue;
    // ordem estável: o resultado não depende da ordem de inserção das relações
    const out = index
      .outgoing(current, kinds)
      .filter((e) => e.resolution === 'resolved' && !bannedEdges.has(e.id))
      .sort((a, b) => compareStrings(a.target, b.target));
    for (const edge of out) {
      const next = edge.target;
      if (depth.has(next) || bannedNodes.has(next)) continue;
      depth.set(next, d + 1);
      previous.set(next, edge);
      if (next === to) {
        const edges: GraphEdge[] = [];
        for (let cur = to; cur !== from; cur = previous.get(cur)!.source)
          edges.unshift(previous.get(cur)!);
        return { nodes: [from, ...edges.map((e) => e.target)], edges };
      }
      queue.push(next);
    }
  }
  return null;
}

/** Até `limit` caminhos simples mais curtos (algoritmo de Yen sobre a BFS). */
function kShortest(
  index: GraphIndex,
  from: string,
  to: string,
  kinds: readonly EdgeKind[],
  maxDepth: number,
  limit: number,
): PathResult[] {
  const first = bfs(index, from, to, kinds, maxDepth, new Set(), new Set());
  if (!first) return [];
  const found: PathResult[] = [first];
  const candidates: PathResult[] = [];
  const key = (p: PathResult) => p.edges.map((e) => e.id).join('|');
  const seen = new Set([key(first)]);

  while (found.length < limit) {
    const last = found[found.length - 1]!;
    for (let i = 0; i < last.nodes.length - 1; i++) {
      const spur = last.nodes[i]!;
      const rootEdges = last.edges.slice(0, i);
      const bannedEdges = new Set<string>();
      for (const p of found) {
        if (
          p.edges
            .slice(0, i)
            .map((e) => e.id)
            .join('|') === rootEdges.map((e) => e.id).join('|')
        )
          if (p.edges[i]) bannedEdges.add(p.edges[i]!.id);
      }
      const bannedNodes = new Set(last.nodes.slice(0, i));
      const tail = bfs(index, spur, to, kinds, maxDepth - i, bannedNodes, bannedEdges);
      if (!tail) continue;
      const candidate: PathResult = {
        nodes: [...last.nodes.slice(0, i), ...tail.nodes],
        edges: [...rootEdges, ...tail.edges],
      };
      const k = key(candidate);
      if (!seen.has(k)) {
        seen.add(k);
        candidates.push(candidate);
      }
    }
    if (!candidates.length) break;
    candidates.sort((a, b) => a.edges.length - b.edges.length || compareStrings(key(a), key(b)));
    found.push(candidates.shift()!);
  }
  return found;
}

/**
 * "Como A chega em B?": caminhos pelas relações resolvidas de chamada, import e herança.
 * Se não houver caminho de A até B, procura de B até A (e avisa com `reversed`).
 */
export function findPaths(
  index: GraphIndex,
  from: string,
  to: string,
  options: Options = {},
): PathSearch {
  const kinds = options.kinds ?? PATH_EDGE_KINDS;
  const maxDepth = options.maxDepth ?? 12;
  const limit = options.limit ?? 3;
  if (!index.node(from) || !index.node(to)) return { paths: [], reversed: false };
  const forward = kShortest(index, from, to, kinds, maxDepth, limit);
  if (forward.length) return { paths: forward, reversed: false };
  const backward = kShortest(index, to, from, kinds, maxDepth, limit);
  return { paths: backward, reversed: backward.length > 0 };
}
