import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { RastroGraph } from '@rastro/core';

export interface ServerOptions {
  graph: RastroGraph;
  /** Pasta com a interface já compilada (index.html + assets). */
  webRoot: string;
  /** Porta preferida; se ocupada, tenta as seguintes. 0 = qualquer porta livre. */
  port?: number;
  /**
   * Token de acesso exigido pela API. Se omitido, um token aleatório é gerado.
   * Passe `false` para desligar (apenas em testes).
   */
  token?: string | false;
}

export interface RunningServer {
  /** Endereço para abrir no navegador (inclui o token de acesso). */
  url: string;
  /** Endereço sem token. */
  baseUrl: string;
  port: number;
  token: string | null;
  close(): Promise<void>;
}

const LOOPBACK = '127.0.0.1';
const MAX_SOURCE_BYTES = 2_000_000;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

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
 * Servidor local da interface.
 * - Só escuta em 127.0.0.1 e só aceita GET/HEAD.
 * - Recusa Host diferente de localhost (proteção contra DNS rebinding).
 * - A API exige um token aleatório por execução: o navegador recebe o token pela URL aberta
 *   pela CLI, que vira um cookie HttpOnly. Outros processos/usuários da máquina não leem o código.
 * - O endpoint de código-fonte só entrega arquivos JS/TS que fazem parte do grafo.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { graph } = options;
  const webRoot = path.resolve(options.webRoot);
  const graphJson = JSON.stringify(graph);
  const token =
    options.token === false
      ? null
      : (options.token ?? crypto.randomBytes(24).toString('base64url'));
  const analyzedFiles = new Set(
    graph.nodes
      .filter((n) => n.kind === 'file' && n.meta?.analyzed !== false)
      .map((n) => n.qualifiedName ?? n.name),
  );
  let port = 0;
  const cookieName = () => `rastro_${port}`;

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
    const json = (status: number, body: unknown) =>
      send(status, JSON.stringify(body), MIME['.json']);

    try {
      const host = (req.headers.host ?? '').toLowerCase();
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
      if (!allowedHosts.includes(host)) {
        return send(
          403,
          `Host não permitido: "${host}". Abra http://127.0.0.1:${port}/ diretamente nesta máquina ` +
            '(o Rastro recusa outros nomes de host para se proteger de DNS rebinding).',
        );
      }
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return send(405, 'Método não permitido.', undefined, { Allow: 'GET, HEAD' });

      let url: URL;
      try {
        url = new URL(req.url ?? '/', `http://${host}`);
      } catch {
        return send(400, 'URL inválida.');
      }

      // troca o token da URL por um cookie e limpa a barra de endereço
      const given = url.searchParams.get('token');
      if (token && given !== null) {
        if (!safeEqual(given, token))
          return send(401, 'Token inválido. Use o endereço exibido no terminal.');
        url.searchParams.delete('token');
        return send(302, '', undefined, {
          Location: url.pathname + url.search,
          'Set-Cookie': `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }

      if (url.pathname.startsWith('/api/')) {
        if (token && !safeEqual(readCookie(req.headers.cookie, cookieName()) ?? '', token)) {
          return json(401, {
            error: 'Acesso negado. Abra o endereço completo (com o token) exibido no terminal.',
          });
        }
        if (url.pathname === '/api/health') return json(200, { ok: true });
        if (url.pathname === '/api/graph') return send(200, graphJson, MIME['.json']);
        if (url.pathname === '/api/source') {
          const result = readSource(
            graph.project.root,
            url.searchParams.get('file') ?? '',
            analyzedFiles,
          );
          return json(result.status, result.body);
        }
        return json(404, { error: 'Endpoint desconhecido.' });
      }

      // arquivos estáticos da interface, com fallback para index.html
      let decoded: string;
      try {
        decoded = decodeURIComponent(url.pathname);
      } catch {
        return send(400, 'Caminho inválido.');
      }
      const requested = path.resolve(webRoot, `.${decoded}`);
      const insideWeb = requested.startsWith(`${webRoot}${path.sep}`);
      const isFile = (p: string) => {
        try {
          return fs.statSync(p).isFile();
        } catch {
          return false;
        }
      };
      const file = insideWeb && isFile(requested) ? requested : path.join(webRoot, 'index.html');
      if (!isFile(file)) {
        return send(
          500,
          'A interface web não foi encontrada. Rode "npm run build" na raiz do repositório do Rastro.',
        );
      }
      const relative = path.relative(webRoot, file);
      const cache = relative.startsWith(`assets${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-store';
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': cache,
      });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) send(500, 'Erro interno do servidor do Rastro.');
      else res.destroy();
    }
  });

  port = await listen(server, options.port ?? 4321);
  const baseUrl = `http://127.0.0.1:${port}/`;
  return {
    url: token ? `${baseUrl}?token=${token}` : baseUrl,
    baseUrl,
    port,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

const MAX_PORT = 65535;

async function listen(server: http.Server, preferred: number): Promise<number> {
  const attempts = preferred === 0 ? 1 : 20;
  let lastError: NodeJS.ErrnoException | undefined;
  for (let i = 0; i < attempts; i++) {
    const candidate = preferred === 0 ? 0 : preferred + i;
    if (candidate > MAX_PORT) break;
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
      lastError = err as NodeJS.ErrnoException;
      // EACCES: porta privilegiada ou reservada (comum no Windows); tenta a próxima
      if (lastError.code !== 'EADDRINUSE' && lastError.code !== 'EACCES') throw err;
    }
  }
  const reason =
    lastError?.code === 'EACCES' ? 'sem permissão para usar essas portas' : 'todas estão ocupadas';
  throw new Error(
    `Não foi possível abrir a interface a partir da porta ${preferred} (${reason}). ` +
      'Tente outra com --port, por exemplo --port 5050.',
  );
}

interface SourceResult {
  status: number;
  body: { file?: string; content?: string; lines?: number; error?: string };
}

/**
 * Lê um arquivo do projeto, apenas se ele estiver no grafo, for JS/TS e ficar dentro da raiz
 * (também depois de resolver links simbólicos). Protege inclusive contra um JSON adulterado
 * aberto com `rastro serve`, que poderia listar caminhos como `../../.ssh/id_rsa`.
 */
export function readSource(root: string, file: string, allowed: ReadonlySet<string>): SourceResult {
  const notInGraph = { status: 404, body: { error: 'Arquivo fora do grafo analisado.' } };
  if (!file || !allowed.has(file)) return notInGraph;
  if (path.isAbsolute(file) || /^[a-z]:/i.test(file) || file.split(/[\\/]/).includes('..'))
    return { status: 403, body: { error: 'Caminho fora do projeto.' } };
  if (!SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()))
    return {
      status: 403,
      body: { error: 'Só arquivos JavaScript/TypeScript podem ser exibidos.' },
    };
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { status: 404, body: { error: 'A raiz do projeto não existe nesta máquina.' } };
  }
  const prefix = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
  const absolute = path.resolve(realRoot, file);
  if (!absolute.startsWith(prefix))
    return { status: 403, body: { error: 'Caminho fora do projeto.' } };
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile()) return { status: 404, body: { error: 'Não é um arquivo regular.' } };
    // uma pasta intermediária pode ter virado link simbólico depois da análise
    if (!fs.realpathSync(absolute).startsWith(prefix)) {
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
