import { describe, expect, it } from 'vitest';
import {
  edgeId,
  graphIssues,
  nodeId,
  parseGraph,
  SCHEMA_VERSION,
  validateGraph,
  validationText,
  type RastroGraph,
} from '@rastro/core';

function minimalGraph(): RastroGraph {
  const file = nodeId.file('src/a.ts');
  const fn = nodeId.function('src/a.ts', 'run');
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date(0).toISOString(),
    tool: { name: 'rastro', version: '0.1.0' },
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

describe('validateGraph — integridade extra', () => {
  it('rejeita ciclos na hierarquia (parent), que travariam quem percorre ancestrais', () => {
    const g = minimalGraph();
    g.nodes[0]!.parent = g.nodes[1]!.id; // arquivo dentro da função que está dentro do arquivo
    expect(validateGraph(g).errors.join()).toContain('ciclo na hierarquia');
  });

  it('rejeita colunas inválidas, meta que não é objeto e stats incompletas', () => {
    const g = minimalGraph();
    (g.nodes[1]!.location as unknown as { startColumn: unknown }).startColumn = 'zz';
    (g.edges[0]!.evidence[0] as unknown as { column: number }).column = -5;
    (g.nodes[0] as unknown as { meta: unknown }).meta = 'x';
    const errors = validateGraph(g).errors.join('\n');
    expect(errors).toContain('location inválida');
    expect(errors).toContain('evidence contém item inválido');
    expect(errors).toContain('meta deve ser um objeto');
    const noStats = minimalGraph();
    (noStats as unknown as { stats: Record<string, unknown> }).stats.nodesByKind = undefined;
    expect(validateGraph(noStats).errors.join()).toContain('stats.nodesByKind');
  });

  it('candidatos possíveis precisam apontar para nós existentes', () => {
    const g = minimalGraph();
    g.nodes.push({
      id: 'unresolved:src/a.ts#call:repo.save',
      kind: 'unresolved',
      name: 'repo.save',
      meta: { reason: 'indirect-call', candidates: [g.nodes[1]!.id] },
    });
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
    g.nodes[2]!.meta!.candidates!.push('method:src/b.ts#Sql.save');
    expect(validateGraph(g).errors.join()).toContain('candidates aponta para nó inexistente');
    (g.nodes[2]!.meta as { candidates: unknown }).candidates = 'x';
    expect(validateGraph(g).errors.join()).toContain('meta.candidates deve ser uma lista');
  });

  it('mudanças do git: as mesmas regras do JSON Schema, e início ≤ fim nos intervalos', () => {
    const ok = (): RastroGraph => ({
      ...minimalGraph(),
      changes: {
        base: 'abc123',
        baseLabel: 'main',
        includesUntracked: true,
        files: [
          { file: 'src/a.ts', status: 'modified', ranges: [[1, 3]], deletionsAt: [5] },
          { file: 'src/b.ts', status: 'renamed', previous: 'src/old.ts', ranges: [] },
        ],
      },
    });
    expect(validateGraph(ok())).toEqual({ valid: true, errors: [] });
    const broken: Array<(g: RastroGraph) => void> = [
      (g) => delete (g.changes as Partial<NonNullable<RastroGraph['changes']>>).baseLabel,
      (g) => ((g.changes as unknown as { includesUntracked: unknown }).includesUntracked = 'sim'),
      (g) => ((g.changes!.files[0] as unknown as { status: string }).status = 'mexido'),
      (g) => (g.changes!.files[0]!.ranges = [[3, 1]]),
      (g) => (g.changes!.files[0]!.deletionsAt = [0]),
      (g) => ((g.changes!.files[1] as unknown as { previous: unknown }).previous = 7),
    ];
    for (const breakIt of broken) {
      const g = ok();
      breakIt(g);
      expect(validateGraph(g).errors.join(), breakIt.toString()).toMatch(/changes/);
    }
  });

  it('diagnósticos: nível conhecido e params só com textos e números', () => {
    const g = minimalGraph();
    g.diagnostics.push({
      level: 'warning',
      code: 'file-too-large',
      message: 'Arquivo ignorado',
      params: { limitKb: 1000, file: 'a.ts' },
    });
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
    (g.diagnostics[0]!.params as Record<string, unknown>).nested = { x: 1 };
    expect(validateGraph(g).errors.join()).toContain('diagnostics[0]');
    const badLevel = minimalGraph();
    badLevel.diagnostics.push({ level: 'fatal' as 'error', code: 'x', message: 'y' });
    expect(validateGraph(badLevel).errors.join()).toContain('diagnostics[0]');
  });
});

describe('validateGraph — idiomas', () => {
  /** Um grafo com um pouco de cada problema. */
  function broken(): RastroGraph {
    const g = minimalGraph();
    g.nodes.push({ ...g.nodes[0]! });
    (g.nodes[1] as { kind: string }).kind = 'banana';
    g.nodes[1]!.location!.endLine = 0;
    g.edges[0]!.target = 'fn:sumiu';
    (g.edges[0] as { resolution: string }).resolution = 'talvez';
    return g;
  }

  it('o português continua igual (compatibilidade com quem lê errors)', () => {
    expect(validateGraph(broken()).errors).toEqual([
      'nodes[1].kind inválido: banana',
      'nodes[1].location inválida em fn:src/a.ts#run.',
      'nodes[2].id duplicado: file:src/a.ts',
      'edges[0].target inexistente: fn:sumiu',
      'edges[0].resolution inválida: talvez',
    ]);
    expect(validateGraph(42).errors).toEqual(['O grafo precisa ser um objeto JSON.']);
    expect(validateGraph({ ...minimalGraph(), schemaVersion: '9' }).errors).toEqual([
      `schemaVersion deve ser "${SCHEMA_VERSION}" (recebido: "9").`,
    ]);
  });

  it('em inglês com { lang: "en" }, com os mesmos campos', () => {
    expect(validateGraph(broken(), { lang: 'en' }).errors).toEqual([
      'invalid nodes[1].kind: banana',
      'invalid nodes[1].location in fn:src/a.ts#run.',
      'duplicate nodes[2].id: file:src/a.ts',
      'edges[0].target does not exist: fn:sumiu',
      'invalid edges[0].resolution: talvez',
    ]);
    expect(validateGraph(42, { lang: 'en' }).errors).toEqual(['The graph must be a JSON object.']);
    expect(validateGraph({ schemaVersion: '9' }, { lang: 'en' }).errors).toContain(
      `schemaVersion must be "${SCHEMA_VERSION}" (got: "9").`,
    );
  });

  it('graphIssues devolve códigos e parâmetros; validationText traduz depois', () => {
    const { valid, issues } = graphIssues(broken());
    expect(valid).toBe(false);
    expect(issues[0]).toEqual({
      code: 'invalid-value',
      params: { field: 'nodes[1].kind', value: 'banana' },
    });
    expect(issues.map((i) => validationText(i, 'pt'))).toEqual(validateGraph(broken()).errors);
    expect(graphIssues(minimalGraph())).toEqual({ valid: true, issues: [] });
    // o limite antigo (número no segundo argumento) continua valendo
    expect(validateGraph(broken(), 2).errors).toHaveLength(2);
    expect(validateGraph(broken(), { maxErrors: 1, lang: 'en' }).errors).toHaveLength(1);
  });

  it('nenhum texto em inglês sai em português', () => {
    const bad = {
      schemaVersion: 1,
      project: {},
      stats: { nodesByKind: 1, importCycles: 1, files: -1 },
      diagnostics: [1],
      changes: 1,
    };
    const en = validateGraph(bad, { lang: 'en' }).errors;
    expect(en.length).toBeGreaterThan(5);
    expect(en.join('\n')).not.toMatch(/[ãõçáéíóú]|\b(deve|lista|inválid|obrigatório)/);
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
