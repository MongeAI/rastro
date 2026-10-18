import { Node, SyntaxKind, ts, type SourceFile } from 'ts-morph';
import type { DiscoveredFile } from '../discover.js';
import { descendantsOfKind, unwrapExpression } from '../analyze.js';
import {
  addRoute,
  frameworkExport,
  hasOpaqueProperties,
  isHandlerLike,
  linkHandlers,
  normalizePrefix,
  objectProperty,
  resolveOwner,
  resolveValue,
  stringLiteral,
  stringLiterals,
  receiverName,
  type OwnerKey,
  type RouteState,
} from './common.js';

const FASTIFY = new Set(['fastify']);
const HTTP_METHODS = new Set(['get', 'head', 'post', 'put', 'delete', 'options', 'patch', 'all']);
/** Métodos da instância que devolvem a própria instância (permitem encadear). */
const CHAINABLE = new Set([...HTTP_METHODS, 'route', 'register', 'withTypeProvider', 'addHook']);

/** `fastify()`, `Fastify({ logger: true })`, `require('fastify')()`, `fastify.fastify()`. */
function isFastifyFactory(state: RouteState, call: ts.CallExpression): boolean {
  const name = frameworkExport(state.ctx, call.expression, FASTIFY);
  return name === 'default' || name === '*' || name === 'fastify';
}

/** Função do plugin: inline, declarada, ou `const plugin = async (app) => {}`. */
function pluginFunction(node: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    return node;
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const init = unwrapExpression(node.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  }
  return undefined;
}

/**
 * Passo preparatório: guarda todo `x.register(plugin, opcoes)` cujo plugin é uma função do
 * projeto. Se `x` é mesmo uma instância do Fastify só é decidido depois, ao achar as rotas,
 * porque o plugin pode estar em um arquivo analisado antes do arquivo que o registra.
 */
export function collectFastifyRegistrations(state: RouteState, sf: SourceFile): void {
  const source = sf.compilerNode;
  if (!source.text.includes('register')) return;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'register' &&
      node.arguments[0]
    ) {
      const prefix = registrationPrefix(node.arguments[1]);
      for (const terminal of resolveValue(state.ctx, node.arguments[0])) {
        const fn = pluginFunction(terminal);
        if (!fn) continue;
        let list = state.fastifyPlugins.get(fn);
        if (!list) state.fastifyPlugins.set(fn, (list = []));
        list.push({ receiver: node.expression.expression, prefix });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

/** `{ prefix: '/v1' }` → `'/v1'`; sem opções ou sem `prefix` → `''`; não literal → `undefined`. */
function registrationPrefix(options: ts.Expression | undefined): string | undefined {
  if (!options) return '';
  const obj = unwrapExpression(options);
  if (!ts.isObjectLiteralExpression(obj)) return undefined;
  const prop = objectProperty(obj, 'prefix');
  if (!prop) return hasOpaqueProperties(obj) ? undefined : '';
  if (!ts.isPropertyAssignment(prop)) return undefined;
  const value = stringLiteral(prop.initializer);
  return value === undefined ? undefined : normalizePrefix(value);
}

/**
 * Dono (instância) comprovadamente do Fastify: criado por `fastify()`, ou o primeiro parâmetro
 * de um plugin registrado (`app.register(plugin, { prefix })`) em uma instância comprovada.
 */
export function fastifyOwner(
  state: RouteState,
  expr: ts.Expression,
  visiting: ReadonlySet<ts.Node> = new Set(),
): OwnerKey | undefined {
  const classify = (e: ts.Expression, key: ts.Node): OwnerKey | undefined => {
    if (!ts.isCallExpression(e)) return undefined;
    if (isFastifyFactory(state, e)) {
      state.owner(key, { known: [''], unknown: false });
      return key;
    }
    if (ts.isPropertyAccessExpression(e.expression) && CHAINABLE.has(e.expression.name.text))
      return fastifyOwner(state, e.expression.expression, visiting);
    return undefined;
  };
  const plugin = (decl: ts.Node): OwnerKey | undefined => {
    if (!ts.isParameter(decl)) return undefined;
    const fn = decl.parent;
    if (!ts.isFunctionLike(fn) || fn.parameters[0] !== decl || visiting.has(fn)) return undefined;
    if (state.owners.has(fn)) return fn;
    const registrations = state.fastifyPlugins.get(fn) ?? [];
    const inner = new Set(visiting).add(fn);
    const parents = registrations
      .map((r) => ({ parent: fastifyOwner(state, r.receiver, inner), prefix: r.prefix }))
      .filter((r): r is { parent: OwnerKey; prefix: string | undefined } => r.parent !== undefined);
    if (!parents.length) return undefined;
    for (const { parent, prefix } of parents) state.mount(fn, parent, prefix);
    return fn;
  };
  return resolveOwner(state.ctx, expr, classify, plugin);
}

/** `{ handler }` / `{ handler: fn }` em um objeto de opções. */
function handlerOption(obj: Node): Node | undefined {
  if (!Node.isObjectLiteralExpression(obj)) return undefined;
  const prop = obj.getProperty('handler');
  if (Node.isPropertyAssignment(prop)) return prop.getInitializer();
  if (Node.isShorthandPropertyAssignment(prop)) return prop.getNameNode();
  if (Node.isMethodDeclaration(prop)) return prop; // { handler(req, reply) { ... } }
  return undefined;
}

/**
 * Regra de framework: rotas do Fastify.
 * `app.get('/p', handler)`, `app.get('/p', { schema }, handler)`, `app.route({ method, url,
 * handler })` em instâncias comprovadas (ver `fastifyOwner`). O prefixo de `register` só entra
 * no caminho completo quando é um texto literal.
 */
export function detectFastifyRoutes(state: RouteState, file: DiscoveredFile, sf: SourceFile): void {
  for (const call of descendantsOfKind(sf, SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const name = callee.getName();
    const args = call.getArguments();
    const receiver = callee.getExpression().compilerNode;

    let methods: string[];
    let routePath: string | undefined;
    let handlers: Node[];
    let qualified: string;
    if (HTTP_METHODS.has(name)) {
      const [first, ...rest] = args;
      routePath = first && stringLiteral(first.compilerNode);
      methods = [name.toUpperCase()];
      handlers = [
        ...rest.filter(isHandlerLike),
        ...rest.map(handlerOption).filter((h): h is Node => !!h),
      ];
      qualified = `${receiverName(receiver)}.${name}('${routePath}')`;
    } else if (name === 'route') {
      const options = args[0];
      if (!options || !Node.isObjectLiteralExpression(options)) continue;
      const obj = options.compilerNode;
      const methodProp = objectProperty(obj, 'method');
      const urlProp = objectProperty(obj, 'url') ?? objectProperty(obj, 'path');
      if (!methodProp || !urlProp) continue;
      if (!ts.isPropertyAssignment(methodProp) || !ts.isPropertyAssignment(urlProp)) continue;
      const declared = stringLiterals(methodProp.initializer);
      routePath = stringLiteral(urlProp.initializer);
      if (!declared) continue;
      methods = [...new Set(declared.map((m) => m.toUpperCase()))];
      const handler = handlerOption(options);
      handlers = handler ? [handler] : [];
      qualified = `${receiverName(receiver)}.route({ url: '${routePath}' })`;
    } else {
      continue;
    }
    if (routePath === undefined || !routePath.startsWith('/')) continue;
    if (!handlers.length || !methods.every((m) => /^[A-Z]+$/.test(m))) continue;
    const owner = fastifyOwner(state, receiver);
    if (owner === undefined) continue;

    for (const httpMethod of methods) {
      const id = addRoute(state, {
        file,
        framework: 'fastify',
        receiver: receiverName(receiver),
        httpMethod,
        routePath,
        identity: owner,
        owner,
        at: call,
        qualifiedName: qualified,
      });
      linkHandlers(state, file, id, handlers);
    }
  }
}
