import type { NodeKind, RastroGraph } from '@rastro/core';
import type { ViewEdge, ViewNode } from '../view.js';
import {
  buildExportView,
  edgeLabel,
  exportTitle,
  ExportTooLargeError,
  nodeLabel,
  viewTree,
  type ExportOptions,
} from './common.js';

export interface MermaidOptions extends ExportOptions {
  /** Direção do fluxograma. Padrão: `LR` (da esquerda para a direita, como o mapa). */
  direction?: 'LR' | 'TB';
  /** Máximo de nós (padrão: 400). Acima disso o diagrama fica ilegível. */
  maxNodes?: number;
}

/** Acima disso o diagrama Mermaid deixa de ser legível (e fica lento no GitHub). */
export const MERMAID_MAX_NODES = 400;
/** Limite padrão de arestas do Mermaid (`maxEdges`), que não pode ser mudado pelo diagrama. */
export const MERMAID_MAX_EDGES = 500;
/** Limite padrão de texto do Mermaid (`maxTextSize`), usado pelo GitHub. */
export const MERMAID_MAX_TEXT = 50_000;

const HINT =
  'Reduza o diagrama com o nível de pastas ou um filtro de pasta (na CLI: --level modules ou --folder <pasta>), ou exporte em DOT/GraphML, que não têm esse limite.';

/** Formas por tipo de nó: [abre, fecha]. */
const SHAPES: Record<NodeKind, [string, string]> = {
  module: ['[[', ']]'],
  file: ['[', ']'],
  function: ['(', ')'],
  method: ['(', ')'],
  class: ['{{', '}}'],
  route: ['>', ']'],
  package: ['([', '])'],
  unresolved: ['[', ']'],
};

const ID_PREFIX: Record<NodeKind, string> = {
  module: 'm',
  file: 'f',
  function: 'fn',
  method: 'me',
  class: 'c',
  route: 'r',
  package: 'p',
  unresolved: 'u',
};

const CLASS_DEFS: Record<string, string> = {
  unresolved: 'fill:#fef2f2,stroke:#dc2626,stroke-dasharray:4 3,color:#991b1b',
  external: 'fill:#f4f4f5,stroke:#71717a,stroke-dasharray:2 2,color:#3f3f46',
  cycle: 'stroke:#ea580c,stroke-width:2px',
};

const LINK_STYLES: Array<[string, (e: ViewEdge) => boolean, string]> = [
  ['unresolved', (e) => e.resolution === 'unresolved', 'stroke:#dc2626,stroke-dasharray:4 3'],
  ['external', (e) => e.resolution === 'external', 'stroke:#a1a1aa,stroke-dasharray:2 3'],
  ['calls', (e) => e.resolution === 'resolved' && e.kind === 'calls', 'stroke:#0284c7'],
  ['extends', (e) => e.resolution === 'resolved' && e.kind === 'extends', 'stroke:#9333ea'],
  ['depends_on', (e) => e.resolution === 'resolved' && e.kind === 'depends_on', 'stroke:#db2777'],
];

/**
 * Texto de um rótulo entre aspas no Mermaid. Caracteres especiais viram entidades
 * (`#quot;`, `#35;`...), que o Mermaid decodifica; quebras de linha viram espaço.
 */
export function mermaidLabel(text: string): string {
  return (
    text
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[#"<>&`]/g, (c) => `#${c.codePointAt(0)};`)
      // eslint-disable-next-line no-control-regex -- remove caracteres de controle de propósito
      .replace(/[\u0000-\u001f\u007f]/g, '')
  );
}

/** Id seguro para o Mermaid: só [A-Za-z0-9_], com prefixo por tipo (evita palavras como `end`). */
function baseId(node: ViewNode): string {
  const ascii = node.label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/, '');
  return `${ID_PREFIX[node.kind]}_${ascii || 'n'}`;
}

/** Fluxograma Mermaid da visão (com subgrafos para pastas, arquivos e classes abertos). */
export function toMermaid(graph: RastroGraph, options: MermaidOptions = {}): string {
  const view = buildExportView(graph, options);
  const maxNodes = options.maxNodes ?? MERMAID_MAX_NODES;
  if (view.nodes.length > maxNodes)
    throw new ExportTooLargeError(
      `O diagrama Mermaid teria ${view.nodes.length} nós (limite: ${maxNodes}).`,
      HINT,
    );
  if (view.edges.length > MERMAID_MAX_EDGES)
    throw new ExportTooLargeError(
      `O diagrama Mermaid teria ${view.edges.length} relações (o Mermaid desenha até ${MERMAID_MAX_EDGES}).`,
      HINT,
    );

  // ids curtos e legíveis, únicos na ordem determinística dos nós
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const node of view.nodes) {
    const base = baseId(node);
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}_${i}`;
    used.add(id);
    ids.set(node.id, id);
  }

  const lines: string[] = [`%% ${exportTitle(view)}`, `flowchart ${options.direction ?? 'LR'}`];
  const { roots, children } = viewTree(view.nodes);
  const classes = new Map<string, string[]>();
  const addClass = (name: string, id: string) => {
    if (!classes.has(name)) classes.set(name, []);
    classes.get(name)!.push(id);
  };
  const emit = (node: ViewNode, depth: number) => {
    const pad = '  '.repeat(depth);
    const id = ids.get(node.id)!;
    const label = mermaidLabel(nodeLabel(node));
    const kids = children.get(node.id);
    if (kids?.length) {
      lines.push(`${pad}subgraph ${id}["${label}"]`);
      for (const child of kids) emit(child, depth + 1);
      lines.push(`${pad}end`);
    } else {
      const [open, close] = SHAPES[node.kind];
      lines.push(`${pad}${id}${open}"${label}"${close}`);
    }
    if (node.kind === 'unresolved') addClass('unresolved', id);
    else if (node.kind === 'package') addClass('external', id);
    else if (node.inCycle) addClass('cycle', id);
  };
  for (const root of roots) emit(root, 1);

  const showKind = new Set(view.edges.map((e) => e.kind)).size > 1;
  view.edges.forEach((edge) => {
    const dotted = edge.typeOnly || edge.kind === 'exports';
    const text = edgeLabel(edge, showKind);
    const arrow = `${dotted ? '-.->' : '-->'}${text ? `|"${mermaidLabel(text)}"|` : ''}`;
    lines.push(`  ${ids.get(edge.source)} ${arrow} ${ids.get(edge.target)}`);
  });

  for (const [name, style] of Object.entries(CLASS_DEFS)) {
    const members = classes.get(name);
    if (!members) continue;
    lines.push(`  classDef ${name} ${style}`);
    lines.push(`  class ${members.join(',')} ${name}`);
  }
  for (const [, matches, style] of LINK_STYLES) {
    const indexes: number[] = [];
    view.edges.forEach((e, i) => matches(e) && indexes.push(i));
    if (indexes.length) lines.push(`  linkStyle ${indexes.join(',')} ${style}`);
  }

  const text = `${lines.join('\n')}\n`;
  if (text.length > MERMAID_MAX_TEXT)
    throw new ExportTooLargeError(
      `O diagrama Mermaid teria ${text.length} caracteres (o Mermaid aceita até ${MERMAID_MAX_TEXT}).`,
      HINT,
    );
  return text;
}
