import path from 'node:path';
import fs from 'node:fs';
import { Node, Project, SyntaxKind, ts, type KindToNodeMappings, type SourceFile } from 'ts-morph';
import {
  nodeId,
  SCHEMA_VERSION,
  RASTRO_VERSION,
  type Diagnostic,
  type EdgeMeta,
  type Evidence,
  type GraphNode,
  type Language,
  type SourceRange,
  type RastroGraph,
  type UnresolvedReason,
} from '@rastro/core';
import { GraphBuilder } from '@rastro/graph';
import { discoverFiles, toPosix, type DiscoverOptions, type DiscoveredFile } from './discover.js';
import {
  fileStamp,
  loadCompilerOptions,
  ModuleResolver,
  packageNameOf,
  type InputStamps,
} from './resolve.js';
import { ImplementationIndex } from './implementations.js';
import { RouteDetector } from './routes/index.js';
import { progressMessage, type ProgressEvent } from './progress.js';

export interface AnalyzeOptions extends DiscoverOptions {
  /** Nome exibido do projeto (padrão: nome do package.json ou da pasta). */
  name?: string;
  /**
   * Recebe o progresso: o texto padrão (em português) e a etapa com código estável e
   * parâmetros, para mostrar o texto em outro idioma.
   */
  onProgress?: (message: string, event: ProgressEvent) => void;
}

const MAX_SNIPPET = 160;
const MAX_SYNTAX_DIAGNOSTICS = 50;

/** Contexto compartilhado durante uma análise. */
interface Ctx {
  root: string;
  builder: GraphBuilder;
  resolver: ModuleResolver;
  checker: ts.TypeChecker;
  /** Caminho absoluto → arquivo descoberto. */
  filesByAbs: Map<string, DiscoveredFile>;
  /** Nó do compilador → id da entidade (função, classe, método, rota). */
  entities: Map<ts.Node, string>;
  /** Linhas de cada arquivo, para montar trechos de evidência. */
  lines: Map<string, string[]>;
  diagnostics: Diagnostic[];
  counters: {
    externalCallsSkipped: number;
    unknownReceiverCalls: number;
    computedCalls: number;
    localCalls: number;
  };
}

/**
 * Analisa estaticamente um projeto JavaScript/TypeScript e devolve o grafo.
 * O código do projeto nunca é executado: tudo é lido como texto e interpretado
 * pelo compilador do TypeScript (via ts-morph).
 */
export async function analyzeProject(
  rootInput: string,
  options: AnalyzeOptions = {},
): Promise<RastroGraph> {
  return runAnalysis(rootInput, options, {
    stamps: new Map(),
    inputs: new Map(),
    external: new Map(),
  });
}

/**
 * Análises repetidas do mesmo projeto (modo `--watch`): o compilador fica em memória entre
 * uma análise e outra e só os arquivos alterados (data ou tamanho diferentes) são relidos e
 * interpretados de novo. Tudo o mais — entidades, imports, chamadas, rotas — é sempre
 * recalculado do zero: o resultado é idêntico ao de uma análise nova.
 */
export class AnalysisSession {
  private readonly cache: CompilerCache = {
    stamps: new Map(),
    inputs: new Map(),
    external: new Map(),
  };

  constructor(
    private readonly rootInput: string,
    private readonly options: AnalyzeOptions = {},
  ) {}

  analyze(): Promise<RastroGraph> {
    return runAnalysis(this.rootInput, this.options, this.cache);
  }
}

const DEPENDENCY_MANIFESTS = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];

/** Compilador guardado entre análises de uma sessão. */
interface CompilerCache {
  project?: Project;
  /** Opções do compilador usadas para criar o projeto: se mudarem, ele é recriado. */
  fingerprint?: string;
  /** Resolvedor da análise atual (o verificador de tipos resolve imports por ele). */
  resolver?: ModuleResolver;
  /** Caminho absoluto → `mtime:tamanho` de quando o arquivo foi lido. */
  stamps: Map<string, string>;
  /**
   * Configurações e package.json usados na resolução de módulos (inclusive tsconfig de
   * subpacotes, lidos sob demanda, e os procurados que não existiam) → carimbo da leitura.
   * Se algum muda, o compilador é recriado: as resoluções guardadas podem ter mudado.
   */
  inputs: InputStamps;
  /**
   * Arquivos que o compilador leu por conta própria, sem terem sido descobertos (`.d.ts`
   * escritos à mão, JSON, tipos em node_modules, arquivos excluídos) → carimbo da leitura.
   */
  external: Map<string, string>;
}

async function runAnalysis(
  rootInput: string,
  options: AnalyzeOptions,
  cache: CompilerCache,
): Promise<RastroGraph> {
  const started = performance.now();
  const progress = (event: ProgressEvent) => options.onProgress?.(progressMessage(event), event);

  progress({ code: 'discovering' });
  const discovered = discoverFiles(rootInput, options);
  const { root } = discovered;
  progress({ code: 'discovered', files: discovered.files.length });

  const config = loadCompilerOptions(root);
  const diagnostics: Diagnostic[] = [...discovered.diagnostics, ...config.diagnostics];
  const resolver = new ModuleResolver(root, config.options, config.scopes, diagnostics);
  cache.resolver = resolver;
  // dependências instaladas mudam a resolução de imports de arquivos que não mudaram
  const manifests = DEPENDENCY_MANIFESTS.map((name) => {
    try {
      return fs.statSync(path.join(root, name)).mtimeMs;
    } catch {
      return 0;
    }
  });
  // os arquivos de cada escopo (tsconfig referenciado) são um Set: viram lista ordenada
  const scopes = config.scopes.map((s) => ({
    name: s.name,
    files: [...s.files].sort(),
    options: s.options,
  }));
  const fingerprint = JSON.stringify([config.options, scopes, manifests]);
  const inputsChanged = [...cache.inputs].some(([file, stamp]) => fileStamp(file) !== stamp);
  if (!cache.project || cache.fingerprint !== fingerprint || inputsChanged) {
    cache.fingerprint = fingerprint;
    cache.stamps.clear();
    cache.inputs.clear();
    cache.external.clear();
    cache.project = new Project({
      compilerOptions: config.options,
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      // o verificador de tipos resolve cada import com o tsconfig do próprio arquivo (subpacotes)
      resolutionHost: () => ({
        resolveModuleNames: (names, containingFile, _reused, _redirected, _options, sourceFile) =>
          names.map((name) =>
            cache.resolver!.resolveForProgram(name, containingFile, sourceFile?.impliedNodeFormat),
          ),
      }),
    });
  }
  const project = cache.project;
  // arquivos que saíram da análise (removidos, excluídos) saem do compilador
  const wanted = new Set(discovered.files.map((f) => f.absolute));
  const inProject = new Set<string>();
  for (const sf of project.getSourceFiles()) {
    const absolute = path.normalize(sf.getFilePath());
    if (!wanted.has(absolute)) {
      project.removeSourceFile(sf);
      cache.stamps.delete(absolute);
    } else {
      inProject.add(absolute);
    }
  }
  // `.d.ts` escritos à mão e outros arquivos que o compilador leu sozinho: relidos se mudaram
  for (const [absolute, stamp] of cache.external) {
    if (wanted.has(absolute)) {
      cache.external.delete(absolute); // agora é um arquivo descoberto (tratado abaixo)
      continue;
    }
    const current = fileStamp(absolute);
    if (current === stamp) continue;
    try {
      project.getSourceFile(absolute)?.refreshFromFileSystemSync();
    } catch {
      const stale = project.getSourceFile(absolute);
      if (stale) project.removeSourceFile(stale);
    }
    cache.external.delete(absolute);
  }
  // o parse acontece aqui: um arquivo extremo (aninhamento profundo, sem permissão de leitura)
  // vira um aviso e sai da análise, em vez de derrubar tudo
  const readable: DiscoveredFile[] = [];
  for (const file of discovered.files) {
    try {
      // o compilador trata a barra invertida como separador de pastas: o arquivo seria outro (ou nenhum)
      if (file.relative.includes('\\')) throw new BackslashNameError();
      const stat = fs.statSync(file.absolute);
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      const existing = project.getSourceFile(file.absolute);
      if (!existing) project.addSourceFileAtPath(file.absolute);
      else {
        if (cache.stamps.get(file.absolute) !== stamp) existing.refreshFromFileSystemSync();
        // lido antes só como dependência de outro arquivo: passa a fazer parte do projeto
        if (!inProject.has(file.absolute)) project.addSourceFileAtPath(file.absolute);
      }
      cache.stamps.set(file.absolute, stamp);
      readable.push(file);
    } catch (err) {
      const stale = project.getSourceFile(file.absolute);
      if (stale) project.removeSourceFile(stale);
      cache.stamps.delete(file.absolute);
      const failure = describeFailure(err, root);
      diagnostics.push({
        level: 'warning',
        code: 'parse-failed',
        message: `Arquivo ignorado: não foi possível ler ou interpretar (${failure.text}).`,
        file: file.relative,
        params: failure.params,
      });
    }
  }
  discovered.files = readable;

  progress({ code: 'loading-compiler' });
  let program: ts.Program;
  try {
    program = project.getProgram().compilerObject;
  } catch (err) {
    throw new Error(
      `O compilador TypeScript não conseguiu montar o projeto (${(err as Error).message}). ` +
        'Tente excluir pastas geradas com --exclude.',
      { cause: err },
    );
  }
  // o que o compilador leu além dos arquivos descobertos, para relermos se mudar
  for (const sf of program.getSourceFiles()) {
    const absolute = toPosix(path.resolve(sf.fileName));
    if (wanted.has(absolute) || cache.external.has(absolute)) continue;
    const stamp = fileStamp(absolute);
    // bibliotecas padrão do TypeScript ficam em memória (não existem no disco)
    if (stamp !== '-') cache.external.set(absolute, stamp);
  }
  const ctx: Ctx = {
    root,
    builder: new GraphBuilder(),
    resolver,
    checker: program.getTypeChecker(),
    filesByAbs: new Map(discovered.files.map((f) => [f.absolute, f])),
    entities: new Map(),
    lines: new Map(),
    diagnostics,
    counters: { externalCallsSkipped: 0, unknownReceiverCalls: 0, computedCalls: 0, localCalls: 0 },
  };

  const sourceFiles = discovered.files
    .map((f) => [f, project.getSourceFile(f.absolute)] as const)
    .filter((pair): pair is readonly [DiscoveredFile, SourceFile] => !!pair[1]);

  // Passo 1: arquivos, módulos, entidades e rotas (Express, Fastify, Hono, NestJS, Next.js)
  progress({ code: 'extracting' });
  let syntaxErrors = 0;
  const routes = new RouteDetector(ctx);
  for (const [file, sf] of sourceFiles) {
    // mesmas quebras de linha que o TypeScript usa para numerar linhas
    ctx.lines.set(file.relative, sf.getFullText().split(/\r\n|[\r\n\u2028\u2029]/));
    addFileNode(ctx, file, sf);
    safely(ctx, file, 'entities', () => extractEntities(ctx, file, sf));
    routes.prepare(file, sf);
    for (const diag of program.getSyntacticDiagnostics(sf.compilerNode)) {
      if (syntaxErrors++ >= MAX_SYNTAX_DIAGNOSTICS) break;
      const line =
        diag.start !== undefined
          ? sf.compilerNode.getLineAndCharacterOfPosition(diag.start).line + 1
          : undefined;
      const error = ts.flattenDiagnosticMessageText(diag.messageText, ' ');
      ctx.diagnostics.push({
        level: 'warning',
        code: 'syntax-error',
        message: `Erro de sintaxe: ${error}`,
        file: file.relative,
        ...(line ? { line } : {}),
        params: { error },
      });
    }
  }
  for (const [file, sf] of sourceFiles) {
    routes.detect(file, sf);
    release(sf);
  }
  try {
    routes.finish();
  } catch (err) {
    const failure = describeFailure(err, root);
    ctx.diagnostics.push({
      level: 'warning',
      code: 'analysis-failed',
      message: `Não foi possível compor os caminhos completos das rotas: ${failure.text}.`,
      params: { step: 'route-paths', ...failure.params },
    });
  }

  // Passo 2: relações (imports, exports, chamadas, herança)
  progress({ code: 'resolving' });
  for (const [file, sf] of sourceFiles) {
    safely(ctx, file, 'imports', () => extractImports(ctx, file, sf));
    safely(ctx, file, 'exports', () => extractExports(ctx, file, sf));
    safely(ctx, file, 'calls', () => extractCalls(ctx, file, sf));
    safely(ctx, file, 'jsx', () => extractJsxUsages(ctx, file, sf));
    safely(ctx, file, 'heritage', () => extractHeritage(ctx, file, sf));
    release(sf);
  }
  routes.afterCalls();

  countMentions(ctx);

  // o que a resolução de módulos leu nesta análise (o carimbo mais antigo vale: se o arquivo
  // mudou durante a análise, a próxima recria o compilador)
  for (const [file, stamp] of [...config.inputs, ...resolver.inputs])
    if (!cache.inputs.has(file)) cache.inputs.set(file, stamp);

  progress({ code: 'building-graph' });
  const finalized = ctx.builder.finalize();
  const languages = [...new Set(discovered.files.map((f) => f.language))].sort();

  const graph: RastroGraph = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    tool: { name: 'rastro', version: RASTRO_VERSION },
    project: {
      name: options.name ?? projectName(root),
      root,
      languages,
      ...tsconfigInfo(config.configFile, resolver.nestedConfigs()),
    },
    analyzer: {
      name: '@rastro/analyzer (ts-morph)',
      version: RASTRO_VERSION,
      typescriptVersion: ts.version,
      options: {
        exclude: options.exclude ?? [],
        respectGitignore: options.respectGitignore !== false,
        maxFiles: options.maxFiles ?? 10_000,
        maxFileSizeBytes: options.maxFileSizeBytes ?? 1_000_000,
      },
    },
    nodes: finalized.nodes,
    edges: finalized.edges,
    stats: {
      files: discovered.files.length,
      nodesByKind: finalized.nodesByKind,
      edgesByKind: finalized.edgesByKind,
      edgesByResolution: finalized.edgesByResolution,
      importCycles: finalized.importCycles,
      ...ctx.counters,
      durationMs: Math.round(performance.now() - started),
    },
    diagnostics: ctx.diagnostics,
  };
  if (discovered.files.length === 0) {
    graph.diagnostics.push({
      level: 'warning',
      code: 'no-source-files',
      message: 'Nenhum arquivo .js/.jsx/.ts/.tsx foi encontrado (após aplicar as exclusões).',
      params: {},
    });
  }
  progress({ code: 'done', durationMs: graph.stats.durationMs });
  return graph;
}

export type AnalyzerContext = Ctx;

/** Configurações usadas: a da raiz (com referências) e as dos subpacotes. */
function tsconfigInfo(rootConfig: string | undefined, nested: string[]): { tsconfig?: string } {
  if (!nested.length) return rootConfig ? { tsconfig: rootConfig } : {};
  const MAX_LISTED = 5;
  const listed = [...(rootConfig ? [rootConfig] : []), ...nested.slice(0, MAX_LISTED)];
  const more = nested.length > MAX_LISTED ? ` +${nested.length - MAX_LISTED}` : '';
  return { tsconfig: `${listed.join(', ')}${more}` };
}

/** Etapas da análise de um arquivo (códigos estáveis em `params.step` de `analysis-failed`). */
export type AnalysisStep =
  | 'entities'
  | 'imports'
  | 'exports'
  | 'calls'
  | 'jsx'
  | 'heritage'
  | 'routes-express'
  | 'routes-fastify'
  | 'routes-hono'
  | 'routes-nestjs'
  | 'routes-next';

/** Nome de cada etapa na mensagem em português (`message`). */
const STEP_LABELS: Record<AnalysisStep, string> = {
  entities: 'entidades',
  imports: 'imports',
  exports: 'exports',
  calls: 'chamadas',
  jsx: 'JSX',
  heritage: 'herança',
  'routes-express': 'rotas (Express)',
  'routes-fastify': 'rotas (Fastify)',
  'routes-hono': 'rotas (Hono)',
  'routes-nestjs': 'rotas (NestJS)',
  'routes-next': 'rotas (Next.js)',
};

/**
 * Executa uma etapa da análise de um arquivo sem derrubar a análise inteira:
 * arquivos patológicos (ex.: expressões aninhadas milhares de vezes) viram um aviso.
 */
export function safely(ctx: Ctx, file: DiscoveredFile, step: AnalysisStep, run: () => void): void {
  try {
    run();
  } catch (err) {
    const failure = describeFailure(err, ctx.root);
    ctx.diagnostics.push({
      level: 'warning',
      code: 'analysis-failed',
      message: `Parte da análise (${STEP_LABELS[step]}) falhou neste arquivo: ${failure.text}. As relações dele podem estar incompletas.`,
      file: file.relative,
      params: { step, ...failure.params },
    });
  }
}

/** Nome de arquivo com barra invertida, que o compilador entende como separador de pastas. */
class BackslashNameError extends Error {}

/**
 * Motivo de uma falha: o texto em português para `message` e os `params` (motivo conhecido
 * em `reason`, senão o erro em `error`). Caminhos absolutos viram relativos à raiz, para não
 * expor a pasta do usuário.
 */
function describeFailure(
  err: unknown,
  root: string,
): { text: string; params: { reason: string } | { error: string } } {
  if (err instanceof BackslashNameError)
    return {
      text: 'o nome contém "\\", que o compilador trata como separador de pastas',
      params: { reason: 'backslash-name' },
    };
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof RangeError && /call stack/i.test(message))
    return { text: 'estrutura aninhada demais para analisar', params: { reason: 'too-deep' } };
  if ((err as NodeJS.ErrnoException)?.code === 'EACCES')
    return { text: 'sem permissão de leitura', params: { reason: 'no-permission' } };
  const error = message.split(`${root}/`).join('').split(root).join('.');
  return { text: error, params: { error } };
}

/**
 * Conta, em todo o código analisado, quantas vezes o nome de cada função, classe ou método
 * aparece como palavra. É uma medida textual (inclui comentários e textos), usada de forma
 * conservadora: só um nome citado uma única vez indica que nada mais o menciona.
 */
function countMentions(ctx: Ctx): void {
  const counts = new Map<string, number>();
  const word = /[A-Za-z_$][\w$]*/g;
  for (const lines of ctx.lines.values()) {
    for (const line of lines) {
      for (const match of line.matchAll(word))
        counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
    }
  }
  for (const id of new Set(ctx.entities.values())) {
    const node = ctx.builder.getNode(id);
    if (!node || (node.kind !== 'function' && node.kind !== 'class' && node.kind !== 'method'))
      continue;
    const name = node.name.replace(/^(get|set) /, '');
    if (name === 'default' || name === 'constructor' || name === 'module.exports') continue;
    node.meta = { ...node.meta, mentions: counts.get(name) ?? 0 };
  }
}

/**
 * Fim do uso de um arquivo numa etapa: descarta a lista de nós por tipo. Os "wrappers" do
 * ts-morph não são liberados (`forgetDescendants` percorria a árvore inteira de novo e custava
 * ~20% da análise); como agora só os nós devolvidos ganham wrapper, a memória quase não muda.
 */
function release(sf: SourceFile): void {
  descendantsCache.delete(sf.compilerNode);
}

/** Nós do compilador de cada arquivo, separados por tipo (uma passada só pela árvore). */
// a chave é o nó do compilador: um arquivo relido (modo --watch) tem outro, e nunca reaproveita
// a lista antiga
const descendantsCache = new WeakMap<ts.SourceFile, Map<SyntaxKind, ts.Node[]>>();

/**
 * Descendentes de um tipo, na mesma ordem de `getDescendantsOfKind` do ts-morph.
 *
 * A árvore de cada arquivo é percorrida uma vez só, direto no compilador, e os "wrappers" do
 * ts-morph são criados apenas para os nós devolvidos. Antes cada tipo pedido percorria a
 * árvore inteira criando objetos para todos os nós: em projetos grandes, metade do tempo da
 * análise ia nisso e na coleta de lixo.
 */
export function descendantsOfKind<K extends SyntaxKind>(
  sf: SourceFile,
  kind: K,
): KindToNodeMappings[K][] {
  let byKind = descendantsCache.get(sf.compilerNode);
  if (!byKind) {
    byKind = new Map();
    const found = byKind;
    const visit = (node: ts.Node): void => {
      let list = found.get(node.kind);
      if (!list) found.set(node.kind, (list = []));
      list.push(node);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf.compilerNode, visit);
    descendantsCache.set(sf.compilerNode, byKind);
  }
  // `_getNodeFromCompilerNode` reaproveita o wrapper do nó se ele já existir
  const wrap = sf as unknown as { _getNodeFromCompilerNode(node: ts.Node): Node };
  return (byKind.get(kind) ?? []).map((n) =>
    wrap._getNodeFromCompilerNode(n),
  ) as KindToNodeMappings[K][];
}

// ---------------------------------------------------------------------------
// utilidades

function projectName(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      name?: unknown;
    };
    if (typeof pkg.name === 'string' && pkg.name) return pkg.name;
  } catch {
    // sem package.json
  }
  return path.basename(root);
}

/**
 * Onde um trecho começa no texto. Uma chamada de método (`a.b(...)`) começa no nome do método:
 * numa cadeia em várias linhas (`Test.createTestingModule({...})` ⏎ `.compile()`), o início da
 * expressão inteira fica linhas acima, numa linha que não contém a chamada.
 */
function startOf(node: ts.Node): ts.Node {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    ? node.expression.name
    : node;
}

export function rangeOf(file: string, node: Node | ts.Node): SourceRange {
  const compiler = node instanceof Node ? node.compilerNode : node;
  const sf = compiler.getSourceFile();
  const start = sf.getLineAndCharacterOfPosition(startOf(compiler).getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(compiler.getEnd());
  return {
    file,
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

const MAX_REFERENCE = 100;
const MAX_LITERAL_IN_REFERENCE = 20;

/**
 * Texto curto de uma expressão chamada, para nomear referências não resolvidas:
 * `app.get(…).post`, `new Hono(…).basePath`, `handlers[…].run`. Argumentos viram `(…)` e
 * trechos que não são nomes viram `…`: o texto original sem espaços chegava a centenas de
 * caracteres e colava palavras (`x instanceof Erro` virava `xinstanceofErro`). Numa cadeia
 * longa demais fica o final, que é o nome chamado.
 */
export function referenceText(expr: ts.Node): string {
  const text = referenceParts(expr, 0);
  return text.length > MAX_REFERENCE ? `…${text.slice(text.length - MAX_REFERENCE + 1)}` : text;
}

function referenceParts(n: ts.Node, depth: number): string {
  if (depth > 40) return '…';
  const inner = (e: ts.Node) => referenceParts(e, depth + 1);
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return n.text;
  if (n.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (n.kind === ts.SyntaxKind.SuperKeyword) return 'super';
  if (ts.isMetaProperty(n)) return `${ts.tokenToString(n.keywordToken)}.${n.name.text}`;
  if (ts.isPropertyAccessExpression(n))
    return `${inner(n.expression)}${n.questionDotToken ? '?.' : '.'}${n.name.text}`;
  if (ts.isElementAccessExpression(n))
    return `${inner(n.expression)}${n.questionDotToken ? '?.' : ''}[…]`;
  if (ts.isCallExpression(n)) return `${inner(n.expression)}${n.questionDotToken ? '?.' : ''}(…)`;
  if (ts.isNewExpression(n)) return `new ${inner(n.expression)}(…)`;
  if (ts.isNonNullExpression(n)) return `${inner(n.expression)}!`;
  if (ts.isParenthesizedExpression(n)) return '(…)';
  if (ts.isStringLiteralLike(n) || ts.isNumericLiteral(n)) {
    const text = n.getText();
    return text.length <= MAX_LITERAL_IN_REFERENCE && !/[\r\n]/.test(text) ? text : '…';
  }
  return '…';
}

export function evidenceAt(ctx: Ctx, file: string, node: Node | ts.Node): Evidence {
  const r = rangeOf(file, node);
  const text = ctx.lines.get(file)?.[r.startLine - 1]?.trim() ?? '';
  return {
    file,
    line: r.startLine,
    column: r.startColumn,
    ...(text
      ? { snippet: text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET - 1)}…` : text }
      : {}),
  };
}

function addFileNode(ctx: Ctx, file: DiscoveredFile, sf: SourceFile): void {
  const dir = path.posix.dirname(file.relative);
  const moduleId = ctx.builder.ensureModule(dir === '.' ? '' : dir);
  const fileId = nodeId.file(file.relative);
  const all = ctx.lines.get(file.relative);
  // um arquivo que termina com quebra de linha não tem uma linha a mais
  const lines = all
    ? Math.max(1, all.length - (all.length > 1 && all[all.length - 1] === '' ? 1 : 0))
    : sf.getEndLineNumber();
  ctx.builder.addNode({
    id: fileId,
    kind: 'file',
    name: path.posix.basename(file.relative),
    qualifiedName: file.relative,
    parent: moduleId,
    location: {
      file: file.relative,
      startLine: 1,
      startColumn: 1,
      endLine: Math.max(1, lines),
      endColumn: 1,
    },
    meta: { language: file.language, lines },
  });
  ctx.builder.addEdge({
    kind: 'contains',
    source: moduleId,
    target: fileId,
    resolution: 'resolved',
    discovery: 'static-ast',
  });
}

/** Registra uma entidade (função/classe/método) e sua relação de contenção. */
function addEntity(
  ctx: Ctx,
  node: GraphNode,
  parentId: string,
  compilerNodes: Array<ts.Node | undefined>,
): string {
  let id = node.id;
  // nomes repetidos no mesmo arquivo (ex.: duas funções "default" em blocos diferentes)
  for (let i = 2; ctx.builder.hasNode(id); i++) id = `${node.id}~${i}`;
  ctx.builder.addNode({ ...node, id, parent: parentId });
  ctx.builder.addEdge({
    kind: 'contains',
    source: parentId,
    target: id,
    resolution: 'resolved',
    discovery: 'static-ast',
  });
  for (const n of compilerNodes) if (n) ctx.entities.set(n, id);
  return id;
}

/** Remove parênteses, `as`, `satisfies` e `!` em volta de uma expressão. */
function unwrap(node: Node | undefined): Node | undefined {
  let current = node;
  while (
    current &&
    (Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isNonNullExpression(current) ||
      Node.isTypeAssertion(current))
  ) {
    current = current.getExpression();
  }
  return current;
}

/**
 * Funções que só "embrulham" outra função e devolvem algo equivalente a ela.
 * Uma lista explícita evita transformar `const dobro = lista.map(x => ...)` em função.
 */
const FUNCTION_WRAPPERS = new Set([
  'memo',
  'forwardRef',
  'observer',
  'defineComponent',
  'withRouter',
  'asyncHandler',
  'catchAsync',
  'debounce',
  'throttle',
  'once',
  'memoize',
  'useCallback',
]);

/** Para `memo(() => ...)` e afins, devolve a função embrulhada. */
export function wrappedFunction(call: Node): Node | undefined {
  if (!Node.isCallExpression(call)) return undefined;
  const callee = unwrap(call.getExpression());
  const name = Node.isIdentifier(callee)
    ? callee.getText()
    : Node.isPropertyAccessExpression(callee)
      ? callee.getName()
      : undefined;
  if (!name || !FUNCTION_WRAPPERS.has(name)) return undefined;
  return call
    .getArguments()
    .map((a) => unwrap(a))
    .find((a) => isFunctionLike(a));
}

const isFunctionLike = (n: Node | undefined) =>
  !!n && (Node.isArrowFunction(n) || Node.isFunctionExpression(n));

// ---------------------------------------------------------------------------
// Passo 1: entidades

function extractEntities(ctx: Ctx, file: DiscoveredFile, sf: SourceFile): void {
  const fileId = nodeId.file(file.relative);
  const rel = file.relative;
  const lang: Language = file.language;

  const addFunction = (
    name: string,
    node: Node,
    extra: Array<ts.Node | undefined>,
    meta: GraphNode['meta'] = {},
  ) =>
    addEntity(
      ctx,
      {
        id: nodeId.function(rel, name),
        kind: 'function',
        name,
        qualifiedName: name,
        location: rangeOf(rel, node),
        meta: { language: lang, ...meta },
      },
      fileId,
      [node.compilerNode, ...extra],
    );

  const addClass = (
    name: string,
    node: Node,
    extra: Array<ts.Node | undefined>,
    meta: GraphNode['meta'] = {},
  ) => {
    const classId = addEntity(
      ctx,
      {
        id: nodeId.class(rel, name),
        kind: 'class',
        name,
        qualifiedName: name,
        location: rangeOf(rel, node),
        meta: { language: lang, ...meta },
      },
      fileId,
      [node.compilerNode, ...extra],
    );
    if (Node.isClassDeclaration(node) || Node.isClassExpression(node)) {
      // `implements` como escrito no código (interfaces não viram nós; ver candidatos possíveis)
      const implemented = node.getImplements().map((t) => t.getExpression().getText());
      if (implemented.length) {
        const classNode = ctx.builder.getNode(classId)!;
        classNode.meta = { ...classNode.meta, implements: [...new Set(implemented)] };
      }
      extractMembers(ctx, rel, lang, name, classId, node);
    }
    return classId;
  };

  for (const statement of sf.getStatements()) {
    if (Node.isFunctionDeclaration(statement)) {
      if (!statement.hasBody()) continue; // sobrecargas e declarações ambientes
      const name = statement.getName() ?? 'default';
      addFunction(name, statement, [], {
        exported: statement.isExported(),
        defaultExport: statement.isDefaultExport(),
        async: statement.isAsync(),
      });
    } else if (Node.isClassDeclaration(statement)) {
      const name = statement.getName() ?? 'default';
      addClass(name, statement, [], {
        exported: statement.isExported(),
        defaultExport: statement.isDefaultExport(),
      });
    } else if (Node.isVariableStatement(statement)) {
      for (const decl of statement.getDeclarations()) {
        const nameNode = decl.getNameNode();
        if (!Node.isIdentifier(nameNode)) continue;
        const init = unwrap(decl.getInitializer());
        if (isFunctionLike(init)) {
          addFunction(nameNode.getText(), decl, [init!.compilerNode], {
            exported: statement.isExported(),
            async:
              Node.isArrowFunction(init) || Node.isFunctionExpression(init)
                ? init.isAsync()
                : false,
          });
        } else if (init && Node.isClassExpression(init)) {
          addClass(nameNode.getText(), init, [decl.compilerNode], {
            exported: statement.isExported(),
          });
        } else if (init && Node.isCallExpression(init)) {
          // função embrulhada: `const Card = memo(() => ...)`, `forwardRef(function Card() {...})`
          const inner = wrappedFunction(init);
          if (inner) {
            addFunction(nameNode.getText(), decl, [inner.compilerNode], {
              exported: statement.isExported(),
            });
          }
        }
      }
    } else if (Node.isExportAssignment(statement)) {
      const expr = unwrap(statement.getExpression());
      if (isFunctionLike(expr)) {
        addFunction('default', expr!, [statement.compilerNode], {
          exported: true,
          defaultExport: true,
        });
      } else if (expr && Node.isClassExpression(expr)) {
        addClass(expr.getName() ?? 'default', expr, [statement.compilerNode], {
          exported: true,
          defaultExport: true,
        });
      } else if (expr && Node.isCallExpression(expr)) {
        // `export default memo(function Card() {...})`
        const inner = wrappedFunction(expr);
        if (inner) {
          const ownName = Node.isFunctionExpression(inner) ? inner.getName() : undefined;
          addFunction(ownName ?? 'default', expr, [statement.compilerNode, inner.compilerNode], {
            exported: true,
            defaultExport: true,
          });
        }
      }
    } else if (Node.isExpressionStatement(statement)) {
      extractCommonJsExport(statement.getExpression(), addFunction, addClass);
    }
  }
}

/** `module.exports = function () {}`, `exports.foo = () => {}`, `module.exports.Bar = class {}`. */
function extractCommonJsExport(
  expression: Node,
  addFunction: (
    name: string,
    node: Node,
    extra: Array<ts.Node | undefined>,
    meta?: GraphNode['meta'],
  ) => string,
  addClass: (
    name: string,
    node: Node,
    extra: Array<ts.Node | undefined>,
    meta?: GraphNode['meta'],
  ) => string,
): void {
  if (
    !Node.isBinaryExpression(expression) ||
    expression.getOperatorToken().getKind() !== SyntaxKind.EqualsToken
  )
    return;
  const left = expression.getLeft();
  if (!Node.isPropertyAccessExpression(left)) return;
  const target = left.getText();
  let name: string | undefined;
  if (target === 'module.exports') name = undefined;
  else if (/^(module\.)?exports\.[\w$]+$/.test(target)) name = left.getName();
  else return;

  const right = unwrap(expression.getRight());
  const extra = [expression.compilerNode, left.compilerNode];
  if (isFunctionLike(right)) {
    const ownName = Node.isFunctionExpression(right!) ? right.getName() : undefined;
    addFunction(name ?? ownName ?? 'module.exports', right!, extra, {
      exported: true,
      defaultExport: !name,
    });
  } else if (right && Node.isClassExpression(right)) {
    addClass(name ?? right.getName() ?? 'module.exports', right, extra, {
      exported: true,
      defaultExport: !name,
    });
  }
}

function extractMembers(
  ctx: Ctx,
  rel: string,
  lang: Language,
  className: string,
  classId: string,
  cls: Node,
): void {
  if (!Node.isClassDeclaration(cls) && !Node.isClassExpression(cls)) return;
  for (const member of cls.getMembers()) {
    let name: string | undefined;
    let memberKind: NonNullable<GraphNode['meta']>['memberKind'];
    const extra: Array<ts.Node | undefined> = [];
    let isStatic = false;
    let isAsync = false;
    if (Node.isMethodDeclaration(member)) {
      if (!member.hasBody()) continue;
      name = member.getName();
      memberKind = 'method';
      isStatic = member.isStatic();
      isAsync = member.isAsync();
    } else if (Node.isConstructorDeclaration(member)) {
      if (!member.hasBody()) continue;
      name = 'constructor';
      memberKind = 'constructor';
    } else if (Node.isGetAccessorDeclaration(member)) {
      name = `get ${member.getName()}`;
      memberKind = 'getter';
      isStatic = member.isStatic();
    } else if (Node.isSetAccessorDeclaration(member)) {
      name = `set ${member.getName()}`;
      memberKind = 'setter';
      isStatic = member.isStatic();
    } else if (Node.isPropertyDeclaration(member)) {
      const init = unwrap(member.getInitializer());
      if (!isFunctionLike(init)) continue;
      name = member.getName();
      memberKind = 'property';
      isStatic = member.isStatic();
      extra.push(init!.compilerNode);
    }
    if (!name) continue;
    addEntity(
      ctx,
      {
        id: nodeId.method(rel, className, name),
        kind: 'method',
        name,
        qualifiedName: `${className}.${name}`,
        location: rangeOf(rel, member),
        meta: {
          language: lang,
          memberKind,
          ...(isStatic ? { static: true } : {}),
          ...(isAsync ? { async: true } : {}),
        },
      },
      classId,
      [member.compilerNode, ...extra],
    );
  }
}

// ---------------------------------------------------------------------------
// Passo 2: imports

interface ImportFound {
  specifier: string;
  node: Node;
  meta: EdgeMeta;
}

function collectImports(sf: SourceFile): { found: ImportFound[]; dynamic: Node[] } {
  const found: ImportFound[] = [];
  const dynamic: Node[] = [];

  for (const decl of sf.getImportDeclarations()) {
    const names: string[] = [];
    const def = decl.getDefaultImport();
    if (def) names.push('default');
    const ns = decl.getNamespaceImport();
    if (ns) names.push('*');
    const named = decl.getNamedImports();
    for (const n of named) names.push(n.getName());
    const typeOnly =
      decl.isTypeOnly() || (named.length > 0 && !def && !ns && named.every((n) => n.isTypeOnly()));
    found.push({
      specifier: decl.getModuleSpecifierValue(),
      node: decl,
      meta: { importKind: 'static', names, ...(typeOnly ? { typeOnly: true } : {}) },
    });
  }
  for (const decl of sf.getExportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue();
    if (!specifier) continue;
    const names = decl.isNamespaceExport() ? ['*'] : decl.getNamedExports().map((n) => n.getName());
    found.push({
      specifier,
      node: decl,
      meta: { importKind: 're-export', names, ...(decl.isTypeOnly() ? { typeOnly: true } : {}) },
    });
  }
  for (const decl of descendantsOfKind(sf, SyntaxKind.ImportEqualsDeclaration)) {
    const ref = decl.getModuleReference();
    if (Node.isExternalModuleReference(ref)) {
      const expr = ref.getExpression();
      if (expr && Node.isStringLiteral(expr)) {
        found.push({
          specifier: expr.getLiteralValue(),
          node: decl,
          meta: { importKind: 'require', names: [decl.getName()] },
        });
      }
    }
  }
  for (const call of descendantsOfKind(sf, SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const isDynamicImport = callee.getKind() === SyntaxKind.ImportKeyword;
    const isRequire = Node.isIdentifier(callee) && callee.getText() === 'require';
    if (!isDynamicImport && !isRequire) continue;
    const arg = call.getArguments()[0];
    if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
      found.push({
        specifier: arg.getLiteralValue(),
        node: call,
        meta: { importKind: isDynamicImport ? 'dynamic' : 'require' },
      });
    } else if (arg) {
      dynamic.push(call);
    }
  }
  return { found, dynamic };
}

export function addUnresolvedNode(
  ctx: Ctx,
  file: string,
  kind: 'import' | 'call' | 'extends',
  reference: string,
  reason: UnresolvedReason,
  at: Node | ts.Node,
  /** Implementações possíveis (chamadas por interface), já ordenadas. */
  candidates: string[] = [],
): string {
  const base = nodeId.unresolved(file, kind, reference);
  let id = base;
  if (kind === 'call') {
    // os candidatos são de cada chamada: o mesmo texto com candidatos diferentes (ex.:
    // `repo.save()` com `repo: UserRepo` e com `repo: OrderRepo`) vira outro nó (`~2`), ou
    // quem chama uma interface pareceria chamar as implementações da outra
    const key = candidates.join('\n');
    for (let i = 2; ; i++) {
      const existing = ctx.builder.getNode(id);
      if (!existing || (existing.meta?.candidates ?? []).join('\n') === key) break;
      id = `${base}~${i}`;
    }
  }
  if (!ctx.builder.hasNode(id)) {
    const fileId = nodeId.file(file);
    ctx.builder.addNode({
      id,
      kind: 'unresolved',
      name: reference,
      // não resolvidos de chamada/herança ficam dentro do arquivo; os de import ficam soltos
      ...(kind === 'import' ? {} : { parent: fileId }),
      location: rangeOf(file, at),
      meta: { reason, reference, ...(candidates.length ? { candidates } : {}) },
    });
    if (kind !== 'import') {
      ctx.builder.addEdge({
        kind: 'contains',
        source: fileId,
        target: id,
        resolution: 'resolved',
        discovery: 'static-ast',
      });
    }
  }
  return id;
}

function extractImports(ctx: Ctx, file: DiscoveredFile, sf: SourceFile): void {
  const fileId = nodeId.file(file.relative);
  const { found, dynamic } = collectImports(sf);

  for (const imp of found) {
    let target = ctx.resolver.resolve(imp.specifier, file.absolute);
    const evidence = evidenceAt(ctx, file.relative, imp.node);
    const meta: EdgeMeta = { specifier: imp.specifier, ...imp.meta };
    if (
      (target.kind === 'file' || target.kind === 'asset') &&
      !ctx.filesByAbs.has(target.absolute)
    ) {
      const source = sourceForDeclarationFile(ctx, target.absolute);
      if (source) {
        // pacote do workspace: o import aponta para o .d.ts compilado; ligamos ao código-fonte
        ctx.builder.addEdge({
          kind: 'imports',
          source: fileId,
          target: nodeId.file(source.relative),
          resolution: 'resolved',
          discovery: 'static-ast',
          evidence,
          meta: { ...meta, viaDeclaration: true },
        });
        continue;
      }
    }
    const bare = !imp.specifier.startsWith('.') && !path.isAbsolute(imp.specifier);
    // ('asset' vindo de especificador sem ponto é um alias de `paths`: `@/styles/x.css`)
    if (target.kind === 'file' && bare && !ctx.filesByAbs.has(target.absolute)) {
      // pacote do workspace sem código-fonte correspondente: tratamos como pacote
      const name = packageNameOf(imp.specifier);
      target = { kind: 'package', name, builtin: false, declared: true };
    }
    if (target.kind === 'file' || target.kind === 'asset') {
      const rel = toPosix(path.relative(ctx.root, target.absolute));
      const known = ctx.filesByAbs.get(target.absolute);
      const targetId = nodeId.file(known ? known.relative : rel);
      if (!ctx.builder.hasNode(targetId)) {
        // arquivo existente, mas fora da análise (css, json, .d.ts, pasta excluída...)
        const dir = path.posix.dirname(rel);
        const moduleId = ctx.builder.ensureModule(dir === '.' ? '' : dir);
        ctx.builder.addNode({
          id: targetId,
          kind: 'file',
          name: path.posix.basename(rel),
          qualifiedName: rel,
          parent: moduleId,
          meta: { analyzed: false },
        });
        ctx.builder.addEdge({
          kind: 'contains',
          source: moduleId,
          target: targetId,
          resolution: 'resolved',
          discovery: 'static-ast',
        });
      }
      ctx.builder.addEdge({
        kind: 'imports',
        source: fileId,
        target: targetId,
        resolution: 'resolved',
        discovery: 'static-ast',
        evidence,
        meta,
      });
    } else if (target.kind === 'package') {
      const targetId = nodeId.package(target.name);
      ctx.builder.addNode({
        id: targetId,
        kind: 'package',
        name: target.name,
        meta: {
          ...(target.builtin ? { builtin: true } : {}),
          declared: target.declared,
          ...(target.outsideRoot ? { outsideRoot: true } : {}),
        },
      });
      ctx.builder.addEdge({
        kind: 'imports',
        source: fileId,
        target: targetId,
        resolution: 'external',
        discovery: 'static-ast',
        evidence,
        meta,
      });
    } else {
      const targetId = addUnresolvedNode(
        ctx,
        file.relative,
        'import',
        imp.specifier,
        target.reason,
        imp.node,
      );
      ctx.builder.addEdge({
        kind: 'imports',
        source: fileId,
        target: targetId,
        resolution: 'unresolved',
        discovery: 'static-ast',
        evidence,
        meta,
      });
    }
  }

  for (const call of dynamic) {
    const text = call.getText().replace(/\s+/g, ' ');
    const reference = text.length > 60 ? `${text.slice(0, 59)}…` : text;
    const targetId = addUnresolvedNode(
      ctx,
      file.relative,
      'import',
      reference,
      'dynamic-import',
      call,
    );
    ctx.builder.addEdge({
      kind: 'imports',
      source: fileId,
      target: targetId,
      resolution: 'unresolved',
      discovery: 'static-ast',
      evidence: evidenceAt(ctx, file.relative, call),
      meta: { importKind: 'dynamic' },
    });
  }
}

// ---------------------------------------------------------------------------
// Passo 2: exports

function extractExports(ctx: Ctx, file: DiscoveredFile, sf: SourceFile): void {
  const fileId = nodeId.file(file.relative);
  // arquivos CommonJS não expõem o símbolo do módulo pela API pública; lemos o símbolo do binder
  const moduleSymbol =
    ctx.checker.getSymbolAtLocation(sf.compilerNode) ??
    (sf.compilerNode as unknown as { symbol?: ts.Symbol }).symbol;
  if (!moduleSymbol) return;
  let exports: ts.Symbol[];
  try {
    exports = ctx.checker.getExportsOfModule(moduleSymbol);
    // `module.exports = X` / `export = X`: getExportsOfModule devolve os membros de X, não o próprio X
    const exportEquals = moduleSymbol.exports?.get(ts.InternalSymbolName.ExportEquals);
    if (exportEquals && !exports.includes(exportEquals)) exports = [exportEquals, ...exports];
  } catch {
    return;
  }
  const displayName = (s: ts.Symbol) => (s.name === 'export=' ? 'module.exports' : s.name);
  const names = [...new Set(exports.map(displayName))].sort();
  const fileNode = ctx.builder.getNode(fileId);
  if (fileNode && names.length) fileNode.meta = { ...fileNode.meta, exportNames: names };

  for (const symbol of exports) {
    const name = displayName(symbol);
    const targets = resolveSymbolTargets(ctx, symbol);
    for (const target of targets) {
      if (target.kind !== 'entity') continue;
      const entity = ctx.builder.getNode(target.id);
      if (!entity) continue;
      const sameFile = entity.location?.file === file.relative;
      if (sameFile) {
        const isDefault = name === 'default' || name === 'module.exports';
        entity.meta = {
          ...entity.meta,
          exported: true,
          ...(isDefault ? { defaultExport: true } : {}),
        };
      }
      const decl = symbol.declarations?.[0];
      const evidence =
        (!sameFile && exportStatementEvidence(ctx, file, sf, name)) ||
        (decl && toPosix(decl.getSourceFile().fileName) === file.absolute
          ? evidenceAt(ctx, file.relative, exportKeywordOf(decl) ?? decl)
          : undefined);
      ctx.builder.addEdge({
        kind: 'exports',
        source: fileId,
        target: target.id,
        resolution: 'resolved',
        discovery: 'static-typecheck',
        ...(evidence ? { evidence } : {}),
        meta: { exportedAs: name, ...(sameFile ? {} : { reexport: true }) },
      });
    }
  }
}

/**
 * A palavra `export` de uma declaração. Numa classe com decorators (`@Module({...})` em várias
 * linhas antes de `export class AppModule`), a declaração começa no decorator, numa linha que
 * não contém o export.
 */
function exportKeywordOf(decl: ts.Node): ts.Node | undefined {
  if (!ts.canHaveModifiers(decl)) return undefined;
  return ts.getModifiers(decl)?.find((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** Evidência do `export ... from` que reexporta um nome. */
function exportStatementEvidence(
  ctx: Ctx,
  file: DiscoveredFile,
  sf: SourceFile,
  name: string,
): Evidence | undefined {
  const reexports = sf.getExportDeclarations().filter((d) => !!d.getModuleSpecifierValue());
  // primeiro os nomes explícitos: `export { x as y } from`
  for (const decl of reexports) {
    if (decl.getNamedExports().some((n) => (n.getAliasNode()?.getText() ?? n.getName()) === name))
      return evidenceAt(ctx, file.relative, decl);
  }
  // depois `export * from`: o módulo de origem precisa realmente exportar o nome
  for (const decl of reexports) {
    if (!decl.isNamespaceExport()) continue;
    const specifier = decl.getModuleSpecifier();
    const moduleSymbol = specifier && ctx.checker.getSymbolAtLocation(specifier.compilerNode);
    if (!moduleSymbol) continue;
    try {
      if (ctx.checker.getExportsOfModule(moduleSymbol).some((s) => s.name === name))
        return evidenceAt(ctx, file.relative, decl);
    } catch {
      // módulo sem exports conhecidos
    }
  }
  return undefined;
}

/** Encontra a entidade que corresponde exatamente a uma declaração. */
export function entityForDeclaration(ctx: Ctx, decl: ts.Node): string | undefined {
  const direct = ctx.entities.get(decl);
  if (direct) return direct;
  // `exports.foo = ...`: a declaração pode ser o acesso à propriedade dentro da atribuição
  if (ts.isPropertyAccessExpression(decl) && decl.parent && ts.isBinaryExpression(decl.parent)) {
    return ctx.entities.get(decl.parent);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Passo 2: chamadas

export type SymbolTarget =
  /** `mapped`: a ligação passou por um .d.ts compilado mapeado de volta para o código-fonte. */
  | { kind: 'entity'; id: string; mapped?: boolean }
  | { kind: 'external' }
  /** função declarada dentro de outra (escopo local), que não vira nó no grafo */
  | { kind: 'local' }
  /** declarada em arquivo do projeto que não foi analisado */
  | { kind: 'not-analyzed' }
  | { kind: 'indirect' }
  | { kind: 'missing' };

/** Resolve um símbolo até entidades do projeto, seguindo aliases de import/require. */
export function resolveSymbolTargets(
  ctx: Ctx,
  symbol: ts.Symbol | undefined,
  depth = 0,
): SymbolTarget[] {
  if (!symbol || depth > 4) return [{ kind: 'missing' }];
  let resolved = symbol;
  const aliasDecl = resolved.flags & ts.SymbolFlags.Alias ? resolved.declarations?.[0] : undefined;
  if (aliasDecl) {
    try {
      resolved = ctx.checker.getAliasedSymbol(resolved);
    } catch {
      return [{ kind: 'missing' }];
    }
  }
  const decls = resolved.declarations ?? [];
  if (!decls.length) {
    // import de um pacote sem tipos instalados (ex.: `node:fs` sem @types/node): é externo, não ausente
    const specifier = aliasDecl && moduleSpecifierOfAlias(aliasDecl);
    if (
      specifier &&
      ctx.resolver.resolve(specifier, toPosix(aliasDecl.getSourceFile().fileName)).kind ===
        'package'
    ) {
      return [{ kind: 'external' }];
    }
    return [{ kind: 'missing' }];
  }

  const targets: SymbolTarget[] = [];
  for (const decl of decls) {
    const entity = entityForDeclaration(ctx, decl);
    if (entity) {
      targets.push({ kind: 'entity', id: entity });
      continue;
    }
    const declFile = toPosix(decl.getSourceFile().fileName);
    if (!ctx.filesByAbs.has(declFile)) {
      const mapped = entityFromDeclarationFile(ctx, decl, declFile);
      if (mapped) targets.push({ kind: 'entity', id: mapped, mapped: true });
      // declarado em um arquivo do projeto que ficou fora da análise (excluído, grande demais...)
      else if (isInsideProject(ctx, declFile)) targets.push({ kind: 'not-analyzed' });
      else targets.push({ kind: 'external' });
      continue;
    }
    if (ts.isShorthandPropertyAssignment(decl)) {
      targets.push(
        ...resolveSymbolTargets(
          ctx,
          ctx.checker.getShorthandAssignmentValueSymbol(decl),
          depth + 1,
        ),
      );
      continue;
    }
    if (
      ts.isPropertyAssignment(decl) &&
      ts.isIdentifier(decl.initializer) &&
      isConstObjectLiteralProperty(decl)
    ) {
      targets.push(
        ...resolveSymbolTargets(ctx, ctx.checker.getSymbolAtLocation(decl.initializer), depth + 1),
      );
      continue;
    }
    if (
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      ts.isIdentifier(decl.initializer) &&
      isConstDeclaration(decl)
    ) {
      // const alias = outraFuncao;
      targets.push(
        ...resolveSymbolTargets(ctx, ctx.checker.getSymbolAtLocation(decl.initializer), depth + 1),
      );
      continue;
    }
    const reexported = commonJsReexport(ctx, decl, depth);
    if (reexported) {
      // `module.exports = require('./lib/app')`: o valor exportado é o do módulo exigido
      targets.push(...reexported);
      continue;
    }
    if (isLocalFunction(decl)) {
      targets.push({ kind: 'local' });
      continue;
    }
    if (producedByExternalCall(ctx, decl, depth)) {
      // ex.: `const [x, setX] = useState()` — a função vem de uma biblioteca
      targets.push({ kind: 'external' });
      continue;
    }
    // parâmetros, propriedades, assinaturas de interface: o alvo real só existe em execução
    targets.push({ kind: 'indirect' });
  }
  return targets;
}

const isFunctionExpression = (n: ts.Node): boolean =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n);

export function unwrapExpression(n: ts.Expression): ts.Expression {
  let current = n;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isInsideProject(ctx: Ctx, absolute: string): boolean {
  // node_modules testado no caminho relativo: a raiz analisada pode estar dentro de um node_modules
  return (
    absolute.startsWith(`${ctx.root}/`) &&
    !absolute.slice(ctx.root.length).includes('/node_modules/')
  );
}

/** `const x = ...` (um `let`/`var` pode ser reatribuído, então o alvo não é garantido). */
function isConstDeclaration(decl: ts.VariableDeclaration): boolean {
  return (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0;
}

/**
 * Reexportação CommonJS: `module.exports = require('./lib/app')` (padrão do index.js de muitos
 * pacotes) e `exports.static = require('serve-static')`. O valor é o `module.exports` do módulo
 * exigido; um pacote sem tipos instalados é externo. Só com especificador literal.
 */
function commonJsReexport(ctx: Ctx, decl: ts.Node, depth: number): SymbolTarget[] | undefined {
  let assignment: ts.BinaryExpression | undefined;
  if (ts.isBinaryExpression(decl) && isModuleExports(decl.left)) assignment = decl;
  else if (
    ts.isPropertyAccessExpression(decl) &&
    ts.isBinaryExpression(decl.parent) &&
    decl.parent.left === decl &&
    (isModuleExports(decl.expression) ||
      (ts.isIdentifier(decl.expression) && decl.expression.text === 'exports'))
  )
    assignment = decl.parent;
  if (!assignment || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
  const right = unwrapExpression(assignment.right);
  if (
    !ts.isCallExpression(right) ||
    !ts.isIdentifier(right.expression) ||
    right.expression.text !== 'require' ||
    right.arguments.length !== 1 ||
    !ts.isStringLiteralLike(right.arguments[0]!)
  )
    return undefined;
  const specifier = right.arguments[0]!;
  const exported = ctx.checker
    .getSymbolAtLocation(specifier)
    ?.exports?.get(ts.InternalSymbolName.ExportEquals);
  if (exported) return resolveSymbolTargets(ctx, exported, depth + 1);
  const target = ctx.resolver.resolve(specifier.text, toPosix(decl.getSourceFile().fileName));
  return target.kind === 'package' ? [{ kind: 'external' }] : undefined;
}

/** `module.exports` */
function isModuleExports(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'module' &&
    node.name.text === 'exports'
  );
}

/** Propriedade de um objeto literal atribuído a `const` ou a `module.exports`. */
function isConstObjectLiteralProperty(decl: ts.PropertyAssignment): boolean {
  const literal = decl.parent;
  const owner = literal?.parent;
  if (!owner) return false;
  if (ts.isVariableDeclaration(owner)) return isConstDeclaration(owner);
  return ts.isBinaryExpression(owner) || ts.isExportAssignment(owner);
}

/** Função declarada dentro de outra: `function aux() {}`, `const aux = () => {}`, `const f = useCallback(() => {})`. */
function isLocalFunction(decl: ts.Node): boolean {
  if (!isInsideFunction(decl)) return false;
  if (ts.isFunctionDeclaration(decl)) return !!decl.body;
  if (!ts.isVariableDeclaration(decl) || !decl.initializer) return false;
  const init = unwrapExpression(decl.initializer);
  return (
    isFunctionExpression(init) ||
    (ts.isCallExpression(init) && init.arguments.some(isFunctionExpression))
  );
}

function isInsideFunction(node: ts.Node): boolean {
  for (let cur = node.parent; cur; cur = cur.parent) if (ts.isFunctionLike(cur)) return true;
  return false;
}

/** A variável recebe o resultado de uma chamada a código externo (ex.: `useState`, `express()`). */
function producedByExternalCall(ctx: Ctx, decl: ts.Node, depth: number): boolean {
  let current: ts.Node = decl;
  while (
    ts.isBindingElement(current) ||
    ts.isObjectBindingPattern(current) ||
    ts.isArrayBindingPattern(current)
  ) {
    current = current.parent;
  }
  if (!ts.isVariableDeclaration(current) || !current.initializer) return false;
  const init = unwrapExpression(current.initializer);
  if (!ts.isCallExpression(init)) return false;
  const callee = unwrapExpression(init.expression);
  const nameNode = ts.isPropertyAccessExpression(callee)
    ? callee.name
    : ts.isIdentifier(callee)
      ? callee
      : undefined;
  if (!nameNode) return false;
  const targets = resolveSymbolTargets(ctx, ctx.checker.getSymbolAtLocation(nameNode), depth + 1);
  return targets.length > 0 && targets.every((t) => t.kind === 'external');
}

const DECLARATION_FILE = /\.d\.([mc]?)ts$/;
const BUILD_DIRS = /\/(dist|build|lib|out|types)\//;
const SOURCE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const declarationSourceCache = new WeakMap<Ctx, Map<string, DiscoveredFile | null>>();

/**
 * Em monorepos, imports entre pacotes do workspace costumam apontar para o `.d.ts` compilado
 * (ex.: `packages/core/dist/index.d.ts`). Quando existe o fonte correspondente na mesma pasta
 * do pacote (`packages/core/src/index.ts`), ligamos ao fonte e marcamos a relação com `viaDeclaration`.
 */
export function sourceForDeclarationFile(ctx: Ctx, absolute: string): DiscoveredFile | undefined {
  if (!DECLARATION_FILE.test(absolute) || !isInsideProject(ctx, absolute)) return undefined;
  let cache = declarationSourceCache.get(ctx);
  if (!cache) declarationSourceCache.set(ctx, (cache = new Map()));
  if (cache.has(absolute)) return cache.get(absolute) ?? undefined;
  const stem = absolute.replace(DECLARATION_FILE, '');
  // .d.ts escrito à mão ao lado do código (ex.: lib/foo.js + lib/foo.d.ts)
  let found = SOURCE_EXTS.map((ext) => ctx.filesByAbs.get(stem + ext)).find((f) => !!f);
  if (!found && BUILD_DIRS.test(stem)) {
    const candidates = [
      stem.replace(/\/(dist|build|lib|out|types)\/(?!.*\/(dist|build|lib|out|types)\/)/, '/src/'),
    ];
    for (const candidate of candidates) {
      for (const ext of SOURCE_EXTS) {
        found = ctx.filesByAbs.get(candidate + ext);
        if (found) break;
      }
      if (found) break;
    }
  }
  cache.set(absolute, found ?? null);
  return found;
}

function entityFromDeclarationFile(ctx: Ctx, decl: ts.Node, declFile: string): string | undefined {
  const source = sourceForDeclarationFile(ctx, declFile);
  if (!source) return undefined;
  const rel = source.relative;
  const nameOf = (n: ts.Node & { name?: ts.Node }) =>
    n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) ? n.name.text : undefined;
  const candidates: string[] = [];
  if (ts.isFunctionDeclaration(decl))
    candidates.push(nodeId.function(rel, nameOf(decl) ?? 'default'));
  else if (ts.isClassDeclaration(decl))
    candidates.push(nodeId.class(rel, nameOf(decl) ?? 'default'));
  else if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
    candidates.push(nodeId.function(rel, decl.name.text), nodeId.class(rel, decl.name.text));
  } else if (ts.isClassDeclaration(decl.parent) && decl.parent.name) {
    const cls = decl.parent.name.text;
    if (ts.isConstructorDeclaration(decl)) candidates.push(nodeId.method(rel, cls, 'constructor'));
    else if (ts.isGetAccessorDeclaration(decl))
      candidates.push(nodeId.method(rel, cls, `get ${nameOf(decl)}`));
    else if (ts.isSetAccessorDeclaration(decl))
      candidates.push(nodeId.method(rel, cls, `set ${nameOf(decl)}`));
    else if (ts.isMethodDeclaration(decl) || ts.isPropertyDeclaration(decl))
      candidates.push(nodeId.method(rel, cls, nameOf(decl) ?? ''));
    // membros com o mesmo nome (estático e de instância) recebem sufixo ~2, ~3...:
    // escolhemos pelo modificador static, e desistimos se continuar ambíguo
    const base = candidates[0];
    if (base) {
      const isStatic =
        (ts.getCombinedModifierFlags(decl as ts.Declaration) & ts.ModifierFlags.Static) !== 0;
      const sameName = [base, `${base}~2`, `${base}~3`, `${base}~4`].filter((id) =>
        ctx.builder.hasNode(id),
      );
      const matching = sameName.filter(
        (id) => !!ctx.builder.getNode(id)?.meta?.static === isStatic,
      );
      return matching.length === 1 ? matching[0] : undefined;
    }
  }
  return candidates.find((id) => ctx.builder.hasNode(id));
}

/** Especificador do módulo de onde vem um alias (`import { x } from 'm'`, `const { x } = require('m')`). */
export function moduleSpecifierOfAlias(decl: ts.Node): string | undefined {
  let current: ts.Node | undefined = decl;
  for (let i = 0; current && i < 6; i++, current = current.parent) {
    if (ts.isImportDeclaration(current) && ts.isStringLiteral(current.moduleSpecifier))
      return current.moduleSpecifier.text;
    if (
      ts.isImportEqualsDeclaration(current) &&
      ts.isExternalModuleReference(current.moduleReference)
    ) {
      const expr = current.moduleReference.expression;
      return ts.isStringLiteral(expr) ? expr.text : undefined;
    }
    if (ts.isVariableDeclaration(current) && current.initializer) {
      const init = current.initializer;
      if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === 'require'
      ) {
        const arg = init.arguments[0];
        return arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
      }
      return undefined;
    }
  }
  return undefined;
}

export function unresolvedReason(targets: SymbolTarget[]): UnresolvedReason {
  if (targets.some((t) => t.kind === 'not-analyzed')) return 'not-analyzed';
  if (targets.some((t) => t.kind === 'indirect')) return 'indirect-call';
  return 'symbol-not-found';
}

/** Entidade mais próxima que envolve um nó (ou o próprio arquivo, para código no topo). */
function enclosingEntity(ctx: Ctx, node: ts.Node, fileId: string): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    const id = ctx.entities.get(current);
    if (id) return id;
    current = current.parent;
  }
  return fileId;
}

function extractCalls(ctx: Ctx, file: DiscoveredFile, sf: SourceFile): void {
  const fileId = nodeId.file(file.relative);
  const calls = [
    ...descendantsOfKind(sf, SyntaxKind.CallExpression),
    ...descendantsOfKind(sf, SyntaxKind.NewExpression),
  ];

  for (const call of calls) {
    const isNew = Node.isNewExpression(call);
    const raw = call.getExpression();
    if (raw.getKind() === SyntaxKind.ImportKeyword) continue;
    if (raw.getKind() === SyntaxKind.SuperKeyword) {
      if (Node.isCallExpression(call)) extractSuperCall(ctx, file, call, fileId);
      continue;
    }
    if (Node.isIdentifier(raw) && raw.getText() === 'require') continue;
    const callee = unwrap(raw)!;

    let nameNode: Node | undefined;
    let reference: string;
    let receiverIsThis = false;
    if (Node.isIdentifier(callee)) {
      nameNode = callee;
      reference = callee.getText();
    } else if (Node.isPropertyAccessExpression(callee)) {
      nameNode = callee.getNameNode();
      const receiver = callee.getExpression();
      receiverIsThis = receiver.getKind() === SyntaxKind.ThisKeyword;
      reference = receiverIsThis ? `this.${callee.getName()}` : referenceText(callee.compilerNode);
    } else if (Node.isElementAccessExpression(callee)) {
      ctx.counters.computedCalls++;
      continue;
    } else {
      continue; // IIFE, chamada do resultado de outra chamada etc.
    }

    const sourceId = enclosingEntity(ctx, call.compilerNode, fileId);
    const symbol = ctx.checker.getSymbolAtLocation(nameNode.compilerNode);
    const evidence = evidenceAt(ctx, file.relative, call);
    const meta: EdgeMeta = { callKind: isNew ? 'new' : 'call' };

    if (!symbol) {
      if (Node.isIdentifier(callee) || receiverIsThis) {
        const target = addUnresolvedNode(
          ctx,
          file.relative,
          'call',
          reference,
          'symbol-not-found',
          call,
        );
        ctx.builder.addEdge({
          kind: 'calls',
          source: sourceId,
          target,
          resolution: 'unresolved',
          discovery: 'static-ast',
          evidence,
          meta,
        });
      } else {
        ctx.counters.unknownReceiverCalls++;
      }
      continue;
    }

    const targets = resolveSymbolTargets(ctx, symbol);
    const entities = targets.filter(
      (t): t is Extract<SymbolTarget, { kind: 'entity' }> => t.kind === 'entity',
    );
    const indirect = targets.some((t) => t.kind === 'indirect')
      ? implementationsOf(ctx).indirectTargets(nameNode.compilerNode, symbol)
      : undefined;
    const indirectEdge = (candidates: string[], reason: UnresolvedReason) => {
      const target = addUnresolvedNode(
        ctx,
        file.relative,
        'call',
        reference,
        reason,
        call,
        candidates,
      );
      ctx.builder.addEdge({
        kind: 'calls',
        source: sourceId,
        target,
        resolution: 'unresolved',
        discovery: 'static-typecheck',
        evidence,
        meta,
      });
    };
    if (entities.length || targets.some((t) => t.kind === 'external')) {
      for (const target of entities) {
        ctx.builder.addEdge({
          kind: 'calls',
          source: sourceId,
          target: target.id,
          resolution: 'resolved',
          discovery: 'static-typecheck',
          evidence,
          meta: { ...meta, ...(target.mapped ? { viaDeclaration: true } : {}) },
        });
      }
      if (!entities.length) ctx.counters.externalCallsSkipped++;
      // receptor de tipo união (`r: UserRepo | SqlRepo`): a parte da interface (ou do método
      // abstrato) continua não resolvida, com as implementações possíveis
      if (indirect) indirectEdge(indirect.candidates, 'indirect-call');
      continue;
    }
    if (targets.every((t) => t.kind === 'local')) {
      ctx.counters.localCalls++;
      continue;
    }
    const reason = unresolvedReason(targets);
    // em JS sem tipos, `obj.metodo()` sem declaração conhecida é só ruído: contamos e seguimos
    if (reason === 'symbol-not-found' && !Node.isIdentifier(callee) && !receiverIsThis) {
      ctx.counters.unknownReceiverCalls++;
      continue;
    }
    indirectEdge(reason === 'indirect-call' ? (indirect?.candidates ?? []) : [], reason);
  }
}

const implementationIndexes = new WeakMap<Ctx, ImplementationIndex>();

function implementationsOf(ctx: Ctx): ImplementationIndex {
  let index = implementationIndexes.get(ctx);
  if (!index) implementationIndexes.set(ctx, (index = new ImplementationIndex(ctx)));
  return index;
}

/**
 * `super(...)` no construtor de uma subclasse: liga ao construtor que o verificador de tipos
 * escolhe (o da classe base ou, se ela não declara um, o herdado de mais acima). Sem nenhum
 * construtor declarado, liga à própria classe base, como `new Base()`.
 */
function extractSuperCall(
  ctx: Ctx,
  file: DiscoveredFile,
  call: Node & { compilerNode: ts.CallExpression },
  fileId: string,
): void {
  let declaration: ts.Declaration | undefined;
  try {
    declaration = ctx.checker.getResolvedSignature(call.compilerNode)?.getDeclaration();
  } catch {
    declaration = undefined;
  }
  let targets: SymbolTarget[] = [];
  if (declaration && !ts.isJSDocSignature(declaration)) {
    const symbol = (declaration as unknown as { symbol?: ts.Symbol }).symbol;
    targets = resolveSymbolTargets(ctx, symbol);
  }
  if (!targets.some((t) => t.kind === 'entity' || t.kind === 'external')) {
    // construtor implícito: a classe base é o alvo (se estiver no projeto)
    const cls = call.getFirstAncestor(
      (n) => Node.isClassDeclaration(n) || Node.isClassExpression(n),
    );
    const base =
      cls && (Node.isClassDeclaration(cls) || Node.isClassExpression(cls))
        ? cls.getExtends()
        : undefined;
    if (!base) return;
    const expr = unwrap(base.getExpression())!;
    const nameNode = Node.isPropertyAccessExpression(expr) ? expr.getNameNode() : expr;
    targets = resolveSymbolTargets(ctx, ctx.checker.getSymbolAtLocation(nameNode.compilerNode));
  }
  const entities = targets.filter(
    (t): t is Extract<SymbolTarget, { kind: 'entity' }> => t.kind === 'entity',
  );
  if (!entities.length) {
    // classe base externa (ex.: `extends Error`); base desconhecida já aparece em `extends`
    if (targets.some((t) => t.kind === 'external')) ctx.counters.externalCallsSkipped++;
    return;
  }
  const sourceId = enclosingEntity(ctx, call.compilerNode, fileId);
  const evidence = evidenceAt(ctx, file.relative, call);
  for (const target of entities) {
    ctx.builder.addEdge({
      kind: 'calls',
      source: sourceId,
      target: target.id,
      resolution: 'resolved',
      discovery: 'static-typecheck',
      evidence,
      meta: { callKind: 'call', ...(target.mapped ? { viaDeclaration: true } : {}) },
    });
  }
}

/** Uso de componentes JSX (`<Card />`) é registrado como chamada do tipo `jsx`. */
function extractJsxUsages(ctx: Ctx, file: DiscoveredFile, sf: SourceFile): void {
  const fileId = nodeId.file(file.relative);
  const elements = [
    ...descendantsOfKind(sf, SyntaxKind.JsxOpeningElement),
    ...descendantsOfKind(sf, SyntaxKind.JsxSelfClosingElement),
  ];
  for (const element of elements) {
    const tag = element.getTagNameNode();
    const text = tag.getText();
    // tags minúsculas são elementos HTML nativos (div, span...)
    if (!/^[A-Z]/.test(text) && !text.includes('.')) continue;
    const nameNode = Node.isPropertyAccessExpression(tag) ? tag.getNameNode() : tag;
    const sourceId = enclosingEntity(ctx, element.compilerNode, fileId);
    const evidence = evidenceAt(ctx, file.relative, element);
    const meta: EdgeMeta = { callKind: 'jsx' };
    const targets = resolveSymbolTargets(
      ctx,
      ctx.checker.getSymbolAtLocation(nameNode.compilerNode),
    );
    const entities = [
      ...new Set(targets.filter((t) => t.kind === 'entity').map((t) => (t as { id: string }).id)),
    ];
    if (entities.length) {
      for (const target of entities)
        ctx.builder.addEdge({
          kind: 'calls',
          source: sourceId,
          target,
          resolution: 'resolved',
          discovery: 'static-typecheck',
          evidence,
          meta,
        });
    } else if (targets.some((t) => t.kind === 'external')) {
      ctx.counters.externalCallsSkipped++;
    } else if (targets.every((t) => t.kind === 'local')) {
      ctx.counters.localCalls++;
    } else {
      const reason = unresolvedReason(targets);
      const target = addUnresolvedNode(ctx, file.relative, 'call', `<${text}>`, reason, element);
      ctx.builder.addEdge({
        kind: 'calls',
        source: sourceId,
        target,
        resolution: 'unresolved',
        discovery: 'static-typecheck',
        evidence,
        meta,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Passo 2: herança

function extractHeritage(ctx: Ctx, file: DiscoveredFile, sf: SourceFile): void {
  const classes = [
    ...descendantsOfKind(sf, SyntaxKind.ClassDeclaration),
    ...descendantsOfKind(sf, SyntaxKind.ClassExpression),
  ];
  for (const cls of classes) {
    const classId = ctx.entities.get(cls.compilerNode);
    if (!classId) continue;
    const base = cls.getExtends();
    if (!base) continue;
    const expr = unwrap(base.getExpression())!;
    const nameNode = Node.isPropertyAccessExpression(expr) ? expr.getNameNode() : expr;
    const targets = resolveSymbolTargets(
      ctx,
      ctx.checker.getSymbolAtLocation(nameNode.compilerNode),
    );
    const evidence = evidenceAt(ctx, file.relative, base);
    const entities = targets.filter(
      (t): t is { kind: 'entity'; id: string } => t.kind === 'entity',
    );
    if (entities.length) {
      for (const t of entities)
        ctx.builder.addEdge({
          kind: 'extends',
          source: classId,
          target: t.id,
          resolution: 'resolved',
          discovery: 'static-typecheck',
          evidence,
        });
    } else if (!targets.some((t) => t.kind === 'external')) {
      const target = addUnresolvedNode(
        ctx,
        file.relative,
        'extends',
        expr.getText(),
        'unknown-base-class',
        base,
      );
      ctx.builder.addEdge({
        kind: 'extends',
        source: classId,
        target,
        resolution: 'unresolved',
        discovery: 'static-typecheck',
        evidence,
      });
    }
  }
}
