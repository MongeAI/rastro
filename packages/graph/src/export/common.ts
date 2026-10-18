import {
  compareStrings,
  kindLabels,
  NODE_KINDS,
  type EdgeKind,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type GraphStats,
  type Lang,
  type RastroGraph,
} from '@rastro/core';
import { GraphIndex } from '../query.js';
import { computeView, groupableModules, type ViewEdge, type ViewNode } from '../view.js';

/**
 * Base comum dos exportadores (Mermaid, DOT, GraphML). Tudo aqui é puro e sem APIs do Node,
 * para a interface web poder exportar o que está na tela com o mesmo código.
 */

/** Nível de detalhe, o mesmo da interface: pastas recolhidas, arquivos ou todos os símbolos. */
export type ExportLevel = 'modules' | 'files' | 'symbols';
export const EXPORT_LEVELS: readonly ExportLevel[] = ['modules', 'files', 'symbols'];

/** Relações exportadas por padrão (as mesmas que a interface mostra ao abrir). */
export const DEFAULT_EXPORT_EDGE_KINDS: readonly EdgeKind[] = ['imports', 'calls', 'extends'];

export interface ExportOptions {
  /** Padrão: `files`. */
  level?: ExportLevel;
  /** Tipos de relação desenhados (padrão: imports, calls, extends). `contains` vira agrupamento. */
  edgeKinds?: readonly EdgeKind[];
  /**
   * Só a pasta indicada (e subpastas), ex.: `src/services`. Compara por pasta inteira:
   * `src/serv` não inclui `src/services`. Relações com o resto do projeto ficam de fora;
   * pacotes externos usados de dentro da pasta continuam (se `includeExternal`).
   */
  folder?: string;
  /** Inclui pacotes externos (npm, Node.js). Padrão: `false`, como na interface. */
  includeExternal?: boolean;
  /** Inclui referências não resolvidas. Padrão: `true`. */
  includeUnresolved?: boolean;
  /** Idioma dos comentários e rótulos legíveis (nível, contagens, tipos de relação). Padrão: `pt`. */
  lang?: Lang;
}

/** O que será exportado: a mesma visão calculada pela interface (`computeView`). */
export interface ExportView {
  /** Grafo de origem, já restrito à pasta (quando há `folder`). */
  graph: RastroGraph;
  index: GraphIndex;
  level: ExportLevel;
  folder?: string;
  edgeKinds: EdgeKind[];
  lang: Lang;
  nodes: ViewNode[];
  edges: ViewEdge[];
}

/** O diagrama passaria do limite do formato (ex.: Mermaid no GitHub). */
export class ExportTooLargeError extends Error {
  constructor(
    message: string,
    /** Como reduzir o diagrama. */
    readonly hint: string,
  ) {
    super(message);
    this.name = 'ExportTooLargeError';
  }
}

/** `./src/services/` → `src/services`; vazio ou `.` → sem filtro. */
export function normalizeFolder(folder: string | undefined): string | undefined {
  if (folder === undefined) return undefined;
  const clean = folder
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+|\/+$/g, '');
  return clean === '' || clean === '.' ? undefined : clean;
}

const inFolder = (p: string, folder: string) => p === folder || p.startsWith(`${folder}/`);

/** Caminho (relativo à raiz) que situa o nó numa pasta; pacotes não têm. */
function nodePath(node: GraphNode): string | undefined {
  if (node.kind === 'module' || node.kind === 'file') return node.qualifiedName ?? node.name;
  return node.location?.file;
}

/**
 * Restringe o grafo a uma pasta. O resultado continua sendo um grafo válido: as relações
 * só ligam nós mantidos e as contagens de `stats` são recalculadas. As pastas acima da
 * escolhida são mantidas (sem os arquivos de fora) para a hierarquia continuar íntegra.
 */
export function filterGraphByFolder(graph: RastroGraph, folder: string | undefined): RastroGraph {
  const prefix = normalizeFolder(folder);
  if (!prefix) return graph;
  const keep = new Set<string>();
  /** Pastas acima da escolhida (inclusive a raiz "."): só a moldura da hierarquia. */
  const frame = new Set<string>();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const node of graph.nodes) {
    const p = nodePath(node);
    if (p === undefined) continue;
    if (inFolder(p, prefix)) keep.add(node.id);
    else if (node.kind === 'module' && (p === '.' || inFolder(prefix, p))) {
      keep.add(node.id);
      frame.add(node.id);
    }
  }
  // pacotes externos usados por algo de dentro da pasta
  for (const edge of graph.edges) {
    if (!keep.has(edge.source) || keep.has(edge.target)) continue;
    if (byId.get(edge.target)?.kind === 'package' && isInside(byId.get(edge.source), prefix))
      keep.add(edge.target);
  }
  const nodes = graph.nodes.filter((n) => keep.has(n.id));
  // a moldura só participa da hierarquia: um depends_on dela viria de arquivos de fora
  const edges = graph.edges.filter(
    (e) =>
      keep.has(e.source) &&
      keep.has(e.target) &&
      (e.kind === 'contains' || (!frame.has(e.source) && !frame.has(e.target))),
  );

  const nodesByKind: GraphStats['nodesByKind'] = {};
  for (const n of nodes) nodesByKind[n.kind] = (nodesByKind[n.kind] ?? 0) + 1;
  const edgesByKind: GraphStats['edgesByKind'] = {};
  const edgesByResolution: GraphStats['edgesByResolution'] = {};
  for (const e of edges) {
    edgesByKind[e.kind] = (edgesByKind[e.kind] ?? 0) + 1;
    edgesByResolution[e.resolution] = (edgesByResolution[e.resolution] ?? 0) + 1;
  }
  return {
    ...graph,
    nodes,
    edges,
    stats: {
      ...graph.stats,
      files: nodes.filter((n) => n.kind === 'file' && n.meta?.analyzed !== false).length,
      nodesByKind,
      edgesByKind,
      edgesByResolution,
      importCycles: graph.stats.importCycles.filter((c) => c.every((id) => keep.has(id))),
    },
    diagnostics: [
      ...graph.diagnostics.filter((d) => !d.file || inFolder(d.file, prefix)),
      {
        level: 'info',
        code: 'folder-filter',
        message: `Grafo restrito à pasta "${prefix}". Os contadores de chamadas fora do grafo (externalCallsSkipped, unknownReceiverCalls...) continuam valendo para o projeto inteiro.`,
      },
    ],
  };
}

function isInside(node: GraphNode | undefined, prefix: string): boolean {
  const p = node && nodePath(node);
  return p !== undefined && inFolder(p, prefix);
}

/** Calcula a visão a exportar, com as mesmas regras da interface. */
export function buildExportView(graph: RastroGraph, options: ExportOptions = {}): ExportView {
  const level = options.level ?? 'files';
  const folder = normalizeFolder(options.folder);
  const filtered = filterGraphByFolder(graph, folder);
  const index = new GraphIndex(filtered);
  const nodeKinds = new Set(
    NODE_KINDS.filter(
      (k) =>
        (k !== 'package' || options.includeExternal === true) &&
        (k !== 'unresolved' || options.includeUnresolved !== false),
    ),
  );
  const edgeKinds = [...new Set(options.edgeKinds ?? DEFAULT_EXPORT_EDGE_KINDS)]
    .filter((k) => k !== 'contains')
    .sort(compareStrings);
  const view = computeView(index, {
    nodeKinds,
    edgeKinds: new Set(edgeKinds),
    expandedFiles: new Set(),
    expandAll: level === 'symbols',
    // no nível "pastas", todas as pastas com arquivos ficam recolhidas (como na interface)
    collapsedModules: new Set(level === 'modules' ? groupableModules(index) : []),
  });
  return {
    graph: filtered,
    index,
    level,
    ...(folder ? { folder } : {}),
    edgeKinds,
    lang: options.lang ?? 'pt',
    nodes: view.nodes,
    edges: view.edges,
  };
}

/** Rótulo exibido de um nó: pastas recolhidas mostram quantos arquivos têm. */
export function nodeLabel(node: ViewNode, lang: Lang = 'pt'): string {
  if (node.collapsed && node.fileCount !== undefined)
    return `${node.label} (${exportTexts(lang).files(node.fileCount)})`;
  return node.label;
}

/** Rótulo de uma relação: o tipo (quando há mais de um no diagrama) e a contagem (×N). */
export function edgeLabel(edge: ViewEdge, showKind: boolean, lang: Lang = 'pt'): string {
  const parts: string[] = [];
  if (showKind) parts.push(kindLabels(lang).edge[edge.kind].toLowerCase());
  if (edge.count > 1) parts.push(`×${edge.count}`);
  return parts.join(' ');
}

/** Primeira evidência (arquivo + linha) entre as relações originais representadas pela aresta. */
export function firstEvidence(edge: ViewEdge, index: GraphIndex): Evidence | undefined {
  for (const id of edge.members) {
    const original: GraphEdge | undefined = index.edges.get(id);
    if (original?.evidence[0]) return original.evidence[0];
  }
  return undefined;
}

/** Arquivo e linha de um nó (para pastas e arquivos, o próprio caminho). */
export function nodeLocation(
  node: ViewNode,
  index: GraphIndex,
): { file?: string; line?: number } | undefined {
  const original = index.node(node.id);
  if (!original) return undefined;
  if (original.location) return { file: original.location.file, line: original.location.startLine };
  if (original.kind === 'file' || original.kind === 'module')
    return { file: original.qualifiedName ?? original.name };
  return undefined;
}

/** Filhos de cada nó na visão (na ordem determinística dos ids) e as raízes. */
export function viewTree(nodes: readonly ViewNode[]): {
  roots: ViewNode[];
  children: Map<string, ViewNode[]>;
} {
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string, ViewNode[]>();
  const roots: ViewNode[] = [];
  for (const node of nodes) {
    if (node.parent && ids.has(node.parent)) {
      if (!children.has(node.parent)) children.set(node.parent, []);
      children.get(node.parent)!.push(node);
    } else roots.push(node);
  }
  return { roots, children };
}

export const LEVEL_LABELS: Record<ExportLevel, string> = {
  modules: 'pastas',
  files: 'arquivos',
  symbols: 'símbolos',
};

const LEVEL_LABELS_EN: Record<ExportLevel, string> = {
  modules: 'folders',
  files: 'files',
  symbols: 'symbols',
};

const PT = {
  levels: LEVEL_LABELS,
  level: 'nível',
  folder: 'pasta',
  files: (n: number) => `${n} ${n === 1 ? 'arquivo' : 'arquivos'}`,
  mermaidTooManyNodes: (n: number, max: number) =>
    `O diagrama Mermaid teria ${n} nós (limite: ${max}).`,
  mermaidTooManyEdges: (n: number, max: number) =>
    `O diagrama Mermaid teria ${n} relações (o Mermaid desenha até ${max}).`,
  mermaidTooLong: (n: number, max: number) =>
    `O diagrama Mermaid teria ${n} caracteres (o Mermaid aceita até ${max}).`,
  mermaidHint:
    'Reduza o diagrama com o nível de pastas ou um filtro de pasta (na CLI: --level modules ou --folder <pasta>), ou exporte em DOT/GraphML, que não têm esse limite.',
};

/** Textos legíveis dos diagramas exportados (comentários, rótulos e erros), por idioma. */
const EXPORT_TEXTS: Record<Lang, typeof PT> = {
  pt: PT,
  en: {
    levels: LEVEL_LABELS_EN,
    level: 'level',
    folder: 'folder',
    files: (n) => `${n} ${n === 1 ? 'file' : 'files'}`,
    mermaidTooManyNodes: (n, max) => `The Mermaid diagram would have ${n} nodes (limit: ${max}).`,
    mermaidTooManyEdges: (n, max) =>
      `The Mermaid diagram would have ${n} relationships (Mermaid draws up to ${max}).`,
    mermaidTooLong: (n, max) =>
      `The Mermaid diagram would have ${n} characters (Mermaid accepts up to ${max}).`,
    mermaidHint:
      'Shrink the diagram with the folders level or a folder filter (in the CLI: --level modules or --folder <path>), or export to DOT/GraphML, which have no such limit.',
  },
};

/** Textos dos exportadores no idioma pedido (padrão: português). */
export function exportTexts(lang: Lang = 'pt'): typeof PT {
  return EXPORT_TEXTS[lang];
}

/** Linha de título usada nos comentários dos formatos de texto. */
export function exportTitle(view: ExportView): string {
  const text = exportTexts(view.lang);
  const parts = [`Rastro`, view.graph.project.name, `${text.level}: ${text.levels[view.level]}`];
  if (view.folder) parts.push(`${text.folder}: ${view.folder}`);
  return parts.join(' · ').replace(/[\r\n]+/g, ' ');
}
