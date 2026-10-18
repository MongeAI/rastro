import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/** `rastro mcp` de verdade: a CLI empacotada num processo, falando JSON-RPC pelo stdio. */

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const bin = path.join(repo, 'apps', 'cli', 'bin', 'rastro.js');
const bundled = fs.existsSync(path.join(repo, 'apps', 'cli', 'dist', 'rastro.mjs'));
const fixture = (name: string) => path.join(repo, 'fixtures', name);
const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Message {
  jsonrpc: string;
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class Client {
  readonly child: ChildProcess;
  /** Tudo o que saiu no stdout, cru (para conferir que só há mensagens do protocolo). */
  stdout = '';
  stderr = '';
  private nextId = 1;
  private readonly waiting = new Map<number, (m: Message) => void>();
  readonly exited: Promise<number | null>;

  constructor(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.child = spawn(process.execPath, [bin, 'mcp', ...args, '--lang', 'en'], {
      cwd: options.cwd ?? repo,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let pending = '';
    this.child.stdout!.on('data', (chunk: Buffer) => {
      this.stdout += chunk.toString();
      pending += chunk.toString();
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        const message = JSON.parse(line) as Message;
        if (typeof message.id === 'number') this.waiting.get(message.id)?.(message);
      }
    });
    this.child.stderr!.on('data', (chunk: Buffer) => (this.stderr += chunk.toString()));
    this.exited = new Promise((resolve) => this.child.on('exit', (code) => resolve(code)));
  }

  request(method: string, params?: unknown): Promise<Message> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sem resposta para ${method}`)), 60_000);
      this.waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  async initialize(): Promise<Message> {
    const reply = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'teste', version: '1' },
    });
    this.notify('notifications/initialized');
    return reply;
  }

  async call(name: string, args: Record<string, unknown> = {}) {
    const reply = await this.request('tools/call', { name, arguments: args });
    const result = reply.result as { content: Array<{ text: string }>; isError: boolean };
    return { text: result.content[0]!.text, isError: result.isError };
  }

  async close(): Promise<number | null> {
    this.child.stdin!.end();
    return this.exited;
  }
}

let clients: Client[] = [];
const start = (...args: ConstructorParameters<typeof Client>) => {
  const client = new Client(...args);
  clients.push(client);
  return client;
};
afterEach(() => {
  for (const c of clients) if (c.child.exitCode === null) c.child.kill();
  clients = [];
});

/** Projeto com git: math.ts mudou; app.ts e um teste dependem dele. */
function gitProject(): { root: string; git: (...args: string[]) => string } {
  const root = tmp('rastro-mcp-git-');
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
      { cwd: root, encoding: 'utf8', stdio: 'pipe' },
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
  return { root, git };
}

describe.skipIf(!bundled)('rastro mcp (CLI empacotada)', () => {
  it('sessão completa: initialize na hora, todas as ferramentas, só JSON-RPC no stdout', async () => {
    const client = start([fixture('express-api')]);
    const before = performance.now();
    const init = await client.initialize();
    const initMs = performance.now() - before;
    expect(init.result!.protocolVersion).toBe('2025-06-18');
    expect(init.result!.serverInfo).toMatchObject({ name: 'rastro' });
    // inclui subir o Node e carregar a CLI; a análise fica para depois
    expect(initMs).toBeLessThan(5000);
    // tools/list e ping respondem mesmo com a primeira análise em andamento (worker thread)
    const list = await client.request('tools/list');
    expect((list.result!.tools as unknown[]).length).toBe(7);
    expect((await client.request('ping')).result).toEqual({});

    const calls: Array<[string, Record<string, unknown>, string]> = [
      ['rastro_overview', {}, '# express-api — Rastro code graph'],
      ['rastro_search', { query: 'user' }, '`getUser` function · src/handlers/users.js:7'],
      ['rastro_entity', { target: 'getUser', source: true }, '7  function getUser(req, res) {'],
      [
        'rastro_references',
        { target: 'find' },
        '`getUser` function · src/handlers/users.js:7 calls `find`',
      ],
      ['rastro_impact', { targets: ['src/db.js'] }, '## HTTP routes involved (3)'],
      ['rastro_path', { from: 'GET /users/:id', to: 'find' }, '1 proven path'],
      ['rastro_routes', {}, '# HTTP routes: 4 of 4'],
    ];
    const results = await Promise.all(calls.map(([name, args]) => client.call(name, args)));
    results.forEach((r, i) => {
      expect(r.isError, calls[i]![0]).toBe(false);
      expect(r.text, calls[i]![0]).toContain(calls[i]![2]);
    });
    expect(await client.close()).toBe(0);
    // cada linha do stdout é uma resposta JSON-RPC a uma requisição (nada de logs)
    const lines = client.stdout.split('\n');
    expect(lines.pop()).toBe('');
    const ids = lines.map((l) => {
      const m = JSON.parse(l) as Message;
      expect(m.jsonrpc).toBe('2.0');
      expect('result' in m || 'error' in m).toBe(true);
      return m.id;
    });
    expect(ids).toHaveLength(3 + calls.length);
    expect(new Set(ids).size).toBe(ids.length);
    // o stderr tem avisos curtos, no idioma pedido
    expect(client.stderr).toContain('rastro mcp: MCP server for');
    expect(client.stderr).toMatch(/analysis ready in \d+ ms · 3 files/);
  });

  it('a entrada fechada encerra o processo, mesmo no meio da primeira análise', async () => {
    const client = start([fixture('nest-api')]);
    await client.initialize();
    const started = Date.now();
    expect(await client.close()).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('ao vivo: um arquivo editado aparece na próxima chamada (e com --no-watch, não)', async () => {
    const root = tmp('rastro-mcp-live-');
    fs.cpSync(fixture('express-api'), root, { recursive: true });
    const live = start([root]);
    await live.initialize();
    const before = await live.call('rastro_references', { target: 'fn:src/db.js#all' });
    expect(before.text).toContain('## Incoming — proven (1)');
    const frozenRoot = tmp('rastro-mcp-frozen-');
    fs.cpSync(fixture('express-api'), frozenRoot, { recursive: true });
    const frozen = start([frozenRoot, '--no-watch']);
    await frozen.initialize();
    await frozen.call('rastro_overview');

    const caller =
      "const db = require('./db');\n\nfunction report() {\n  return db.all();\n}\n\nmodule.exports = { report };\n";
    fs.writeFileSync(path.join(root, 'src', 'report.js'), caller);
    fs.writeFileSync(path.join(frozenRoot, 'src', 'report.js'), caller);
    await pause(300); // o evento do sistema de arquivos chega em milissegundos
    const after = await live.call('rastro_references', { target: 'fn:src/db.js#all' });
    expect(after.text).toContain('## Incoming — proven (2)');
    expect(after.text).toContain(
      '`report` function · src/report.js:3 calls `all` — src/report.js:4 `return db.all();`',
    );
    expect((await live.call('rastro_overview')).text).toContain('_Analysis #2:');

    const stale = await frozen.call('rastro_references', { target: 'fn:src/db.js#all' });
    expect(stale.text).toContain('## Incoming — proven (1)');
    expect((await frozen.call('rastro_overview')).text).toContain(
      'not watching files (--no-watch)',
    );
    expect(live.stderr).toMatch(/re-analyzed in \d+ ms · 4 files/);
  });

  it('impacto das mudanças do git: sem commit, desde uma referência e fora de um repositório', async () => {
    const { root, git } = gitProject();
    fs.writeFileSync(
      path.join(root, 'src', 'math.ts'),
      'export function sum(a: number, b: number) {\n  return b + a;\n}\n',
    );
    const client = start([root]);
    await client.initialize();
    const local = await client.call('rastro_impact', {});
    expect(local.isError).toBe(false);
    expect(local.text).toContain(
      '# Impact of uncommitted changes (vs HEAD, including untracked files)',
    );
    expect(local.text).toContain(
      'Summary: 1 changed file · 1 changed entity · 2 could be affected · 0 HTTP routes · 1 test file',
    );
    expect(local.text).toContain('- `sum` function · src/math.ts:1');
    expect(local.text).toContain(
      '- [d1] `total` function · src/app.ts:3 — calls `sum` at src/app.ts:4 `return sum(1, 2);`',
    );
    expect(local.text).toContain('## Test files to run (1)\n- `test/math.test.ts`');

    git('checkout', '-q', '-b', 'feature');
    git('commit', '-q', '-am', 'troca a ordem');
    const since = await client.call('rastro_impact', { since: 'main' });
    expect(since.text).toContain('# Impact of changes since `main`');
    expect(since.text).toContain('- `sum` function · src/math.ts:1');
    const clean = await client.call('rastro_impact', { changes: true });
    expect(clean.text).toContain('No changed files.');
    const badRef = await client.call('rastro_impact', { since: 'nao-existe' });
    expect(badRef.isError).toBe(true);
    expect(badRef.text).toBe('Could not read the git changes: unknown reference: nao-existe');
    const dash = await client.call('rastro_impact', { since: '--output=/tmp/x' });
    expect(dash.isError).toBe(true);
    expect(dash.text).toContain('invalid reference');
    await client.close();

    const plain = tmp('rastro-mcp-plain-');
    fs.cpSync(fixture('express-api'), plain, { recursive: true });
    const outside = start([plain]);
    await outside.initialize();
    const notRepo = await outside.call('rastro_impact', {});
    expect(notRepo.isError).toBe(true);
    expect(notRepo.text).toContain('not a git repository');
  });

  it('configuração arriscada do git: recusada, a menos que o servidor confie (--trust-git-config)', async () => {
    const { root, git } = gitProject();
    git('config', 'core.pager', 'echo pwned');
    const client = start([root]);
    await client.initialize();
    const refused = await client.call('rastro_impact', {});
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('core.pager');
    expect(refused.text).toContain('--trust-git-config');
    // os alvos não usam o git: continuam funcionando
    expect((await client.call('rastro_impact', { targets: ['sum'] })).isError).toBe(false);
    await client.close();
    const trusted = start([root, '--trust-git-config']);
    await trusted.initialize();
    const ok = await trusted.call('rastro_impact', {});
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain('No changed files.');
  });

  it('sem caminho: a pasta do projeto do Claude Code (CLAUDE_PROJECT_DIR), senão a atual', async () => {
    const elsewhere = tmp('rastro-mcp-cwd-');
    const viaEnv = start([], {
      cwd: elsewhere,
      env: { CLAUDE_PROJECT_DIR: fixture('express-api') },
    });
    await viaEnv.initialize();
    expect((await viaEnv.call('rastro_overview')).text).toContain('# express-api —');
    const viaCwd = start([], { cwd: fixture('oop'), env: { CLAUDE_PROJECT_DIR: '' } });
    await viaCwd.initialize();
    expect((await viaCwd.call('rastro_overview')).text).toContain('# oop —');
  });

  it('opções que não se aplicam falham antes de começar, sem nada no stdout', () => {
    const run = (args: string[]) =>
      spawnSync(process.execPath, [bin, ...args, '--lang', 'en'], { encoding: 'utf8', input: '' });
    const cases: Array<[string[], string]> = [
      [
        ['mcp', '.', '--watch'],
        'error: --watch does not apply to "mcp": it already watches the project',
      ],
      [
        ['mcp', '.', '--since', 'main'],
        'error: --since does not apply to "mcp": the agent asks for git changes on each call',
      ],
      [['mcp', '.', '--changes'], 'error: --changes does not apply to "mcp"'],
      [['mcp', '.', '-p', '4000'], 'error: --port does not apply to "mcp".'],
      [['mcp', '.', '--no-open'], 'error: --no-open does not apply to "mcp".'],
      [['mcp', '.', '-o', 'x.json'], 'error: --out does not apply to "mcp".'],
      [['mcp', '.', '--format', 'json'], 'error: --format only works with "rastro export".'],
      [['mcp', 'a', 'b'], 'error: unexpected argument: b'],
      [['mcp', '/nao/existe/mesmo'], 'error: directory not found: /nao/existe/mesmo'],
      [['analyze', '.', '--no-watch'], 'error: --no-watch only works with "rastro mcp".'],
    ];
    for (const [args, message] of cases) {
      const res = run(args);
      expect(res.status, args.join(' ')).toBe(1);
      expect(res.stderr, args.join(' ')).toContain(message);
      expect(res.stdout, args.join(' ')).toBe('');
    }
  });
});
