import { kindLabels, type Lang } from '@rastro/core';
import type { ComparedStat, DiffEdge, DiffNode, GraphDiff, RouteAddress } from '@rastro/graph';
import { getLang, MESSAGES, type Messages } from './i18n.js';
import { bold, cyan, dim, green, red, safeText, yellow } from './term.js';

/** Itens mostrados por grupo antes do "… e mais N". */
const LIST_LIMIT = 15;

/**
 * `fn:src/a.ts#run` → `src/a.ts#run` (o prefixo do tipo já aparece no título do grupo). Ids e
 * nomes vêm do JSON comparado: saem sem caracteres de controle.
 */
const shortId = (id: string) => safeText(id.slice(id.indexOf(':') + 1));

function groupBy<T, K extends string>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(item);
  }
  return groups;
}

function capped<T>(
  items: T[],
  line: (item: T) => string,
  out: string[],
  m: Messages['compare'],
): void {
  for (const item of items.slice(0, LIST_LIMIT)) out.push(line(item));
  if (items.length > LIST_LIMIT) out.push(dim(`      ${m.andMore(items.length - LIST_LIMIT)}`));
}

const nodeLine = (sign: string) => (n: DiffNode) => {
  const label = n.kind === 'file' || n.kind === 'module' ? (n.file ?? n.name) : shortId(n.id);
  return `    ${sign} ${safeText(label)}`;
};

const edgeLine = (sign: string, m: Messages['compare']) => (e: DiffEdge) =>
  `    ${sign} ${shortId(e.source)} ${dim('→')} ${shortId(e.target)}${
    e.resolution === 'resolved' ? '' : dim(` (${m.resolution[e.resolution]})`)
  }`;

/** Resumo legível da comparação (no idioma da CLI), agrupado e com listas limitadas. */
export function formatDiff(diff: GraphDiff, lang: Lang = getLang()): string {
  const m = MESSAGES[lang].compare;
  const edgeLabels = kindLabels(lang).edge;
  const out: string[] = [];
  const when = (iso: string) =>
    iso ? safeText(iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')) : '?';
  out.push(
    `${bold(m.title)} ${safeText(diff.before.project)} ${dim(`(${when(diff.before.generatedAt)})`)} ${dim('→')} ${safeText(diff.after.project)} ${dim(`(${when(diff.after.generatedAt)})`)}`,
  );
  if (diff.before.root !== diff.after.root) out.push(dim(`  ${m.differentRoots}`));
  out.push('');

  out.push(bold(m.numbers));
  const width = Math.max(...Object.values(m.stats).map((l) => l.length));
  for (const [key, label] of Object.entries(m.stats) as Array<[ComparedStat, string]>) {
    const s = diff.stats[key];
    const delta =
      s.delta === 0 ? dim('=') : s.delta > 0 ? green(`+${s.delta}`) : red(String(s.delta));
    out.push(
      `  ${label.padEnd(width)}  ${String(s.before).padStart(6)} → ${String(s.after).padEnd(6)} ${delta}`,
    );
  }

  if (diff.identical) {
    out.push('', m.identical);
    return `${out.join('\n')}\n`;
  }

  const nodeSection = (title: string, items: DiffNode[], sign: string) => {
    if (!items.length) return;
    out.push('', bold(`${title} (${items.length})`));
    for (const [kind, list] of groupBy(items, (n) => n.kind)) {
      out.push(`  ${m.kindPlural[kind]} ${dim(`(${list.length})`)}`);
      capped(list, nodeLine(sign), out, m);
    }
  };
  const edgeSection = (title: string, items: DiffEdge[], sign: string) => {
    if (!items.length) return;
    out.push('', bold(`${title} (${items.length})`));
    for (const [kind, list] of groupBy(items, (e) => e.kind)) {
      out.push(`  ${edgeLabels[kind]} ${dim(`(${list.length})`)}`);
      capped(list, edgeLine(sign, m), out, m);
    }
  };

  nodeSection(m.added, diff.nodes.added, green('+'));
  nodeSection(m.removed, diff.nodes.removed, red('-'));
  // rotas com o mesmo id e outro endereço (caminho completo ou montagem)
  const moved = diff.nodes.changed ?? [];
  if (moved.length) {
    out.push('', bold(`${m.changed} (${moved.length})`));
    const address = (a: RouteAddress) =>
      safeText(
        a.fullPath ?? (a.mountedAt?.length ? m.mountedAt(a.mountedAt.join(', ')) : m.unknownPath),
      );
    capped(
      moved,
      (c) =>
        `    ${yellow('~')} ${shortId(c.id)}: ${address(c.before)} ${dim('→')} ${address(c.after)}`,
      out,
      m,
    );
  }
  edgeSection(m.edgesAdded, diff.edges.added, green('+'));
  edgeSection(m.edgesRemoved, diff.edges.removed, red('-'));

  const changed = diff.edges.resolutionChanged;
  if (changed.length) {
    out.push('', bold(`${m.resolutionChanged} (${changed.length})`));
    capped(
      changed,
      (c) =>
        `    ${yellow('~')} ${edgeLabels[c.kind].toLowerCase()} ${shortId(c.source)} ${dim('→')} ${shortId(c.target)}: ${m.resolution[c.before]} ${dim('→')} ${m.resolution[c.after]}`,
      out,
      m,
    );
  }

  const cycles = (title: string, list: string[][], sign: string) => {
    if (!list.length) return;
    out.push('', bold(`${title} (${list.length})`));
    capped(list, (c) => `    ${sign} ${c.map(shortId).join(dim(' ↔ '))}`, out, m);
  };
  cycles(m.cyclesAdded, diff.cycles.added, yellow('!'));
  cycles(m.cyclesRemoved, diff.cycles.removed, cyan('✓'));
  return `${out.join('\n')}\n`;
}
