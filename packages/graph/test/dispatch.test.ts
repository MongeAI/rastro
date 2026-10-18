import { describe, expect, it } from 'vitest';
import { nodeId, SCHEMA_VERSION, type RastroGraph } from '@rastro/core';
import { findPathBetween, GraphBuilder, GraphIndex, specifierCandidates } from '@rastro/graph';

const F = 'src/animals.ts';
const cls = (name: string) => nodeId.class(F, name);
const method = (owner: string, name: string) => nodeId.method(F, owner, name);

/**
 * Animal (constructor, move) ← Dog (constructor, move com super.move()) ← Puppy (sem
 * construtor) ← Grandchild (constructor com super(), que roda o de Dog).
 * `run` faz `animal.move()` (resolvido para Animal.move) e `new Puppy()`.
 */
function animals(): GraphIndex {
  const b = new GraphBuilder();
  const file = nodeId.file(F);
  b.addNode({ id: file, kind: 'file', name: 'animals.ts', qualifiedName: F });
  const ev = (line: number, snippet: string) => ({ file: F, line, column: 1, snippet });
  for (const name of ['Animal', 'Dog', 'Puppy', 'Grandchild'])
    b.addNode({ id: cls(name), kind: 'class', name, qualifiedName: name, parent: file });
  const members: Array<[string, string, 'method' | 'constructor']> = [
    ['Animal', 'constructor', 'constructor'],
    ['Animal', 'move', 'method'],
    ['Dog', 'constructor', 'constructor'],
    ['Dog', 'move', 'method'],
    ['Grandchild', 'constructor', 'constructor'],
  ];
  for (const [owner, name, memberKind] of members)
    b.addNode({
      id: method(owner, name),
      kind: 'method',
      name,
      qualifiedName: `${owner}.${name}`,
      parent: cls(owner),
      meta: { memberKind },
    });
  b.addNode({ id: nodeId.function(F, 'run'), kind: 'function', name: 'run', parent: file });
  const extend = (sub: string, base: string) =>
    b.addEdge({
      kind: 'extends',
      source: cls(sub),
      target: cls(base),
      resolution: 'resolved',
      discovery: 'static-typecheck',
      evidence: ev(1, `class ${sub} extends ${base}`),
    });
  extend('Dog', 'Animal');
  extend('Puppy', 'Dog');
  extend('Grandchild', 'Puppy');
  const call = (
    source: string,
    target: string,
    snippet: string,
    callKind: 'call' | 'new' = 'call',
  ) =>
    b.addEdge({
      kind: 'calls',
      source,
      target,
      resolution: 'resolved',
      discovery: 'static-typecheck',
      evidence: ev(10, snippet),
      meta: { callKind },
    });
  const run = nodeId.function(F, 'run');
  call(run, method('Animal', 'move'), 'animal.move();');
  call(run, cls('Puppy'), "const p = new Puppy('rex');", 'new');
  call(method('Dog', 'move'), method('Animal', 'move'), 'return super.move();');
  call(method('Dog', 'constructor'), method('Animal', 'constructor'), 'super(name);');
  call(method('Grandchild', 'constructor'), method('Dog', 'constructor'), "super('neto');");
  const f = b.finalize();
  return new GraphIndex({
    schemaVersion: SCHEMA_VERSION,
    nodes: f.nodes,
    edges: f.edges,
    project: { name: 't', root: '/t', languages: ['ts'] },
  } as unknown as RastroGraph);
}

describe('construtores: `new` de subclasse sem construtor roda o herdado', () => {
  it('constructionSites: o new da classe e das subclasses sem construtor próprio', () => {
    const index = animals();
    const sites = (id: string) =>
      index.constructionSites(id).map((e) => `${e.source}->${e.target}`);
    expect(sites(method('Dog', 'constructor'))).toEqual([`fn:${F}#run->${cls('Puppy')}`]);
    // Dog tem construtor próprio: `new Puppy()` chega em Animal só pelo super() de Dog
    expect(sites(method('Animal', 'constructor'))).toEqual([]);
    expect(sites(method('Dog', 'move'))).toEqual([]);
  });

  it('o impacto de um construtor inclui quem faz new (direto ou pela cadeia de super)', () => {
    const index = animals();
    const dog = index.impact(method('Dog', 'constructor')).map((i) => [i.node.name, i.depth]);
    expect(dog).toContainEqual(['run', 1]);
    expect(dog).toContainEqual(['constructor', 1]); // Grandchild.constructor (super)
    const animal = index.impact(method('Animal', 'constructor')).map((i) => [i.node.id, i.depth]);
    expect(animal).toContainEqual([`fn:${F}#run`, 2]);
  });
});

describe('sobrescrita: chamadas ao método da base podem cair na subclasse', () => {
  it('overriddenMethods e dispatchCalls (sem o super.metodo() da própria sobrescrita)', () => {
    const index = animals();
    expect(index.overriddenMethods(method('Dog', 'move')).map((n) => n.id)).toEqual([
      method('Animal', 'move'),
    ]);
    expect(index.overriddenMethods(method('Animal', 'move'))).toEqual([]);
    expect(index.overriddenMethods(method('Dog', 'constructor'))).toEqual([]);
    expect(
      index.dispatchCalls(method('Dog', 'move')).map((d) => [d.edge.source, d.base.id]),
    ).toEqual([[`fn:${F}#run`, method('Animal', 'move')]]);
  });
});

describe('specifierCandidates: para onde um import relativo pode apontar', () => {
  it('extensões do TypeScript, o .js do ESM e index; nunca fora da raiz', () => {
    const c = specifierCandidates('apps/cli/src/index.ts', './term.js');
    expect(c).toContain('apps/cli/src/term.ts');
    expect(specifierCandidates('src/a/b.ts', '../lib')).toContain('src/lib/index.ts');
    expect(specifierCandidates('src/a.ts', '../../x')).toEqual([]);
    expect(specifierCandidates('src/a.ts', 'lodash')).toEqual([]);
  });
});

describe('findPathBetween: de um conjunto a outro', () => {
  it('chega no primeiro nó do destino; o pacote externo só como último passo', () => {
    const b = new GraphBuilder();
    for (const id of ['file:a.ts', 'file:b.ts', 'file:c.ts'])
      b.addNode({ id, kind: 'file', name: id.slice(5) });
    b.addNode({ id: 'pkg:lodash', kind: 'package', name: 'lodash' });
    const imp = (s: string, t: string, resolution: 'resolved' | 'external' = 'resolved') =>
      b.addEdge({
        kind: 'imports',
        source: s,
        target: t,
        resolution,
        discovery: 'static-ast',
        evidence: { file: s.slice(5), line: 1, column: 1 },
      });
    imp('file:a.ts', 'file:b.ts');
    imp('file:b.ts', 'file:c.ts');
    imp('file:c.ts', 'pkg:lodash', 'external');
    const f = b.finalize();
    const index = new GraphIndex({
      nodes: f.nodes,
      edges: f.edges,
      project: { name: 't', root: '/t', languages: ['ts'] },
    } as unknown as RastroGraph);
    expect(
      findPathBetween(index, ['file:a.ts'], new Set(['file:b.ts', 'file:c.ts']))?.nodes,
    ).toEqual(['file:a.ts', 'file:b.ts']);
    expect(
      findPathBetween(index, ['file:a.ts'], new Set(['pkg:lodash']), { external: true })?.nodes,
    ).toEqual(['file:a.ts', 'file:b.ts', 'file:c.ts', 'pkg:lodash']);
    expect(findPathBetween(index, ['file:a.ts'], new Set(['pkg:lodash']))).toBeNull();
    expect(findPathBetween(index, ['file:c.ts'], new Set(['file:a.ts']))).toBeNull();
  });
});
