import { Node, SyntaxKind, ts, type SourceFile } from 'ts-morph';
import { nodeId } from '@teia/core';
import type { DiscoveredFile } from './discover.js';
import {
  addUnresolvedNode,
  descendantsOfKind,
  evidenceAt,
  rangeOf,
  resolveSymbolTargets,
  unresolvedReason,
  type AnalyzerContext,
} from './analyze.js';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);

/** Chamadas que criam um app/roteador Express: `express()`, `express.Router()`, `Router()`. */
const EXPRESS_FACTORIES = new Set([
  'express',
  'express.Router',
  'Router',
  "require('express')",
  'require("express")',
]);

function importsExpress(sf: SourceFile): boolean {
  if (sf.getImportDeclarations().some((d) => d.getModuleSpecifierValue() === 'express'))
    return true;
  return descendantsOfKind(sf, SyntaxKind.CallExpression).some(
    (c) =>
      c.getExpression().getText() === 'require' &&
      c.getArguments()[0]?.getText().slice(1, -1) === 'express',
  );
}

/**
 * O receptor (`app`, `router`...) foi criado por `express()`/`express.Router()` em um arquivo
 * que importa o Express? Segue imports/requires até a declaração da variável.
 */
function isExpressReceiver(ctx: AnalyzerContext, receiver: Node): boolean {
  let symbol = ctx.checker.getSymbolAtLocation(receiver.compilerNode);
  if (!symbol) return false;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = ctx.checker.getAliasedSymbol(symbol);
    } catch {
      return false;
    }
  }
  for (const decl of symbol.declarations ?? []) {
    if (!ts.isVariableDeclaration(decl) || !decl.initializer) continue;
    let init: ts.Expression = decl.initializer;
    while (ts.isParenthesizedExpression(init) || ts.isAwaitExpression(init)) init = init.expression;
    if (!ts.isCallExpression(init)) continue;
    const callee = init.expression.getText(decl.getSourceFile()).replace(/\s+/g, '');
    if (!EXPRESS_FACTORIES.has(callee)) continue;
    const declFile = ctx.filesByAbs.get(decl.getSourceFile().fileName);
    const declSf = declFile && receiver.getProject().getSourceFile(declFile.absolute);
    if (declSf && importsExpress(declSf)) return true;
  }
  return false;
}

const isHandlerLike = (n: Node) =>
  Node.isArrowFunction(n) ||
  Node.isFunctionExpression(n) ||
  Node.isIdentifier(n) ||
  Node.isPropertyAccessExpression(n);

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
    if (!isExpressReceiver(ctx, receiver)) continue;

    const httpMethod = method.toUpperCase();
    const receiverName = receiver.getText();
    const id = nodeId.route(file.relative, receiverName, httpMethod, routePath);
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
      if (Node.isArrowFunction(handler) || Node.isFunctionExpression(handler)) {
        // chamadas feitas dentro do handler inline passam a ser atribuídas à rota
        ctx.entities.set(handler.compilerNode, id);
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
