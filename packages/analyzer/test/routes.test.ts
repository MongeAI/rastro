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

describe('NestJS com @nestjs/core resolvido para dentro da raiz', () => {
  it('setGlobalPrefix de um app criado por NestFactory.create entra no caminho completo', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"@nestjs/common":"11","@nestjs/core":"11"}}',
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          experimentalDecorators: true,
          paths: {
            '@nestjs/core': ['./vendor/core/index.ts'],
            '@nestjs/common': ['./vendor/common/index.ts'],
          },
        },
      }),
      'vendor/core/index.ts': [
        'export class NestApplication {',
        '  setGlobalPrefix(prefix: string) { return this; }',
        '  listen(p: number) {}',
        '}',
        'export const NestFactory = {',
        '  async create(m: unknown): Promise<NestApplication> { return new NestApplication(); },',
        '};',
      ].join('\n'),
      'vendor/common/index.ts': [
        'export function Controller(p?: string): ClassDecorator { return () => {}; }',
        'export function Get(p?: string): MethodDecorator { return () => {}; }',
      ].join('\n'),
      'src/main.ts': [
        "import { NestFactory } from '@nestjs/core';",
        'async function bootstrap() {',
        '  const app = await NestFactory.create({});',
        "  app.setGlobalPrefix('api');",
        '  await app.listen(3000);',
        '}',
        'bootstrap();',
      ].join('\n'),
      'src/users.controller.ts': [
        "import { Controller, Get } from '@nestjs/common';",
        "@Controller('users')",
        'export class UsersController {',
        '  @Get()',
        '  list() { return []; }',
        '}',
      ].join('\n'),
      // método homônimo de um objeto qualquer do projeto continua não sendo o do Nest
      'src/other.ts': [
        'const config = { setGlobalPrefix(p: string) {} };',
        "config.setGlobalPrefix('nope');",
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
    expect(node(g, 'route:src/users.controller.ts#UsersController GET /users')?.meta).toMatchObject(
      { framework: 'nestjs', fullPath: '/api/users', mountedAt: ['/api'] },
    );
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

  it('Next.js: config que pode trazer o basePath de fora deixa o caminho completo desconhecido', async () => {
    const fullPath = async (config: Record<string, string>) => {
      const root = makeProject({
        'package.json': '{"dependencies":{"next":"16"}}',
        'config/shared.js': 'module.exports = { basePath: "/docs" };',
        'app/about/page.tsx': 'export default function About() { return null; }',
        ...config,
      });
      const g = await analyzeProject(root);
      const about = node(g, 'route:app/about/page.tsx#next GET /about');
      expect(about?.meta?.routePath).toBe('/about');
      return about?.meta?.fullPath;
    };
    for (const config of [
      'const shared = require("./config/shared");\nmodule.exports = { ...shared, reactStrictMode: true };',
      'module.exports = require("./config/shared");',
      "import shared from './config/shared.js';\nexport default shared;",
      "import withMDX from '@next/mdx';\nexport default withMDX()({ reactStrictMode: true });",
      'const config = withPlugins({ reactStrictMode: true });\nmodule.exports = config;',
      "export default async () => (await import('./config/shared.js')).default;",
    ])
      expect(await fullPath({ 'next.config.js': config }), config).toBeUndefined();
    // literal, com import só de tipo e em função de fase: continua comprovado
    for (const config of [
      "import type { NextConfig } from 'next';\nconst config: NextConfig = { reactStrictMode: true };\nexport default config;",
      'module.exports = (phase) => ({ reactStrictMode: phase !== "x" });',
    ])
      expect(await fullPath({ 'next.config.ts': config }), config).toBe('/about');
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

  it('montagem num receptor não comprovado deixa o caminho completo desconhecido', async () => {
    const full = async (files: Record<string, string>) =>
      Object.fromEntries(
        routes(await analyzeProject(makeProject(files)))
          .map((n) => [n.name, n.meta?.fullPath ?? null] as const)
          .sort(),
      );
    // Hono: sub-app montado num app de outro pacote (OpenAPIHono)
    expect(
      await full({
        'package.json': '{"name":"hono1","dependencies":{"hono":"*","@hono/zod-openapi":"*"}}\n',
        'src/index.ts':
          "import { OpenAPIHono } from '@hono/zod-openapi';\nimport { users } from './users';\nconst app = new OpenAPIHono();\napp.route('/users', users);\nexport default app;\n",
        'src/users.ts':
          "import { Hono } from 'hono';\nexport const users = new Hono();\nusers.get('/list', (c: any) => c.json([]));\n",
        'tsconfig.json':
          '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"}}\n',
      }),
    ).toEqual({ 'GET /list': null });
    // Express: app montado num app criado por uma fábrica do projeto; roteador montado também
    // num receptor não comprovado
    expect(
      await full({
        'package.json': '{"name":"ex1","dependencies":{"express":"*"}}\n',
        'src/admin.js':
          "const express = require('express');\nconst admin = express();\nadmin.get('/stats', (req, res) => res.send('x'));\nmodule.exports = admin;\n",
        'src/factory.js':
          "exports.makeMain = function makeMain() { return require('express')(); };\n",
        'src/server.js':
          "const express = require('express');\nconst admin = require('./admin');\nconst { makeMain } = require('./factory');\nconst main = makeMain();\nmain.use('/admin', admin);\nconst r = express.Router();\nr.get('/x', (req, res) => res.send('x'));\nconst app = express();\napp.use('/api', r);\nfunction mountAll(target, router) { target.use('/v2', router); }\nmountAll(app, r);\napp.listen(3000);\nmain.listen(4000);\n",
      }),
    ).toEqual({ 'GET /stats': null, 'GET /api/x': '/api/x' });
    expect(
      await full({
        'package.json': '{"name":"ex1","dependencies":{"express":"*"}}\n',
        'src/legacy.js': 'exports.createLegacyApp = () => require("express")();\n',
        'src/server.js':
          "const express = require('express');\nconst { createLegacyApp } = require('./legacy');\nconst r = express.Router();\nr.get('/x', (req, res) => res.send('x'));\nconst app = express();\napp.use('/api', r);\nconst legacy = createLegacyApp();\nlegacy.use('/v1', r);\n",
      }),
    ).toEqual({ 'GET /x': null });
    // Fastify: plugin registrado de novo por um receptor não comprovado (`other.register`)
    expect(
      await full({
        'package.json': '{"name":"fy1","dependencies":{"fastify":"*","fastify-plugin":"*"}}\n',
        'src/server.js':
          "const fastify = require('fastify');\nconst fp = require('fastify-plugin');\nconst app = fastify();\nasync function users(inst) { inst.get('/list', async () => []); }\napp.register(users, { prefix: '/users' });\nfunction setup(other) { other.register(users, { prefix: '/v2/users' }); }\nsetup(app);\nasync function shared(inst) { inst.get('/health', async () => 'ok'); }\napp.register(fp(shared), { prefix: '/x' });\nconst wrapped = fp(async function wrappedPlugin(inst) { inst.get('/w', async () => 'ok'); });\napp.register(wrapped, { prefix: '/y' });\napp.register(async (inst) => {\n  inst.register(async (inner) => { inner.get('/deep', async () => 1); }, { prefix: '/b' });\n}, { prefix: '/a' });\n",
      }),
    ).toEqual({
      'GET /a/b/deep': '/a/b/deep',
      'GET /list': null,
    });
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

  it('projeto que só se chama "express" (express-fake): require(\'..\') não é o Express', async () => {
    expectNoNodeModules('express-fake');
    const fake = await analyzeProject(fixture('express-fake'));
    expect(validateGraph(fake)).toEqual({ valid: true, errors: [] });
    expect(routeIds(fake)).toEqual([]);
    // a chamada da fábrica local continua resolvida normalmente
    expect(edge(fake, 'calls', 'file:sub/app.js', 'fn:index.js#make')?.resolution).toBe('resolved');
  });

  it('nome de framework no package.json sem a fábrica dele não inventa rotas', async () => {
    const helper = 'module.exports = function make() { return { get() {}, post() {} }; };';
    const use = (spec: string) =>
      [
        `const make = require('${spec}');`,
        'const s = make();',
        "s.get('/x', function h() {});",
      ].join('\n');
    // Fastify: o ponto de entrada não define `function fastify()`
    const fastifyLike = await analyzeProject(
      makeProject({
        'package.json': '{"name":"fastify","main":"fastify.js"}',
        'fastify.js': helper,
        'examples/app.js': use('../fastify'),
      }),
    );
    expect(routeIds(fastifyLike)).toEqual([]);
    // Express: a fábrica certa, mas exportada só de um lado de um if (sem prova)
    const conditional = await analyzeProject(
      makeProject({
        'package.json': '{"name":"express"}',
        'index.js': [
          "if (process.env.REAL) module.exports = require('./lib/express');",
          "else module.exports = require('./lib/other');",
        ].join('\n'),
        'lib/express.js': 'module.exports = function createApplication() { return { get() {} }; };',
        'lib/other.js': helper,
        'examples/app.js': use('../'),
      }),
    );
    expect(routeIds(conditional)).toEqual([]);
    // Hono: nenhuma fábrica conhecida comprova o ponto de entrada (só o pacote instalado vale)
    const honoLike = await analyzeProject(
      makeProject({
        'package.json': '{"name":"hono"}',
        'index.js': 'class Hono { get() {} }\nmodule.exports = { Hono };',
        'examples/app.js':
          "const { Hono } = require('..');\nconst app = new Hono();\napp.get('/x', function h() {});",
      }),
    );
    expect(routeIds(honoLike)).toEqual([]);
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

describe('regressões da revisão do analisador: rotas', () => {
  it('handler de receptor união (Mock | Real) fica não resolvido, como a chamada direta', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"express":"5"}}',
      'a.ts': [
        "import express from 'express';",
        'export class RealCtrl { list(req: any, res: any) {} }',
        'export class MockCtrl { list(req: any, res: any) {} }',
        'const ctrl = process.env.MOCK ? new MockCtrl() : new RealCtrl();',
        'const real = new RealCtrl();',
        'const app = express();',
        "app.get('/items', ctrl.list);",
        "app.get('/real', real.list);",
        'export function direct() { ctrl.list(1, 2); }',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expect(validateGraph(g).valid).toBe(true);
    const fromItems = g.edges.filter((e) => e.source === 'route:a.ts#app GET /items');
    expect(fromItems.map((e) => [e.target, e.resolution])).toEqual([
      ['unresolved:a.ts#call:ctrl.list', 'unresolved'],
    ]);
    expect(node(g, 'unresolved:a.ts#call:ctrl.list')?.meta).toEqual({
      reason: 'indirect-call',
      reference: 'ctrl.list',
      candidates: ['method:a.ts#MockCtrl.list', 'method:a.ts#RealCtrl.list'],
    });
    // o mesmo nó da chamada direta (mesmos candidatos)
    expect(edge(g, 'calls', 'fn:a.ts#direct', 'unresolved:a.ts#call:ctrl.list')).toBeDefined();
    expect(handler(g, 'route:a.ts#app GET /real', 'method:a.ts#RealCtrl.list')).toEqual(
      ROUTE_HANDLER,
    );
  });

  it('handler de module.exports atribuído duas vezes: não resolvido, com os dois candidatos', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"express":"5"}}',
      'fast.js': 'module.exports = function fast(req, res) {};',
      'slow.js': 'module.exports = function slow(req, res) {};',
      'pick.js': [
        "if (process.env.FAST) module.exports = require('./fast');",
        "else module.exports = require('./slow');",
      ].join('\n'),
      'app.js': [
        "const express = require('express');",
        "const pick = require('./pick');",
        'const app = express();',
        "app.get('/h', pick);",
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    const fromH = g.edges.filter((e) => e.source === 'route:app.js#app GET /h');
    expect(fromH.map((e) => [e.target, e.resolution])).toEqual([
      ['unresolved:app.js#call:pick', 'unresolved'],
    ]);
    expect(node(g, 'unresolved:app.js#call:pick')?.meta).toMatchObject({
      reason: 'indirect-call',
      candidates: ['fn:fast.js#fast', 'fn:slow.js#slow'],
    });
  });

  it('Fastify: prefixo, url e handler escondidos por um espalhamento depois não são inventados', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"fastify":"5"}}',
      'server.ts': [
        "import Fastify from 'fastify';",
        'const app = Fastify();',
        'export function h() {}',
        'export function other() {}',
        "async function users(f: any) { f.get('/users', h); }",
        "async function admin(f: any) { f.get('/admin', h); }",
        "async function twice(f: any) { f.get('/twice', h); }",
        "const opts = { prefix: '/v2' };",
        "app.register(users, { prefix: '/v1', ...opts });",
        // espalhamento antes: o prefixo literal depois dele vale
        "app.register(admin, { ...opts, prefix: '/adm' });",
        // chave repetida: vale a última
        "app.register(twice, { prefix: '/a', prefix: '/b' });",
        "app.route({ method: 'GET', url: '/a', handler: h, ...{ url: '/b' } });",
        "app.route({ method: 'GET', url: '/c', handler: h, ...{ handler: other } });",
        "app.route({ method: 'GET', path: '/p', handler: other });",
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    const byName = Object.fromEntries(routes(g).map((n) => [n.meta?.routePath, n.meta]));
    expect(byName['/users']?.fullPath).toBeUndefined();
    expect(byName['/admin']?.fullPath).toBe('/adm/admin');
    expect(byName['/twice']?.fullPath).toBe('/b/twice');
    expect(byName['/a']).toBeUndefined();
    expect(byName['/b']).toBeUndefined();
    // handler sobrescrito pelo espalhamento: a rota não tem handler comprovado
    expect(byName['/c']).toBeUndefined();
    expect(byName['/p']?.fullPath).toBe('/p');
  });

  it('Next.js: %5F no nome da pasta vira _ no caminho (não é pasta privada)', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"next":"15"}}',
      'app/%5Fescaped/page.tsx': 'export default function Page() { return null; }',
      'app/_private/page.tsx': 'export default function Page() { return null; }',
      'app/a%5Fb/[%5Fid]/page.tsx': 'export default function Page() { return null; }',
    });
    const g = await analyzeProject(root);
    expect(routeNames(g)).toEqual(['GET /_escaped', 'GET /a_b/:_id']);
  });

  it('Next.js: pageExtensions seguido de espalhamento só seria conhecido executando', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"next":"15"}}',
      'next.config.mjs':
        "import base from './base.mjs';\nexport default { pageExtensions: ['page.tsx'], ...base };",
      'base.mjs': 'export default {};',
      'pages/about.page.tsx': 'export default function About() { return null; }',
    });
    const g = await analyzeProject(root);
    expect(routeIds(g)).toEqual([]);
    expect(g.diagnostics.some((d) => d.code === 'next-routes-skipped')).toBe(true);
  });

  it('Express: handler com .bind nativo é ligado; bind do projeto não', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"express":"5"}}',
      'a.ts': [
        "import express from 'express';",
        'export class Ctrl { list(req: any, res: any) {} }',
        'const ctrl = new Ctrl();',
        'const fake = { list: { bind(_x: unknown) { return () => {}; } } };',
        'const app = express();',
        "app.get('/bound', ctrl.list.bind(ctrl));",
        "app.get('/fake', fake.list.bind(ctrl));",
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expect(handler(g, 'route:a.ts#app GET /bound', 'method:a.ts#Ctrl.list')).toEqual(ROUTE_HANDLER);
    expect(g.edges.filter((e) => e.source === 'route:a.ts#app GET /fake')).toEqual([]);
  });

  it('Express: app.use(middleware(), router) monta na raiz; caminho de outro tipo continua desconhecido', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"express":"5"}}',
      'a.ts': [
        "import express, { Router } from 'express';",
        'function cors() { return (req: any, res: any, next: () => void) => next(); }',
        'function prefix(): string { return process.env.P ?? "/x"; }',
        'export function h() {}',
        'const app = express();',
        'const r1 = Router();',
        'const r2 = Router();',
        "r1.get('/one', h);",
        "r2.get('/two', h);",
        'app.use(cors(), r1);',
        'app.use(prefix(), r2);',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expect(node(g, 'route:a.ts#r1 GET /one')?.meta?.fullPath).toBe('/one');
    expect(node(g, 'route:a.ts#r2 GET /two')?.meta?.fullPath).toBeUndefined();
  });

  it('roteadores montados em dois caminhos por nível, muitos níveis: compõe sem explodir', async () => {
    const levels = 22;
    const lines = [
      "import express, { Router } from 'express';",
      'export function h() {}',
      'const app = express();',
    ];
    for (let i = 0; i < levels; i++) lines.push(`const r${i} = Router();`);
    lines.push("app.use(['/a', '/b'], r0);");
    for (let i = 1; i < levels; i++) lines.push(`r${i - 1}.use(['/a', '/b'], r${i});`);
    for (let k = 0; k < 50; k++) lines.push(`r${levels - 1}.get('/x${k}', h);`);
    const root = makeProject({
      'package.json': '{"dependencies":{"express":"5"}}',
      'app.ts': lines.join('\n'),
    });
    const started = performance.now();
    const g = await analyzeProject(root);
    expect(performance.now() - started).toBeLessThan(15_000);
    const route = node(g, `route:app.ts#r${levels - 1} GET /x0`);
    // prefixos demais: o caminho completo não é escolhido, e a lista é limitada e ordenada
    expect(route?.meta?.fullPath).toBeUndefined();
    const mounted = route?.meta?.mountedAt ?? [];
    expect(mounted).toHaveLength(32);
    expect([...mounted].sort()).toEqual(mounted);
    expect(node(g, `route:app.ts#r${levels - 1} GET /x49`)?.meta?.mountedAt).toEqual(mounted);
  });
});
