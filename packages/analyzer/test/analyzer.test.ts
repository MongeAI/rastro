import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { validateGraph, type GraphEdge, type TeiaGraph } from '@teia/core';
import { analyzeProject, discoverFiles } from '@teia/analyzer';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const fixture = (name: string) => path.join(fixtures, name);

const edge = (g: TeiaGraph, kind: string, source: string, target: string): GraphEdge | undefined =>
  g.edges.find((e) => e.kind === kind && e.source === source && e.target === target);
const node = (g: TeiaGraph, id: string) => g.nodes.find((n) => n.id === id);

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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teia-symlink-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'teia-outside-'));
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
  let g: TeiaGraph;
  beforeAll(async () => {
    g = await analyzeProject(fixture('ts-basic'));
  });

  it('gera um grafo válido pela validação interna e pelo JSON Schema', () => {
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
    const schema = JSON.parse(
      fs.readFileSync(new URL('../../core/schema/teia-graph.schema.json', import.meta.url), 'utf8'),
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
    const strip = (x: TeiaGraph) => ({
      ...x,
      generatedAt: '',
      stats: { ...x.stats, durationMs: 0 },
    });
    expect(strip(again)).toEqual(strip(g));
  });
});

describe('projeto JavaScript misto (js-mixed)', () => {
  let g: TeiaGraph;
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
  let g: TeiaGraph;
  beforeAll(async () => {
    g = await analyzeProject(fixture('express-api'));
  });

  it('identifica rotas e seus handlers', () => {
    const routes = g.nodes.filter((n) => n.kind === 'route').map((n) => n.name);
    expect(routes).toEqual(['DELETE /users/:id', 'GET /users', 'GET /users/:id', 'POST /users']);
    expect(
      edge(g, 'calls', 'route:src/server.js#GET /users', 'fn:src/handlers/users.js#listUsers'),
    ).toMatchObject({
      discovery: 'framework-rule',
      meta: { callKind: 'route-handler' },
    });
    // handler inline: chamadas dentro dele pertencem à rota
    expect(
      edge(g, 'calls', 'route:src/server.js#POST /users', 'fn:src/handlers/users.js#createUser'),
    ).toBeDefined();
    // handler que não existe
    expect(
      edge(
        g,
        'calls',
        'route:src/server.js#DELETE /users/:id',
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teia-empty-'));
    fs.writeFileSync(path.join(tmp, 'README.md'), '# vazio');
    const g = await analyzeProject(tmp);
    expect(validateGraph(g).valid).toBe(true);
    expect(g.stats.files).toBe(0);
    expect(g.diagnostics.some((d) => d.code === 'no-source-files')).toBe(true);
  });
});

describe('monorepo (pacotes do workspace)', () => {
  let g: TeiaGraph;
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
  let g: TeiaGraph;
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
