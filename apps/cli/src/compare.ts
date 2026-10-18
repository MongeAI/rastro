import { EDGE_KIND_LABELS, type NodeKind, type Resolution } from '@rastro/core';
import type { ComparedStat, DiffEdge, DiffNode, GraphDiff } from '@rastro/graph';
import { bold, cyan, dim, green, red, yellow } from './term.js';

/** Itens mostrados por grupo antes do "… e mais N". */
const LIST_LIMIT = 15;

const KIND_PLURAL: Record<NodeKind, string> = {
  module: 'Pastas',
  file: 'Arquivos',
  function: 'Funções',
  class: 'Classes',
  method: 'Métodos',
  route: 'Rotas',
  package: 'Pacotes externos',
  unresolved: 'Não resolvidos',
};

const STAT_LABELS: Record<ComparedStat, string> = {
  files: 'arquivos analisados',
  functions: 'funções',
  classes: 'classes',
  methods: 'métodos',
  routes: 'rotas',
  packages: 'pacotes externos',
  unresolved: 'relações não resolvidas',
  cycles: 'ciclos de importação',
  nodes: 'nós',
  edges: 'relações',
};

const RESOLUTION_SHORT: Record<Resolution, string> = {
  resolved: 'resolvida',
  external: 'externa',
  unresolved: 'não resolvida',
};

/** `fn:src/a.ts#run` → `src/a.ts#run` (o prefixo do tipo já aparece no título do grupo). */
const shortId = (id: string) => id.slice(id.indexOf(':') + 1);

function groupBy<T, K extends string>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(item);
  }
  return groups;
}

function capped<T>(items: T[], line: (item: T) => string, out: string[]): void {
  for (const item of items.slice(0, LIST_LIMIT)) out.push(line(item));
  if (items.length > LIST_LIMIT) out.push(dim(`      … e mais ${items.length - LIST_LIMIT}`));
}

const nodeLine = (sign: string) => (n: DiffNode) => {
  const label = n.kind === 'file' || n.kind === 'module' ? (n.file ?? n.name) : shortId(n.id);
  return `    ${sign} ${label}`;
};

const edgeLine = (sign: string) => (e: DiffEdge) =>
  `    ${sign} ${shortId(e.source)} ${dim('→')} ${shortId(e.target)}${
    e.resolution === 'resolved' ? '' : dim(` (${RESOLUTION_SHORT[e.resolution]})`)
  }`;

/** Resumo legível da comparação, em português, agrupado e com listas limitadas. */
export function formatDiff(diff: GraphDiff): string {
  const out: string[] = [];
  const when = (iso: string) => (iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '?');
  out.push(
    `${bold('Comparação')} ${diff.before.project} ${dim(`(${when(diff.before.generatedAt)})`)} ${dim('→')} ${diff.after.project} ${dim(`(${when(diff.after.generatedAt)})`)}`,
  );
  if (diff.before.root !== diff.after.root)
    out.push(dim('  as análises são de pastas diferentes; ids iguais ainda são comparados.'));
  out.push('');

  out.push(bold('Números'));
  const width = Math.max(...Object.values(STAT_LABELS).map((l) => l.length));
  for (const [key, label] of Object.entries(STAT_LABELS) as Array<[ComparedStat, string]>) {
    const s = diff.stats[key];
    const delta =
      s.delta === 0 ? dim('=') : s.delta > 0 ? green(`+${s.delta}`) : red(String(s.delta));
    out.push(
      `  ${label.padEnd(width)}  ${String(s.before).padStart(6)} → ${String(s.after).padEnd(6)} ${delta}`,
    );
  }

  if (diff.identical) {
    out.push('', 'Nenhum nó, relação ou ciclo mudou entre as duas análises.');
    return `${out.join('\n')}\n`;
  }

  const nodeSection = (title: string, items: DiffNode[], sign: string) => {
    if (!items.length) return;
    out.push('', bold(`${title} (${items.length})`));
    for (const [kind, list] of groupBy(items, (n) => n.kind)) {
      out.push(`  ${KIND_PLURAL[kind]} ${dim(`(${list.length})`)}`);
      capped(list, nodeLine(sign), out);
    }
  };
  const edgeSection = (title: string, items: DiffEdge[], sign: string) => {
    if (!items.length) return;
    out.push('', bold(`${title} (${items.length})`));
    for (const [kind, list] of groupBy(items, (e) => e.kind)) {
      out.push(`  ${EDGE_KIND_LABELS[kind]} ${dim(`(${list.length})`)}`);
      capped(list, edgeLine(sign), out);
    }
  };

  nodeSection('Entraram', diff.nodes.added, green('+'));
  nodeSection('Saíram', diff.nodes.removed, red('-'));
  edgeSection('Relações novas', diff.edges.added, green('+'));
  edgeSection('Relações removidas', diff.edges.removed, red('-'));

  const changed = diff.edges.resolutionChanged;
  if (changed.length) {
    out.push('', bold(`Resolução alterada (${changed.length})`));
    capped(
      changed,
      (c) =>
        `    ${yellow('~')} ${EDGE_KIND_LABELS[c.kind].toLowerCase()} ${shortId(c.source)} ${dim('→')} ${shortId(c.target)}: ${RESOLUTION_SHORT[c.before]} ${dim('→')} ${RESOLUTION_SHORT[c.after]}`,
      out,
    );
  }

  const cycles = (title: string, list: string[][], sign: string) => {
    if (!list.length) return;
    out.push('', bold(`${title} (${list.length})`));
    capped(list, (c) => `    ${sign} ${c.map(shortId).join(dim(' ↔ '))}`, out);
  };
  cycles('Ciclos de importação novos', diff.cycles.added, yellow('!'));
  cycles('Ciclos de importação desfeitos', diff.cycles.removed, cyan('✓'));
  return `${out.join('\n')}\n`;
}
