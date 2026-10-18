import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { validateGraph, type GraphEdge, type RastroGraph } from '@rastro/core';
import { analyzeProject } from '@rastro/analyzer';
import { computeInsights, filterGraphByFolder, GraphIndex } from '@rastro/graph';

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

function makeProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-precision-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

function expectValid(g: RastroGraph): void {
  expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
  const schema = JSON.parse(
    fs.readFileSync(new URL('../../core/schema/rastro-graph.schema.json', import.meta.url), 'utf8'),
  );
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  expect(validate(JSON.parse(JSON.stringify(g))), JSON.stringify(validate.errors)).toBe(true);
}

const A = 'src/animals.ts';
const R = 'src/repository.ts';

describe('herança: super e métodos herdados (fixtures/oop)', () => {
  let g: RastroGraph;
  beforeAll(async () => {
    g = await analyzeProject(fixture('oop'));
  });

  it('gera um grafo válido', () => expectValid(g));

  it('super.metodo() liga ao método da classe base', () => {
    expect(edge(g, 'calls', `method:${A}#Dog.move`, `method:${A}#Animal.move`)).toMatchObject({
      resolution: 'resolved',
      discovery: 'static-typecheck',
      evidence: [{ file: A, line: 25 }],
    });
    expect(
      edge(g, 'calls', `method:${R}#CachedRepository.find`, `method:${R}#MemoryRepository.find`)
        ?.resolution,
    ).toBe('resolved');
  });

  it('super(...) liga ao construtor da base, ao herdado ou à própria classe base', () => {
    const toBase = edge(
      g,
      'calls',
      `method:${A}#Dog.constructor`,
      `method:${A}#Animal.constructor`,
    );
    expect(toBase).toMatchObject({ resolution: 'resolved', discovery: 'static-typecheck' });
    expect(toBase?.evidence[0]?.snippet).toBe('super(name);');
    // Puppy não declara construtor: o super('neto') de Grandchild executa o de Dog
    expect(
      edge(g, 'calls', `method:${A}#Grandchild.constructor`, `method:${A}#Dog.constructor`),
    ).toBeDefined();
    // base sem nenhum construtor declarado: a relação vai para a classe, como em `new Plain()`
    expect(edge(g, 'calls', `method:${A}#Child.constructor`, `class:${A}#Plain`)?.resolution).toBe(
      'resolved',
    );
    // base externa (Error): fica fora do grafo, como qualquer chamada externa
    expect(g.edges.some((e) => e.source === `method:${A}#AppError.constructor`)).toBe(false);
    expect(g.nodes.some((n) => n.kind === 'unresolved' && n.name.startsWith('super'))).toBe(false);
  });

  it('this.metodo() e instancia.metodo() herdados apontam para a classe que declara', () => {
    expect(edge(g, 'calls', `method:${A}#Dog.fetch`, `method:${A}#Animal.describe`)).toBeDefined();
    expect(edge(g, 'calls', 'fn:src/main.ts#run', `method:${A}#Dog.fetch`)).toBeDefined();
    expect(edge(g, 'calls', 'fn:src/main.ts#run', `method:${A}#Animal.describe`)).toBeDefined();
    // método concreto da base chamado pelo tipo da base: resolvido para a base
    expect(edge(g, 'calls', 'fn:src/main.ts#run', `method:${A}#Animal.move`)?.resolution).toBe(
      'resolved',
    );
  });

  it('o mesmo vale para JavaScript sem tipos', () => {
    const L = 'src/legacy.js';
    expect(edge(g, 'calls', `method:${L}#Square.area`, `method:${L}#Shape.area`)).toBeDefined();
    expect(edge(g, 'calls', `method:${L}#Cube.volume`, `method:${L}#Square.twice`)).toBeDefined();
    expect(edge(g, 'calls', `method:${L}#Square.twice`, `method:${L}#Square.area`)).toBeDefined();
  });
});

describe('implements e chamadas por interface (fixtures/oop)', () => {
  let g: RastroGraph;
  beforeAll(async () => {
    g = await analyzeProject(fixture('oop'));
  });

  it('chamada por interface fica não resolvida, com as implementações como candidatas', () => {
    const save = node(g, 'unresolved:src/main.ts#call:repo.save')!;
    expect(save.meta).toMatchObject({ reason: 'indirect-call', reference: 'repo.save' });
    expect(save.meta?.candidates).toEqual([
      `method:${R}#MemoryRepository.save`,
      `method:${R}#SqlRepository.save`,
    ]);
    // nunca vira relação resolvida para nenhuma candidata
    expect(
      edge(g, 'calls', 'fn:src/main.ts#run', 'unresolved:src/main.ts#call:repo.save')?.resolution,
    ).toBe('unresolved');
    for (const candidate of save.meta!.candidates!)
      expect(g.edges.some((e) => e.kind === 'calls' && e.target === candidate)).toBe(false);
    // mesmo formato, mas sem `implements`: não é candidata
    expect(save.meta?.candidates).not.toContain(`method:${R}#LooksLikeRepository.save`);
  });

  it('usa o tipo do receptor: interface que estende outra e implementação pela classe base', () => {
    // store: Store<string>. SqlRepository só implementa Repository, então não serve aqui;
    // CachedRepository implementa Store através de MemoryRepository
    expect(node(g, 'unresolved:src/main.ts#call:store.find')?.meta?.candidates).toEqual([
      `method:${R}#CachedRepository.find`,
      `method:${R}#MemoryRepository.find`,
    ]);
  });

  it('aceita implements de alias de tipo', () => {
    expect(node(g, 'unresolved:src/main.ts#call:clock.now')?.meta?.candidates).toEqual([
      `method:${R}#SystemClock.now`,
    ]);
  });

  it('método abstrato: as subclasses que o implementam são candidatas', () => {
    const expected = [`method:${A}#Cat.sound`, `method:${A}#Dog.sound`, `method:${A}#Puppy.sound`];
    expect(node(g, 'unresolved:src/main.ts#call:animal.sound')?.meta?.candidates).toEqual(expected);
    // this.sound() dentro da própria classe abstrata
    expect(node(g, `unresolved:${A}#call:this.sound`)?.meta?.candidates).toEqual(expected);
  });

  it('registra o implements de cada classe como escrito no código', () => {
    expect(node(g, `class:${R}#MemoryRepository`)?.meta?.implements).toEqual(['Store', 'Named']);
    expect(node(g, `class:${R}#SystemClock`)?.meta?.implements).toEqual(['Clock']);
    expect(node(g, `class:${R}#CachedRepository`)?.meta?.implements).toBeUndefined();
  });

  it('o índice do grafo mostra quem possivelmente chama uma implementação', () => {
    const index = new GraphIndex(g);
    expect(index.possibleCallSites(`method:${R}#SqlRepository.save`).map((n) => n.id)).toEqual([
      'unresolved:src/main.ts#call:repo.save',
    ]);
    expect(index.possibleCallSites(`method:${R}#LooksLikeRepository.save`)).toEqual([]);
  });

  it('o filtro por pasta remove candidatos de fora, mantendo o grafo válido', () => {
    const root = makeProject({
      'core/repo.ts': 'export interface Repo { save(): void }',
      'core/use.ts':
        "import type { Repo } from './repo';\nexport function use(r: Repo) { r.save(); }",
      'impl/memory.ts':
        "import type { Repo } from '../core/repo';\nexport class Memory implements Repo { save() {} }",
    });
    return analyzeProject(root).then((full) => {
      expect(node(full, 'unresolved:core/use.ts#call:r.save')?.meta?.candidates).toEqual([
        'method:impl/memory.ts#Memory.save',
      ]);
      const sub = filterGraphByFolder(full, 'core');
      expect(validateGraph(sub)).toEqual({ valid: true, errors: [] });
      expect(node(sub, 'unresolved:core/use.ts#call:r.save')?.meta?.candidates).toBeUndefined();
    });
  });

  it('implementação possível não é apontada como "sem uso"', async () => {
    const root = makeProject({
      'a.ts': [
        'interface Tarefa { executarAgora(): void }',
        'class Limpeza implements Tarefa { executarAgora() {} }',
        'export function rodar(t: Tarefa) { t.executarAgora(); }',
        'export const limpeza = new Limpeza();',
      ].join('\n'),
    });
    const g2 = await analyzeProject(root);
    const index = new GraphIndex(g2);
    expect(index.possibleCallSites('method:a.ts#Limpeza.executarAgora')).toHaveLength(1);
    const unused = computeInsights(index).unused;
    expect([...unused.internal, ...unused.exported].map((n) => n.id)).not.toContain(
      'method:a.ts#Limpeza.executarAgora',
    );
  });

  const repos = [
    'export interface UserRepo { save(): void }',
    'export interface OrderRepo { save(): void }',
    'export class SqlUserRepo implements UserRepo { save() {} }',
    'export class SqlOrderRepo implements OrderRepo { save() {} }',
  ];
  /** Quem chama (pelas relações) os nós não resolvidos que têm o método como candidato. */
  const possibleCallers = (g2: RastroGraph, method: string) => {
    const index = new GraphIndex(g2);
    return index
      .possibleCallSites(method)
      .flatMap((site) => g2.edges.filter((e) => e.kind === 'calls' && e.target === site.id))
      .map((e) => e.source)
      .sort();
  };

  it('cada chamada guarda os próprios candidatos (mesmo texto, interfaces diferentes)', async () => {
    const root = makeProject({
      'a.ts': [
        ...repos,
        'export function u(repo: UserRepo) { repo.save(); }',
        'export function o(repo: OrderRepo) { repo.save(); }',
        'export function u2(repo: UserRepo) { repo.save(); }',
        'export function shape(repo: { save(): void }) { repo.save(); }',
      ].join('\n'),
    });
    const g2 = await analyzeProject(root);
    expectValid(g2);
    expect(possibleCallers(g2, 'method:a.ts#SqlUserRepo.save')).toEqual([
      'fn:a.ts#u',
      'fn:a.ts#u2',
    ]);
    expect(possibleCallers(g2, 'method:a.ts#SqlOrderRepo.save')).toEqual(['fn:a.ts#o']);
    const sites = g2.nodes.filter(
      (n) => n.kind === 'unresolved' && n.meta?.reference === 'repo.save',
    );
    // o mesmo texto vira um nó por conjunto de candidatos (e um sem candidatos)
    expect(sites.map((n) => [n.id, n.meta?.candidates])).toEqual([
      ['unresolved:a.ts#call:repo.save', ['method:a.ts#SqlUserRepo.save']],
      ['unresolved:a.ts#call:repo.save~2', ['method:a.ts#SqlOrderRepo.save']],
      ['unresolved:a.ts#call:repo.save~3', undefined],
    ]);
    for (const site of sites) expect(site.name).toBe('repo.save');
  });

  it('receptor de tipo união com interface e classe: nenhuma parte é comprovada, todas são possíveis', async () => {
    const root = makeProject({
      'a.ts': [...repos, 'export function un(r: UserRepo | SqlOrderRepo) { r.save(); }'].join('\n'),
    });
    const g2 = await analyzeProject(root);
    expectValid(g2);
    // em execução só um dos métodos atende a chamada: nenhuma relação resolvida
    expect(edge(g2, 'calls', 'fn:a.ts#un', 'method:a.ts#SqlOrderRepo.save')).toBeUndefined();
    const indirect = edge(g2, 'calls', 'fn:a.ts#un', 'unresolved:a.ts#call:r.save');
    expect(indirect?.resolution).toBe('unresolved');
    expect(node(g2, 'unresolved:a.ts#call:r.save')?.meta).toEqual({
      reason: 'indirect-call',
      reference: 'r.save',
      candidates: ['method:a.ts#SqlOrderRepo.save', 'method:a.ts#SqlUserRepo.save'],
    });
  });

  it('receptor de tipo união de duas classes do projeto: as duas são possíveis, nenhuma resolvida', async () => {
    const root = makeProject({
      'a.ts': [
        'export class Foo { save() {} }',
        'export class Bar { save() {} }',
        'export class SubFoo extends Foo {}',
        'export function both(r: Foo | Bar) { r.save(); }',
        'export function generic<T extends Foo | Bar>(r: T) { r.save(); }',
        // uma declaração só do projeto: continua resolvida
        'export function optional(r?: Foo) { r?.save(); }',
        'export function same(r: Foo | SubFoo) { r.save(); }',
        'export function nullable(r: Foo | null) { r!.save(); }',
      ].join('\n'),
    });
    const g2 = await analyzeProject(root);
    expectValid(g2);
    const calls = (from: string) =>
      g2.edges
        .filter((e) => e.kind === 'calls' && e.source === from)
        .map((e) => [e.target, e.resolution]);
    expect(calls('fn:a.ts#both')).toEqual([['unresolved:a.ts#call:r.save', 'unresolved']]);
    expect(node(g2, 'unresolved:a.ts#call:r.save')?.meta).toEqual({
      reason: 'indirect-call',
      reference: 'r.save',
      candidates: ['method:a.ts#Bar.save', 'method:a.ts#Foo.save'],
    });
    expect(calls('fn:a.ts#generic')).toEqual([['unresolved:a.ts#call:r.save', 'unresolved']]);
    expect(calls('fn:a.ts#optional')).toEqual([['method:a.ts#Foo.save', 'resolved']]);
    expect(calls('fn:a.ts#same')).toEqual([['method:a.ts#Foo.save', 'resolved']]);
    expect(calls('fn:a.ts#nullable')).toEqual([['method:a.ts#Foo.save', 'resolved']]);
    // a interface mostra os dois como possíveis chamados
    expect(possibleCallers(g2, 'method:a.ts#Bar.save')).toEqual([
      'fn:a.ts#both',
      'fn:a.ts#generic',
    ]);
  });

  it('interface e classe com o mesmo nome (declarações mescladas) não são uma união', async () => {
    const root = makeProject({
      'a.ts': [
        'export interface Store { save(): void }',
        'export class Store { save() {} }',
        'export function use(s: Store) { s.save(); }',
      ].join('\n'),
    });
    const g2 = await analyzeProject(root);
    expect(edge(g2, 'calls', 'fn:a.ts#use', 'method:a.ts#Store.save')?.resolution).toBe('resolved');
  });
});

describe('paths por subpacote em monorepos (fixtures/monorepo-paths)', () => {
  let g: RastroGraph;
  beforeAll(async () => {
    g = await analyzeProject(fixture('monorepo-paths'));
  });

  it('gera um grafo válido e informa os tsconfig dos subpacotes', () => {
    expectValid(g);
    expect(g.project.tsconfig).toBe('packages/api/tsconfig.json, packages/web/tsconfig.json');
  });

  it('cada subpacote resolve o próprio alias "@/*" (imports e chamadas)', () => {
    const web = 'packages/web/src';
    expect(
      edge(g, 'imports', `file:${web}/pages/cart.ts`, `file:${web}/lib/format.ts`),
    ).toMatchObject({ resolution: 'resolved', meta: { specifier: '@/lib/format' } });
    expect(
      edge(g, 'calls', `fn:${web}/pages/cart.ts#renderCart`, `fn:${web}/lib/format.ts#formatPrice`)
        ?.resolution,
    ).toBe('resolved');

    // api: "extends" encadeado com baseUrl ./app e "@/*": ["*"]
    const api = 'packages/api/app';
    expect(
      edge(g, 'imports', `file:${api}/handlers/order.ts`, `file:${api}/lib/format.ts`),
    ).toBeDefined();
    expect(
      edge(
        g,
        'calls',
        `fn:${api}/handlers/order.ts#orderSummary`,
        `fn:${api}/lib/format.ts#formatPrice`,
      ),
    ).toBeDefined();
    expect(
      edge(g, 'calls', `fn:${api}/handlers/order.ts#orderSummary`, `fn:${api}/audit.ts#audit`),
    ).toBeDefined();
  });

  it('os aliases não se misturam entre subpacotes nem vazam para fora deles', () => {
    expect(
      g.edges.some(
        (e) =>
          e.source.includes('packages/web/') &&
          e.target.includes('packages/api/') &&
          e.kind !== 'depends_on',
      ),
    ).toBe(false);
    expect(
      g.edges.some((e) => e.source.includes('packages/api/') && e.target.includes('packages/web/')),
    ).toBe(false);
    // scripts/ fica fora dos dois subpacotes: "@/lib/format" não existe ali
    expect(node(g, 'unresolved:scripts/check.ts#import:@/lib/format')?.meta?.reason).toBe(
      'undeclared-package',
    );
    expect(
      g.edges.some((e) => e.source === 'fn:scripts/check.ts#check' && e.resolution === 'resolved'),
    ).toBe(false);
  });

  it('tsconfig inválido em um subpacote vira aviso e o resto continua', async () => {
    const root = makeProject({
      'packages/a/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
      'packages/a/src/x.ts': 'export function x() {}',
      'packages/a/src/y.ts': "import { x } from '@/x';\nexport function y() { x(); }",
      'packages/b/tsconfig.json': '{ "compilerOptions": ',
      // a configuração só é lida quando um arquivo da pasta tem imports para resolver
      'packages/b/z.ts': "import { w } from './w';\nexport function z() { w(); }",
      'packages/b/w.ts': 'export function w() {}',
    });
    const g2 = await analyzeProject(root);
    expect(edge(g2, 'calls', 'fn:packages/a/src/y.ts#y', 'fn:packages/a/src/x.ts#x')).toBeDefined();
    expect(edge(g2, 'calls', 'fn:packages/b/z.ts#z', 'fn:packages/b/w.ts#w')).toBeDefined();
    expect(
      g2.diagnostics.find(
        (d) => d.code === 'invalid-config' && d.file === 'packages/b/tsconfig.json',
      ),
    ).toBeDefined();
  });

  it('alias "@/*" para arquivo que não é código vira arquivo, não pacote npm', () => {
    const theme = 'file:packages/web/src/pages/theme.ts';
    expect(edge(g, 'imports', theme, 'file:packages/web/src/styles/cart.css')).toMatchObject({
      resolution: 'resolved',
      meta: { specifier: '@/styles/cart.css' },
    });
    expect(g.nodes.some((n) => n.id === 'pkg:@/styles')).toBe(false);
    // o alias casa, mas o arquivo (gerado) não existe: é um módulo ausente do projeto
    expect(
      node(g, 'unresolved:packages/web/src/pages/theme.ts#import:@/generated/tokens')?.meta?.reason,
    ).toBe('module-not-found');
  });
});

describe('cadeias de chamadas em várias linhas (fixtures/chains)', () => {
  let g: RastroGraph;
  beforeAll(async () => {
    g = await analyzeProject(fixture('chains'));
  });

  it('gera um grafo válido', () => expectValid(g));

  it('a evidência de cada método da cadeia é a linha do próprio método', () => {
    const B = 'src/builder.ts';
    const at = (target: string) =>
      edge(g, 'calls', 'fn:src/main.ts#report', target)?.evidence.map((e) => [e.line, e.snippet]);
    expect(at(`fn:${B}#query`)).toEqual([[8, 'return query()']]);
    expect(at(`method:${B}#QueryBuilder.where`)).toEqual([[9, ".where('active')"]]);
    expect(at(`method:${B}#QueryBuilder.orderBy`)).toEqual([[10, ".orderBy('name')"]]);
    expect(at(`method:${B}#QueryBuilder.run`)).toEqual([[11, '.run();']]);
    // numa linha só, a coluna é a do nome chamado
    expect(
      edge(g, 'calls', 'fn:src/main.ts#listUsers', `method:${B}#QueryBuilder.run`)?.evidence[0],
    ).toMatchObject({ line: 4, column: 50 });
  });

  it('não resolvidos de cadeia têm nome curto, sem argumentos nem palavras coladas', () => {
    const done = node(g, 'unresolved:src/main.ts#call:pipeline.step(…).step(…).done');
    expect(done?.meta).toMatchObject({ reason: 'indirect-call' });
    expect(done?.location?.startLine).toBe(18);
    expect(edge(g, 'calls', 'fn:src/main.ts#build', done!.id)?.evidence[0]?.snippet).toBe(
      '.done();',
    );
    for (const n of g.nodes.filter((x) => x.kind === 'unresolved')) {
      expect(n.name).not.toMatch(/instanceof|=>/);
      expect(n.name.length).toBeLessThanOrEqual(100);
    }
  });

  it('cadeias muito longas guardam o final (o nome chamado)', async () => {
    const steps = Array.from({ length: 40 }, (_, i) => `  .step('s${i}', (v) => v)`).join('\n');
    const root = makeProject({
      'p.ts': 'export interface P { step(n: string, f: (v: unknown) => unknown): P; done(): void }',
      'use.ts': `import type { P } from './p';\nexport function go(p: P) {\n  p\n${steps}\n  .done();\n}`,
    });
    const g2 = await analyzeProject(root);
    const done = g2.nodes.find((n) => n.kind === 'unresolved' && n.name.endsWith('.done'));
    expect(done?.name.startsWith('…')).toBe(true);
    expect(done?.name.length).toBe(100);
    expectValid(g2);
  });
});

describe("reexportação CommonJS: module.exports = require('./lib/x')", () => {
  it('a chamada do módulo reexportado chega à função exportada pelo arquivo exigido', async () => {
    const g = await analyzeProject(fixture('express-self'));
    expectValid(g);
    for (const example of ['hello', 'multi', 'internal'])
      expect(
        edge(g, 'calls', `file:examples/${example}/index.js`, 'fn:lib/express.js#createApplication')
          ?.resolution,
      ).toBe('resolved');
    expect(g.nodes.some((n) => n.id === 'unresolved:examples/hello/index.js#call:express')).toBe(
      false,
    );
    // `exports.static = require('serve-static')`: pacote declarado, a chamada é externa
    expect(g.nodes.some((n) => n.name === 'express.static')).toBe(false);
    expect(g.stats.externalCallsSkipped).toBeGreaterThan(0);
  });

  it('reexportação de pacote externo continua externa, sem inventar destino', async () => {
    const root = makeProject({
      'package.json': '{"dependencies":{"left-pad":"1"}}',
      'index.js': "module.exports = require('left-pad');\nexports.extra = require('./missing');",
      'use.js': "const pad = require('./index');\npad('x', 3);\npad.extra();",
    });
    const g = await analyzeProject(root);
    expectValid(g);
    expect(g.edges.filter((e) => e.kind === 'calls' && e.resolution === 'resolved')).toEqual([]);
    expect(g.nodes.some((n) => n.kind === 'unresolved' && n.name === 'pad')).toBe(false);
  });
  it('module.exports condicional: nenhum dos lados é comprovado, os dois são possíveis', async () => {
    const root = makeProject({
      'package.json': '{"name":"cond"}',
      'impl1.js': 'module.exports = function one() { return 1; };',
      'impl2.js': 'module.exports = function two() { return 2; };',
      'c.js': [
        'if (process.env.X) {',
        "  module.exports = require('./impl1');",
        '} else {',
        "  module.exports = require('./impl2');",
        '}',
      ].join('\n'),
      'single.js': "module.exports = require('./impl1');",
      'main.js': "const c = require('./c');\nc();\nrequire('./single')();\n",
    });
    const g = await analyzeProject(root);
    expectValid(g);
    const calls = g.edges.filter((e) => e.kind === 'calls' && e.source === 'file:main.js');
    expect(calls.map((e) => [e.target, e.resolution])).toEqual([
      ['unresolved:main.js#call:c', 'unresolved'],
    ]);
    expect(node(g, 'unresolved:main.js#call:c')?.meta).toEqual({
      reason: 'indirect-call',
      reference: 'c',
      candidates: ['fn:impl1.js#one', 'fn:impl2.js#two'],
    });
    // cada `exports` cita a atribuição que produziu aquele alvo
    expect(edge(g, 'exports', 'file:c.js', 'fn:impl1.js#one')?.evidence[0]).toMatchObject({
      line: 2,
      snippet: "module.exports = require('./impl1');",
    });
    expect(edge(g, 'exports', 'file:c.js', 'fn:impl2.js#two')?.evidence[0]).toMatchObject({
      line: 4,
      snippet: "module.exports = require('./impl2');",
    });
    // reexportação única continua comprovada
    expect(edge(g, 'exports', 'file:single.js', 'fn:impl1.js#one')?.resolution).toBe('resolved');
  });

  it('exports.x atribuído duas vezes: chamada não resolvida com os dois candidatos', async () => {
    const root = makeProject({
      'package.json': '{"name":"twice"}',
      'a.js': 'module.exports = function fast() {};',
      'b.js': 'module.exports = function slow() {};',
      'lib.js': [
        "if (process.env.FAST) exports.run = require('./a');",
        "else exports.run = require('./b');",
        "exports.only = require('./a');",
      ].join('\n'),
      'main.js': "const lib = require('./lib');\nlib.run();\nlib.only();\n",
    });
    const g = await analyzeProject(root);
    expectValid(g);
    const calls = g.edges.filter((e) => e.kind === 'calls' && e.source === 'file:main.js');
    expect(calls.map((e) => [e.target, e.resolution]).sort()).toEqual([
      ['fn:a.js#fast', 'resolved'],
      ['unresolved:main.js#call:lib.run', 'unresolved'],
    ]);
    expect(node(g, 'unresolved:main.js#call:lib.run')?.meta?.candidates).toEqual([
      'fn:a.js#fast',
      'fn:b.js#slow',
    ]);
  });
});

describe('regressões da revisão do analisador: alvos que não são comprovados', () => {
  const callsFrom = (g: RastroGraph, from: string) =>
    g.edges
      .filter((e) => e.kind === 'calls' && e.source === from)
      .map((e) => [e.target, e.resolution]);

  it('união com uma parte externa ou de objeto literal: não resolvida, com o método do projeto como candidato', async () => {
    const root = makeProject({
      'package.json': '{"name":"u","dependencies":{"ext":"1"}}',
      'node_modules/ext/package.json': '{"name":"ext","types":"index.d.ts"}',
      'node_modules/ext/index.d.ts': 'export declare class ExtRepo { save(): void }',
      'a.ts': [
        "import { ExtRepo } from 'ext';",
        'export class MyRepo { save() {} }',
        "const memory = { save: () => { console.log('mem'); } };",
        'export function ext(r: MyRepo | ExtRepo) { r.save(); }',
        'export function literal(r: MyRepo | typeof memory) { r.save(); }',
        'export function generic<T extends MyRepo | ExtRepo>(r: T) { r.save(); }',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expectValid(g);
    for (const fn of ['ext', 'literal', 'generic']) {
      const calls = callsFrom(g, `fn:a.ts#${fn}`);
      expect(calls).toEqual([
        [expect.stringMatching(/^unresolved:a\.ts#call:r\.save/), 'unresolved'],
      ]);
      expect(node(g, calls[0]![0]!)?.meta).toMatchObject({
        reason: 'indirect-call',
        candidates: ['method:a.ts#MyRepo.save'],
      });
    }
  });

  it('interseção: só as partes que implementam o membro contam', async () => {
    const root = makeProject({
      'package.json': '{"name":"i","dependencies":{"ext":"1"}}',
      'node_modules/ext/package.json': '{"name":"ext","types":"index.d.ts"}',
      'node_modules/ext/index.d.ts': 'export declare class ExtRepo { save(): void }',
      'a.ts': [
        "import { ExtRepo } from 'ext';",
        'export class Repo { save() {} }',
        'export class Other { save() {} }',
        // a parte extra não declara save: continua sendo Repo.save
        'export function tagged(r: Repo & { tag: string }) { r.save(); }',
        'export function nullable(r: (Repo & { tag: string }) | undefined) { r?.save(); }',
        // duas implementações (do projeto e externa) no mesmo objeto: nenhuma é comprovada
        'export function both(r: Repo & Other) { r.save(); }',
        'export function mixed(r: Repo & ExtRepo) { r.save(); }',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expectValid(g);
    for (const fn of ['tagged', 'nullable'])
      expect(callsFrom(g, `fn:a.ts#${fn}`)).toEqual([['method:a.ts#Repo.save', 'resolved']]);
    for (const fn of ['both', 'mixed']) {
      const calls = callsFrom(g, `fn:a.ts#${fn}`);
      expect(calls).toHaveLength(1);
      expect(calls[0]![1]).toBe('unresolved');
    }
  });

  it('objeto em let (forma curta ou longa): o valor inicial é só candidato', async () => {
    const root = makeProject({
      'a.ts': [
        'export function list() {}',
        'export function other() {}',
        'let api = { list };',
        'api = { list: other };',
        'export function useShorthand() { api.list(); }',
        'let api2 = { list: list };',
        'api2 = { list: other };',
        'export function useLong() { api2.list(); }',
        // const continua comprovado, também com `as const` e `satisfies`
        'const fixed = { list } as const;',
        'export function useConst() { fixed.list(); }',
        'const checked = { list: list } satisfies Record<string, () => void>;',
        'export function useSatisfies() { checked.list(); }',
        // objeto novo devolvido a cada chamada: também comprovado
        'function make() { return { list }; }',
        'const makeArrow = () => ({ list: list });',
        'export function useFactory() { make().list(); makeArrow().list(); }',
        // passado como argumento: quem recebe decide o que devolver
        'function wrap<T>(x: T): T { return x; }',
        'export function useWrapped() { wrap({ list }).list(); }',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expectValid(g);
    expect(callsFrom(g, 'fn:a.ts#useShorthand')).toEqual([
      ['unresolved:a.ts#call:api.list', 'unresolved'],
    ]);
    expect(node(g, 'unresolved:a.ts#call:api.list')?.meta).toEqual({
      reason: 'indirect-call',
      reference: 'api.list',
      candidates: ['fn:a.ts#list'],
    });
    expect(callsFrom(g, 'fn:a.ts#useLong')).toEqual([
      ['unresolved:a.ts#call:api2.list', 'unresolved'],
    ]);
    expect(callsFrom(g, 'fn:a.ts#useConst')).toEqual([['fn:a.ts#list', 'resolved']]);
    expect(callsFrom(g, 'fn:a.ts#useSatisfies')).toEqual([['fn:a.ts#list', 'resolved']]);
    expect(callsFrom(g, 'fn:a.ts#useFactory').sort()).toEqual([
      ['fn:a.ts#list', 'resolved'],
      ['fn:a.ts#make', 'resolved'],
      ['fn:a.ts#makeArrow', 'resolved'],
    ]);
    expect(callsFrom(g, 'fn:a.ts#useWrapped')).toContainEqual([
      expect.stringMatching(/^unresolved:a\.ts#call:wrap\(.*\)\.list$/),
      'unresolved',
    ]);
  });

  it('objeto atribuído a this.h (ou a outra variável) não é comprovado; module.exports = {...} é', async () => {
    const root = makeProject({
      'package.json': '{"name":"bin"}',
      'a.js': [
        'export function foo() {}',
        'export function bar() {}',
        'export class S {',
        '  constructor() { this.h = { run: foo }; }',
        '  swap() { this.h = { run: bar }; }',
        '  go() { this.h.run(); }',
        '}',
      ].join('\n'),
      'lib.js': 'function start() {}\nmodule.exports = { start: start };',
      'main.js': "const lib = require('./lib');\nlib.start();",
    });
    const g = await analyzeProject(root);
    expectValid(g);
    const calls = callsFrom(g, 'method:a.js#S.go');
    expect(calls).toEqual([['unresolved:a.js#call:this.h.run', 'unresolved']]);
    expect(node(g, 'unresolved:a.js#call:this.h.run')?.meta?.reason).toBe('indirect-call');
    expect(callsFrom(g, 'file:main.js')).toEqual([['fn:lib.js#start', 'resolved']]);
  });

  it('propriedade de objeto const reatribuída depois (mesmo arquivo ou importada): os dois valores são candidatos', async () => {
    const root = makeProject({
      'package.json': '{"name":"mut"}',
      'a.js': [
        'export function foo() {}',
        'export function bar() {}',
        'const api = { run: foo };',
        'if (process.env.X) api.run = bar;',
        'export function use() { api.run(); }',
      ].join('\n'),
      'b.ts': [
        'export function foo2() {}',
        'export function bar2() {}',
        'export const api = { run: foo2, keep: foo2 };',
        'export function use2() { api.run(); api.keep(); }',
      ].join('\n'),
      'c.ts': "import { api, bar2 } from './b';\nif (Math.random()) api['run'] = bar2;",
    });
    const g = await analyzeProject(root);
    expectValid(g);
    expect(callsFrom(g, 'fn:a.js#use')).toEqual([['unresolved:a.js#call:api.run', 'unresolved']]);
    expect(node(g, 'unresolved:a.js#call:api.run')?.meta?.candidates).toEqual([
      'fn:a.js#bar',
      'fn:a.js#foo',
    ]);
    // `keep` nunca é reatribuída: continua comprovada
    expect(callsFrom(g, 'fn:b.ts#use2').sort()).toEqual([
      ['fn:b.ts#foo2', 'resolved'],
      ['unresolved:b.ts#call:api.run', 'unresolved'],
    ]);
    expect(node(g, 'unresolved:b.ts#call:api.run')?.meta?.candidates).toEqual([
      'fn:b.ts#bar2',
      'fn:b.ts#foo2',
    ]);
  });

  it('evidência de reexportação: nome explícito antes de export *, e só de quem exporta o nome', async () => {
    const root = makeProject({
      'a.ts': 'export function shared() {}\nexport function onlyA() {}',
      'b.ts': 'export function shared() {}\nexport function onlyB() {}',
      'index.ts': "export * from './a';\nexport * from './b';\nexport { shared } from './b';",
    });
    const g = await analyzeProject(root);
    expect(edge(g, 'exports', 'file:index.ts', 'fn:b.ts#shared')?.evidence[0]?.line).toBe(3);
    expect(edge(g, 'exports', 'file:index.ts', 'fn:a.ts#onlyA')?.evidence[0]?.line).toBe(1);
    expect(edge(g, 'exports', 'file:index.ts', 'fn:b.ts#onlyB')?.evidence[0]?.line).toBe(2);
  });
});

describe('linhas como no git e nos editores (U+2028/U+2029 não quebram linha)', () => {
  it('evidências e locais depois de um U+2028 num texto continuam na linha certa', async () => {
    const root = makeProject({
      'src/a.ts': [
        "export const sep = 'a\u2028b\u2029c';",
        'export function first() {',
        '  return second();',
        '}',
        '',
        'export function second() {',
        '  return 2;',
        '}',
        '',
      ].join('\n'),
      'src/b.ts': "import { first } from './a';\r\n\r\nexport const x = 'y\u2028';\r\nfirst();\r\n",
    });
    const g = await analyzeProject(root);
    expectValid(g);
    expect(node(g, 'fn:src/a.ts#first')?.location).toMatchObject({ startLine: 2, endLine: 4 });
    expect(node(g, 'fn:src/a.ts#second')?.location).toMatchObject({
      startLine: 6,
      startColumn: 1,
      endLine: 8,
    });
    expect(edge(g, 'calls', 'fn:src/a.ts#first', 'fn:src/a.ts#second')?.evidence[0]).toMatchObject({
      line: 3,
      column: 10,
      snippet: 'return second();',
    });
    // \r\n conta uma linha só; o U+2028 dentro do texto, nenhuma
    expect(edge(g, 'calls', 'file:src/b.ts', 'fn:src/a.ts#first')?.evidence[0]).toMatchObject({
      line: 4,
      snippet: 'first();',
    });
    expect(node(g, 'file:src/a.ts')?.meta?.lines).toBe(8);
  });
});

describe('o que o grafo guarda para explicar e comparar mudanças', () => {
  it('métodos abstratos ficam na classe (não viram nós)', async () => {
    const g = await analyzeProject(fixture('oop'));
    expect(node(g, `class:${A}#Animal`)?.meta?.abstractMembers).toEqual(['sound']);
    expect(node(g, `method:${A}#Animal.sound`)).toBeUndefined();
    expect(node(g, `class:${A}#Dog`)?.meta?.abstractMembers).toBeUndefined();
  });

  it('obj.x() sem o membro x num tipo do projeto: não resolvida, com o arquivo do tipo', async () => {
    const root = makeProject({
      'src/dog.ts': 'export class Dog {\n  run(): number {\n    return 1;\n  }\n}\n',
      'src/use.ts': [
        "import { Dog } from './dog';",
        "import * as dogs from './dog';",
        'export function walk(d: Dog, anything: any, m: Record<string, () => void>) {',
        '  d.move();',
        '  d.run();',
        '  anything.move();',
        '  m.go();',
        '  return dogs.nope();',
        '}',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expectValid(g);
    expect(node(g, 'unresolved:src/use.ts#call:d.move')?.meta).toMatchObject({
      reason: 'symbol-not-found',
      receiverFile: 'src/dog.ts',
    });
    expect(node(g, 'unresolved:src/use.ts#call:dogs.nope')?.meta?.receiverFile).toBe('src/dog.ts');
    // `any` e assinatura de índice: nada provado, continua só contado
    expect(node(g, 'unresolved:src/use.ts#call:anything.move')).toBeUndefined();
    expect(node(g, 'unresolved:src/use.ts#call:m.go')).toBeUndefined();
    expect(edge(g, 'calls', 'fn:src/use.ts#walk', 'method:src/dog.ts#Dog.run')?.resolution).toBe(
      'resolved',
    );
  });

  it('base desconhecida em qualquer nível da herança: o membro pode vir dela', async () => {
    const root = makeProject({
      'src/app.ts': [
        "import type { Base } from 'pacote-que-nao-existe';",
        'export interface Middle extends Base {',
        '  listen(): void;',
        '}',
        'export interface App extends Middle {',
        '  use(): void;',
        '}',
        'export class Known {',
        '  run(): void {}',
        '}',
        'export class Child extends Known {}',
      ].join('\n'),
      'src/use.ts': [
        "import type { App, Child } from './app';",
        'export function start(app: App, c: Child) {',
        '  app.close();',
        '  c.nope();',
        '}',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expectValid(g);
    // Base não resolve: `close` pode existir nela, então nada é atribuído ao arquivo de App
    expect(node(g, 'unresolved:src/use.ts#call:app.close')?.meta?.receiverFile).toBeUndefined();
    // hierarquia toda conhecida: o membro comprovadamente não existe
    expect(node(g, 'unresolved:src/use.ts#call:c.nope')?.meta?.receiverFile).toBe('src/app.ts');
  });

  it('nome() sem nada no escopo fica marcado; importado de pacote ausente, não', async () => {
    const root = makeProject({
      'src/use.ts': [
        "import clsx from 'pacote-ausente';",
        "import { thing } from 'outro-ausente';",
        'export function go() {',
        '  clsx();',
        '  thing();',
        '  sumiu();',
        '  return parseInt("1");',
        '}',
      ].join('\n'),
    });
    const g = await analyzeProject(root);
    expectValid(g);
    expect(node(g, 'unresolved:src/use.ts#call:sumiu')?.meta?.undeclared).toBe(true);
    for (const name of ['clsx', 'thing'])
      expect(node(g, `unresolved:src/use.ts#call:${name}`)?.meta?.undeclared).toBeUndefined();
  });

  it('lista de exports incompleta: export * de módulo que não se vê e CommonJS dinâmico', async () => {
    const root = makeProject({
      'src/db.ts':
        "export * from 'pacote-ausente';\nexport * from './gerado/api';\nexport const local = 1;\n",
      'src/barrel.ts': "export * from './db';\n",
      'src/ok.ts': "export * from './db2';\n",
      'src/db2.ts': 'export const x = 1;\n',
      'lib/star.js':
        "var __exportStar = function (m, e) { for (var p in m) e[p] = m[p]; };\nObject.defineProperty(exports, '__esModule', { value: true });\n__exportStar(require('./inner'), exports);\nexports.own = 1;\n",
      'lib/inner.js': 'exports.inner = 1;\n',
      'lib/assign.js': 'Object.assign(module.exports, { a1: 1 });\n',
      'lib/computed.js': "const k = 'x';\nexports[k] = 1;\n",
      'lib/plain.js':
        "exports.foo = function () {};\nObject.defineProperty(exports, 'baz', { get() { return 1; } });\n",
      'lib/esm.js': 'export const e = 1;\n',
    });
    const g = await analyzeProject(root);
    expectValid(g);
    const meta = (rel: string) => node(g, `file:${rel}`)?.meta;
    for (const rel of [
      'src/db.ts',
      'src/barrel.ts',
      'lib/star.js',
      'lib/assign.js',
      'lib/computed.js',
    ])
      expect(meta(rel)?.exportsIncomplete, rel).toBe(true);
    for (const rel of ['src/ok.ts', 'src/db2.ts', 'lib/plain.js', 'lib/inner.js', 'lib/esm.js'])
      expect(meta(rel)?.exportsIncomplete, rel).toBeUndefined();
    // CommonJS: um import default recebe o module.exports inteiro
    for (const rel of ['lib/star.js', 'lib/plain.js', 'lib/inner.js', 'lib/assign.js'])
      expect(meta(rel)?.commonjs, rel).toBe(true);
    for (const rel of ['lib/esm.js', 'src/db.ts']) expect(meta(rel)?.commonjs, rel).toBeUndefined();
  });

  it('rota com handler inline fica marcada; com handler referenciado, não', async () => {
    const g = await analyzeProject(fixture('express-api'));
    const routes = g.nodes.filter((n) => n.kind === 'route');
    const inline = routes.filter((n) => n.meta?.inlineHandler).map((n) => n.name);
    const named = routes.filter((n) => !n.meta?.inlineHandler).map((n) => n.name);
    expect(named).toEqual(expect.arrayContaining(['GET /users/:id', 'DELETE /users/:id']));
    expect(inline).toEqual(['POST /users']);
  });
});
