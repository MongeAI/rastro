import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeProject } from '@rastro/analyzer';
import { validateGraph } from '@rastro/core';
import { computeChangeImpact, GraphIndex } from '@rastro/graph';
import { collectChanges, GitError, parseUnifiedDiff } from '../src/git.js';

const run = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Teste',
      '-c',
      'user.email=teste@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, stdio: 'pipe' },
  );

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-git-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  run(root, 'init', '-q', '-b', 'main');
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', 'inicial');
  return fs.realpathSync(root);
}

describe('parseUnifiedDiff', () => {
  it('lê linhas alteradas, remoções, arquivos novos, removidos e renomeados', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3 +3,2 @@',
      '@@ -10,2 +11,0 @@',
      'diff --git a/src/novo.ts b/src/novo.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/novo.ts',
      '@@ -0,0 +1,4 @@',
      'diff --git a/src/velho.ts b/src/velho.ts',
      'deleted file mode 100644',
      '--- a/src/velho.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      'diff --git a/src/x.ts b/src/y.ts',
      'similarity index 90%',
      'rename from src/x.ts',
      'rename to src/y.ts',
      '--- a/src/x.ts',
      '+++ b/src/y.ts',
      '@@ -5 +5 @@',
    ].join('\n');
    expect(parseUnifiedDiff(diff)).toEqual([
      { file: 'src/a.ts', status: 'modified', ranges: [[3, 4]], deletionsAt: [12] },
      { file: 'src/novo.ts', status: 'added', ranges: [[1, 4]] },
      { file: 'src/velho.ts', status: 'deleted', ranges: [], deletionsAt: [1] },
      { file: 'src/y.ts', status: 'renamed', previous: 'src/x.ts', ranges: [[5, 5]] },
    ]);
  });
});

describe('collectChanges + impacto', () => {
  const base = {
    'src/strings.ts': [
      'export function slugify(text: string) {',
      '  return text.trim();',
      '}',
      '',
      'export function upper(text: string) {',
      '  return text.toUpperCase();',
      '}',
    ].join('\n'),
    'src/main.ts':
      "import { slugify } from './strings';\nexport function main() { return slugify(' a '); }\n",
    'src/strings.test.ts':
      "import { slugify } from './strings';\nexport function testa() { return slugify('x'); }\n",
  };

  it('marca a função alterada, quem depende dela e os testes afetados', async () => {
    const root = repo(base);
    fs.writeFileSync(
      path.join(root, 'src/strings.ts'),
      base['src/strings.ts'].replace('text.trim()', 'text.trim().toLowerCase()'),
    );
    fs.writeFileSync(path.join(root, 'src/extra.ts'), 'export const x = 1;\n');
    const changes = collectChanges(root);
    expect(changes.baseLabel).toBe('HEAD');
    expect(changes.files.map((f) => [f.file, f.status])).toEqual([
      ['src/extra.ts', 'added'],
      ['src/strings.ts', 'modified'],
    ]);

    const graph = await analyzeProject(root);
    graph.changes = changes;
    expect(validateGraph(graph).valid).toBe(true);
    const impact = computeChangeImpact(new GraphIndex(graph), changes);
    expect(impact.changedEntities.map((n) => n.id)).toEqual(['fn:src/strings.ts#slugify']);
    expect(impact.impacted.map((i) => i.node.id)).toEqual(
      expect.arrayContaining(['fn:src/main.ts#main', 'fn:src/strings.test.ts#testa']),
    );
    expect(impact.impacted.some((i) => i.node.id === 'fn:src/strings.ts#upper')).toBe(false);
    expect(impact.tests.map((n) => n.id)).toEqual(['file:src/strings.test.ts']);
  });

  it('--since compara com o ponto em que a branch saiu', async () => {
    const root = repo(base);
    run(root, 'switch', '-q', '-c', 'feature');
    fs.writeFileSync(path.join(root, 'src/main.ts'), base['src/main.ts'] + '// mudança\n');
    run(root, 'commit', '-q', '-am', 'mudança');
    const changes = collectChanges(root, { since: 'main' });
    expect(changes.baseLabel).toBe('main');
    expect(changes.files.map((f) => f.file)).toEqual(['src/main.ts']);
  });

  it('recusa repositórios cujo .git/config executaria comandos', () => {
    const root = repo(base);
    run(root, 'config', 'core.fsmonitor', 'touch FSMONITOR_RODOU');
    expect(() => collectChanges(root)).toThrow(GitError);
    expect(() => collectChanges(root)).toThrow(/trust-git-config/);
    expect(fs.existsSync(path.join(root, 'FSMONITOR_RODOU'))).toBe(false);
  });

  it('aceita uma subpasta do repositório como raiz', () => {
    const root = repo({ ...base, 'outro/z.ts': 'export const z = 1;\n' });
    fs.appendFileSync(path.join(root, 'src/main.ts'), '// sub\n');
    fs.appendFileSync(path.join(root, 'outro/z.ts'), '// fora\n');
    const changes = collectChanges(path.join(root, 'src'));
    expect(changes.files.map((f) => f.file)).toEqual(['main.ts']);
  });

  it('explica quando a pasta não é um repositório git', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-nogit-'));
    expect(() => collectChanges(dir)).toThrow(GitError);
  });
});
