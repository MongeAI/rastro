import fs from 'node:fs';
import path from 'node:path';
import {
  RASTRO_VERSION,
  RULES_FILE,
  ruleIssueText,
  type EdgeKind,
  type GraphRules,
  type RastroGraph,
  type Rule,
} from '@rastro/core';
import {
  checkRules,
  graphRules,
  GraphIndex,
  suggestRules,
  type RulesCheck,
  type RuleViolation,
} from '@rastro/graph';
import { getLang, t } from './i18n.js';
import { fileLink, mdCode, type RenderOptions } from './markdown.js';
import { bold, cyan, dim, green, red, safeText, tildify, yellow } from './term.js';

/**
 * `rastro check`: as regras de arquitetura (`rastro.rules.json`) conferidas no grafo, em texto,
 * Markdown ou JSON. Só relações comprovadas reprovam; com as mudanças do git, só o que a
 * mudança introduziu (evidência numa linha alterada) reprova.
 */

export const CHECK_FORMATS = ['text', 'markdown', 'json'] as const;
export type CheckFormat = (typeof CHECK_FORMATS)[number];

/** O arquivo de regras não pôde ser lido (não confundir com regras inválidas: `issues`). */
export class RulesFileError extends Error {}

const MAX_RULES_BYTES = 1_000_000;

/**
 * Lê as regras: o arquivo pedido (`--rules`) ou `rastro.rules.json` na raiz analisada. Sem
 * pedido e sem arquivo, `undefined`. O arquivo padrão vem do projeto (de um pull request, no
 * CI): precisa ser um arquivo comum (link simbólico não), e o erro de JSON não repete o
 * conteúdo, para nunca ecoar um arquivo de fora num comentário.
 */
export function readRules(root: string, explicit?: string): GraphRules | undefined {
  const file = explicit !== undefined ? path.resolve(explicit) : path.join(root, RULES_FILE);
  const m = t().rules;
  let stat: fs.Stats | undefined;
  try {
    stat = explicit !== undefined ? fs.statSync(file) : fs.lstatSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      if (explicit === undefined) return undefined;
      throw new RulesFileError(m.notFound(tildify(file)));
    }
    throw new RulesFileError(m.unreadable(tildify(file), (err as Error).message));
  }
  if (!stat.isFile()) throw new RulesFileError(m.notRegular(tildify(file)));
  if (stat.size > MAX_RULES_BYTES) throw new RulesFileError(m.tooLarge(tildify(file)));
  const relative = path.relative(root, file);
  const source =
    relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative.split(path.sep).join('/')
      : tildify(file);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new RulesFileError(m.unreadable(tildify(file), (err as Error).message));
  }
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    // a mensagem do JSON.parse pode citar um trecho do arquivo: fica só o começo dela (antes
    // de qualquer citação) e a linha e coluna
    const raw = (err as Error).message;
    const head = raw.split(/,?\s*(?:\.\.\.)?"/)[0]!.trim();
    const at = /position (\d+)/.exec(raw);
    let message = head;
    if (at && !/\(line \d+ column \d+\)/.test(head)) {
      const before = text.slice(0, Number(at[1]));
      const line = before.split('\n').length;
      message += ` (line ${line} column ${before.length - before.lastIndexOf('\n')})`;
    }
    return { source, issues: [{ code: 'invalid-json', params: { message } }] };
  }
  const { rules, issues } = parseRulesFrom(data);
  return rules ? { source, config: data as GraphRules['config'] } : { source, issues };
}

// `graphRules` lê do grafo; aqui o conteúdo ainda não está nele
const parseRulesFrom = (data: unknown) =>
  graphRules({ rules: { source: '', config: data } } as RastroGraph)!;

// ---------------------------------------------------------------------------------------------
// Relatório

export interface ViolationItem {
  from: string;
  to: string;
  package: boolean;
  kinds: EdgeKind[];
  typeOnly: boolean;
  count: number;
  /** Onde aparece (até 20, em ordem de linha). */
  evidence: Array<{ file: string; line: number }>;
  /** Num ciclo: cada arquivo e a linha do import que leva ao próximo. */
  cycle?: Array<{ file: string; line?: number }>;
  cycleSize?: number;
  /** Com mudanças do git: está numa linha alterada. */
  introduced?: boolean;
}

export interface RuleResult {
  name: string;
  kind: Rule['kind'];
  severity: Rule['severity'];
  because?: string;
  /** Arquivos analisados a que a regra se aplica. */
  files: number;
  violations: ViolationItem[];
  /** Por chamadas não resolvidas que podem ir para o destino (nunca reprovam). */
  possible: ViolationItem[];
}

export interface CheckReport {
  tool: { name: 'rastro'; version: string };
  project: string;
  /** Arquivo de regras (relativo à raiz analisada quando está dentro dela). */
  rules: string;
  /** Problemas no arquivo de regras, em texto (nenhuma regra conferida). */
  issues?: string[];
  /** Com mudanças do git: a referência comparada. */
  base?: string;
  baseLabel?: string;
  summary: {
    rules: number;
    errors: number;
    warnings: number;
    possible: number;
    /** Com mudanças do git: as violações introduzidas pela mudança. */
    introduced?: { errors: number; warnings: number };
  };
  results: RuleResult[];
}

function violationItem(v: RuleViolation): ViolationItem {
  return {
    from: v.from,
    to: v.to,
    package: v.package,
    kinds: v.kinds,
    typeOnly: v.typeOnly,
    count: v.count,
    evidence: v.evidence.map((e) => ({ file: e.file, line: e.line })),
    ...(v.cycle
      ? {
          cycle: v.cycle.map((s) => ({
            file: s.file,
            ...(s.evidence ? { line: s.evidence.line } : {}),
          })),
          cycleSize: v.cycleSize ?? v.cycle.length,
        }
      : {}),
    ...(v.introduced !== undefined ? { introduced: v.introduced } : {}),
  };
}

/** Confere as regras guardadas no grafo (`undefined` quando o projeto não tem regras). */
export function runRules(
  graph: RastroGraph,
  index = new GraphIndex(graph),
): RulesCheck | undefined {
  const parsed = graphRules(graph);
  if (!parsed?.rules) return undefined;
  return checkRules(index, parsed.rules, graph.changes);
}

export function buildCheckReport(graph: RastroGraph, index?: GraphIndex): CheckReport {
  const rules = graph.rules;
  if (!rules) throw new Error('graph without rules');
  const base = {
    tool: { name: 'rastro' as const, version: RASTRO_VERSION },
    project: graph.project.name,
    rules: rules.source,
    ...(graph.changes ? { base: graph.changes.base, baseLabel: graph.changes.baseLabel } : {}),
  };
  const parsed = graphRules(graph)!;
  if (!parsed.rules)
    return {
      ...base,
      issues: parsed.issues.map((i) => ruleIssueText(i, getLang())),
      summary: { rules: 0, errors: 0, warnings: 0, possible: 0 },
      results: [],
    };
  const check = checkRules(index ?? new GraphIndex(graph), parsed.rules, graph.changes);
  return {
    ...base,
    summary: {
      rules: parsed.rules.length,
      errors: check.errors,
      warnings: check.warnings,
      possible: check.possible,
      ...(check.introduced ? { introduced: check.introduced } : {}),
    },
    results: check.outcomes.map((o) => ({
      name: o.rule.name,
      kind: o.rule.kind,
      severity: o.rule.severity,
      ...(o.rule.because ? { because: o.rule.because } : {}),
      files: o.files,
      violations: o.violations.map(violationItem),
      possible: o.possible.map(violationItem),
    })),
  };
}

/** Quantas violações reprovam: os erros (com mudanças do git, só os introduzidos). */
export function failingCount(report: CheckReport): number {
  return report.summary.introduced?.errors ?? report.summary.errors;
}

export function renderCheck(
  report: CheckReport,
  format: CheckFormat,
  options: RenderOptions = {},
): string {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  return format === 'markdown'
    ? `${CHECK_MARKER}\n${rulesMarkdown(report, options, '###')}\n`
    : renderText(report, options);
}

/** As violações que contam no modo de mudanças: só as introduzidas; sem mudanças, todas. */
const shown = (report: CheckReport, list: ViolationItem[]) =>
  report.summary.introduced ? list.filter((v) => v.introduced) : list;

// ---------------------------------------------------------------------------------------------
// texto

function renderText(report: CheckReport, options: RenderOptions): string {
  const m = t().rules;
  const limit = options.limit ?? 50;
  const out: string[] = [];
  const since = report.baseLabel
    ? ` · ${report.baseLabel === 'HEAD' ? t().changes.sinceLastCommit : t().changes.since(safeText(report.baseLabel))}`
    : '';
  out.push(
    `${bold(m.title)} ${dim(`${safeText(report.rules)} · ${m.ruleCount(report.summary.rules)}${since}`)}`,
  );
  if (report.issues) {
    out.push('', red(m.invalid(safeText(report.rules))));
    for (const issue of report.issues) out.push(`  ${dim('•')} ${safeText(issue)}`);
    return `${out.join('\n')}\n`;
  }
  out.push('');
  for (const r of report.results) {
    const list = shown(report, r.violations);
    const existing = r.violations.length - list.length;
    const mark = !list.length ? green('✓') : r.severity === 'error' ? red('✗') : yellow('!');
    const counts = list.length
      ? ` ${dim('·')} ${(r.kind === 'cycles' ? m.cycles : report.summary.introduced ? m.newViolations : m.violations)(list.length)}${r.severity === 'warning' ? dim(` (${m.warning})`) : ''}`
      : '';
    const extra = existing ? ` ${dim(`(${m.existing(existing)})`)}` : '';
    out.push(`${mark} ${bold(safeText(r.name))}${counts}${extra}`);
    if (r.files === 0) out.push(`    ${yellow(m.noFiles)}`);
    if (list.length && r.because) out.push(`    ${dim(safeText(r.because))}`);
    for (const v of list.slice(0, limit)) out.push(`    ${violationText(v)}`);
    if (list.length > limit) out.push(`    ${dim(t().impact.more(list.length - limit))}`);
    const possible = report.summary.introduced ? [] : r.possible;
    if (possible.length) {
      out.push(`    ${dim(m.possibleTitle(possible.length))}`);
      for (const v of possible.slice(0, 5)) out.push(`      ${dim(violationText(v))}`);
      if (possible.length > 5) out.push(`      ${dim(t().impact.more(possible.length - 5))}`);
    }
  }
  out.push('', summaryText(report));
  if (report.summary.possible && !report.summary.introduced) out.push(dim(m.possibleHint));
  return `${out.join('\n')}\n`;
}

/** A seção de regras dentro do `rastro impact` (texto): o resumo e só o que conta. */
export function rulesText(report: CheckReport, limit = 50): string[] {
  const m = t().rules;
  const out = [`${bold(m.title)} ${dim(safeText(report.rules))}`];
  if (report.issues) {
    out.push(`  ${yellow(m.invalid(safeText(report.rules)))}`);
    for (const issue of report.issues) out.push(`    ${dim('•')} ${safeText(issue)}`);
    return out;
  }
  out.push(`  ${summaryText(report)}`);
  for (const r of report.results) {
    const list = shown(report, r.violations);
    if (!list.length) continue;
    out.push(`  ${r.severity === 'error' ? red('✗') : yellow('!')} ${bold(safeText(r.name))}`);
    if (r.because) out.push(`    ${dim(safeText(r.because))}`);
    for (const v of list.slice(0, limit)) out.push(`    ${violationText(v)}`);
    if (list.length > limit) out.push(`    ${dim(t().impact.more(list.length - limit))}`);
  }
  return out;
}

function summaryText(report: CheckReport): string {
  const m = t().rules;
  const s = report.summary;
  if (!s.rules) return dim(m.noRules);
  if (s.introduced) {
    const fresh = s.introduced.errors + s.introduced.warnings;
    const existing = s.errors + s.warnings - fresh;
    const head = fresh
      ? (s.introduced.errors ? red : yellow)(
          `${s.introduced.errors ? '✗' : '!'} ${m.newViolations(fresh)}`,
        )
      : green(`✓ ${m.noNew}`);
    return existing ? `${head} ${dim(`· ${m.existing(existing)}`)}` : head;
  }
  if (!s.errors && !s.warnings) return green(`✓ ${m.allPassed(s.rules)}`);
  const parts = [
    ...(s.errors ? [red(`✗ ${m.violations(s.errors)}`)] : []),
    ...(s.warnings ? [yellow(m.warnings(s.warnings))] : []),
  ];
  return parts.join(dim(' · '));
}

function kindText(v: ViolationItem): string {
  const m = t().rules;
  return [
    ...v.kinds.map((k) => m.kind[k as 'imports' | 'calls' | 'extends']),
    ...(v.typeOnly ? [m.typeOnly] : []),
  ].join(', ');
}

function violationText(v: ViolationItem): string {
  const m = t().rules;
  if (v.cycle) {
    const steps = v.cycle.map((s) => cyan(safeText(`${s.file}${s.line ? `:${s.line}` : ''}`)));
    const size =
      v.cycleSize && v.cycleSize > v.cycle.length ? dim(` (${m.cycleOf(v.cycleSize)})`) : '';
    return `${steps.join(dim(' → '))} ${dim('→')} ${cyan(safeText(v.cycle[0]!.file))}${size}`;
  }
  const to = v.package ? `${safeText(v.to)} ${dim(`(${m.package})`)}` : safeText(v.to);
  const first = v.evidence[0];
  const where = first ? cyan(safeText(`${first.file}:${first.line}`)) : '';
  const more = v.count > 1 ? dim(` ${m.times(v.count)}`) : '';
  return `${safeText(v.from)} ${dim('→')} ${to} ${dim(`(${kindText(v)})`)} ${where}${more}`;
}

// ---------------------------------------------------------------------------------------------
// Markdown (comentário de pull request; também a seção do `rastro impact`)

export const CHECK_MARKER = '<!-- rastro-check -->';

function violationMd(v: ViolationItem, options: RenderOptions): string {
  const m = t().rules;
  if (v.cycle) {
    const steps = v.cycle.map((s) => fileLink(s.file, s.line, options));
    const size = v.cycleSize && v.cycleSize > v.cycle.length ? ` (${m.cycleOf(v.cycleSize)})` : '';
    return `${steps.join(' → ')} → ${mdCode(v.cycle[0]!.file)}${size}`;
  }
  const to = v.package ? `${mdCode(v.to)} (${m.package})` : mdCode(v.to);
  const first = v.evidence[0];
  const more = v.count > 1 ? ` ${m.times(v.count)}` : '';
  return `${mdCode(v.from)} → ${to} (${kindText(v)}) ${first ? fileLink(first.file, first.line, options) : ''}${more}`;
}

/**
 * As regras em Markdown. `heading` é o nível do título (`###` no `rastro check`, `####` dentro
 * do comentário do `rastro impact`). Nomes, motivos e caminhos vêm do projeto: sempre em código.
 */
export function rulesMarkdown(
  report: CheckReport,
  options: RenderOptions,
  heading: string,
): string {
  const m = t().rules;
  const limit = options.limit ?? 30;
  const out: string[] = [`${heading} 🧱 ${m.title}`, ''];
  if (report.issues) {
    out.push(`⚠️ ${m.invalid(mdCode(report.rules))}`, '');
    for (const issue of report.issues) out.push(`- ${mdCode(issue)}`);
    return out.join('\n');
  }
  out.push(`**${summaryMd(report)}** · ${mdCode(report.rules)}`, '');
  for (const r of report.results) {
    const list = shown(report, r.violations);
    if (!list.length) continue;
    const icon = r.severity === 'error' ? '❌' : '⚠️';
    const counts = (
      r.kind === 'cycles' ? m.cycles : report.summary.introduced ? m.newViolations : m.violations
    )(list.length);
    out.push(
      `${icon} **${mdCode(r.name)}** · ${counts}${r.severity === 'warning' ? ` (${m.warning})` : ''}`,
    );
    if (r.because) out.push(`> ${mdCode(r.because)}`);
    out.push('');
    for (const v of list.slice(0, limit)) out.push(`- ${violationMd(v, options)}`);
    if (list.length > limit) out.push(`- _${t().impact.more(list.length - limit)}_`);
    out.push('');
  }
  while (out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

function summaryMd(report: CheckReport): string {
  const m = t().rules;
  const s = report.summary;
  if (!s.rules) return m.noRules;
  if (s.introduced) {
    const fresh = s.introduced.errors + s.introduced.warnings;
    const existing = s.errors + s.warnings - fresh;
    const head = fresh ? m.newViolations(fresh) : `✅ ${m.noNew}`;
    return existing ? `${head} · ${m.existing(existing)}` : head;
  }
  if (!s.errors && !s.warnings) return `✅ ${m.allPassed(s.rules)}`;
  return [
    ...(s.errors ? [m.violations(s.errors)] : []),
    ...(s.warnings ? [m.warnings(s.warnings)] : []),
  ].join(' · ');
}

// ---------------------------------------------------------------------------------------------
// --init

/** As regras que o projeto já cumpre hoje, como o conteúdo de um `rastro.rules.json`. */
export function initialRules(graph: RastroGraph): string {
  const m = t().rules;
  const specs = suggestRules(new GraphIndex(graph), {
    layer: (folder, above) => m.layerName(folder, above),
    noCycles: m.noCyclesName,
    tests: m.testsName,
  });
  const config = {
    $schema: `https://unpkg.com/@mongeai/rastro@${RASTRO_VERSION}/schema/rastro-rules.schema.json`,
    rules: specs,
  };
  return `${formatJson(config)}\n`;
}

/** JSON com 2 espaços, mas listas curtas de textos numa linha só (mais fácil de editar). */
function formatJson(value: unknown, indent = ''): string {
  if (Array.isArray(value)) {
    const inline = `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
    if (value.every((v) => typeof v === 'string') && inline.length + indent.length <= 90)
      return inline;
    const inner = `${indent}  `;
    return `[\n${value.map((v) => `${inner}${formatJson(v, inner)}`).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const inner = `${indent}  `;
    const entries = Object.entries(value).map(
      ([k, v]) => `${inner}${JSON.stringify(k)}: ${formatJson(v, inner)}`,
    );
    return `{\n${entries.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}
