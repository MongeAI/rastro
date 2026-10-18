import fs from 'node:fs';
import path from 'node:path';
import { ts, type SourceFile } from 'ts-morph';
import { toPosix, type DiscoveredFile } from '../discover.js';
import { unwrapExpression } from '../analyze.js';
import { addRoute, linkHandlerSymbol, type RouteState } from './common.js';

const HTTP_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'];
/** `pageExtensions` padrão do Next.js. */
const PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js'];
const ROUTE_EXTENSIONS = ['ts', 'js'];
const PAGES_SPECIAL = new Set(['_app', '_document', '_error']);
const NEXT_CONFIGS = [
  'next.config.js',
  'next.config.mjs',
  'next.config.cjs',
  'next.config.ts',
  'next.config.mts',
];

interface NextProject {
  /** Pasta do App Router relativa ao projeto (`app` ou `src/app`). */
  appDir?: string;
  /** Pasta do Pages Router relativa ao projeto (`pages` ou `src/pages`). */
  pagesDir?: string;
  /** `next.config` menciona `basePath`: o caminho completo não pode ser comprovado. */
  basePath: boolean;
  /** `pageExtensions` lido do `next.config` (lista literal); sem ele, o padrão do Next.js. */
  pageExtensions?: string[];
  /** `next.config` define algo que só seria conhecido executando-o: nenhuma rota é afirmada. */
  skipped: boolean;
}

const projects = new WeakMap<RouteState, Map<string, NextProject>>();

const isDirectory = (p: string) => {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * `pageExtensions: ['page.tsx', 'api.ts']` lido sem executar o arquivo: só vale uma única
 * menção, que seja uma lista de textos literais. `undefined` sem menção; `null` quando o valor
 * só seria conhecido executando a configuração (variável, condição, espalhamento...).
 */
function staticPageExtensions(file: string, text: string): string[] | null | undefined {
  const mentions = text.match(/\bpageExtensions\b/g)?.length ?? 0;
  if (!mentions) return undefined;
  if (mentions > 1) return null;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  let found: string[] | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === 'pageExtensions'
    ) {
      const value = unwrapExpression(node.initializer);
      if (ts.isArrayLiteralExpression(value) && value.elements.length) {
        const items = value.elements.map((e) => (ts.isStringLiteralLike(e) ? e.text : undefined));
        if (items.every((t): t is string => !!t && /^[\w.-]+$/.test(t))) found = items;
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Como o próprio Next.js: `app`/`pages` na raiz do projeto; `src/app` e `src/pages` só valem
 * quando nenhuma das duas existe na raiz (o Next ignora `src/` nesse caso).
 */
function nextProject(state: RouteState, dir: string): NextProject {
  let cache = projects.get(state);
  if (!cache) projects.set(state, (cache = new Map()));
  const cached = cache.get(dir);
  if (cached) return cached;
  const atRoot = isDirectory(path.join(dir, 'app')) || isDirectory(path.join(dir, 'pages'));
  const find = (name: string) => {
    const rel = atRoot ? name : `src/${name}`;
    return isDirectory(path.join(dir, rel)) ? rel : undefined;
  };
  let basePath = false;
  let skipped = false;
  const extensions = new Set<string>();
  for (const config of NEXT_CONFIGS) {
    const file = path.join(dir, config);
    let text: string;
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // sem esse arquivo de configuração
    }
    if (/\bbasePath\b/.test(text)) basePath = true;
    const pageExtensions = staticPageExtensions(file, text);
    if (pageExtensions === null) {
      skipped = true;
      const rel = toPosix(path.relative(state.ctx.root, file));
      state.ctx.diagnostics.push({
        level: 'warning',
        code: 'next-routes-skipped',
        message: `Rotas do Next.js não detectadas: ${rel} define pageExtensions de um jeito que só seria conhecido executando o arquivo.`,
        file: rel,
        params: { config: rel, option: 'pageExtensions' },
      });
    } else if (pageExtensions) {
      extensions.add(JSON.stringify(pageExtensions));
    }
  }
  if (extensions.size > 1) skipped = true; // configurações diferentes: não dá para saber qual vale
  const appDir = find('app');
  const pagesDir = find('pages');
  const project: NextProject = {
    ...(appDir ? { appDir } : {}),
    ...(pagesDir ? { pagesDir } : {}),
    basePath,
    ...(extensions.size === 1
      ? { pageExtensions: JSON.parse([...extensions][0]!) as string[] }
      : {}),
    skipped,
  };
  cache.set(dir, project);
  return project;
}

/** Nome do arquivo sem a extensão de página (a mais longa que casar), ou `undefined`. */
function withoutPageExtension(name: string, extensions: string[]): string | undefined {
  const ext = extensions
    .filter((e) => name.length > e.length + 1 && name.endsWith(`.${e}`))
    .sort((a, b) => b.length - a.length)[0];
  return ext === undefined ? undefined : name.slice(0, -(ext.length + 1));
}

/** Segmento de pasta → segmento de rota: `[id]` → `:id`, `[...slug]` → `*slug`, `[[...slug]]` → `*slug?`. */
function routeSegment(segment: string): string {
  const optionalCatchAll = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(segment);
  if (optionalCatchAll) return `*${optionalCatchAll[1]}?`;
  const catchAll = /^\[\.\.\.([^\]]+)\]$/.exec(segment);
  if (catchAll) return `*${catchAll[1]}`;
  const dynamic = /^\[([^\]]+)\]$/.exec(segment);
  if (dynamic) return `:${dynamic[1]}`;
  return segment;
}

/**
 * Caminho de uma pasta do App Router, ou `undefined` se a pasta não gera URL:
 * pastas privadas (`_x`), slots paralelos (`@x`) e rotas interceptadas (`(.)x`) ficam de fora;
 * grupos (`(x)`) somem do caminho.
 */
function appRoutePath(folders: string[]): string | undefined {
  const parts: string[] = [];
  for (const folder of folders) {
    if (folder.startsWith('_') || folder.startsWith('@')) return undefined;
    if (/^\(\.{1,3}\)/.test(folder)) return undefined;
    if (/^\(.+\)$/.test(folder)) continue;
    parts.push(routeSegment(folder));
  }
  return `/${parts.join('/')}`;
}

/** Exports de valor do módulo (imports e exports só de tipo não contam). */
function valueExports(state: RouteState, sf: SourceFile): Map<string, ts.Symbol> {
  const { checker } = state.ctx;
  const out = new Map<string, ts.Symbol>();
  const moduleSymbol = checker.getSymbolAtLocation(sf.compilerNode);
  if (!moduleSymbol) return out;
  let exports: ts.Symbol[];
  try {
    exports = checker.getExportsOfModule(moduleSymbol);
  } catch {
    return out;
  }
  for (const symbol of exports) {
    const decl = symbol.declarations?.[0];
    if (decl && ts.isExportSpecifier(decl) && (decl.isTypeOnly || decl.parent.parent.isTypeOnly))
      continue;
    let flags = symbol.flags;
    if (flags & ts.SymbolFlags.Alias) {
      try {
        flags = checker.getAliasedSymbol(symbol).flags;
      } catch {
        flags = ts.SymbolFlags.Value;
      }
      // alvo desconhecido (ex.: pacote sem tipos): o export existe e é tratado como valor
      if (!(flags & (ts.SymbolFlags.Value | ts.SymbolFlags.Type))) flags = ts.SymbolFlags.Value;
    }
    if (flags & ts.SymbolFlags.Value) out.set(symbol.name, symbol);
  }
  return out;
}

/**
 * Texto da referência quando o export aponta para outro nome (`export default handler`,
 * `export { x as GET }`, `export const GET = x`); `undefined` para declarações e expressões.
 */
function referenceText(decl: ts.Node | undefined): string | undefined {
  if (!decl) return undefined;
  if (ts.isExportSpecifier(decl)) return (decl.propertyName ?? decl.name).text;
  const value = ts.isExportAssignment(decl)
    ? decl.expression
    : ts.isVariableDeclaration(decl)
      ? decl.initializer
      : undefined;
  const e = value && unwrapExpression(value);
  return e && (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e))
    ? e.getText().replace(/\s+/g, '')
    : undefined;
}

/**
 * Regra de framework: rotas do Next.js (baseadas em arquivos).
 * Só vale quando o package.json do projeto declara `next` e o arquivo está na pasta `app/` ou
 * `pages/` (ou `src/app`, `src/pages`) desse projeto.
 * - App Router: `page.tsx` → página (GET); `route.ts` → uma rota por função exportada com nome
 *   de método HTTP (`GET`, `POST`...), ligada à função.
 * - Pages Router: cada arquivo com export padrão é uma página (GET); em `pages/api/` é uma rota
 *   de API (método `ALL`, pois o handler atende todos), ligada ao export padrão.
 */
export function detectNextRoutes(state: RouteState, file: DiscoveredFile, sf: SourceFile): void {
  const dir = state.ctx.resolver.packageDirDeclaring('next', file.absolute);
  if (!dir) return;
  const project = nextProject(state, dir);
  if (project.skipped) return;
  const rel = path.posix.relative(dir, file.absolute);
  const name = path.posix.basename(rel);
  const pageExtensions = project.pageExtensions ?? PAGE_EXTENSIONS;
  // sem `pageExtensions` próprio, handlers de rota (`route.ts`) são só .ts/.js
  const routeExtensions = project.pageExtensions ?? ROUTE_EXTENSIONS;

  let routes: Array<{ httpMethod: string; exportName: string; routeKind: 'page' | 'api' }>;
  let routePath: string | undefined;
  if (project.appDir && rel.startsWith(`${project.appDir}/`)) {
    const folders = rel
      .slice(project.appDir.length + 1)
      .split('/')
      .slice(0, -1);
    routePath = appRoutePath(folders);
    if (withoutPageExtension(name, pageExtensions) === 'page') {
      routes = [{ httpMethod: 'GET', exportName: 'default', routeKind: 'page' }];
    } else if (withoutPageExtension(name, routeExtensions) === 'route') {
      routes = HTTP_METHODS.map((m) => ({ httpMethod: m, exportName: m, routeKind: 'api' }));
    } else {
      return;
    }
  } else if (project.pagesDir && rel.startsWith(`${project.pagesDir}/`)) {
    // com `pageExtensions: ['page.tsx']`, `Button.tsx` em pages/ não é página
    const base = withoutPageExtension(name, pageExtensions);
    if (base === undefined) return;
    const folders = rel
      .slice(project.pagesDir.length + 1)
      .split('/')
      .slice(0, -1);
    if (!folders.length && PAGES_SPECIAL.has(base)) return;
    if (base === '_middleware') return;
    const segments = [...folders, ...(base === 'index' ? [] : [base])];
    routePath = `/${segments.map(routeSegment).join('/')}`;
    const api = folders[0] === 'api';
    routes = [
      { httpMethod: api ? 'ALL' : 'GET', exportName: 'default', routeKind: api ? 'api' : 'page' },
    ];
  } else {
    return;
  }
  if (routePath === undefined) return;

  const exports = valueExports(state, sf);
  for (const route of routes) {
    const symbol = exports.get(route.exportName);
    if (!symbol) continue;
    const decl = symbol.declarations?.find((d) => d.getSourceFile() === sf.compilerNode);
    const at = decl ?? sf.compilerNode;
    const id = addRoute(state, {
      file,
      framework: 'next',
      receiver: 'next',
      httpMethod: route.httpMethod,
      routePath,
      identity: file.relative,
      fullPath: project.basePath ? null : routePath,
      at,
      qualifiedName: `${file.relative}#${route.exportName}`,
      meta: { routeKind: route.routeKind },
    });
    const reference = referenceText(decl);
    linkHandlerSymbol(state.ctx, file, id, symbol, at, reference ?? route.exportName, !!reference);
  }
}
