import { describe, expect, it } from 'vitest';
import { nodeId, SCHEMA_VERSION, type RastroGraph, type Resolution } from '@rastro/core';
import { compareGraphs, GraphBuilder } from '@rastro/graph';

interface Spec {
  files: string[];
  functions: Array<[file: string, name: string]>;
  imports: Array<[from: string, to: string, resolution?: Resolution]>;
  generatedAt: string;
}

/** Monta um grafo pequeno a partir de listas simples (arquivos na raiz). */
function graph(spec: Spec): RastroGraph {
  const b = new GraphBuilder();
  const root = b.ensureModule('');
  for (const f of spec.files) {
    b.addNode({ id: nodeId.file(f), kind: 'file', name: f, qualifiedName: f, parent: root });
    b.addEdge({
      kind: 'contains',
      source: root,
      target: nodeId.file(f),
      resolution: 'resolved',
      discovery: 'derived',
    });
  }
  for (const [f, name] of spec.functions) {
    const id = nodeId.function(f, name);
    b.addNode({
      id,
      kind: 'function',
      name,
      parent: nodeId.file(f),
      location: { file: f, startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 },
    });
    b.addEdge({
      kind: 'contains',
      source: nodeId.file(f),
      target: id,
      resolution: 'resolved',
      discovery: 'static-ast',
    });
  }
  for (const [from, to, resolution = 'resolved'] of spec.imports) {
    const target = resolution === 'resolved' ? nodeId.file(to) : `unresolved:${from}#import:${to}`;
    if (resolution !== 'resolved')
      b.addNode({ id: target, kind: 'unresolved', name: to, meta: { reason: 'module-not-found' } });
    b.addEdge({
      kind: 'imports',
      source: nodeId.file(from),
      target,
      resolution,
      discovery: 'static-ast',
      evidence: { file: from, line: 1, column: 1 },
    });
  }
  const f = b.finalize();
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: spec.generatedAt,
    tool: { name: 'rastro', version: '0.2.0' },
    project: { name: 'demo', root: '/demo', languages: ['ts'] },
    analyzer: {
      name: 't',
      version: '0',
      typescriptVersion: '0',
      options: { exclude: [], respectGitignore: true, maxFiles: 1, maxFileSizeBytes: 1 },
    },
    nodes: f.nodes,
    edges: f.edges,
    stats: {
      files: spec.files.length,
      nodesByKind: f.nodesByKind,
      edgesByKind: f.edgesByKind,
      edgesByResolution: f.edgesByResolution,
      importCycles: f.importCycles,
      externalCallsSkipped: 0,
      unknownReceiverCalls: 0,
      computedCalls: 0,
      localCalls: 0,
      durationMs: 0,
    },
    diagnostics: [],
  };
}

const before = graph({
  generatedAt: '2026-01-01T00:00:00.000Z',
  files: ['a.ts', 'b.ts', 'old.ts'],
  functions: [
    ['a.ts', 'run'],
    ['old.ts', 'legacy'],
  ],
  imports: [
    ['a.ts', 'b.ts'],
    ['a.ts', 'old.ts'],
  ],
});

const after = graph({
  generatedAt: '2026-01-02T00:00:00.000Z',
  files: ['a.ts', 'b.ts', 'c.ts'],
  functions: [
    ['a.ts', 'run'],
    ['c.ts', 'novo'],
  ],
  imports: [
    ['a.ts', 'b.ts'],
    ['b.ts', 'a.ts'], // ciclo novo a ↔ b
    ['c.ts', './sumiu', 'unresolved'],
  ],
});

describe('compareGraphs', () => {
  it('lista o que entrou e saiu, por id e em ordem estável', () => {
    const diff = compareGraphs(before, after);
    expect(diff.nodes.added.map((n) => n.id)).toEqual([
      'file:c.ts',
      'fn:c.ts#novo',
      'unresolved:c.ts#import:./sumiu',
    ]);
    expect(diff.nodes.removed.map((n) => n.id)).toEqual(['file:old.ts', 'fn:old.ts#legacy']);
    expect(diff.nodes.added[1]).toEqual({
      id: 'fn:c.ts#novo',
      kind: 'function',
      name: 'novo',
      file: 'c.ts',
    });
    expect(diff.edges.added.map((e) => e.id)).toEqual([
      'imports:file:b.ts->file:a.ts',
      'imports:file:c.ts->unresolved:c.ts#import:./sumiu',
    ]);
    expect(diff.edges.removed.map((e) => e.id)).toEqual(['imports:file:a.ts->file:old.ts']);
    // relações "contains" só repetiriam os nós: ficam de fora por padrão
    expect(diff.edges.added.some((e) => e.kind === 'contains')).toBe(false);
    const withContains = compareGraphs(before, after, { includeContains: true });
    expect(withContains.edges.added.some((e) => e.kind === 'contains')).toBe(true);
    expect(diff.identical).toBe(false);
  });

  it('mostra ciclos novos e as diferenças nos números', () => {
    const diff = compareGraphs(before, after);
    expect(diff.cycles.added).toEqual([['file:a.ts', 'file:b.ts']]);
    expect(diff.cycles.removed).toEqual([]);
    expect(diff.stats.files).toEqual({ before: 3, after: 3, delta: 0 });
    expect(diff.stats.functions).toEqual({ before: 2, after: 2, delta: 0 });
    expect(diff.stats.unresolved).toEqual({ before: 0, after: 1, delta: 1 });
    expect(diff.stats.cycles).toEqual({ before: 0, after: 1, delta: 1 });
    expect(diff.before.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(diff.after.generatedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('detecta relações cuja resolução mudou', () => {
    const a = graph({
      generatedAt: '',
      files: ['a.ts'],
      functions: [],
      imports: [['a.ts', 'x', 'unresolved']],
    });
    const b = structuredClone(a);
    b.edges[b.edges.length - 1]!.resolution = 'external';
    const diff = compareGraphs(a, b);
    expect(diff.edges.resolutionChanged).toEqual([
      {
        id: 'imports:file:a.ts->unresolved:a.ts#import:x',
        kind: 'imports',
        source: 'file:a.ts',
        target: 'unresolved:a.ts#import:x',
        before: 'unresolved',
        after: 'external',
      },
    ]);
    expect(diff.edges.added).toEqual([]);
  });

  it('rota cujo endereço (caminho completo ou montagem) mudou, com o mesmo id', () => {
    const a = graph({ generatedAt: '', files: ['s.js'], functions: [], imports: [] });
    a.nodes.push({
      id: 'route:s.js#r GET /x',
      kind: 'route',
      name: 'GET /api/x',
      parent: 'file:s.js',
      meta: { httpMethod: 'GET', routePath: '/x', fullPath: '/api/x', mountedAt: ['/api'] },
    });
    const b = structuredClone(a);
    const route = b.nodes[b.nodes.length - 1]!;
    route.name = 'GET /v2/x';
    route.meta = { ...route.meta, fullPath: '/v2/x', mountedAt: ['/v2'] };
    const diff = compareGraphs(a, b);
    expect(diff.identical).toBe(false);
    expect(diff.nodes.changed).toEqual([
      {
        id: 'route:s.js#r GET /x',
        kind: 'route',
        name: 'GET /v2/x',
        before: { fullPath: '/api/x', mountedAt: ['/api'] },
        after: { fullPath: '/v2/x', mountedAt: ['/v2'] },
      },
    ]);
    // caminho completo que deixou de ser comprovado também é mudança
    delete route.meta!.fullPath;
    expect(compareGraphs(a, b).nodes.changed[0]?.after).toEqual({ mountedAt: ['/v2'] });
    expect(compareGraphs(a, structuredClone(a)).nodes.changed).toEqual([]);
  });

  it('duas análises iguais não têm diferenças', () => {
    const diff = compareGraphs(before, structuredClone(before));
    expect(diff.identical).toBe(true);
    expect(Object.values(diff.stats).every((s) => s.delta === 0)).toBe(true);
  });
});
