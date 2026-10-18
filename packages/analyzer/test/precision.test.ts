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

  it('receptor de tipo união: a parte concreta é resolvida e a da interface fica possível', async () => {
    const root = makeProject({
      'a.ts': [...repos, 'export function un(r: UserRepo | SqlOrderRepo) { r.save(); }'].join('\n'),
    });
    const g2 = await analyzeProject(root);
    expectValid(g2);
    expect(edge(g2, 'calls', 'fn:a.ts#un', 'method:a.ts#SqlOrderRepo.save')?.resolution).toBe(
      'resolved',
    );
    const indirect = edge(g2, 'calls', 'fn:a.ts#un', 'unresolved:a.ts#call:r.save');
    expect(indirect?.resolution).toBe('unresolved');
    expect(node(g2, 'unresolved:a.ts#call:r.save')?.meta).toEqual({
      reason: 'indirect-call',
      reference: 'r.save',
      candidates: ['method:a.ts#SqlUserRepo.save'],
    });
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
});
