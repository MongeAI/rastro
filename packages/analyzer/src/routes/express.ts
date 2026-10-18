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
  stringLiterals,
  type OwnerKey,
  type RouteState,
  UNPROVEN_PARENT,
} from './common.js';

const EXPRESS = new Set(['express']);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);

/**
 * `express()`, `e()` (alias), `require('express')()` criam um app; `express.Router()`,
 * `Router()`, `R()` (alias de `Router`) criam um roteador. Qualquer outra chamada: `undefined`.
 */
function expressFactory(state: RouteState, call: ts.CallExpression): 'app' | 'router' | undefined {
  const name = frameworkExport(state.ctx, call.expression, EXPRESS);
  if (name === 'Router') return 'router';
  if (name === 'default' || name === '*') return 'app';
  return undefined;
}

/** Dono (app ou roteador) comprovadamente criado por uma fábrica do Express. */
export function expressOwner(state: RouteState, expr: ts.Expression): OwnerKey | undefined {
  return resolveOwner(state.ctx, expr, (e, key) => {
    if (!ts.isCallExpression(e)) return undefined;
    const kind = expressFactory(state, e);
    if (!kind) return undefined;
    // um app é a raiz enquanto não for montado em outro; um roteador sem montagem tem prefixo desconhecido
    state.owner(key, kind === 'app' ? { known: [''], unknown: false } : undefined);
    return key;
  });
}

/**
 * Regra de framework: rotas do Express.
 * Reconhece `app.get('/caminho', handler)`, `router.post(...)` e `router.route('/x').get(...)`
 * somente quando o receptor comprovadamente vem de `express()` ou `express.Router()`, o caminho
 * é um texto literal começando com `/` e há ao menos um handler (função ou referência a uma).
 * `app.use('/api', router)` monta o roteador no prefixo, para compor o caminho completo.
 */
export function detectExpressRoutes(state: RouteState, file: DiscoveredFile, sf: SourceFile): void {
  for (const call of descendantsOfKind(sf, SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const method = callee.getName().toLowerCase();
    if (method === 'use') {
      detectMount(state, call.compilerNode);
      continue;
    }
    if (!HTTP_METHODS.has(method)) continue;
    const receiver = callee.getExpression();
    const args = call.getArguments();

    let owner: OwnerKey | undefined;
    let routePath: string | undefined;
    let handlers: Node[];
    let receiverName: string;
    let qualifiedName: string;
    if (Node.isIdentifier(receiver)) {
      const [first, ...rest] = args;
      if (!first || !(Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first)))
        continue;
      routePath = first.getLiteralValue();
      handlers = rest;
      receiverName = receiver.getText();
      qualifiedName = `${receiverName}.${method}('${routePath}')`;
      if (!routePath.startsWith('/') || !handlers.some(isHandlerLike)) continue;
      owner = expressOwner(state, receiver.compilerNode);
    } else {
      // router.route('/users').get(listar).post(criar)
      const chain = routeChain(receiver.compilerNode);
      if (!chain) continue;
      routePath = chain.path;
      handlers = args;
      receiverName = chain.receiver.getText();
      qualifiedName = `${receiverName}.route('${routePath}').${method}()`;
      if (!routePath.startsWith('/') || !handlers.some(isHandlerLike)) continue;
      owner = expressOwner(state, chain.receiver);
    }
    if (owner === undefined) continue;

    const id = addRoute(state, {
      file,
      framework: 'express',
      receiver: receiverName,
      httpMethod: method.toUpperCase(),
      routePath,
      // dois roteadores com o mesmo nome (em funções diferentes) não podem virar uma rota só
      identity: owner,
      owner,
      at: call,
      qualifiedName,
    });
    linkHandlers(state, file, id, handlers);
  }
}

/**
 * O valor é comprovadamente uma função: todo o tipo dele tem assinatura de chamada (ex.: o
 * middleware devolvido por `cors()`). `any` (JS sem tipos) e uniões com texto não contam.
 */
function isFunctionValue(state: RouteState, expr: ts.Expression): boolean {
  try {
    const type = state.ctx.checker.getTypeAtLocation(expr);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
    return type.getCallSignatures().length > 0 && !(type.flags & ts.TypeFlags.StringLike);
  } catch {
    return false;
  }
}

/** `x.route('/p')` seguido de `.get(...)`, `.post(...)`: devolve o receptor e o caminho. */
function routeChain(expr: ts.Expression): { receiver: ts.Identifier; path: string } | undefined {
  let current = expr;
  while (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    HTTP_METHODS.has(current.expression.name.text.toLowerCase())
  ) {
    current = current.expression.expression;
  }
  if (
    !ts.isCallExpression(current) ||
    !ts.isPropertyAccessExpression(current.expression) ||
    current.expression.name.text !== 'route' ||
    !ts.isIdentifier(current.expression.expression)
  )
    return undefined;
  const path = current.arguments[0];
  if (!path || !(ts.isStringLiteral(path) || ts.isNoSubstitutionTemplateLiteral(path)))
    return undefined;
  return { receiver: current.expression.expression, path: path.text };
}

/**
 * `app.use('/api', router)`, `app.use(router)`, `app.use(['/a', '/b'], auth, router)`:
 * registra a montagem quando o receptor e o roteador montado são comprovadamente do Express.
 */
function detectMount(state: RouteState, call: ts.CallExpression): void {
  const callee = call.expression as ts.PropertyAccessExpression;
  if (!ts.isIdentifier(callee.expression) || !call.arguments.length) return;
  const [first, ...rest] = call.arguments;
  let prefixes: Array<string | undefined>;
  let candidates: readonly ts.Expression[];
  const literal = stringLiterals(first);
  if (literal) {
    prefixes = literal.map(normalizePrefix);
    candidates = rest;
  } else if (first && (expressOwner(state, first) !== undefined || isFunctionValue(state, first))) {
    // sem caminho: montado na raiz do receptor. O Express só lê o primeiro argumento como
    // caminho quando ele não é uma função (`app.use(cors(), router)` monta na raiz)
    prefixes = [''];
    candidates = call.arguments;
  } else {
    prefixes = [undefined]; // caminho não literal: a montagem existe, mas o prefixo é desconhecido
    candidates = rest;
  }
  const children = candidates
    .map((arg) => expressOwner(state, arg))
    .filter((o): o is OwnerKey => o !== undefined);
  if (!children.length) return;
  const parent = expressOwner(state, callee.expression);
  for (const child of children) {
    // montado num receptor que não dá para comprovar: o prefixo de lá é desconhecido
    if (parent === undefined) {
      state.mount(child, UNPROVEN_PARENT, undefined);
      continue;
    }
    if (child === parent) continue;
    for (const prefix of prefixes) state.mount(child, parent, prefix);
  }
}
