import { describe, expect, it } from 'vitest';
import { nodeId, SCHEMA_VERSION, type ChangeSet, type RastroGraph } from '@rastro/core';
import { computeChangeImpact, GraphBuilder, GraphIndex } from '@rastro/graph';

/**
 * src/config.ts: `export const LIMIT` (linha 1, não vira nó) e `f` (linhas 2–4).
 * src/use.ts importa config.ts e `g` chama `f`.
 */
function sample(): GraphIndex {
  const b = new GraphBuilder();
  const mod = b.ensureModule('src');
  for (const file of ['src/config.ts', 'src/use.ts']) {
    b.addNode({ id: nodeId.file(file), kind: 'file', name: file.slice(4), parent: mod });
    b.addEdge({
      kind: 'contains',
      source: mod,
      target: nodeId.file(file),
      resolution: 'resolved',
      discovery: 'static-ast',
    });
  }
  const fn = (file: string, name: string, startLine: number, endLine: number) => {
    const id = nodeId.function(file, name);
    b.addNode({
      id,
      kind: 'function',
      name,
      parent: nodeId.file(file),
      location: { file, startLine, startColumn: 1, endLine, endColumn: 2 },
    });
    b.addEdge({
      kind: 'contains',
      source: nodeId.file(file),
      target: id,
      resolution: 'resolved',
      discovery: 'static-ast',
    });
    return id;
  };
  const f = fn('src/config.ts', 'f', 2, 4);
  const g = fn('src/use.ts', 'g', 2, 2);
  b.addEdge({
    kind: 'imports',
    source: nodeId.file('src/use.ts'),
    target: nodeId.file('src/config.ts'),
    resolution: 'resolved',
    discovery: 'static-ast',
    evidence: { file: 'src/use.ts', line: 1, column: 1 },
  });
  b.addEdge({
    kind: 'calls',
    source: g,
    target: f,
    resolution: 'resolved',
    discovery: 'static-typecheck',
    evidence: { file: 'src/use.ts', line: 2, column: 1 },
  });
  const done = b.finalize();
  const graph = {
    schemaVersion: SCHEMA_VERSION,
    nodes: done.nodes,
    edges: done.edges,
  } as unknown as RastroGraph;
  return new GraphIndex(graph);
}

const changes = (file: ChangeSet['files'][number]): ChangeSet => ({
  base: 'HEAD',
  baseLabel: 'HEAD',
  includesUntracked: true,
  files: [file],
});

describe('computeChangeImpact: trechos só removidos', () => {
  it('remoção fora de qualquer entidade (ex.: export const apagado) muda o arquivo', () => {
    const impact = computeChangeImpact(
      sample(),
      changes({ file: 'src/config.ts', status: 'modified', ranges: [], deletionsAt: [1] }),
    );
    expect(impact.changedEntities).toEqual([]);
    expect(impact.impacted.map((i) => i.node.id)).toContain('file:src/use.ts');
  });

  it('remoção logo antes de uma função também conta como mudança no topo do arquivo', () => {
    // o trecho removido ficava entre a linha 1 e a 2 (onde `f` começa): fora de `f`
    const impact = computeChangeImpact(
      sample(),
      changes({ file: 'src/config.ts', status: 'modified', ranges: [], deletionsAt: [2] }),
    );
    expect(impact.changedEntities).toEqual([]); // `f` em si não mudou
    expect(impact.impacted.map((i) => i.node.id)).toContain('file:src/use.ts');
  });

  it('remoção dentro de uma função muda só a função', () => {
    const impact = computeChangeImpact(
      sample(),
      changes({ file: 'src/config.ts', status: 'modified', ranges: [], deletionsAt: [3] }),
    );
    expect(impact.changedEntities.map((n) => n.id)).toEqual(['fn:src/config.ts#f']);
    const impacted = impact.impacted.map((i) => i.node.id);
    expect(impacted).toContain('fn:src/use.ts#g');
    expect(impacted).not.toContain('file:src/use.ts');
  });
});
