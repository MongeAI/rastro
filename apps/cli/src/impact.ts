import path from 'node:path';
import {
  compareStrings,
  kindLabels,
  RASTRO_VERSION,
  type ChangedFile,
  type GraphNode,
  type RastroGraph,
} from '@rastro/core';
import { computeChangeImpact, GraphIndex } from '@rastro/graph';
import { getLang, t } from './i18n.js';
import { bold, cyan, dim, safeText, yellow } from './term.js';

/**
 * `rastro impact`: o impacto das mudanças do git em texto (terminal), Markdown (comentário de
 * pull request) ou JSON (CI). Tudo vem de `computeChangeImpact`, o mesmo cálculo da aba
 * Mudanças da interface: só relações comprovadas entram no impacto.
 */

export const IMPACT_FORMATS = ['text', 'markdown', 'json'] as const;
export type ImpactFormat = (typeof IMPACT_FORMATS)[number];

export interface ImpactItem {
  id: string;
  kind: GraphNode['kind'];
  name: string;
  /** Arquivo (relativo à raiz analisada) e linha onde a entidade começa. */
  file?: string;
  line?: number;
}

export interface ImpactedItem extends ImpactItem {
  /** Distância até o que mudou, em relações (1 = depende diretamente). */
  depth: number;
  /** A relação que leva até o que mudou: tipo e o nome do outro lado. */
  via: { kind: string; target: string };
}

export interface ImpactReport {
  tool: { name: 'rastro'; version: string };
  project: string;
  base: string;
  baseLabel: string;
  summary: {
    files: number;
    changed: number;
    impacted: number;
    routes: number;
    tests: number;
    outsideGraph: number;
  };
  changed: ImpactItem[];
  impacted: ImpactedItem[];
  routes: ImpactItem[];
  /** Arquivos de teste alterados ou que dependem do que mudou (relativos à raiz analisada). */
  tests: string[];
  /** Arquivos alterados fora do mapa (removidos, não analisados, ignorados). */
  outsideGraph: Array<{ file: string; status: ChangedFile['status'] }>;
}

/** Nomes vêm do código analisado: um literal enorme não pode estourar um comentário. */
const MAX_NAME = 160;
const clip = (s: string) => (s.length > MAX_NAME ? `${s.slice(0, MAX_NAME - 1)}…` : s);

const display = (n: GraphNode) =>
  clip(n.qualifiedName && n.kind !== 'file' && n.kind !== 'module' ? n.qualifiedName : n.name);

function item(n: GraphNode): ImpactItem {
  const file = n.location?.file ?? (n.kind === 'file' ? n.qualifiedName : undefined);
  return {
    id: n.id,
    kind: n.kind,
    name: display(n),
    ...(file ? { file } : {}),
    ...(n.location && n.kind !== 'file' ? { line: n.location.startLine } : {}),
  };
}

/** Monta o relatório a partir de um grafo com mudanças do git (`graph.changes`). */
export function buildImpactReport(graph: RastroGraph): ImpactReport {
  const changes = graph.changes;
  if (!changes) throw new Error('graph without changes');
  const index = new GraphIndex(graph);
  const impact = computeChangeImpact(index, changes);
  // arquivos alterados sem nenhuma entidade alterada dentro (código no topo do arquivo,
  // arquivo novo ou renomeado); quem já aparece como afetado fica só lá
  const impactedIds = new Set(impact.impacted.map((i) => i.node.id));
  const fileLevel = impact.changedFiles.filter(
    (f) =>
      !impactedIds.has(f.id) &&
      !impact.changedEntities.some((e) => index.fileOf(e.id)?.id === f.id),
  );
  const changed = [...impact.changedEntities, ...fileLevel]
    .map(item)
    .sort((a, b) => compareStrings(a.file ?? '', b.file ?? '') || (a.line ?? 0) - (b.line ?? 0));
  const tests = impact.tests.map((f) => f.qualifiedName ?? f.name).sort(compareStrings);
  return {
    tool: { name: 'rastro', version: RASTRO_VERSION },
    project: graph.project.name,
    base: changes.base,
    baseLabel: changes.baseLabel,
    summary: {
      files: changes.files.length,
      // como na aba Mudanças: entidades (funções, classes, métodos, rotas) alteradas
      changed: impact.changedEntities.length,
      impacted: impact.impacted.length,
      routes: impact.routes.length,
      tests: tests.length,
      outsideGraph: impact.outsideGraph.length,
    },
    changed,
    impacted: impact.impacted.map((entry) => ({
      ...item(entry.node),
      depth: entry.depth,
      via: {
        kind: entry.via.kind,
        target: (() => {
          const other = index.node(entry.via.target);
          return other ? display(other) : entry.via.target;
        })(),
      },
    })),
    routes: impact.routes.map(item),
    tests,
    outsideGraph: impact.outsideGraph.map((f) => ({ file: f.file, status: f.status })),
  };
}

/** Caminhos dos testes afetados relativos à pasta atual, prontos para o executor de testes. */
export function testPathsFrom(report: ImpactReport, root: string, cwd = process.cwd()): string[] {
  return report.tests.map((file) => {
    const relative = path.relative(cwd, path.join(root, file)).split(path.sep).join('/');
    return relative.startsWith('.') ? relative : `./${relative}`;
  });
}

export interface RenderOptions {
  /** Base dos links `arquivo:linha` no Markdown (ex.: https://github.com/org/repo/blob/<commit>). */
  link?: string;
  /** Máximo de itens por lista no texto e no Markdown (o JSON vem completo). */
  limit?: number;
}

export function renderImpact(
  report: ImpactReport,
  format: ImpactFormat,
  options: RenderOptions = {},
): string {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  return format === 'markdown' ? renderMarkdown(report, options) : renderText(report, options);
}

// ---------------------------------------------------------------------------
// texto (terminal)

function renderText(report: ImpactReport, options: RenderOptions): string {
  const m = t().impact;
  const labels = kindLabels(getLang());
  const limit = options.limit ?? 50;
  const lines: string[] = [];
  const where = (i: ImpactItem) =>
    i.file ? dim(safeText(`${i.file}${i.line ? `:${i.line}` : ''}`)) : '';
  const kind = (i: ImpactItem) => dim(`(${labels.node[i.kind].toLowerCase()})`);
  const more = (total: number) => {
    if (total > limit) lines.push(`  ${dim(m.more(total - limit))}`);
  };

  lines.push(`${bold(m.title)} ${dim(sinceLabel(report))}`);
  lines.push(`  ${summaryLine(report)}`);
  if (!report.summary.files) return `${lines.join('\n')}\n`;

  if (report.changed.length) {
    lines.push('', bold(m.changed));
    for (const i of report.changed.slice(0, limit))
      lines.push(`  ${cyan('•')} ${safeText(i.name)} ${kind(i)} ${where(i)}`);
    more(report.changed.length);
  }
  lines.push('', bold(m.impacted));
  if (!report.impacted.length) lines.push(`  ${dim(m.nothingDepends)}`);
  for (const i of report.impacted.slice(0, limit))
    lines.push(
      `  ${yellow(String(i.depth))} ${safeText(i.name)} ${kind(i)} ${where(i)} ${dim(
        `← ${viaText(i)}`,
      )}`,
    );
  more(report.impacted.length);
  if (report.routes.length) {
    lines.push('', bold(m.routes));
    for (const i of report.routes.slice(0, limit))
      lines.push(`  ${cyan('↳')} ${safeText(i.name)} ${where(i)}`);
    more(report.routes.length);
  }
  if (report.tests.length) {
    lines.push('', bold(m.tests));
    for (const file of report.tests.slice(0, limit)) lines.push(`  ${cyan('•')} ${safeText(file)}`);
    more(report.tests.length);
  }
  if (report.outsideGraph.length) {
    lines.push('', bold(m.outside));
    for (const f of report.outsideGraph.slice(0, limit))
      lines.push(`  ${dim('•')} ${safeText(f.file)} ${dim(`(${m.status[f.status]})`)}`);
    more(report.outsideGraph.length);
  }
  lines.push('', dim(m.footnote));
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Markdown (comentário de pull request)

/** Marcador para encontrar e atualizar o mesmo comentário a cada push. */
export const MARKDOWN_MARKER = '<!-- rastro-impact -->';

/**
 * Texto vindo do projeto analisado (nomes, caminhos) em um trecho de código: nada de links,
 * imagens, menções ou HTML injetados num comentário público. Caracteres de controle e quebras
 * de linha viram espaço; em tabelas, `|` é escapado (o GitHub exige até dentro de código).
 */
export function mdCode(text: string, inTable = false): string {
  // eslint-disable-next-line no-control-regex -- é exatamente o que queremos remover
  let clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  if (inTable) clean = clean.replace(/\|/g, '\\|');
  const longest = Math.max(0, ...[...clean.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = clean.startsWith('`') || clean.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${clean}${pad}${fence}`;
}

function fileLink(i: ImpactItem, options: RenderOptions, inTable: boolean): string {
  if (!i.file) return '';
  const label = mdCode(`${i.file}${i.line ? `:${i.line}` : ''}`, inTable);
  if (!options.link) return label;
  // encodeURIComponent deixa ( ) ! * ' ~ como estão: um ")" sem par num nome de arquivo
  // fecharia o link antes da hora e o resto viraria Markdown solto no comentário
  const encode = (segment: string) =>
    encodeURIComponent(segment).replace(
      /[!'()*~]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  const url =
    `${options.link.replace(/\/+$/, '')}/` +
    i.file.split('/').map(encode).join('/') +
    (i.line ? `#L${i.line}` : '');
  return `[${label}](${url})`;
}

function renderMarkdown(report: ImpactReport, options: RenderOptions): string {
  const m = t().impact;
  const labels = kindLabels(getLang());
  const limit = options.limit ?? 30;
  const out: string[] = [MARKDOWN_MARKER, `### 🧭 ${m.title} ${sinceLabelMd(report)}`, ''];
  out.push(`**${summaryLine(report)}**`, '');
  if (!report.summary.files) return `${out.join('\n')}\n`;

  const more = (total: number) => {
    if (total > limit) out.push('', `_${m.more(total - limit)}_`);
  };
  const kind = (k: GraphNode['kind']) => labels.node[k];

  if (report.changed.length) {
    out.push(
      `#### ${m.changed}`,
      '',
      `| ${m.entity} | ${m.kind} | ${m.where} |`,
      '| --- | --- | --- |',
    );
    for (const i of report.changed.slice(0, limit))
      out.push(`| ${mdCode(i.name, true)} | ${kind(i.kind)} | ${fileLink(i, options, true)} |`);
    more(report.changed.length);
    out.push('');
  }

  out.push(`#### ${m.impacted}`, '');
  if (!report.impacted.length) out.push(m.nothingDepends, '');
  else {
    out.push(
      `| ${m.distance} | ${m.entity} | ${m.kind} | ${m.via} | ${m.where} |`,
      '| ---: | --- | --- | --- | --- |',
    );
    for (const i of report.impacted.slice(0, limit))
      out.push(
        `| ${i.depth} | ${mdCode(i.name, true)} | ${kind(i.kind)} | ${viaMd(i)} | ${fileLink(i, options, true)} |`,
      );
    more(report.impacted.length);
    out.push('');
  }

  if (report.routes.length) {
    out.push(`#### ${m.routes}`, '');
    for (const i of report.routes.slice(0, limit))
      out.push(`- ${mdCode(i.name)} ${fileLink(i, options, false)}`);
    more(report.routes.length);
    out.push('');
  }

  if (report.tests.length) {
    out.push(`#### ${m.tests}`, '');
    for (const file of report.tests.slice(0, limit)) out.push(`- ${mdCode(file)}`);
    more(report.tests.length);
    out.push('');
  }

  if (report.outsideGraph.length) {
    out.push(`#### ${m.outside}`, '');
    for (const f of report.outsideGraph.slice(0, limit))
      out.push(`- ${mdCode(f.file)} (${m.status[f.status]})`);
    more(report.outsideGraph.length);
    out.push('');
  }

  out.push(
    '<details>',
    `<summary>${m.howToRead}</summary>`,
    '',
    m.footnote,
    '',
    '</details>',
    '',
    `<sub>${m.generatedBy(report.tool.version)}</sub>`,
  );
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------

function sinceLabel(report: ImpactReport): string {
  const c = t().changes;
  return report.baseLabel === 'HEAD' ? c.sinceLastCommit : c.since(safeText(report.baseLabel));
}

function sinceLabelMd(report: ImpactReport): string {
  const c = t().changes;
  return report.baseLabel === 'HEAD' ? c.sinceLastCommit : c.since(mdCode(report.baseLabel));
}

function summaryLine(report: ImpactReport): string {
  const m = t().impact;
  const s = report.summary;
  if (!s.files) return m.noChanges;
  return [
    m.files(s.files),
    m.changedCount(s.changed),
    m.impactedCount(s.impacted),
    ...(s.routes ? [m.routesCount(s.routes)] : []),
    ...(s.tests ? [m.testsCount(s.tests)] : []),
  ].join(' · ');
}

function viaText(i: ImpactedItem): string {
  return t().impact.viaText(i.via.kind, safeText(i.via.target));
}

function viaMd(i: ImpactedItem): string {
  return t().impact.viaText(i.via.kind, mdCode(i.via.target, true));
}
