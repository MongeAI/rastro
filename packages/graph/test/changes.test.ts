import { describe, expect, it } from 'vitest';
import {
  compareStrings,
  nodeId,
  SCHEMA_VERSION,
  type ChangeSet,
  type EdgeKind,
  type NodeKind,
  type RastroGraph,
  type Resolution,
} from '@rastro/core';
import {
  computeChangeImpact,
  GraphBuilder,
  GraphIndex,
  IMPACT_EDGE_KINDS,
  isTestFile,
  type ImpactEntry,
} from '@rastro/graph';

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

/** Índice a partir de nós `[id, tipo, pai?, início?, fim?]` e relações `[tipo, origem, destino]`. */
function indexOf(
  nodes: Array<[string, NodeKind, string?, number?, number?]>,
  edges: Array<[EdgeKind, string, string, Resolution?]>,
): GraphIndex {
  const graph = {
    schemaVersion: SCHEMA_VERSION,
    nodes: nodes.map(([id, kind, parent, startLine, endLine]) => ({
      id,
      kind,
      name: id.slice(id.lastIndexOf('#') + 1),
      ...(parent ? { parent } : {}),
      ...(startLine
        ? {
            location: {
              file: id.slice(id.indexOf(':') + 1).split('#')[0]!,
              startLine,
              startColumn: 1,
              endLine: endLine!,
              endColumn: 2,
            },
          }
        : {}),
    })),
    edges: edges.map(([kind, source, target, resolution = 'resolved'], i) => ({
      id: `${kind}:${source}->${target}#${i}`,
      kind,
      source,
      target,
      resolution,
      discovery: 'static-ast',
      evidence: [{ file: 'x.ts', line: 1, column: 1 }],
    })),
  } as unknown as RastroGraph;
  return new GraphIndex(graph);
}

const modified = (file: string, ranges: Array<[number, number]>, deletionsAt?: number[]) =>
  changes({ file, status: 'modified', ranges, ...(deletionsAt ? { deletionsAt } : {}) });

describe('computeChangeImpact: qual entidade mudou', () => {
  /** a.ts: classe C (1–20) com o método m (5–10); em b.ts, x() cria um C e D estende C. */
  const classIndex = () =>
    indexOf(
      [
        ['module:.', 'module'],
        ['file:a.ts', 'file', 'module:.'],
        ['file:b.ts', 'file', 'module:.'],
        ['class:a.ts#C', 'class', 'file:a.ts', 1, 20],
        ['method:a.ts#C.m', 'method', 'class:a.ts#C', 5, 10],
        ['fn:b.ts#x', 'function', 'file:b.ts', 1, 3],
        ['class:b.ts#D', 'class', 'file:b.ts', 5, 9],
      ],
      [
        ['calls', 'fn:b.ts#x', 'class:a.ts#C'],
        ['extends', 'class:b.ts#D', 'class:a.ts#C'],
      ],
    );
  const ids = (impact: ReturnType<typeof computeChangeImpact>) => ({
    changed: impact.changedEntities.map((n) => n.id),
    impacted: impact.impacted.map((i) => i.node.id),
  });

  it('só o método mudou: a classe não entra', () => {
    expect(ids(computeChangeImpact(classIndex(), modified('a.ts', [[6, 7]])))).toEqual({
      changed: ['method:a.ts#C.m'],
      impacted: [],
    });
    // trecho removido dentro do método também
    expect(ids(computeChangeImpact(classIndex(), modified('a.ts', [], [7])))).toEqual({
      changed: ['method:a.ts#C.m'],
      impacted: [],
    });
  });

  it('mudou um campo da classe junto com o método: a classe também mudou', () => {
    // antes, a classe sumia por ter um método alterado, e quem estende/cria C ficava de fora
    const expected = {
      changed: ['class:a.ts#C', 'method:a.ts#C.m'],
      impacted: ['class:b.ts#D', 'fn:b.ts#x'],
    };
    expect(ids(computeChangeImpact(classIndex(), modified('a.ts', [[2, 7]])))).toEqual(expected);
    expect(
      ids(
        computeChangeImpact(
          classIndex(),
          modified('a.ts', [
            [2, 2],
            [6, 6],
          ]),
        ),
      ),
    ).toEqual(expected);
    // trecho removido na classe (fora do método) junto com uma linha do método
    expect(ids(computeChangeImpact(classIndex(), modified('a.ts', [[6, 6]], [3])))).toEqual(
      expected,
    );
    expect(ids(computeChangeImpact(classIndex(), modified('a.ts', [[2, 2]])))).toEqual({
      changed: ['class:a.ts#C'],
      impacted: ['class:b.ts#D', 'fn:b.ts#x'],
    });
  });

  it('um trecho que pega o fim de uma função e o começo da seguinte não muda o arquivo', () => {
    // a.ts: f1 (1–5), f2 (6–10), f3 (11–20); b.ts: x chama f3, que não mudou
    const index = indexOf(
      [
        ['module:.', 'module'],
        ['file:a.ts', 'file', 'module:.'],
        ['file:b.ts', 'file', 'module:.'],
        ['fn:a.ts#f1', 'function', 'file:a.ts', 1, 5],
        ['fn:a.ts#f2', 'function', 'file:a.ts', 6, 10],
        ['fn:a.ts#f3', 'function', 'file:a.ts', 11, 20],
        ['fn:b.ts#x', 'function', 'file:b.ts', 1, 3],
      ],
      [['calls', 'fn:b.ts#x', 'fn:a.ts#f3']],
    );
    const expected = { changed: ['fn:a.ts#f1', 'fn:a.ts#f2'], impacted: [] };
    expect(ids(computeChangeImpact(index, modified('a.ts', [[5, 6]])))).toEqual(expected);
    expect(
      ids(
        computeChangeImpact(
          index,
          modified('a.ts', [
            [5, 5],
            [6, 6],
          ]),
        ),
      ),
    ).toEqual(expected);
    // removido entre as duas funções: aí sim é código do topo do arquivo
    expect(ids(computeChangeImpact(index, modified('a.ts', [], [6])))).toEqual({
      changed: [],
      impacted: ['fn:b.ts#x'],
    });
    // passa da última função: a linha 21 é do topo do arquivo
    expect(ids(computeChangeImpact(index, modified('a.ts', [[19, 21]])))).toEqual({
      changed: ['fn:a.ts#f3'],
      impacted: ['fn:b.ts#x'],
    });
  });
});

describe('GraphIndex.impactOfAll', () => {
  const SYMBOLS = new Set<NodeKind>(['function', 'class', 'method', 'route']);

  /** O cálculo antigo de `impact`, uma busca por entidade (a referência). */
  function referenceImpact(index: GraphIndex, id: string, maxDepth = 6): ImpactEntry[] {
    const result = new Map<string, ImpactEntry>();
    const start = index.node(id);
    if (!start) return [];
    const seeds = [id];
    if (start.kind === 'file' || start.kind === 'class' || start.kind === 'module')
      for (const d of index.descendants(id))
        if (SYMBOLS.has(d.kind) || d.kind === 'file') seeds.push(d.id);
    const visited = new Set<string>(seeds);
    let frontier = seeds;
    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      const next: string[] = [];
      for (const current of frontier)
        for (const edge of index.incoming(current, IMPACT_EDGE_KINDS)) {
          if (edge.resolution !== 'resolved' || visited.has(edge.source)) continue;
          visited.add(edge.source);
          const node = index.node(edge.source);
          if (!node) continue;
          result.set(node.id, { node, depth, via: edge });
          next.push(node.id);
        }
      frontier = next;
    }
    return [...result.values()].sort(
      (a, b) => a.depth - b.depth || compareStrings(a.node.id, b.node.id),
    );
  }

  /** Grafo aleatório com pastas, arquivos, classes, métodos e funções aninhadas. */
  function randomIndex(rnd: () => number): GraphIndex {
    const nodes: Array<[string, NodeKind, string?, number?, number?]> = [
      ['module:.', 'module'],
      ['module:d', 'module', 'module:.'],
    ];
    const pick = <T>(list: T[]) => list[Math.floor(rnd() * list.length)]!;
    for (let f = 0; f < 2 + rnd() * 5; f++) {
      const file = `file:f${f}.ts`;
      nodes.push([file, 'file', rnd() < 0.5 ? 'module:.' : 'module:d']);
      for (let s = 0; s < 1 + rnd() * 4; s++) {
        const kind = pick<NodeKind>(['function', 'class', 'route']);
        const id = `${kind}:f${f}.ts#s${s}`;
        nodes.push([id, kind, file, s * 10 + 1, s * 10 + 9]);
        if (kind !== 'route' && rnd() < 0.6)
          nodes.push([`method:f${f}.ts#s${s}.m`, kind === 'class' ? 'method' : 'function', id]);
      }
    }
    const ids = nodes.map((n) => n[0]);
    const edges: Array<[EdgeKind, string, string, Resolution?]> = [];
    for (let e = 0; e < ids.length * (0.5 + rnd() * 2); e++)
      edges.push([
        pick<EdgeKind>(['calls', 'imports', 'extends', 'contains', 'exports']),
        rnd() < 0.05 ? 'fn:sumiu.ts#x' : pick(ids),
        pick(ids),
        rnd() < 0.15 ? pick<Resolution>(['unresolved', 'external']) : 'resolved',
      ]);
    return indexOf(nodes, edges);
  }

  it('dá o mesmo que juntar o impacto de cada entidade (grafos aleatórios)', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trial = 0; trial < 300; trial++) {
      const index = randomIndex(rnd);
      const all = [...index.nodes.keys()];
      // uma entidade sozinha: igual ao cálculo antigo, inclusive a relação `via`
      const one = all[Math.floor(rnd() * all.length)]!;
      expect(index.impact(one), one).toEqual(referenceImpact(index, one));

      const ids = all.filter(() => rnd() < 0.3);
      const maxDepth = 1 + Math.floor(rnd() * 6);
      const expected = new Map<string, number>();
      for (const id of ids)
        for (const entry of referenceImpact(index, id, maxDepth)) {
          if (ids.includes(entry.node.id)) continue;
          const previous = expected.get(entry.node.id);
          if (previous === undefined || entry.depth < previous)
            expected.set(entry.node.id, entry.depth);
        }
      const got = index.impactOfAll(ids, maxDepth);
      expect(
        got.map((e) => [e.node.id, e.depth]),
        `tentativa ${trial}`,
      ).toEqual([...expected].sort((a, b) => a[1] - b[1] || compareStrings(a[0], b[0])));
      // `via` é uma relação resolvida de impacto que sai do nó afetado
      for (const entry of got) {
        expect(entry.via.source).toBe(entry.node.id);
        expect(entry.via.resolution).toBe('resolved');
        expect(IMPACT_EDGE_KINDS).toContain(entry.via.kind);
      }
    }
  });

  it('um símbolo de um arquivo alterado ainda pode ser afetado por outra mudança', () => {
    // a.ts mudou no topo (todos os símbolos dele são ponto de partida); f3 chama b, que mudou
    const index = indexOf(
      [
        ['file:a.ts', 'file'],
        ['fn:a.ts#f3', 'function', 'file:a.ts', 1, 3],
        ['file:b.ts', 'file'],
        ['fn:b.ts#b', 'function', 'file:b.ts', 1, 3],
      ],
      [['calls', 'fn:a.ts#f3', 'fn:b.ts#b']],
    );
    expect(index.impactOfAll(['file:a.ts', 'fn:b.ts#b']).map((e) => [e.node.id, e.depth])).toEqual([
      ['fn:a.ts#f3', 1],
    ]);
  });
});

describe('isTestFile', () => {
  it('testes pelo nome ou pela pasta; ajudantes dentro das pastas de teste não', () => {
    const tests = [
      'src/a.test.ts',
      'src/a.spec.tsx',
      'e2e/login.e2e.ts',
      'src/__tests__/a.ts',
      // mocha: arquivos comuns direto em test/, ou em subpastas que não são de ajudantes
      'test/foo.js',
      'test/unit/user.js',
      'packages/x/tests/api.ts',
      'test/helpers/factory.test.ts',
    ];
    const helpers = [
      'test/helpers/factory.ts',
      'test/fixtures/data.ts',
      'test/utils/render.tsx',
      'tests/support/server.ts',
      'src/__tests__/__fixtures__/x.ts',
      'test/mocks/api.ts',
      'src/__mocks__/fs.ts',
      'test/setup.ts',
      'test/helpers.ts',
      'test/types.d.ts',
      'src/testing.ts',
    ];
    for (const p of tests) expect(isTestFile(p), p).toBe(true);
    for (const p of helpers) expect(isTestFile(p), p).toBe(false);
  });
});
