import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeProject } from '@teia/analyzer';
import { validateGraph, type TeiaGraph } from '@teia/core';
import { readSource, startServer, type RunningServer } from '../src/server.js';
import { defaultGraphPath, loadGraph, saveGraph } from '../src/storage.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = path.join(repo, 'fixtures', 'ts-basic');

/** GET cru, permitindo forjar o cabeçalho Host. */
function get(port: number, urlPath: string, host = `127.0.0.1:${port}`, method = 'GET') {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: urlPath, method, headers: { Host: host } },
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

let graph: TeiaGraph;
beforeAll(async () => {
  graph = await analyzeProject(fixture);
});

describe('armazenamento', () => {
  it('salva e lê o grafo sem perdas, fora do projeto analisado', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teia-store-'));
    process.env.TEIA_CACHE_DIR = dir;
    const file = defaultGraphPath(graph);
    expect(file.startsWith(dir)).toBe(true);
    expect(path.basename(file)).toMatch(/^ts-basic-[0-9a-f]{10}\.graph\.json$/);
    saveGraph(graph, file);
    expect(loadGraph(file)).toEqual(JSON.parse(JSON.stringify(graph)));
    delete process.env.TEIA_CACHE_DIR;
  });

  it('recusa JSON inválido ao carregar', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'teia-bad-')), 'bad.json');
    fs.writeFileSync(file, '{"schemaVersion":"0.1.0","nodes":[]}');
    expect(() => loadGraph(file)).toThrow(/Grafo inválido/);
  });
});

describe('servidor local', () => {
  let server: RunningServer;
  let webRoot: string;
  beforeAll(async () => {
    webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teia-web-'));
    fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Teia</title>');
    server = await startServer({ graph, webRoot, port: 0 });
  });
  afterAll(() => server.close());

  it('escuta apenas em 127.0.0.1', () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it('entrega o grafo e a interface', async () => {
    const res = await get(server.port, '/api/graph');
    expect(res.status).toBe(200);
    expect(validateGraph(JSON.parse(res.body)).valid).toBe(true);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    const page = await get(server.port, '/qualquer/rota');
    expect(page.body).toContain('<title>Teia</title>');
  });

  it('recusa Host desconhecido (DNS rebinding) e métodos de escrita', async () => {
    expect((await get(server.port, '/api/graph', 'evil.example:80')).status).toBe(403);
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
  it('bloqueia caminhos fora da raiz mesmo se estiverem na lista', () => {
    const res = readSource(fixture, '../outside.ts', new Set(['../outside.ts']));
    expect(res.status).toBe(403);
  });

  it('não segue pastas que viraram links simbólicos depois da análise', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teia-src-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'teia-secret-'));
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
    const g = JSON.parse(out) as TeiaGraph;
    expect(validateGraph(g).valid).toBe(true);
    expect(g.stats.files).toBe(9);
  });

  it('analyze -o salva e validate confirma', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'teia-cli-')), 'g.json');
    execFileSync(process.execPath, [cli, 'analyze', fixture, '-o', file], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const out = execFileSync(process.execPath, [cli, 'validate', file], { encoding: 'utf8' });
    expect(out).toMatch(/^válido/);
  });
});
