import path from 'node:path';
import type { DiscoverOptions } from '@rastro/analyzer';
import { RASTRO_VERSION } from '@rastro/core';
import { t } from './i18n.js';
import { LiveProject, workerBackend } from './mcp-project.js';
import { checkArgs, TOOLS, ToolError, type ToolDefinition } from './mcp-tools.js';
import { dim, safeText, tildify, yellow } from './term.js';

/**
 * `rastro mcp`: servidor do Model Context Protocol sobre stdio (JSON-RPC 2.0, uma mensagem
 * por linha), escrito à mão para não trazer dependências. Só expõe ferramentas de leitura do
 * grafo; nada é executado, nada sai da máquina.
 *
 * Regras do protocolo seguidas aqui:
 * - toda requisição (com `id`) recebe exatamente uma resposta (menos as que o cliente
 *   cancela enquanto rodam); notificações, nenhuma;
 * - `initialize` responde na hora (a primeira análise começa depois, em segundo plano);
 * - erros de execução de uma ferramenta voltam como resultado com `isError` (o agente lê e
 *   corrige); erros do protocolo (método desconhecido, parâmetros inválidos) como erro JSON-RPC;
 * - nada além de mensagens do protocolo vai para o stdout (avisos vão para o stderr).
 */

/**
 * Versões com o handshake `initialize` (revisões "legadas" na nomenclatura de 2026), da mais
 * nova para a mais antiga.
 */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/**
 * Versões "modernas" (2026-07-28 em diante): sem handshake, cada requisição traz a versão e
 * as capacidades do cliente em `_meta`. O servidor atende as duas eras no mesmo processo: um
 * `initialize` escolhe a legada; uma requisição com `_meta` de versão, a moderna.
 */
export const MODERN_VERSIONS = ['2026-07-28'] as const;

/** Maior linha aceita (as requisições de ferramentas têm poucos KB). */
export const MAX_LINE_BYTES = 1024 * 1024;

export const ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** `UnsupportedProtocolVersionError` (2026-07-28). */
  unsupportedVersion: -32022,
} as const;

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';

/** Por quanto tempo o cliente pode guardar a lista de ferramentas (fixa nesta versão). */
const LIST_TTL_MS = 3_600_000;

const SERVER_INFO = { name: 'rastro', title: 'Rastro', version: RASTRO_VERSION };

export const INSTRUCTIONS = `Rastro is a static code graph of this JavaScript/TypeScript project, built with the TypeScript compiler: functions, classes, methods, files, folders, HTTP routes (Express, Fastify, Hono, NestJS, Next.js) and external packages, connected by calls, imports, exports and inheritance. Every relationship carries evidence: the file:line (and line of code) where it appears.

Prefer Rastro over grep for structural questions: "who calls X?", "what does X call?", "what breaks if I change X?", "how does A reach B?", "which routes and tests do my changes affect?". Grep is still better for literal text, comments and non-JS/TS files.

Typical flow: rastro_overview to get oriented; rastro_search to find an entity; rastro_entity for its details (source: true adds the code); rastro_references for callers/callees/importers with evidence; rastro_impact before changing code (targets) or before committing (git changes, or since: "main"); rastro_path for chains between two entities; rastro_routes for HTTP endpoints; rastro_check for the project's architecture rules (rastro.rules.json) — run it with changes: true before finishing a change, and fix new violations instead of working around them.

Semantics: PROVEN = resolved by the type checker or an explicit framework rule, always with file:line evidence. POSSIBLE = an unresolved reference (call through an interface or abstract method, callback, dynamic call) with candidate targets; the real target is only known at runtime, so never present it as fact. Rastro never guesses: no proven relationship does not mean no use (reflection, string-based dispatch, dependency injection, code outside the analyzed folder).

Targets: an id such as fn:src/math.ts#sum (ids are stable within this session), a name or qualified name (UserService.create), a file path (src/math.ts), a folder (src/services) or path:line — every file:line shown in results can be passed back as a target. Paths are relative to the project root. Long lists are paginated: "N shown of M" tells you to raise \`limit\` or pass \`offset\`.`;

const FRESH_WATCHING =
  'Files are re-analyzed automatically after edits, so answers reflect the code on disk.';
const FRESH_NOT_WATCHING =
  'File watching is OFF (--no-watch): answers reflect the code as it was when the server started; restart the server to see edits.';

/** Instruções para o cliente: o que diz sobre a atualização depende de observar arquivos. */
export function instructionsFor(watching: boolean): string {
  return `${INSTRUCTIONS} ${watching ? FRESH_WATCHING : FRESH_NOT_WATCHING}`;
}

type Id = string | number;

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

type Response =
  | { jsonrpc: '2.0'; id: Id | null; result: unknown }
  | { jsonrpc: '2.0'; id: Id | null; error: JsonRpcError };

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Ids válidos no MCP: texto ou número (nunca `null`). */
const isId = (v: unknown): v is Id =>
  typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

export interface McpServerOptions {
  project: LiveProject;
  trustGitConfig?: boolean;
  /** `--rules <arquivo>` (caminho absoluto). */
  rulesFile?: string;
  tools?: ToolDefinition[];
  /** Erros inesperados (stderr). */
  log?: (message: string) => void;
}

export class McpServer {
  private readonly tools: ToolDefinition[];
  private readonly byName: Map<string, ToolDefinition>;
  /** Requisições em andamento, e as que o cliente cancelou (não recebem resposta). */
  private readonly running = new Set<Id>();
  private readonly cancelled = new Set<Id>();

  constructor(private readonly options: McpServerOptions) {
    this.tools = options.tools ?? TOOLS;
    this.byName = new Map(this.tools.map((t) => [t.name, t]));
  }

  /**
   * Trata uma linha recebida. Devolve a resposta (objeto ou lista, para lotes) ou `undefined`
   * quando não há o que responder (notificações, requisições canceladas).
   */
  async handleLine(line: string): Promise<Response | Response[] | undefined> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return errorResponse(null, ERROR.parse, 'Parse error: the line is not valid JSON');
    }
    if (Array.isArray(message)) {
      // lotes (JSON-RPC 2.0; o MCP 2025-03-26 os permitia): cada item, respostas juntas
      if (!message.length)
        return errorResponse(null, ERROR.invalidRequest, 'Invalid Request: empty batch');
      const replies = await Promise.all(message.map((m) => this.handleMessage(m)));
      const list = replies.filter((r): r is Response => r !== undefined);
      return list.length ? list : undefined;
    }
    return this.handleMessage(message);
  }

  private async handleMessage(message: unknown): Promise<Response | undefined> {
    if (!isObject(message) || message.jsonrpc !== '2.0')
      return errorResponse(
        isObject(message) && isId(message.id) ? message.id : null,
        ERROR.invalidRequest,
        'Invalid Request: expected a JSON-RPC 2.0 object',
      );
    // resposta do cliente (este servidor não faz requisições): nada a fazer
    if (message.method === undefined && ('result' in message || 'error' in message))
      return undefined;
    if (typeof message.method !== 'string')
      return errorResponse(
        isId(message.id) ? message.id : null,
        ERROR.invalidRequest,
        'Invalid Request: "method" must be a string',
      );
    const hasId = 'id' in message;
    if (hasId && !isId(message.id))
      return errorResponse(
        null,
        ERROR.invalidRequest,
        'Invalid Request: "id" must be a string or a number',
      );
    if (message.params !== undefined && !isObject(message.params)) {
      return hasId
        ? errorResponse(
            message.id as Id,
            ERROR.invalidParams,
            'Invalid params: "params" must be an object',
          )
        : undefined;
    }
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (!hasId) {
      this.handleNotification(message.method, params);
      return undefined;
    }
    const id = message.id as Id;
    const method = message.method;
    this.running.add(id);
    let response: Response;
    try {
      response = { jsonrpc: '2.0', id, result: await this.handleRequest(method, params) };
    } catch (err) {
      if (err instanceof RpcError) response = errorResponse(id, err.code, err.message, err.data);
      else {
        this.options.log?.(`internal error in ${method}: ${(err as Error).stack ?? String(err)}`);
        response = errorResponse(id, ERROR.internal, `Internal error: ${(err as Error).message}`);
      }
    } finally {
      this.running.delete(id);
    }
    // cancelada pelo cliente enquanto rodava: nenhuma resposta (o initialize nunca é cancelado)
    if (this.cancelled.delete(id) && method !== 'initialize') return undefined;
    return response;
  }

  /**
   * Notificações não têm resposta. `notifications/initialized`: o cliente está pronto (a
   * análise já começou no `initialize`). `notifications/cancelled`: a requisição em andamento
   * fica sem resposta, como pede o protocolo (as ferramentas só leem; não há o que desfazer).
   * As desconhecidas, e cancelamentos de requisições que já terminaram, são ignorados.
   */
  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method !== 'notifications/cancelled') return;
    const id = params.requestId;
    if (isId(id) && this.running.has(id)) this.cancelled.add(id);
  }

  private async handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'initialize') return this.initialize(params);
    const meta = isObject(params._meta) ? params._meta : undefined;
    const modern = meta?.[META_VERSION];
    if (!meta || modern === undefined) return this.dispatch(method, params, false);

    // era moderna: versão e capacidades do cliente em cada requisição
    if (typeof modern !== 'string' || !(MODERN_VERSIONS as readonly string[]).includes(modern))
      // só as versões que valem neste estilo de requisição (com a versão em `_meta`); as
      // legadas existem, mas pedem o handshake `initialize`
      throw new RpcError(
        ERROR.unsupportedVersion,
        (PROTOCOL_VERSIONS as readonly string[]).includes(String(modern))
          ? `Unsupported protocol version: ${String(modern)} is supported only through the initialize handshake`
          : 'Unsupported protocol version',
        { supported: [...MODERN_VERSIONS], requested: modern },
      );
    if (!isObject(meta[META_CAPABILITIES]))
      throw new RpcError(
        ERROR.invalidParams,
        `Invalid params: _meta["${META_CAPABILITIES}"] is required`,
      );
    const result = await this.dispatch(method, params, true);
    return {
      resultType: 'complete',
      ...(result as Record<string, unknown>),
      _meta: { [META_SERVER]: SERVER_INFO },
    };
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
    modern: boolean,
  ): Promise<unknown> {
    switch (method) {
      case 'ping':
        return {};
      case 'server/discover':
        // sem `_meta` de versão, é a sondagem de um cliente das duas eras falando com um
        // servidor legado: o erro comum faz o cliente voltar ao initialize
        if (!modern) break;
        return {
          supportedVersions: [...MODERN_VERSIONS, ...PROTOCOL_VERSIONS],
          capabilities: { tools: {} },
          instructions: instructionsFor(this.options.project.watching),
          ttlMs: LIST_TTL_MS,
          cacheScope: 'public',
        };
      case 'tools/list':
        // a lista de ferramentas é pedida logo depois de conectar: a análise já pode começar
        this.warmUp();
        return {
          tools: this.tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: {
              title: t.title,
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          })),
          ...(modern ? { ttlMs: LIST_TTL_MS, cacheScope: 'public' } : {}),
        };
      case 'tools/call':
        return this.callTool(params);
    }
    throw new RpcError(ERROR.methodNotFound, `Method not found: ${method.slice(0, 100)}`);
  }

  /** Começa a primeira análise logo depois da resposta atual sair. */
  private warmUp(): void {
    setImmediate(() => this.options.project.start());
  }

  private initialize(params: Record<string, unknown>): unknown {
    const requested = params.protocolVersion;
    if (typeof requested !== 'string')
      throw new RpcError(ERROR.invalidParams, 'Invalid params: "protocolVersion" must be a string');
    // a versão pedida, se suportada; senão a mais nova que temos (o cliente decide se segue)
    const version = (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : PROTOCOL_VERSIONS[0];
    this.warmUp();
    return {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: instructionsFor(this.options.project.watching),
    };
  }

  private async callTool(params: Record<string, unknown>): Promise<unknown> {
    const name = params.name;
    if (typeof name !== 'string')
      throw new RpcError(ERROR.invalidParams, 'Invalid params: "name" must be a string');
    const tool = this.byName.get(name);
    if (!tool) throw new RpcError(ERROR.invalidParams, `Unknown tool: ${name.slice(0, 100)}`);
    const args = params.arguments ?? {};
    if (!isObject(args))
      throw new RpcError(ERROR.invalidParams, 'Invalid params: "arguments" must be an object');
    // argumentos fora do esquema: erro da ferramenta, para o agente corrigir e tentar de novo
    const problems = checkArgs(tool.inputSchema, args);
    if (problems.length)
      return toolError(`Invalid arguments for ${tool.name}: ${problems.join('; ')}.`);
    const project = this.options.project;
    // sem initialize nem tools/list antes: a análise começa aqui
    project.start();
    let snapshot;
    try {
      snapshot = await project.current();
    } catch (err) {
      return toolError(
        `The analysis of the project failed: ${(err as Error).message}. The next call will retry.`,
      );
    }
    try {
      const text = tool.run(args, {
        snapshot,
        trustGitConfig: !!this.options.trustGitConfig,
        watchMode: project.watchMode,
        ...(this.options.rulesFile ? { rulesFile: this.options.rulesFile } : {}),
      });
      return { content: [{ type: 'text', text }], isError: false };
    } catch (err) {
      if (err instanceof ToolError) return toolError(err.message);
      this.options.log?.(`${tool.name} failed: ${(err as Error).stack ?? String(err)}`);
      return toolError(`Internal error in ${tool.name}: ${(err as Error).message}`);
    }
  }
}

function toolError(text: string) {
  return { content: [{ type: 'text', text }], isError: true };
}

function errorResponse(id: Id | null, code: number, message: string, data?: unknown): Response {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

export interface StdioOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  maxLineBytes?: number;
  /** Quanto esperar as requisições em andamento depois que a entrada fecha (padrão 2 s). */
  closeGraceMs?: number;
}

/**
 * Liga o servidor ao stdio: lê mensagens separadas por `\n` (aceita `\r\n`), protege contra
 * linhas enormes e escreve cada resposta numa linha. Termina (a promessa resolve) quando a
 * entrada fecha e as requisições em andamento foram respondidas.
 */
export function serveStdio(server: McpServer, options: StdioOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const maxBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  const inflight = new Set<Promise<void>>();
  let buffer = '';
  /** Descartando o resto de uma linha grande demais (até o próximo `\n`). */
  let discarding = false;

  const send = (reply: Response | Response[] | undefined) => {
    // JSON.stringify nunca gera quebras de linha cruas: uma mensagem por linha. U+2028/U+2029
    // são válidos crus num texto JSON, mas leitores que separam linhas por eles (ou tratam a
    // saída como JavaScript) quebrariam a mensagem: vão escapados
    if (reply !== undefined)
      output.write(
        `${JSON.stringify(reply)
          .replace(/\u2028/g, '\\u2028')
          .replace(/\u2029/g, '\\u2029')}\n`,
      );
  };
  const handle = (line: string) => {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!trimmed.trim()) return;
    const task = server
      .handleLine(trimmed)
      .then(send, (err: unknown) =>
        send(errorResponse(null, ERROR.internal, `Internal error: ${(err as Error).message}`)),
      );
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
  };
  const tooLarge = () =>
    send(errorResponse(null, ERROR.parse, `Parse error: message larger than ${maxBytes} bytes`));

  return new Promise<void>((resolve) => {
    (input as NodeJS.ReadStream).setEncoding?.('utf8');
    input.on('data', (chunk: string | Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (discarding) {
          discarding = false;
          continue;
        }
        if (Buffer.byteLength(line) > maxBytes) tooLarge();
        else handle(line);
      }
      if (!discarding && Buffer.byteLength(buffer) > maxBytes) {
        // linha sem fim à vista: responde já e ignora o resto dela
        tooLarge();
        discarding = true;
        buffer = '';
      } else if (discarding) buffer = '';
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (!discarding && buffer.trim()) handle(buffer);
      buffer = '';
      // o cliente fechou a entrada: responde o que terminar logo, sem esperar uma análise longa
      const grace = setTimeout(resolve, options.closeGraceMs ?? 2000);
      grace.unref?.();
      void Promise.allSettled([...inflight]).then(() => {
        clearTimeout(grace);
        resolve();
      });
    };
    input.once('end', finish);
    input.once('close', finish);
  });
}

export interface RunMcpOptions {
  root: string;
  discover: DiscoverOptions;
  /** `--no-watch` desliga a observação de arquivos. */
  watch: boolean;
  trustGitConfig: boolean;
  /** `--rules <arquivo>`: as regras de arquitetura (padrão: `rastro.rules.json` na raiz). */
  rulesFile?: string;
}

/**
 * O comando `rastro mcp`: servidor no stdio até o cliente fechar a entrada. Avisos curtos no
 * stderr (os clientes mostram nos logs); o stdout é só do protocolo.
 */
export async function runMcp(options: RunMcpOptions): Promise<void> {
  const m = t().mcp;
  // o cliente pode fechar o stderr (pipe): escrever nele não pode derrubar o servidor
  process.stderr.on('error', () => {});
  const say = (text: string) => {
    try {
      process.stderr.write(`${dim('rastro mcp:')} ${safeText(text)}\n`);
    } catch {
      // stderr fechado: os avisos são só informativos
    }
  };
  // nada de console.log no stdout (de dependências, inclusive): tudo vai para o stderr
  for (const method of ['log', 'info', 'debug', 'warn'] as const)
    console[method] = (...args: unknown[]) => console.error(...args);

  const project = new LiveProject(options.root, workerBackend(options.root, options.discover), {
    watch: options.watch,
    discover: options.discover,
    log: (event) => {
      if (event.type === 'analyzed') say(m.analyzed(event.ms, event.files, event.sequence));
      else if (event.type === 'failed')
        say(`${yellow(t().warningPrefix)} ${m.failed(event.message)}`);
      else if (event.type === 'watch-fallback')
        say(
          `${yellow(t().warningPrefix)} ${t().watch.fallback(event.reason)}` +
            (event.limit ? ` ${t().watch.limitHint}` : ''),
        );
    },
  });
  const server = new McpServer({
    project,
    trustGitConfig: options.trustGitConfig,
    ...(options.rulesFile ? { rulesFile: path.resolve(options.rulesFile) } : {}),
    log: (text) => say(text),
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    project.close();
    // espera o stdout esvaziar (no Windows, a escrita em pipes é assíncrona)
    process.stdout.write('', () => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  // o cliente foi embora no meio de uma resposta: encerra em silêncio
  process.stdout.on('error', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  say(m.serving(tildify(path.resolve(options.root))));
  if (process.stdin.isTTY) say(m.ttyHint);
  await serveStdio(server);
  stop();
}
