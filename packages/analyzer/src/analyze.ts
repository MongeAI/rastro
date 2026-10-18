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
import { loadCompilerOptions, ModuleResolver, packageNameOf } from './resolve.js';
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
  const started = performance.now();
  const progress = (event: ProgressEvent) => options.onProgress?.(progressMessage(event), event);

  progress({ code: 'discovering' });
  const discovered = discoverFiles(rootInput, options);
  const { root } = discovered;
  progress({ code: 'discovered', files: discovered.files.length });

  const config = loadCompilerOptions(root);
  const project = new Project({
    compilerOptions: config.options,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });
  // o parse acontece aqui: um arquivo extremo (aninhamento profundo, sem permissão de leitura)
  // vira um aviso e sai da análise, em vez de derrubar tudo
  const readable: DiscoveredFile[] = [];
  for (const file of discovered.files) {
    try {
      project.addSourceFileAtPath(file.absolute);
      readable.push(file);
    } catch (err) {
      discovered.diagnostics.push({
        level: 'warning',
        code: 'parse-failed',
        message: `Arquivo ignorado: não foi possível ler ou interpretar (${describeError(err)}).`,
        file: file.relative,
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
  const ctx: Ctx = {
    root,
    builder: new GraphBuilder(),
    resolver: new ModuleResolver(root, config.options, config.scopes),
    checker: program.getTypeChecker(),
    filesByAbs: new Map(discovered.files.map((f) => [f.absolute, f])),
    entities: new Map(),
    lines: new Map(),
    diagnostics: [...discovered.diagnostics, ...config.diagnostics],
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
    safely(ctx, file, 'entidades', () => extractEntities(ctx, file, sf));
    routes.prepare(file, sf);
    for (const diag of program.getSyntacticDiagnostics(sf.compilerNode)) {
      if (syntaxErrors++ >= MAX_SYNTAX_DIAGNOSTICS) break;
      const line =
        diag.start !== undefined
          ? sf.compilerNode.getLineAndCharacterOfPosition(diag.start).line + 1
          : undefined;
      ctx.diagnostics.push({
        level: 'warning',
        code: 'syntax-error',
        message: `Erro de sintaxe: ${ts.flattenDiagnosticMessageText(diag.messageText, ' ')}`,
        file: file.relative,
        ...(line ? { line } : {}),
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
    ctx.diagnostics.push({
      level: 'warning',
      code: 'analysis-failed',
      message: `Não foi possível compor os caminhos completos das rotas: ${describeError(err)}.`,
    });
  }

  // Passo 2: relações (imports, exports, chamadas, herança)
  progress({ code: 'resolving' });
  for (const [file, sf] of sourceFiles) {
    safely(ctx, file, 'imports', () => extractImports(ctx, file, sf));
    safely(ctx, file, 'exports', () => extractExports(ctx, file, sf));
    safely(ctx, file, 'chamadas', () => extractCalls(ctx, file, sf));
    safely(ctx, file, 'JSX', () => extractJsxUsages(ctx, file, sf));
    safely(ctx, file, 'herança', () => extractHeritage(ctx, file, sf));
    release(sf);
  }
  routes.afterCalls();

  countMentions(ctx);

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
      ...(config.configFile ? { tsconfig: config.configFile } : {}),
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
    });
  }
  progress({ code: 'done', durationMs: graph.stats.durationMs });
  return graph;
}

export type AnalyzerContext = Ctx;

/**
 * Executa uma etapa da análise de um arquivo sem derrubar a análise inteira:
 * arquivos patológicos (ex.: expressões aninhadas milhares de vezes) viram um aviso.
 */
export function safely(ctx: Ctx, file: DiscoveredFile, step: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    const reason = describeError(err);
    ctx.diagnostics.push({
      level: 'warning',
      code: 'analysis-failed',
      message: `Parte da análise (${step}) falhou neste arquivo: ${reason}. As relações dele podem estar incompletas.`,
      file: file.relative,
    });
  }
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof RangeError && /call stack/i.test(message))
    return 'estrutura aninhada demais para analisar';
  if ((err as NodeJS.ErrnoException)?.code === 'EACCES') return 'sem permissão de leitura';
  return message;
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
 * Libera os objetos do ts-morph de um arquivo já processado. O grafo guarda só nós do
 * compilador, então os "wrappers" podem ser recriados sob demanda; em projetos grandes isso
 * evita manter milhões de objetos vivos até o fim.
 */
function release(sf: SourceFile): void {
  descendantsCache.delete(sf);
  sf.forgetDescendants();
}

const descendantsCache = new WeakMap<SourceFile, Map<SyntaxKind, Node[]>>();

/** `getDescendantsOfKind` com cache por arquivo (cada tipo é buscado uma vez só). */
export function descendantsOfKind<K extends SyntaxKind>(
  sf: SourceFile,
  kind: K,
): KindToNodeMappings[K][] {
  let byKind = descendantsCache.get(sf);
  if (!byKind) descendantsCache.set(sf, (byKind = new Map()));
  let nodes = byKind.get(kind);
  if (!nodes) byKind.set(kind, (nodes = sf.getDescendantsOfKind(kind)));
  return nodes as KindToNodeMappings[K][];
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

export function rangeOf(file: string, node: Node | ts.Node): SourceRange {
  const compiler = node instanceof Node ? node.compilerNode : node;
  const sf = compiler.getSourceFile();
  const start = sf.getLineAndCharacterOfPosition(compiler.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(compiler.getEnd());
  return {
    file,
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
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
    if (Node.isClassDeclaration(node) || Node.isClassExpression(node))
      extractMembers(ctx, rel, lang, name, classId, node);
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
): string {
  const id = nodeId.unresolved(file, kind, reference);
  if (!ctx.builder.hasNode(id)) {
    const fileId = nodeId.file(file);
    ctx.builder.addNode({
      id,
      kind: 'unresolved',
      name: reference,
      // não resolvidos de chamada/herança ficam dentro do arquivo; os de import ficam soltos
      ...(kind === 'import' ? {} : { parent: fileId }),
      location: rangeOf(file, at),
      meta: { reason, reference },
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
    if (
      (target.kind === 'file' || target.kind === 'asset') &&
      bare &&
      !ctx.filesByAbs.has(target.absolute)
    ) {
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
          ? evidenceAt(ctx, file.relative, decl)
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
function entityForDeclaration(ctx: Ctx, decl: ts.Node): string | undefined {
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
    if (raw.getKind() === SyntaxKind.ImportKeyword || raw.getKind() === SyntaxKind.SuperKeyword)
      continue;
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
      reference = receiverIsThis
        ? `this.${callee.getName()}`
        : callee.getText().replace(/\s+/g, '');
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
    if (entities.length) {
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
      continue;
    }
    if (targets.some((t) => t.kind === 'external')) {
      ctx.counters.externalCallsSkipped++;
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
    const target = addUnresolvedNode(ctx, file.relative, 'call', reference, reason, call);
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
