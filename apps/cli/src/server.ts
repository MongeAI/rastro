import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { TeiaGraph } from '@teia/core';

export interface ServerOptions {
  graph: TeiaGraph;
  /** Pasta com a interface já compilada (index.html + assets). */
  webRoot: string;
  /** Porta preferida; se ocupada, tenta as seguintes. 0 = qualquer porta livre. */
  port?: number;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const LOOPBACK = '127.0.0.1';
const MAX_SOURCE_BYTES = 2_000_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

/**
 * Servidor local da interface. Só escuta em 127.0.0.1, só aceita GET/HEAD e recusa
 * requisições com Host diferente de localhost (proteção contra DNS rebinding).
 * O endpoint de código-fonte só entrega arquivos que fazem parte do grafo analisado.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { graph } = options;
  const webRoot = path.resolve(options.webRoot);
  const graphJson = JSON.stringify(graph);
  const analyzedFiles = new Set(
    graph.nodes
      .filter((n) => n.kind === 'file' && n.meta?.analyzed !== false)
      .map((n) => n.qualifiedName ?? n.name),
  );
  let port = 0;

  const server = http.createServer((req, res) => {
    const send = (
      status: number,
      body: string | Buffer,
      type = 'text/plain; charset=utf-8',
      extra: Record<string, string> = {},
    ) => {
      res.writeHead(status, {
        ...SECURITY_HEADERS,
        'Content-Type': type,
        'Cache-Control': 'no-store',
        ...extra,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const host = (req.headers.host ?? '').toLowerCase();
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (!allowedHosts.includes(host)) return send(403, 'Host não permitido.');
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return send(405, 'Método não permitido.', undefined, { Allow: 'GET, HEAD' });

    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${host}`);
    } catch {
      return send(400, 'URL inválida.');
    }

    if (url.pathname === '/api/health') return send(200, '{"ok":true}', MIME['.json']);
    if (url.pathname === '/api/graph') return send(200, graphJson, MIME['.json']);
    if (url.pathname === '/api/source') {
      const file = url.searchParams.get('file') ?? '';
      const result = readSource(graph.project.root, file, analyzedFiles);
      return send(result.status, JSON.stringify(result.body), MIME['.json']);
    }
    if (url.pathname.startsWith('/api/'))
      return send(404, '{"error":"Endpoint desconhecido."}', MIME['.json']);

    // arquivos estáticos da interface, com fallback para index.html
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return send(400, 'Caminho inválido.');
    }
    const requested = path.resolve(webRoot, `.${decoded}`);
    const insideWeb = requested === webRoot || requested.startsWith(`${webRoot}${path.sep}`);
    const file =
      insideWeb && fs.existsSync(requested) && fs.statSync(requested).isFile()
        ? requested
        : path.join(webRoot, 'index.html');
    if (!fs.existsSync(file)) {
      return send(
        500,
        'A interface web não foi encontrada. Rode "npm run build" na raiz do repositório do Teia.',
      );
    }
    const ext = path.extname(file);
    const cache = file.includes(`${path.sep}assets${path.sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-store';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': cache,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });

  port = await listen(server, options.port ?? 4321);
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function listen(server: http.Server, preferred: number): Promise<number> {
  const attempts = preferred === 0 ? 1 : 20;
  for (let i = 0; i < attempts; i++) {
    const candidate = preferred === 0 ? 0 : preferred + i;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, LOOPBACK);
      });
      return (server.address() as AddressInfo).port;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`Nenhuma porta livre entre ${preferred} e ${preferred + attempts - 1}.`);
}

interface SourceResult {
  status: number;
  body: { file?: string; content?: string; lines?: number; error?: string };
}

/** Lê um arquivo do projeto, apenas se ele estiver no grafo e dentro da raiz. */
export function readSource(root: string, file: string, allowed: ReadonlySet<string>): SourceResult {
  if (!file || !allowed.has(file))
    return { status: 404, body: { error: 'Arquivo fora do grafo analisado.' } };
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { status: 404, body: { error: 'A raiz do projeto não existe nesta máquina.' } };
  }
  const absolute = path.resolve(realRoot, file);
  if (!absolute.startsWith(`${realRoot}${path.sep}`))
    return { status: 403, body: { error: 'Caminho fora do projeto.' } };
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile()) return { status: 404, body: { error: 'Não é um arquivo regular.' } };
    // uma pasta intermediária pode ter virado link simbólico depois da análise
    if (!fs.realpathSync(absolute).startsWith(`${realRoot}${path.sep}`)) {
      return { status: 403, body: { error: 'Caminho fora do projeto.' } };
    }
    if (stat.size > MAX_SOURCE_BYTES)
      return { status: 413, body: { error: 'Arquivo grande demais para exibir.' } };
    const content = fs.readFileSync(absolute, 'utf8');
    return { status: 200, body: { file, content, lines: content.split(/\r?\n/).length } };
  } catch {
    return {
      status: 404,
      body: { error: 'Arquivo não encontrado (o projeto mudou desde a análise?).' },
    };
  }
}
