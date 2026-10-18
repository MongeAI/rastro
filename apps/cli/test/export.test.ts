import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeProject } from '@rastro/analyzer';
import { validateGraph, type RastroGraph } from '@rastro/core';
import type { GraphDiff } from '@rastro/graph';
import { buildHtmlReport, jsonForScript, REPORT_CSP } from '../src/report.js';
import { parseExportRequest, renderExport, UsageError } from '../src/export.js';
import { setLang } from '../src/i18n.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = path.join(repo, 'fixtures', 'ts-basic');
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const EVIL = '</script><script>alert(1)</script><!--';

let graph: RastroGraph;
beforeAll(async () => {
  // as mensagens conferidas aqui são as em português (o padrão sem locale é inglês)
  setLang('pt');
  graph = await analyzeProject(fixture);
});

/** Interface "compilada" mínima, com as mesmas armadilhas do bundle real. */
function fakeWebRoot(): string {
  const root = tmp('rastro-fakeweb-');
  fs.mkdirSync(path.join(root, 'assets'));
  fs.mkdirSync(path.join(root, 'fonts'));
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<!doctype html><html><head><link rel="icon" type="image/svg+xml" href="/favicon.svg" />' +
      '<script type="module" crossorigin src="/assets/index-abc.js"></script>' +
      '<link rel="stylesheet" crossorigin href="/assets/index-abc.css"></head>' +
      '<body><div id="root"></div></body></html>',
  );
  fs.writeFileSync(
    path.join(root, 'assets', 'index-abc.js'),
    'const t = "</script>"; const w = "/assets/elk-worker.min-x1.js"; console.log(t, w);',
  );
  fs.writeFileSync(path.join(root, 'assets', 'elk-worker.min-x1.js'), 'self.onmessage = () => {};');
  fs.writeFileSync(
    path.join(root, 'assets', 'index-abc.css'),
    '@font-face{src:url(/fonts/inter.woff2)format(\'woff2\')}body{background:url("data:image/png;base64,AA==")}',
  );
  fs.writeFileSync(path.join(root, 'fonts', 'inter.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  fs.writeFileSync(path.join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return root;
}

/** Confere que o HTML não busca nada fora do próprio arquivo. */
function expectSelfContained(html: string) {
  // a marcação, sem o conteúdo dos scripts (que tem textos como "http://www.w3.org/2000/svg")
  const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2');
  expect(markup).not.toMatch(/<script\b[^>]*\bsrc=/i);
  expect(markup).not.toMatch(/<link\b[^>]*\bhref="(?!data:)/i);
  expect(markup).not.toMatch(/url\(\s*(?!['"]?data:)/i);
  expect(markup).not.toMatch(/https?:\/\//i);
  expect(html).toContain(`content="${REPORT_CSP}"`);
  expect(REPORT_CSP).toContain("connect-src 'none'");
}

/** O JSON embutido do grafo, como a interface lê. */
function embeddedGraph(html: string): RastroGraph {
  const m = /<script id="rastro-graph" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  expect(m).not.toBeNull();
  return JSON.parse(m![1]!) as RastroGraph;
}

describe('relatório HTML', () => {
  it('jsonForScript não deixa fechar a tag nem abrir comentários', () => {
    const out = jsonForScript({ name: EVIL, sep: ' ' });
    expect(out).not.toMatch(/[<>]/);
    expect(out).not.toContain(' ');
    expect(JSON.parse(out)).toEqual({ name: EVIL, sep: ' ' });
  });

  it('embute JS, CSS, fontes, worker e grafo num arquivo só', () => {
    const evil = structuredClone(graph);
    evil.nodes.find((n) => n.kind === 'function')!.name = EVIL;
    const html = buildHtmlReport(evil, fakeWebRoot());
    expectSelfContained(html);
    // o </script> dentro do bundle foi neutralizado; só as três tags do relatório fecham
    expect(html).toContain('const t = "<\\/script>"');
    expect(html.match(/<\/script>/gi)).toHaveLength(3);
    expect(html).not.toContain(EVIL);
    expect(html).toContain('src:url("data:font/woff2;base64,d09GMg==")');
    expect(html).toContain('href="data:image/svg+xml;base64,');
    expect(html).toContain(
      'window.__RASTRO_ELK_WORKER_SOURCE__ = "self.onmessage = () =\\u003e {};"',
    );
    expect(embeddedGraph(html)).toEqual(JSON.parse(JSON.stringify(evil)));
  });

  it('recusa uma interface sem compilar ou dividida em pedaços', () => {
    expect(() => buildHtmlReport(graph, tmp('rastro-empty-'))).toThrow(/npm run build/);
    const root = fakeWebRoot();
    fs.writeFileSync(path.join(root, 'assets', 'chunk-1.js'), '');
    fs.appendFileSync(path.join(root, 'assets', 'index-abc.js'), 'import("./chunk-1.js");');
    expect(() => buildHtmlReport(graph, root)).toThrow(/bundle único/);
  });
});

describe('opções do export', () => {
  it('valida formato, nível e relações antes de analisar', () => {
    expect(() => parseExportRequest({ format: undefined })).toThrow(/--format/);
    expect(() => parseExportRequest({ format: 'svg' })).toThrow(/formato desconhecido/);
    expect(() => parseExportRequest({ format: 'json', level: 'files' })).toThrow(
      /--level não se aplica/,
    );
    expect(() => parseExportRequest({ format: 'dot', level: 'pastas' })).toThrow(/nível/);
    expect(() => parseExportRequest({ format: 'dot', edges: 'imports,contains' })).toThrow(
      /--edges/,
    );
    expect(
      parseExportRequest({ format: 'Mermaid', level: 'symbols', edges: 'calls', folder: './src/' }),
    ).toEqual({
      format: 'mermaid',
      options: {
        level: 'symbols',
        edgeKinds: ['calls'],
        folder: 'src',
        includeExternal: false,
        includeUnresolved: true,
      },
    });
  });

  it('json respeita a pasta e continua válido; pasta vazia é um erro claro', () => {
    const out = renderExport(graph, 'json', { folder: 'src/cycle' }, '');
    const g = JSON.parse(out) as RastroGraph;
    expect(validateGraph(g).valid).toBe(true);
    expect(g.nodes.filter((n) => n.kind === 'file').map((n) => n.id)).toEqual([
      'file:src/cycle/a.ts',
      'file:src/cycle/b.ts',
    ]);
    expect(g.stats.importCycles).toHaveLength(1);
    expect(() => renderExport(graph, 'mermaid', { folder: 'nao-existe' }, '')).toThrow(UsageError);
  });
});

const bin = path.join(repo, 'apps', 'cli', 'bin', 'rastro.js');
const bundled = path.join(repo, 'apps', 'cli', 'dist', 'rastro.mjs');
/** Roda a CLI empacotada em português (`RASTRO_LANG=pt`), salvo outro idioma pedido. */
const run = (args: string[], cwd = repo, lang = 'pt') =>
  spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, RASTRO_LANG: lang },
  });

describe.skipIf(!fs.existsSync(bundled))('rastro export e compare (CLI empacotada)', () => {
  let saved: string;
  beforeAll(() => {
    saved = path.join(tmp('rastro-exp-'), 'ts-basic.json');
    execFileSync(process.execPath, [bin, 'analyze', fixture, '-o', saved], { stdio: 'pipe' });
  });

  it('mermaid de uma pasta vai para a saída padrão', () => {
    const res = run(['export', fixture, '--format', 'mermaid']);
    expect(res.status).toBe(0);
    expect(res.stdout.startsWith('%% Rastro · ts-basic · nível: arquivos\nflowchart LR\n')).toBe(
      true,
    );
    expect(res.stdout).toContain('subgraph m_src_cycle["src/cycle"]');
  });

  it('dot e graphml a partir de um JSON salvo, com filtros', () => {
    const out = path.join(tmp('rastro-exp-'), 'mapa.dot');
    const res = run(['export', saved, '-f', 'dot', '--level', 'symbols', '-o', out]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('dot salvo em');
    expect(fs.readFileSync(out, 'utf8')).toContain(
      'subgraph "cluster_class:src/models/user.ts#User"',
    );

    const gml = run(['export', saved, '-f', 'graphml', '--folder', 'src/services', '--external']);
    expect(gml.status).toBe(0);
    expect(gml.stdout).toContain('<node id="file:src/services/user-service.ts">');
    expect(gml.stdout).not.toContain('<node id="file:src/math.ts">');
    expect(gml.stdout).toContain('<data key="g_folder">src/services</data>');
  });

  it('erros de uso saem com código 1 e mensagem em português', () => {
    const noFormat = run(['export', saved]);
    expect(noFormat.status).toBe(1);
    expect(noFormat.stderr).toContain('informe o formato com --format');
    expect(run(['export', saved, '-f', 'json', '--level', 'files']).stderr).toContain(
      '--level não se aplica a --format json',
    );
    expect(run(['analyze', fixture, '--format', 'dot']).stderr).toContain(
      '--format só funciona com "rastro export"',
    );
    expect(run(['export', saved, '-f', 'mermaid', '--folder', 'xyz']).stderr).toContain(
      'nenhum arquivo do grafo está na pasta "xyz"',
    );
  });

  it('html: relatório offline com o grafo embutido (nome padrão na pasta atual)', () => {
    const cwd = tmp('rastro-html-');
    const res = run(['export', saved, '--format', 'html'], cwd);
    expect(res.status).toBe(0);
    const file = path.join(cwd, 'ts-basic.rastro.html');
    const html = fs.readFileSync(file, 'utf8');
    expectSelfContained(html);
    expect(html).toContain('<script type="module">');
    expect(html).toContain('window.__RASTRO_ELK_WORKER_SOURCE__ = "');
    expect(html.match(/<\/script>/gi)).toHaveLength(3);
    const embedded = embeddedGraph(html);
    expect(validateGraph(embedded).valid).toBe(true);
    expect(embedded.nodes).toHaveLength(graph.nodes.length);
    // a pasta pessoal não vai junto no relatório
    if (graph.project.root.startsWith(os.homedir()))
      expect(embedded.project.root.startsWith('~')).toBe(true);
  });

  it('html escapa </script> vindo de nomes do grafo', () => {
    const dir = tmp('rastro-evil-');
    const evil = JSON.parse(fs.readFileSync(saved, 'utf8')) as RastroGraph;
    evil.nodes.find((n) => n.kind === 'function')!.name = EVIL;
    const input = path.join(dir, 'evil.json');
    fs.writeFileSync(input, JSON.stringify(evil));
    const out = path.join(dir, 'r.html');
    expect(run(['export', input, '-f', 'html', '-o', out]).status).toBe(0);
    const html = fs.readFileSync(out, 'utf8');
    expect(html).not.toContain(EVIL);
    expect(html.match(/<\/script>/gi)).toHaveLength(3);
    expect(embeddedGraph(html).nodes.some((n) => n.name === EVIL)).toBe(true);
  });

  it('compare: resumo em português e JSON com --json', () => {
    const dir = tmp('rastro-cmp-');
    const changed = JSON.parse(fs.readFileSync(saved, 'utf8')) as RastroGraph;
    const removed = 'fn:src/math.ts#double';
    changed.nodes = changed.nodes.filter((n) => n.id !== removed);
    changed.edges = changed.edges.filter((e) => e.source !== removed && e.target !== removed);
    changed.nodes.push({
      id: 'fn:src/math.ts#triple',
      kind: 'function',
      name: 'triple',
      parent: 'file:src/math.ts',
      location: { file: 'src/math.ts', startLine: 40, startColumn: 1, endLine: 41, endColumn: 1 },
    });
    const after = path.join(dir, 'depois.json');
    fs.writeFileSync(after, JSON.stringify(changed));

    const human = run(['compare', saved, after]);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain('Comparação');
    expect(human.stdout).toContain('Entraram (1)');
    expect(human.stdout).toContain('+ src/math.ts#triple');
    expect(human.stdout).toContain('Saíram (1)');
    expect(human.stdout).toContain('- src/math.ts#double');
    expect(human.stdout).toContain('Relações removidas');

    const json = run(['compare', saved, after, '--json']);
    const diff = JSON.parse(json.stdout) as GraphDiff;
    expect(diff.nodes.added.map((n) => n.id)).toEqual(['fn:src/math.ts#triple']);
    expect(diff.nodes.removed.map((n) => n.id)).toEqual([removed]);
    expect(diff.edges.removed.length).toBeGreaterThan(0);

    const same = run(['compare', saved, saved]);
    expect(same.stdout).toContain('Nenhum nó, relação ou ciclo mudou');
    expect(run(['compare', saved]).status).toBe(1);
  });

  it('export com --changes leva as mudanças do git junto (relatório de PR)', () => {
    const root = tmp('rastro-exp-git-');
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=T',
          '-c',
          'user.email=t@example.com',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd: root, stdio: 'pipe' },
      );
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function a() {\n  return 1;\n}\n');
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'inicial');
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function a() {\n  return 2;\n}\n');

    const res = run(['export', root, '-f', 'json', '--changes']);
    expect(res.status).toBe(0);
    const exported = JSON.parse(res.stdout) as RastroGraph;
    expect(exported.changes?.baseLabel).toBe('HEAD');
    expect(exported.changes?.files).toEqual([
      { file: 'a.ts', status: 'modified', ranges: [[2, 2]] },
    ]);
    // sem a opção, nada de git
    expect((JSON.parse(run(['export', root, '-f', 'json']).stdout) as RastroGraph).changes).toBe(
      undefined,
    );
  });
});
