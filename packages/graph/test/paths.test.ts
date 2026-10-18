import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type RastroGraph } from '@rastro/core';
import { findPaths, GraphBuilder, GraphIndex } from '@rastro/graph';

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
