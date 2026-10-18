import { Node, ts } from 'ts-morph';
import { compareStrings, nodeId, type NodeMeta } from '@rastro/core';
import { toPosix, type DiscoveredFile } from '../discover.js';
import {
  addUnresolvedNode,
  evidenceAt,
  moduleSpecifierOfAlias,
  rangeOf,
  referenceText,
  resolveSymbolTargets,
  unresolvedReason,
  unwrapExpression,
  wrappedFunction,
  type AnalyzerContext,
} from '../analyze.js';

export type Framework = 'express' | 'fastify' | 'hono' | 'nestjs' | 'next';

/**
 * Dono de rotas: a declaração do app/roteador/instância, a função de um plugin do Fastify ou
 * uma chave sintética (ex.: o prefixo global de um app NestJS).
 */
export type OwnerKey = ts.Node | string;

/** Prefixos conhecidos (normalizados: `''` é a raiz, `'/api'`) e se há algum desconhecido. */
export interface PrefixSet {
  known: string[];
  unknown: boolean;
}

interface Owner {
  /** Prefixos quando o dono não está montado em nenhum outro. `undefined`: desconhecido. */
  base?: PrefixSet;
  /** Onde o dono foi montado (`app.use('/api', router)`); `prefix` indefinido = não literal. */
  mounts: Array<{ parent: OwnerKey; prefix: string | undefined }>;
}

interface RouteRecord {
  id: string;
  httpMethod: string;
  routePath: string;
  /** Dono cujos prefixos de montagem compõem o caminho completo. */
  owner?: OwnerKey;
  /** Caminho completo já conhecido (Next.js); `null` quando ele não pode ser comprovado. */
  fullPath?: string | null;
  /** Prefixo entre a montagem e o caminho local (`basePath` do Hono); `null` = desconhecido. */
  innerPrefix?: string | null;
}

/** Registro de `instancia.register(plugin, { prefix })` encontrado no código (Fastify). */
export interface PluginRegistration {
  /** Expressão do receptor (`app` em `app.register(...)`). */
  receiver: ts.Expression;
  /** Prefixo literal, `''` sem prefixo, `undefined` quando não pode ser comprovado. */
  prefix: string | undefined;
}

/** Estado compartilhado pelas regras de rotas durante uma análise. */
export class RouteState {
  readonly owners = new Map<OwnerKey, Owner>();
  /** id da rota → dono, para separar rotas iguais de donos diferentes (sufixo `~N`). */
  readonly routeOwners = new Map<string, unknown>();
  readonly routes: RouteRecord[] = [];
  /** função do plugin → onde ela foi registrada. */
  readonly fastifyPlugins = new Map<ts.Node, PluginRegistration[]>();
  /**
   * Rota que recebeu as chamadas de um handler inline → outras rotas atendidas pelo mesmo
   * handler (ex.: `app.on(['GET', 'POST'], ...)`), que recebem uma cópia dessas chamadas.
   */
  readonly sharedHandlers = new Map<string, Set<string>>();
  /** pasta do app NestJS → prefixos globais (`app.setGlobalPrefix`), `undefined` = não literal. */
  readonly nestPrefixes = new Map<string, Array<string | undefined>>();
  /**
   * O projeto usa algo que muda os caminhos do NestJS fora do controller (`RouterModule`,
   * `enableVersioning`, `@Version`): nenhum caminho completo do NestJS é comprovado.
   */
  nestPathsUncertain = false;

  constructor(readonly ctx: AnalyzerContext) {}

  /** Garante o registro de um dono; `base` só vale na criação. */
  owner(key: OwnerKey, base?: PrefixSet): Owner {
    let owner = this.owners.get(key);
    if (!owner) this.owners.set(key, (owner = { ...(base ? { base } : {}), mounts: [] }));
    return owner;
  }

  mount(child: OwnerKey, parent: OwnerKey, prefix: string | undefined): void {
    const owner = this.owner(child);
    if (!owner.mounts.some((m) => m.parent === parent && m.prefix === prefix))
      owner.mounts.push({ parent, prefix });
  }
}

// ---------------------------------------------------------------------------
// prova de origem (import/require do framework)

/**
 * Nome importado de um pacote pelo identificador: `default` (import padrão), `*` (namespace ou
 * `require` do módulo inteiro) ou o nome exportado (`Router` em `import { Router as R }`).
 * Imports só de tipo não contam. Devolve `undefined` se o identificador não vier de um pacote.
 */
export function importBinding(
  ctx: AnalyzerContext,
  identifier: ts.Identifier,
): { module: string; name: string } | undefined {
  const decl = ctx.checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  if (!decl) return undefined;
  let name: string;
  if (ts.isImportSpecifier(decl)) {
    if (decl.isTypeOnly || decl.parent.parent.isTypeOnly) return undefined;
    name = (decl.propertyName ?? decl.name).text;
  } else if (ts.isImportClause(decl)) {
    if (decl.isTypeOnly) return undefined;
    name = 'default';
  } else if (ts.isNamespaceImport(decl)) {
    if (decl.parent.isTypeOnly) return undefined;
    name = '*';
  } else if (ts.isImportEqualsDeclaration(decl)) {
    if (decl.isTypeOnly) return undefined;
    name = '*';
  } else if (ts.isBindingElement(decl)) {
    // const { Router } = require('express')
    const prop = decl.propertyName ?? decl.name;
    if (!ts.isIdentifier(prop) && !ts.isStringLiteral(prop)) return undefined;
    name = prop.text;
  } else if (ts.isVariableDeclaration(decl)) {
    name = '*'; // const express = require('express')
  } else {
    return undefined;
  }
  const module = moduleSpecifierOfAlias(decl);
  return module ? { module: packageOfSpecifier(ctx, module, decl), name } : undefined;
}

/**
 * Especificador como nome de pacote: `../..` vira `express` quando o arquivo exigido é o ponto
 * de entrada do package.json chamado `express` (exemplos e testes no repositório do próprio
 * framework) e esse ponto de entrada comprovadamente é o framework (ver `isFrameworkEntry`).
 * Qualquer outro especificador fica como está.
 */
function packageOfSpecifier(ctx: AnalyzerContext, specifier: string, at: ts.Node): string {
  if (!specifier.startsWith('.')) return specifier;
  const target = ctx.resolver.resolve(specifier, toPosix(at.getSourceFile().fileName));
  if (target.kind !== 'file') return specifier;
  // `../fastify` chega ao fastify.d.ts escrito à mão, mas quem roda é o fastify.js ao lado
  const runtime = target.absolute.replace(/\.d\.([cm]?)ts$/, '.$1js');
  const name = ctx.resolver.packageEntryName(runtime);
  return name !== undefined && isFrameworkEntry(ctx, name, runtime) ? name : specifier;
}

/**
 * Fábrica de cada framework no código dele: `createApplication` no lib/express.js do Express,
 * `function fastify()` no fastify.js do Fastify.
 */
const FRAMEWORK_FACTORIES: Record<string, string> = {
  express: 'createApplication',
  fastify: 'fastify',
};

const frameworkEntries = new WeakMap<AnalyzerContext, Map<string, boolean>>();

/**
 * O ponto de entrada do pacote chamado `name` é o próprio framework? Só o nome no package.json
 * não basta: um projeto qualquer pode se chamar `express`, e um `require('..')` dele viraria o
 * Express, inventando rotas. A prova é o valor do `module.exports` do ponto de entrada (seguindo
 * `module.exports = require('./lib/express')`) ser exatamente a fábrica do framework, uma
 * função analisada do projeto. Com mais de um `module.exports =` (condicional), não há prova.
 */
function isFrameworkEntry(ctx: AnalyzerContext, name: string, entry: string): boolean {
  let cache = frameworkEntries.get(ctx);
  if (!cache) frameworkEntries.set(ctx, (cache = new Map()));
  const cached = cache.get(entry);
  if (cached !== undefined) return cached;
  let proven = false;
  const factory = Object.hasOwn(FRAMEWORK_FACTORIES, name) ? FRAMEWORK_FACTORIES[name] : undefined;
  const sf = factory && ctx.filesByAbs.has(entry) ? ctx.program.getSourceFile(entry) : undefined;
  if (sf) {
    // arquivos CommonJS não expõem o símbolo do módulo pela API pública; lemos o do binder
    const moduleSymbol =
      ctx.checker.getSymbolAtLocation(sf) ?? (sf as unknown as { symbol?: ts.Symbol }).symbol;
    const exported = moduleSymbol?.exports?.get(ts.InternalSymbolName.ExportEquals);
    const targets = exported ? resolveSymbolTargets(ctx, exported) : [];
    proven =
      targets.length > 0 &&
      targets.every((t) => {
        const node = t.kind === 'entity' ? ctx.builder.getNode(t.id) : undefined;
        return node?.kind === 'function' && node.name === factory;
      });
  }
  cache.set(entry, proven);
  return proven;
}

/**
 * Nome exportado por um dos `modules` que a expressão referencia: `Hono` (identificador
 * importado) ou `hono.Hono` (namespace / `require` inteiro). `require('m')` direto vale `*`.
 */
export function frameworkExport(
  ctx: AnalyzerContext,
  expr: ts.Expression,
  modules: ReadonlySet<string>,
): string | undefined {
  const e = unwrapExpression(expr);
  if (ts.isIdentifier(e)) {
    const binding = importBinding(ctx, e);
    return binding && modules.has(binding.module) ? binding.name : undefined;
  }
  if (ts.isPropertyAccessExpression(e)) {
    const base = unwrapExpression(e.expression);
    if (ts.isIdentifier(base)) {
      const binding = importBinding(ctx, base);
      if (
        binding &&
        modules.has(binding.module) &&
        (binding.name === '*' || binding.name === 'default')
      )
        return e.name.text;
      return undefined;
    }
    const required = requiredModule(base); // require('express').Router
    return required !== undefined && modules.has(packageOfSpecifier(ctx, required, base))
      ? e.name.text
      : undefined;
  }
  const required = requiredModule(e);
  return required !== undefined && modules.has(packageOfSpecifier(ctx, required, e))
    ? '*'
    : undefined;
}

/** `require('m')` → `'m'`. */
function requiredModule(e: ts.Expression): string | undefined {
  if (
    ts.isCallExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === 'require' &&
    e.arguments[0] &&
    ts.isStringLiteralLike(e.arguments[0])
  )
    return e.arguments[0].text;
  return undefined;
}

// ---------------------------------------------------------------------------
// valores: de uma expressão até a declaração que a produz

/**
 * Segue uma expressão até as declarações que produzem o valor, atravessando imports, `require`,
 * `import()`, `export default x`, `module.exports = x`, `const a = b` e propriedades de objetos
 * literais. Devolve declarações "terminais": variáveis com inicializador próprio (ex.: uma
 * chamada `express()`), funções, parâmetros ou a própria expressão quando ela já é terminal.
 */
export function resolveValue(ctx: AnalyzerContext, expr: ts.Expression, depth = 0): ts.Node[] {
  if (depth > 8) return [];
  const e = unwrapExpression(expr);
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
    const nameNode = ts.isPropertyAccessExpression(e) ? e.name : e;
    return resolveSymbolValue(ctx, ctx.checker.getSymbolAtLocation(nameNode), depth + 1);
  }
  const moduleRef = moduleReference(e);
  if (moduleRef) {
    const moduleSymbol = ctx.checker.getSymbolAtLocation(moduleRef.specifier);
    const exported =
      moduleSymbol?.exports?.get(ts.InternalSymbolName.ExportEquals) ??
      (moduleRef.dynamic ? moduleSymbol?.exports?.get(ts.InternalSymbolName.Default) : undefined);
    return resolveSymbolValue(ctx, exported, depth + 1);
  }
  return [e];
}

/** `require('x')` ou `import('x')` com especificador literal. */
function moduleReference(
  e: ts.Expression,
): { specifier: ts.StringLiteralLike; dynamic: boolean } | undefined {
  if (!ts.isCallExpression(e)) return undefined;
  const arg = e.arguments[0];
  if (!arg || !ts.isStringLiteralLike(arg)) return undefined;
  if (e.expression.kind === ts.SyntaxKind.ImportKeyword) return { specifier: arg, dynamic: true };
  if (ts.isIdentifier(e.expression) && e.expression.text === 'require')
    return { specifier: arg, dynamic: false };
  return undefined;
}

function resolveSymbolValue(
  ctx: AnalyzerContext,
  symbol: ts.Symbol | undefined,
  depth: number,
): ts.Node[] {
  if (!symbol || depth > 8) return [];
  let resolved = symbol;
  if (resolved.flags & ts.SymbolFlags.Alias) {
    try {
      resolved = ctx.checker.getAliasedSymbol(resolved);
    } catch {
      return [];
    }
  }
  const out: ts.Node[] = [];
  for (const decl of resolved.declarations ?? []) {
    if (ts.isVariableDeclaration(decl)) {
      const init = decl.initializer && assignedValue(decl.initializer);
      if (
        init &&
        (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init) || moduleReference(init))
      )
        out.push(...resolveValue(ctx, init, depth + 1));
      else out.push(decl);
    } else if (ts.isExportAssignment(decl)) {
      out.push(...resolveValue(ctx, decl.expression, depth + 1));
    } else if (
      ts.isBinaryExpression(decl) &&
      decl.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      out.push(...resolveValue(ctx, decl.right, depth + 1)); // module.exports = router
    } else if (
      ts.isPropertyAccessExpression(decl) &&
      ts.isBinaryExpression(decl.parent) &&
      decl.parent.left === decl &&
      decl.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      out.push(...resolveValue(ctx, decl.parent.right, depth + 1)); // exports.users = router
    } else if (ts.isShorthandPropertyAssignment(decl)) {
      out.push(
        ...resolveSymbolValue(ctx, ctx.checker.getShorthandAssignmentValueSymbol(decl), depth + 1),
      );
    } else if (ts.isPropertyAssignment(decl)) {
      out.push(...resolveValue(ctx, decl.initializer, depth + 1));
    } else if (!ts.isBindingElement(decl)) {
      out.push(decl);
    }
  }
  return out;
}

/**
 * Resolve o dono de rotas de uma expressão. `classify` recebe uma expressão terminal (a própria
 * expressão ou o inicializador de uma variável) e a chave sob a qual ela deve ser registrada.
 * `other` trata declarações que não são variáveis (ex.: o parâmetro de um plugin).
 */
export function resolveOwner(
  ctx: AnalyzerContext,
  expr: ts.Expression,
  classify: (e: ts.Expression, key: ts.Node) => OwnerKey | undefined,
  other?: (decl: ts.Node) => OwnerKey | undefined,
): OwnerKey | undefined {
  const e = unwrapExpression(expr);
  if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e) && !moduleReference(e))
    return guarded(e, () => classify(e, e));
  for (const terminal of resolveValue(ctx, e)) {
    let found: OwnerKey | undefined;
    if (ts.isVariableDeclaration(terminal)) {
      const init = terminal.initializer;
      if (init) found = guarded(terminal, () => classify(assignedValue(init), terminal));
    } else if (ts.isParameter(terminal) || ts.isFunctionLike(terminal)) {
      found = other?.(terminal);
    } else if (terminal !== e) {
      found = guarded(terminal, () => classify(terminal as ts.Expression, terminal));
    }
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Valor de uma atribuição encadeada: em `var app = module.exports = express()` (comum em
 * exemplos CommonJS), o valor de `app` é o de `express()`, o lado direito da última atribuição.
 */
function assignedValue(expr: ts.Expression): ts.Expression {
  let current = unwrapExpression(expr);
  while (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    current = unwrapExpression(current.right);
  return current;
}

/** Nós sendo classificados agora: `const app = app.get(...)` não pode entrar em laço. */
const classifying = new Set<ts.Node>();

function guarded(key: ts.Node, run: () => OwnerKey | undefined): OwnerKey | undefined {
  if (classifying.has(key)) return undefined;
  classifying.add(key);
  try {
    return run();
  } finally {
    classifying.delete(key);
  }
}

/** Identificador mais à esquerda de `app.get(...).post(...)`, para nomear a rota. */
export function receiverName(expr: ts.Expression): string {
  let current = unwrapExpression(expr);
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression))
    current = unwrapExpression(current.expression.expression);
  return referenceText(current);
}

// ---------------------------------------------------------------------------
// literais e caminhos

/** Texto de um literal de string (`'x'`, `"x"`, `` `x` `` sem substituições). */
export function stringLiteral(n: ts.Node | undefined): string | undefined {
  if (!n) return undefined;
  const e = ts.isExpression(n) ? unwrapExpression(n) : n;
  return ts.isStringLiteralLike(e) ? e.text : undefined;
}

/** `'a'` → `['a']`, `['a', 'b']` → os dois; `undefined` se algo não for literal. */
export function stringLiterals(n: ts.Node | undefined): string[] | undefined {
  if (!n) return undefined;
  const e = ts.isExpression(n) ? unwrapExpression(n) : n;
  if (ts.isArrayLiteralExpression(e)) {
    const values = e.elements.map((el) => stringLiteral(el));
    return values.length && values.every((v) => v !== undefined) ? (values as string[]) : undefined;
  }
  const single = stringLiteral(e);
  return single === undefined ? undefined : [single];
}

/** Propriedade `name` de um objeto literal (atribuição ou forma curta). */
export function objectProperty(
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
    const key = prop.name;
    if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === name) return prop;
  }
  return undefined;
}

/** O objeto tem espalhamento (`...opts`) ou chaves calculadas que podem esconder `name`? */
export function hasOpaqueProperties(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some(
    (p) => ts.isSpreadAssignment(p) || (p.name !== undefined && ts.isComputedPropertyName(p.name)),
  );
}

/** Prefixo normalizado: sem barra no fim; `''` é a raiz. */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, '');
  return trimmed === '' || trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** Junta um prefixo e um caminho de rota: `('/api', '/users')` → `/api/users`. */
export function joinPath(prefix: string, routePath: string): string {
  const base = normalizePrefix(prefix);
  if (routePath === '' || routePath === '/') return base || '/';
  return base + (routePath.startsWith('/') ? routePath : `/${routePath}`);
}

const MAX_PREFIXES = 32;

/** Todos os prefixos completos de um dono, compondo montagens aninhadas. */
export function prefixesOf(
  state: RouteState,
  key: OwnerKey,
  visiting: ReadonlySet<OwnerKey> = new Set(),
): PrefixSet {
  const owner = state.owners.get(key);
  if (!owner || visiting.has(key)) return { known: [], unknown: true };
  if (!owner.mounts.length) return owner.base ?? { known: [], unknown: true };
  const next = new Set(visiting).add(key);
  const known = new Set<string>();
  let unknown = false;
  for (const mount of owner.mounts) {
    const parent = prefixesOf(state, mount.parent, next);
    unknown ||= parent.unknown || mount.prefix === undefined;
    if (mount.prefix === undefined) continue;
    for (const p of parent.known) {
      if (known.size >= MAX_PREFIXES) {
        unknown = true;
        break;
      }
      known.add(normalizePrefix(joinPath(p, mount.prefix)));
    }
  }
  return { known: [...known].sort(compareStrings), unknown };
}

// ---------------------------------------------------------------------------
// nós de rota e handlers

export interface RouteInput {
  file: DiscoveredFile;
  framework: Framework;
  /** Receptor usado no id (`app`, `router`, nome do controller, `next`). */
  receiver: string;
  httpMethod: string;
  routePath: string;
  /** Identidade de quem registra a rota (rotas iguais de donos diferentes viram `~2`). */
  identity: unknown;
  /** Dono cujos prefixos compõem o caminho completo. */
  owner?: OwnerKey;
  /** Caminho completo já conhecido (`null` se não pode ser comprovado). */
  fullPath?: string | null;
  /** Prefixo entre a montagem e o caminho local (`basePath` do Hono); `null` = desconhecido. */
  innerPrefix?: string | null;
  at: Node | ts.Node;
  qualifiedName: string;
  meta?: NodeMeta;
}

/** Cria (ou reaproveita) o nó da rota e a relação `contains` a partir do arquivo. */
export function addRoute(state: RouteState, input: RouteInput): string {
  const { ctx } = state;
  const rel = input.file.relative;
  const fileId = nodeId.file(rel);
  const baseId = nodeId.route(rel, input.receiver, input.httpMethod, input.routePath);
  let id = baseId;
  for (let i = 2; state.routeOwners.has(id) && state.routeOwners.get(id) !== input.identity; i++)
    id = `${baseId}~${i}`;
  state.routeOwners.set(id, input.identity);
  if (ctx.builder.hasNode(id)) return id;
  ctx.builder.addNode({
    id,
    kind: 'route',
    name: `${input.httpMethod} ${input.routePath}`,
    qualifiedName: input.qualifiedName,
    parent: fileId,
    location: rangeOf(rel, input.at),
    meta: {
      httpMethod: input.httpMethod,
      routePath: input.routePath,
      framework: input.framework,
      ...input.meta,
    },
  });
  ctx.builder.addEdge({
    kind: 'contains',
    source: fileId,
    target: id,
    resolution: 'resolved',
    discovery: 'framework-rule',
    evidence: evidenceAt(ctx, rel, input.at),
  });
  state.routes.push({
    id,
    httpMethod: input.httpMethod,
    routePath: input.routePath,
    ...(input.owner !== undefined ? { owner: input.owner } : {}),
    ...(input.fullPath !== undefined ? { fullPath: input.fullPath } : {}),
    ...(input.innerPrefix !== undefined ? { innerPrefix: input.innerPrefix } : {}),
  });
  return id;
}

/** Fecha as rotas: caminho completo (`fullPath`) e prefixos de montagem (`mountedAt`). */
export function finishRoutes(state: RouteState): void {
  for (const route of state.routes) {
    const node = state.ctx.builder.getNode(route.id);
    if (!node) continue;
    let fullPath: string | undefined;
    let mountedAt: string[] | undefined;
    if (route.owner !== undefined) {
      const outer = prefixesOf(state, route.owner);
      const inner = route.innerPrefix;
      // prefixo interno desconhecido: nem o caminho completo nem as montagens são comprovados
      const prefixes: PrefixSet =
        inner === null
          ? { known: [], unknown: true }
          : inner
            ? {
                known: [...new Set(outer.known.map((p) => normalizePrefix(joinPath(p, inner))))],
                unknown: outer.unknown,
              }
            : outer;
      if (!prefixes.unknown && prefixes.known.length === 1)
        fullPath = joinPath(prefixes.known[0]!, route.routePath);
      const onlyRoot = !prefixes.unknown && prefixes.known.length === 1 && prefixes.known[0] === '';
      if (prefixes.known.length && !onlyRoot) mountedAt = prefixes.known.map((p) => p || '/');
    } else if (typeof route.fullPath === 'string') {
      fullPath = route.fullPath;
    }
    node.meta = {
      ...node.meta,
      ...(fullPath !== undefined ? { fullPath } : {}),
      ...(mountedAt ? { mountedAt } : {}),
    };
    if (fullPath !== undefined) node.name = `${route.httpMethod} ${fullPath}`;
  }
}

/**
 * Depois das chamadas (passo 2): rotas que dividem um handler inline recebem as mesmas chamadas
 * que a primeira rota dele, com as mesmas evidências.
 */
export function copySharedHandlerCalls(state: RouteState): void {
  const { builder } = state.ctx;
  for (const [primary, siblings] of state.sharedHandlers) {
    const calls = builder
      .edgesFrom(primary)
      .filter((e) => e.kind === 'calls' && e.meta?.callKind !== 'route-handler');
    for (const sibling of siblings) {
      for (const edge of calls) {
        for (const evidence of edge.evidence) {
          builder.addEdge({
            kind: edge.kind,
            source: sibling,
            target: edge.target,
            resolution: edge.resolution,
            discovery: edge.discovery,
            evidence,
            ...(edge.meta?.callKind ? { meta: { callKind: edge.meta.callKind } } : {}),
          });
        }
      }
    }
  }
}

/** Função que atende a rota: inline, ou embrulhada (`asyncHandler(async () => ...)`). */
export function inlineHandler(n: Node): Node | undefined {
  if (Node.isArrowFunction(n) || Node.isFunctionExpression(n)) return n;
  // método de objeto literal: `{ handler(req, reply) { ... } }`
  if (Node.isMethodDeclaration(n) && Node.isObjectLiteralExpression(n.getParent())) return n;
  if (Node.isCallExpression(n)) return wrappedFunction(n);
  return undefined;
}

export const isHandlerLike = (n: Node) =>
  !!inlineHandler(n) || Node.isIdentifier(n) || Node.isPropertyAccessExpression(n);

/**
 * Liga a rota aos seus handlers. Funções inline passam a ter as chamadas atribuídas à rota;
 * referências são resolvidas pelo verificador de tipos (e viram nós não resolvidos sem prova).
 */
export function linkHandlers(
  state: RouteState,
  file: DiscoveredFile,
  routeId: string,
  handlers: Node[],
): void {
  const { ctx } = state;
  for (const handler of handlers) {
    const inline = inlineHandler(handler);
    if (inline) {
      // chamadas feitas dentro do handler inline (ou embrulhado) passam a ser atribuídas à rota
      const previous = ctx.entities.get(inline.compilerNode);
      if (previous === undefined) {
        ctx.entities.set(inline.compilerNode, routeId);
      } else if (previous !== routeId && previous.startsWith('route:')) {
        let siblings = state.sharedHandlers.get(previous);
        if (!siblings) state.sharedHandlers.set(previous, (siblings = new Set()));
        siblings.add(routeId);
      }
      continue;
    }
    const nameNode = Node.isPropertyAccessExpression(handler)
      ? handler.getNameNode()
      : Node.isIdentifier(handler)
        ? handler
        : undefined;
    if (!nameNode) continue;
    linkHandlerSymbol(
      ctx,
      file,
      routeId,
      ctx.checker.getSymbolAtLocation(nameNode.compilerNode),
      handler.compilerNode,
      handler.getText(),
    );
  }
}

/** Liga a rota às entidades de um símbolo; sem prova, cria um nó não resolvido. */
export function linkHandlerSymbol(
  ctx: AnalyzerContext,
  file: DiscoveredFile,
  routeId: string,
  symbol: ts.Symbol | undefined,
  at: ts.Node,
  reference: string,
  unresolvedAllowed = true,
): void {
  const targets = resolveSymbolTargets(ctx, symbol);
  const evidence = evidenceAt(ctx, file.relative, at);
  const entities = [
    ...new Set(
      targets.flatMap((t) => (t.kind === 'entity' ? [t.id] : [])).filter((id) => id !== routeId),
    ),
  ];
  if (entities.length) {
    for (const target of entities) {
      ctx.builder.addEdge({
        kind: 'calls',
        source: routeId,
        target,
        resolution: 'resolved',
        discovery: 'framework-rule',
        evidence,
        meta: { callKind: 'route-handler' },
      });
    }
  } else if (
    unresolvedAllowed &&
    !targets.some((t) => t.kind === 'external') &&
    // função declarada dentro de outra (sem nó próprio, como nas chamadas): existe, não é "sem declaração"
    !targets.every((t) => t.kind === 'local')
  ) {
    const target = addUnresolvedNode(
      ctx,
      file.relative,
      'call',
      reference,
      unresolvedReason(targets),
      at,
    );
    ctx.builder.addEdge({
      kind: 'calls',
      source: routeId,
      target,
      resolution: 'unresolved',
      discovery: 'framework-rule',
      evidence,
      meta: { callKind: 'route-handler' },
    });
  }
}
