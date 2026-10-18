import { Node, SyntaxKind, ts, type Decorator, type SourceFile } from 'ts-morph';
import { compareStrings } from '@rastro/core';
import type { DiscoveredFile } from '../discover.js';
import { descendantsOfKind, evidenceAt, unwrapExpression } from '../analyze.js';
import {
  addRoute,
  frameworkExport,
  hasOpaqueProperties,
  normalizePrefix,
  objectProperty,
  resolveValue,
  stringLiteral,
  stringLiterals,
  type RouteState,
} from './common.js';

const NEST_COMMON = new Set(['@nestjs/common']);
const NEST_CORE = new Set(['@nestjs/core']);
const METHOD_DECORATORS = new Map([
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['Put', 'PUT'],
  ['Patch', 'PATCH'],
  ['Delete', 'DELETE'],
  ['Options', 'OPTIONS'],
  ['Head', 'HEAD'],
  ['All', 'ALL'],
]);

/**
 * Decorator chamado (`@Get(':id')`) que comprovadamente vem de `@nestjs/common`: devolve o nome
 * exportado (`Get`) e a chamada. Decorators homônimos de outros pacotes não contam.
 */
function nestDecorator(
  state: RouteState,
  decorator: Decorator,
): { name: string; call: ts.CallExpression } | undefined {
  const call = decorator.getExpression().compilerNode;
  if (!ts.isCallExpression(call)) return undefined;
  const name = frameworkExport(state.ctx, call.expression, NEST_COMMON);
  return name ? { name, call } : undefined;
}

/**
 * Caminhos de `@Controller(...)`: `()` → raiz, `'users'`, `['a', 'b']`, `{ path: 'users' }`.
 * `undefined` quando o caminho não é literal (a rota não é inventada). `versioned` indica a
 * opção `version`, que muda o caminho conforme a configuração do app.
 */
function controllerPaths(
  call: ts.CallExpression,
): { paths: string[]; versioned: boolean } | undefined {
  const arg = call.arguments[0];
  if (!arg) return { paths: [''], versioned: false };
  const literal = stringLiterals(arg);
  if (literal) return { paths: literal, versioned: false };
  const obj = unwrapExpression(arg);
  if (!ts.isObjectLiteralExpression(obj) || hasOpaqueProperties(obj)) return undefined;
  const versioned = !!objectProperty(obj, 'version');
  const pathProp = objectProperty(obj, 'path');
  if (!pathProp) return { paths: [''], versioned };
  if (!ts.isPropertyAssignment(pathProp)) return undefined;
  const paths = stringLiterals(pathProp.initializer);
  return paths ? { paths, versioned } : undefined;
}

/** `/users` + `:id` → `/users/:id`; tudo vazio → `/`. */
function nestPath(controller: string, method: string): string {
  const parts = [controller, method]
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p !== '');
  return `/${parts.join('/')}`;
}

/** Pasta do app NestJS do arquivo (package.json que declara o Nest), para o prefixo global. */
function nestScope(state: RouteState, file: DiscoveredFile): string {
  const { resolver, root } = state.ctx;
  return (
    resolver.packageDirDeclaring('@nestjs/core', file.absolute) ??
    resolver.packageDirDeclaring('@nestjs/common', file.absolute) ??
    root
  );
}

/**
 * Regra de framework: controllers do NestJS.
 * Uma classe com `@Controller('users')` e métodos com `@Get(':id')`, `@Post()`... (decorators
 * importados de `@nestjs/common`) gera uma rota por método, ligada ao método da classe.
 * `app.setGlobalPrefix('api')` (com `app` vindo de `NestFactory.create`) entra no caminho completo.
 */
export function detectNestRoutes(state: RouteState, file: DiscoveredFile, sf: SourceFile): void {
  if (!sf.getFullText().includes('@nestjs/')) return;
  const scope = `nest:${nestScope(state, file)}`;
  detectGlobalPrefix(state, file, sf);

  for (const cls of descendantsOfKind(sf, SyntaxKind.ClassDeclaration)) {
    let controller: { paths: string[]; versioned: boolean } | undefined;
    for (const decorator of cls.getDecorators()) {
      const found = nestDecorator(state, decorator);
      if (found?.name !== 'Controller') continue;
      controller = controllerPaths(found.call);
      break;
    }
    if (!controller) continue;
    const className = cls.getName() ?? 'default';
    state.owner(scope);

    for (const method of cls.getMethods()) {
      const entity = state.ctx.entities.get(method.compilerNode);
      for (const decorator of method.getDecorators()) {
        const found = nestDecorator(state, decorator);
        const httpMethod = found && METHOD_DECORATORS.get(found.name);
        if (!found || !httpMethod) continue;
        const arg = found.call.arguments[0];
        const methodPaths = arg ? stringLiterals(arg) : [''];
        if (!methodPaths) continue;
        for (const controllerPath of controller.paths) {
          for (const methodPath of methodPaths) {
            const routePath = nestPath(controllerPath, methodPath);
            const id = addRoute(state, {
              file,
              framework: 'nestjs',
              receiver: className,
              httpMethod,
              routePath,
              identity: cls.compilerNode,
              // com `version`, o caminho real depende da configuração de versionamento
              ...(controller.versioned ? { fullPath: null } : { owner: scope }),
              at: decorator,
              qualifiedName: `${className}.${method.getName()}`,
            });
            if (!entity) continue;
            state.ctx.builder.addEdge({
              kind: 'calls',
              source: id,
              target: entity,
              resolution: 'resolved',
              discovery: 'framework-rule',
              evidence: evidenceAt(state.ctx, file.relative, method.getNameNode()),
              meta: { callKind: 'route-handler' },
            });
          }
        }
      }
    }
  }
}

/** `app.setGlobalPrefix('api')` em um app criado por `NestFactory.create(...)`. */
function detectGlobalPrefix(state: RouteState, file: DiscoveredFile, sf: SourceFile): void {
  if (!sf.getFullText().includes('setGlobalPrefix')) return;
  for (const call of descendantsOfKind(sf, SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'setGlobalPrefix')
      continue;
    const isNestApp = resolveValue(state.ctx, callee.getExpression().compilerNode).some((decl) => {
      if (!ts.isVariableDeclaration(decl) || !decl.initializer) return false;
      const init = unwrapExpression(decl.initializer);
      if (!ts.isCallExpression(init) || !ts.isPropertyAccessExpression(init.expression))
        return false;
      const factory = init.expression;
      return (
        factory.name.text === 'create' &&
        frameworkExport(state.ctx, factory.expression, NEST_CORE) === 'NestFactory'
      );
    });
    if (!isNestApp) continue;
    const [prefixArg, options] = call.compilerNode.arguments;
    const literal = stringLiteral(prefixArg);
    // `exclude` tira algumas rotas do prefixo: sem saber quais, o prefixo fica desconhecido
    const prefix = literal === undefined || options ? undefined : normalizePrefix(literal);
    const scope = nestScope(state, file);
    const list = state.nestPrefixes.get(scope) ?? [];
    list.push(prefix);
    state.nestPrefixes.set(scope, list);
  }
}

/** Define o prefixo de cada app NestJS: o global (se houver) ou a raiz. */
export function finishNest(state: RouteState): void {
  for (const [key, owner] of state.owners) {
    if (typeof key !== 'string' || !key.startsWith('nest:')) continue;
    const prefixes = state.nestPrefixes.get(key.slice('nest:'.length));
    if (!prefixes?.length) {
      owner.base = { known: [''], unknown: false };
      continue;
    }
    const known = [...new Set(prefixes.filter((p): p is string => p !== undefined))].sort(
      compareStrings,
    );
    owner.base = { known, unknown: prefixes.some((p) => p === undefined) };
  }
}
