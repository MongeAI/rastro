import type { NodeSingular, StylesheetJson } from 'cytoscape';
import type { ViewNode } from '@rastro/graph';
import { GROUP_PADDING } from './elkLayout';
import type { Palette } from './theme';

const SANS = 'Inter, ui-sans-serif, system-ui, sans-serif';
const MONO = 'JetBrains Mono, ui-monospace, monospace';

/** Texto exibido no nó: arquivos com símbolos ganham "+", pastas recolhidas mostram a contagem. */
export function displayLabel(n: ViewNode, files: (count: number) => string): string {
  if (n.collapsed) return `${n.label}/  ·  ${files(n.fileCount ?? 0)}`;
  if (n.kind === 'file' && n.expandable && !n.expanded) return `${n.label}  +`;
  return n.label;
}

/**
 * Largura estimada pelo tamanho do rótulo. Calculada uma vez ao criar o nó (vai em `data.w`):
 * uma função no estilo seria reavaliada a cada recálculo, caro com milhares de nós.
 */
export function estimateNodeWidth(display: string, kind: string, collapsed: boolean): number {
  const charWidth = kind === 'method' ? 6.4 : collapsed ? 7.4 : 7;
  return Math.max(40, Math.min(360, display.length * charWidth + 28));
}

/**
 * Tamanho do rótulo de um grupo: cresce quando o zoom diminui (o mapa continua legível de
 * longe), mas nunca fica mais largo que a própria caixa, para não invadir os vizinhos.
 */
function groupFontSize(scale: () => number, groupWidth: (id: string) => number | undefined) {
  return (n: NodeSingular) => {
    const label = String(n.data('display') ?? '');
    const factor = scale();
    if (factor <= 1) return 11;
    // largura do grupo medida depois do layout; medir aqui seria caro
    const width = groupWidth(n.id()) ?? label.length * 6.8;
    const byBox = (width + 2 * GROUP_PADDING) / Math.max(1, label.length * 0.62);
    return Math.max(11, Math.min(11 * factor, byBox));
  };
}

/** `labelScale` informa o fator atual de ampliação dos rótulos dos grupos (1 = sem ampliação). */
export function buildStyle(
  p: Palette,
  labelScale: () => number = () => 1,
  groupWidth: (id: string) => number | undefined = () => undefined,
): StylesheetJson {
  const groupFont = groupFontSize(labelScale, groupWidth);
  const groupMargin = (n: NodeSingular) => -4 * (groupFont(n) / 11);
  const kinds = Object.keys(p.node) as Array<keyof Palette['node']>;
  return [
    {
      selector: 'node',
      style: {
        label: 'data(display)',
        'font-family': SANS,
        'font-size': 12,
        'font-weight': 500,
        color: p.text,
        'text-valign': 'center',
        'text-halign': 'center',
        'min-zoomed-font-size': 4,
        width: 'data(w)',
        height: 28,
        shape: 'round-rectangle',
        'corner-radius': '6',
        'background-color': p.surface,
        'border-width': 1.2,
        'border-color': p.border,
        'transition-property': 'opacity',
        'transition-duration': 160,
      },
    },
    ...kinds.map((kind) => ({
      selector: `node[kind = "${kind}"]`,
      style: {
        'border-color': p.node[kind],
        'background-color': p.node[kind],
        'background-opacity': kind === 'file' ? 0.08 : 0.16,
      },
    })),
    { selector: 'node[kind = "function"]', style: { 'corner-radius': '14' } },
    {
      selector: 'node[kind = "method"]',
      style: { 'corner-radius': '12', height: 24, 'font-size': 11 },
    },
    { selector: 'node[kind = "class"]', style: { shape: 'cut-rectangle', height: 30 } },
    {
      selector: 'node[kind = "route"]',
      style: { shape: 'round-tag', 'font-family': MONO, 'font-size': 11 },
    },
    {
      selector: 'node[kind = "package"]',
      style: { shape: 'barrel', 'border-style': 'dashed', color: p.muted },
    },
    {
      selector: 'node[kind = "unresolved"]',
      style: { 'border-style': 'dashed', color: p.unresolved, 'background-opacity': 0.08 },
    },
    { selector: 'node.not-analyzed', style: { 'border-style': 'dotted', color: p.muted } },
    { selector: 'node.expandable', style: { 'border-width': 1.6 } },
    {
      selector: 'node.collapsed',
      style: {
        'font-family': MONO,
        'font-size': 12,
        height: 36,
        'border-style': 'dashed',
        'border-width': 1.6,
        'border-color': p.text,
        'background-color': p.text,
        'background-opacity': 0.06,
        'corner-radius': '8',
      },
    },
    {
      selector: ':parent',
      style: {
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': groupMargin,
        'font-size': groupFont,
        color: p.muted,
        padding: `${GROUP_PADDING}px`,
        'background-opacity': 0.035,
        shape: 'round-rectangle',
        'corner-radius': '10',
      },
    },
    {
      selector: 'node[kind = "module"]:parent',
      style: {
        'border-style': 'dashed',
        'border-color': p.border,
        'font-family': MONO,
        'font-size': groupFont,
      },
    },
    {
      selector: 'node[kind = "file"]:parent',
      style: { 'border-color': p.node.file, 'border-opacity': 0.5, color: p.text },
    },
    { selector: 'node[kind = "class"]:parent', style: { color: p.node.class } },
    { selector: 'node.cycle', style: { 'border-color': p.cycle, 'border-width': 2 } },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        width: 'mapData(count, 1, 12, 1.1, 3.2)',
        'line-color': p.edge.imports,
        'target-arrow-color': p.edge.imports,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.8,
        opacity: 0.7,
        'transition-property': 'opacity',
        'transition-duration': 160,
      },
    },
    ...(Object.keys(p.edge) as Array<keyof Palette['edge']>).map((kind) => ({
      selector: `edge[kind = "${kind}"]`,
      style: { 'line-color': p.edge[kind], 'target-arrow-color': p.edge[kind] },
    })),
    // mapas com milhares de linhas: retas (as curvas calculam pontos de controle e agrupam
    // linhas paralelas, caro nessa escala) e sem transição de opacidade
    { selector: 'edge.fast', style: { 'curve-style': 'straight', 'transition-duration': 0 } },
    {
      selector: 'edge[kind = "extends"]',
      style: { 'target-arrow-fill': 'hollow', 'arrow-scale': 1.1 },
    },
    { selector: 'edge[kind = "exports"]', style: { 'line-style': 'dotted' } },
    {
      selector: 'edge.aggregated',
      style: { width: 'mapData(count, 1, 30, 1.6, 5)', opacity: 0.8 },
    },
    {
      selector: 'edge[resolution = "external"]',
      style: { 'line-style': 'dashed', 'line-dash-pattern': [5, 4] },
    },
    {
      selector: 'edge[resolution = "unresolved"]',
      style: {
        'line-style': 'dashed',
        'line-color': p.unresolved,
        'target-arrow-color': p.unresolved,
        'line-dash-pattern': [3, 3],
      },
    },
    { selector: 'edge.type-only', style: { 'line-style': 'dotted' } },
    { selector: 'edge.cycle', style: { 'line-color': p.cycle, 'target-arrow-color': p.cycle } },
    { selector: '.faded', style: { opacity: 0.12 } },
    { selector: 'edge.faded', style: { opacity: 0.04 } },
    { selector: 'edge.highlight', style: { opacity: 1, width: 2.4, 'z-index': 10 } },
    {
      selector: 'edge.chosen',
      style: {
        opacity: 1,
        width: 3.4,
        'z-index': 30,
        'underlay-color': p.selection,
        'underlay-opacity': 0.15,
        'underlay-padding': 4,
      },
    },
    {
      selector: 'node.chosen',
      style: {
        'border-width': 2.5,
        'border-color': p.selection,
        'underlay-color': p.selection,
        'underlay-opacity': 0.12,
        'underlay-padding': 6,
        'z-index': 20,
      },
    },
    { selector: 'node.hover', style: { 'border-width': 2, 'border-color': p.selection } },
    {
      selector: 'node.changed',
      style: {
        'border-width': 3,
        'border-color': p.changed,
        'border-style': 'solid',
        'underlay-color': p.changed,
        'underlay-opacity': 0.18,
        'underlay-padding': 5,
        'z-index': 22,
      },
    },
    {
      selector: 'node.impacted',
      style: {
        'border-width': 2,
        'border-color': p.changed,
        'border-style': 'dashed',
        'z-index': 21,
      },
    },
    {
      selector: 'edge.impact-edge',
      style: { opacity: 0.9, 'line-color': p.changed, 'target-arrow-color': p.changed },
    },
    {
      selector: 'node.violation',
      style: {
        'border-width': 3,
        'border-color': p.violation,
        'border-style': 'solid',
        'underlay-color': p.violation,
        'underlay-opacity': 0.16,
        'underlay-padding': 5,
        'z-index': 22,
      },
    },
    {
      selector: 'edge.violation',
      style: {
        width: 3.2,
        opacity: 1,
        'line-color': p.violation,
        'target-arrow-color': p.violation,
        'line-style': 'solid',
        'z-index': 38,
      },
    },
    {
      selector: 'node.path',
      style: { 'border-width': 2.5, 'border-color': p.selection, 'z-index': 25 },
    },
    {
      selector: 'edge.path',
      style: {
        width: 3.6,
        opacity: 1,
        'line-color': p.selection,
        'target-arrow-color': p.selection,
        'line-style': 'solid',
        'z-index': 40,
      },
    },
  ];
}
