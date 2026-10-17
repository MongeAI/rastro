#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { analyzeProject } from '@teia/analyzer';
import { TEIA_VERSION, validateGraph, type NodeKind, type TeiaGraph } from '@teia/core';
import { openBrowser } from './browser.js';
import { startServer } from './server.js';
import { defaultGraphPath, loadGraph, saveGraph } from './storage.js';

const HELP = `
Teia ${TEIA_VERSION} — mapa navegável de projetos JavaScript/TypeScript

Uso:
  teia <caminho>                  analisa o projeto e abre o mapa no navegador
                                  (equivale a "teia open <caminho>")
  teia analyze <caminho>          só analisa e salva o grafo em JSON
  teia serve <grafo.json>         abre o mapa de um JSON salvo anteriormente
  teia validate <grafo.json>      confere se um JSON exportado é válido

Opções:
  -o, --out <arquivo>       onde salvar o JSON (padrão: cache do usuário)
      --stdout              (analyze) escreve o JSON na saída padrão
  -p, --port <n>            porta da interface (padrão: 4321, ou a próxima livre)
      --no-open             não abre o navegador automaticamente
  -e, --exclude <padrão>    ignora caminhos (sintaxe do .gitignore; pode repetir)
      --no-gitignore        não usa o .gitignore do projeto
      --max-files <n>       limite de arquivos analisados (padrão: 10000)
  -h, --help                mostra esta ajuda
  -v, --version             mostra a versão

O Teia só lê arquivos: não executa o projeto, não instala dependências e não
envia nada para a internet. A interface fica disponível apenas em 127.0.0.1.
`;

const color = (code: number) => (s: string) =>
  process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = color(1);
const dim = color(2);
const red = color(31);
const yellow = color(33);
const cyan = color(36);

function fail(message: string): never {
  process.stderr.write(`${red('erro:')} ${message}\n`);
  process.exit(1);
}

function webRoot(): string {
  return fileURLToPath(new URL('./web/', import.meta.url));
}

function printSummary(graph: TeiaGraph, savedTo?: string): void {
  const { stats } = graph;
  const out = (s = '') => process.stderr.write(`${s}\n`);
  out();
  out(`${bold(graph.project.name)} ${dim(graph.project.root)}`);
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
  if (savedTo) out(`  grafo salvo em ${cyan(savedTo)}`);
  out();
}

async function serve(graph: TeiaGraph, port: number, open: boolean): Promise<void> {
  const root = webRoot();
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    fail('a interface web não foi compilada. Rode "npm run build" na raiz do repositório do Teia.');
  }
  const server = await startServer({ graph, webRoot: root, port });
  process.stderr.write(
    `${bold('Teia')} pronto em ${cyan(server.url)}  ${dim('(Ctrl+C para encerrar)')}\n` +
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
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    fail(`${(err as Error).message}\nUse "teia --help" para ver as opções.`);
  }
  const { values, positionals } = parsed;
  if (values.version) return void process.stdout.write(`${TEIA_VERSION}\n`);
  if (values.help || positionals.length === 0) return void process.stdout.write(HELP);

  const commands = ['open', 'analyze', 'serve', 'validate'];
  const [first, ...rest] = positionals;
  // "teia analyze" sem caminho, mas existindo uma pasta chamada "analyze": trata como caminho
  const isCommand = commands.includes(first!) && (rest.length > 0 || !fs.existsSync(first!));
  const command = isCommand ? first! : 'open';
  const target = isCommand ? rest[0] : first;
  if (!target) fail(`informe o caminho para "${command}". Exemplo: teia ${command} ./meu-projeto`);

  const servesUi = command === 'open' || command === 'serve';
  if (values.port !== undefined && (!servesUi || !/^\d+$/.test(values.port)))
    fail(
      servesUi
        ? '--port precisa ser um número entre 0 e 65535.'
        : `--port não se aplica a "${command}".`,
    );
  const port = values.port !== undefined ? Number(values.port) : 4321;
  if (port > 65535) fail('--port precisa ser um número entre 0 e 65535.');
  if (values.stdout && command !== 'analyze') fail('--stdout só funciona com "teia analyze".');
  if (values.out && command !== 'analyze' && command !== 'open')
    fail(`--out não se aplica a "${command}".`);
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
    const g = data as TeiaGraph;
    process.stdout.write(
      `válido — ${g.nodes.length} nós, ${g.edges.length} relações (schema ${g.schemaVersion})\n`,
    );
    return;
  }

  if (command === 'serve') {
    let graph: TeiaGraph;
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
    return serve(graph, port, !values['no-open']);
  }

  const root = path.resolve(target);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory())
    fail(`diretório não encontrado: ${root}`);
  const quiet = command === 'analyze' && values.stdout;
  const graph = await analyzeProject(root, {
    ...(values.exclude ? { exclude: values.exclude } : {}),
    respectGitignore: !values['no-gitignore'],
    ...(maxFiles ? { maxFiles } : {}),
    onProgress: quiet ? undefined : (msg) => process.stderr.write(dim(`  ${msg}\n`)),
  });

  if (quiet) {
    process.stdout.write(`${JSON.stringify(graph, null, 2)}\n`);
    return;
  }
  const savedTo = saveGraph(graph, values.out ?? defaultGraphPath(graph));
  printSummary(graph, savedTo);
  if (command === 'analyze') return;
  return serve(graph, port, !values['no-open']);
}

main(process.argv.slice(2)).catch((err: unknown) =>
  fail(err instanceof Error ? err.message : String(err)),
);
