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
      'https://github.com/o/r/blob/abc/src/a%7Cb%5D%28https%3A%252F%252Fevil%29.ts',
    );
    expect(md).not.toMatch(/\]\(https:\/\/evil/);
  });

  it('um ")" sem par no nome do arquivo não fecha o link antes da hora', async () => {
    setLang('en');
    const root = changedProject({
      'src/x)~www.evil-example.com/a.ts':
        "import { sum } from '../math';\nexport const y = sum(1, 1);\n",
    });
    const report = buildImpactReport(await graphWithChanges(root));
    const md = renderImpact(report, 'markdown', { link: 'https://github.com/o/r/blob/abc' });
    expect(md).toContain('https://github.com/o/r/blob/abc/src/x%29%7Ewww.evil-example.com/a.ts');
    // o único ")" de fechamento de link em cada linha é o do próprio link
    // fora dos trechos de código, nada de "evil-example" solto (que viraria um link automático)
    for (const line of md.split('\n').filter((l) => l.includes('evil-example'))) {
      const outsideCode = line.replace(/`[^`]*`/g, '');
      expect(outsideCode.replace(/\(https:\/\/github\.com\/o\/r\/[^)\s]*\)/g, '')).not.toContain(
        'evil-example',
      );
    }
  });

  it('arquivo renomeado não aparece ao mesmo tempo como alterado e como afetado', async () => {
    setLang('en');
    const root = changedProject();
    execFileSync('git', ['mv', 'src/app.ts', 'src/app2.ts'], { cwd: root });
    const report = buildImpactReport(await graphWithChanges(root));
    const changed = new Set(report.changed.map((c) => c.id));
    expect(report.impacted.filter((i) => changed.has(i.id))).toEqual([]);
    expect(report.summary.changed).toBe(1); // como na aba Mudanças: só entidades
  });

  it('nomes enormes são cortados (o comentário tem limite de tamanho)', async () => {
    setLang('en');
    const long = 'x'.repeat(5000);
    const root = changedProject({
      'src/route.ts': `import express from 'express';\nimport { sum } from './math';\nconst app = express();\napp.get('/${long}', () => sum(1, 2));\n`,
      'package.json': '{"dependencies":{"express":"*"}}',
    });
    const report = buildImpactReport(await graphWithChanges(root));
    for (const i of [...report.changed, ...report.impacted, ...report.routes])
      expect(i.name.length).toBeLessThanOrEqual(160);
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

/** Projeto com git: `files` no commit base; `change` mexe na cópia de trabalho depois. */
function gitProject(
  files: Record<string, string>,
  change: (tools: {
    write: (rel: string, content: string) => void;
    git: (...args: string[]) => void;
  }) => void,
): string {
  const root = tmp('rastro-broken-');
  const git = (...args: string[]) => {
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
  };
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  change({ write, git });
  return root;
}

/** Escreve (criando as pastas) um arquivo do projeto de teste. */
function writeFile(root: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

const MATH = 'export function sum(a: number, b: number) {\n  return a + b;\n}\n';
const APP =
  "import { sum } from './math.js';\nimport { ghost } from './missing';\n\nexport function total() {\n  return sum(1, 2) + ghost();\n}\n";

describe('possivelmente quebrado pela mudança', () => {
  it('testes que dependem de quem tem uma referência quebrada também rodam', async () => {
    const root = changedProject({
      'src/user.ts':
        "import { sum } from './math';\nexport function load() {\n  return sum(1, 1);\n}\n",
      'test/user.test.ts': "import { load } from '../src/user';\nload();\n",
    });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@x',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'u',
      ],
      { cwd: root },
    );
    fs.rmSync(path.join(root, 'src/math.ts'));
    const report = buildImpactReport(await graphWithChanges(root));
    expect(report.broken.map((b) => b.from.name)).toContain('user.ts');
    // user.ts não tem mais relação comprovada com math.ts, mas é o que vai falhar
    expect(report.tests).toContain('test/user.test.ts');
    expect(report.summary.tests).toBe(report.tests.length);
  });

  const brokenOf = async (root: string) =>
    buildImpactReport(await graphWithChanges(root)).broken.map((b) => [
      b.kind,
      b.from.name,
      b.reference,
      b.target,
      b.why,
      `${b.file}:${b.line}`,
    ]);

  it('nome renomeado no arquivo alterado: o import e as chamadas que não resolvem mais', async () => {
    setLang('en');
    const root = gitProject(
      { 'src/math.ts': MATH, 'src/app.ts': APP, 'src/index.ts': "export { sum } from './math';\n" },
      ({ write }) => write('src/math.ts', MATH.replace('sum', 'add')),
    );
    const report = buildImpactReport(await graphWithChanges(root));
    expect(report.summary.broken).toBe(3);
    expect(await brokenOf(root)).toEqual([
      ['import', 'app.ts', 'sum', 'src/math.ts', 'not-exported', 'src/app.ts:1'],
      ['import', 'index.ts', 'sum', 'src/math.ts', 'not-exported', 'src/index.ts:1'],
      ['call', 'total', 'sum', 'src/math.ts', 'not-exported', 'src/app.ts:5'],
    ]);
    // `ghost` (de um arquivo que nunca existiu) não tem nada a ver com a mudança
    expect(
      report.broken.some((b) => b.reference.includes('ghost') || b.reference.includes('missing')),
    ).toBe(false);
    const text = renderImpact(report, 'text');
    expect(text).toContain('Possibly broken by this change');
    expect(text).toContain('imports sum from src/math.ts, which does not export that name');
    const md = renderImpact(report, 'markdown', { link: 'https://github.com/o/r/blob/abc' });
    expect(md).toContain('#### Possibly broken by this change');
    expect(md).toContain(
      '- `total` [`src/app.ts:5`](https://github.com/o/r/blob/abc/src/app.ts#L5) — calls `sum`, imported from `src/math.ts` (which does not export that name)',
    );
    expect(md).toContain('3 references possibly broken');
    const json = JSON.parse(renderImpact(report, 'json')) as typeof report;
    expect(json.broken).toHaveLength(3);
    setLang('pt');
    expect(renderImpact(report, 'text')).toContain('Possivelmente quebrado pela mudança');
    setLang('en');
  });

  it('arquivo removido ou renomeado: imports do caminho antigo (também pelo .js do ESM)', async () => {
    setLang('en');
    const removed = gitProject({ 'src/math.ts': MATH, 'src/app.ts': APP }, ({ git }) =>
      git('rm', '-q', 'src/math.ts'),
    );
    expect(await brokenOf(removed)).toEqual([
      ['import', 'app.ts', './math.js', 'src/math.ts', 'file-deleted', 'src/app.ts:1'],
      ['call', 'total', 'sum', 'src/math.ts', 'file-deleted', 'src/app.ts:5'],
    ]);
    const renamed = gitProject({ 'src/math.ts': MATH, 'src/app.ts': APP }, ({ git }) =>
      git('mv', 'src/math.ts', 'src/calc.ts'),
    );
    expect((await brokenOf(renamed)).map((b) => b[4])).toEqual(['file-renamed', 'file-renamed']);
  });

  it('método renomeado numa classe: a chamada pelo tipo declarado no arquivo alterado', async () => {
    setLang('en');
    const dog = 'export class Dog {\n  move(): string {\n    return "x";\n  }\n}\n';
    const root = gitProject(
      {
        'src/dog.ts': dog,
        'src/use.ts':
          "import { Dog } from './dog';\n\nexport function walk(d: Dog) {\n  return d.move();\n}\n",
      },
      ({ write }) => write('src/dog.ts', dog.replace('move', 'run')),
    );
    expect(await brokenOf(root)).toEqual([
      ['call', 'walk', 'd.move', 'src/dog.ts', 'member-missing', 'src/use.ts:4'],
    ]);
  });

  it('função renomeada ainda chamada pelo nome antigo no próprio arquivo alterado', async () => {
    setLang('en');
    const math =
      'export function sum(a: number, b: number) {\n  return a + b;\n}\n\nexport function twice(n: number) {\n  return sum(n, n);\n}\n';
    // `describe` sem os tipos instalados falta também num arquivo que não mudou: não conta
    const spec = 'describe("x", () => {});\n';
    // `use.ts` também chama `sum`, mas pelo import que a mudança quebrou: não é "faltava antes"
    const use = "import { sum } from './math';\n\nexport const three = () => sum(1, 2);\n";
    const root = gitProject(
      { 'src/math.ts': math + spec, 'src/use.ts': use, 'test/other.test.ts': spec },
      ({ write }) => write('src/math.ts', math.replace('function sum', 'function add') + spec),
    );
    expect(await brokenOf(root)).toEqual([
      ['import', 'use.ts', 'sum', 'src/math.ts', 'not-exported', 'src/use.ts:1'],
      ['call', 'twice', 'sum', 'src/math.ts', 'name-missing', 'src/math.ts:6'],
      ['call', 'three', 'sum', 'src/math.ts', 'not-exported', 'src/use.ts:3'],
    ]);
    const text = renderImpact(buildImpactReport(await graphWithChanges(root)), 'text');
    expect(text).toContain('calls sum, which is not declared or imported in src/math.ts');
  });

  it('export * de módulo que não se vê e CommonJS: a lista de exports não prova a falta', async () => {
    setLang('en');
    const root = gitProject(
      {
        '.gitignore': 'src/gerado/\n',
        'src/gerado/api.ts': 'export class ApiClient {}\n',
        'src/db.ts':
          "export * from '@prisma/client';\nexport * from './gerado/api';\nexport const local = 1;\n",
        'src/use.ts':
          "import { PrismaClient, ApiClient, local } from './db';\nexport const c = [PrismaClient, ApiClient, local];\n",
        'lib/cj.js': 'exports.foo = function foo() { return 1; };\n',
        'lib/star.js':
          "var __exportStar = function (m, e) { for (var p in m) e[p] = m[p]; };\n__exportStar(require('./inner'), exports);\nexports.own = 1;\n",
        'lib/inner.js': 'exports.inner = function inner() { return 1; };\n',
        'lib/assign.js': 'Object.assign(module.exports, { a1: 1 });\n',
        'use.mjs':
          "import cj from './lib/cj.js';\nimport { inner, own } from './lib/star.js';\nimport { a1 } from './lib/assign.js';\ncj.foo(); inner(); own; a1;\n",
        'use2.ts': "import cj2 from './lib/cj.js';\nexport const v = cj2.foo();\n",
      },
      ({ write }) => {
        write(
          'src/db.ts',
          "export * from '@prisma/client';\nexport * from './gerado/api';\nexport const local = 2;\n",
        );
        write('lib/cj.js', 'exports.foo = function foo() { return 2; };\n');
        write('lib/star.js', "__exportStar(require('./inner'), exports);\nexports.own = 2;\n");
        write('lib/assign.js', 'Object.assign(module.exports, { a1: 2 });\n');
      },
    );
    expect(await brokenOf(root)).toEqual([]);
    // o que a lista completa prova continua valendo: `foo` renomeado em CommonJS
    writeFile(root, 'lib/cj.js', 'exports.bar = function bar() { return 1; };\n');
    writeFile(root, 'use3.mjs', "import { foo } from './lib/cj.js';\nfoo();\n");
    expect((await brokenOf(root)).map((b) => [b[0], b[1], b[2], b[4]])).toEqual([
      ['import', 'use3.mjs', 'foo', 'not-exported'],
      ['call', 'use3.mjs', 'foo', 'not-exported'],
    ]);
  });

  it('nome não declarado só conta na linha alterada ou se a mudança tirou o nome', async () => {
    setLang('en');
    // `gtag` (global de um .d.ts fora da análise) numa função que a mudança não tocou
    const a = 'export function a() {\n  gtag("y");\n}\n\nexport function b() {\n  return 1;\n}\n';
    const untouched = gitProject({ 'src/a.ts': a }, ({ write }) =>
      write('src/a.ts', a.replace('return 1', 'return 2')),
    );
    expect(await brokenOf(untouched)).toEqual([]);
    // globais de um .d.ts do "include" do tsconfig (nunca importado) existem
    const ambient = gitProject(
      {
        'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src","types"]}',
        'src/globals.d.ts': 'declare function track(e: string): void;\n',
        'types/gtag.d.ts': 'declare function gtag(...a: unknown[]): void;\n',
        'src/a.ts': 'export function a() {\n  return 1;\n}\n',
      },
      ({ write }) =>
        write('src/a.ts', 'export function a() {\n  track("x");\n  gtag("y");\n  return 2;\n}\n'),
    );
    expect(await brokenOf(ambient)).toEqual([]);
    // tipos globais pedidos pelo tsconfig e não instalados: os globais deles são desconhecidos
    const spec = (n: number) =>
      `import { sum } from "../src/sum";\ndescribe("sum", () => {\n  it("adds", () => {\n    expect(sum(1, ${n})).toBe(${n + 1});\n  });\n});\n`;
    const types = gitProject(
      {
        'tsconfig.json': '{"compilerOptions":{"types":["vitest/globals","node"]}}',
        'src/sum.ts': 'export function sum(a: number, b: number) { return a + b; }\n',
        'test/sum.test.ts': spec(1),
      },
      ({ write }) => write('test/sum.test.ts', spec(2)),
    );
    expect(await brokenOf(types)).toEqual([]);
  });

  it('arquivo movido: os imports relativos dele que não resolvem mais da pasta nova', async () => {
    setLang('en');
    const a =
      "import { h } from './helper';\nimport { g } from './ghost';\nexport const a = h + g;\n";
    const root = gitProject(
      {
        'src/helper.ts': 'export const h = 1;\n',
        'src/a.ts':
          "import { h } from './helper';\nimport { g } from './ghost';\nexport const a = h + g;\n",
        'src/main.ts': "import { a } from './a';\nexport const m = a;\n",
      },
      ({ git, write }) => {
        // como um `git mv` para uma pasta nova
        write('src/sub/a.ts', a);
        git('rm', '-q', 'src/a.ts');
        git('add', 'src/sub/a.ts');
        write('src/main.ts', "import { a } from './sub/a';\nexport const m = a;\n");
      },
    );
    // `./ghost` nunca existiu: não tem nada a ver com a mudança
    expect(await brokenOf(root)).toEqual([
      ['import', 'a.ts', './helper', 'src/a.ts', 'importer-moved', 'src/sub/a.ts:1'],
    ]);
    const report = buildImpactReport(await graphWithChanges(root));
    expect(renderImpact(report, 'text')).toContain(
      'imports ./helper, which no longer resolves since this file moved from src/a.ts',
    );
    setLang('pt');
    expect(renderImpact(report, 'text')).toContain(
      'importa ./helper, que não resolve mais desde que o arquivo saiu de src/a.ts',
    );
    setLang('en');
  });

  it('nome que some de um arquivo reexportado por barris (export *, em cadeia)', async () => {
    setLang('en');
    const str = 'export function slug(s: string) {\n  return s;\n}\nexport const keep = 1;\n';
    const root = gitProject(
      {
        'src/utils/str.ts': str,
        'src/utils/index.ts': "export * from './str';\n",
        'src/all.ts': "export * from './utils';\n",
        'src/ns.ts': "export * as utils from './utils/str';\n",
        'src/page.ts':
          "import { slug } from './utils';\nimport { slug as s2 } from './all';\nimport { utils } from './ns';\nexport const y = slug('a') + s2('b') + utils.keep;\n",
        // um nome que o barril nunca exportou não tem nada a ver com a mudança
        'src/old.ts': "import { nunca } from './utils';\nexport const z = nunca;\n",
      },
      ({ write }) => write('src/utils/str.ts', str.replace('slug', 'slugify')),
    );
    expect(await brokenOf(root)).toEqual([
      ['import', 'page.ts', 'slug', 'src/utils/str.ts', 'not-exported', 'src/page.ts:1'],
      ['import', 'page.ts', 'slug', 'src/utils/str.ts', 'not-exported', 'src/page.ts:2'],
      ['call', 'page.ts', 'slug', 'src/utils/str.ts', 'not-exported', 'src/page.ts:4'],
    ]);
  });

  it('arquivo removido importado por um alias de paths (ou pelo baseUrl)', async () => {
    setLang('en');
    const root = gitProject(
      {
        'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
        'src/lib/fmt.ts': 'export function fmt(s: string) {\n  return s;\n}\n',
        'src/lib/util/index.ts': 'export const u = 1;\n',
        'src/page.ts':
          "import { fmt } from '@/lib/fmt';\nimport { u } from 'src/lib/util';\nimport { nunca } from '@/nunca';\nexport const y = fmt('a') + u + nunca;\n",
      },
      ({ git }) => {
        git('rm', '-q', 'src/lib/fmt.ts');
        git('rm', '-q', 'src/lib/util/index.ts');
      },
    );
    expect(await brokenOf(root)).toEqual([
      ['import', 'page.ts', '@/lib/fmt', 'src/lib/fmt.ts', 'file-deleted', 'src/page.ts:1'],
      [
        'import',
        'page.ts',
        'src/lib/util',
        'src/lib/util/index.ts',
        'file-deleted',
        'src/page.ts:2',
      ],
      ['call', 'page.ts', 'fmt', 'src/lib/fmt.ts', 'file-deleted', 'src/page.ts:4'],
    ]);
  });

  it('arquivo binário ou vazio removido (o diff não tem ---/+++)', async () => {
    setLang('en');
    const root = gitProject(
      {
        'logo.png': '\u0000\u0001PNG\u0000binário',
        'types.ts': '',
        'main.ts': "import logo from './logo.png';\nimport './types';\nexport const l = logo;\n",
      },
      ({ git }) => {
        git('rm', '-q', 'logo.png');
        git('rm', '-q', 'types.ts');
      },
    );
    expect(await brokenOf(root)).toEqual([
      ['import', 'main.ts', './logo.png', 'logo.png', 'file-deleted', 'main.ts:1'],
      ['import', 'main.ts', './types', 'types.ts', 'file-deleted', 'main.ts:2'],
    ]);
  });

  it('nada quebrado: nenhuma seção nova', async () => {
    setLang('en');
    const report = buildImpactReport(await graphWithChanges(changedProject()));
    expect(report.broken).toEqual([]);
    expect(renderImpact(report, 'text')).not.toContain('Possibly broken');
    expect(renderImpact(report, 'markdown')).not.toContain('Possibly broken');
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

    const testsFile = path.join(tmp('rastro-impact-out-'), 'tests.txt');
    expect(run(['impact', '.', '--tests', '-o', testsFile], root).status).toBe(0);
    expect(fs.readFileSync(testsFile, 'utf8')).toBe('./test/math.test.ts\n');

    const textFile = path.join(tmp('rastro-impact-out-'), 'impact.txt');
    expect(run(['impact', root, '-o', textFile]).status).toBe(0);
    expect(fs.readFileSync(textFile, 'utf8')).not.toContain('\u001b[');

    const out = path.join(tmp('rastro-impact-out-'), 'impact.md');
    expect(run(['impact', saved, '-f', 'markdown', '-o', out]).status).toBe(0);
    expect(fs.readFileSync(out, 'utf8').startsWith('<!-- rastro-impact -->')).toBe(true);
  });

  it('impact de uma pasta aceita --trust-git-config (sempre lê o git)', () => {
    const root = changedProject();
    execFileSync('git', ['config', 'core.pager', 'cat'], { cwd: root });
    const refused = run(['impact', root]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('--trust-git-config');
    const trusted = run(['impact', root, '--trust-git-config']);
    expect(trusted.status, trusted.stderr).toBe(0);
    expect(trusted.stdout).toContain('What changed');
    // com um grafo salvo não há git para ler: a opção continua recusada
    const saved = path.join(tmp('rastro-impact-out-'), 'g.json');
    expect(run(['analyze', root, '--changes', '--trust-git-config', '-o', saved]).status).toBe(0);
    expect(run(['impact', saved, '--trust-git-config']).stderr).toContain(
      'it only works when analyzing a folder',
    );
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
    expect(run(['impact', root, '--tests', '--format', 'json']).stderr).toContain(
      'cannot be used together',
    );
    expect(run(['impact', root, '--link', 'https://x']).stderr).toContain('--link only applies');
    // --changes/--since pedidos explicitamente: sem git, o analyze falha (não segue sem mudanças)
    const noGit = tmp('rastro-impact-nogit-a-');
    fs.writeFileSync(path.join(noGit, 'a.ts'), 'export const a = 1;\n');
    const analyzed = run(['analyze', noGit, '--changes', '-o', path.join(noGit, 'g.json')]);
    expect(analyzed.status).toBe(1);
    expect(analyzed.stderr).toContain('could not read the git changes');
    const notRepo = tmp('rastro-impact-nogit-');
    fs.writeFileSync(path.join(notRepo, 'a.ts'), 'export const a = 1;\n');
    const res = run(['impact', notRepo]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('could not read the git changes');
  });
});
