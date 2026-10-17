import { describe, expect, it } from 'vitest';
import {
  edgeId,
  nodeId,
  parseGraph,
  SCHEMA_VERSION,
  validateGraph,
  type TeiaGraph,
} from '@teia/core';

function minimalGraph(): TeiaGraph {
  const file = nodeId.file('src/a.ts');
  const fn = nodeId.function('src/a.ts', 'run');
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date(0).toISOString(),
    tool: { name: 'teia', version: '0.1.0' },
    project: { name: 'demo', root: '/tmp/demo', languages: ['ts'] },
    analyzer: {
      name: 'test',
      version: '0.1.0',
      typescriptVersion: '0',
      options: { exclude: [], respectGitignore: true, maxFiles: 1, maxFileSizeBytes: 1 },
    },
    nodes: [
      { id: file, kind: 'file', name: 'a.ts' },
      {
        id: fn,
        kind: 'function',
        name: 'run',
        parent: file,
        location: { file: 'src/a.ts', startLine: 1, startColumn: 1, endLine: 3, endColumn: 2 },
      },
    ],
    edges: [
      {
        id: edgeId('contains', file, fn),
        kind: 'contains',
        source: file,
        target: fn,
        resolution: 'resolved',
        discovery: 'static-ast',
        evidence: [{ file: 'src/a.ts', line: 1, column: 1 }],
      },
    ],
    stats: {
      files: 1,
      nodesByKind: {},
      edgesByKind: {},
      edgesByResolution: {},
      importCycles: [],
      externalCallsSkipped: 0,
      unknownReceiverCalls: 0,
      computedCalls: 0,
      localCalls: 0,
      durationMs: 0,
    },
    diagnostics: [],
  };
}

describe('validateGraph', () => {
  it('aceita um grafo coerente', () => {
    expect(validateGraph(minimalGraph())).toEqual({ valid: true, errors: [] });
  });

  it('rejeita relações para nós inexistentes', () => {
    const g = minimalGraph();
    g.edges[0]!.target = 'fn:nao-existe';
    const r = validateGraph(g);
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toContain('target inexistente');
  });

  it('rejeita ids duplicados, tipos inválidos e localizações incoerentes', () => {
    const g = minimalGraph();
    g.nodes.push({ ...g.nodes[0]! });
    (g.nodes[1] as { kind: string }).kind = 'banana';
    g.nodes[1]!.location!.endLine = 0;
    const r = validateGraph(g);
    expect(r.errors.some((e) => e.includes('duplicado'))).toBe(true);
    expect(r.errors.some((e) => e.includes('kind inválido'))).toBe(true);
    expect(r.errors.some((e) => e.includes('location inválida'))).toBe(true);
  });

  it('rejeita versão de schema desconhecida', () => {
    const g = { ...minimalGraph(), schemaVersion: '9.9.9' };
    expect(validateGraph(g).valid).toBe(false);
  });
});

describe('parseGraph', () => {
  it('lê JSON válido', () => {
    expect(parseGraph(JSON.stringify(minimalGraph())).project.name).toBe('demo');
  });
  it('explica JSON malformado', () => {
    expect(() => parseGraph('{oops')).toThrow(/JSON inválido/);
  });
  it('explica grafo inválido', () => {
    expect(() => parseGraph('{"schemaVersion":"0.1.0"}')).toThrow(/Grafo inválido/);
  });
});

describe('ids', () => {
  it('são legíveis e estáveis', () => {
    expect(nodeId.method('src/s.ts', 'Svc', 'run')).toBe('method:src/s.ts#Svc.run');
    expect(nodeId.module('')).toBe('module:.');
    expect(edgeId('calls', 'a', 'b')).toBe('calls:a->b');
  });
});
