import fs from 'node:fs';
import path from 'node:path';
import { ts, type SourceFile } from 'ts-morph';
import type { DiscoveredFile } from '../discover.js';
import { unwrapExpression } from '../analyze.js';
import { addRoute, linkHandlerSymbol, type RouteState } from './common.js';

const HTTP_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'];
const PAGE_EXT = /^(tsx|jsx|ts|js)$/;
const ROUTE_EXT = /^(ts|js)$/;
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
}

const projects = new WeakMap<RouteState, Map<string, NextProject>>();

const isDirectory = (p: string) => {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Como o próprio Next.js: `app`/`pages` na raiz do projeto, senão em `src/`. */
function nextProject(state: RouteState, dir: string): NextProject {
  let cache = projects.get(state);
  if (!cache) projects.set(state, (cache = new Map()));
  const cached = cache.get(dir);
  if (cached) return cached;
  const find = (name: string) =>
    isDirectory(path.join(dir, name))
      ? name
      : isDirectory(path.join(dir, 'src', name))
        ? `src/${name}`
        : undefined;
  let basePath = false;
  for (const config of NEXT_CONFIGS) {
    try {
      const file = path.join(dir, config);
      if (fs.lstatSync(file).isFile() && /\bbasePath\b/.test(fs.readFileSync(file, 'utf8')))
        basePath = true;
    } catch {
      // sem esse arquivo de configuração
    }
  }
  const appDir = find('app');
  const pagesDir = find('pages');
  const project: NextProject = {
    ...(appDir ? { appDir } : {}),
    ...(pagesDir ? { pagesDir } : {}),
    basePath,
  };
  cache.set(dir, project);
  return project;
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
  const rel = path.posix.relative(dir, file.absolute);
  const ext = path.posix.extname(rel).slice(1);
  const base = path.posix.basename(rel, `.${ext}`);

  let routes: Array<{ httpMethod: string; exportName: string; routeKind: 'page' | 'api' }>;
  let routePath: string | undefined;
  if (project.appDir && rel.startsWith(`${project.appDir}/`)) {
    const folders = rel
      .slice(project.appDir.length + 1)
      .split('/')
      .slice(0, -1);
    routePath = appRoutePath(folders);
    if (base === 'page' && PAGE_EXT.test(ext)) {
      routes = [{ httpMethod: 'GET', exportName: 'default', routeKind: 'page' }];
    } else if (base === 'route' && ROUTE_EXT.test(ext)) {
      routes = HTTP_METHODS.map((m) => ({ httpMethod: m, exportName: m, routeKind: 'api' }));
    } else {
      return;
    }
  } else if (project.pagesDir && rel.startsWith(`${project.pagesDir}/`)) {
    if (!PAGE_EXT.test(ext)) return;
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
