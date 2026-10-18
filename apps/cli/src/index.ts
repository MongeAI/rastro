#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  AnalysisSession,
  analyzeProject,
  type DiscoverOptions,
  type ProgressEvent,
} from '@rastro/analyzer';
import {
  diagnosticText,
  RASTRO_VERSION,
  validateGraph,
  type NodeKind,
  type RastroGraph,
} from '@rastro/core';
import { compareGraphs, computeChangeImpact, GraphIndex } from '@rastro/graph';
import { openBrowser } from './browser.js';
import { formatDiff } from './compare.js';
import {
  defaultReportPath,
  parseExportRequest,
  renderExport,
  UsageError,
  writeExport,
} from './export.js';
import { collectChanges, GitError } from './git.js';
import { getLang, langArg, parseLang, setLang, t } from './i18n.js';
import { startServer, type RunningServer } from './server.js';
import { watchProject } from './watch.js';
import { defaultGraphPath, loadGraph, saveGraph } from './storage.js';
import { bold, cyan, dim, fail, red, safeText, tildify, yellow } from './term.js';

/** Mostra uma etapa da análise no idioma da CLI. */
function showProgress(_message: string, event: ProgressEvent): void {
  process.stderr.write(dim(`  ${t().progress(event)}\n`));
}

function webRoot(): string {
  return fileURLToPath(new URL('./web/', import.meta.url));
}

function printChanges(graph: RastroGraph): void {
  const changes = graph.changes!;
  const impact = computeChangeImpact(new GraphIndex(graph), changes);
  const out = (s = '') => process.stderr.write(`${s}\n`);
  const m = t().changes;
  const since =
    changes.baseLabel === 'HEAD' ? m.sinceLastCommit : m.since(safeText(changes.baseLabel));
  if (!changes.files.length) {
    out(`  ${dim(m.none(since))}`);
    out();
    return;
  }
  out(`${bold(m.title)} ${dim(since)}`);
  out(`  ${m.counts(changes.files.length, impact.changedEntities.length)}`);
  out(
    `  ${m.impact(impact.impacted.length)}` +
      (impact.routes.length ? ` · ${m.routes(impact.routes.length)}` : '') +
      (impact.tests.length ? ` · ${m.tests(impact.tests.length)}` : ''),
  );
  for (const route of impact.routes.slice(0, 5)) out(`    ${cyan('↳')} ${safeText(route.name)}`);
  out();
}

function printSummary(graph: RastroGraph, savedTo?: string): void {
  const { stats } = graph;
  const out = (s = '') => process.stderr.write(`${s}\n`);
  out();
  out(`${bold(safeText(graph.project.name))} ${dim(safeText(tildify(graph.project.root)))}`);
  const m = t().summary;
  const parts = [m.files(stats.files)];
  for (const [kind, label] of Object.entries(m.kinds) as Array<
    [NodeKind, (count: number) => string]
  >) {
    const n = stats.nodesByKind[kind];
    if (n) parts.push(label(n));
  }
  out(`  ${parts.join(' · ')}`);
  const r = stats.edgesByResolution;
  out(`  ${m.relations(r.resolved ?? 0, r.external ?? 0, r.unresolved ?? 0)}`);
  if (stats.importCycles.length) out(`  ${yellow(m.cycles(stats.importCycles.length))}`);
  // as mensagens dos diagnósticos são dados do grafo (gravadas em português no JSON)
  const warnings = graph.diagnostics.filter((d) => d.level !== 'info');
  if (warnings.length) {
    out(`  ${yellow(m.warnings(warnings.length))}`);
    for (const d of warnings.slice(0, 5))
      out(
        `    ${dim('•')} ${d.file ? `${safeText(d.file)}${d.line ? `:${d.line}` : ''} — ` : ''}${safeText(diagnosticText(d, getLang()))}`,
      );
    if (warnings.length > 5) out(dim(`    ${m.moreWarnings(warnings.length - 5)}`));
  }
  out(dim(`  ${m.duration(stats.durationMs, graph.analyzer.typescriptVersion)}`));
  if (savedTo) out(`  ${m.savedTo} ${cyan(tildify(savedTo))}`);
  out();
}

async function serve(graph: RastroGraph, port: number, open: boolean): Promise<RunningServer> {
  const root = webRoot();
  const m = t().serve;
  if (!fs.existsSync(path.join(root, 'index.html'))) fail(m.webNotBuilt);
  const server = await startServer({ graph, webRoot: root, port });
  process.stderr.write(
    `${bold('Rastro')} ${m.readyAt} ${cyan(server.url)}  ${dim(m.stopHint)}\n` +
      dim(`  ${m.tokenNote}\n`),
  );
  if (open) openBrowser(server.url);
  const stop = () => {
    process.stderr.write(dim(`\n${m.stopping}\n`));
    void server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}

async function main(argv: string[]): Promise<void> {
  // o idioma vem antes de tudo: até os erros de opções saem nele
  const langValue = langArg(argv);
  if (langValue !== undefined) {
    const lang = parseLang(langValue);
    if (!lang) fail(`${t().usage.badLang(langValue)}\n${t().usage.seeHelp}`);
    setLang(lang);
  }
  const u = t().usage;
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: 'string', short: 'o' },
        stdout: { type: 'boolean' },
        port: { type: 'string', short: 'p' },
        'no-open': { type: 'boolean' },
        exclude: { type: 'string', short: 'e', multiple: true },
        'no-gitignore': { type: 'boolean' },
        'max-files': { type: 'string' },
        changes: { type: 'boolean' },
        since: { type: 'string' },
        'trust-git-config': { type: 'boolean' },
        watch: { type: 'boolean', short: 'w' },
        format: { type: 'string', short: 'f' },
        level: { type: 'string' },
        folder: { type: 'string' },
        edges: { type: 'string' },
        external: { type: 'boolean' },
        'no-unresolved': { type: 'boolean' },
        json: { type: 'boolean' },
        lang: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    fail(`${(err as Error).message}\n${u.seeHelp}`);
  }
  const { values, positionals } = parsed;
  if (values.version) return void process.stdout.write(`${RASTRO_VERSION}\n`);
  if (values.help || positionals.length === 0)
    return void process.stdout.write(t().help(RASTRO_VERSION));

  const commands = ['open', 'analyze', 'serve', 'validate', 'export', 'compare'];
  const [first, ...rest] = positionals;
  // "rastro analyze" sem caminho, mas existindo uma pasta chamada "analyze": trata como caminho
  const isCommand = commands.includes(first!) && (rest.length > 0 || !fs.existsSync(first!));
  const command = isCommand ? first! : 'open';
  const target = isCommand ? rest[0] : first;
  if (!target) fail(u.needPath(command));

  const servesUi = command === 'open' || command === 'serve';
  if (values.port !== undefined && (!servesUi || !/^\d+$/.test(values.port)))
    fail(servesUi ? u.portRange : u.notApplicable('--port', command));
  const port = values.port !== undefined ? Number(values.port) : 4321;
  if (port > 65535) fail(u.portRange);
  if (values.stdout && command !== 'analyze') fail(u.onlyWith('--stdout', 'analyze'));
  if (values.out && command !== 'analyze' && command !== 'open' && command !== 'export')
    fail(u.notApplicable('--out', command));
  if (values.json && command !== 'compare') fail(u.onlyWith('--json', 'compare'));
  if (command !== 'export') {
    const exportOnly = (
      ['format', 'level', 'folder', 'edges', 'external', 'no-unresolved'] as const
    ).find((k) => values[k] !== undefined);
    if (exportOnly) fail(u.onlyWith(`--${exportOnly}`, 'export'));
  }
  const maxFiles = values['max-files'] !== undefined ? Number(values['max-files']) : undefined;
  if (maxFiles !== undefined && (!Number.isInteger(maxFiles) || maxFiles < 1)) fail(u.maxFiles);
  // opções que nunca teriam efeito falham, em vez de serem ignoradas em silêncio
  if (values.watch && command !== 'open') fail(u.watchOnly);
  if (values['trust-git-config'] && !values.changes && values.since === undefined)
    fail(u.trustNeedsChanges);
  /** Opções que só valem ao analisar uma pasta (o export confere depois se a fonte é pasta). */
  const analysisFlag = (
    [
      ['changes', '--changes'],
      ['since', '--since'],
      ['exclude', '--exclude'],
      ['max-files', '--max-files'],
      ['no-gitignore', '--no-gitignore'],
      ['trust-git-config', '--trust-git-config'],
    ] as const
  ).find(([k]) => values[k] !== undefined)?.[1];
  if (analysisFlag && (command === 'validate' || command === 'compare' || command === 'serve'))
    fail(u.needsFolder(analysisFlag, command));
  /** Como descobrir os arquivos do projeto (análise e modo ao vivo usam as mesmas regras). */
  const discover: DiscoverOptions = {
    ...(values.exclude ? { exclude: values.exclude } : {}),
    respectGitignore: !values['no-gitignore'],
    ...(maxFiles ? { maxFiles } : {}),
  };

  if (command === 'validate') {
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(path.resolve(target), 'utf8'));
    } catch (err) {
      fail(t().validate.cannotRead((err as Error).message));
    }
    const result = validateGraph(data);
    if (!result.valid) {
      // os detalhes vêm do validador de @rastro/core (em português, como na interface)
      process.stderr.write(
        `${red(t().validate.invalid)}\n${result.errors.map((e) => `  • ${safeText(e)}`).join('\n')}\n`,
      );
      process.exit(1);
    }
    const g = data as RastroGraph;
    process.stdout.write(
      `${t().validate.valid(g.nodes.length, g.edges.length, safeText(String(g.schemaVersion)))}\n`,
    );
    return;
  }

  /** Anexa as mudanças do git ao grafo quando `--changes`/`--since` foram pedidos. */
  const attachChanges = (graph: RastroGraph, root: string, warn: boolean) => {
    if (!values.changes && !values.since) return;
    try {
      graph.changes = collectChanges(root, {
        ...(values.since ? { since: values.since } : {}),
        trustConfig: !!values['trust-git-config'],
      });
    } catch (err) {
      const reason = err instanceof GitError ? err.message : (err as Error).message;
      if (warn)
        process.stderr.write(
          `${yellow(t().warningPrefix)} ${t().changes.skipped(safeText(reason))}\n`,
        );
    }
  };

  if (command === 'compare') {
    const other = rest[1];
    if (!other || rest.length > 2) fail(u.compareNeedsTwo);
    let before: RastroGraph;
    let after: RastroGraph;
    try {
      before = loadGraph(target);
      after = loadGraph(other);
    } catch (err) {
      fail((err as Error).message);
    }
    const diff = compareGraphs(before, after);
    process.stdout.write(values.json ? `${JSON.stringify(diff, null, 2)}\n` : formatDiff(diff));
    return;
  }

  if (command === 'export') {
    let request: ReturnType<typeof parseExportRequest>;
    try {
      request = parseExportRequest({
        format: values.format,
        ...(values.level !== undefined ? { level: values.level } : {}),
        ...(values.folder !== undefined ? { folder: values.folder } : {}),
        ...(values.edges !== undefined ? { edges: values.edges } : {}),
        external: !!values.external,
        noUnresolved: !!values['no-unresolved'],
      });
    } catch (err) {
      fail((err as Error).message);
    }
    const source = path.resolve(target);
    if (!fs.existsSync(source)) fail(u.pathNotFound(source));
    let graph: RastroGraph;
    const fromFolder = fs.statSync(source).isDirectory();
    if (!fromFolder && analysisFlag) fail(u.needsFolder(analysisFlag, command));
    if (fromFolder) {
      graph = await analyzeProject(source, { ...discover, onProgress: showProgress });
      attachChanges(graph, source, true);
    } else {
      try {
        graph = loadGraph(source);
      } catch (err) {
        fail((err as Error).message);
      }
    }
    let content: string;
    try {
      content = renderExport(graph, request.format, request.options, webRoot());
    } catch (err) {
      if (err instanceof UsageError) fail(err.message);
      fail(t().export.failed((err as Error).message));
    }
    const outFile =
      values.out ?? (request.format === 'html' ? defaultReportPath(graph) : undefined);
    if (!outFile) {
      process.stdout.write(content);
      return;
    }
    let written: string;
    try {
      written = writeExport(outFile, content);
    } catch (err) {
      fail((err as Error).message);
    }
    process.stderr.write(`${t().export.saved(request.format)} ${cyan(tildify(written))}\n`);
    if (request.format === 'html') process.stderr.write(dim(`  ${t().export.htmlHint}\n`));
    return;
  }

  if (command === 'serve') {
    let graph: RastroGraph;
    try {
      graph = loadGraph(target);
    } catch (err) {
      fail((err as Error).message);
    }
    printSummary(graph);
    if (!fs.existsSync(graph.project.root)) {
      process.stderr.write(
        `${yellow(t().warningPrefix)} ${t().serve.rootMissing(safeText(graph.project.root))}\n`,
      );
    }
    await serve(graph, port, !values['no-open']);
    return;
  }

  const root = path.resolve(target);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(u.dirNotFound(root));
  const quiet = command === 'analyze' && values.stdout;

  /**
   * Analisa o projeto (e as mudanças do git, se pedidas). No modo --watch, a sessão mantém o
   * compilador em memória: cada reanálise só relê os arquivos alterados.
   */
  let showingProgress = false;
  const session = new AnalysisSession(root, {
    ...discover,
    onProgress: (message, event) => {
      if (showingProgress) showProgress(message, event);
    },
  });
  const runAnalysis = async (progress: boolean) => {
    showingProgress = progress;
    const result = await session.analyze();
    attachChanges(result, root, progress);
    return result;
  };
  const graph = await runAnalysis(!quiet);

  if (quiet) {
    process.stdout.write(`${JSON.stringify(graph, null, 2)}\n`);
    return;
  }
  const savedTo = saveGraph(graph, values.out ?? defaultGraphPath(graph));
  printSummary(graph, savedTo);
  if (graph.changes) printChanges(graph);
  if (command === 'analyze') return;
  const server = await serve(graph, port, !values['no-open']);
  if (values.watch)
    startWatch(root, server, runAnalysis, values.out ?? defaultGraphPath(graph), discover);
}

/**
 * Modo ao vivo: reanalisa quando arquivos do projeto mudam e avisa os navegadores abertos.
 * Nunca roda duas análises ao mesmo tempo; mudanças durante uma análise disparam outra no fim.
 */
function startWatch(
  root: string,
  server: RunningServer,
  runAnalysis: (progress: boolean) => Promise<RastroGraph>,
  savePath: string,
  discover: DiscoverOptions,
): void {
  let running = false;
  let again: string[] | null = null;
  const rerun = async (files: string[]) => {
    if (running) {
      again = [...(again ?? []), ...files];
      return;
    }
    running = true;
    const started = Date.now();
    try {
      const next = await runAnalysis(false);
      // pastas novas ou removidas, .gitignore alterado: observa o conjunto atual
      watcher.refresh();
      server.update(next);
      saveGraph(next, savePath);
      const shown =
        safeText(files.slice(0, 3).join(', ')) + (files.length > 3 ? ` +${files.length - 3}` : '');
      process.stderr.write(
        `${cyan('↻')} ${shown} ${dim(t().watch.reanalyzed(Date.now() - started, next.stats.files))}\n`,
      );
    } catch (err) {
      process.stderr.write(
        `${yellow(t().warningPrefix)} ${t().watch.failed(safeText((err as Error).message))}\n`,
      );
    } finally {
      running = false;
      if (again) {
        const queued = again;
        again = null;
        void rerun(queued);
      }
    }
  };
  const watcher = watchProject(root, (files) => void rerun(files), {
    ...discover,
    onFallback: (err) => {
      const m = t().watch;
      process.stderr.write(
        `${yellow(t().warningPrefix)} ${m.fallback(safeText(err.code ?? err.message))}\n` +
          (err.code === 'ENOSPC' || err.code === 'EMFILE' ? dim(`  ${m.limitHint}\n`) : ''),
      );
    },
  });
  process.stderr.write(dim(`  ${watcher.mode === 'live' ? t().watch.live : t().watch.polling}\n`));
}

main(process.argv.slice(2)).catch((err: unknown) =>
  fail(err instanceof Error ? err.message : String(err)),
);
