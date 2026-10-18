import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeProject } from '@rastro/analyzer';
import { validateGraph, type RastroGraph } from '@rastro/core';
import { readSource, startServer, type RunningServer } from '../src/server.js';
import { defaultGraphPath, loadGraph, saveGraph } from '../src/storage.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = path.join(repo, 'fixtures', 'ts-basic');

/** GET cru, permitindo forjar o cabeçalho Host. */
let cookie = '';

function get(port: number, urlPath: string, host = `127.0.0.1:${port}`, method = 'GET') {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: urlPath, method, headers: { Host: host, Cookie: cookie } },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        },
      );
      req.on('error', reject);
      req.end();
    },
  );
}

let graph: RastroGraph;
beforeAll(async () => {
  graph = await analyzeProject(fixture);
});

describe('armazenamento', () => {
  it('salva e lê o grafo sem perdas, fora do projeto analisado', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-store-'));
    process.env.RASTRO_CACHE_DIR = dir;
    const file = defaultGraphPath(graph);
    expect(file.startsWith(dir)).toBe(true);
    expect(path.basename(file)).toMatch(/^ts-basic-[0-9a-f]{10}\.graph\.json$/);
    saveGraph(graph, file);
    expect(loadGraph(file)).toEqual(JSON.parse(JSON.stringify(graph)));
    delete process.env.RASTRO_CACHE_DIR;
  });

  it('recusa JSON inválido ao carregar', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-bad-')), 'bad.json');
    fs.writeFileSync(file, '{"schemaVersion":"0.1.0","nodes":[]}');
    expect(() => loadGraph(file)).toThrow(/Grafo inválido/);
  });
});

describe('servidor local', () => {
  let server: RunningServer;
  let webRoot: string;
  beforeAll(async () => {
    webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-web-'));
    fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Rastro</title>');
    server = await startServer({ graph, webRoot, port: 0 });
  });
  afterAll(() => server.close());

  it('escuta apenas em 127.0.0.1 e gera um token por execução', () => {
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(server.token).toMatch(/^[\w-]{32}$/);
    expect(server.url).toBe(`${server.baseUrl}?token=${server.token}`);
  });

  it('exige o token para a API e o troca por um cookie HttpOnly', async () => {
    cookie = '';
    expect((await get(server.port, '/api/graph')).status).toBe(401);
    expect((await get(server.port, '/?token=errado')).status).toBe(401);
    const login = await get(server.port, `/?token=${server.token}`);
    expect(login.status).toBe(302);
    expect(login.headers.location).toBe('/');
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    cookie = setCookie.split(';')[0]!;
  });

  it('o redirecionamento do token nunca aponta para outro site', async () => {
    for (const p of ['/.//evil.com', '/a/..//evil.com', '//evil.com']) {
      const res = await get(server.port, `${p}?token=${server.token}`);
      expect(res.headers.location, p).toMatch(/^\/(?!\/)/);
    }
  });

  it('entrega o grafo e a interface', async () => {
    const res = await get(server.port, '/api/graph');
    expect(res.status).toBe(200);
    expect(validateGraph(JSON.parse(res.body)).valid).toBe(true);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    const page = await get(server.port, '/qualquer/rota');
    expect(page.body).toContain('<title>Rastro</title>');
  });

  it('recusa Host desconhecido (DNS rebinding) e métodos de escrita', async () => {
    const evil = await get(server.port, '/api/graph', 'evil.example:80');
    expect(evil.status).toBe(403);
    expect(evil.body).toContain(`127.0.0.1:${server.port}`);
    expect((await get(server.port, '/api/graph', undefined, 'POST')).status).toBe(405);
  });

  it('entrega código só de arquivos do grafo', async () => {
    const ok = await get(server.port, '/api/source?file=src/math.ts');
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).content).toContain('export function sum');
    for (const file of ['../../../etc/passwd', 'package.json', '/etc/passwd', 'dist/bundle.js']) {
      const res = await get(server.port, `/api/source?file=${encodeURIComponent(file)}`);
      expect(res.status, file).toBe(404);
    }
  });

  it('não sai da pasta da interface ao servir arquivos estáticos', async () => {
    const res = await get(server.port, '/..%2f..%2f..%2fetc%2fpasswd');
    expect(res.body).not.toContain('root:');
  });
});

describe('readSource', () => {
  it('não confia em caminhos absolutos ou extensões estranhas vindos de um JSON adulterado', () => {
    const evil = new Set(['/etc/passwd', 'a/../../x.ts', 'package.json']);
    expect(readSource(fixture, '/etc/passwd', evil).status).toBe(403);
    expect(readSource(fixture, 'a/../../x.ts', evil).status).toBe(403);
    expect(readSource(fixture, 'package.json', evil).status).toBe(403);
  });

  it('bloqueia caminhos fora da raiz mesmo se estiverem na lista', () => {
    const res = readSource(fixture, '../outside.ts', new Set(['../outside.ts']));
    expect(res.status).toBe(403);
  });

  it('não segue pastas que viraram links simbólicos depois da análise', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-src-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-secret-'));
    fs.writeFileSync(path.join(outside, 'a.ts'), 'segredo');
    fs.symlinkSync(outside, path.join(root, 'src'));
    expect(readSource(root, 'src/a.ts', new Set(['src/a.ts'])).status).toBe(403);
  });
});

const cli = path.join(repo, 'apps', 'cli', 'dist', 'index.js');
describe.skipIf(!fs.existsSync(cli))('CLI compilada (após npm run build)', () => {
  it('analyze --stdout gera JSON válido', () => {
    const out = execFileSync(process.execPath, [cli, 'analyze', fixture, '--stdout'], {
      encoding: 'utf8',
    });
    const g = JSON.parse(out) as RastroGraph;
    expect(validateGraph(g).valid).toBe(true);
    expect(g.stats.files).toBe(9);
  });

  it('analyze -o salva e validate confirma', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-cli-')), 'g.json');
    execFileSync(process.execPath, [cli, 'analyze', fixture, '-o', file], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const out = execFileSync(process.execPath, [cli, 'validate', file], { encoding: 'utf8' });
    expect(out).toMatch(/^válido/);
  });
});
