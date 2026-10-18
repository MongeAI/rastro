import path from 'node:path';
import {
  compareStrings,
  kindLabels,
  RASTRO_VERSION,
  type ChangedFile,
  type ChangeSet,
  type GraphNode,
  type RastroGraph,
} from '@rastro/core';
import {
  computeChangeImpact,
  GraphIndex,
  routesAndTests,
  type BrokenReference,
  type ChangeImpact,
} from '@rastro/graph';
import { buildCheckReport, rulesMarkdown, rulesText, type CheckReport } from './check.js';
import { getLang, t } from './i18n.js';
import { fileLink, mdCode, type RenderOptions } from './markdown.js';

export { mdCode, type RenderOptions } from './markdown.js';
import { bold, cyan, dim, red, safeText, yellow } from './term.js';

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

/** Referência ao que mudou que não resolve mais (ver `BrokenReference` em @rastro/graph). */
export interface BrokenItem {
  /** Quem faz a referência: o arquivo que importa ou a entidade que chama. */
  from: ImpactItem;
  kind: BrokenReference['kind'];
  reference: string;
  /** Arquivo alterado ou removido para onde ela aponta. */
  target: string;
  why: BrokenReference['why'];
  /** Onde a referência aparece (primeira ocorrência) e quantas vezes. */
  file?: string;
  line?: number;
  count: number;
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
    /** Referências possivelmente quebradas pela mudança. */
    broken: number;
    /** Violações de regras de arquitetura introduzidas pela mudança (com `rastro.rules.json`). */
    violations?: number;
  };
  changed: ImpactItem[];
  impacted: ImpactedItem[];
  routes: ImpactItem[];
  /** Arquivos de teste alterados ou que dependem do que mudou (relativos à raiz analisada). */
  tests: string[];
  /** Arquivos alterados fora do mapa (removidos, não analisados, ignorados). */
  outsideGraph: Array<{ file: string; status: ChangedFile['status'] }>;
  /**
   * Referências ao que mudou que não resolvem no código atual (import de arquivo removido, nome
   * que deixou de ser exportado, membro que sumiu): possivelmente quebradas pela mudança.
   */
  broken: BrokenItem[];
  /**
   * As regras de arquitetura conferidas (quando o projeto tem `rastro.rules.json`): só as
   * violações com `introduced` vieram desta mudança.
   */
  rules?: CheckReport;
}

/** Nomes vêm do código analisado: um literal enorme não pode estourar um comentário. */
const MAX_NAME = 160;
const clip = (s: string) => (s.length > MAX_NAME ? `${s.slice(0, MAX_NAME - 1)}…` : s);

/** Como na interface: rota como `GET /x`, método como `Classe.metodo`. */
const display = (n: GraphNode) =>
  clip(
    n.kind !== 'route' && n.qualifiedName && n.kind !== 'file' && n.kind !== 'module'
      ? n.qualifiedName
      : n.name,
  );

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

/**
 * O cálculo por trás do relatório (também usado pelo `rastro mcp`): o impacto das mudanças e
 * o que mudou — as entidades alteradas e os arquivos alterados sem nenhuma entidade alterada
 * dentro (código no topo do arquivo, arquivo novo ou renomeado). Quem já aparece como afetado
 * fica só lá.
 */
export function changesWithImpact(
  index: GraphIndex,
  changes: ChangeSet,
): {
  impact: ChangeImpact;
  changed: GraphNode[];
  /** Rotas e testes que só chegam ao que mudou por uma referência possivelmente quebrada. */
  viaBroken: { routes: GraphNode[]; tests: GraphNode[] };
} {
  const impact = computeChangeImpact(index, changes);
  const impactedIds = new Set(impact.impacted.map((i) => i.node.id));
  const fileLevel = impact.changedFiles.filter(
    (f) =>
      !impactedIds.has(f.id) &&
      !impact.changedEntities.some((e) => index.fileOf(e.id)?.id === f.id),
  );
  return {
    impact,
    changed: [...impact.changedEntities, ...fileLevel],
    viaBroken: reachedViaBroken(index, impact),
  };
}

/**
 * Quem faz uma referência possivelmente quebrada (import de arquivo removido, nome que sumiu)
 * deixou de ter a relação comprovada com o que mudou, mas é justamente o que pode falhar: os
 * testes e as rotas que dependem dele (por relações comprovadas) também devem rodar. Um
 * arquivo com import quebrado conta por inteiro (o módulo nem carrega).
 */
function reachedViaBroken(
  index: GraphIndex,
  impact: ChangeImpact,
): { routes: GraphNode[]; tests: GraphNode[] } {
  if (!impact.broken.length) return { routes: [], tests: [] };
  const seeds = new Map<string, GraphNode>();
  for (const { from } of impact.broken) {
    seeds.set(from.id, from);
    if (from.kind === 'file') for (const d of index.descendants(from.id)) seeds.set(d.id, d);
  }
  const reached = index.impactOfAll(seeds.keys());
  const found = routesAndTests(index, [...seeds.values(), ...reached.map((i) => i.node)]);
  const routes = new Set(impact.routes.map((n) => n.id));
  const tests = new Set(impact.tests.map((n) => n.id));
  return {
    routes: found.routes.filter((n) => !routes.has(n.id)),
    tests: found.tests.filter((n) => !tests.has(n.id)),
  };
}

/** Monta o relatório a partir de um grafo com mudanças do git (`graph.changes`). */
export function buildImpactReport(graph: RastroGraph): ImpactReport {
  const changes = graph.changes;
  if (!changes) throw new Error('graph without changes');
  const index = new GraphIndex(graph);
  const { impact, changed: changedNodes, viaBroken } = changesWithImpact(index, changes);
  const routes = [...impact.routes, ...viaBroken.routes];
  const changed = changedNodes
    .map(item)
    .sort((a, b) => compareStrings(a.file ?? '', b.file ?? '') || (a.line ?? 0) - (b.line ?? 0));
  // testes que dependem de algo possivelmente quebrado também rodam (podem falhar por isso)
  const tests = [...impact.tests, ...viaBroken.tests]
    .map((f) => f.qualifiedName ?? f.name)
    .sort(compareStrings);
  const rules = graph.rules ? buildCheckReport(graph, index) : undefined;
  const introduced = rules?.summary.introduced;
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
      routes: routes.length,
      tests: tests.length,
      outsideGraph: impact.outsideGraph.length,
      broken: impact.broken.length,
      ...(introduced ? { violations: introduced.errors + introduced.warnings } : {}),
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
    routes: routes.map(item),
    tests,
    outsideGraph: impact.outsideGraph.map((f) => ({ file: f.file, status: f.status })),
    broken: impact.broken.map((b) => ({
      from: item(b.from),
      kind: b.kind,
      reference: clip(b.reference),
      target: b.target,
      why: b.why,
      ...(b.evidence ? { file: b.evidence.file, line: b.evidence.line } : {}),
      count: b.count,
    })),
    ...(rules ? { rules } : {}),
  };
}

/** Caminhos dos testes afetados relativos à pasta atual, prontos para o executor de testes. */
export function testPathsFrom(report: ImpactReport, root: string, cwd = process.cwd()): string[] {
  return report.tests.map((file) => {
    const relative = path.relative(cwd, path.join(root, file)).split(path.sep).join('/');
    return relative.startsWith('.') ? relative : `./${relative}`;
  });
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
  if (report.rules) lines.push('', ...rulesText(report.rules, limit));
  if (report.broken.length) {
    lines.push('', bold(m.broken), `  ${dim(m.brokenHint)}`);
    for (const b of report.broken.slice(0, limit))
      lines.push(
        `  ${red('✗')} ${safeText(b.from.name)} ${dim(safeText(brokenWhere(b)))} ${brokenText(b, safeText)}`,
      );
    more(report.broken.length);
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
      out.push(
        `| ${mdCode(i.name, true)} | ${kind(i.kind)} | ${fileLink(i.file, i.line, options, true)} |`,
      );
    more(report.changed.length);
    out.push('');
  }

  if (report.rules) out.push(rulesMarkdown(report.rules, options, '####'), '');
  if (report.broken.length) {
    out.push(`#### ${m.broken}`, '', `_${m.brokenHint}_`, '');
    for (const b of report.broken.slice(0, limit))
      out.push(
        `- ${mdCode(b.from.name)} ${fileLink(b.file, b.line, options)} — ${brokenText(b, (s) => mdCode(s))}`,
      );
    more(report.broken.length);
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
        `| ${i.depth} | ${mdCode(i.name, true)} | ${kind(i.kind)} | ${viaMd(i)} | ${fileLink(i.file, i.line, options, true)} |`,
      );
    more(report.impacted.length);
    out.push('');
  }

  if (report.routes.length) {
    out.push(`#### ${m.routes}`, '');
    for (const i of report.routes.slice(0, limit))
      out.push(`- ${mdCode(i.name)} ${fileLink(i.file, i.line, options)}`);
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
    ...(s.violations ? [t().rules.newViolations(s.violations)] : []),
    ...(s.broken ? [m.brokenCount(s.broken)] : []),
    m.impactedCount(s.impacted),
    ...(s.routes ? [m.routesCount(s.routes)] : []),
    ...(s.tests ? [m.testsCount(s.tests)] : []),
  ].join(' · ');
}

function brokenWhere(b: BrokenItem): string {
  return b.file ? `${b.file}${b.line ? `:${b.line}` : ''}` : '';
}

/** O que a referência faz e por que não resolve; `code` formata nomes e caminhos. */
function brokenText(b: BrokenItem, code: (s: string) => string): string {
  const text = t().impact.brokenWhy(b.kind, b.why, code(b.reference), code(b.target));
  return b.count > 1 ? `${text} ${t().impact.times(b.count)}` : text;
}

function viaText(i: ImpactedItem): string {
  return t().impact.viaText(i.via.kind, safeText(i.via.target));
}

function viaMd(i: ImpactedItem): string {
  return t().impact.viaText(i.via.kind, mdCode(i.via.target, true));
}
