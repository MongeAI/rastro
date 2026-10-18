import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type RastroGraph } from '@rastro/core';
import {
  findPaths,
  findPossiblePath,
  GraphBuilder,
  GraphIndex,
  routesAndTests,
} from '@rastro/graph';

/** a → b → d, a → c → d, d → e; f isolado. */
function diamond(): GraphIndex {
  const b = new GraphBuilder();
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f'])
    b.addNode({ id: `fn:x.ts#${id}`, kind: 'function', name: id });
  const call = (s: string, t: string, resolution: 'resolved' | 'unresolved' = 'resolved') =>
    b.addEdge({
      kind: 'calls',
      source: `fn:x.ts#${s}`,
      target: `fn:x.ts#${t}`,
      resolution,
      discovery: 'static-typecheck',
      evidence: { file: 'x.ts', line: 1, column: 1 },
    });
  call('a', 'b');
  call('b', 'd');
  call('a', 'c');
  call('c', 'd');
  call('d', 'e');
  call('a', 'f', 'unresolved');
  const f = b.finalize();
  const graph = {
    schemaVersion: SCHEMA_VERSION,
    nodes: f.nodes,
    edges: f.edges,
    project: { name: 't', root: '/t', languages: ['ts'] },
  } as unknown as RastroGraph;
  return new GraphIndex(graph);
}

const short = (ids: string[]) => ids.map((id) => id.split('#')[1]).join('→');

describe('findPaths', () => {
  const index = diamond();

  it('acha o menor caminho e as alternativas, sem repetir', () => {
    const result = findPaths(index, 'fn:x.ts#a', 'fn:x.ts#e');
    expect(result.reversed).toBe(false);
    expect(result.paths.map((p) => short(p.nodes))).toEqual(['a→b→d→e', 'a→c→d→e']);
    expect(result.paths[0]!.edges.map((e) => e.kind)).toEqual(['calls', 'calls', 'calls']);
  });

  it('procura no sentido inverso quando só existe esse caminho', () => {
    const result = findPaths(index, 'fn:x.ts#e', 'fn:x.ts#a');
    expect(result.reversed).toBe(true);
    expect(short(result.paths[0]!.nodes)).toBe('a→b→d→e');
  });

  it('não usa relações não resolvidas', () => {
    expect(findPaths(index, 'fn:x.ts#a', 'fn:x.ts#f').paths).toEqual([]);
  });

  it('respeita o limite de alternativas', () => {
    expect(findPaths(index, 'fn:x.ts#a', 'fn:x.ts#e', { limit: 1 }).paths).toHaveLength(1);
  });

  it('limite menor que 1 não devolve caminho nenhum', () => {
    for (const limit of [0, -1])
      expect(findPaths(index, 'fn:x.ts#a', 'fn:x.ts#e', { limit })).toEqual({
        paths: [],
        reversed: false,
      });
  });
});

/**
 * a → i (não resolvido, candidatos x e y); x → z; y é isolado; a → w comprovado; w → z.
 * O caminho comprovado a → w → z existe; até y, só pelo candidato.
 */
function viaInterface(): GraphIndex {
  const b = new GraphBuilder();
  for (const id of ['a', 'w', 'x', 'y', 'z'])
    b.addNode({ id: `fn:x.ts#${id}`, kind: 'function', name: id });
  b.addNode({
    id: 'unresolved:x.ts#call:repo.save',
    kind: 'unresolved',
    name: 'repo.save',
    meta: { reason: 'indirect-call', candidates: ['fn:x.ts#x', 'fn:x.ts#y', 'fn:x.ts#sumiu'] },
  });
  const call = (s: string, t: string, resolution: 'resolved' | 'unresolved' = 'resolved') =>
    b.addEdge({
      kind: 'calls',
      source: `fn:x.ts#${s}`,
      target: t.includes(':') ? t : `fn:x.ts#${t}`,
      resolution,
      discovery: 'static-typecheck',
      evidence: { file: 'x.ts', line: 1, column: 1 },
    });
  call('a', 'unresolved:x.ts#call:repo.save', 'unresolved');
  call('a', 'w');
  call('w', 'z');
  call('x', 'z');
  const f = b.finalize();
  return new GraphIndex({
    schemaVersion: SCHEMA_VERSION,
    nodes: f.nodes,
    edges: f.edges,
    project: { name: 't', root: '/t', languages: ['ts'] },
  } as unknown as RastroGraph);
}

describe('findPossiblePath', () => {
  const index = viaInterface();

  it('caminho que depende de uma chamada não resolvida ir para um candidato', () => {
    const path = findPossiblePath(index, 'fn:x.ts#a', 'fn:x.ts#y')!;
    expect(path).toHaveLength(1);
    expect(path[0]).toMatchObject({ to: 'fn:x.ts#y', possible: true });
    expect(path[0]!.edge.target).toBe('unresolved:x.ts#call:repo.save');
  });

  it('nada quando o menor caminho é todo comprovado (findPaths já o acha) ou não existe', () => {
    expect(findPossiblePath(index, 'fn:x.ts#a', 'fn:x.ts#z')).toBeNull();
    expect(findPossiblePath(index, 'fn:x.ts#z', 'fn:x.ts#a')).toBeNull();
    expect(findPossiblePath(index, 'fn:x.ts#a', 'fn:x.ts#a')).toBeNull();
    expect(findPossiblePath(index, 'fn:x.ts#a', 'fn:x.ts#sumiu')).toBeNull();
  });
});

describe('routesAndTests', () => {
  it('rotas e arquivos de teste entre as entidades envolvidas, sem repetir', () => {
    const b = new GraphBuilder();
    b.addNode({
      id: 'file:test/a.test.ts',
      kind: 'file',
      name: 'a.test.ts',
      qualifiedName: 'test/a.test.ts',
    });
    b.addNode({
      id: 'fn:test/a.test.ts#t',
      kind: 'function',
      name: 't',
      parent: 'file:test/a.test.ts',
    });
    b.addNode({ id: 'file:src/a.ts', kind: 'file', name: 'a.ts', qualifiedName: 'src/a.ts' });
    b.addNode({
      id: 'route:src/a.ts#app GET /',
      kind: 'route',
      name: 'GET /',
      parent: 'file:src/a.ts',
    });
    const f = b.finalize();
    const index = new GraphIndex({ nodes: f.nodes, edges: f.edges } as unknown as RastroGraph);
    const nodes = [...index.nodes.values()];
    const result = routesAndTests(index, [...nodes, ...nodes]);
    expect(result.routes.map((n) => n.id)).toEqual(['route:src/a.ts#app GET /']);
    expect(result.tests.map((n) => n.id)).toEqual(['file:test/a.test.ts']);
  });
});
