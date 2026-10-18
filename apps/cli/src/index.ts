#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { analyzeProject } from '@rastro/analyzer';
import { RASTRO_VERSION, validateGraph, type NodeKind, type RastroGraph } from '@rastro/core';
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
import { startServer, type RunningServer } from './server.js';
import { watchProject } from './watch.js';
import { defaultGraphPath, loadGraph, saveGraph } from './storage.js';
import { bold, cyan, dim, fail, red, tildify, yellow } from './term.js';

const HELP = `
Rastro ${RASTRO_VERSION} — siga o rastro do seu código (mapa navegável de projetos JS/TS)

Uso:
  rastro <caminho>                  analisa o projeto e abre o mapa no navegador
                                  (equivale a "rastro open <caminho>")
  rastro analyze <caminho>          só analisa e salva o grafo em JSON
  rastro serve <grafo.json>         abre o mapa de um JSON salvo anteriormente
  rastro validate <grafo.json>      confere se um JSON exportado é válido
  rastro export <caminho|grafo.json> --format <formato>
                                  exporta o mapa: mermaid, dot, graphml, json ou html
                                  (html = relatório navegável num arquivo só, offline)
  rastro compare <a.json> <b.json>  o que entrou, saiu e mudou entre duas análises

Opções:
  -o, --out <arquivo>       onde salvar o JSON (padrão: cache do usuário); no export,
                            o arquivo gerado (padrão: saída padrão; html: <projeto>.rastro.html)
      --stdout              (analyze) escreve o JSON na saída padrão
  -f, --format <formato>    (export) mermaid, dot, graphml, json ou html
      --level <nível>       (export) modules, files (padrão) ou symbols
      --folder <pasta>      (export) só esta pasta, ex.: src/services
      --edges <tipos>       (export) relações, ex.: imports,calls (padrão: imports,calls,extends)
      --external            (export) inclui pacotes externos (npm, Node.js)
      --no-unresolved       (export) omite referências não resolvidas
      --json                (compare) resultado em JSON
  -p, --port <n>            porta da interface (padrão: 4321, ou a próxima livre)
      --no-open             não abre o navegador automaticamente
  -e, --exclude <padrão>    ignora caminhos (sintaxe do .gitignore; pode repetir)
      --no-gitignore        não usa o .gitignore do projeto
      --max-files <n>       limite de arquivos analisados (padrão: 10000)
      --changes             marca o que mudou desde o último commit (git) e o impacto
      --since <ref>         marca o que mudou desde que a branch saiu de <ref> (ex.: main)
      --trust-git-config    permite rodar o git mesmo com comandos no .git/config
  -w, --watch               reanalisa ao salvar arquivos e atualiza o mapa ao vivo
  -h, --help                mostra esta ajuda
  -v, --version             mostra a versão

O Rastro só lê arquivos: não executa o projeto, não instala dependências e não
envia nada para a internet. A interface fica disponível apenas em 127.0.0.1.
`;

function webRoot(): string {
  return fileURLToPath(new URL('./web/', import.meta.url));
}

function printChanges(graph: RastroGraph): void {
  const changes = graph.changes!;
  const impact = computeChangeImpact(new GraphIndex(graph), changes);
  const out = (s = '') => process.stderr.write(`${s}\n`);
  const since =
    changes.baseLabel === 'HEAD' ? 'desde o último commit' : `desde ${changes.baseLabel}`;
  if (!changes.files.length) {
    out(`  ${dim(`nenhuma mudança ${since}`)}`);
    out();
    return;
  }
  out(`${bold('Mudanças')} ${dim(since)}`);
  out(
    `  ${changes.files.length} arquivo(s) alterado(s) · ${impact.changedEntities.length} entidade(s) alterada(s)`,
  );
  out(
    `  impacto: ${impact.impacted.length} entidade(s) dependem do que mudou` +
      (impact.routes.length ? ` · ${impact.routes.length} rota(s)` : '') +
      (impact.tests.length ? ` · ${impact.tests.length} arquivo(s) de teste` : ''),
  );
  for (const route of impact.routes.slice(0, 5)) out(`    ${cyan('↳')} ${route.name}`);
  out();
}

function printSummary(graph: RastroGraph, savedTo?: string): void {
  const { stats } = graph;
  const out = (s = '') => process.stderr.write(`${s}\n`);
  out();
  out(`${bold(graph.project.name)} ${dim(tildify(graph.project.root))}`);
  const names: Partial<Record<NodeKind, [string, string]>> = {
    function: ['função', 'funções'],
    class: ['classe', 'classes'],
    method: ['método', 'métodos'],
    route: ['rota', 'rotas'],
    package: ['pacote externo', 'pacotes externos'],
    unresolved: ['não resolvido', 'não resolvidos'],
  };
  const parts = [
    `${stats.files} ${stats.files === 1 ? 'arquivo analisado' : 'arquivos analisados'}`,
  ];
  for (const [kind, [one, many]] of Object.entries(names) as Array<[NodeKind, [string, string]]>) {
    const n = stats.nodesByKind[kind];
    if (n) parts.push(`${n} ${n === 1 ? one : many}`);
  }
  out(`  ${parts.join(' · ')}`);
  const r = stats.edgesByResolution;
  out(
    `  relações: ${r.resolved ?? 0} resolvidas · ${r.external ?? 0} externas · ${r.unresolved ?? 0} não resolvidas`,
  );
  if (stats.importCycles.length)
    out(`  ${yellow(`${stats.importCycles.length} ciclo(s) de importação`)}`);
  const warnings = graph.diagnostics.filter((d) => d.level !== 'info');
  if (warnings.length) {
    out(`  ${yellow(`${warnings.length} aviso(s):`)}`);
    for (const d of warnings.slice(0, 5))
      out(
        `    ${dim('•')} ${d.file ? `${d.file}${d.line ? `:${d.line}` : ''} — ` : ''}${d.message}`,
      );
    if (warnings.length > 5)
      out(dim(`    … e mais ${warnings.length - 5} (veja "diagnostics" no JSON)`));
  }
  out(
    dim(`  análise em ${stats.durationMs} ms com TypeScript ${graph.analyzer.typescriptVersion}`),
  );
  if (savedTo) out(`  grafo salvo em ${cyan(tildify(savedTo))}`);
  out();
}

async function serve(graph: RastroGraph, port: number, open: boolean): Promise<RunningServer> {
  const root = webRoot();
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    fail(
      'a interface web não foi compilada. Rode "npm run build" na raiz do repositório do Rastro.',
    );
  }
  const server = await startServer({ graph, webRoot: root, port });
  process.stderr.write(
    `${bold('Rastro')} pronto em ${cyan(server.url)}  ${dim('(Ctrl+C para encerrar)')}\n` +
      dim('  O endereço inclui um token de acesso válido só nesta execução.\n'),
  );
  if (open) openBrowser(server.url);
  const stop = () => {
    process.stderr.write(dim('\nEncerrando...\n'));
    void server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}

async function main(argv: string[]): Promise<void> {
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
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    fail(`${(err as Error).message}\nUse "rastro --help" para ver as opções.`);
  }
  const { values, positionals } = parsed;
  if (values.version) return void process.stdout.write(`${RASTRO_VERSION}\n`);
  if (values.help || positionals.length === 0) return void process.stdout.write(HELP);

  const commands = ['open', 'analyze', 'serve', 'validate', 'export', 'compare'];
  const [first, ...rest] = positionals;
  // "rastro analyze" sem caminho, mas existindo uma pasta chamada "analyze": trata como caminho
  const isCommand = commands.includes(first!) && (rest.length > 0 || !fs.existsSync(first!));
  const command = isCommand ? first! : 'open';
  const target = isCommand ? rest[0] : first;
  if (!target)
    fail(`informe o caminho para "${command}". Exemplo: rastro ${command} ./meu-projeto`);

  const servesUi = command === 'open' || command === 'serve';
  if (values.port !== undefined && (!servesUi || !/^\d+$/.test(values.port)))
    fail(
      servesUi
        ? '--port precisa ser um número entre 0 e 65535.'
        : `--port não se aplica a "${command}".`,
    );
  const port = values.port !== undefined ? Number(values.port) : 4321;
  if (port > 65535) fail('--port precisa ser um número entre 0 e 65535.');
  if (values.stdout && command !== 'analyze') fail('--stdout só funciona com "rastro analyze".');
  if (values.out && command !== 'analyze' && command !== 'open' && command !== 'export')
    fail(`--out não se aplica a "${command}".`);
  if (values.json && command !== 'compare') fail('--json só funciona com "rastro compare".');
  if (command !== 'export') {
    const exportOnly = (
      ['format', 'level', 'folder', 'edges', 'external', 'no-unresolved'] as const
    ).find((k) => values[k] !== undefined);
    if (exportOnly) fail(`--${exportOnly} só funciona com "rastro export".`);
  }
  const maxFiles = values['max-files'] !== undefined ? Number(values['max-files']) : undefined;
  if (maxFiles !== undefined && (!Number.isInteger(maxFiles) || maxFiles < 1))
    fail('--max-files precisa ser um inteiro positivo.');

  if (command === 'validate') {
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(path.resolve(target), 'utf8'));
    } catch (err) {
      fail(`não foi possível ler o JSON: ${(err as Error).message}`);
    }
    const result = validateGraph(data);
    if (!result.valid) {
      process.stderr.write(
        `${red('inválido')}\n${result.errors.map((e) => `  • ${e}`).join('\n')}\n`,
      );
      process.exit(1);
    }
    const g = data as RastroGraph;
    process.stdout.write(
      `válido — ${g.nodes.length} nós, ${g.edges.length} relações (schema ${g.schemaVersion})\n`,
    );
    return;
  }

  if (command === 'compare') {
    const other = rest[1];
    if (!other || rest.length > 2)
      fail('informe dois arquivos JSON. Exemplo: rastro compare antes.json depois.json');
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
    if (!fs.existsSync(source)) fail(`caminho não encontrado: ${source}`);
    let graph: RastroGraph;
    if (fs.statSync(source).isDirectory()) {
      graph = await analyzeProject(source, {
        ...(values.exclude ? { exclude: values.exclude } : {}),
        respectGitignore: !values['no-gitignore'],
        ...(maxFiles ? { maxFiles } : {}),
        onProgress: (msg) => process.stderr.write(dim(`  ${msg}\n`)),
      });
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
      fail(`não foi possível exportar: ${(err as Error).message}`);
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
    process.stderr.write(`${request.format} salvo em ${cyan(tildify(written))}\n`);
    if (request.format === 'html')
      process.stderr.write(
        dim(
          '  Abra no navegador: o mapa funciona offline, sem servidor (o código-fonte não vai junto).\n',
        ),
      );
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
        `${yellow('aviso:')} a pasta analisada (${graph.project.root}) não existe nesta máquina; o código-fonte não poderá ser exibido.\n`,
      );
    }
    await serve(graph, port, !values['no-open']);
    return;
  }

  const root = path.resolve(target);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory())
    fail(`diretório não encontrado: ${root}`);
  const quiet = command === 'analyze' && values.stdout;
  if (values.watch && command !== 'open')
    fail('--watch só funciona ao abrir o mapa (rastro <caminho>).');

  /** Analisa o projeto (e as mudanças do git, se pedidas). Reutilizado pelo modo --watch. */
  const runAnalysis = async (progress: boolean) => {
    const result = await analyzeProject(root, {
      ...(values.exclude ? { exclude: values.exclude } : {}),
      respectGitignore: !values['no-gitignore'],
      ...(maxFiles ? { maxFiles } : {}),
      onProgress: progress ? (msg) => process.stderr.write(dim(`  ${msg}\n`)) : undefined,
    });
    if (values.changes || values.since) {
      try {
        result.changes = collectChanges(root, {
          ...(values.since ? { since: values.since } : {}),
          trustConfig: !!values['trust-git-config'],
        });
      } catch (err) {
        const reason = err instanceof GitError ? err.message : (err as Error).message;
        if (progress)
          process.stderr.write(`${yellow('aviso:')} mudanças do git não incluídas: ${reason}\n`);
      }
    }
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
  if (values.watch) startWatch(root, server, runAnalysis, values.out ?? defaultGraphPath(graph));
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
      server.update(next);
      saveGraph(next, savePath);
      const shown =
        files.slice(0, 3).join(', ') + (files.length > 3 ? ` +${files.length - 3}` : '');
      process.stderr.write(
        `${cyan('↻')} ${shown} ${dim(`· reanalisado em ${Date.now() - started} ms · ${next.stats.files} arquivos`)}\n`,
      );
    } catch (err) {
      process.stderr.write(`${yellow('aviso:')} a reanálise falhou: ${(err as Error).message}\n`);
    } finally {
      running = false;
      if (again) {
        const queued = again;
        again = null;
        void rerun(queued);
      }
    }
  };
  watchProject(root, (files) => void rerun(files));
  process.stderr.write(dim('  Modo ao vivo: o mapa se atualiza quando você salva um arquivo.\n'));
}

main(process.argv.slice(2)).catch((err: unknown) =>
  fail(err instanceof Error ? err.message : String(err)),
);
