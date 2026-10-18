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
import { argsErrorMessage } from './args.js';
import { openBrowser } from './browser.js';
import { formatDiff } from './compare.js';
import {
  buildImpactReport,
  IMPACT_FORMATS,
  renderImpact,
  testPathsFrom,
  type ImpactFormat,
} from './impact.js';
import {
  defaultReportPath,
  parseExportRequest,
  renderExport,
  UsageError,
  writeExport,
} from './export.js';
import { checkGit, collectChanges, GitError } from './git.js';
import { getLang, langArg, parseLang, setLang, t } from './i18n.js';
import { runMcp } from './mcp.js';
import { IN_ANALYSIS_WORKER } from './mcp-project.js';
import { startServer, type RunningServer } from './server.js';
import { watchProject } from './watch.js';
import {
  checkGraphTarget,
  defaultGraphPath,
  loadGraph,
  readGraphJson,
  saveGraph,
} from './storage.js';
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

/** Endereço http:// ou https:// válido (base dos links do `impact --link`). */
function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
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
        'no-watch': { type: 'boolean' },
        format: { type: 'string', short: 'f' },
        level: { type: 'string' },
        folder: { type: 'string' },
        edges: { type: 'string' },
        external: { type: 'boolean' },
        'no-unresolved': { type: 'boolean' },
        json: { type: 'boolean' },
        tests: { type: 'boolean' },
        link: { type: 'string' },
        lang: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    fail(`${argsErrorMessage(err)}\n${u.seeHelp}`);
  }
  const { values, positionals } = parsed;
  if (values.version) return void process.stdout.write(`${RASTRO_VERSION}\n`);
  if (values.help || positionals.length === 0)
    return void process.stdout.write(t().help(RASTRO_VERSION));

  const commands = ['open', 'analyze', 'serve', 'validate', 'export', 'compare', 'impact', 'mcp'];
  const [first, ...rest] = positionals;
  // "rastro analyze" sem caminho, mas existindo uma pasta chamada "analyze": trata como caminho.
  // "rastro mcp" é sempre o comando (o caminho é opcional): um cliente de IA que o configura
  // nunca deve abrir o navegador porque a pasta atual tem uma subpasta "mcp"
  const isCommand =
    commands.includes(first!) && (rest.length > 0 || first === 'mcp' || !fs.existsSync(first!));
  const command = isCommand ? first! : 'open';
  // mcp sem caminho: a pasta do projeto que o Claude Code informa ao servidor, senão a atual
  const target = isCommand
    ? (rest[0] ?? (command === 'mcp' ? process.env.CLAUDE_PROJECT_DIR?.trim() || '.' : undefined))
    : first;
  // argumentos a mais falham (o compare recebe dois arquivos; os outros comandos, um)
  const extra = isCommand ? rest.slice(command === 'compare' ? 2 : 1) : rest;
  if (extra.length) fail(`${u.unexpectedArg(extra[0]!)}\n${u.seeHelp}`);
  if (!target)
    fail(
      command === 'compare'
        ? u.compareNeedsTwo
        : command === 'serve' || command === 'validate'
          ? u.needGraph(command)
          : u.needPath(command),
    );

  // um valor vazio (--since "", -o "") nunca é o que se quis: falha em vez de ser ignorado
  const empty = (
    ['out', 'since', 'port', 'max-files', 'format', 'level', 'folder', 'edges', 'link'] as const
  ).find((k) => values[k] === '');
  if (empty) fail(`${u.needsValue(`--${empty}`)}\n${u.seeHelp}`);
  if (values.exclude?.includes('')) fail(`${u.needsValue('--exclude')}\n${u.seeHelp}`);

  const servesUi = command === 'open' || command === 'serve';
  if (values.port !== undefined && (!servesUi || !/^\d+$/.test(values.port)))
    fail(servesUi ? u.portRange : u.notApplicable('--port', command));
  const port = values.port !== undefined ? Number(values.port) : 4321;
  if (port > 65535) fail(u.portRange);
  if (values['no-open'] && !servesUi) fail(u.notApplicable('--no-open', command));
  if (values.stdout && command !== 'analyze') fail(u.onlyWith('--stdout', 'analyze'));
  if (values.stdout && values.out !== undefined) fail(u.notTogether('--stdout', '--out'));
  if (
    values.out !== undefined &&
    command !== 'analyze' &&
    command !== 'open' &&
    command !== 'export' &&
    command !== 'impact'
  )
    fail(u.notApplicable('--out', command));
  if (values.json && command !== 'compare') fail(u.onlyWith('--json', 'compare'));
  if (command !== 'export') {
    // --format também vale para o impact (text, markdown ou json)
    const exportOnly = (
      ['format', 'level', 'folder', 'edges', 'external', 'no-unresolved'] as const
    ).find((k) => values[k] !== undefined && !(k === 'format' && command === 'impact'));
    if (exportOnly) fail(u.onlyWith(`--${exportOnly}`, 'export'));
  }
  if (command !== 'impact') {
    const impactOnly = (['tests', 'link'] as const).find((k) => values[k] !== undefined);
    if (impactOnly) fail(u.onlyWith(`--${impactOnly}`, 'impact'));
  }
  // os links vão para um comentário de PR: só endereços web (nada de javascript: ou file:)
  if (values.link !== undefined && !isWebUrl(values.link)) fail(t().impact.badLink(values.link));
  const maxFiles = values['max-files'] !== undefined ? Number(values['max-files']) : undefined;
  if (maxFiles !== undefined && (!Number.isInteger(maxFiles) || maxFiles < 1)) fail(u.maxFiles);
  // opções que nunca teriam efeito falham, em vez de serem ignoradas em silêncio
  if (values.watch && command === 'mcp') fail(u.mcpWatches);
  if (values.watch && command !== 'open') fail(u.watchOnly);
  if (values['no-watch'] && command !== 'mcp') fail(u.onlyWith('--no-watch', 'mcp'));
  if (command === 'mcp') {
    // as mudanças do git vêm a cada chamada do rastro_impact (--out, --port e --no-open já
    // falham acima: o mcp não grava nada nem abre navegador)
    if (values.changes) fail(u.mcpGitPerCall('--changes'));
    if (values.since !== undefined) fail(u.mcpGitPerCall('--since'));
  }
  // o impact de uma pasta sempre lê o git (e o mcp, a cada chamada do rastro_impact); os
  // outros comandos só com --changes ou --since
  if (
    values['trust-git-config'] &&
    command !== 'impact' &&
    command !== 'mcp' &&
    !values.changes &&
    values.since === undefined
  )
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
  if (values.out !== undefined) {
    try {
      if (command === 'analyze' || command === 'open') checkGraphTarget(values.out);
      else if (fs.statSync(values.out, { throwIfNoEntry: false })?.isDirectory())
        fail(t().export.writeFailed(path.resolve(values.out), t().export.isDir));
    } catch (err) {
      fail((err as Error).message);
    }
  }
  /** Como descobrir os arquivos do projeto (análise e modo ao vivo usam as mesmas regras). */
  const discover: DiscoverOptions = {
    ...(values.exclude ? { exclude: values.exclude } : {}),
    respectGitignore: !values['no-gitignore'],
    ...(maxFiles ? { maxFiles } : {}),
  };

  if (command === 'validate') {
    let data: unknown;
    try {
      data = readGraphJson(target);
    } catch (err) {
      fail((err as Error).message);
    }
    const result = validateGraph(data, { lang: getLang() });
    if (!result.valid) {
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

  /**
   * Confere o git antes da análise (que pode demorar) quando as mudanças são obrigatórias:
   * pasta fora de um repositório ou referência desconhecida falham na hora.
   */
  const precheckGit = (root: string) => {
    try {
      checkGit(root, {
        ...(values.since !== undefined ? { since: values.since } : {}),
        trustConfig: !!values['trust-git-config'],
      });
    } catch (err) {
      fail(t().impact.gitFailed(safeText((err as Error).message)));
    }
  };

  /** Anexa as mudanças do git ao grafo quando `--changes`/`--since` foram pedidos. */
  const attachChanges = (graph: RastroGraph, root: string, warn: boolean) => {
    if (!values.changes && values.since === undefined) return;
    try {
      graph.changes = collectChanges(root, {
        ...(values.since !== undefined ? { since: values.since } : {}),
        trustConfig: !!values['trust-git-config'],
      });
    } catch (err) {
      const reason = err instanceof GitError ? err.message : (err as Error).message;
      // pedido explícito num comando não interativo (analyze, export): sem as mudanças, o
      // resultado não é o que foi pedido. Ao abrir o mapa, só avisa e segue.
      if (command === 'analyze' || command === 'export')
        fail(t().impact.gitFailed(safeText(reason)));
      if (warn)
        process.stderr.write(
          `${yellow(t().warningPrefix)} ${t().changes.skipped(safeText(reason))}\n`,
        );
    }
  };

  if (command === 'compare') {
    const other = rest[1];
    if (!other) fail(u.compareNeedsTwo);
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
      if (values.changes || values.since !== undefined) precheckGit(source);
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

  if (command === 'impact') {
    const format = (values.format ?? 'text') as ImpactFormat;
    if (!IMPACT_FORMATS.includes(format)) fail(t().impact.badFormat(values.format!));
    if (values.tests && values.format !== undefined) fail(u.notTogether('--tests', '--format'));
    if (values.link !== undefined && format !== 'markdown') fail(t().impact.linkNeedsMarkdown);
    const source = path.resolve(target);
    if (!fs.existsSync(source)) fail(u.pathNotFound(source));
    const fromFolder = fs.statSync(source).isDirectory();
    if (!fromFolder && analysisFlag) fail(u.needsFolder(analysisFlag, command));
    let graph: RastroGraph;
    if (fromFolder) {
      precheckGit(source);
      // só o texto mostra o progresso: markdown, json e --tests costumam ir para arquivos e CI
      const progress = format === 'text' && !values.tests;
      graph = await analyzeProject(source, {
        ...discover,
        ...(progress ? { onProgress: showProgress } : {}),
      });
      try {
        // sem --changes nem --since: o que ainda não foi commitado
        graph.changes = collectChanges(source, {
          ...(values.since !== undefined ? { since: values.since } : {}),
          trustConfig: !!values['trust-git-config'],
        });
      } catch (err) {
        fail(t().impact.gitFailed(safeText((err as Error).message)));
      }
    } else {
      try {
        graph = loadGraph(source);
      } catch (err) {
        fail((err as Error).message);
      }
      if (!graph.changes) fail(t().impact.needsChanges);
    }
    const report = buildImpactReport(graph);
    let content: string;
    if (values.tests) {
      // um caminho por linha: nomes com quebra de linha ou controles não entram (virariam
      // argumentos falsos no executor de testes)
      const files = testPathsFrom(report, graph.project.root);
      // eslint-disable-next-line no-control-regex
      const odd = /[\u0000-\u001f\u007f-\u009f]/;
      for (const f of files.filter((f) => odd.test(f)))
        process.stderr.write(`${yellow(t().warningPrefix)} ${t().impact.oddTest(safeText(f))}\n`);
      const clean = files.filter((f) => !odd.test(f));
      content = clean.length ? `${clean.join('\n')}\n` : '';
    } else {
      content = renderImpact(report, format, {
        ...(values.link !== undefined ? { link: values.link } : {}),
      });
    }
    if (values.out !== undefined) {
      try {
        // cores do terminal não vão para arquivos
        // eslint-disable-next-line no-control-regex
        const written = writeExport(values.out, content.replace(/\u001b\[[0-9;]*m/g, ''));
        process.stderr.write(
          `${t().export.saved(values.tests ? 'tests' : format)} ${cyan(tildify(written))}\n`,
        );
      } catch (err) {
        fail((err as Error).message);
      }
      return;
    }
    process.stdout.write(content);
    return;
  }

  if (command === 'mcp') {
    const root = path.resolve(target);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(u.dirNotFound(root));
    await runMcp({
      root,
      discover,
      watch: !values['no-watch'],
      trustGitConfig: !!values['trust-git-config'],
    });
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
  // analyze com --changes/--since falha sem as mudanças; ao abrir o mapa, só avisa (depois)
  if (command === 'analyze' && (values.changes || values.since !== undefined)) precheckGit(root);

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

// a worker de análise do `rastro mcp` carrega este mesmo arquivo: lá, só a worker roda
if (!IN_ANALYSIS_WORKER)
  main(process.argv.slice(2)).catch((err: unknown) =>
    fail(err instanceof Error ? err.message : String(err)),
  );
