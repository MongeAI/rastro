import { Node, SyntaxKind, ts, type SourceFile } from 'ts-morph';
import type { DiscoveredFile } from '../discover.js';
import { descendantsOfKind } from '../analyze.js';
import {
  addRoute,
  frameworkExport,
  isHandlerLike,
  linkHandlers,
  normalizePrefix,
  resolveOwner,
  stringLiteral,
  stringLiterals,
  receiverName,
  type OwnerKey,
  type RouteState,
} from './common.js';

/** O Hono expõe a mesma classe pelos presets `hono/tiny` e `hono/quick`. */
const HONO = new Set(['hono', 'hono/tiny', 'hono/quick']);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'options', 'patch', 'all']);
/** Métodos que devolvem a própria instância (permitem encadear). */
const CHAINABLE = new Set([...HTTP_METHODS, 'on', 'use', 'route', 'notFound', 'onError']);

/**
 * Dono (app) comprovadamente do Hono: `new Hono()` (import de `hono`), `x.basePath('/api')`
 * sobre um app comprovado e encadeamentos (`app.get(...).post(...)`).
 */
export function honoOwner(state: RouteState, expr: ts.Expression): OwnerKey | undefined {
  return resolveOwner(state.ctx, expr, (e, key) => {
    if (ts.isNewExpression(e)) {
      if (frameworkExport(state.ctx, e.expression, HONO) !== 'Hono') return undefined;
      state.owner(key, { known: [''], unknown: false });
      return key;
    }
    if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return undefined;
    const name = e.expression.name.text;
    if (name === 'basePath') {
      // basePath devolve um app novo, que responde sob o prefixo
      const parent = honoOwner(state, e.expression.expression);
      if (parent === undefined) return undefined;
      const prefix = stringLiteral(e.arguments[0]);
      state.owner(key);
      state.mount(key, parent, prefix === undefined ? undefined : normalizePrefix(prefix));
      return key;
    }
    return CHAINABLE.has(name) ? honoOwner(state, e.expression.expression) : undefined;
  });
}

/**
 * Regra de framework: rotas do Hono.
 * `app.get('/p', ...handlers)` (e `post`, `put`, `delete`, `options`, `patch`, `all`),
 * `app.on('GET' | ['GET', 'POST'], '/p', handler)` e `app.route('/prefixo', subApp)`, sempre
 * com o app comprovadamente criado por `new Hono()`.
 */
export function detectHonoRoutes(state: RouteState, file: DiscoveredFile, sf: SourceFile): void {
  for (const call of descendantsOfKind(sf, SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const name = callee.getName();
    const args = call.getArguments();
    const receiver = callee.getExpression().compilerNode;

    if (name === 'route') {
      detectMount(state, receiver, call.compilerNode);
      continue;
    }
    let methods: string[];
    let pathArg: Node | undefined;
    let handlers: Node[];
    if (HTTP_METHODS.has(name)) {
      methods = [name.toUpperCase()];
      [pathArg, ...handlers] = args;
    } else if (name === 'on') {
      const declared = args[0] && stringLiterals(args[0].compilerNode);
      if (!declared) continue;
      methods = [...new Set(declared.map((m) => m.toUpperCase()))];
      [, pathArg, ...handlers] = args;
    } else {
      continue;
    }
    const routePath = pathArg && stringLiteral(pathArg.compilerNode);
    if (routePath === undefined || !routePath.startsWith('/')) continue;
    if (!handlers.some(isHandlerLike) || !methods.every((m) => /^[A-Z]+$/.test(m))) continue;
    const owner = honoOwner(state, receiver);
    if (owner === undefined) continue;

    const receiverText = receiverName(receiver);
    for (const httpMethod of methods) {
      const id = addRoute(state, {
        file,
        framework: 'hono',
        receiver: receiverText,
        httpMethod,
        routePath,
        identity: owner,
        owner,
        at: call,
        qualifiedName: `${receiverText}.${name}('${routePath}')`,
      });
      linkHandlers(state, file, id, handlers);
    }
  }
}

/** `app.route('/users', users)`: monta o sub-app no prefixo (só entre apps comprovados). */
function detectMount(state: RouteState, receiver: ts.Expression, call: ts.CallExpression): void {
  const [pathArg, childArg] = call.arguments;
  if (!pathArg || !childArg) return;
  const child = honoOwner(state, childArg);
  if (child === undefined) return;
  const parent = honoOwner(state, receiver);
  if (parent === undefined || parent === child) return;
  const prefix = stringLiteral(pathArg);
  state.mount(child, parent, prefix === undefined ? undefined : normalizePrefix(prefix));
}
