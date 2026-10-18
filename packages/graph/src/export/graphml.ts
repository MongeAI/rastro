import type { RastroGraph } from '@rastro/core';
import {
  buildExportView,
  firstEvidence,
  nodeLabel,
  nodeLocation,
  type ExportOptions,
} from './common.js';

export type GraphMLOptions = ExportOptions;

/**
 * Texto seguro em XML 1.0 (conteúdo e atributos): escapa `& < > " '` e remove caracteres
 * que o XML não aceita (controles, surrogates soltos, U+FFFE/U+FFFF).
 */
export function xmlEscape(text: string): string {
  return text
    .replace(
      // eslint-disable-next-line no-control-regex -- remove caracteres de controle de propósito
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
      '',
    )
    .replace(/[&<>"']/g, (c) => XML_ENTITIES[c]!);
}

const XML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Chaves (atributos) declaradas no GraphML: [id, para, nome, tipo]. */
const KEYS: Array<[string, 'graph' | 'node' | 'edge', string, 'string' | 'int' | 'boolean']> = [
  ['g_project', 'graph', 'project', 'string'],
  ['g_level', 'graph', 'level', 'string'],
  ['g_folder', 'graph', 'folder', 'string'],
  ['n_label', 'node', 'label', 'string'],
  ['n_kind', 'node', 'kind', 'string'],
  ['n_parent', 'node', 'parent', 'string'],
  ['n_file', 'node', 'file', 'string'],
  ['n_line', 'node', 'line', 'int'],
  ['n_in_cycle', 'node', 'inCycle', 'boolean'],
  ['n_file_count', 'node', 'fileCount', 'int'],
  ['e_kind', 'edge', 'kind', 'string'],
  ['e_resolution', 'edge', 'resolution', 'string'],
  ['e_count', 'edge', 'count', 'int'],
  ['e_aggregated', 'edge', 'aggregated', 'boolean'],
  ['e_type_only', 'edge', 'typeOnly', 'boolean'],
  ['e_file', 'edge', 'file', 'string'],
  ['e_line', 'edge', 'line', 'int'],
];

/**
 * GraphML da visão (yEd, Gephi, Cytoscape desktop, networkx...). Os nós ficam numa lista
 * plana, com a hierarquia em `parent`, que é o que a maioria das ferramentas entende.
 */
export function toGraphML(graph: RastroGraph, options: GraphMLOptions = {}): string {
  const view = buildExportView(graph, options);
  const data = (key: string, value: string | number | boolean | undefined, pad: string) =>
    value === undefined ? '' : `${pad}<data key="${key}">${xmlEscape(String(value))}</data>\n`;

  let out = '<?xml version="1.0" encoding="UTF-8"?>\n';
  out +=
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">\n';
  for (const [id, target, name, type] of KEYS)
    out += `  <key id="${id}" for="${target}" attr.name="${name}" attr.type="${type}"/>\n`;
  out += '  <graph id="rastro" edgedefault="directed">\n';
  out += data('g_project', view.graph.project.name, '    ');
  out += data('g_level', view.level, '    ');
  out += data('g_folder', view.folder, '    ');

  for (const node of view.nodes) {
    const loc = nodeLocation(node, view.index);
    out += `    <node id="${xmlEscape(node.id)}">\n`;
    out += data('n_label', nodeLabel(node), '      ');
    out += data('n_kind', node.kind, '      ');
    out += data('n_parent', node.parent, '      ');
    out += data('n_file', loc?.file, '      ');
    out += data('n_line', loc?.line, '      ');
    if (node.inCycle) out += data('n_in_cycle', true, '      ');
    out += data('n_file_count', node.fileCount, '      ');
    out += '    </node>\n';
  }
  for (const edge of view.edges) {
    const ev = firstEvidence(edge, view.index);
    out +=
      `    <edge id="${xmlEscape(edge.id)}" source="${xmlEscape(edge.source)}" ` +
      `target="${xmlEscape(edge.target)}">\n`;
    out += data('e_kind', edge.kind, '      ');
    out += data('e_resolution', edge.resolution, '      ');
    out += data('e_count', edge.count, '      ');
    if (edge.aggregated) out += data('e_aggregated', true, '      ');
    if (edge.typeOnly) out += data('e_type_only', true, '      ');
    out += data('e_file', ev?.file, '      ');
    out += data('e_line', ev?.line, '      ');
    out += '    </edge>\n';
  }
  out += '  </graph>\n</graphml>\n';
  return out;
}
