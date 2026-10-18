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

type Lines = [number, number];

// `deletionsAt` é a linha logo depois do trecho removido: removido logo acima da entidade
// aponta para a primeira linha dela, mas não a altera (o código no topo do arquivo é que mudou).
// O trecho removido ficava entre as linhas `line - 1` e `line`: dentro da entidade só se as
// duas são dela.
const removedInside = (node: GraphNode, line: number) =>
  !!node.location && line > node.location.startLine && line <= node.location.endLine;

function touches(node: GraphNode, file: ChangedFile): boolean {
  const loc = node.location;
  if (!loc) return false;
  return (
    file.ranges.some(([a, b]) => a <= loc.endLine && b >= loc.startLine) ||
    (file.deletionsAt ?? []).some((line) => removedInside(node, line))
  );
}

/** Junta intervalos de linhas que se sobrepõem ou se encostam (`[1,5]` e `[6,9]` → `[1,9]`). */
function mergeLines(list: Lines[]): Lines[] {
  const merged: Lines[] = [];
  for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** Todas as linhas de `[a, b]` estão em algum dos intervalos (já juntados por `mergeLines`)? */
const covered = (merged: Lines[], a: number, b: number) =>
  merged.some(([start, end]) => a >= start && b <= end);

const linesOf = (nodes: GraphNode[]): Lines[] =>
  mergeLines(
    nodes.flatMap((n) => (n.location ? [[n.location.startLine, n.location.endLine]] : [])),
  );

/**
 * A entidade mudou por si, além do que mudou nas entidades de dentro dela? Um método
 * alterado não muda a classe; um campo ou o construtor alterado junto, sim.
 */
function changedOutside(node: GraphNode, inner: GraphNode[], file: ChangedFile): boolean {
  const loc = node.location!;
  const innerLines = linesOf(inner);
  return (
    file.ranges.some(([a, b]) => {
      const from = Math.max(a, loc.startLine);
      const to = Math.min(b, loc.endLine);
      return from <= to && !covered(innerLines, from, to);
    }) ||
    (file.deletionsAt ?? []).some(
      (line) => removedInside(node, line) && !inner.some((d) => removedInside(d, line)),
    )
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
    const hit = new Set(symbols.filter((n) => touches(n, file)));
    // fica a entidade mais específica: se só um método mudou, a classe não entra por isso
    // (mas entra se também mudou fora dos métodos alterados, ex.: um campo)
    for (const node of hit) {
      const inner = index.descendants(node.id).filter((d) => hit.has(d));
      if (!inner.length || changedOutside(node, inner, file)) changed.add(node.id);
    }
    // código no topo do arquivo (fora de qualquer entidade) também muda o arquivo: linhas
    // alteradas ou trechos removidos (ex.: um `export const` apagado) fora das entidades.
    // Linha a linha: um trecho que pega o fim de uma função e o começo da seguinte continua
    // dentro de entidades
    const symbolLines = linesOf(symbols);
    const outsideSymbols =
      file.ranges.some(([a, b]) => !covered(symbolLines, a, b)) ||
      (file.deletionsAt ?? []).some((line) => !symbols.some((n) => removedInside(n, line)));
    if (outsideSymbols || file.status === 'added') changed.add(fileNode.id);
  }

  // uma busca só a partir de tudo o que mudou (o mesmo que juntar o impacto de cada um)
  const impactedList = index.impactOfAll(changed);

  const changedEntities = [...changed]
    .map((id) => index.node(id)!)
    .filter((n) => n && n.kind !== 'file')
    .sort((a, b) => compareStrings(a.id, b.id));

  const { routes, tests } = routesAndTests(index, [
    ...changedEntities,
    ...changedFiles,
    ...impactedList.map((i) => i.node),
  ]);

  changedFiles.sort((a, b) => compareStrings(a.id, b.id));
  return { changedFiles, outsideGraph, changedEntities, impacted: impactedList, routes, tests };
}

/**
 * Rotas HTTP e arquivos de teste entre as entidades envolvidas (o que mudou e quem depende
 * disso): as rotas para revisar e os testes para rodar, sem repetição e em ordem estável.
 */
export function routesAndTests(
  index: GraphIndex,
  involved: readonly GraphNode[],
): { routes: GraphNode[]; tests: GraphNode[] } {
  return {
    routes: uniqueSorted(involved.filter((n) => n.kind === 'route')),
    tests: uniqueSorted(
      involved
        .map((n) => (n.kind === 'file' ? n : index.fileOf(n.id)))
        .filter((f): f is GraphNode => !!f && isTestFile(f.qualifiedName ?? f.name)),
    ),
  };
}

function uniqueSorted(nodes: GraphNode[]): GraphNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return [...byId.values()].sort((a, b) => compareStrings(a.id, b.id));
}
