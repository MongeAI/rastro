/**
 * `rastro check`: regras de arquitetura (rastro.rules.json) lidas com segurança, conferidas no
 * grafo e mostradas em texto, Markdown e JSON; `--init` trava a arquitetura atual.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeProject } from '@rastro/analyzer';
import { buildCheckReport, failingCount, readRules, renderCheck } from '../src/check.js';
import { setLang } from '../src/i18n.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const bin = path.join(repo, 'apps', 'cli', 'bin', 'rastro.js');
const bundled = fs.existsSync(path.join(repo, 'apps', 'cli', 'dist', 'rastro.mjs'));
const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function project(files: Record<string, string>): string {
  const root = tmp('rastro-check-');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

/** ui → services → db, e a ui também usa o db direto. */
const layered = {
  'src/db/client.ts': 'export function query(sql: string) { return sql; }\n',
  'src/services/users.ts':
    "import { query } from '../db/client';\nexport function listUsers() { return query('x'); }\n",
  'src/ui/page.ts':
    "import { listUsers } from '../services/users';\nimport { query } from '../db/client';\nexport function render() {\n  listUsers();\n  return query('y');\n}\n",
};
const rules = (list: unknown[]) => `${JSON.stringify({ rules: list }, null, 2)}\n`;

function run(args: string[], cwd?: string) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    ...(cwd ? { cwd } : {}),
    env: { ...process.env, NO_COLOR: '1', RASTRO_LANG: 'en' },
  });
}

describe('readRules', () => {
  it('sem arquivo: undefined; com --rules ausente: erro', () => {
    const root = project(layered);
    expect(readRules(root)).toBeUndefined();
    expect(() => readRules(root, path.join(root, 'nao.json'))).toThrow(/not found|não encontrado/);
  });

  it('JSON inválido vira problema, sem ecoar o conteúdo do arquivo', () => {
    const root = project({ 'rastro.rules.json': '{"rules": [SEGREDO-123 ]}' });
    const read = readRules(root)!;
    expect(read.source).toBe('rastro.rules.json');
    expect(read.issues?.[0]?.code).toBe('invalid-json');
    expect(JSON.stringify(read.issues)).not.toContain('SEGREDO');
    for (const text of [
      '{"rules": "SEGREDO',
      '{"a": 1,}',
      '{"rules": [1, 2',
      '{\n  "x": SEGREDO\n}',
    ]) {
      fs.writeFileSync(path.join(root, 'rastro.rules.json'), text);
      const issue = readRules(root)!.issues![0]!;
      expect(issue.code).toBe('invalid-json');
      expect(String(issue.params.message)).not.toContain('SEGREDO');
      expect(String(issue.params.message)).not.toBe('');
    }
  });

  it.skipIf(process.platform === 'win32')(
    'link simbólico no lugar do arquivo padrão é recusado (o CI leria um arquivo de fora)',
    () => {
      const root = project(layered);
      const outside = path.join(tmp('rastro-check-out-'), 'segredo.json');
      fs.writeFileSync(outside, rules([{ name: 'x', noCycles: true }]));
      fs.symlinkSync(outside, path.join(root, 'rastro.rules.json'));
      expect(() => readRules(root)).toThrow(/symbolic|simbólico/);
      // pedido explicitamente com --rules, o link é seguido
      expect(readRules(root, path.join(root, 'rastro.rules.json'))?.config).toBeTruthy();
    },
  );

  it('regras com problemas: os códigos, e nenhuma regra', () => {
    const root = project({ 'rastro.rules.json': rules([{ name: 'a', form: 'src', deny: 'x' }]) });
    expect(readRules(root)).toEqual({
      source: 'rastro.rules.json',
      issues: [{ code: 'unknown-key', params: { field: 'rules[0].form' } }],
    });
  });
});

describe('relatório do check', () => {
  it('texto, Markdown (nomes do projeto sempre em código) e JSON', async () => {
    const root = project({
      ...layered,
      'rastro.rules.json': rules([
        {
          name: 'UI <b>sem</b> banco @time',
          from: 'src/ui',
          deny: 'src/db',
          because: 'Use [services](http://x)',
        },
        { name: 'Sem ciclos', noCycles: true },
        { name: 'Errado', from: 'src/iu', deny: 'src/db', severity: 'warning' },
      ]),
    });
    const graph = await analyzeProject(root);
    graph.rules = readRules(root);
    const report = buildCheckReport(graph);
    expect(report.summary).toMatchObject({ rules: 3, errors: 1, warnings: 0 });
    expect(failingCount(report)).toBe(1);
    expect(report.results[2]!.files).toBe(0);

    setLang('en');
    const text = renderCheck(report, 'text');
    expect(text).toContain('✗ UI <b>sem</b> banco @time · 1 violation');
    expect(text).toContain('src/ui/page.ts → src/db/client.ts (import, call) src/ui/page.ts:2');
    expect(text).toContain('✓ Sem ciclos');
    expect(text).toContain('no analyzed file matches');

    const md = renderCheck(report, 'markdown', { link: 'https://github.com/o/r/blob/abc' });
    expect(md.startsWith('<!-- rastro-check -->')).toBe(true);
    expect(md).toContain('`UI <b>sem</b> banco @time`');
    expect(md).toContain('`Use [services](http://x)`');
    expect(md.replace(/`[^`]*`/g, '')).not.toMatch(/<b>|\]\(http:\/\/x/);
    expect(md).toContain('[`src/ui/page.ts:2`](https://github.com/o/r/blob/abc/src/ui/page.ts#L2)');

    const json = JSON.parse(renderCheck(report, 'json')) as typeof report;
    expect(json.results[0]!.violations[0]).toMatchObject({
      from: 'src/ui/page.ts',
      to: 'src/db/client.ts',
      kinds: ['imports', 'calls'],
      evidence: [
        { file: 'src/ui/page.ts', line: 2 },
        { file: 'src/ui/page.ts', line: 5 },
      ],
    });
    setLang('pt');
  });
});

describe.skipIf(!bundled)('rastro check (CLI)', () => {
  it('sem arquivo de regras: código 2 com a dica do --init', () => {
    const root = project(layered);
    const res = run(['check', root]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('rastro check --init');
  });

  it('regras inválidas: código 2, antes de analisar', () => {
    const root = project({ ...layered, 'rastro.rules.json': rules([{ name: 'a' }]) });
    const res = run(['check', root]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('rules[0] needs "deny", "allow" or "noCycles": true.');
    expect(res.stderr).not.toContain('Looking for');
  });

  it('--init cria regras que já passam; não sobrescreve; violação dá código 1', () => {
    const root = project(layered);
    const init = run(['check', '--init'], root);
    expect(init.status, init.stderr).toBe(0);
    const created = JSON.parse(fs.readFileSync(path.join(root, 'rastro.rules.json'), 'utf8')) as {
      $schema: string;
      rules: Array<{ name: string }>;
    };
    expect(created.$schema).toMatch(/rastro-rules\.schema\.json$/);
    expect(created.rules.map((r) => r.name)).toEqual([
      'src/db does not depend on src/services or src/ui',
      'src/services does not depend on src/ui',
      'No import cycles',
    ]);
    expect(run(['check', '--init'], root).status).toBe(2);
    expect(run(['check'], root).status).toBe(0);

    fs.writeFileSync(
      path.join(root, 'src/db/client.ts'),
      "import { render } from '../ui/page';\nexport function query(sql: string) { return sql; }\nexport const r = () => render();\n",
    );
    const res = run(['check', root, '--format', 'json']);
    expect(res.status).toBe(1);
    const report = JSON.parse(res.stdout) as { summary: { errors: number } };
    expect(report.summary.errors).toBe(2);
  });

  it('--changes: só o que a mudança introduziu reprova', () => {
    const root = project({
      ...layered,
      'rastro.rules.json': rules([{ name: 'ui sem db', from: 'src/ui', deny: 'src/db' }]),
    });
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=T', '-c', 'user.email=t@x', '-c', 'commit.gpgsign=false', ...args],
        { cwd: root, stdio: 'pipe' },
      );
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'base');
    // a violação existente (ui → db) não muda: nada novo
    fs.appendFileSync(path.join(root, 'src/services/users.ts'), '// ok\n');
    const clean = run(['check', root, '--changes']);
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    expect(clean.stdout).toContain('no new violations');
    expect(clean.stdout).toContain('1 already existed');
    // uma nova chamada ao db numa linha alterada: reprova
    fs.writeFileSync(
      path.join(root, 'src/ui/other.ts'),
      "import { query } from '../db/client';\nexport const o = () => query('z');\n",
    );
    const dirty = run(['check', root, '--changes']);
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).toContain('src/ui/other.ts → src/db/client.ts');
    expect(dirty.stdout).not.toContain('src/ui/page.ts → src/db/client.ts');
  });

  it('opções que não se aplicam falham', () => {
    const root = project(layered);
    expect(run(['check', root, '--tests']).status).toBe(1);
    expect(run(['check', root, '--init', '--format', 'json']).status).toBe(1);
    expect(run(['check', root, '--init', '--changes']).status).toBe(1);
    expect(run(['check', root, '--format', 'html']).status).toBe(1);
    expect(run(['analyze', root, '--init']).status).toBe(1);
    expect(run(['validate', 'x.json', '--rules', 'r.json']).status).toBe(1);
  });

  it('o mapa (analyze) leva as regras no JSON e mostra o resumo', () => {
    const root = project({
      ...layered,
      'rastro.rules.json': rules([{ name: 'ui sem db', from: 'src/ui', deny: 'src/db' }]),
    });
    const out = path.join(root, 'g.json');
    const res = run(['analyze', root, '-o', out]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toContain('rules: 1 violation');
    const graph = JSON.parse(fs.readFileSync(out, 'utf8')) as { rules: { source: string } };
    expect(graph.rules.source).toBe('rastro.rules.json');
    expect(run(['validate', out]).status).toBe(0);
  });
});
