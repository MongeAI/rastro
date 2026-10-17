import { Node, SyntaxKind, ts, type SourceFile } from 'ts-morph';
import { nodeId } from '@rastro/core';
import type { DiscoveredFile } from './discover.js';
import {
  addUnresolvedNode,
  descendantsOfKind,
  moduleSpecifierOfAlias,
  wrappedFunction,
  evidenceAt,
  rangeOf,
  resolveSymbolTargets,
  unresolvedReason,
  type AnalyzerContext,
} from './analyze.js';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);

/** O identificador vem (por import/require, sem ser só de tipo) do pacote `express`? */
function comesFromExpress(ctx: AnalyzerContext, identifier: ts.Node): boolean {
  const symbol = ctx.checker.getSymbolAtLocation(identifier);
  const decl = symbol?.declarations?.[0];
  if (!decl) return false;
  if (ts.isImportSpecifier(decl) && (decl.isTypeOnly || decl.parent.parent.isTypeOnly))
    return false;
  if (ts.isImportClause(decl) && decl.isTypeOnly) return false;
  return moduleSpecifierOfAlias(decl) === 'express';
}

/** `express()`, `e()`, `express.Router()`, `Router()`, `R()` (alias), `require('express')()`. */
function isExpressFactory(ctx: AnalyzerContext, call: ts.CallExpression): boolean {
  let callee: ts.Expression = call.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (ts.isIdentifier(callee)) return comesFromExpress(ctx, callee);
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'Router' &&
    ts.isIdentifier(callee.expression)
  )
    return comesFromExpress(ctx, callee.expression);
  // require('express')()
  if (
    ts.isCallExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'require' &&
    callee.arguments[0] &&
    ts.isStringLiteralLike(callee.arguments[0])
  )
    return callee.arguments[0].text === 'express';
  return false;
}

/**
 * Declaração do receptor (`app`, `router`...) quando ele comprovadamente foi criado por uma
 * fábrica do Express. Segue imports/requires até a variável. Devolve `undefined` caso contrário.
 */
function expressReceiverDeclaration(ctx: AnalyzerContext, receiver: Node): ts.Node | undefined {
  let symbol = ctx.checker.getSymbolAtLocation(receiver.compilerNode);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = ctx.checker.getAliasedSymbol(symbol);
    } catch {
      return undefined;
    }
  }
  for (const decl of symbol.declarations ?? []) {
    if (!ts.isVariableDeclaration(decl) || !decl.initializer) continue;
    let init: ts.Expression = decl.initializer;
    while (ts.isParenthesizedExpression(init) || ts.isAwaitExpression(init)) init = init.expression;
    if (ts.isCallExpression(init) && isExpressFactory(ctx, init)) return decl;
  }
  return undefined;
}

/** Função que atende a rota: inline, referência, ou embrulhada (`asyncHandler(async () => ...)`). */
function handlerFunction(n: Node): Node | undefined {
  if (Node.isArrowFunction(n) || Node.isFunctionExpression(n)) return n;
  if (Node.isCallExpression(n)) return wrappedFunction(n);
  return undefined;
}

const isHandlerLike = (n: Node) =>
  !!handlerFunction(n) || Node.isIdentifier(n) || Node.isPropertyAccessExpression(n);

/**
 * Regra de framework suportada: rotas do Express.
 * Reconhece `app.get('/caminho', handler)`, `router.post(...)` etc. somente quando o receptor
 * comprovadamente vem de `express()` ou `express.Router()`, o caminho é um texto literal
 * começando com `/` e há ao menos um handler (função ou referência a uma).
 */
export function detectExpressRoutes(
  ctx: AnalyzerContext,
  file: DiscoveredFile,
  sf: SourceFile,
): void {
  const fileId = nodeId.file(file.relative);
  const routeOwners = new Map<string, ts.Node>();

  for (const call of descendantsOfKind(sf, SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const method = callee.getName().toLowerCase();
    if (!HTTP_METHODS.has(method)) continue;
    const receiver = callee.getExpression();
    if (!Node.isIdentifier(receiver)) continue;
    const [first, ...handlers] = call.getArguments();
    if (!first || !(Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first)))
      continue;
    const routePath = first.getLiteralValue();
    if (!routePath.startsWith('/') || !handlers.some(isHandlerLike)) continue;
    const receiverDecl = expressReceiverDeclaration(ctx, receiver);
    if (!receiverDecl) continue;

    const httpMethod = method.toUpperCase();
    const receiverName = receiver.getText();
    // dois roteadores com o mesmo nome (em funções diferentes) não podem virar uma rota só
    const baseId = nodeId.route(file.relative, receiverName, httpMethod, routePath);
    let id = baseId;
    for (let i = 2; routeOwners.has(id) && routeOwners.get(id) !== receiverDecl; i++)
      id = `${baseId}~${i}`;
    routeOwners.set(id, receiverDecl);
    if (!ctx.builder.hasNode(id)) {
      ctx.builder.addNode({
        id,
        kind: 'route',
        name: `${httpMethod} ${routePath}`,
        qualifiedName: `${receiverName}.${method}('${routePath}')`,
        parent: fileId,
        location: rangeOf(file.relative, call),
        meta: { httpMethod, routePath, framework: 'express' },
      });
      ctx.builder.addEdge({
        kind: 'contains',
        source: fileId,
        target: id,
        resolution: 'resolved',
        discovery: 'framework-rule',
        evidence: evidenceAt(ctx, file.relative, call),
      });
    }

    for (const handler of handlers) {
      const inline = handlerFunction(handler);
      if (inline) {
        // chamadas feitas dentro do handler inline (ou embrulhado) passam a ser atribuídas à rota
        ctx.entities.set(inline.compilerNode, id);
        continue;
      }
      const nameNode = Node.isPropertyAccessExpression(handler)
        ? handler.getNameNode()
        : Node.isIdentifier(handler)
          ? handler
          : undefined;
      if (!nameNode) continue;
      const targets = resolveSymbolTargets(
        ctx,
        ctx.checker.getSymbolAtLocation(nameNode.compilerNode),
      );
      const evidence = evidenceAt(ctx, file.relative, handler);
      const entities = targets.filter(
        (t): t is { kind: 'entity'; id: string } => t.kind === 'entity',
      );
      if (entities.length) {
        for (const t of entities) {
          ctx.builder.addEdge({
            kind: 'calls',
            source: id,
            target: t.id,
            resolution: 'resolved',
            discovery: 'framework-rule',
            evidence,
            meta: { callKind: 'route-handler' },
          });
        }
      } else if (!targets.some((t) => t.kind === 'external')) {
        const target = addUnresolvedNode(
          ctx,
          file.relative,
          'call',
          handler.getText(),
          unresolvedReason(targets),
          handler,
        );
        ctx.builder.addEdge({
          kind: 'calls',
          source: id,
          target,
          resolution: 'unresolved',
          discovery: 'framework-rule',
          evidence,
          meta: { callKind: 'route-handler' },
        });
      }
    }
  }
}
