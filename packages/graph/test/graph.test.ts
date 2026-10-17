import { describe, expect, it } from 'vitest';
import {
  nodeId,
  SCHEMA_VERSION,
  type NodeKind,
  type EdgeKind,
  type RastroGraph,
} from '@rastro/core';
import {
  computeView,
  GraphBuilder,
  GraphIndex,
  groupableModules,
  MAX_EVIDENCE_PER_EDGE,
  stronglyConnectedComponents,
} from '@rastro/graph';

const ev = (line: number) => ({ file: 'src/a.ts', line, column: 1 });

/** Projeto pequeno: src/a.ts (run → helper), src/b.ts (Svc.go → run), lib/c.ts importado por b. */
function sampleGraph(): RastroGraph {
  const b = new GraphBuilder();
  const files = ['src/a.ts', 'src/b.ts', 'lib/c.ts'];
  for (const f of files) {
    const mod = b.ensureModule(f.split('/')[0]!);
    b.addNode({
      id: nodeId.file(f),
      kind: 'file',
      name: f.split('/')[1]!,
      qualifiedName: f,
      parent: mod,
    });
    b.addEdge({
      kind: 'contains',
      source: mod,
      target: nodeId.file(f),
      resolution: 'resolved',
      discovery: 'static-ast',
    });
  }
  const sym = (kind: NodeKind, id: string, name: string, parent: string) => {
    b.addNode({
      id,
      kind,
      name,
      parent,
      location: { file: 'x', startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 },
    });
    b.addEdge({
      kind: 'contains',
      source: parent,
      target: id,
      resolution: 'resolved',
      discovery: 'static-ast',
    });
  };
  sym('function', 'fn:src/a.ts#run', 'run', 'file:src/a.ts');
  sym('function', 'fn:src/a.ts#helper', 'helper', 'file:src/a.ts');
  sym('class', 'class:src/b.ts#Svc', 'Svc', 'file:src/b.ts');
  sym('method', 'method:src/b.ts#Svc.go', 'go', 'class:src/b.ts#Svc');
  const call = (s: string, t: string, line = 1) =>
    b.addEdge({
      kind: 'calls',
      source: s,
      target: t,
      resolution: 'resolved',
      discovery: 'static-typecheck',
      evidence: ev(line),
    });
  call('fn:src/a.ts#run', 'fn:src/a.ts#helper');
  call('method:src/b.ts#Svc.go', 'fn:src/a.ts#run');
  const imp = (s: string, t: string) =>
    b.addEdge({
      kind: 'imports',
      source: nodeId.file(s),
      target: nodeId.file(t),
      resolution: 'resolved',
      discovery: 'static-ast',
      evidence: ev(1),
    });
  imp('src/b.ts', 'src/a.ts');
  imp('src/b.ts', 'lib/c.ts');
  imp('lib/c.ts', 'src/b.ts'); // ciclo b ↔ c
  const f = b.finalize();
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '',
    tool: { name: 'rastro', version: '0.1.0' },
    project: { name: 't', root: '/t', languages: ['ts'] },
    analyzer: {
      name: 't',
      version: '0',
      typescriptVersion: '0',
      options: { exclude: [], respectGitignore: true, maxFiles: 1, maxFileSizeBytes: 1 },
    },
    nodes: f.nodes,
    edges: f.edges,
    stats: {
      files: 3,
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

describe('GraphBuilder', () => {
  it('mescla relações repetidas, acumulando evidências e contagem', () => {
    const b = new GraphBuilder();
    b.addNode({ id: 'a', kind: 'function', name: 'a' });
    b.addNode({ id: 'b', kind: 'function', name: 'b' });
    for (let i = 1; i <= MAX_EVIDENCE_PER_EDGE + 5; i++)
      b.addEdge({
        kind: 'calls',
        source: 'a',
        target: 'b',
        resolution: 'resolved',
        discovery: 'static-ast',
        evidence: ev(i),
      });
    b.addEdge({
      kind: 'calls',
      source: 'a',
      target: 'b',
      resolution: 'resolved',
      discovery: 'static-ast',
      evidence: ev(1),
    });
    const { edges } = b.finalize();
    expect(edges).toHaveLength(1);
    expect(edges[0]!.evidence).toHaveLength(MAX_EVIDENCE_PER_EDGE);
    expect(edges[0]!.meta?.count).toBe(MAX_EVIDENCE_PER_EDGE + 6);
  });

  it('cria a cadeia de módulos', () => {
    const b = new GraphBuilder();
    b.ensureModule('src/features/auth');
    const ids = b.finalize().nodes.map((n) => n.id);
    expect(ids).toEqual([
      'module:.',
      'module:src',
      'module:src/features',
      'module:src/features/auth',
    ]);
  });

  it('deriva dependências entre módulos e marca ciclos', () => {
    const g = sampleGraph();
    expect(g.edges.find((e) => e.id === 'depends_on:module:src->module:lib')?.discovery).toBe(
      'derived',
    );
    expect(g.stats.importCycles).toEqual([['file:lib/c.ts', 'file:src/b.ts']]);
    expect(g.nodes.find((n) => n.id === 'file:lib/c.ts')?.meta?.inCycle).toBe(true);
    expect(g.nodes.find((n) => n.id === 'file:src/a.ts')?.meta?.inCycle).toBeFalsy();
  });
});

describe('stronglyConnectedComponents', () => {
  it('encontra ciclos sem recursão profunda', () => {
    const adj = new Map<string, string[]>();
    const n = 20_000;
    for (let i = 0; i < n; i++) adj.set(`n${i}`, [`n${(i + 1) % n}`]);
    const sccs = stronglyConnectedComponents(adj);
    expect(sccs).toHaveLength(1);
    expect(sccs[0]).toHaveLength(n);
  });
});

describe('GraphIndex', () => {
  const index = new GraphIndex(sampleGraph());

  it('lista relações de entrada e saída', () => {
    expect(index.incoming('fn:src/a.ts#run', ['calls']).map((e) => e.source)).toEqual([
      'method:src/b.ts#Svc.go',
    ]);
    expect(index.outgoing('fn:src/a.ts#run', ['calls']).map((e) => e.target)).toEqual([
      'fn:src/a.ts#helper',
    ]);
  });

  it('encontra o arquivo de qualquer símbolo', () => {
    expect(index.fileOf('method:src/b.ts#Svc.go')?.id).toBe('file:src/b.ts');
  });

  it('calcula o impacto de uma alteração', () => {
    const impact = index.impact('fn:src/a.ts#helper').map((i) => [i.node.id, i.depth]);
    expect(impact).toEqual([
      ['fn:src/a.ts#run', 1],
      ['method:src/b.ts#Svc.go', 2],
    ]);
    // alterar um arquivo afeta quem o importa e quem chama seus símbolos
    const fileImpact = index.impact('file:src/a.ts').map((i) => i.node.id);
    expect(fileImpact).toContain('file:src/b.ts');
    expect(fileImpact).toContain('method:src/b.ts#Svc.go');
  });

  it('pesquisa por nome com prioridade para correspondência exata', () => {
    const results = index.search('run').map((r) => r.node.id);
    expect(results[0]).toBe('fn:src/a.ts#run');
    expect(index.search('')).toEqual([]);
    expect(index.search('lib/c').map((r) => r.node.id)).toContain('file:lib/c.ts');
  });

  it('calcula vizinhança por profundidade', () => {
    expect([...index.neighborhood('fn:src/a.ts#run', 1, ['calls'])].sort()).toEqual([
      'fn:src/a.ts#helper',
      'fn:src/a.ts#run',
      'method:src/b.ts#Svc.go',
    ]);
  });
});

describe('computeView (expansão progressiva)', () => {
  const index = new GraphIndex(sampleGraph());
  const allKinds = new Set<NodeKind>([
    'module',
    'file',
    'function',
    'class',
    'method',
    'route',
    'package',
    'unresolved',
  ]);
  const edgeKinds = new Set<EdgeKind>(['imports', 'calls', 'extends']);

  it('por padrão mostra só módulos e arquivos', () => {
    const view = computeView(index, { nodeKinds: allKinds, edgeKinds, expandedFiles: new Set() });
    expect(view.nodes.map((n) => n.kind).sort()).toEqual([
      'file',
      'file',
      'file',
      'module',
      'module',
    ]);
    expect(view.nodes.find((n) => n.id === 'file:src/a.ts')).toMatchObject({
      parent: 'module:src',
      expandable: true,
    });
    expect(view.edges.every((e) => e.kind === 'imports')).toBe(true);
    expect(view.hiddenCount).toBeGreaterThan(0);
  });

  it('ao expandir um arquivo mostra seus símbolos dentro dele', () => {
    const view = computeView(index, {
      nodeKinds: allKinds,
      edgeKinds,
      expandedFiles: new Set(['file:src/a.ts']),
    });
    const run = view.nodes.find((n) => n.id === 'fn:src/a.ts#run');
    expect(run?.parent).toBe('file:src/a.ts');
    expect(view.nodes.find((n) => n.id === 'file:src/a.ts')?.compound).toBe(true);
    expect(view.edges.some((e) => e.id === 'calls:fn:src/a.ts#run->fn:src/a.ts#helper')).toBe(true);
  });

  it('o foco mostra a vizinhança com os grupos necessários', () => {
    const view = computeView(index, {
      nodeKinds: allKinds,
      edgeKinds,
      expandedFiles: new Set(),
      focus: { id: 'fn:src/a.ts#run', depth: 1 },
    });
    const ids = view.nodes.map((n) => n.id);
    expect(ids).toContain('method:src/b.ts#Svc.go');
    expect(ids).toContain('class:src/b.ts#Svc'); // grupo do método
    expect(ids).not.toContain('file:lib/c.ts');
    expect(view.nodes.find((n) => n.id === 'method:src/b.ts#Svc.go')?.parent).toBe(
      'class:src/b.ts#Svc',
    );
  });

  it('respeita filtros de tipo de nó e relação', () => {
    const view = computeView(index, {
      nodeKinds: new Set<NodeKind>(['file']),
      edgeKinds: new Set<EdgeKind>(),
      expandedFiles: new Set(),
    });
    expect(view.nodes.every((n) => n.kind === 'file' && !n.parent)).toBe(true);
    expect(view.edges).toHaveLength(0);
  });

  it('pastas recolhidas viram um nó só, com as relações agregadas', () => {
    expect(groupableModules(index)).toEqual(['module:lib', 'module:src']);
    const view = computeView(index, {
      nodeKinds: allKinds,
      edgeKinds,
      expandedFiles: new Set(),
      collapsedModules: new Set(['module:src', 'module:lib']),
    });
    expect(view.nodes.map((n) => [n.id, n.collapsed, n.fileCount])).toEqual([
      ['module:lib', true, 1],
      ['module:src', true, 2],
    ]);
    const edges = view.edges.map((e) => [e.source, e.target, e.aggregated, e.members.length]);
    expect(edges).toEqual(
      expect.arrayContaining([
        ['module:src', 'module:lib', true, 1],
        ['module:lib', 'module:src', true, 1],
      ]),
    );
    // import src/b → src/a fica dentro da mesma pasta: não vira laço
    expect(view.edges.some((e) => e.source === e.target)).toBe(false);
  });

  it('não desenha relações de um grupo para o próprio filho', () => {
    const b = new GraphBuilder();
    const mod = b.ensureModule('src');
    b.addNode({ id: 'file:src/x.ts', kind: 'file', name: 'x.ts', parent: mod });
    b.addNode({ id: 'fn:src/x.ts#main', kind: 'function', name: 'main', parent: 'file:src/x.ts' });
    b.addEdge({
      kind: 'calls',
      source: 'file:src/x.ts',
      target: 'fn:src/x.ts#main',
      resolution: 'resolved',
      discovery: 'static-typecheck',
    });
    const f = b.finalize();
    const g = { ...sampleGraph(), nodes: f.nodes, edges: f.edges };
    const view = computeView(new GraphIndex(g), {
      nodeKinds: allKinds,
      edgeKinds,
      expandedFiles: new Set(['file:src/x.ts']),
    });
    expect(view.nodes.some((n) => n.id === 'fn:src/x.ts#main')).toBe(true);
    expect(view.edges).toEqual([]);
  });

  it('desenha depends_on entre pastas', () => {
    const view = computeView(index, {
      nodeKinds: allKinds,
      edgeKinds: new Set<EdgeKind>(['depends_on']),
      expandedFiles: new Set(),
    });
    expect(view.edges.map((e) => e.id)).toContain('depends_on:module:src->module:lib');
  });

  it('foco sem nenhum tipo de relação habilitado mostra só a própria entidade', () => {
    const view = computeView(index, {
      nodeKinds: allKinds,
      edgeKinds: new Set<EdgeKind>(),
      expandedFiles: new Set(),
      focus: { id: 'fn:src/a.ts#run', depth: 2 },
    });
    expect(
      view.nodes.filter((n) => n.kind === 'function' || n.kind === 'method').map((n) => n.id),
    ).toEqual(['fn:src/a.ts#run']);
  });

  it('relações diretas e somadas entre as mesmas pastas viram uma linha só', () => {
    const view = computeView(index, {
      nodeKinds: allKinds,
      edgeKinds: new Set<EdgeKind>(['imports', 'depends_on']),
      expandedFiles: new Set(),
      collapsedModules: new Set(['module:src', 'module:lib']),
    });
    const keys = view.edges.map((e) => `${e.kind}|${e.source}|${e.target}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('não conta como ocultas pastas que nunca aparecem', () => {
    const view = computeView(index, {
      nodeKinds: allKinds,
      edgeKinds,
      expandedFiles: new Set(),
      expandAll: true,
    });
    expect(view.hiddenCount).toBe(0);
  });
});
