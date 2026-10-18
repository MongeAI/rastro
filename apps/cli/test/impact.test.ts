import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeProject } from '@rastro/analyzer';
import type { RastroGraph } from '@rastro/core';
import { buildImpactReport, mdCode, renderImpact, testPathsFrom } from '../src/impact.js';
import { collectChanges } from '../src/git.js';
import { setLang } from '../src/i18n.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const bin = path.join(repo, 'apps', 'cli', 'bin', 'rastro.js');
const bundled = fs.existsSync(path.join(repo, 'apps', 'cli', 'dist', 'rastro.mjs'));
const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/** Projeto com git: math.ts mudou; app.ts e um teste dependem dele. */
function changedProject(extra: Record<string, string> = {}): string {
  const root = tmp('rastro-impact-');
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
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  write('src/math.ts', 'export function sum(a: number, b: number) {\n  return a + b;\n}\n');
  write(
    'src/app.ts',
    "import { sum } from './math';\n\nexport function total() {\n  return sum(1, 2);\n}\n",
  );
  write(
    'test/math.test.ts',
    "import { sum } from '../src/math';\n\nexport function check() {\n  return sum(2, 2) === 4;\n}\n",
  );
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  write('src/math.ts', 'export function sum(a: number, b: number) {\n  return b + a;\n}\n');
  for (const [rel, content] of Object.entries(extra)) write(rel, content);
  return root;
}

async function graphWithChanges(root: string): Promise<RastroGraph> {
  const graph = await analyzeProject(root);
  graph.changes = collectChanges(root);
  return graph;
}

describe('mdCode (texto do projeto em comentário público)', () => {
  it('nunca vira link, imagem, menção ou HTML', () => {
    expect(mdCode('[x](https://evil) ![i](a) @someone <img src=x>')).toBe(
      '`[x](https://evil) ![i](a) @someone <img src=x>`',
    );
  });

  it('crases no nome usam uma cerca maior', () => {
    expect(mdCode('a`b')).toBe('``a`b``');
    expect(mdCode('`x`')).toBe('`` `x` ``');
  });

  it('quebras de linha e controles viram espaço; em tabela, | é escapado', () => {
    expect(mdCode('a\nb\r\u0007c')).toBe('`a b  c`');
    expect(mdCode('a|b', true)).toBe('`a\\|b`');
    expect(mdCode('a|b')).toBe('`a|b`');
  });
});

describe('relatório de impacto', () => {
  it('o que mudou, quem é afetado e os testes; links seguros no markdown', async () => {
    setLang('en');
    const root = changedProject();
    const report = buildImpactReport(await graphWithChanges(root));
    expect(report.summary).toMatchObject({ files: 1, changed: 1, tests: 1 });
    expect(report.changed.map((c) => c.name)).toEqual(['sum']);
    expect(report.impacted.map((i) => [i.name, i.depth, i.via.kind])).toContainEqual([
      'total',
      1,
      'calls',
    ]);
    expect(report.tests).toEqual(['test/math.test.ts']);
    expect(testPathsFrom(report, root, root)).toEqual(['./test/math.test.ts']);
    expect(testPathsFrom(report, root, path.dirname(root))).toEqual([
      `./${path.basename(root)}/test/math.test.ts`,
    ]);

    const md = renderImpact(report, 'markdown', { link: 'https://github.com/o/r/blob/abc/' });
    expect(md.startsWith('<!-- rastro-impact -->\n')).toBe(true);
    expect(md).toContain('[`src/math.ts:1`](https://github.com/o/r/blob/abc/src/math.ts#L1)');
    expect(md).toContain('| 1 | `total` | Function | calls `sum` |');

    const json = JSON.parse(renderImpact(report, 'json')) as typeof report;
    expect(json.summary).toEqual(report.summary);
  });

  it('nomes maliciosos de arquivo não quebram a tabela nem viram link', async () => {
    setLang('en');
    const root = changedProject({
      'src/a|b](https:%2F%2Fevil).ts':
        "import { sum } from './math';\nexport const x = sum(1, 1);\n",
    });
    const report = buildImpactReport(await graphWithChanges(root));
    const md = renderImpact(report, 'markdown', { link: 'https://github.com/o/r/blob/abc' });
    const row = md.split('\n').find((l) => l.includes('a\\|b'));
    expect(row).toBeDefined();
    // a célula do arquivo continua um link do próprio repositório, com o nome codificado
    expect(row).toContain(
      'https://github.com/o/r/blob/abc/src/a%7Cb%5D(https%3A%252F%252Fevil).ts',
    );
    expect(md).not.toMatch(/\]\(https:\/\/evil/);
  });

  it('textos em português', async () => {
    setLang('pt');
    const report = buildImpactReport(await graphWithChanges(changedProject()));
    const text = renderImpact(report, 'markdown');
    expect(text).toContain('Impacto das mudanças');
    expect(text).toContain('Testes para rodar');
    setLang('en');
  });
});

const run = (args: string[], cwd = repo) =>
  spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, RASTRO_LANG: 'en', NO_COLOR: '1' },
  });

describe.skipIf(!bundled)('rastro impact (CLI empacotada)', () => {
  it('texto, --tests e markdown a partir de uma pasta; json a partir de um grafo salvo', () => {
    const root = changedProject();
    const text = run(['impact', root]);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain('Impact of the changes since the last commit');
    expect(text.stdout).toContain('What changed');

    const tests = run(['impact', '.', '--tests'], root);
    expect(tests.stdout).toBe('./test/math.test.ts\n');
    expect(tests.stderr).toBe('');

    const saved = path.join(tmp('rastro-impact-out-'), 'g.json');
    expect(run(['analyze', root, '--changes', '-o', saved]).status).toBe(0);
    const json = run(['impact', saved, '--format', 'json']);
    expect((JSON.parse(json.stdout) as { summary: { changed: number } }).summary.changed).toBe(1);

    const out = path.join(tmp('rastro-impact-out-'), 'impact.md');
    expect(run(['impact', saved, '-f', 'markdown', '-o', out]).status).toBe(0);
    expect(fs.readFileSync(out, 'utf8').startsWith('<!-- rastro-impact -->')).toBe(true);
  });

  it('erros de uso claros', () => {
    const root = changedProject();
    expect(run(['impact', root, '--format', 'mermaid']).stderr).toContain(
      'unknown format for impact',
    );
    const saved = path.join(tmp('rastro-impact-out-'), 'g.json');
    run(['analyze', root, '-o', saved]);
    expect(run(['impact', saved]).stderr).toContain('this graph has no git changes');
    expect(run(['impact', saved, '--since', 'main']).stderr).toContain('--since');
    expect(run(['analyze', root, '--tests']).stderr).toContain('--tests');
    expect(run(['impact', root, '--level', 'files']).stderr).toContain('--level');
    const notRepo = tmp('rastro-impact-nogit-');
    fs.writeFileSync(path.join(notRepo, 'a.ts'), 'export const a = 1;\n');
    const res = run(['impact', notRepo]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('could not read the git changes');
  });
});
