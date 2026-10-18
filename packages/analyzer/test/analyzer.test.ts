import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  DIAGNOSTIC_CODES,
  diagnosticText,
  validateGraph,
  type GraphEdge,
  type RastroGraph,
} from '@rastro/core';
import { analyzeProject, discoverFiles } from '@rastro/analyzer';
import { computeInsights, GraphIndex } from '@rastro/graph';

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

describe('descoberta de arquivos', () => {
  it('ignora node_modules, dist, .gitignore, .d.ts e .min.js', () => {
    const { files } = discoverFiles(fixture('ts-basic'));
    const rel = files.map((f) => f.relative);
    expect(rel).toEqual([
      'src/cycle/a.ts',
      'src/cycle/b.ts',
      'src/index.ts',
      'src/lib/index.ts',
      'src/lib/strings.ts',
      'src/math.ts',
      'src/models/user.ts',
      'src/services/user-service.ts',
      'src/side-effect.ts',
    ]);
  });

  it('aceita padrões extras de exclusão', () => {
    const { files } = discoverFiles(fixture('ts-basic'), { exclude: ['src/cycle/'] });
    expect(files.some((f) => f.relative.startsWith('src/cycle/'))).toBe(false);
  });

  it('não segue links simbólicos', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-symlink-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const secret = 1;');
    fs.writeFileSync(path.join(tmp, 'main.ts'), 'export const ok = 1;');
    fs.symlinkSync(outside, path.join(tmp, 'linked-dir'));
    fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(tmp, 'linked.ts'));
    const { files, diagnostics } = discoverFiles(tmp);
    expect(files.map((f) => f.relative)).toEqual(['main.ts']);
    expect(diagnostics.filter((d) => d.code === 'symlink-skipped')).toHaveLength(2);
  });

  it('respeita limites de quantidade e tamanho', () => {
    const limited = discoverFiles(fixture('ts-basic'), { maxFiles: 2 });
    expect(limited.files).toHaveLength(2);
    expect(limited.diagnostics.some((d) => d.code === 'max-files-reached')).toBe(true);
    const small = discoverFiles(fixture('ts-basic'), { maxFileSizeBytes: 100 });
    expect(small.diagnostics.some((d) => d.code === 'file-too-large')).toBe(true);
  });
});

describe('projeto TypeScript (ts-basic)', () => {
  let g: RastroGraph;
  beforeAll(async () => {
    g = await analyzeProject(fixture('ts-basic'));
  });

  it('gera um grafo válido pela validação interna e pelo JSON Schema', () => {
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
    const schema = JSON.parse(
      fs.readFileSync(
        new URL('../../core/schema/rastro-graph.schema.json', import.meta.url),
        'utf8',
      ),
    );
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const roundTrip = JSON.parse(JSON.stringify(g));
    expect(validate(roundTrip), JSON.stringify(validate.errors)).toBe(true);
  });

  it('identifica funções, classes e métodos com localização', () => {
    const sum = node(g, 'fn:src/math.ts#sum');
    expect(sum).toMatchObject({
      kind: 'function',
      parent: 'file:src/math.ts',
      meta: { exported: true },
    });
    expect(sum?.location).toMatchObject({ file: 'src/math.ts', startLine: 1, endLine: 3 });
    expect(node(g, 'fn:src/math.ts#multiply')?.meta?.exported).toBeFalsy();
    expect(node(g, 'fn:src/math.ts#double')?.kind).toBe('function');
    expect(node(g, 'class:src/services/user-service.ts#UserService')?.kind).toBe('class');
    for (const m of ['create', 'findBySlug', 'withSeed', 'onCreate', 'validate', 'nextId']) {
      expect(node(g, `method:src/services/user-service.ts#UserService.${m}`)?.parent).toBe(
        'class:src/services/user-service.ts#UserService',
      );
    }
    expect(node(g, 'method:src/services/user-service.ts#UserService.withSeed')?.meta?.static).toBe(
      true,
    );
    expect(node(g, 'method:src/models/user.ts#User.get displayName')?.meta?.memberKind).toBe(
      'getter',
    );
  });

  it('resolve imports com extensão .js, alias do tsconfig e reexportações', () => {
    expect(edge(g, 'imports', 'file:src/index.ts', 'file:src/math.ts')?.resolution).toBe(
      'resolved',
    );
    expect(
      edge(g, 'imports', 'file:src/index.ts', 'file:src/lib/strings.ts')?.meta?.specifier,
    ).toBe('@lib/strings');
    expect(edge(g, 'imports', 'file:src/index.ts', 'file:src/models/user.ts')?.meta?.typeOnly).toBe(
      true,
    );
    expect(edge(g, 'imports', 'file:src/lib/index.ts', 'file:src/math.ts')?.meta?.importKind).toBe(
      're-export',
    );
    expect(edge(g, 'exports', 'file:src/lib/index.ts', 'fn:src/math.ts#sum')?.meta).toMatchObject({
      exportedAs: 'add',
      reexport: true,
    });
  });

  it('distingue pacotes externos de referências não resolvidas', () => {
    expect(node(g, 'pkg:node:fs')?.meta?.builtin).toBe(true);
    expect(node(g, 'pkg:fake-lib')?.meta?.declared).toBe(true); // instalado em node_modules
    expect(node(g, 'pkg:lodash')?.meta?.declared).toBe(true); // declarado, não instalado
    expect(edge(g, 'imports', 'file:src/index.ts', 'pkg:lodash')?.resolution).toBe('external');
    expect(node(g, 'unresolved:src/index.ts#import:chalk')?.meta?.reason).toBe(
      'undeclared-package',
    );
    expect(node(g, 'unresolved:src/index.ts#import:./missing')?.meta?.reason).toBe(
      'module-not-found',
    );
  });

  it('registra chamadas resolvidas, incluindo this.metodo() e new', () => {
    const create = 'method:src/services/user-service.ts#UserService.create';
    expect(edge(g, 'calls', 'fn:src/index.ts#main', 'fn:src/math.ts#sum')?.resolution).toBe(
      'resolved',
    );
    expect(edge(g, 'calls', 'fn:src/index.ts#main', create)?.discovery).toBe('static-typecheck');
    expect(
      edge(g, 'calls', create, 'method:src/services/user-service.ts#UserService.validate'),
    ).toBeDefined();
    expect(edge(g, 'calls', create, 'class:src/models/user.ts#User')?.meta?.callKind).toBe('new');
    expect(
      edge(g, 'calls', 'method:src/services/user-service.ts#UserService.onCreate', create),
    ).toBeDefined();
    expect(edge(g, 'calls', 'fn:src/math.ts#average', 'fn:src/math.ts#sum')).toBeDefined();
    // código no topo do arquivo é atribuído ao próprio arquivo
    expect(edge(g, 'calls', 'file:src/index.ts', 'fn:src/index.ts#main')).toBeDefined();
  });

  it('guarda evidências com arquivo, linha e trecho', () => {
    const e = edge(g, 'calls', 'fn:src/math.ts#double', 'fn:src/math.ts#multiply')!;
    expect(e.evidence[0]).toMatchObject({ file: 'src/math.ts', line: 10 });
    expect(e.evidence[0]?.snippet).toContain('multiply(n, 2)');
  });

  it('não inventa conexões: chamadas indiretas e ausentes ficam como não resolvidas', () => {
    expect(node(g, 'unresolved:src/index.ts#call:cb')?.meta?.reason).toBe('indirect-call');
    expect(node(g, 'unresolved:src/index.ts#call:ghost')?.meta?.reason).toBe('symbol-not-found');
    expect(node(g, 'unresolved:src/index.ts#call:notDefinedAnywhere')).toBeDefined();
    expect(g.stats.computedCalls).toBe(1); // handlers['a']()
    // writeFileSync vem de node:fs (sem tipos): é externo, não "não resolvido"
    expect(g.nodes.some((n) => n.id.includes('writeFileSync'))).toBe(false);
    for (const e of g.edges.filter((x) => x.resolution === 'unresolved')) {
      expect(node(g, e.target)?.kind).toBe('unresolved');
    }
  });

  it('detecta herança e ciclos de importação', () => {
    expect(
      edge(g, 'extends', 'class:src/models/user.ts#User', 'class:src/models/user.ts#BaseModel'),
    ).toBeDefined();
    expect(g.stats.importCycles).toEqual([['file:src/cycle/a.ts', 'file:src/cycle/b.ts']]);
    expect(node(g, 'file:src/cycle/a.ts')?.meta?.inCycle).toBe(true);
    expect(node(g, 'file:src/math.ts')?.meta?.inCycle).toBeFalsy();
  });

  it('agrupa arquivos em módulos e deriva dependências entre módulos', () => {
    expect(node(g, 'file:src/services/user-service.ts')?.parent).toBe('module:src/services');
    expect(node(g, 'module:src/services')?.parent).toBe('module:src');
    expect(edge(g, 'depends_on', 'module:src/services', 'module:src/models')?.discovery).toBe(
      'derived',
    );
  });

  it('nunca executa o código analisado', () => {
    expect(fs.existsSync(path.join(fixture('ts-basic'), 'EXECUTED.marker'))).toBe(false);
    expect(fs.existsSync(path.join(fixture('ts-basic'), 'POSTINSTALL_RAN'))).toBe(false);
  });

  it('é determinístico', async () => {
    const again = await analyzeProject(fixture('ts-basic'));
    const strip = (x: RastroGraph) => ({
      ...x,
      generatedAt: '',
      stats: { ...x.stats, durationMs: 0 },
    });
    expect(strip(again)).toEqual(strip(g));
  });
});

describe('projeto JavaScript misto (js-mixed)', () => {
  let g: RastroGraph;
  beforeAll(async () => {
    g = await analyzeProject(fixture('js-mixed'));
  });

  it('entende CommonJS (require, module.exports, exports.x)', () => {
    expect(
      edge(g, 'imports', 'file:src/index.js', 'file:src/utils/format.js')?.meta?.importKind,
    ).toBe('require');
    expect(
      edge(g, 'calls', 'fn:src/index.js#main', 'fn:src/utils/format.js#formatPrice'),
    ).toBeDefined();
    expect(edge(g, 'calls', 'fn:src/index.js#main', 'fn:src/cart.js#addItem')).toBeDefined();
    expect(
      edge(g, 'calls', 'fn:src/index.js#main', 'class:src/legacy.cjs#Legacy')?.meta?.callKind,
    ).toBe('new');
    expect(
      edge(g, 'calls', 'fn:src/index.js#main', 'method:src/legacy.cjs#Legacy.run'),
    ).toBeDefined();
    expect(
      edge(g, 'exports', 'file:src/utils/format.js', 'fn:src/utils/format.js#currency'),
    ).toBeDefined();
    expect(
      edge(g, 'exports', 'file:src/legacy.cjs', 'class:src/legacy.cjs#Legacy')?.meta?.exportedAs,
    ).toBe('module.exports');
  });

  it('resolve .mjs, .jsx, imports sem extensão e pastas com index', () => {
    expect(edge(g, 'imports', 'file:src/esm/app.mjs', 'file:src/esm/view.jsx')).toBeDefined();
    expect(
      edge(g, 'imports', 'file:src/esm/app.mjs', 'file:src/loader/index.js')?.meta?.specifier,
    ).toBe('../loader');
    expect(
      edge(g, 'imports', 'file:src/esm/app.mjs', 'file:src/esm/lazy.mjs')?.meta?.importKind,
    ).toBe('dynamic');
  });

  it('registra uso de componentes JSX', () => {
    expect(
      edge(g, 'calls', 'fn:src/esm/view.jsx#render', 'fn:src/esm/view.jsx#Card')?.meta?.callKind,
    ).toBe('jsx');
  });

  it('marca arquivos não analisados e requires dinâmicos', () => {
    expect(node(g, 'file:src/esm/view.css')?.meta?.analyzed).toBe(false);
    const dynamic = g.nodes.find(
      (n) => n.kind === 'unresolved' && n.meta?.reason === 'dynamic-import',
    );
    expect(dynamic?.name).toBe('require(pluginName)');
    expect(node(g, 'unresolved:src/broken.js#import:./does-not-exist')).toBeDefined();
  });

  it('ignora a pasta build', () => {
    expect(g.nodes.some((n) => n.id.includes('build/'))).toBe(false);
  });
});

describe('API Express (express-api)', () => {
  let g: RastroGraph;
  beforeAll(async () => {
    g = await analyzeProject(fixture('express-api'));
  });

  it('identifica rotas e seus handlers', () => {
    const routes = g.nodes.filter((n) => n.kind === 'route').map((n) => n.name);
    expect(routes).toEqual(['DELETE /users/:id', 'GET /users', 'GET /users/:id', 'POST /users']);
    expect(
      edge(g, 'calls', 'route:src/server.js#app GET /users', 'fn:src/handlers/users.js#listUsers'),
    ).toMatchObject({
      discovery: 'framework-rule',
      meta: { callKind: 'route-handler' },
    });
    // handler inline: chamadas dentro dele pertencem à rota
    expect(
      edge(
        g,
        'calls',
        'route:src/server.js#app POST /users',
        'fn:src/handlers/users.js#createUser',
      ),
    ).toBeDefined();
    // handler que não existe
    expect(
      edge(
        g,
        'calls',
        'route:src/server.js#app DELETE /users/:id',
        'unresolved:src/server.js#call:removeUser',
      )?.resolution,
    ).toBe('unresolved');
  });

  it('considera express um pacote declarado, mesmo sem node_modules', () => {
    expect(node(g, 'pkg:express')?.meta).toMatchObject({ declared: true });
  });
});

describe('projeto vazio', () => {
  it('retorna grafo válido com aviso', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-empty-'));
    fs.writeFileSync(path.join(tmp, 'README.md'), '# vazio');
    const g = await analyzeProject(tmp);
    expect(validateGraph(g).valid).toBe(true);
    expect(g.stats.files).toBe(0);
    expect(g.diagnostics.some((d) => d.code === 'no-source-files')).toBe(true);
  });
});

describe('monorepo (pacotes do workspace)', () => {
  let g: RastroGraph;
  beforeAll(async () => {
    g = await analyzeProject(fixture('monorepo'));
  });

  it('liga imports do .d.ts compilado ao código-fonte do pacote', () => {
    const imp = edge(
      g,
      'imports',
      'file:packages/app/src/main.ts',
      'file:packages/util/src/index.ts',
    );
    expect(imp).toMatchObject({
      resolution: 'resolved',
      meta: { viaDeclaration: true, specifier: '@demo/util' },
    });
    expect(g.nodes.some((n) => n.id.includes('/dist/'))).toBe(false);
  });

  it('liga chamadas entre pacotes, marcando o mapeamento', () => {
    const fn = edge(
      g,
      'calls',
      'fn:packages/app/src/main.ts#run',
      'fn:packages/util/src/index.ts#formatName',
    );
    expect(fn?.meta?.viaDeclaration).toBe(true);
    expect(
      edge(
        g,
        'calls',
        'fn:packages/app/src/main.ts#run',
        'class:packages/util/src/index.ts#Greeter',
      )?.meta?.callKind,
    ).toBe('new');
    expect(
      edge(
        g,
        'calls',
        'fn:packages/app/src/main.ts#run',
        'method:packages/util/src/index.ts#Greeter.greet',
      ),
    ).toBeDefined();
  });
});

describe('componentes React (js-mixed/src/esm/counter.jsx)', () => {
  let g: RastroGraph;
  beforeAll(async () => {
    g = await analyzeProject(fixture('js-mixed'));
  });

  it('reconhece componentes embrulhados em memo/forwardRef', () => {
    expect(node(g, 'fn:src/esm/counter.jsx#Badge')?.meta?.exported).toBe(true);
    expect(
      edge(g, 'calls', 'fn:src/esm/counter.jsx#Counter', 'fn:src/esm/counter.jsx#Badge')?.meta
        ?.callKind,
    ).toBe('jsx');
  });

  it('não marca como não resolvidos setters de hooks nem funções locais', () => {
    const unresolvedHere = g.nodes.filter(
      (n) => n.kind === 'unresolved' && n.location?.file === 'src/esm/counter.jsx',
    );
    expect(unresolvedHere).toEqual([]);
    expect(g.stats.localCalls).toBeGreaterThanOrEqual(1); // label(count)
  });
});

/** Cria um projeto temporário com os arquivos indicados. */
function makeProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-case-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

describe('regressões da revisão de código', () => {
  it('Express: não inventa rotas em clientes HTTP nem em objetos comuns', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"express":"5","axios":"1"}}',
      'server.js':
        "const express = require('express');\nconst app = express();\napp.get('/ok', (req, res) => res.end());",
      'client/api.js':
        "import axios from 'axios';\nconst api = axios.create();\nexport const load = () => api.get('/users', { params: {} });",
      'fake.js': "const router = { post() {} };\nrouter.post('/login', { user: 1 });",
    });
    const g = await analyzeProject(root);
    expect(g.nodes.filter((n) => n.kind === 'route').map((n) => n.id)).toEqual([
      'route:server.js#app GET /ok',
    ]);
  });

  it('Express: rotas iguais em roteradores diferentes não se misturam', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"express":"5"}}',
      'server.js': [
        "const express = require('express');",
        'const app = express();',
        'const admin = express.Router();',
        'function listUsers() {}',
        'function listAdmins() {}',
        "app.get('/list', listUsers);",
        "admin.get('/list', listAdmins);",
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expect(
      edge(g, 'calls', 'route:server.js#app GET /list', 'fn:server.js#listUsers'),
    ).toBeDefined();
    expect(
      edge(g, 'calls', 'route:server.js#admin GET /list', 'fn:server.js#listAdmins'),
    ).toBeDefined();
    expect(
      edge(g, 'calls', 'route:server.js#app GET /list', 'fn:server.js#listAdmins'),
    ).toBeUndefined();
  });

  it('um arquivo patológico vira aviso, sem derrubar a análise', async () => {
    const deep = `export const s = ${Array.from({ length: 8000 }, (_, i) => `'p${i}'`).join(' + ')};\n`;
    const root = makeProject({ 'deep.ts': deep, 'ok.ts': 'export function ok() { return 1; }' });
    const g = await analyzeProject(root);
    expect(node(g, 'fn:ok.ts#ok')).toBeDefined();
    expect(validateGraph(g).valid).toBe(true);
  });

  it('só segue aliases de const (let/var podem ser reatribuídos)', async () => {
    const root = makeProject({
      'a.ts': [
        'export function foo() {}',
        'export function bar() {}',
        'export function run() {',
        '  let h = foo;',
        '  h = bar;',
        '  h();',
        '  const k = foo;',
        '  k();',
        '}',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    const calls = g.edges.filter((e) => e.kind === 'calls' && e.source === 'fn:a.ts#run');
    expect(calls.map((e) => [e.target, e.resolution])).toEqual([
      ['fn:a.ts#foo', 'resolved'],
      ['unresolved:a.ts#call:h', 'unresolved'],
    ]);
  });

  it('evidência de export * aponta para o export certo', async () => {
    const root = makeProject({
      'a.ts': 'export function foo() {}',
      'b.ts': 'export function baz() {}',
      'index.ts': "export * from './a';\nexport * from './b';",
    });
    const g = await analyzeProject(root);
    expect(edge(g, 'exports', 'file:index.ts', 'fn:b.ts#baz')?.evidence[0]?.line).toBe(2);
    expect(edge(g, 'exports', 'file:index.ts', 'fn:a.ts#foo')?.evidence[0]?.line).toBe(1);
  });

  it('pasta do projeto com nome de módulo nativo não vira pacote do Node', async () => {
    const root = makeProject({
      'tsconfig.json':
        '{"compilerOptions":{"baseUrl":"src","moduleResolution":"Bundler","module":"ESNext"}}',
      'src/constants/index.ts': 'export function k() {}',
      'src/main.ts': "import { k } from 'constants';\nimport fs from 'node:fs';\nk();",
    });
    const g = await analyzeProject(root);
    expect(edge(g, 'imports', 'file:src/main.ts', 'file:src/constants/index.ts')).toBeDefined();
    expect(edge(g, 'imports', 'file:src/main.ts', 'pkg:node:fs')).toBeDefined();
  });

  it('JSX em .js, export default memo(...) e só funções de verdade viram nós', async () => {
    const root = makeProject({
      'App.js': [
        "import { memo } from 'react';",
        'export default memo(function Card() { return <div />; });',
        'export function App() { return <Inner />; }',
        'const Inner = memo(() => <span />);',
        'function helper(x) { return x; }',
        'export const doubled = [1, 2].map((x) => helper(x));',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expect(node(g, 'fn:App.js#Card')?.meta?.defaultExport).toBe(true);
    expect(edge(g, 'calls', 'fn:App.js#App', 'fn:App.js#Inner')?.meta?.callKind).toBe('jsx');
    expect(node(g, 'fn:App.js#doubled')).toBeUndefined();
    // a chamada no topo do arquivo é atribuída ao arquivo, não a uma "função" inventada
    expect(edge(g, 'calls', 'file:App.js', 'fn:App.js#helper')).toBeDefined();
  });

  it('chamada para arquivo excluído da análise é "não analisado", não "externa"', async () => {
    const root = makeProject({
      '.gitignore': 'generated/\n',
      'generated/api.ts': 'export function gen() {}',
      'main.ts': "import { gen } from './generated/api';\nexport function run() { gen(); }",
    });
    const g = await analyzeProject(root);
    const target = g.edges.find((e) => e.kind === 'calls' && e.source === 'fn:main.ts#run')?.target;
    expect(node(g, target!)?.meta?.reason).toBe('not-analyzed');
  });

  it('lê paths de tsconfig com references (padrão do Vite)', async () => {
    const root = makeProject({
      'tsconfig.json': '{"files":[],"references":[{"path":"./tsconfig.app.json"}]}',
      'tsconfig.app.json':
        '{"compilerOptions":{"baseUrl":".","paths":{"~/*":["src/*"]},"jsx":"preserve","moduleResolution":"Bundler","module":"ESNext"},"include":["src"]}',
      'src/components/Button.tsx': 'export function Button() { return <button />; }',
      'src/main.tsx':
        "import { Button } from '~/components/Button';\nexport function Main() { return <Button />; }",
    });
    const g = await analyzeProject(root);
    expect(edge(g, 'imports', 'file:src/main.tsx', 'file:src/components/Button.tsx')).toBeDefined();
    expect(
      edge(g, 'calls', 'fn:src/main.tsx#Main', 'fn:src/components/Button.tsx#Button'),
    ).toBeDefined();
    expect(g.project.tsconfig).toContain('tsconfig.app.json');
  });

  it('pacotes do workspace ligados por node_modules apontam para o código-fonte', async () => {
    const root = makeProject({
      'package.json': '{"workspaces":["packages/*"]}',
      'packages/util/package.json':
        '{"name":"@demo/util","types":"dist/index.d.ts","main":"dist/index.js"}',
      'packages/util/src/index.ts': 'export function hello() {}',
      'packages/util/dist/index.d.ts': 'export declare function hello(): void;',
      'packages/app/package.json': '{"name":"app","dependencies":{"@demo/util":"*"}}',
      'packages/app/src/main.ts':
        "import { hello } from '@demo/util';\nexport function run() { hello(); }",
    });
    fs.mkdirSync(path.join(root, 'node_modules/@demo'), { recursive: true });
    fs.symlinkSync(path.join(root, 'packages/util'), path.join(root, 'node_modules/@demo/util'));
    const g = await analyzeProject(root);
    expect(
      edge(g, 'imports', 'file:packages/app/src/main.ts', 'file:packages/util/src/index.ts')?.meta
        ?.viaDeclaration,
    ).toBe(true);
    expect(
      edge(g, 'calls', 'fn:packages/app/src/main.ts#run', 'fn:packages/util/src/index.ts#hello'),
    ).toBeDefined();
    expect(g.nodes.some((n) => n.id === 'pkg:@demo/util')).toBe(false);
  });

  it('dependências declaradas no package.json do subpacote contam como declaradas', async () => {
    const root = makeProject({
      'package.json': '{"workspaces":["packages/*"]}',
      'packages/app/package.json': '{"dependencies":{"left-pad":"1"}}',
      'packages/app/main.ts': "import pad from 'left-pad';\nexport const p = pad;",
    });
    const g = await analyzeProject(root);
    expect(node(g, 'pkg:left-pad')?.meta?.declared).toBe(true);
  });

  it('ciclos formados só por imports de tipo não contam', async () => {
    const root = makeProject({
      'a.ts':
        "import type { B } from './b';\nexport interface A { b?: B }\nexport function fa() {}",
      'b.ts': "import { fa } from './a';\nexport interface B { x: number }\nfa();",
    });
    const g = await analyzeProject(root);
    expect(g.stats.importCycles).toEqual([]);
  });

  it('numera linhas como o TypeScript, mesmo com separadores Unicode', async () => {
    const root = makeProject({ 'a.ts': "const s = 'x\u2028y';\nexport function f() {}\n" });
    const g = await analyzeProject(root);
    const f = node(g, 'fn:a.ts#f')!;
    expect(f.location?.startLine).toBeLessThanOrEqual(node(g, 'file:a.ts')!.meta!.lines!);
  });
});

describe('regressões da segunda revisão', () => {
  it('tsconfig com references: aliases iguais em apps diferentes não se misturam', async () => {
    const root = makeProject({
      'tsconfig.json':
        '{"files":[],"references":[{"path":"./apps/web/tsconfig.json"},{"path":"./apps/api/tsconfig.json"}]}',
      'apps/web/tsconfig.json':
        '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./src/*"]},"moduleResolution":"Bundler","module":"ESNext"},"include":["src"]}',
      'apps/api/tsconfig.json':
        '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./src/*"]},"moduleResolution":"Bundler","module":"ESNext"},"include":["src"]}',
      'apps/web/src/util.ts': 'export function helper() {}',
      'apps/api/src/util.ts': 'export function helper() {}',
      'apps/api/src/main.ts':
        "import { helper } from '@/util';\nexport function run() { helper(); }",
    });
    const g = await analyzeProject(root);
    expect(
      edge(g, 'imports', 'file:apps/api/src/main.ts', 'file:apps/api/src/util.ts'),
    ).toBeDefined();
    expect(
      edge(g, 'imports', 'file:apps/api/src/main.ts', 'file:apps/web/src/util.ts'),
    ).toBeUndefined();
    expect(
      g.edges.some((e) => e.target === 'fn:apps/web/src/util.ts#helper' && e.kind === 'calls'),
    ).toBe(false);
    // o verificador de tipos também resolve cada arquivo com o tsconfig dele: a chamada é ligada
    expect(
      edge(g, 'calls', 'fn:apps/api/src/main.ts#run', 'fn:apps/api/src/util.ts#helper')?.resolution,
    ).toBe('resolved');
  });

  it('arquivo impossível de interpretar vira aviso e sai da análise', async () => {
    const depth = 3000;
    const root = makeProject({
      'deep.ts': `export const x = ${'['.repeat(depth)}${']'.repeat(depth)};\n`,
      'ok.ts': 'export function ok() {}',
    });
    const g = await analyzeProject(root);
    expect(node(g, 'fn:ok.ts#ok')).toBeDefined();
    expect(validateGraph(g).valid).toBe(true);
  });

  it('.js com .d.ts escrito à mão ao lado mantém seus chamadores', async () => {
    const root = makeProject({
      'lib/foo.js': 'export function add(a, b) { return a + b; }',
      'lib/foo.d.ts': 'export declare function add(a: number, b: number): number;',
      'main.ts': "import { add } from './lib/foo';\nexport function run() { return add(1, 2); }",
    });
    const g = await analyzeProject(root);
    expect(edge(g, 'imports', 'file:main.ts', 'file:lib/foo.js')).toBeDefined();
    expect(edge(g, 'calls', 'fn:main.ts#run', 'fn:lib/foo.js#add')).toBeDefined();
  });

  it('Express por símbolo: aliases reconhecidos, homônimos de outros pacotes não', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"express":"5","itty-router":"5"}}',
      'a.ts': "import e from 'express';\nconst app = e();\nfunction h() {}\napp.get('/a', h);",
      'b.ts':
        "import { Router as R } from 'express';\nconst r = R();\nfunction h() {}\nr.post('/b', h);",
      'c.ts':
        "import express from 'express';\nimport { Router } from 'itty-router';\nconst x = express();\nconst router = Router();\nfunction h() {}\nrouter.get('/fake', h);",
      'd.ts':
        "import type { Express } from 'express';\nfunction express() { return { get(_p: string, _h: unknown) {} }; }\nconst app = express();\nfunction h() {}\napp.get('/fake2', h);",
    });
    const g = await analyzeProject(root);
    expect(
      g.nodes
        .filter((n) => n.kind === 'route')
        .map((n) => n.id)
        .sort(),
    ).toEqual(['route:a.ts#app GET /a', 'route:b.ts#r POST /b']);
  });

  it('Express: handlers embrulhados (asyncHandler) e roteadores homônimos', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"express":"5"}}',
      'app.js': [
        "const express = require('express');",
        'function asyncHandler(fn) { return fn; }',
        'function save() {}',
        'function auth() {}',
        'function v1() {',
        '  const r = express.Router();',
        "  r.post('/', auth, asyncHandler(async (req, res) => { save(); }));",
        '}',
        'function v2() {',
        '  const r = express.Router();',
        "  r.post('/', auth);",
        '}',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    const routes = g.nodes
      .filter((n) => n.kind === 'route')
      .map((n) => n.id)
      .sort();
    expect(routes).toEqual(['route:app.js#r POST /', 'route:app.js#r POST /~2']);
    expect(edge(g, 'calls', 'route:app.js#r POST /', 'fn:app.js#save')).toBeDefined();
  });

  it('raiz dentro de node_modules continua resolvendo arquivos', async () => {
    const parent = makeProject({});
    const root = path.join(parent, 'node_modules', 'lib');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'a.ts'), "import { b } from './b';\nexport const x = b;");
    fs.writeFileSync(path.join(root, 'b.ts'), 'export const b = 1;');
    const g = await analyzeProject(root);
    expect(edge(g, 'imports', 'file:a.ts', 'file:b.ts')?.resolution).toBe('resolved');
  });

  it('depends_on só de tipos é marcado e soma a contagem real', async () => {
    const root = makeProject({
      'p/a.ts': "import type { T } from '../n/t';\nexport const a: T = 1;",
      'n/t.ts': 'export type T = number;',
    });
    const g = await analyzeProject(root);
    expect(edge(g, 'depends_on', 'module:p', 'module:n')?.meta).toMatchObject({
      typeOnly: true,
      count: 1,
    });
  });
});

describe('regressões da terceira revisão', () => {
  it('paths: só o padrão de prefixo mais longo vale, como no compilador', async () => {
    const root = makeProject({
      'package.json': '{"name":"paths2"}',
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['./src/*'], '@/styles/*': ['./nonexist/*'] },
        },
      }),
      'src/styles/globals.css': 'body {}',
      'src/main.ts': "import '@/styles/globals.css';\n",
    });
    const g = await analyzeProject(root);
    // `@/styles/*` vence e o destino dele não existe: o compilador não tenta `@/*`
    expect(edge(g, 'imports', 'file:src/main.ts', 'file:src/styles/globals.css')).toBeUndefined();
    expect(
      edge(g, 'imports', 'file:src/main.ts', 'unresolved:src/main.ts#import:@/styles/globals.css')
        ?.resolution,
    ).toBe('unresolved');
  });

  it('JSON do projeto por um alias de paths é o arquivo, não um pacote npm', async () => {
    const root = makeProject({
      'package.json': '{"name":"paths-json"}',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', resolveJsonModule: true, paths: { '@/*': ['./src/*'] } },
      }),
      'src/conf.json': '{"a":1}',
      'src/main.ts': "import conf from '@/conf.json';\nconsole.log(conf);\n",
    });
    const g = await analyzeProject(root);
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
    expect(g.nodes.some((n) => n.kind === 'package')).toBe(false);
    expect(edge(g, 'imports', 'file:src/main.ts', 'file:src/conf.json')?.resolution).toBe(
      'resolved',
    );
    expect(node(g, 'file:src/conf.json')?.meta).toEqual({ analyzed: false });
  });

  it('new quebrado em duas linhas: a evidência aponta para a linha da classe', async () => {
    const root = makeProject({
      'a.ts': [
        'export class Svc {}',
        'export class Box { constructor(x: number) {} }',
        'export const s = new',
        '  Svc();',
        'export const b = new Box(1);',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    const newOf = (cls: string) =>
      g.edges.find(
        (e) => e.kind === 'calls' && e.meta?.callKind === 'new' && e.target.includes(cls),
      )?.evidence[0];
    expect(newOf('Svc')).toMatchObject({ line: 4, column: 3, snippet: 'Svc();' });
    // numa linha só, a coluna é a do nome da classe (como numa chamada)
    expect(newOf('Box')).toMatchObject({
      line: 5,
      column: 22,
      snippet: 'export const b = new Box(1);',
    });
  });
});

describe('insights (0.2)', () => {
  it('aponta código possivelmente sem uso sem acusar callbacks nem métodos implícitos', async () => {
    const root = makeProject({
      'a.ts': [
        'function usado() { return 1; }',
        'function comoCallback(x: number) { return x * 2; }',
        'function esquecido() { return 3; }',
        'export function api() { return usado() + [1].map(comoCallback)[0]!; }',
        'export class Modelo {',
        '  toJSON() { return {}; }',
        '  metodoSemUso() { return 4; }',
        '}',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    const insights = computeInsights(new GraphIndex(g));
    expect(insights.unused.internal.map((n) => n.id)).toEqual(['fn:a.ts#esquecido']);
    // a classe exportada nunca é usada; toJSON é implícito e não aparece
    expect(insights.unused.exported.map((n) => n.id)).toEqual([
      'class:a.ts#Modelo',
      'fn:a.ts#api',
      'method:a.ts#Modelo.metodoSemUso',
    ]);
  });

  it('ranqueia os mais chamados e os arquivos mais importados', async () => {
    const g = await analyzeProject(fixture('ts-basic'));
    const insights = computeInsights(new GraphIndex(g));
    // create é chamado por main, onCreate e withSeed
    expect(insights.mostCalled[0]).toMatchObject({
      node: { id: 'method:src/services/user-service.ts#UserService.create' },
      value: 3,
    });
    expect(insights.mostCalled.find((r) => r.node.id === 'fn:src/math.ts#sum')?.value).toBe(2);
    expect(insights.mostImported.map((r) => r.node.id)).toContain('file:src/lib/strings.ts');
    expect(insights.largestFiles[0]!.value).toBeGreaterThan(0);
    expect(insights.coupledModules.length).toBeGreaterThan(0);
  });
});

describe('diagnósticos com parâmetros (textos em outros idiomas)', () => {
  it('cada diagnóstico traz os params do código, e o texto em pt é o da mensagem', async () => {
    const root = makeProject({
      'package.json': '{"name":"diag"}',
      'tsconfig.json': '{ "compilerOptions": ',
      'src/broken.ts': 'export function x( {\n',
      'src/big.ts': `export const big = '${'x'.repeat(3000)}';\n`,
      'src/a.ts': 'export function a() {}\n',
      'src/b.ts': 'export function b() {}\n',
    });
    const g = await analyzeProject(root, { maxFileSizeBytes: 2000, maxFiles: 2 });
    const byCode = new Map(g.diagnostics.map((d) => [d.code, d]));
    expect(byCode.get('invalid-config')?.params).toMatchObject({ config: 'tsconfig.json' });
    expect(byCode.get('file-too-large')?.params).toEqual({ limitKb: 2 });
    expect(byCode.get('max-files-reached')?.params).toEqual({ limit: 2 });
    for (const d of g.diagnostics) {
      expect(d.params, d.code).toBeDefined();
      expect(DIAGNOSTIC_CODES, d.code).toContain(d.code);
      expect(diagnosticText(d, 'pt'), d.code).toBe(d.message);
      expect(diagnosticText(d, 'en'), d.code).not.toBe(d.message);
    }
  });

  it('erro de sintaxe e arquivo com barra invertida no nome (sem expor o caminho absoluto)', async () => {
    const root = makeProject({
      'src/broken.ts': 'export function x( {\n',
      'src/ok.ts': 'export function ok() {}\n',
      'src/a\\b.ts': 'export function weird() {}\n',
    });
    const g = await analyzeProject(root);
    const syntax = g.diagnostics.find((d) => d.code === 'syntax-error');
    expect(syntax?.params?.error).toBeTypeOf('string');
    expect(diagnosticText(syntax!, 'en')).toMatch(/^Syntax error: /);
    const skipped = g.diagnostics.find((d) => d.code === 'parse-failed');
    expect(skipped).toMatchObject({ file: 'src/a\\b.ts', params: { reason: 'backslash-name' } });
    for (const d of g.diagnostics) expect(JSON.stringify(d)).not.toContain(root);
    expect(node(g, 'fn:src/ok.ts#ok')).toBeDefined();
    expect(validateGraph(g).valid).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'arquivo importado sem permissão de leitura vira aviso, não derruba a análise',
    async () => {
      const root = makeProject({
        'src/a.ts': "import { b } from '../gen/b';\nexport function a() {\n  return b();\n}\n",
        'gen/b.ts': 'export function b() {\n  return 1;\n}\n',
      });
      fs.chmodSync(path.join(root, 'gen/b.ts'), 0o000);
      try {
        const g = await analyzeProject(root);
        expect(g.diagnostics.find((d) => d.code === 'parse-failed')).toMatchObject({
          file: 'gen/b.ts',
          params: { reason: 'no-permission' },
        });
        expect(node(g, 'fn:src/a.ts#a')).toBeDefined();
        expect(validateGraph(g).valid).toBe(true);
      } finally {
        fs.chmodSync(path.join(root, 'gen/b.ts'), 0o644);
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'nome de arquivo que não é UTF-8 válido vira aviso, não derruba a descoberta',
    async () => {
      const root = makeProject({ 'src/ok.ts': 'export function ok() {}\n' });
      // "\xff.ts": o nome lido de volta não é o mesmo (vira U+FFFD) e o arquivo "some"
      fs.writeFileSync(
        Buffer.concat([
          Buffer.from(path.join(root, 'src') + '/'),
          Buffer.from([0xff, 0x2e, 0x74, 0x73]),
        ]),
        'export const x = 1;\n',
      );
      const g = await analyzeProject(root);
      const d = g.diagnostics.find((x) => x.code === 'unreadable-file');
      expect(d).toMatchObject({ level: 'warning', params: { error: 'ENOENT' } });
      expect(diagnosticText(d!, 'en')).toBe('File skipped: it could not be read (ENOENT).');
      expect(diagnosticText(d!, 'pt')).toBe(d!.message);
      expect(node(g, 'fn:src/ok.ts#ok')).toBeDefined();
      expect(validateGraph(g).valid).toBe(true);
    },
  );
});

describe('regressões da revisão do analisador: aliases de tsconfig referenciados', () => {
  const files = (rootPaths: boolean) => ({
    'tsconfig.json': JSON.stringify({
      ...(rootPaths ? { compilerOptions: { paths: { '~root/*': ['./*'] } } } : {}),
      files: [],
      references: [{ path: './packages/web' }],
    }),
    'packages/web/tsconfig.json':
      '{ "compilerOptions": { "composite": true, "paths": { "@/*": ["./src/*"] } }, "include": ["src"] }',
    'packages/web/src/util.ts': 'export function util() { return 1; }',
    'packages/web/src/main.ts': 'import { util } from "@/util";\nexport const w = util();',
    'packages/web/tools/gen.ts': 'import { util } from "@/util";\nutil();',
    // homônimo na raiz: o alias do subpacote nunca pode apontar para cá
    'src/util.ts': 'export function util() { return 2; }',
    'scripts/build.ts':
      'import { util } from "@/util";\nimport { util as u } from "~root/src/util";\nutil();\nu();',
  });

  for (const rootPaths of [true, false]) {
    it(`alias de referência resolve a partir da pasta dela e não vale fora dela (raiz ${rootPaths ? 'com' : 'sem'} paths)`, async () => {
      const g = await analyzeProject(makeProject(files(rootPaths)));
      const web = 'packages/web/src';
      expect(edge(g, 'imports', `file:${web}/main.ts`, `file:${web}/util.ts`)).toBeDefined();
      expect(edge(g, 'calls', `file:${web}/main.ts`, `fn:${web}/util.ts#util`)?.resolution).toBe(
        'resolved',
      );
      // fora do "include", mas dentro da pasta do subpacote: o alias dele ainda vale
      expect(
        edge(g, 'imports', 'file:packages/web/tools/gen.ts', `file:${web}/util.ts`),
      ).toBeDefined();
      // scripts/ está fora do subpacote: "@/util" não existe ali, e nunca é o src/util.ts da raiz
      expect(
        g.edges.some(
          (e) =>
            (e.target === 'fn:src/util.ts#util' || e.target === 'file:src/util.ts') &&
            (e.kind === 'calls' || e.kind === 'imports') &&
            e.source !== 'file:scripts/build.ts',
        ),
      ).toBe(false);
      expect(
        g.edges.some(
          (e) => e.source === 'file:scripts/build.ts' && e.target === `file:${web}/util.ts`,
        ),
      ).toBe(false);
      expect(node(g, 'unresolved:scripts/build.ts#import:@/util')).toBeDefined();
      // o alias da própria raiz continua valendo para os arquivos dela
      if (rootPaths)
        expect(edge(g, 'imports', 'file:scripts/build.ts', 'file:src/util.ts')).toBeDefined();
    });
  }
});
