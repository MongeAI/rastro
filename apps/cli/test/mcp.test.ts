import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { afterAll, describe, expect, it } from 'vitest';
import type { RastroGraph } from '@rastro/core';
import {
  ERROR,
  INSTRUCTIONS,
  McpServer,
  MODERN_VERSIONS,
  PROTOCOL_VERSIONS,
  serveStdio,
} from '../src/mcp.js';
import { inlineBackend, LiveProject, type AnalysisBackend } from '../src/mcp-project.js';
import { checkArgs, gitBranch, TOOLS } from '../src/mcp-tools.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = (name: string) => path.join(repo, 'fixtures', name);
const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

type Reply = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

const projects: LiveProject[] = [];
afterAll(() => {
  for (const p of projects) p.close();
});

/** Servidor em memória sobre uma pasta (análise na própria thread, sem observar arquivos). */
function open(
  root: string,
  backend: AnalysisBackend = inlineBackend(root),
  trustGitConfig = false,
) {
  const project = new LiveProject(root, backend, { watch: false });
  projects.push(project);
  const server = new McpServer({ project, trustGitConfig });
  let nextId = 1;
  const send = async (message: unknown): Promise<Reply | Reply[] | undefined> =>
    (await server.handleLine(JSON.stringify(message))) as Reply | Reply[] | undefined;
  const request = async (method: string, params?: unknown): Promise<Reply> =>
    (await send({
      jsonrpc: '2.0',
      id: nextId++,
      method,
      ...(params === undefined ? {} : { params }),
    })) as Reply;
  /** Chama uma ferramenta e devolve o texto e se é erro. */
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await request('tools/call', { name, arguments: args });
    if (reply.error) throw new Error(`erro JSON-RPC: ${reply.error.message}`);
    const result = reply.result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    return { text: result.content[0]!.text, isError: result.isError };
  };
  return { server, project, send, request, call };
}

/** Uma sessão por fixture, compartilhada entre os testes (cada análise leva ~1 s). */
const sessions = new Map<string, ReturnType<typeof open>>();
const on = (name: string) => {
  if (!sessions.has(name)) sessions.set(name, open(fixture(name)));
  return sessions.get(name)!;
};

describe('protocolo: ciclo de vida', () => {
  it('initialize responde na hora, com a versão pedida quando suportada', async () => {
    let analyses = 0;
    const slow: AnalysisBackend = {
      analyze: () => {
        analyses++;
        return new Promise<RastroGraph>(() => {}); // nunca termina
      },
      close: () => {},
    };
    for (const version of PROTOCOL_VERSIONS) {
      const { request } = open(fixture('ts-basic'), slow);
      const started = performance.now();
      const reply = await request('initialize', {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: 'teste', version: '1' },
      });
      expect(performance.now() - started).toBeLessThan(50);
      expect(reply.result).toEqual({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'rastro', title: 'Rastro', version: expect.any(String) },
        instructions: INSTRUCTIONS,
      });
    }
    // a análise começa depois da resposta, em segundo plano
    expect(analyses).toBe(0);
    await new Promise((r) => setImmediate(r));
    expect(analyses).toBe(PROTOCOL_VERSIONS.length);
  });

  it('versão desconhecida: responde com a mais nova suportada', async () => {
    const { request } = open(fixture('ts-basic'));
    const reply = await request('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
    expect(reply.result!.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
    expect(PROTOCOL_VERSIONS).toEqual(
      expect.arrayContaining(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']),
    );
  });

  it('initialize sem protocolVersion é parâmetro inválido', async () => {
    const { request } = open(fixture('ts-basic'));
    const reply = await request('initialize', { capabilities: {} });
    expect(reply.error!.code).toBe(ERROR.invalidParams);
  });

  it('ping, notificações e respostas do cliente', async () => {
    const { request, send } = on('express-api');
    expect((await request('ping')).result).toEqual({});
    for (const method of [
      'notifications/initialized',
      'notifications/cancelled',
      'notifications/x',
    ])
      expect(await send({ jsonrpc: '2.0', method, params: { requestId: 1 } })).toBeUndefined();
    // resposta a uma requisição que o servidor nunca fez: ignorada
    expect(await send({ jsonrpc: '2.0', id: 9, result: {} })).toBeUndefined();
  });

  it('erros do JSON-RPC: parse, requisição inválida, método desconhecido, parâmetros', async () => {
    const { server, send, request } = on('express-api');
    const parse = (await server.handleLine('{"jsonrpc": "2.0", "id": 1, "method": ')) as Reply;
    expect(parse).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: expect.objectContaining({ code: ERROR.parse }),
    });
    const cases: Array<[unknown, number, string | number | null]> = [
      [{ id: 1, method: 'ping' }, ERROR.invalidRequest, 1],
      [{ jsonrpc: '1.0', id: 2, method: 'ping' }, ERROR.invalidRequest, 2],
      [{ jsonrpc: '2.0', id: 3, method: 7 }, ERROR.invalidRequest, 3],
      [{ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }, ERROR.invalidRequest, null],
      [{ jsonrpc: '2.0', id: null, method: 'ping' }, ERROR.invalidRequest, null],
      [42, ERROR.invalidRequest, null],
      [{ jsonrpc: '2.0', id: 4, method: 'ping', params: [1] }, ERROR.invalidParams, 4],
      [{ jsonrpc: '2.0', id: 5, method: 'resources/list' }, ERROR.methodNotFound, 5],
      // server/discover sem _meta de versão não é da era moderna: método desconhecido
      [{ jsonrpc: '2.0', id: 6, method: 'server/discover', params: {} }, ERROR.methodNotFound, 6],
    ];
    for (const [message, code, id] of cases) {
      const reply = (await send(message)) as Reply;
      expect(reply.id, JSON.stringify(message)).toBe(id);
      expect(reply.error?.code, JSON.stringify(message)).toBe(code);
      expect(reply.result).toBeUndefined();
    }
    expect((await request('tools/call', { arguments: {} })).error!.code).toBe(ERROR.invalidParams);
    expect((await request('tools/call', { name: 'nope' })).error).toEqual({
      code: ERROR.invalidParams,
      message: 'Unknown tool: nope',
    });
    expect(
      (await request('tools/call', { name: 'rastro_overview', arguments: [] })).error!.code,
    ).toBe(ERROR.invalidParams);
  });

  it('lotes: uma resposta por requisição, nenhuma para notificações', async () => {
    const { send } = on('express-api');
    const replies = (await send([
      { jsonrpc: '2.0', id: 'a', method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'b', method: 'nope' },
    ])) as Reply[];
    expect(replies.map((r) => r.id)).toEqual(['a', 'b']);
    expect(replies[1]!.error!.code).toBe(ERROR.methodNotFound);
    expect(await send([{ jsonrpc: '2.0', method: 'notifications/initialized' }])).toBeUndefined();
    expect(((await send([])) as Reply).error!.code).toBe(ERROR.invalidRequest);
  });
});

describe('protocolo: era moderna (2026-07-28, sem handshake)', () => {
  const meta = (extra: Record<string, unknown> = {}) => ({
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'teste', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
      ...extra,
    },
  });

  it('server/discover: versões das duas eras, capacidades, instruções e cache', async () => {
    const { request } = on('express-api');
    const reply = await request('server/discover', meta());
    expect(MODERN_VERSIONS).toContain('2026-07-28');
    expect(reply.result).toEqual({
      resultType: 'complete',
      supportedVersions: [...MODERN_VERSIONS, ...PROTOCOL_VERSIONS],
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
      ttlMs: expect.any(Number),
      cacheScope: 'public',
      _meta: { 'io.modelcontextprotocol/serverInfo': expect.objectContaining({ name: 'rastro' }) },
    });
  });

  it('tools/list e tools/call com resultType, cache da lista e serverInfo em _meta', async () => {
    const { request } = on('express-api');
    const list = (await request('tools/list', meta())).result!;
    expect(list.resultType).toBe('complete');
    expect(list.ttlMs).toBeGreaterThanOrEqual(0);
    expect(list.cacheScope).toBe('public');
    expect((list.tools as unknown[]).length).toBe(7);
    const call = (await request('tools/call', { name: 'rastro_routes', arguments: {}, ...meta() }))
      .result!;
    expect(call).toMatchObject({ resultType: 'complete', isError: false });
    expect((call._meta as Record<string, unknown>)['io.modelcontextprotocol/serverInfo']).toEqual(
      expect.objectContaining({ name: 'rastro' }),
    );
    // a era legada continua sem os campos novos
    expect((await request('tools/list')).result!.resultType).toBeUndefined();
  });

  it('versão desconhecida: UnsupportedProtocolVersionError com as versões suportadas', async () => {
    const { request } = on('express-api');
    const reply = await request(
      'tools/list',
      meta({ 'io.modelcontextprotocol/protocolVersion': '2099-01-01' }),
    );
    expect(reply.error).toEqual({
      code: -32022,
      message: 'Unsupported protocol version',
      data: { supported: [...MODERN_VERSIONS, ...PROTOCOL_VERSIONS], requested: '2099-01-01' },
    });
  });

  it('sem as capacidades do cliente: parâmetros inválidos', async () => {
    const { request } = on('express-api');
    const reply = await request('tools/list', {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    });
    expect(reply.error!.code).toBe(ERROR.invalidParams);
    expect(reply.error!.message).toContain('clientCapabilities');
  });
});

describe('protocolo: cancelamento', () => {
  it('requisição cancelada enquanto roda fica sem resposta; as outras seguem', async () => {
    const root = fixture('express-api');
    const real = inlineBackend(root);
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow: AnalysisBackend = {
      analyze: () => gate.then(() => real.analyze()),
      close: () => {},
    };
    const { send } = open(root, slow);
    const call = (id: number) =>
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'rastro_routes' } });
    const first = call(1);
    const second = call(2);
    expect(
      await send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }),
    ).toBeUndefined();
    // cancelamento de algo que não está rodando: ignorado
    await send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } });
    release();
    expect(await first).toBeUndefined();
    expect(((await second) as Reply).id).toBe(2);
    // o mesmo id depois do cancelamento é uma requisição nova, respondida normalmente
    expect(((await call(1)) as Reply).id).toBe(1);
  });
});

describe('protocolo: ferramentas', () => {
  it('tools/list: nomes, títulos, esquemas válidos e somente leitura', async () => {
    const { request } = on('express-api');
    const { tools } = (await request('tools/list')).result as {
      tools: Array<{
        name: string;
        title: string;
        description: string;
        inputSchema: {
          type: string;
          properties: Record<string, unknown>;
          required?: string[];
          additionalProperties: boolean;
        };
        annotations: Record<string, unknown>;
      }>;
    };
    expect(tools.map((t) => t.name)).toEqual([
      'rastro_overview',
      'rastro_search',
      'rastro_entity',
      'rastro_references',
      'rastro_impact',
      'rastro_path',
      'rastro_routes',
    ]);
    const ajv = new Ajv({ strict: true, strictRequired: true });
    for (const tool of tools) {
      expect(tool.name).toMatch(/^rastro_[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(80);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      for (const key of tool.inputSchema.required ?? [])
        expect(Object.keys(tool.inputSchema.properties)).toContain(key);
      // esquema JSON válido (o Ajv estrito recusa palavras-chave desconhecidas)
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
    }
  });

  it('o validador próprio concorda com o Ajv nos casos de borda', () => {
    const ajv = new Ajv({ strict: true });
    const samples: Record<string, unknown[]> = {
      rastro_search: [
        { query: 'x' },
        { query: '' },
        { query: 'x', limit: 0 },
        { query: 'x', limit: 2.5 },
        { query: 'x', kind: 'nope' },
        { query: 'x', extra: 1 },
        {},
      ],
      rastro_references: [
        { target: 'a', kinds: ['calls'] },
        { target: 'a', kinds: [] },
        { target: 'a', kinds: ['calls', 'calls'] },
        { target: 'a', depth: 4 },
        { target: 'a', direction: 'up' },
      ],
      rastro_impact: [
        {},
        { targets: ['a'] },
        { targets: [] },
        { targets: [1] },
        { since: 'main', changes: true },
      ],
      rastro_entity: [
        { target: 'a', source: true },
        { target: 'a', source: 'yes' },
      ],
    };
    for (const [name, list] of Object.entries(samples)) {
      const tool = TOOLS.find((t) => t.name === name)!;
      const validate = ajv.compile(tool.inputSchema);
      for (const args of list)
        expect(
          checkArgs(tool.inputSchema, args as Record<string, unknown>).length === 0,
          `${name} ${JSON.stringify(args)}`,
        ).toBe(validate(args));
    }
  });

  it('argumentos inválidos voltam como erro da ferramenta, com o que corrigir', async () => {
    const { call } = on('express-api');
    const bad = await call('rastro_search', { query: 'x', limit: 1000, bogus: true });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('Invalid arguments for rastro_search');
    expect(bad.text).toContain('unknown argument `bogus`');
    expect(bad.text).toContain('`limit` must be between 1 and 100 (got 1000)');
    const missing = await call('rastro_entity', {});
    expect(missing.text).toContain('`target` is required');
  });
});

describe('rastro_overview', () => {
  it('resume o projeto, as rotas, os pontos centrais e a atualização', async () => {
    const { text, isError } = await on('express-api').call('rastro_overview');
    expect(isError).toBe(false);
    expect(text).toContain('# express-api — Rastro code graph');
    expect(text).toContain('Files: 3 analyzed');
    expect(text).toContain(
      'Entities: 6 functions · 4 routes · 1 external package · 1 unresolved reference',
    );
    expect(text).toContain('HTTP routes: 4 (express)');
    expect(text).toContain('Most called: `all` function · src/db.js:3 (1 caller)');
    expect(text).toContain('Central files (most imported): `src/db.js` (1 importer)');
    expect(text).toMatch(/_Analysis #1: \d+s ago, took \d+ ms .* not watching files/);
  });

  it('código possivelmente sem uso, separado entre interno e exportado', async () => {
    const { text } = await on('oop').call('rastro_overview');
    expect(text).toContain('Possibly unused (no proven caller');
    expect(text).toMatch(/0 internal, \d+ exported \(may be public API\)/);
  });

  it('branch do git lida dos arquivos, sem rodar o git', () => {
    const root = tmp('rastro-branch-');
    expect(gitBranch(root)).toBe(gitBranch(path.dirname(root)) ?? undefined);
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
    fs.mkdirSync(path.join(root, 'sub'));
    expect(gitBranch(path.join(root, 'sub'))).toBe('feature/x');
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'a'.repeat(40));
    expect(gitBranch(root)).toBe('detached at aaaaaaa');
    // worktree: .git é um arquivo apontando para a pasta real
    const wt = tmp('rastro-wt-');
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(root, '.git')}\n`);
    expect(gitBranch(wt)).toBe('detached at aaaaaaa');
  });
});

describe('rastro_search', () => {
  it('ids, tipos e arquivo:linha; limite com aviso', async () => {
    const { call } = on('oop');
    const { text } = await call('rastro_search', { query: 'repo', limit: 3 });
    expect(text).toMatch(/^\d+ matches for `repo`, showing 3:/);
    expect(text).toContain('- `src/repository.ts` file · id `file:src/repository.ts`');
    expect(text).toMatch(/- … \d+ more \(raise `limit`\)/);
    const classes = await call('rastro_search', { query: 'repo', kind: 'class' });
    expect(classes.text).toContain(
      '`MemoryRepository` class · src/repository.ts:14 · id `class:src/repository.ts#MemoryRepository`',
    );
    expect(classes.text).not.toContain(' method ');
    const none = await call('rastro_search', { query: 'zzzz' });
    expect(none.isError).toBe(false);
    expect(none.text).toContain('No entity matches `zzzz`');
    expect(none.text).toContain('use grep');
  });
});

describe('resolução de nomes', () => {
  it('id, nome, nome qualificado, caminho, pasta, arquivo:linha e sufixo de id', async () => {
    const { call } = on('oop');
    const header = async (target: string) =>
      (await call('rastro_entity', { target })).text.split('\n')[0];
    expect(await header('method:src/animals.ts#Dog.sound')).toBe('# `Dog.sound` — method');
    expect(await header('Dog.sound')).toBe('# `Dog.sound` — method');
    expect(await header('dog.SOUND')).toBe('# `Dog.sound` — method');
    expect(await header('src/animals.ts')).toBe('# `src/animals.ts` — file');
    expect(await header('./src/animals.ts')).toBe('# `src/animals.ts` — file');
    expect(await header(path.join(fixture('oop'), 'src', 'animals.ts'))).toBe(
      '# `src/animals.ts` — file',
    );
    expect(await header('src/')).toBe('# `src/` — folder');
    expect(await header('src/animals.ts:21')).toBe('# `Dog.sound` — method');
    expect(await header('src/animals.ts:15')).toBe('# `Dog` — class');
    expect(await header('src/animals.ts:14')).toBe('# `src/animals.ts` — file');
    expect(await header('src/animals.ts#Dog.sound')).toBe('# `Dog.sound` — method');
  });

  it('ambíguo: lista os candidatos com id e pede para repetir', async () => {
    const { text, isError } = await on('oop').call('rastro_entity', { target: 'sound' });
    expect(isError).toBe(true);
    expect(text).toContain('`sound` is ambiguous: 3 entities match. Retry with one of these ids');
    expect(text).toContain(
      '- `method:src/animals.ts#Dog.sound` — `Dog.sound` method · src/animals.ts:20',
    );
  });

  it('não encontrado: sugere parecidos, inclusive com erro de digitação', async () => {
    const { call } = on('express-api');
    const typo = await call('rastro_entity', { target: 'getUsr' });
    expect(typo.isError).toBe(true);
    expect(typo.text).toContain('No entity matches `getUsr`.');
    expect(typo.text).toContain('`getUser` function · src/handlers/users.js:7');
    const partial = await call('rastro_references', { target: 'handlers/users' });
    expect(partial.text).toContain('`src/handlers/users.js` file');
  });

  it('nome que também é referência não resolvida: a entidade real primeiro', async () => {
    const { text } = await on('express-api').call('rastro_entity', { target: 'removeUser' });
    // só existe a referência não resolvida: ela mesma
    expect(text).toContain('— unresolved reference');
    expect(text).toContain('Why it is unresolved: no known declaration for this name');
    expect(text).toContain("src/server.js:12 `app.delete('/users/:id', removeUser);`");
  });
});

describe('rastro_entity', () => {
  it('função: local, cadeia, chamadores e chamados com evidência, código', async () => {
    const { text } = await on('express-api').call('rastro_entity', {
      target: 'getUser',
      source: true,
    });
    expect(text).toContain('id: `fn:src/handlers/users.js#getUser`');
    expect(text).toContain('Location: src/handlers/users.js:7-9');
    expect(text).toContain(
      'Inside: `src/` folder › `src/handlers/` folder › `src/handlers/users.js` file',
    );
    expect(text).toContain('Facts: exported · language js');
    expect(text).toContain(
      "- `GET /users/:id` route · src/server.js:8 calls (route handler) `getUser` — src/server.js:8 `app.get('/users/:id', getUser);`",
    );
    expect(text).toContain(
      '- `getUser` calls `find` function · src/db.js:4 — src/handlers/users.js:8',
    );
    expect(text).toContain(
      '```js\n7  function getUser(req, res) {\n8    res.json(db.find(req.params.id));\n9  }\n```',
    );
  });

  it('classe: membros, herança, implements como escrito e uso de fora', async () => {
    const { text } = await on('oop').call('rastro_entity', { target: 'Dog' });
    expect(text).toContain('## Members (4)');
    expect(text).toContain('- `fetch` method · src/animals.ts:28');
    expect(text).toContain(
      'Extends: `Animal` class · src/animals.ts:1 — src/animals.ts:15 `export class Dog extends Animal {`',
    );
    expect(text).toContain('Extended by: `Puppy` class · src/animals.ts:34');
    expect(text).toContain('Used from outside the class: 2 distinct callers');
    expect(text).not.toContain('No proven callers');
    const repoClass = await on('oop').call('rastro_entity', { target: 'MemoryRepository' });
    expect(repoClass.text).toContain(
      'Implements (as written; interfaces are not graph nodes): `Store`, `Named`',
    );
  });

  it('método só possível: chamadas por interface aparecem separadas, nunca como prova', async () => {
    const { text } = await on('oop').call('rastro_entity', { target: 'SqlRepository.save' });
    expect(text).not.toContain('## Called by (proven)');
    expect(text).toContain('No proven callers.');
    expect(text).toContain('## Possible (unproven) relationships');
    expect(text).toContain(
      "- may be called by `run` function · src/main.ts:4 via `repo.save` (1 of 2 possible implementations) — src/main.ts:5 `repo.save('x');`",
    );
  });

  it('arquivo, pasta, pacote e rota', async () => {
    const { call } = on('express-api');
    const file = (await call('rastro_entity', { target: 'src/server.js' })).text;
    expect(file).toContain('## External packages imported (1)\n`express` (require)');
    expect(file).toContain('## Imports (project files) (1)');
    expect(file).toContain('No project file imports this file');
    const folder = (await call('rastro_entity', { target: 'src/handlers' })).text;
    expect(folder).toContain('Files: 1 analyzed (recursively)');
    expect(folder).toContain(
      '## Depends on folders (1, derived from imports)\n- `src/` (1 import)',
    );
    const pkg = (await call('rastro_entity', { target: 'express' })).text;
    expect(pkg).toContain(
      'External to the project (declared in package.json). Its code is not analyzed.',
    );
    expect(pkg).toContain(
      "- `src/server.js` (require) — src/server.js:1 `const express = require('express');`",
    );
    const route = (await call('rastro_entity', { target: 'DELETE /users/:id' })).text;
    expect(route).toContain('`DELETE /users/:id` · framework express');
    expect(route).toContain('Handler: `removeUser` (unresolved: no known declaration');
  });

  it('rota com prefixo de montagem não comprovado (vários prefixos)', async () => {
    const { text } = await on('express-mounted').call('rastro_entity', { target: 'GET /stats' });
    expect(text).toContain('full path unknown: router mounted at `/api/admin`, `/backoffice`');
  });

  it('código limitado a 120 linhas', async () => {
    const root = tmp('rastro-mcp-long-');
    const body = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(root, 'big.ts'), `export function big() {\n${body}\n}\n`);
    const { text } = await open(root).call('rastro_entity', { target: 'big', source: true });
    expect(text).toContain('big.ts lines 1-120 of 1-202 (truncated to 120 lines');
    expect(text.split('\n').filter((l) => /^ *\d+ {2}/.test(l))).toHaveLength(120);
  });
});

describe('rastro_references', () => {
  it('quem chama, com evidência; profundidade segue só o comprovado', async () => {
    const { call } = on('express-api');
    const one = (await call('rastro_references', { target: 'fn:src/db.js#find' })).text;
    expect(one).toContain('## Incoming — proven (1)');
    // exports e contains são estruturais: só entram quando pedidos
    expect(one).not.toContain('exports');
    const exported = (
      await call('rastro_references', { target: 'fn:src/db.js#find', kinds: ['exports'] })
    ).text;
    expect(exported).toContain('- `src/db.js` file exports `find` — src/db.js:4');
    expect(one).toContain(
      '- `getUser` function · src/handlers/users.js:7 calls `find` — src/handlers/users.js:8',
    );
    const three = (
      await call('rastro_references', { target: 'fn:src/db.js#find', depth: 3, kinds: ['calls'] })
    ).text;
    expect(three).toContain('[d1] `getUser` function');
    expect(three).toContain(
      '[d2] `GET /users/:id` route · src/server.js:8 calls (route handler) `getUser`',
    );
    expect(three).not.toContain('imports');
  });

  it('saída: comprovado, externo e não resolvido com motivo', async () => {
    const { text } = await on('express-api').call('rastro_references', {
      target: 'DELETE /users/:id',
      direction: 'outgoing',
    });
    expect(text).toContain('## Outgoing — proven (0)\nnone');
    expect(text).toContain('## Outgoing — possible / unresolved (1; NOT proven)');
    expect(text).toContain(
      '- calls (route handler) `removeUser` — unresolved: no known declaration',
    );
  });

  it('possíveis: candidatos (saída) e quem talvez chame (entrada)', async () => {
    const { call } = on('oop');
    const out = (await call('rastro_references', { target: 'run', direction: 'outgoing' })).text;
    expect(out).toContain('## Outgoing — proven (4)');
    expect(out).toContain(
      '- calls `repo.save` — unresolved: call through a variable, parameter or interface',
    );
    expect(out).toContain(
      'possible targets (2, runtime decides): `MemoryRepository.save` method · src/repository.ts:17; `SqlRepository.save` method · src/repository.ts:42',
    );
    const both = (await call('rastro_references', { target: 'Dog.sound', direction: 'both' })).text;
    expect(both).toContain('## Incoming — proven (0)');
    expect(both).toContain('## Incoming — possible / unresolved (2; NOT proven)');
    expect(both).toContain(
      '`run` function · src/main.ts:4 may call it via `animal.sound` (1 of 3 possible implementations)',
    );
    expect(both).toContain('## Outgoing — proven (0)');
  });

  it('nada encontrado: explica que ausência não é prova', async () => {
    const { text } = await on('oop').call('rastro_references', { target: 'AppError' });
    expect(text).toContain('absence of use');
  });

  it('limite por lista', async () => {
    const { text } = await on('oop').call('rastro_references', {
      target: 'run',
      direction: 'outgoing',
      limit: 2,
    });
    expect(text).toContain('## Outgoing — proven (4)');
    expect(text).toContain('- … 2 more (raise `limit`)');
  });
});

describe('rastro_impact (alvos)', () => {
  it('quem depende, por distância, com a relação e a evidência; rotas', async () => {
    const { text } = await on('express-api').call('rastro_impact', { targets: ['src/db.js'] });
    expect(text).toContain('# Impact of changing `src/db.js`');
    expect(text).toContain('Summary: 8 entities could be affected · 3 HTTP routes · 0 test files');
    expect(text).toContain(
      '- [d1] `getUser` function · src/handlers/users.js:7 — calls `find` at src/handlers/users.js:8 `res.json(db.find(req.params.id));`',
    );
    expect(text).toContain(
      '- [d2] `GET /users` route · src/server.js:7 — calls (route handler) `listUsers`',
    );
    expect(text).toContain('## HTTP routes involved (3)');
  });

  it('chamadas por interface aparecem como possivelmente afetadas', async () => {
    const { text } = await on('oop').call('rastro_impact', { targets: ['SqlRepository'] });
    expect(text).toContain('## Possibly affected (1; NOT proven');
    expect(text).toContain(
      '`run` function · src/main.ts:4 via `repo.save` → maybe `SqlRepository.save`',
    );
  });

  it('vários alvos e erros claros', async () => {
    const { call } = on('oop');
    const many = await call('rastro_impact', { targets: ['Animal', 'src/legacy.js'] });
    expect(many.text).toContain('# Impact of changing `Animal`, `src/legacy.js`');
    const mixed = await call('rastro_impact', { targets: ['Animal'], since: 'main' });
    expect(mixed.isError).toBe(true);
    expect(mixed.text).toContain('Use either `targets` or the git mode');
    const ambiguous = await call('rastro_impact', { targets: ['sound'] });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain('is ambiguous');
  });
});

describe('rastro_path', () => {
  it('caminho comprovado, passo a passo com evidência', async () => {
    const { text } = await on('express-api').call('rastro_path', {
      from: 'GET /users/:id',
      to: 'src/db.js:4',
    });
    expect(text).toContain('1 proven path');
    expect(text).toContain(
      '1. `GET /users/:id` calls (route handler) `getUser` function · src/handlers/users.js:7',
    );
    expect(text).toContain(
      '2. `getUser` calls `find` function · src/db.js:4 — src/handlers/users.js:8',
    );
  });

  it('sentido inverso e caminho só possível, sempre marcados', async () => {
    const { call } = on('oop');
    const reversed = (await call('rastro_path', { from: 'Animal.move', to: 'run' })).text;
    expect(reversed).toContain('No proven path from `Animal.move` to `run`');
    expect(reversed).toContain('But `run` reaches `Animal.move` (opposite direction)');
    const possible = (await call('rastro_path', { from: 'run', to: 'Dog.sound' })).text;
    expect(possible).toContain('No proven path from `run` to `Dog.sound`');
    expect(possible).toContain('A POSSIBLE (unproven) path exists');
    expect(possible).toContain(
      '`run` calls `animal.sound` → maybe `Dog.sound` method · src/animals.ts:20 (POSSIBLE, 1 of 3)',
    );
    expect(possible).toContain(
      'At the file level, `src/main.ts` reaches `src/animals.ts` through imports',
    );
    const same = (await call('rastro_path', { from: 'run', to: 'src/main.ts:5' })).text;
    expect(same).toContain('Both arguments are the same entity.');
  });

  it('sem caminho nenhum: diz o que não é seguido', async () => {
    const { text } = await on('oop').call('rastro_path', {
      from: 'Cube.volume',
      to: 'SystemClock.now',
    });
    expect(text).toContain('No proven path');
    expect(text).toContain('a runtime link may still exist');
  });
});

describe('rastro_routes', () => {
  it('método, caminho completo ou o motivo de não saber, framework e handler', async () => {
    const { call } = on('express-mounted');
    const { text } = await call('rastro_routes');
    expect(text).toMatch(/^# HTTP routes: 7 of 7/);
    expect(text).toContain(
      '- `GET /api/users/:id` — express · defined at src/routes/users.js:6 · handler: `getUser` function',
    );
    expect(text).toContain('`GET /lost` — express · defined at src/routes/orphan.js:5');
    expect(text).toContain('full path unknown (no proven mount prefix; path as written in code)');
    const filtered = await call('rastro_routes', { filter: 'avatar', method: 'put' });
    expect(filtered.text).toMatch(/^# HTTP routes: 1 of 7 \(filter `avatar`, method PUT\)/);
    expect(filtered.text).toContain('handler: inline function (calls `saveAvatar`)');
  });

  it('NestJS e Next.js; filtro por framework; projeto sem rotas', async () => {
    const nest = (await on('nest-api').call('rastro_routes', { framework: 'nestjs' })).text;
    expect(nest).toContain(
      '- `GET /api/health` — nestjs · defined at src/health.controller.ts:5 · handler: `HealthController.check` method',
    );
    const next = (await on('next-app').call('rastro_routes', { filter: '/api/' })).text;
    expect(next).toContain('`ALL /api/hello` — next api');
    const none = (await on('oop').call('rastro_routes')).text;
    expect(none).toContain('No HTTP routes were found.');
  });
});

describe('análise: falhas, concorrência e atualização', () => {
  it('falha da análise vira isError; a chamada seguinte tenta de novo', async () => {
    const root = fixture('express-api');
    const real = inlineBackend(root);
    let attempts = 0;
    const flaky: AnalysisBackend = {
      analyze: () => (++attempts === 1 ? Promise.reject(new Error('disco sumiu')) : real.analyze()),
      close: () => {},
    };
    const { call } = open(root, flaky);
    const first = await call('rastro_overview');
    expect(first.isError).toBe(true);
    expect(first.text).toBe(
      'The analysis of the project failed: disco sumiu. The next call will retry.',
    );
    const second = await call('rastro_overview');
    expect(second.isError).toBe(false);
    expect(attempts).toBe(2);
  });

  it('chamadas simultâneas esperam a mesma análise', async () => {
    const root = fixture('express-api');
    const real = inlineBackend(root);
    let analyses = 0;
    const counting: AnalysisBackend = {
      analyze: () => (analyses++, real.analyze()),
      close: () => {},
    };
    const { call } = open(root, counting);
    const results = await Promise.all([
      call('rastro_overview'),
      call('rastro_routes'),
      call('rastro_search', { query: 'user' }),
    ]);
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(analyses).toBe(1);
    // nada mudou: nenhuma reanálise
    await call('rastro_routes');
    expect(analyses).toBe(1);
  });

  it('projeto marcado como alterado: a próxima chamada reanalisa e vê a mudança', async () => {
    const root = tmp('rastro-mcp-fresh-');
    fs.cpSync(fixture('express-api'), root, { recursive: true });
    const { call, project } = open(root);
    expect((await call('rastro_references', { target: 'fn:src/db.js#all' })).text).toContain(
      '## Incoming — proven (1)',
    );
    fs.appendFileSync(
      path.join(root, 'src', 'db.js'),
      '\nexports.count = () => exports.all().length;\n',
    );
    project.markDirty();
    const after = (await call('rastro_references', { target: 'fn:src/db.js#all' })).text;
    expect(after).toContain('## Incoming — proven (2)');
    expect(after).toContain('`count` function · src/db.js:10 calls `all`');
    expect((await call('rastro_overview')).text).toContain('_Analysis #2:');
  });
});

describe('stdio', () => {
  /** Servidor ligado a streams em memória; devolve as linhas escritas e a promessa do fim. */
  function wire(maxLineBytes?: number) {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (c: Buffer) => (written += c.toString()));
    const { server } = on('express-api');
    const done = serveStdio(server, { input, output, ...(maxLineBytes ? { maxLineBytes } : {}) });
    return {
      input,
      done,
      lines: () =>
        written
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Reply),
    };
  }

  it('uma resposta por linha; \\r\\n aceito; mensagens partidas entre pedaços', async () => {
    const { input, done, lines } = wire();
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\r\n');
    input.write('{"jsonrpc":"2.0",');
    input.write('"id":2,"method":"ping"}\n\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    // a última linha sem \n também vale, e o fim espera as respostas em andamento
    input.end('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"rastro_routes"}}');
    await done;
    const replies = lines();
    expect(replies.map((r) => r.id).sort()).toEqual([1, 2, 3]);
    expect(replies.every((r) => r.jsonrpc === '2.0')).toBe(true);
  });

  it('linhas enormes: erro de parse e o servidor continua', async () => {
    const { input, done, lines } = wire(1000);
    input.write(`{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":"${'a'.repeat(600)}`);
    input.write(`${'b'.repeat(600)}"}}\n`);
    input.write(`{"jsonrpc":"2.0","id":2,"method":"ping","params":{"x":"${'c'.repeat(2000)}"}}\n`);
    input.end('{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
    await done;
    const replies = lines();
    expect(replies.filter((r) => r.error?.code === ERROR.parse)).toHaveLength(2);
    expect(replies.filter((r) => r.error?.code === ERROR.parse).every((r) => r.id === null)).toBe(
      true,
    );
    expect(replies.find((r) => r.id === 3)?.result).toEqual({});
  });
});
