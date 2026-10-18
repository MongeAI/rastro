/**
 * Scripts da GitHub Action (scripts/action/*.sh) rodando como no Actions: um repositório git com
 * uma branch de feature, o `rastro` local no lugar do npx e um `gh` falso que registra as chamadas.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const bin = path.join(repo, 'apps', 'cli', 'bin', 'rastro.js');
const bundled = fs.existsSync(path.join(repo, 'apps', 'cli', 'dist', 'rastro.mjs'));
const hasTools = ['bash', 'jq', 'git'].every(
  (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0,
);
const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function featureRepo(): string {
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
  git('checkout', '-q', '-b', 'feature');
  write('src/math.ts', 'export function sum(a: number, b: number) {\n  return b + a;\n}\n');
  git('commit', '-qam', 'change sum');
  return root;
}

describe.skipIf(!bundled || !hasTools || process.platform === 'win32')('GitHub Action', () => {
  it('impact.sh: resumo do job, saídas, testes e relatório a partir de uma análise só', () => {
    const root = featureRepo();
    const work = tmp('rastro-action-out-');
    const summary = path.join(work, 'summary.md');
    const output = path.join(work, 'output.txt');
    const res = spawnSync('bash', [path.join(repo, 'scripts', 'action', 'impact.sh')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        RASTRO_BIN: `${process.execPath} ${bin}`,
        RASTRO_PATH: '.',
        RASTRO_BASE: 'main',
        RASTRO_LANG: 'en',
        RASTRO_LINK: 'https://github.com/org/repo/blob/abc',
        RASTRO_EXCLUDE: 'dist\nbuild',
        RUNNER_TEMP: work,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_OUTPUT: output,
      },
    });
    expect(res.status, res.stderr).toBe(0);

    const md = fs.readFileSync(summary, 'utf8');
    expect(md.startsWith('<!-- rastro-impact -->')).toBe(true);
    expect(md).toContain('`sum`');
    expect(md).toContain('(https://github.com/org/repo/blob/abc/src/math.ts#L1)');
    expect(md).toContain('`test/math.test.ts`');

    const outputs = fs.readFileSync(output, 'utf8');
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

  it('impact.sh recusa base ausente ou que parece opção', () => {
    const root = featureRepo();
    for (const base of ['', '--upload-pack=touch PWNED']) {
      const res = spawnSync('bash', [path.join(repo, 'scripts', 'action', 'impact.sh')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          RASTRO_BIN: `${process.execPath} ${bin}`,
          RASTRO_BASE: base,
          GITHUB_BASE_REF: '',
          RUNNER_TEMP: tmp('rastro-action-out-'),
        },
      });
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('::error');
    }
    expect(fs.existsSync(path.join(root, 'PWNED'))).toBe(false);
  });

  it('comment.sh cria o comentário na primeira vez e atualiza o mesmo depois', () => {
    const work = tmp('rastro-action-gh-');
    const log = path.join(work, 'gh.log');
    const existing = path.join(work, 'existing');
    // gh falso: registra os argumentos; a listagem devolve o id em "existing", se houver
    fs.writeFileSync(
      path.join(work, 'gh'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nfor a in "$@"; do case "$a" in body=@*) cat "\${a#body=@}" >> "${log}.body";; esac; done\nif [ "$2" = "--paginate" ] && [ -f "${existing}" ]; then cat "${existing}"; fi\n`,
      { mode: 0o755 },
    );
    const event = path.join(work, 'event.json');
    fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 42 } }));
    const markdown = path.join(work, 'impact.md');
    fs.writeFileSync(markdown, '<!-- rastro-impact -->\n### impact\n');
    const run = () =>
      spawnSync('bash', [path.join(repo, 'scripts', 'action', 'comment.sh')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${work}:${process.env.PATH}`,
          GITHUB_REPOSITORY: 'org/repo',
          GITHUB_EVENT_PATH: event,
          RASTRO_MARKDOWN: markdown,
          RASTRO_REPORT_URL: 'https://github.com/org/repo/actions/runs/1/artifacts/2',
          RASTRO_LANG: 'en',
        },
      });

    expect(run().status).toBe(0);
    fs.writeFileSync(existing, '777\n');
    expect(run().status).toBe(0);

    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toContain(
      'api --paginate repos/org/repo/issues/42/comments --jq .[] | select(.body | startswith("<!-- rastro-impact -->")) | .id',
    );
    expect(calls.some((c) => c.startsWith('api -X POST repos/org/repo/issues/42/comments'))).toBe(
      true,
    );
    expect(calls.some((c) => c.startsWith('api -X PATCH repos/org/repo/issues/comments/777'))).toBe(
      true,
    );
    const body = fs.readFileSync(`${log}.body`, 'utf8');
    expect(body).toContain('### impact');
    expect(body).toContain(
      '[download rastro-report](https://github.com/org/repo/actions/runs/1/artifacts/2)',
    );
  });

  it('comment.sh não faz nada fora de um pull request', () => {
    const work = tmp('rastro-action-gh-');
    const event = path.join(work, 'event.json');
    fs.writeFileSync(event, JSON.stringify({ ref: 'refs/heads/main' }));
    const res = spawnSync('bash', [path.join(repo, 'scripts', 'action', 'comment.sh')], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_PATH: event, RASTRO_MARKDOWN: '/dev/null' },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('not a pull request');
  });
});
