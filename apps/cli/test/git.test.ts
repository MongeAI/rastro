import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeProject } from '@rastro/analyzer';
import { validateGraph } from '@rastro/core';
import { computeChangeImpact, GraphIndex } from '@rastro/graph';
import { collectChanges, GitError, parseUnifiedDiff, riskyGitConfig, unquote } from '../src/git.js';

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

  it('tira o TAB que o git põe depois de caminhos com espaço', () => {
    const diff = [
      'diff --git a/src/meu arquivo.ts b/src/meu arquivo.ts',
      '--- a/src/meu arquivo.ts\t',
      '+++ b/src/meu arquivo.ts\t',
      '@@ -1 +1 @@',
    ].join('\n');
    expect(parseUnifiedDiff(diff)).toEqual([
      { file: 'src/meu arquivo.ts', status: 'modified', ranges: [[1, 1]] },
    ]);
  });

  it('decodifica caminhos entre aspas (escapes do git e octais UTF-8)', () => {
    const diff = [
      'diff --git "a/src/a\\tb.ts" "b/src/a\\tb.ts"',
      '--- "a/src/a\\tb.ts"',
      '+++ "b/src/a\\tb.ts"',
      '@@ -2 +2 @@',
      'diff --git "a/x\\"y.ts" "b/z\\\\w.ts"',
      'rename from "x\\"y.ts"',
      'rename to "z\\\\w.ts"',
    ].join('\n');
    expect(parseUnifiedDiff(diff)).toEqual([
      { file: 'src/a\tb.ts', status: 'modified', ranges: [[2, 2]] },
      { file: 'z\\w.ts', status: 'renamed', previous: 'x"y.ts', ranges: [] },
    ]);
  });
  it('linhas de conteúdo que parecem cabeçalhos ("+++ ", "--- ") não trocam o arquivo', () => {
    // "++ n;" adicionada vira "+++ n;"; "-- comentário" removida vira "--- comentário"
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -2 +2,2 @@',
      '--- comentário removido',
      '+++ n;',
      '+++ b/outro.ts',
      '@@ -9,0 +10 @@',
      '+--- /dev/null',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(parseUnifiedDiff(diff)).toEqual([
      {
        file: 'src/a.ts',
        status: 'modified',
        ranges: [
          [2, 3],
          [10, 10],
        ],
        removedNames: ['comentário', 'removido'],
      },
      { file: 'src/b.ts', status: 'modified', ranges: [[1, 1]], removedNames: ['x'] },
    ]);
  });

  it('nomes das linhas removidas (fora de chamadas): pistas do que a mudança tirou', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,2 @@',
      '-export function sum(a: number) {',
      "-  gtag('evento'); return a",
      "-import { fmt, type Opt } from './fmt';",
      '+export function add(a: number) {',
      'diff --git a/src/velho.ts b/src/velho.ts',
      'deleted file mode 100644',
      '--- a/src/velho.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-export const velho = 1;',
    ].join('\n');
    expect(parseUnifiedDiff(diff).map((f) => f.removedNames)).toEqual([
      ['sum', 'a', 'number', 'evento', 'fmt', 'Opt'],
      undefined,
    ]);
  });
});

describe('unquote', () => {
  it('trata \\t, \\n, \\", \\\\ e bytes em octal', () => {
    expect(unquote('"a\\tb"')).toBe('a\tb');
    expect(unquote('"linha\\nquebrada.ts"')).toBe('linha\nquebrada.ts');
    expect(unquote('"diz \\"oi\\".ts"')).toBe('diz "oi".ts');
    expect(unquote('"barra\\\\.ts"')).toBe('barra\\.ts');
    expect(unquote('"src/a\\303\\247\\303\\243o.ts"')).toBe('src/ação.ts');
    expect(unquote('"já-é-utf8.ts"')).toBe('já-é-utf8.ts');
    expect(unquote('sem/aspas.ts')).toBe('sem/aspas.ts');
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

  it('recusa filtros no .git/config.worktree (extensions.worktreeConfig): o comando nunca roda', () => {
    const root = repo({ ...base, '.gitattributes': '*.ts filter=evil\n' });
    run(root, 'config', 'extensions.worktreeConfig', 'true');
    run(root, 'config', '--worktree', 'filter.evil.clean', "sh -c 'touch PWNED; cat'");
    // `git config --local --list` não mostra essa chave
    expect(String(run(root, 'config', '--local', '--list', '--name-only'))).not.toContain(
      'filter.evil',
    );
    fs.appendFileSync(path.join(root, 'src/main.ts'), '// mudança\n');
    expect(() => collectChanges(root)).toThrow(/filter\.evil\.clean/);
    expect(fs.existsSync(path.join(root, 'PWNED'))).toBe(false);
    // prova de que o vetor é real: confiando na configuração, o git roda o filtro
    collectChanges(root, { trustConfig: true });
    expect(fs.existsSync(path.join(root, 'PWNED'))).toBe(true);
  });

  it('recusa include.path no config.worktree e chaves vindas de GIT_CONFIG_*', () => {
    const root = repo(base);
    run(root, 'config', 'extensions.worktreeConfig', 'true');
    run(root, 'config', '--worktree', 'include.path', '../outro.config');
    expect(riskyGitConfig(root)).toEqual(['include.path']);
    expect(() => collectChanges(root)).toThrow(GitError);

    const clean = repo(base);
    expect(riskyGitConfig(clean)).toEqual([]);
    const saved = { ...process.env };
    try {
      Object.assign(process.env, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.pager',
        GIT_CONFIG_VALUE_0: 'touch PAGER_RODOU',
      });
      expect(riskyGitConfig(clean)).toEqual(['core.pager']);
    } finally {
      for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'])
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
  });

  it('caminhos com espaço, aspas e acento, mesmo com prefixos trocados na config global', () => {
    const root = repo({ ...base, 'src/meu arquivo.ts': 'export const a = 1;\n' });
    fs.writeFileSync(path.join(root, 'src/meu arquivo.ts'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(root, 'src/ação "x".ts'), 'export const b = 1;\n');
    run(root, 'add', '-A');
    run(root, 'commit', '-q', '-m', 'nomes');
    fs.writeFileSync(path.join(root, 'src/meu arquivo.ts'), 'export const a = 3;\n');
    fs.writeFileSync(path.join(root, 'src/ação "x".ts'), 'export const b = 2;\n');

    const expected = [
      ['src/ação "x".ts', 'modified'],
      ['src/meu arquivo.ts', 'modified'],
    ];
    const globalConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-gcfg-')), 'cfg');
    const before = process.env.GIT_CONFIG_GLOBAL;
    try {
      for (const config of [
        '[diff]\n\tnoprefix = true\n',
        '[diff]\n\tmnemonicPrefix = true\n',
        '[diff]\n\tsrcPrefix = x/\n\tdstPrefix = y/\n\trelative = true\n',
      ]) {
        fs.writeFileSync(globalConfig, config);
        process.env.GIT_CONFIG_GLOBAL = globalConfig;
        const changes = collectChanges(root);
        expect(
          changes.files.map((f) => [f.file, f.status]),
          config,
        ).toEqual(expected);
      }
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
  });

  it('arquivos novos: não segue links, não lê o que o analisador não lê, limita o tamanho', () => {
    const root = repo(base);
    fs.writeFileSync(path.join(root, 'src/novo.ts'), 'a\nb\nc\n');
    fs.writeFileSync(path.join(root, 'notas.txt'), 'x\n'.repeat(50));
    fs.writeFileSync(path.join(root, 'src/enorme.ts'), '// x\n'.repeat(400_000));
    if (process.platform === 'linux') {
      fs.symlinkSync('/dev/zero', path.join(root, 'zero.ts'));
      execFileSync('mkfifo', [path.join(root, 'fila.ts')]);
    }
    const changes = collectChanges(root);
    const byFile = Object.fromEntries(changes.files.map((f) => [f.file, f]));
    expect(byFile['src/novo.ts']).toEqual({
      file: 'src/novo.ts',
      status: 'added',
      ranges: [[1, 3]],
    });
    expect(byFile['notas.txt']?.ranges).toEqual([[1, 1]]);
    expect(byFile['src/enorme.ts']?.ranges).toEqual([[1, 1]]);
    if (process.platform === 'linux') expect(byFile['zero.ts']?.ranges).toEqual([[1, 1]]);
  });

  it('aceita uma subpasta do repositório como raiz', () => {
    const root = repo({ ...base, 'outro/z.ts': 'export const z = 1;\n' });
    fs.appendFileSync(path.join(root, 'src/main.ts'), '// sub\n');
    fs.appendFileSync(path.join(root, 'outro/z.ts'), '// fora\n');
    const changes = collectChanges(path.join(root, 'src'));
    expect(changes.files.map((f) => f.file)).toEqual(['main.ts']);
  });

  it('conteúdo real com "++"/"--" no começo da linha: o arquivo certo, nas linhas certas', () => {
    const root = repo({ 'src/a.ts': 'let n = 0;\nexport const x = n;\n' });
    fs.writeFileSync(
      path.join(root, 'src/a.ts'),
      'let n = 0;\n++ n;\n-- n;\nexport const x = n;\n',
    );
    const changes = collectChanges(root);
    expect(changes.files).toEqual([{ file: 'src/a.ts', status: 'modified', ranges: [[2, 3]] }]);
  });

  it('nunca entra em submódulos: um filtro em .git/modules/<nome>/config não roda', () => {
    const sub = repo({ 'x.ts': 'export const a = 1;\n' });
    const root = repo(base);
    run(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub');
    run(root, 'commit', '-q', '-m', 'submódulo');
    const pwned = path.join(root, 'PWNED');
    const modules = path.join(root, '.git', 'modules', 'sub');
    run(
      root,
      'config',
      '-f',
      path.join(modules, 'config'),
      'filter.evil.clean',
      `sh -c 'touch "${pwned}"; cat'`,
    );
    fs.mkdirSync(path.join(modules, 'info'), { recursive: true });
    fs.writeFileSync(path.join(modules, 'info', 'attributes'), '*.ts filter=evil\n');
    // arquivo do submódulo "sujo" (stat diferente): o status dentro dele rodaria o filtro
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(root, 'sub', 'x.ts'), later, later);
    fs.appendFileSync(path.join(root, 'src/main.ts'), '// mudança\n');
    const changes = collectChanges(root);
    expect(changes.files.map((f) => f.file)).toEqual(['src/main.ts']);
    expect(fs.existsSync(pwned)).toBe(false);
  });

  it('pasta analisada com nome de "mágica" de pathspec (":(top)x") é lida como caminho', () => {
    const root = repo({ ...base, ':(top)x/a.ts': 'export const a = 1;\n' });
    fs.appendFileSync(path.join(root, ':(top)x/a.ts'), '// mudança\n');
    fs.writeFileSync(path.join(root, ':(top)x/novo.ts'), 'export const b = 1;\n');
    fs.appendFileSync(path.join(root, 'src/main.ts'), '// fora da pasta\n');
    const changes = collectChanges(path.join(root, ':(top)x'));
    expect(changes.files.map((f) => [f.file, f.status])).toEqual([
      ['a.ts', 'modified'],
      ['novo.ts', 'added'],
    ]);
  });

  it('explica quando a pasta não é um repositório git', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-nogit-'));
    expect(() => collectChanges(dir)).toThrow(GitError);
  });
});
