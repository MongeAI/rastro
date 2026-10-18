import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateGraph, type GraphEdge, type GraphNode, type RastroGraph } from '@rastro/core';
import { analyzeProject } from '@rastro/analyzer';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const fixture = (name: string) => path.join(fixtures, name);

const edge = (
  g: RastroGraph,
  kind: string,
  source: string,
  target: string,
): GraphEdge | undefined =>
  g.edges.find((e) => e.kind === kind && e.source === source && e.target === target);
const node = (g: RastroGraph, id: string) => g.nodes.find((n) => n.id === id);
const routes = (g: RastroGraph): GraphNode[] => g.nodes.filter((n) => n.kind === 'route');
const routeIds = (g: RastroGraph) => routes(g).map((n) => n.id);
const routeNames = (g: RastroGraph) =>
  routes(g)
    .map((n) => n.name)
    .sort();
const handler = (g: RastroGraph, route: string, target: string) => {
  const e = edge(g, 'calls', route, target);
  return e && { resolution: e.resolution, discovery: e.discovery, callKind: e.meta?.callKind };
};
const ROUTE_HANDLER = {
  resolution: 'resolved',
  discovery: 'framework-rule',
  callKind: 'route-handler',
};

/** Cria um projeto temporário com os arquivos indicados (sem node_modules). */
function makeProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-routes-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

/** Os fixtures não podem depender de pacotes instalados: a análise funciona sem eles. */
function expectNoNodeModules(name: string): void {
  expect(fs.existsSync(path.join(fixture(name), 'node_modules'))).toBe(false);
}

describe('Express com prefixos de montagem (express-mounted)', () => {
  let g: RastroGraph;
  beforeAll(async () => {
    expectNoNodeModules('express-mounted');
    g = await analyzeProject(fixture('express-mounted'));
  });

  it('é um grafo válido', () => {
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
  });

  it('compõe montagens aninhadas entre arquivos (app → /api → /users)', () => {
    const list = node(g, 'route:src/routes/users.js#router GET /');
    expect(list?.name).toBe('GET /api/users');
    expect(list?.meta).toMatchObject({
      framework: 'express',
      httpMethod: 'GET',
      routePath: '/',
      fullPath: '/api/users',
      mountedAt: ['/api/users'],
    });
    expect(node(g, 'route:src/routes/users.js#router GET /:id')?.meta?.fullPath).toBe(
      '/api/users/:id',
    );
  });

  it('rotas do app (sem montagem) têm o caminho completo igual ao local', () => {
    const health = node(g, 'route:src/app.js#app GET /health');
    expect(health?.name).toBe('GET /health');
    expect(health?.meta?.fullPath).toBe('/health');
    expect(health?.meta?.mountedAt).toBeUndefined();
    expect(handler(g, health!.id, 'fn:src/handlers/health.js#health')).toEqual(ROUTE_HANDLER);
  });

  it('roteador montado em dois prefixos: registra os dois e não escolhe um para o nome', () => {
    const stats = node(g, 'route:src/routes/admin.js#admin GET /stats');
    expect(stats?.name).toBe('GET /stats');
    expect(stats?.meta?.fullPath).toBeUndefined();
    expect(stats?.meta?.mountedAt).toEqual(['/api/admin', '/backoffice']);
  });

  it('roteador nunca montado mantém só o caminho local', () => {
    const lost = node(g, 'route:src/routes/orphan.js#orphan GET /lost');
    expect(lost?.name).toBe('GET /lost');
    expect(lost?.meta?.fullPath).toBeUndefined();
    expect(lost?.meta?.mountedAt).toBeUndefined();
  });

  it('router.route("/x").get(...).put(...) gera uma rota por método', () => {
    const get = 'route:src/routes/users.js#router GET /:id/avatar';
    const put = 'route:src/routes/users.js#router PUT /:id/avatar';
    expect(node(g, get)?.name).toBe('GET /api/users/:id/avatar');
    expect(node(g, put)?.name).toBe('PUT /api/users/:id/avatar');
    expect(handler(g, get, 'fn:src/handlers/users.js#getUser')).toEqual(ROUTE_HANDLER);
    // chamada feita dentro do handler inline é atribuída à rota
    expect(edge(g, 'calls', put, 'fn:src/handlers/users.js#saveAvatar')?.meta?.callKind).toBe(
      'call',
    );
  });

  it('express.json() e outros middlewares não viram montagens nem rotas', () => {
    expect(routeIds(g)).toHaveLength(7);
  });
});

describe('Fastify (fastify-api)', () => {
  let g: RastroGraph;
  beforeAll(async () => {
    expectNoNodeModules('fastify-api');
    g = await analyzeProject(fixture('fastify-api'));
  });

  it('é um grafo válido', () => {
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
  });

  it('detecta métodos, opções, route() e plugins com prefixo', () => {
    expect(routeNames(g)).toEqual([
      'DELETE /v1/users/admin/:id',
      'GET /health',
      'GET /status',
      'GET /v1/users',
      'GET /v1/users/:id',
      'GET /version',
      'HEAD /status',
      'POST /auth/login',
    ]);
    expect(routes(g).every((r) => r.meta?.framework === 'fastify')).toBe(true);
  });

  it('liga handlers por referência, inclusive dentro do objeto de opções', () => {
    expect(handler(g, 'route:src/server.ts#app GET /health', 'fn:src/handlers.ts#health')).toEqual(
      ROUTE_HANDLER,
    );
    expect(
      handler(g, 'route:src/routes/users.ts#app DELETE /:id', 'fn:src/handlers.ts#removeUser'),
    ).toEqual(ROUTE_HANDLER);
    expect(handler(g, 'route:src/server.ts#app HEAD /status', 'fn:src/handlers.ts#health')).toEqual(
      ROUTE_HANDLER,
    );
  });

  it('plugin registrado em outro arquivo recebe o prefixo, inclusive aninhado', () => {
    const list = node(g, 'route:src/routes/users.ts#fastify GET /');
    expect(list?.meta).toMatchObject({
      routePath: '/',
      fullPath: '/v1/users',
      mountedAt: ['/v1/users'],
    });
    expect(node(g, 'route:src/routes/users.ts#app DELETE /:id')?.meta?.fullPath).toBe(
      '/v1/users/admin/:id',
    );
  });

  it('chamadas do handler inline de um plugin inline são atribuídas à rota', () => {
    expect(
      edge(g, 'calls', 'route:src/server.ts#instance POST /login', 'fn:src/handlers.ts#login'),
    ).toBeDefined();
  });
});

describe('Hono (hono-api)', () => {
  let g: RastroGraph;
  beforeAll(async () => {
    expectNoNodeModules('hono-api');
    g = await analyzeProject(fixture('hono-api'));
  });

  it('é um grafo válido', () => {
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
  });

  it('detecta rotas, encadeamentos, app.on e prefixos de route() e basePath()', () => {
    expect(routeNames(g)).toEqual([
      'GET /api/echo',
      'GET /health',
      'GET /users',
      'GET /users/:id',
      'POST /api/echo',
      'POST /users',
    ]);
    expect(routes(g).every((r) => r.meta?.framework === 'hono')).toBe(true);
  });

  it('sub-app importado de outro arquivo é montado com app.route', () => {
    const get = node(g, 'route:src/users.ts#users GET /:id');
    expect(get?.meta).toMatchObject({ routePath: '/:id', fullPath: '/users/:id' });
    expect(handler(g, get!.id, 'fn:src/handlers.ts#getUser')).toEqual(ROUTE_HANDLER);
  });

  it('um handler inline de vários métodos atribui as chamadas a todas as rotas', () => {
    for (const method of ['GET', 'POST'])
      expect(
        edge(g, 'calls', `route:src/index.ts#api ${method} /echo`, 'fn:src/handlers.ts#echo'),
      ).toBeDefined();
  });
});

describe('NestJS (nest-api)', () => {
  let g: RastroGraph;
  beforeAll(async () => {
    expectNoNodeModules('nest-api');
    g = await analyzeProject(fixture('nest-api'));
  });

  it('é um grafo válido e sem erros de sintaxe (decorators de parâmetro)', () => {
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
    expect(g.diagnostics.filter((d) => d.code === 'syntax-error')).toEqual([]);
  });

  it('gera uma rota por método decorado, com o caminho do controller', () => {
    expect(routeIds(g).sort()).toEqual([
      'route:src/health.controller.ts#HealthController GET /health',
      'route:src/users/users.controller.ts#UsersController DELETE /users/:id',
      'route:src/users/users.controller.ts#UsersController GET /users',
      'route:src/users/users.controller.ts#UsersController GET /users/:id',
      'route:src/users/users.controller.ts#UsersController POST /users',
    ]);
  });

  it('liga a rota ao método da classe', () => {
    expect(
      handler(
        g,
        'route:src/users/users.controller.ts#UsersController GET /users/:id',
        'method:src/users/users.controller.ts#UsersController.findOne',
      ),
    ).toEqual(ROUTE_HANDLER);
  });

  it('o prefixo global (app.setGlobalPrefix) entra no caminho completo', () => {
    const one = node(g, 'route:src/users/users.controller.ts#UsersController GET /users/:id');
    expect(one?.name).toBe('GET /api/users/:id');
    expect(one?.meta).toMatchObject({
      framework: 'nestjs',
      routePath: '/users/:id',
      fullPath: '/api/users/:id',
      mountedAt: ['/api'],
    });
  });

  it('o export de uma classe com decorator aponta para a linha do export', () => {
    const exported = edge(
      g,
      'exports',
      'file:src/app.module.ts',
      'class:src/app.module.ts#AppModule',
    );
    expect(exported?.evidence[0]).toMatchObject({
      line: 7,
      snippet: 'export class AppModule {}',
    });
    // a classe continua começando no decorator (mudar o decorator é mudar a classe)
    expect(node(g, 'class:src/app.module.ts#AppModule')?.location?.startLine).toBe(6);
  });
});

describe('Next.js (next-app)', () => {
  let g: RastroGraph;
  beforeAll(async () => {
    expectNoNodeModules('next-app');
    g = await analyzeProject(fixture('next-app'));
  });

  it('é um grafo válido', () => {
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
  });

  it('App Router e Pages Router: segmentos dinâmicos, grupos e pastas ignoradas', () => {
    expect(routeNames(g)).toEqual([
      'ALL /api/hello',
      'DELETE /api/items/:id',
      'GET /',
      'GET /about',
      'GET /api/items/:id',
      'GET /api/users',
      'GET /blog/:slug',
      'GET /docs/*path',
      'GET /legacy',
      'GET /posts/:id',
      'GET /shop/*filters?',
      'POST /api/users',
    ]);
  });

  it('página liga ao componente do export padrão, com tipo e caminho completo', () => {
    const page = node(g, 'route:app/blog/[slug]/page.tsx#next GET /blog/:slug');
    expect(page?.meta).toMatchObject({
      framework: 'next',
      routeKind: 'page',
      routePath: '/blog/:slug',
      fullPath: '/blog/:slug',
    });
    expect(handler(g, page!.id, 'fn:app/blog/[slug]/page.tsx#Post')).toEqual(ROUTE_HANDLER);
  });

  it('route.ts: uma rota por função exportada com nome de método HTTP', () => {
    const get = 'route:app/api/users/route.ts#next GET /api/users';
    expect(node(g, get)?.meta?.routeKind).toBe('api');
    expect(handler(g, get, 'fn:app/api/users/route.ts#GET')).toEqual(ROUTE_HANDLER);
    // `dynamic` e `helper` não são métodos HTTP
    expect(routeIds(g).filter((id) => id.startsWith('route:app/api/users/'))).toHaveLength(2);
  });

  it('export { handler as GET } liga à função de outro arquivo', () => {
    expect(
      handler(
        g,
        'route:app/api/items/[id]/route.ts#next GET /api/items/:id',
        'fn:lib/items.ts#itemHandler',
      ),
    ).toEqual(ROUTE_HANDLER);
  });

  it('pages/api é rota de API (ALL) ligada ao export padrão', () => {
    const api = node(g, 'route:pages/api/hello.ts#next ALL /api/hello');
    expect(api?.meta).toMatchObject({ routeKind: 'api', httpMethod: 'ALL' });
    expect(handler(g, api!.id, 'fn:pages/api/hello.ts#handler')).toEqual(ROUTE_HANDLER);
  });

  it('não cria rotas para layout, _app, _document, pastas privadas, slots, interceptações e components/', () => {
    const files = new Set(routes(g).map((r) => r.location?.file));
    for (const file of [
      'app/layout.tsx',
      'app/_drafts/page.tsx',
      'app/@modal/page.tsx',
      'app/photos/(.)[id]/page.tsx',
      'pages/_app.tsx',
      'pages/_document.tsx',
      'components/page.tsx',
    ])
      expect(files.has(file)).toBe(false);
  });
});

describe('regra da casa: nenhuma rota inventada', () => {
  it('Fastify, Hono e NestJS homônimos de outros pacotes não geram rotas', async () => {
    const root = makeProject({
      'package.json':
        '{"dependencies":{"fastify-lookalike":"1","my-hono":"1","routing-controllers":"1","hono":"4"}}',
      'a.ts':
        "import fastify from 'fastify-lookalike';\nconst app = fastify();\nfunction h() {}\napp.get('/a', h);",
      'b.ts':
        "import { Hono } from 'my-hono';\nconst app = new Hono();\nfunction h() {}\napp.get('/b', h);",
      'c.ts': [
        "import { Controller, Get } from 'routing-controllers';",
        "@Controller('/c')",
        'export class C {',
        "  @Get('/x')",
        '  x() {}',
        '}',
      ].join('\n'),
      // o cliente RPC do Hono não é um app
      'd.ts':
        "import { hc } from 'hono/client';\nconst client = hc('/');\nclient.get('/d', () => 1);",
    });
    const g = await analyzeProject(root);
    expect(routeIds(g)).toEqual([]);
  });

  it('funções locais com o nome do framework não contam', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"fastify":"5","hono":"4"}}',
      'a.ts': [
        'function fastify() { return { get(_p: string, _h: unknown) {} }; }',
        'class Hono { get(_p: string, _h: unknown) {} }',
        'const app = fastify();',
        'const h = new Hono();',
        'function handler() {}',
        "app.get('/a', handler);",
        "h.get('/b', handler);",
      ].join('\n'),
    });
    expect(routeIds(await analyzeProject(root))).toEqual([]);
  });

  it('imports só de tipo não provam o framework', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"fastify":"5","hono":"4","@nestjs/common":"11"}}',
      'a.ts': [
        "import type { FastifyInstance } from 'fastify';",
        "import type { Hono } from 'hono';",
        'function handler() {}',
        // parâmetro tipado como instância, mas o plugin nunca é registrado
        "export function routes(app: FastifyInstance) { app.get('/a', handler); }",
        "export function more(app: Hono) { app.get('/b', handler); }",
      ].join('\n'),
      'b.ts': [
        "import { type Controller, type Get } from '@nestjs/common';",
        "@Controller('c')",
        'export class C {',
        "  @Get('x')",
        '  x() {}',
        '}',
      ].join('\n'),
    });
    expect(routeIds(await analyzeProject(root))).toEqual([]);
  });

  it('Fastify: plugin registrado em algo que não é Fastify não gera rotas', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"fastify":"5"}}',
      'a.ts': [
        "import Fastify from 'fastify';",
        'const app = Fastify();',
        'const registry = { register(_p: unknown) {} };',
        'function handler() {}',
        "async function plugin(instance: any) { instance.get('/fake', handler); }",
        "async function real(instance: any) { instance.get('/real', handler); }",
        'registry.register(plugin);',
        'app.register(real);',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expect(routeIds(g)).toEqual(['route:a.ts#instance GET /real']);
    // sem opções, o plugin fica na raiz da instância
    expect(node(g, 'route:a.ts#instance GET /real')?.meta?.fullPath).toBe('/real');
  });

  it('prefixos não literais: a rota existe, mas o caminho completo não é inventado', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"express":"5","fastify":"5"}}',
      'express.js': [
        "const express = require('express');",
        "const prefix = process.env.PREFIX || '/api';",
        'const app = express();',
        'const r = express.Router();',
        "r.get('/x', (req, res) => res.end());",
        'app.use(prefix, r);',
      ].join('\n'),
      'fastify.ts': [
        "import Fastify from 'fastify';",
        'const app = Fastify();',
        'const opts = { prefix: process.env.PREFIX };',
        "app.register(async (i) => { i.get('/y', async () => 1); }, opts);",
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expect(routeNames(g)).toEqual(['GET /x', 'GET /y']);
    for (const r of routes(g)) expect(r.meta?.fullPath).toBeUndefined();
  });

  it('NestJS: caminho de controller não literal não gera rotas; com version não há caminho completo', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"@nestjs/common":"11"}}',
      'tsconfig.json': '{"compilerOptions":{"experimentalDecorators":true}}',
      'a.ts': [
        "import { Controller, Get } from '@nestjs/common';",
        "const PATH = 'users';",
        '@Controller(PATH)',
        'export class A {',
        '  @Get()',
        '  list() {}',
        '}',
        "@Controller({ path: 'items', version: '1' })",
        'export class B {',
        "  @Get(':id')",
        '  one() {}',
        '}',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expect(routeIds(g)).toEqual(['route:a.ts#B GET /items/:id']);
    expect(node(g, 'route:a.ts#B GET /items/:id')?.meta?.fullPath).toBeUndefined();
  });

  it('NestJS: setGlobalPrefix fora de um app do NestFactory é ignorado', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"@nestjs/common":"11","@nestjs/core":"11"}}',
      'a.ts': [
        "import { Controller, Get } from '@nestjs/common';",
        "@Controller('users')",
        'export class A {',
        '  @Get()',
        '  list() {}',
        '}',
        'const fake = { setGlobalPrefix(_p: string) {} };',
        "fake.setGlobalPrefix('nope');",
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expect(node(g, 'route:a.ts#A GET /users')?.meta?.fullPath).toBe('/users');
  });

  it('NestJS: controller de biblioteca do monorepo não herda o prefixo global de outro app', async () => {
    const root = makeProject({
      'package.json': '{"private":true,"workspaces":["apps/*","libs/*"]}',
      'apps/api/package.json': '{"dependencies":{"@nestjs/core":"11","@nestjs/common":"11"}}',
      'apps/api/src/main.ts': [
        "import { NestFactory } from '@nestjs/core';",
        'async function boot() {',
        '  const app = await NestFactory.create({});',
        "  app.setGlobalPrefix('api');",
        '}',
      ].join('\n'),
      'apps/api/src/health.controller.ts': [
        "import { Controller, Get } from '@nestjs/common';",
        "@Controller('health')",
        'export class HealthController {',
        '  @Get()',
        '  ok() {}',
        '}',
      ].join('\n'),
      'libs/users/package.json': '{"peerDependencies":{"@nestjs/common":"11"}}',
      'libs/users/src/users.controller.ts': [
        "import { Controller, Get } from '@nestjs/common';",
        "@Controller('users')",
        'export class UsersController {',
        '  @Get()',
        '  list() {}',
        '}',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    // mesmo app do setGlobalPrefix: comprovado
    expect(
      node(g, 'route:apps/api/src/health.controller.ts#HealthController GET /health')?.meta
        ?.fullPath,
    ).toBe('/api/health');
    // a biblioteca pode ser usada pelo app com prefixo: o caminho completo não é afirmado
    const users = node(g, 'route:libs/users/src/users.controller.ts#UsersController GET /users');
    expect(users?.meta?.routePath).toBe('/users');
    expect(users?.meta?.fullPath).toBeUndefined();
    expect(users?.name).toBe('GET /users');
  });

  it('NestJS: RouterModule, enableVersioning e @Version deixam o caminho completo desconhecido', async () => {
    const controller = [
      "import { Controller, Get } from '@nestjs/common';",
      "@Controller('stats')",
      'export class AdminController {',
      '  @Get()',
      '  list() {}',
      '}',
    ].join('\n');
    const variants: Record<string, string> = {
      'app.module.ts': [
        "import { Module } from '@nestjs/common';",
        "import { RouterModule } from '@nestjs/core';",
        "@Module({ imports: [RouterModule.register([{ path: 'admin', module: AppModule }])] })",
        'export class AppModule {}',
      ].join('\n'),
      'main.ts': [
        "import { NestFactory } from '@nestjs/core';",
        'async function boot() {',
        '  const app = await NestFactory.create({});',
        "  app.enableVersioning({ type: 1, defaultVersion: '1' });",
        '}',
      ].join('\n'),
      'other.controller.ts': [
        "import { Controller, Get, Version } from '@nestjs/common';",
        "@Controller('other')",
        'export class OtherController {',
        "  @Version('2')",
        '  @Get()',
        '  get() {}',
        '}',
      ].join('\n'),
    };
    for (const [name, content] of Object.entries(variants)) {
      const root = makeProject({
        'package.json': '{"dependencies":{"@nestjs/common":"11","@nestjs/core":"11"}}',
        'admin.controller.ts': controller,
        [name]: content,
      });
      const g = await analyzeProject(root);
      const stats = node(g, 'route:admin.controller.ts#AdminController GET /stats');
      expect(stats?.meta?.routePath, name).toBe('/stats');
      expect(stats?.meta?.fullPath, name).toBeUndefined();
    }
  });

  it('NestJS: setGlobalPrefix num app que não dá para comprovar deixa o prefixo desconhecido', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"@nestjs/common":"11","@nestjs/core":"11"}}',
      'main.ts': [
        "import { createApp } from './factory';",
        'async function boot() {',
        '  const app = await createApp();',
        "  app.setGlobalPrefix('api');",
        '}',
      ].join('\n'),
      'factory.js': 'export async function createApp() { return globalThis.app; }',
      'a.ts': [
        "import { Controller, Get } from '@nestjs/common';",
        "@Controller('users')",
        'export class A {',
        '  @Get()',
        '  list() {}',
        '}',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expect(node(g, 'route:a.ts#A GET /users')?.meta?.fullPath).toBeUndefined();
  });

  it('Next.js: pageExtensions literal do next.config é respeitado', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"next":"16"}}',
      'next.config.js': "module.exports = { pageExtensions: ['page.tsx', 'api.ts'] };",
      'pages/index.page.tsx': 'export default function Home() { return null; }',
      'pages/Button.tsx': 'export default function Button() { return null; }',
      'pages/api/hello.api.ts': 'export default function hello(req: any, res: any) {}',
      'pages/api/util.ts': 'export default function util() {}',
    });
    const g = await analyzeProject(root);
    expect(routeNames(g)).toEqual(['ALL /api/hello', 'GET /']);
    expect(g.diagnostics.filter((d) => d.code === 'next-routes-skipped')).toEqual([]);
  });

  it('Next.js: pageExtensions que só seria conhecido executando o config não gera rotas', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"next":"16"}}',
      'next.config.mjs': [
        "const extra = process.env.MDX ? ['mdx'] : [];",
        "export default { pageExtensions: ['tsx', ...extra] };",
      ].join('\n'),
      'pages/index.tsx': 'export default function Home() { return null; }',
    });
    const g = await analyzeProject(root);
    expect(routeIds(g)).toEqual([]);
    const diag = g.diagnostics.find((d) => d.code === 'next-routes-skipped');
    expect(diag?.file).toBe('next.config.mjs');
    expect(diag?.params).toEqual({ config: 'next.config.mjs', option: 'pageExtensions' });
  });

  it('Next.js: pages/ na raiz faz o Next ignorar src/app', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"next":"16"}}',
      'pages/about.tsx': 'export default function About() { return null; }',
      'src/app/page.tsx': 'export default function Ignored() { return null; }',
    });
    const g = await analyzeProject(root);
    expect(routeIds(g)).toEqual(['route:pages/about.tsx#next GET /about']);
  });

  it('Fastify: com três argumentos o handler é o último (as opções não são handler)', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"fastify":"5"}}',
      'server.ts': [
        "import Fastify from 'fastify';",
        'const app = Fastify();',
        'const opts = { schema: {} };',
        'function handler() { return 1; }',
        "app.get('/x', opts, handler);",
        "app.get('/y', { handler });",
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    const fromX = g.edges.filter((e) => e.source === 'route:server.ts#app GET /x');
    expect(fromX.map((e) => `${e.target} ${e.resolution}`)).toEqual([
      'fn:server.ts#handler resolved',
    ]);
    expect(handler(g, 'route:server.ts#app GET /y', 'fn:server.ts#handler')).toEqual(ROUTE_HANDLER);
  });

  it('Hono: app com basePath montado por route() tem o basePath depois do prefixo', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"hono":"4"}}',
      'a.ts': [
        "import { Hono } from 'hono';",
        "const api = new Hono().basePath('/api');",
        "api.get('/users', (c) => c.text('ok'));",
        'const root = new Hono();',
        "root.route('/v1', api);",
        'const app = new Hono();',
        "const v2 = app.basePath('/v2');",
        "v2.get('/items', (c) => c.text('ok'));",
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    const users = node(g, 'route:a.ts#api GET /users');
    expect(users?.meta?.routePath).toBe('/users');
    expect(users?.meta?.fullPath).toBe('/v1/api/users');
    expect(users?.meta?.mountedAt).toEqual(['/v1/api']);
    // app nunca montado: as rotas do derivado ficam em /v2 (o roteador é o mesmo do app)
    expect(node(g, 'route:a.ts#v2 GET /items')?.meta?.fullPath).toBe('/v2/items');
  });

  it('Next.js: sem a dependência next, app/ e pages/ não geram rotas', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"react":"19"}}',
      'app/page.tsx': 'export default function Home() { return null; }',
      'pages/about.tsx': 'export default function About() { return null; }',
    });
    expect(routeIds(await analyzeProject(root))).toEqual([]);
  });

  it('Next.js: só a pasta app/pages do projeto que declara next; src/app perde para app', async () => {
    const root = makeProject({
      'package.json': '{"private":true}',
      'apps/web/package.json': '{"dependencies":{"next":"16"}}',
      'apps/web/app/page.tsx': 'export default function Home() { return null; }',
      'apps/web/src/app/page.tsx': 'export default function Ignored() { return null; }',
      'apps/web/lib/app/page.tsx': 'export default function Nested() { return null; }',
      'apps/web/app/sem-default/page.tsx': 'export const x = 1;',
      'apps/api/package.json': '{"dependencies":{"express":"5"}}',
      'apps/api/app/page.tsx': 'export default function Other() { return null; }',
    });
    const g = await analyzeProject(root);
    expect(routeIds(g)).toEqual(['route:apps/web/app/page.tsx#next GET /']);
  });

  it('Next.js: src/app vale quando não há app/ na raiz do projeto', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"next":"16"}}',
      'src/app/dashboard/page.tsx': 'export default function D() { return null; }',
      'src/pages/api/ping.js': 'export default function ping(req, res) { res.end(); }',
    });
    const g = await analyzeProject(root);
    expect(routeNames(g)).toEqual(['ALL /api/ping', 'GET /dashboard']);
  });

  it('Next.js: basePath no next.config deixa o caminho completo desconhecido', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"next":"16"}}',
      'next.config.mjs': "export default { basePath: '/docs' };",
      'app/page.tsx': 'export default function Home() { return null; }',
    });
    const g = await analyzeProject(root);
    const home = node(g, 'route:app/page.tsx#next GET /');
    expect(home?.meta?.routePath).toBe('/');
    expect(home?.meta?.fullPath).toBeUndefined();
  });

  it('Next.js: export só de tipo com nome de método não vira rota', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"next":"16"}}',
      'app/api/route.ts': [
        'type GET = { ok: true };',
        'export type { GET };',
        'export interface POST { ok: boolean }',
        'export async function PUT() { return new Response(); }',
      ].join('\n'),
    });
    expect(routeIds(await analyzeProject(root))).toEqual(['route:app/api/route.ts#next PUT /api']);
  });

  it('handler sem declaração conhecida vira nó não resolvido (Fastify e Next.js)', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"fastify":"5","next":"16"}}',
      'server.ts':
        "import Fastify from 'fastify';\nconst app = Fastify();\napp.get('/x', missingHandler);",
      'app/api/route.ts': "export { missing as GET } from './nowhere';",
    });
    const g = await analyzeProject(root);
    expect(
      edge(g, 'calls', 'route:server.ts#app GET /x', 'unresolved:server.ts#call:missingHandler')
        ?.resolution,
    ).toBe('unresolved');
    expect(routeIds(g)).toContain('route:app/api/route.ts#next GET /api');
  });

  it('declarações que se referem a si mesmas não travam a análise', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"fastify":"5","hono":"4"}}',
      'a.ts': [
        'function h() {}',
        "const app = app.get('/a', h);",
        "const sub = sub.basePath('/b');",
        "sub.get('/c', h);",
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expect(routeIds(g)).toEqual([]);
    expect(g.diagnostics.filter((d) => d.code === 'analysis-failed')).toEqual([]);
  });

  it('a saída é determinística', async () => {
    const a = await analyzeProject(fixture('express-mounted'));
    const b = await analyzeProject(fixture('express-mounted'));
    const strip = (g: RastroGraph) => JSON.stringify({ nodes: g.nodes, edges: g.edges });
    expect(strip(a)).toBe(strip(b));
  });
});

describe('repositório do próprio framework (express-self, fastify-self)', () => {
  let express: RastroGraph;
  let fastify: RastroGraph;
  beforeAll(async () => {
    expectNoNodeModules('express-self');
    expectNoNodeModules('fastify-self');
    express = await analyzeProject(fixture('express-self'));
    fastify = await analyzeProject(fixture('fastify-self'));
  });

  it('são grafos válidos', () => {
    expect(validateGraph(express)).toEqual({ valid: true, errors: [] });
    expect(validateGraph(fastify)).toEqual({ valid: true, errors: [] });
  });

  it("require('../..') é o Express quando o arquivo é o ponto de entrada do package.json", () => {
    // `var app = module.exports = express()`: o valor de app é o de express()
    expect(node(express, 'route:examples/hello/index.js#app GET /')?.meta).toMatchObject({
      framework: 'express',
      fullPath: '/',
    });
    // montagem entre arquivos com require('../../') e app.use('/api', require('./api'))
    expect(node(express, 'route:examples/multi/api.js#api GET /users')?.meta).toMatchObject({
      fullPath: '/api/users',
      mountedAt: ['/api'],
    });
    expect(
      handler(
        express,
        'route:examples/multi/api.js#api GET /users',
        'fn:examples/multi/api.js#listUsers',
      ),
    ).toEqual(ROUTE_HANDLER);
  });

  it('outro arquivo do pacote (lib/express.js) não comprova o framework', () => {
    expect(routeIds(express).some((id) => id.startsWith('route:examples/internal/'))).toBe(false);
  });

  it('rotas encadeadas em várias linhas apontam para a linha de cada método', () => {
    const get = node(express, 'route:examples/hello/index.js#app GET /book');
    const post = node(express, 'route:examples/hello/index.js#app POST /book');
    expect(get?.location?.startLine).toBe(13);
    expect(post?.location?.startLine).toBe(16);
    const contains = edge(express, 'contains', 'file:examples/hello/index.js', post!.id);
    expect(contains?.evidence[0]).toMatchObject({
      line: 16,
      snippet: '.post(function (req, res) {',
    });
  });

  it("require('../fastify') chega ao fastify.d.ts, mas o ponto de entrada é o fastify.js", () => {
    expect(node(fastify, 'route:examples/app.js#fastify GET /hello')?.meta?.fullPath).toBe(
      '/hello',
    );
    expect(node(fastify, 'route:examples/app.js#instance GET /ping')?.meta).toMatchObject({
      fullPath: '/v1/ping',
      mountedAt: ['/v1'],
    });
  });

  it('handler declarado dentro de outra função não vira "sem declaração"', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"fastify":"5"}}',
      'server.js': [
        "const app = require('fastify')();",
        'function setup() {',
        '  function handler(req, reply) {}',
        "  app.get('/local', handler);",
        '}',
        'setup();',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expect(routeIds(g)).toEqual(['route:server.js#app GET /local']);
    expect(g.nodes.some((n) => n.id === 'unresolved:server.js#call:handler')).toBe(false);
  });

  it('receptor que não é um nome vira um texto curto (sem colar palavras)', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"hono":"4"}}',
      'app.ts': [
        "import { Hono } from 'hono';",
        'export default new Hono()',
        "  .get('/a', (c) => c.text('a'))",
        "  .post('/b', (c) => c.text('b'));",
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expect(routeIds(g).sort()).toEqual([
      'route:app.ts#new Hono(…) GET /a',
      'route:app.ts#new Hono(…) POST /b',
    ]);
    expect(node(g, 'route:app.ts#new Hono(…) POST /b')?.location?.startLine).toBe(4);
  });
});
