import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import { nodeId } from '@teia/core';
import type { DiscoveredFile } from './discover.js';
import {
  addUnresolvedNode,
  evidenceAt,
  rangeOf,
  resolveSymbolTargets,
  type AnalyzerContext,
} from './analyze.js';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);
const ROUTER_NAME = /^(app|api|router|server|routes|\w*router)$/i;

function importsExpress(sf: SourceFile): boolean {
  if (sf.getImportDeclarations().some((d) => d.getModuleSpecifierValue() === 'express'))
    return true;
  return sf
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .some(
      (c) =>
        c.getExpression().getText() === 'require' &&
        c.getArguments()[0]?.getText().slice(1, -1) === 'express',
    );
}

const projectCache = new WeakMap<AnalyzerContext, boolean>();

/**
 * Regra de framework suportada no MVP: rotas do Express.
 * Reconhece `app.get('/caminho', handler)`, `router.post(...)` etc. quando:
 * - o arquivo importa `express`; ou
 * - o projeto usa `express` e o receptor tem nome típico de roteador (`app`, `router`, `xxxRouter`).
 * O primeiro argumento precisa ser um texto literal começando com `/`.
 */
export function detectExpressRoutes(
  ctx: AnalyzerContext,
  file: DiscoveredFile,
  sf: SourceFile,
): void {
  if (!projectCache.has(ctx)) {
    projectCache.set(
      ctx,
      [...ctx.filesByAbs.keys()].some((abs) => {
        const other = sf.getProject().getSourceFile(abs);
        return !!other && importsExpress(other);
      }),
    );
  }
  if (!projectCache.get(ctx)) return;
  const fileImportsExpress = importsExpress(sf);
  const fileId = nodeId.file(file.relative);

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const method = callee.getName().toLowerCase();
    if (!HTTP_METHODS.has(method)) continue;
    const receiver = callee.getExpression();
    if (!Node.isIdentifier(receiver)) continue;
    if (!fileImportsExpress && !ROUTER_NAME.test(receiver.getText())) continue;
    const [first, ...handlers] = call.getArguments();
    if (!first || !(Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first)))
      continue;
    const routePath = first.getLiteralValue();
    if (!routePath.startsWith('/') || handlers.length === 0) continue;

    const httpMethod = method.toUpperCase();
    const id = nodeId.route(file.relative, httpMethod, routePath);
    if (!ctx.builder.hasNode(id)) {
      ctx.builder.addNode({
        id,
        kind: 'route',
        name: `${httpMethod} ${routePath}`,
        qualifiedName: `${receiver.getText()}.${method}('${routePath}')`,
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
          targets.some((t) => t.kind === 'indirect') ? 'indirect-call' : 'symbol-not-found',
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
