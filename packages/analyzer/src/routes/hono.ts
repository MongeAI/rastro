import { Node, SyntaxKind, ts, type SourceFile } from 'ts-morph';
import type { DiscoveredFile } from '../discover.js';
import { descendantsOfKind } from '../analyze.js';
import {
  addRoute,
  frameworkExport,
  isHandlerLike,
  joinPath,
  linkHandlers,
  normalizePrefix,
  resolveOwner,
  stringLiteral,
  stringLiterals,
  receiverName,
  type OwnerKey,
  type RouteState,
  UNPROVEN_PARENT,
} from './common.js';

/** O Hono expõe a mesma classe pelos presets `hono/tiny` e `hono/quick`. */
const HONO = new Set(['hono', 'hono/tiny', 'hono/quick']);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'options', 'patch', 'all']);
/** Métodos que devolvem a própria instância (permitem encadear). */
const CHAINABLE = new Set([...HTTP_METHODS, 'on', 'use', 'route', 'notFound', 'onError']);

/** Um app do Hono: o dono das rotas e o prefixo de `basePath` dentro dele. */
interface HonoApp {
  /** App de origem (`new Hono()`): os derivados por `basePath` dividem as rotas com ele. */
  owner: OwnerKey;
  /** Prefixo acumulado de `basePath` (`''` sem); `undefined` quando não é literal. */
  inner: string | undefined;
}

/** App derivado por `basePath` → app de origem e prefixo. */
const derivedApps = new WeakMap<RouteState, Map<OwnerKey, HonoApp>>();

/**
 * App do Hono de uma expressão. `x.basePath('/api')` não é uma montagem: devolve um app que
 * divide as rotas (e o roteador) com `x` e registra cada uma com o prefixo na frente. Então a
 * rota fica em `<onde x (ou o derivado) é servido> + /api + caminho`.
 */
function honoApp(state: RouteState, expr: ts.Expression): HonoApp | undefined {
  const key = honoOwner(state, expr);
  if (key === undefined) return undefined;
  return derivedApps.get(state)?.get(key) ?? { owner: key, inner: '' };
}

/**
 * Dono (app) comprovadamente do Hono: `new Hono()` (import de `hono`), `x.basePath('/api')`
 * sobre um app comprovado e encadeamentos (`app.get(...).post(...)`). Para um app derivado por
 * `basePath`, a chave é a do próprio derivado (ver `honoApp` para o app de origem).
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
      const parent = honoApp(state, e.expression.expression);
      if (parent === undefined) return undefined;
      const prefix = stringLiteral(e.arguments[0]);
      const inner =
        prefix === undefined || parent.inner === undefined
          ? undefined
          : normalizePrefix(joinPath(parent.inner, normalizePrefix(prefix)));
      let derived = derivedApps.get(state);
      if (!derived) derivedApps.set(state, (derived = new Map()));
      derived.set(key, { owner: parent.owner, inner });
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
    const identity = honoOwner(state, receiver);
    const app = identity === undefined ? undefined : honoApp(state, receiver);
    if (identity === undefined || !app) continue;

    const receiverText = receiverName(receiver);
    for (const httpMethod of methods) {
      const id = addRoute(state, {
        file,
        framework: 'hono',
        receiver: receiverText,
        httpMethod,
        routePath,
        identity,
        owner: app.owner,
        innerPrefix: app.inner ?? null,
        at: call,
        qualifiedName: `${receiverText}.${name}('${routePath}')`,
      });
      linkHandlers(state, file, id, handlers);
    }
  }
}

/**
 * `app.route('/users', users)`: monta o sub-app no prefixo (só entre apps comprovados). As rotas
 * do sub-app já levam o `basePath` dele; o `basePath` de quem monta entra antes do prefixo.
 */
function detectMount(state: RouteState, receiver: ts.Expression, call: ts.CallExpression): void {
  const [pathArg, childArg] = call.arguments;
  if (!pathArg || !childArg) return;
  const child = honoApp(state, childArg);
  if (!child) return;
  const parent = honoApp(state, receiver);
  // montado num app que não dá para comprovar: o prefixo de lá é desconhecido
  if (!parent) return state.mount(child.owner, UNPROVEN_PARENT, undefined);
  if (parent.owner === child.owner) return;
  const prefix = stringLiteral(pathArg);
  state.mount(
    child.owner,
    parent.owner,
    prefix === undefined || parent.inner === undefined
      ? undefined
      : normalizePrefix(joinPath(parent.inner, normalizePrefix(prefix))),
  );
}
