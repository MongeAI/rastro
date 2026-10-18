/**
 * Scripts da GitHub Action (scripts/action/*.sh) rodando como no Actions: um repositório git com
 * uma branch de feature, o `rastro` local no lugar do npm e um `gh` falso que registra as chamadas.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const bin = path.join(repo, 'apps', 'cli', 'bin', 'rastro.js');
const impactSh = path.join(repo, 'scripts', 'action', 'impact.sh');
const commentSh = path.join(repo, 'scripts', 'action', 'comment.sh');
const bundled = fs.existsSync(path.join(repo, 'apps', 'cli', 'dist', 'rastro.mjs'));
const hasTools = ['bash', 'jq', 'git'].every(
  (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0,
);
const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function featureRepo(sub = ''): string {
  const root = tmp('rastro-action-');
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
    fs.mkdirSync(path.dirname(path.join(root, sub, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, sub, rel), content);
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
  git('checkout', '-q', '-b', 'feature');
  write('src/math.ts', 'export function sum(a: number, b: number) {\n  return b + a;\n}\n');
  git('commit', '-qam', 'change sum');
  return root;
}

function runImpact(root: string, env: Record<string, string>) {
  const work = tmp('rastro-action-out-');
  const summary = path.join(work, 'summary.md');
  const output = path.join(work, 'output.txt');
  const res = spawnSync('bash', [impactSh], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      RASTRO_BIN: `${process.execPath} ${bin}`,
      RASTRO_PATH: '.',
      RASTRO_BASE: 'main',
      RASTRO_LANG: 'en',
      RUNNER_TEMP: work,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: output,
      ...env,
    },
  });
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return { res, summary: read(summary), outputs: read(output), work };
}

describe.skipIf(!bundled || !hasTools || process.platform === 'win32')('GitHub Action', () => {
  it('impact.sh: resumo do job, saídas, testes e relatório a partir de uma análise só', () => {
    const root = featureRepo();
    // o actions/checkout v6+ guarda as credenciais num includeIf do .git/config
    execFileSync('git', ['config', `includeIf.gitdir:${root}/.git.path`, '/tmp/x'], { cwd: root });
    const { res, summary, outputs } = runImpact(root, {
      RASTRO_LINK_BASE: 'https://github.com/org/repo/blob/abc',
      RASTRO_EXCLUDE: 'dist\nbuild',
    });
    expect(res.status, res.stderr).toBe(0);

    expect(summary.startsWith('<!-- rastro-impact -->')).toBe(true);
    expect(summary).toContain('`sum`');
    expect(summary).toContain('(https://github.com/org/repo/blob/abc/src/math.ts#L1)');
    expect(summary).toContain('`test/math.test.ts`');

    expect(outputs).toMatch(/^changed=1$/m);
    expect(outputs).toMatch(/^impacted=[1-9]\d*$/m);
    expect(outputs).toMatch(/tests<<(RASTRO_[0-9a-f]+)\n\.\/test\/math\.test\.ts\n\1\n/);
    const dir = /^dir=(.+)$/m.exec(outputs)![1]!;
    expect(fs.existsSync(path.join(dir, 'rastro-report.html'))).toBe(true);
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'impact.json'), 'utf8')) as {
      baseLabel: string;
    };
    expect(json.baseLabel).toBe('main');
  });

  it('impact.sh: subpasta com espaço entra codificada nos links', () => {
    const root = featureRepo('my app');
    const { res, summary } = runImpact(root, {
      RASTRO_PATH: './my app/',
      RASTRO_LINK_BASE: 'https://github.com/org/repo/blob/abc/',
    });
    expect(res.status, res.stderr).toBe(0);
    expect(summary).toContain('(https://github.com/org/repo/blob/abc/my%20app/src/math.ts#L1)');
  });

  it('impact.sh: git sem a base falha com o erro do git, não com uma mensagem enganosa', () => {
    const root = featureRepo();
    const { res } = runImpact(root, { RASTRO_BASE: 'does-not-exist' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('could not read the git changes');
    expect(res.stderr).not.toContain('has no git changes');
  });

  it('impact.sh recusa base ausente ou que parece opção', () => {
    const root = featureRepo();
    for (const base of ['', '--upload-pack=touch PWNED']) {
      const { res } = runImpact(root, { RASTRO_BASE: base, GITHUB_BASE_REF: '' });
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('::error');
    }
    expect(fs.existsSync(path.join(root, 'PWNED'))).toBe(false);
  });

  it('impact.sh: o .npmrc e o NODE_OPTIONS do pull request não alcançam o Rastro', () => {
    const root = featureRepo();
    // o que um pull request malicioso poderia trazer
    fs.writeFileSync(
      path.join(root, '.npmrc'),
      'node-options=--require=./evil.cjs\nregistry=https://evil.example/\n',
    );
    fs.writeFileSync(
      path.join(root, 'evil.cjs'),
      `require('fs').writeFileSync(${JSON.stringify(path.join(root, 'PWNED'))}, 'x');\n`,
    );
    // npm falso: registra pasta e argumentos e "instala" um bin que chama o rastro local
    const fakes = tmp('rastro-action-npm-');
    const log = path.join(fakes, 'npm.log');
    fs.writeFileSync(
      path.join(fakes, 'npm'),
      [
        '#!/usr/bin/env bash',
        `{ pwd; printf '%s\\n' "$@"; echo "NODE_OPTIONS=\${NODE_OPTIONS:-}"; } > "${log}"`,
        'prefix=""; while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && prefix="$2"; shift; done',
        'mkdir -p "$prefix/node_modules/@mongeai/rastro/bin"',
        `printf '%s\\n' "import('${bin.replace(/\\/g, '/')}');" > "$prefix/node_modules/@mongeai/rastro/bin/rastro.js"`,
      ].join('\n'),
      { mode: 0o755 },
    );
    const { res } = runImpact(root, {
      RASTRO_BIN: '',
      PATH: `${fakes}:${process.env.PATH}`,
      NODE_OPTIONS: `--require=${path.join(root, 'evil.cjs')}`,
      RASTRO_VERSION: '0.2.0',
    });
    expect(res.status, res.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, 'PWNED'))).toBe(false);
    const npm = fs.readFileSync(log, 'utf8').split('\n');
    expect(npm[0]).not.toBe(root); // instalado fora da pasta do pull request
    expect(npm).toContain('--registry=https://registry.npmjs.org/');
    expect(npm).toContain('--ignore-scripts');
    expect(npm).toContain('@mongeai/rastro@0.2.0');
    expect(npm).toContain('NODE_OPTIONS=');
  });

  /** gh falso: aplica o --jq de verdade sobre comentários de exemplo; registra as chamadas. */
  function fakeGh(comments: unknown[], { failWrites = false } = {}) {
    const work = tmp('rastro-action-gh-');
    const log = path.join(work, 'gh.log');
    fs.writeFileSync(path.join(work, 'comments.json'), JSON.stringify(comments));
    fs.writeFileSync(
      path.join(work, 'gh'),
      [
        '#!/usr/bin/env bash',
        `printf '%s\\n' "$*" >> "${log}"`,
        'if [ "$2" = "--paginate" ]; then',
        `  jq -r "$5" "${path.join(work, 'comments.json')}"; exit 0`,
        'fi',
        `for a in "$@"; do case "$a" in body=@*) cat "\${a#body=@}" > "${log}.body";; esac; done`,
        failWrites ? 'echo "HTTP 403" >&2; exit 1' : 'exit 0',
      ].join('\n'),
      { mode: 0o755 },
    );
    const event = path.join(work, 'event.json');
    fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 42 } }));
    const markdown = path.join(work, 'impact.md');
    fs.writeFileSync(markdown, '<!-- rastro-impact -->\n### impact\n');
    const run = (env: Record<string, string> = {}) =>
      spawnSync('bash', [commentSh], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${work}:${process.env.PATH}`,
          GITHUB_REPOSITORY: 'org/repo',
          GITHUB_EVENT_PATH: event,
          RASTRO_MARKDOWN: markdown,
          RASTRO_REPORT_URL: 'https://github.com/org/repo/actions/runs/1/artifacts/2',
          RASTRO_LANG: 'en',
          ...env,
        },
      });
    const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n');
    const body = () => fs.readFileSync(`${log}.body`, 'utf8');
    return { run, calls, body };
  }

  it('comment.sh cria o comentário na primeira vez, com o link do relatório', () => {
    const gh = fakeGh([]);
    expect(gh.run().status).toBe(0);
    expect(
      gh.calls().some((c) => c.startsWith('api -X POST repos/org/repo/issues/42/comments')),
    ).toBe(true);
    expect(gh.body()).toContain('### impact');
    expect(gh.body()).toContain(
      '[download rastro-report](https://github.com/org/repo/actions/runs/1/artifacts/2)',
    );
  });

  it('comment.sh atualiza só o comentário do bot, nunca o de outra pessoa com o marcador', () => {
    const gh = fakeGh([
      { id: 1, user: { login: 'mallory' }, body: '<!-- rastro-impact -->nothing affected' },
      { id: 777, user: { login: 'github-actions[bot]' }, body: '<!-- rastro-impact -->old' },
    ]);
    expect(gh.run().status).toBe(0);
    const calls = gh.calls();
    expect(calls.some((c) => c.startsWith('api -X PATCH repos/org/repo/issues/comments/777'))).toBe(
      true,
    );
    expect(calls.some((c) => c.includes('comments/1 '))).toBe(false);

    const only = fakeGh([{ id: 1, user: { login: 'mallory' }, body: '<!-- rastro-impact -->x' }]);
    expect(only.run().status).toBe(0);
    expect(only.calls().some((c) => c.startsWith('api -X POST'))).toBe(true);
  });

  it('comment.sh: sem permissão (PR de fork) avisa e não falha; autor inválido é recusado', () => {
    const gh = fakeGh([], { failWrites: true });
    const res = gh.run();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('::warning');
    expect(gh.run({ RASTRO_AUTHOR: 'x") or true | ("' }).status).toBe(1);
  });

  it('comment.sh não faz nada fora de um pull request', () => {
    const work = tmp('rastro-action-gh-');
    const event = path.join(work, 'event.json');
    fs.writeFileSync(event, JSON.stringify({ ref: 'refs/heads/main' }));
    const res = spawnSync('bash', [commentSh], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_PATH: event, RASTRO_MARKDOWN: '/dev/null' },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('not a pull request');
  });
});
