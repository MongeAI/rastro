import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  diagnosticText,
  nodeId,
  SCHEMA_VERSION,
  validateGraph,
  type EdgeKind,
  type NodeKind,
  type RastroGraph,
  type Resolution,
} from '@rastro/core';
import {
  buildExportView,
  dotString,
  ExportTooLargeError,
  filterGraphByFolder,
  GraphBuilder,
  mermaidLabel,
  normalizeFolder,
  toDot,
  toGraphML,
  toMermaid,
  xmlEscape,
} from '@rastro/graph';

const ev = (file: string, line: number) => ({ file, line, column: 1 });

function wrap(b: GraphBuilder, files: number): RastroGraph {
  const f = b.finalize();
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    tool: { name: 'rastro', version: '0.2.0' },
    project: { name: 'demo "x" <y>', root: '/demo', languages: ['ts'] },
    analyzer: {
      name: 't',
      version: '0',
      typescriptVersion: '0',
      options: { exclude: [], respectGitignore: true, maxFiles: 1, maxFileSizeBytes: 1 },
    },
    nodes: f.nodes,
    edges: f.edges,
    stats: {
      files,
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

function addFile(b: GraphBuilder, file: string): string {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  const mod = b.ensureModule(dir);
  const id = nodeId.file(file);
  b.addNode({
    id,
    kind: 'file',
    name: file.slice(file.lastIndexOf('/') + 1),
    qualifiedName: file,
    parent: mod,
  });
  b.addEdge({
    kind: 'contains',
    source: mod,
    target: id,
    resolution: 'resolved',
    discovery: 'derived',
  });
  return id;
}

function addSymbol(b: GraphBuilder, kind: NodeKind, id: string, name: string, parent: string) {
  const file = id.slice(id.indexOf(':') + 1).split('#')[0]!;
  b.addNode({
    id,
    kind,
    name,
    parent,
    location: { file, startLine: 3, startColumn: 1, endLine: 4, endColumn: 1 },
  });
  b.addEdge({
    kind: 'contains',
    source: parent,
    target: id,
    resolution: 'resolved',
    discovery: 'static-ast',
  });
}

function link(
  b: GraphBuilder,
  kind: EdgeKind,
  source: string,
  target: string,
  resolution: Resolution = 'resolved',
  line = 1,
) {
  const file = source.slice(source.indexOf(':') + 1).split('#')[0]!;
  b.addEdge({
    kind,
    source,
    target,
    resolution,
    discovery: 'static-ast',
    evidence: ev(file, line),
  });
}

/**
 * Projeto pequeno com nomes difíceis:
 * - src/a.ts: `run` chama `weird` (nome com aspas, <>&, # e acento) e `end` (palavra reservada)
 * - src/b.ts: classe `Svc` com método `go`, que chama `run`; importa a.ts duas vezes (×2)
 * - lib/c.ts importa src/b.ts; src/a.ts importa `react` (externo) e `./missing` (não resolvido)
 */
function sample(): RastroGraph {
  const b = new GraphBuilder();
  const a = addFile(b, 'src/a.ts');
  const bf = addFile(b, 'src/b.ts');
  const c = addFile(b, 'lib/c.ts');
  addSymbol(b, 'function', 'fn:src/a.ts#run', 'run', a);
  addSymbol(b, 'function', 'fn:src/a.ts#weird', 'diz "olá" <b>&\\ #1 ação', a);
  addSymbol(b, 'function', 'fn:src/a.ts#end', 'end', a);
  addSymbol(b, 'class', 'class:src/b.ts#Svc', 'Svc', bf);
  addSymbol(b, 'method', 'method:src/b.ts#Svc.go', 'go', 'class:src/b.ts#Svc');
  link(b, 'calls', 'fn:src/a.ts#run', 'fn:src/a.ts#weird');
  link(b, 'calls', 'fn:src/a.ts#run', 'fn:src/a.ts#end');
  link(b, 'calls', 'method:src/b.ts#Svc.go', 'fn:src/a.ts#run');
  link(b, 'imports', bf, a, 'resolved', 1);
  link(b, 'imports', bf, a, 'resolved', 2);
  link(b, 'imports', c, bf);
  b.addNode({ id: 'pkg:react', kind: 'package', name: 'react' });
  link(b, 'imports', a, 'pkg:react', 'external');
  b.addNode({
    id: 'unresolved:src/a.ts#import:./missing',
    kind: 'unresolved',
    name: './missing',
    location: { file: 'src/a.ts', startLine: 2, startColumn: 1, endLine: 2, endColumn: 9 },
    meta: { reason: 'module-not-found', reference: './missing' },
  });
  link(b, 'imports', a, 'unresolved:src/a.ts#import:./missing', 'unresolved');
  return wrap(b, 3);
}

describe('buildExportView', () => {
  it('usa as mesmas regras da interface para cada nível', () => {
    const g = sample();
    const files = buildExportView(g, { level: 'files' });
    expect(files.nodes.map((n) => n.id)).toEqual([
      'file:lib/c.ts',
      'file:src/a.ts',
      'file:src/b.ts',
      'module:lib',
      'module:src',
      'unresolved:src/a.ts#import:./missing',
    ]);
    const modules = buildExportView(g, { level: 'modules' });
    expect(modules.nodes.map((n) => n.id)).toEqual([
      'module:lib',
      'module:src',
      'unresolved:src/a.ts#import:./missing',
    ]);
    // relações dos arquivos somadas entre as pastas recolhidas
    expect(modules.edges.find((e) => e.source === 'module:lib')).toMatchObject({
      target: 'module:src',
      aggregated: true,
      count: 1,
    });
    const symbols = buildExportView(g, { level: 'symbols' });
    expect(symbols.nodes.some((n) => n.id === 'method:src/b.ts#Svc.go')).toBe(true);
  });

  it('nível "pastas" abre a pasta única do topo, como a interface (projeto todo em src/)', () => {
    const b = new GraphBuilder();
    const app = addFile(b, 'src/app.ts');
    const db = addFile(b, 'src/db/pool.ts');
    const ui = addFile(b, 'src/ui/view.ts');
    link(b, 'imports', app, db);
    link(b, 'imports', ui, db);
    const view = buildExportView(wrap(b, 3), { level: 'modules' });
    // antes: um nó só (`module:src`, recolhido) e nenhuma relação
    expect(view.nodes.map((n) => [n.id, !!n.collapsed])).toEqual([
      ['file:src/app.ts', false],
      ['module:src', false],
      ['module:src/db', true],
      ['module:src/ui', true],
    ]);
    expect(view.edges.map((e) => `${e.source} -> ${e.target}`).sort()).toEqual([
      'file:src/app.ts -> module:src/db',
      'module:src/ui -> module:src/db',
    ]);
  });

  it('respeita os filtros de externos, não resolvidos e tipos de relação', () => {
    const g = sample();
    const ids = (o: Parameters<typeof buildExportView>[1]) =>
      buildExportView(g, o).nodes.map((n) => n.id);
    expect(ids({ includeExternal: true })).toContain('pkg:react');
    expect(ids({})).not.toContain('pkg:react');
    expect(ids({ includeUnresolved: false })).not.toContain('unresolved:src/a.ts#import:./missing');
    const onlyCalls = buildExportView(g, { level: 'symbols', edgeKinds: ['calls'] });
    expect(new Set(onlyCalls.edges.map((e) => e.kind))).toEqual(new Set(['calls']));
  });
});

describe('filtro de pasta', () => {
  it('normaliza o caminho e compara por pasta inteira', () => {
    expect(normalizeFolder('./src/')).toBe('src');
    expect(normalizeFolder('src\\services')).toBe('src/services');
    expect(normalizeFolder('.')).toBeUndefined();
    expect(filterGraphByFolder(sample(), 'sr').nodes.some((n) => n.kind === 'file')).toBe(false);
  });

  it('mantém só a pasta, continua válido e recalcula as contagens', () => {
    const g = filterGraphByFolder(sample(), 'src');
    expect(validateGraph(g).valid).toBe(true);
    const files = g.nodes.filter((n) => n.kind === 'file').map((n) => n.id);
    expect(files).toEqual(['file:src/a.ts', 'file:src/b.ts']);
    expect(g.edges.some((e) => e.source === 'file:lib/c.ts')).toBe(false);
    expect(g.stats.files).toBe(2);
    expect(g.stats.nodesByKind.file).toBe(2);
    // pacote usado de dentro da pasta continua; a raiz fica só como moldura
    expect(g.nodes.map((n) => n.id)).toContain('pkg:react');
    expect(g.nodes.map((n) => n.id)).toContain('module:.');
    expect(g.diagnostics.at(-1)?.code).toBe('folder-filter');
    expect(g.diagnostics.at(-1)?.params).toEqual({ folder: 'src' });
    expect(diagnosticText(g.diagnostics.at(-1)!, 'en')).toMatch(
      /^Graph restricted to the folder "src"/,
    );
  });
});

describe('toMermaid', () => {
  it('gera um fluxograma determinístico com subgrafos por pasta', () => {
    const g = sample();
    const out = toMermaid(g);
    expect(out).toBe(toMermaid(sample()));
    expect(out).toBe(
      [
        '%% Rastro · demo "x" <y> · nível: arquivos',
        'flowchart LR',
        '  subgraph m_lib["lib"]',
        '    f_c_ts["c.ts"]',
        '  end',
        '  subgraph m_src["src"]',
        '    f_a_ts["a.ts"]',
        '    f_b_ts["b.ts"]',
        '  end',
        '  u_missing["./missing"]',
        '  f_c_ts --> f_b_ts',
        '  f_a_ts --> u_missing',
        '  f_b_ts -->|"×2"| f_a_ts',
        '  classDef unresolved fill:#fef2f2,stroke:#dc2626,stroke-dasharray:4 3,color:#991b1b',
        '  class u_missing unresolved',
        '  linkStyle 1 stroke:#dc2626,stroke-dasharray:4 3',
        '',
      ].join('\n'),
    );
  });

  it('escapa rótulos e gera ids seguros (acentos, palavras reservadas, repetidos)', () => {
    const out = toMermaid(sample(), { level: 'symbols', includeExternal: true });
    // id vem do nome, sem acentos nem símbolos; o rótulo mantém tudo (escapado)
    expect(out).toContain('fn_diz_ola_b_1_acao("diz #34;olá#34; #60;b#62;#38;\\ #35;1 ação")');
    expect(out).toContain('fn_end("end")');
    expect(out).toContain('p_react(["react"])');
    expect(out).toContain('classDef external');
    expect(out).toMatch(/fn_run -->\|"chama"\| fn_end/);
    for (const line of out.split('\n')) {
      const m = /^\s*(\w+)(?:\[|\(|\{|>)/.exec(line);
      if (m && !['subgraph', 'classDef', 'class', 'linkStyle'].includes(m[1]!))
        expect(m[1]).toMatch(/^[a-z]+_[A-Za-z0-9_]+$/);
    }
    // nenhum rótulo leva aspas, < ou > crus para dentro do diagrama: em cada linha, o rótulo
    // vai da primeira aspa depois de ( [ { | até a última antes de ) ] } | (guloso), então uma
    // aspa crua no meio dele também aparece aqui
    const labels = out
      .split('\n')
      .flatMap((line) => [...line.matchAll(/[([{|]"(.*)"[)\]}|]/g)].map((m) => m[1]!));
    expect(labels).toContain('diz #34;olá#34; #60;b#62;#38;\\ #35;1 ação');
    for (const label of labels) expect(label).not.toMatch(/["<>]/);
    expect(mermaidLabel('a\nb`c')).toBe('a b#96;c');
  });

  it('nomes de arquivo e de projeto não viram diretivas (%%{init}%%) nem quebram o diagrama', () => {
    const b = new GraphBuilder();
    addFile(b, "src/%%{init: {'theme':'forest'}}%%.ts");
    addFile(b, 'src/%%{aberto.ts');
    const graph = wrap(b, 2);
    graph.project.name = "x\n%%{init: {'theme':'dark'}}%%\ny";
    const out = toMermaid(graph, { level: 'files' });
    expect(mermaidLabel("%%{init: {'theme':'forest'}}%%")).toBe(
      '#37;#37;#123;init: #123;#39;theme#39;:#39;forest#39;#125;#125;#37;#37;',
    );
    const [header, ...rest] = out.split('\n');
    expect(header).toMatch(/^%% /);
    expect(header!.slice(3)).not.toMatch(/[%{}]/);
    // fora do comentário do título, nenhum %, { ou } cru dentro dos rótulos
    for (const label of rest.join('\n').matchAll(/"([^"]*)"/g))
      expect(label[1]).not.toMatch(/[%{}']/);
    expect(rest.some((l) => /^\s*%%/.test(l))).toBe(false);
  });

  it('recusa diagramas grandes demais com uma dica de como reduzir', () => {
    const b = new GraphBuilder();
    // em duas pastas: uma pasta única no topo seria aberta no nível "pastas"
    for (let i = 0; i < 30; i++) addFile(b, `src/${i % 2 ? 'a' : 'b'}/f${i}.ts`);
    const g = wrap(b, 30);
    expect(() => toMermaid(g, { maxNodes: 20 })).toThrow(ExportTooLargeError);
    try {
      toMermaid(g, { maxNodes: 20 });
    } catch (err) {
      expect((err as ExportTooLargeError).message).toContain('32 nós');
      expect((err as ExportTooLargeError).hint).toContain('--level modules');
    }
    expect(() => toMermaid(g, { level: 'modules', maxNodes: 20 })).not.toThrow();
  });
});

describe('toDot', () => {
  it('cita todos os ids e escapa aspas e barras', () => {
    expect(dotString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
    const out = toDot(sample(), { level: 'symbols', includeExternal: true });
    expect(out).toBe(toDot(sample(), { level: 'symbols', includeExternal: true }));
    expect(out).toMatch(/^\/\/ Rastro · demo "x" <y> · nível: símbolos\ndigraph "rastro" \{/);
    expect(out).toContain('label="demo \\"x\\" <y> · símbolos"');
    expect(out).toContain('subgraph "cluster_module:src" {');
    expect(out).toContain('"fn:src/a.ts#weird" [label="diz \\"olá\\" <b>&\\\\ #1 ação"');
    expect(out).toContain('"pkg:react" [label="react"');
    // relação entre grupos (arquivos abertos) passa por nós invisíveis + ltail/lhead
    expect(out).toContain('"file:src/b.ts" [shape="point", style="invis"');
    expect(out).toMatch(
      /"file:src\/b\.ts" -> "file:src\/a\.ts" \[label="importa ×2".*ltail="cluster_file:src\/b\.ts", lhead="cluster_file:src\/a\.ts"\]/,
    );
    expect(out).toMatch(
      /-> "unresolved:src\/a\.ts#import:\.\/missing" \[[^\]]*color="#dc2626", style="dashed"/,
    );
    expect(out.trimEnd().endsWith('}')).toBe(true);
  });

  it('ids diferentes nunca viram o mesmo nó (\\n, \\r e caracteres de controle)', () => {
    const out = toDot(collisionSample());
    // id entre aspas como o Graphviz lê: só `\"` é escape
    const ids = [...out.matchAll(/^ {2}"((?:[^"\\]|\\.)*)" \[label=/gm)].map((m) => m[1]);
    expect(ids.sort()).toEqual([
      'file:a b.ts',
      'file:a\\nb.ts',
      'file:a\\rb.ts',
      'file:c.ts',
      'file:c\\x01.ts',
    ]);
    expect(out).toContain('"file:a\\nb.ts" -> "file:c.ts"');
    expect(out).toContain('"file:a\\rb.ts" -> "file:c\\x01.ts"');
    // ids comuns continuam iguais aos de antes
    expect(out).toContain('"file:a b.ts" -> "file:c.ts"');
  });
});

/** Arquivos cujos nomes só diferem em quebras de linha e caracteres de controle. */
function collisionSample(): RastroGraph {
  const b = new GraphBuilder();
  const [nl, cr, space, ctrl, c] = ['a\nb.ts', 'a\rb.ts', 'a b.ts', 'c\u0001.ts', 'c.ts'].map((f) =>
    addFile(b, f),
  );
  link(b, 'imports', nl!, c!);
  link(b, 'imports', cr!, ctrl!);
  link(b, 'imports', space!, c!);
  return wrap(b, 5);
}

describe('toGraphML', () => {
  it('gera XML válido com chaves de tipo, resolução, contagem, arquivo e linha', () => {
    const out = toGraphML(sample(), { level: 'files', includeExternal: true });
    expect(out).toBe(toGraphML(sample(), { level: 'files', includeExternal: true }));
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<graphml')).toBe(true);
    for (const key of [
      'n_kind',
      'e_kind',
      'e_resolution',
      'e_count',
      'e_file',
      'e_line',
      'n_file',
      'n_line',
    ])
      expect(out).toContain(`<key id="${key}"`);
    expect(out).toContain('<data key="g_project">demo &quot;x&quot; &lt;y&gt;</data>');
    expect(out).toMatch(
      /<edge id="imports:file:src\/b\.ts-&gt;file:src\/a\.ts" source="file:src\/b\.ts" target="file:src\/a\.ts">\n {6}<data key="e_kind">imports<\/data>\n {6}<data key="e_resolution">resolved<\/data>\n {6}<data key="e_count">2<\/data>\n {6}<data key="e_file">src\/b\.ts<\/data>\n {6}<data key="e_line">1<\/data>/,
    );
    expect(out).toContain('<data key="e_resolution">external</data>');
    // estrutura: nenhuma tag aberta sem fechar e nenhum & cru
    expect(out.match(/<node /g)?.length).toBe(out.match(/<\/node>/g)?.length);
    expect(out.match(/<edge /g)?.length).toBe(out.match(/<\/edge>/g)?.length);
    expect(out).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/);
  });

  it('ids diferentes nunca viram o mesmo nó (\\n, \\r e caracteres de controle)', () => {
    const out = toGraphML(collisionSample());
    // valor do atributo como um leitor de XML entrega: quebras cruas viram espaço, depois
    // as referências são decodificadas
    const attr = (raw: string) =>
      raw
        .replace(/[\t\n\r]/g, ' ')
        .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
    const nodes = [...out.matchAll(/<node id="([^"]*)">/g)].map((m) => attr(m[1]!));
    // o XML não aceita U+0001 nem como referência: esse id perde o caractere e ganha sufixo
    expect(nodes.sort()).toEqual([
      'file:a\nb.ts',
      'file:a\rb.ts',
      'file:a b.ts',
      'file:c.ts',
      'file:c.ts~2',
    ]);
    const edges = [...out.matchAll(/<edge id="[^"]*" source="([^"]*)" target="([^"]*)">/g)].map(
      (m) => `${attr(m[1]!)} -> ${attr(m[2]!)}`,
    );
    expect(edges.sort()).toEqual([
      'file:a\nb.ts -> file:c.ts',
      'file:a\rb.ts -> file:c.ts~2',
      'file:a b.ts -> file:c.ts',
    ]);

    // o pai (`n_parent`) aponta para o id usado no GraphML
    const b = new GraphBuilder();
    addFile(b, 'd/x.ts');
    addFile(b, 'd\u0001/y.ts');
    const folders = toGraphML(wrap(b, 2));
    expect(folders).toContain('<node id="module:d~2">');
    expect(folders).toMatch(
      /<node id="file:d\/y\.ts">\n(?: {6}<data[^\n]*\n)*? {6}<data key="n_parent">module:d~2</,
    );
    expect(folders).toMatch(
      /<node id="file:d\/x\.ts">\n(?: {6}<data[^\n]*\n)*? {6}<data key="n_parent">module:d</,
    );
  });

  it('escapa textos e remove caracteres proibidos no XML', () => {
    expect(xmlEscape(`a<b>&"c'`)).toBe('a&lt;b&gt;&amp;&quot;c&apos;');
    expect(xmlEscape('x\u0001y\u0000z\ud800w')).toBe('xyzw');
    expect(xmlEscape('ação 😀')).toBe('ação 😀');
    const out = toGraphML(sample(), { level: 'symbols' });
    expect(out).toContain(
      '<data key="n_label">diz &quot;olá&quot; &lt;b&gt;&amp;\\ #1 ação</data>',
    );
  });
});

describe('exportadores com o fixture ts-basic', () => {
  const example = JSON.parse(
    fs.readFileSync(new URL('../../../docs/examples/ts-basic.graph.json', import.meta.url), 'utf8'),
  ) as RastroGraph;

  it('Mermaid: pastas como subgrafos, ciclo e não resolvidos destacados', () => {
    const out = toMermaid(example, { includeExternal: true });
    expect(out).toContain('  subgraph m_src_cycle["src/cycle"]');
    expect(out).toContain('  class f_a_ts,f_b_ts cycle');
    expect(out).toContain('p_node_fs(["node:fs"])');
    expect(out).toMatch(/linkStyle [\d,]+ stroke:#dc2626/);
    expect(out).toMatch(/linkStyle [\d,]+ stroke:#a1a1aa/);
  });

  it('as três saídas têm os mesmos nós e relações da visão', () => {
    const view = buildExportView(example, { level: 'symbols' });
    const graphml = toGraphML(example, { level: 'symbols' });
    expect(graphml.match(/<node /g)).toHaveLength(view.nodes.length);
    expect(graphml.match(/<edge /g)).toHaveLength(view.edges.length);
    const dot = toDot(example, { level: 'symbols' });
    expect(dot.match(/ -> /g)).toHaveLength(view.edges.length);
    const mermaid = toMermaid(example, { level: 'symbols' });
    expect(mermaid.match(/ -(?:->|\.->)/g)).toHaveLength(view.edges.length);
  });
});

describe('idioma dos exportadores', () => {
  it('português por padrão; inglês com lang: en (comentário, níveis, contagens e relações)', () => {
    const pt = toMermaid(sample(), { level: 'modules' });
    expect(pt).toContain('%% Rastro · demo "x" <y> · nível: pastas');
    expect(pt).toContain('(1 arquivo)');
    expect(pt).toContain('(2 arquivos)');

    const en = toMermaid(sample(), { level: 'modules', lang: 'en' });
    expect(en).toContain('%% Rastro · demo "x" <y> · level: folders');
    expect(en).toContain('(1 file)');
    expect(en).toContain('(2 files)');
    expect(toMermaid(sample(), { level: 'symbols', lang: 'en' })).toMatch(
      /fn_run -->\|"calls"\| fn_end/,
    );

    const dot = toDot(sample(), { level: 'symbols', folder: 'src', lang: 'en' });
    expect(dot).toMatch(/^\/\/ Rastro · demo "x" <y> · level: symbols · folder: src\n/);
    expect(dot).toContain('label="demo \\"x\\" <y> · symbols · src"');
    expect(dot).toContain('label="imports ×2"');
    expect(toGraphML(sample(), { level: 'modules', lang: 'en' })).toContain(
      '<data key="n_label">src (2 files)</data>',
    );
  });

  it('erros do Mermaid no idioma pedido', () => {
    const b = new GraphBuilder();
    for (let i = 0; i < 30; i++) addFile(b, `src/f${i}.ts`);
    const g = wrap(b, 30);
    expect(() => toMermaid(g, { maxNodes: 20, lang: 'en' })).toThrow(
      'The Mermaid diagram would have 31 nodes (limit: 20).',
    );
    try {
      toMermaid(g, { maxNodes: 20, lang: 'en' });
    } catch (err) {
      expect((err as ExportTooLargeError).hint).toContain('--level modules or --folder <path>');
    }
  });
});
