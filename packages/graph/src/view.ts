import type { EdgeKind, GraphNode, NodeKind, Resolution } from '@rastro/core';
import { compareStrings } from '@rastro/core';
import type { GraphIndex } from './query.js';

/**
 * Cálculo do que aparece na tela. A ideia é nunca despejar todos os símbolos de uma vez:
 * - pastas podem ficar recolhidas (viram um nó só, com as relações dos arquivos somadas);
 * - arquivos mostram seus símbolos apenas quando expandidos;
 * - o foco mostra só a vizinhança de uma entidade.
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
  /** Pastas recolhidas: aparecem como um único nó, com as relações internas agregadas. */
  collapsedModules?: ReadonlySet<string>;
  /** Mostra apenas a vizinhança de um nó (ignora pastas recolhidas). */
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
  /** Pasta recolhida (desenhada como um nó só). */
  collapsed: boolean;
  /** Para pastas recolhidas: quantos arquivos ela contém. */
  fileCount?: number;
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
  /** Soma de relações de nós internos a pastas recolhidas. */
  aggregated: boolean;
  /** Ids das relações originais representadas por esta aresta. */
  members: string[];
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

/** Pastas que viram grupo no mapa: as que contêm arquivos diretamente (exceto a raiz). */
export function groupableModules(index: GraphIndex): string[] {
  const result: string[] = [];
  for (const node of index.nodes.values()) {
    if (node.kind !== 'module' || node.qualifiedName === '.') continue;
    if (index.children(node.id).some((c) => c.kind === 'file')) result.push(node.id);
  }
  return result.sort();
}

const RESOLUTION_RANK: Record<Resolution, number> = { resolved: 0, unresolved: 1, external: 2 };

export function computeView(index: GraphIndex, options: ViewOptions): GraphView {
  const candidates = new Set<string>();
  const enabled = (n: GraphNode) => options.nodeKinds.has(n.kind);
  const fileExpanded = (fileId: string | undefined) =>
    !!fileId && (options.expandAll || options.expandedFiles.has(fileId));
  const focused = !!(options.focus && index.node(options.focus.id));

  if (focused) {
    const { id: focusId, depth } = options.focus!;
    for (const id of index.neighborhood(focusId, depth, [...options.edgeKinds])) {
      const node = index.node(id);
      if (node && (enabled(node) || id === focusId)) candidates.add(id);
    }
    // ao focar um arquivo expandido, seus símbolos também aparecem
    for (const id of [...candidates]) {
      if (index.node(id)!.kind === 'file' && fileExpanded(id))
        for (const d of index.descendants(id)) if (enabled(d)) candidates.add(d.id);
    }
  } else {
    for (const node of index.nodes.values()) {
      if (!enabled(node) || node.kind === 'module') continue;
      if (isSymbolLevel(node) && !fileExpanded(index.fileOf(node.id)?.id)) continue;
      candidates.add(node.id);
    }
  }
  for (const id of options.pinned ?? []) if (index.node(id)) candidates.add(id);

  const showModules = options.nodeKinds.has('module');
  const groupableSet = new Set(groupableModules(index));
  const groupable = showModules ? groupableSet : new Set<string>();
  const collapsed = new Set(
    focused ? [] : [...(options.collapsedModules ?? [])].filter((id) => groupable.has(id)),
  );

  // representante de cada candidato: a pasta recolhida mais externa que o contém, ou ele mesmo
  const repOf = new Map<string, string>();
  for (const id of candidates) {
    let rep = id;
    for (const ancestor of index.ancestors(id)) if (collapsed.has(ancestor.id)) rep = ancestor.id;
    repOf.set(id, rep);
  }
  const visible = new Set(repOf.values());

  // ancestrais viram grupos: pasta → arquivo → classe
  const isGroup = (n: GraphNode) => groupable.has(n.id) || n.kind === 'file' || n.kind === 'class';
  for (const id of [...visible]) {
    for (const ancestor of index.ancestors(id)) if (isGroup(ancestor)) visible.add(ancestor.id);
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
    const parent = parentOf.get(id);
    const isCollapsed = collapsed.has(id);
    nodes.push({
      id,
      kind: node.kind,
      // pastas mostram o caminho completo, já que pastas intermediárias não aparecem
      label: node.kind === 'module' ? (node.qualifiedName ?? node.name) : node.name,
      ...(parent ? { parent } : {}),
      compound: hasVisibleChildren.has(id),
      inCycle: isCollapsed
        ? index.descendants(id).some((d) => d.meta?.inCycle)
        : !!node.meta?.inCycle,
      exported: !!node.meta?.exported,
      expandable: node.kind === 'file' && index.children(id).some(isSymbolLevel),
      expanded: node.kind === 'file' && fileExpanded(id),
      collapsed: isCollapsed,
      ...(isCollapsed
        ? { fileCount: index.descendants(id).filter((d) => d.kind === 'file').length }
        : {}),
      analyzed: node.meta?.analyzed !== false,
    });
  }

  /**
   * Representante de um nó para desenhar relações. Pastas (ex.: `depends_on`) não são
   * candidatas, mas aparecem como grupo ou dentro de uma pasta recolhida.
   */
  const repFor = (id: string): string | undefined => {
    const rep = repOf.get(id);
    if (rep) return rep;
    if (index.node(id)?.kind !== 'module') return undefined;
    let outer: string | undefined;
    for (const ancestor of index.ancestors(id)) if (collapsed.has(ancestor.id)) outer = ancestor.id;
    if (outer) return outer;
    return visible.has(id) ? id : undefined;
  };

  /** `a` é ancestral de `b` no mapa (a relação desenhada seria um laço no próprio grupo). */
  const isViewAncestor = (a: string, b: string) => {
    for (let cur = parentOf.get(b); cur; cur = parentOf.get(cur)) if (cur === a) return true;
    return false;
  };

  const byKey = new Map<string, ViewEdge>();
  for (const edge of index.edges.values()) {
    if (edge.kind === 'contains' || !options.edgeKinds.has(edge.kind)) continue;
    const source = repFor(edge.source);
    const target = repFor(edge.target);
    if (!source || !target || source === target) continue;
    if (isViewAncestor(source, target) || isViewAncestor(target, source)) continue;
    const aggregated = source !== edge.source || target !== edge.target;
    const count = edge.meta?.count ?? edge.evidence.length;
    // uma linha por (tipo, origem, destino): relações diretas e somadas não se duplicam
    const key = `${edge.kind}|${source}|${target}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += count;
      existing.members.push(edge.id);
      existing.aggregated = true;
      existing.id = `agg:${edge.kind}:${source}->${target}`;
      existing.typeOnly &&= !!edge.meta?.typeOnly;
      if (RESOLUTION_RANK[edge.resolution] < RESOLUTION_RANK[existing.resolution])
        existing.resolution = edge.resolution;
      continue;
    }
    byKey.set(key, {
      id: aggregated ? `agg:${edge.kind}:${source}->${target}` : edge.id,
      kind: edge.kind,
      source,
      target,
      resolution: edge.resolution,
      count,
      typeOnly: !!edge.meta?.typeOnly,
      aggregated,
      members: [edge.id],
    });
  }

  nodes.sort((a, b) => compareStrings(a.id, b.id));
  const edges = [...byKey.values()].sort((a, b) => compareStrings(a.id, b.id));
  // pastas sem arquivos diretos (e a raiz) nunca aparecem, então não contam como "ocultas"
  let displayable = 0;
  for (const node of index.nodes.values())
    if (node.kind !== 'module' || groupableSet.has(node.id)) displayable++;
  return { nodes, edges, hiddenCount: Math.max(0, displayable - nodes.length) };
}
