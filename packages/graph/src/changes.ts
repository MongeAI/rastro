import {
  compareStrings,
  nodeId,
  type ChangedFile,
  type ChangeSet,
  type GraphNode,
  type NodeKind,
} from '@rastro/core';
import type { GraphIndex, ImpactEntry } from './query.js';

export interface ChangeImpact {
  /** Arquivos alterados que existem no grafo. */
  changedFiles: GraphNode[];
  /** Arquivos alterados fora do grafo (removidos, não analisados, ignorados). */
  outsideGraph: ChangedFile[];
  /** Entidades cujo código foi alterado (a mais específica: o método, não a classe inteira). */
  changedEntities: GraphNode[];
  /** Quem depende do que mudou (chamadas, imports e herança resolvidos), por distância. */
  impacted: ImpactEntry[];
  /** Rotas HTTP alteradas ou afetadas. */
  routes: GraphNode[];
  /** Arquivos de teste alterados ou afetados (pistas de quais testes rodar). */
  tests: GraphNode[];
}

const SYMBOLS = new Set<NodeKind>(['function', 'class', 'method', 'route']);
const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$/i;

export const isTestFile = (path: string) => TEST_FILE.test(path);

function touches(node: GraphNode, file: ChangedFile): boolean {
  const loc = node.location;
  if (!loc) return false;
  const inside = (line: number) => line >= loc.startLine && line <= loc.endLine;
  return (
    file.ranges.some(([a, b]) => a <= loc.endLine && b >= loc.startLine) ||
    (file.deletionsAt ?? []).some(inside)
  );
}

/** O que mudou e quem pode ser afetado, a partir das mudanças do git anexadas ao grafo. */
export function computeChangeImpact(index: GraphIndex, changes: ChangeSet): ChangeImpact {
  const changedFiles: GraphNode[] = [];
  const outsideGraph: ChangedFile[] = [];
  const changed = new Set<string>();

  for (const file of changes.files) {
    const fileNode = index.node(nodeId.file(file.file));
    if (!fileNode || file.status === 'deleted' || fileNode.meta?.analyzed === false) {
      outsideGraph.push(file);
      continue;
    }
    changedFiles.push(fileNode);
    const symbols = index.descendants(fileNode.id).filter((n) => SYMBOLS.has(n.kind));
    const hit = symbols.filter((n) => touches(n, file));
    // fica só a entidade mais específica: se um método mudou, a classe não entra por isso
    for (const node of hit) {
      const moreSpecific = index.descendants(node.id).some((d) => hit.includes(d));
      if (!moreSpecific) changed.add(node.id);
    }
    // código no topo do arquivo (fora de qualquer entidade) também muda o arquivo: linhas
    // alteradas ou trechos removidos (ex.: um `export const` apagado) fora das entidades
    const outsideSymbols =
      file.ranges.some(
        ([a, b]) =>
          !symbols.some((n) => n.location && a >= n.location.startLine && b <= n.location.endLine),
      ) ||
      (file.deletionsAt ?? []).some(
        // o trecho removido ficava entre as linhas `line - 1` e `line`: dentro de uma entidade
        // só se as duas são dela
        (line) =>
          !symbols.some(
            (n) => n.location && line > n.location.startLine && line <= n.location.endLine,
          ),
      );
    if (outsideSymbols || file.status === 'added') changed.add(fileNode.id);
  }

  const impacted = new Map<string, ImpactEntry>();
  for (const id of changed) {
    for (const entry of index.impact(id)) {
      if (changed.has(entry.node.id)) continue;
      const previous = impacted.get(entry.node.id);
      if (!previous || entry.depth < previous.depth) impacted.set(entry.node.id, entry);
    }
  }

  const changedEntities = [...changed]
    .map((id) => index.node(id)!)
    .filter((n) => n && n.kind !== 'file')
    .sort((a, b) => compareStrings(a.id, b.id));
  const impactedList = [...impacted.values()].sort(
    (a, b) => a.depth - b.depth || compareStrings(a.node.id, b.node.id),
  );

  const involved = [...changedEntities, ...changedFiles, ...impactedList.map((i) => i.node)];
  const routes = uniqueSorted(involved.filter((n) => n.kind === 'route'));
  const tests = uniqueSorted(
    involved
      .map((n) => (n.kind === 'file' ? n : index.fileOf(n.id)))
      .filter((f): f is GraphNode => !!f && isTestFile(f.qualifiedName ?? f.name)),
  );

  changedFiles.sort((a, b) => compareStrings(a.id, b.id));
  return { changedFiles, outsideGraph, changedEntities, impacted: impactedList, routes, tests };
}

function uniqueSorted(nodes: GraphNode[]): GraphNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return [...byId.values()].sort((a, b) => compareStrings(a.id, b.id));
}
