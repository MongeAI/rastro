import type { NodeKind, RastroGraph } from '@rastro/core';
import type { ViewEdge, ViewNode } from '../view.js';
import {
  buildExportView,
  edgeLabel,
  exportTitle,
  LEVEL_LABELS,
  nodeLabel,
  viewTree,
  type ExportOptions,
} from './common.js';

export interface DotOptions extends ExportOptions {
  /** `rankdir` do Graphviz. Padrão: `LR`. */
  direction?: 'LR' | 'TB';
}

/**
 * Texto entre aspas no DOT. Escapa `\` e `"`, e troca quebras de linha por `\n`
 * (nos rótulos, o Graphviz interpreta `\\` como uma barra).
 */
export function dotString(text: string): string {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n|\r/g, '\\n')
    // eslint-disable-next-line no-control-regex -- remove caracteres de controle de propósito
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  return `"${escaped}"`;
}

const NODE_ATTRS: Record<NodeKind, Record<string, string>> = {
  module: { shape: 'folder', style: 'filled', fillcolor: '#f4f4f5', color: '#71717a' },
  file: { shape: 'note', style: 'filled', fillcolor: '#ffffff', color: '#27272a' },
  function: { shape: 'box', style: 'rounded', color: '#2563eb' },
  method: { shape: 'box', style: 'rounded', color: '#0d9488' },
  class: { shape: 'box', style: 'rounded,bold', color: '#9333ea' },
  route: { shape: 'cds', color: '#d97706' },
  package: { shape: 'box', style: 'rounded,dashed', color: '#71717a', fontcolor: '#52525b' },
  unresolved: { shape: 'box', style: 'dashed', color: '#dc2626', fontcolor: '#dc2626' },
};

const EDGE_COLORS: Record<string, string> = {
  imports: '#71717a',
  calls: '#0284c7',
  extends: '#9333ea',
  exports: '#a1a1aa',
  depends_on: '#db2777',
};

const attrs = (values: Record<string, string>) =>
  `[${Object.entries(values)
    .map(([k, v]) => `${k}=${dotString(v)}`)
    .join(', ')}]`;

/** Grafo DOT (Graphviz) da visão; pastas, arquivos e classes abertos viram `cluster`. */
export function toDot(graph: RastroGraph, options: DotOptions = {}): string {
  const view = buildExportView(graph, options);
  const { roots, children } = viewTree(view.nodes);
  const isCluster = (id: string) => (children.get(id)?.length ?? 0) > 0;
  // um cluster não pode ser ponta de relação: usa-se um nó invisível dentro dele (+ lhead/ltail)
  const anchored = new Set<string>();
  for (const e of view.edges)
    for (const id of [e.source, e.target]) if (isCluster(id)) anchored.add(id);

  const lines: string[] = [
    `// ${exportTitle(view)}`,
    `digraph ${dotString('rastro')} {`,
    `  graph ${attrs({
      rankdir: options.direction ?? 'LR',
      compound: 'true',
      fontname: 'Helvetica',
      fontsize: '11',
      label: `${view.graph.project.name} · ${LEVEL_LABELS[view.level]}${view.folder ? ` · ${view.folder}` : ''}`,
      labelloc: 't',
    })};`,
    `  node ${attrs({ shape: 'box', fontname: 'Helvetica', fontsize: '10' })};`,
    `  edge ${attrs({ fontname: 'Helvetica', fontsize: '9', arrowsize: '0.7' })};`,
  ];

  const emit = (node: ViewNode, depth: number) => {
    const pad = '  '.repeat(depth);
    const label = nodeLabel(node);
    const kids = children.get(node.id);
    if (kids?.length) {
      lines.push(`${pad}subgraph ${dotString(`cluster_${node.id}`)} {`);
      lines.push(
        `${pad}  graph ${attrs({
          label,
          tooltip: node.id,
          style: node.kind === 'module' ? 'dashed' : 'rounded',
          color: node.inCycle ? '#ea580c' : node.kind === 'class' ? '#9333ea' : '#a1a1aa',
        })};`,
      );
      if (anchored.has(node.id))
        lines.push(
          `${pad}  ${dotString(node.id)} ${attrs({ shape: 'point', style: 'invis', width: '0', height: '0', label: '' })};`,
        );
      for (const child of kids) emit(child, depth + 1);
      lines.push(`${pad}}`);
      return;
    }
    const values: Record<string, string> = { label, tooltip: node.id, ...NODE_ATTRS[node.kind] };
    if (node.inCycle) Object.assign(values, { color: '#ea580c', penwidth: '2' });
    lines.push(`${pad}${dotString(node.id)} ${attrs(values)};`);
  };
  for (const root of roots) emit(root, 1);

  const showKind = new Set(view.edges.map((e) => e.kind)).size > 1;
  for (const edge of view.edges) lines.push(`  ${edgeLine(edge, showKind, isCluster)}`);
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function edgeLine(edge: ViewEdge, showKind: boolean, isCluster: (id: string) => boolean): string {
  const values: Record<string, string> = {};
  const label = edgeLabel(edge, showKind);
  if (label) values.label = label;
  values.color =
    edge.resolution === 'unresolved'
      ? '#dc2626'
      : edge.resolution === 'external'
        ? '#a1a1aa'
        : (EDGE_COLORS[edge.kind] ?? '#71717a');
  if (edge.resolution !== 'resolved') values.style = 'dashed';
  else if (edge.typeOnly || edge.kind === 'exports') values.style = 'dotted';
  if (isCluster(edge.source)) values.ltail = `cluster_${edge.source}`;
  if (isCluster(edge.target)) values.lhead = `cluster_${edge.target}`;
  return `${dotString(edge.source)} -> ${dotString(edge.target)} ${attrs(values)};`;
}
