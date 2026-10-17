import type { EdgeKind, GraphNode, NodeKind, Resolution } from '@teia/core';
import type { GraphIndex } from './query.js';

/**
 * Cálculo do que aparece na tela. A ideia é nunca despejar todos os símbolos de uma vez:
 * por padrão mostramos módulos e arquivos; os símbolos de um arquivo aparecem quando
 * ele é expandido, ou quando o usuário foca em uma entidade e pede a vizinhança.
 */
export interface ViewOptions {
  /** Tipos de nó habilitados nos filtros. */
  nodeKinds: ReadonlySet<NodeKind>;
  /** Tipos de relação habilitados nos filtros. */
  edgeKinds: ReadonlySet<EdgeKind>;
  /** Arquivos cujos símbolos (funções, classes...) estão expandidos. */
  expandedFiles: ReadonlySet<string>;
  /** Expande os símbolos de todos os arquivos. */
  expandAll?: boolean;
  /** Mostra apenas a vizinhança de um nó. */
  focus?: { id: string; depth: number };
  /** Nós adicionados manualmente (ex.: "expandir relações"). */
  pinned?: ReadonlySet<string>;
}

export interface ViewNode {
  id: string;
  kind: NodeKind;
  label: string;
  parent?: string;
  /** Tem filhos visíveis (desenhado como grupo). */
  compound: boolean;
  inCycle: boolean;
  exported: boolean;
  /** O arquivo tem símbolos que podem ser expandidos. */
  expandable: boolean;
  expanded: boolean;
  /** `false` para arquivos referenciados mas não analisados (css, json...). */
  analyzed: boolean;
}

export interface ViewEdge {
  id: string;
  kind: EdgeKind;
  source: string;
  target: string;
  resolution: Resolution;
  count: number;
  typeOnly: boolean;
}

export interface GraphView {
  nodes: ViewNode[];
  edges: ViewEdge[];
  /** Quantos nós ficaram de fora por causa dos filtros ou da expansão progressiva. */
  hiddenCount: number;
}

const SYMBOL_KINDS = new Set<NodeKind>(['function', 'class', 'method', 'route']);

const isSymbolLevel = (node: GraphNode) =>
  SYMBOL_KINDS.has(node.kind) || (node.kind === 'unresolved' && !!node.parent);

export function computeView(index: GraphIndex, options: ViewOptions): GraphView {
  const visible = new Set<string>();
  const enabled = (n: GraphNode) => options.nodeKinds.has(n.kind);
  const fileExpanded = (fileId: string | undefined) =>
    !!fileId && (options.expandAll || options.expandedFiles.has(fileId));

  if (options.focus && index.node(options.focus.id)) {
    const edgeKinds = [...options.edgeKinds];
    for (const id of index.neighborhood(options.focus.id, options.focus.depth, edgeKinds)) {
      const node = index.node(id);
      if (node && (enabled(node) || id === options.focus.id)) visible.add(id);
    }
    // ao focar um arquivo expandido, seus símbolos também aparecem
    for (const id of [...visible]) {
      const node = index.node(id)!;
      if (node.kind === 'file' && fileExpanded(id))
        for (const d of index.descendants(id)) if (enabled(d)) visible.add(d.id);
    }
  } else {
    for (const node of index.nodes.values()) {
      if (!enabled(node) || node.kind === 'module') continue;
      if (isSymbolLevel(node) && !fileExpanded(index.fileOf(node.id)?.id)) continue;
      visible.add(node.id);
    }
  }
  for (const id of options.pinned ?? []) if (index.node(id)) visible.add(id);

  // ancestrais viram grupos (compound nodes): módulo → arquivo → classe.
  // Só pastas que contêm arquivos viram grupo, evitando caixas vazias aninhadas (apps → cli → src).
  const showModules = options.nodeKinds.has('module');
  const groupable = (n: GraphNode) =>
    (n.kind === 'module' &&
      showModules &&
      n.qualifiedName !== '.' &&
      index.children(n.id).some((c) => c.kind === 'file')) ||
    n.kind === 'file' ||
    n.kind === 'class';
  for (const id of [...visible]) {
    for (const ancestor of index.ancestors(id)) if (groupable(ancestor)) visible.add(ancestor.id);
  }
  const parentOf = new Map<string, string>();
  for (const id of visible) {
    const parent = index.ancestors(id).find((a) => visible.has(a.id));
    if (parent) parentOf.set(id, parent.id);
  }

  const hasVisibleChildren = new Set(parentOf.values());
  const nodes: ViewNode[] = [];
  for (const id of visible) {
    const node = index.node(id)!;
    const symbols = node.kind === 'file' ? index.children(id).some((c) => isSymbolLevel(c)) : false;
    const parent = parentOf.get(id);
    nodes.push({
      id,
      kind: node.kind,
      // módulos mostram o caminho completo, já que pastas intermediárias não aparecem
      label: node.kind === 'module' ? (node.qualifiedName ?? node.name) : node.name,
      ...(parent ? { parent } : {}),
      compound: hasVisibleChildren.has(id),
      inCycle: !!node.meta?.inCycle,
      exported: !!node.meta?.exported,
      expandable: symbols,
      expanded: node.kind === 'file' && fileExpanded(id),
      analyzed: node.meta?.analyzed !== false,
    });
  }

  const edges: ViewEdge[] = [];
  for (const edge of index.edges.values()) {
    if (edge.kind === 'contains' || !options.edgeKinds.has(edge.kind)) continue;
    if (!visible.has(edge.source) || !visible.has(edge.target)) continue;
    // não desenha aresta de um grupo para o próprio filho (fica redundante com o agrupamento)
    if (parentOf.get(edge.target) === edge.source && edge.kind === 'exports') continue;
    edges.push({
      id: edge.id,
      kind: edge.kind,
      source: edge.source,
      target: edge.target,
      resolution: edge.resolution,
      count: edge.meta?.count ?? edge.evidence.length,
      typeOnly: !!edge.meta?.typeOnly,
    });
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  return { nodes, edges, hiddenCount: Math.max(0, index.nodes.size - nodes.length) };
}
