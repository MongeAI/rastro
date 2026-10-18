import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  analyzeProject,
  PROGRESS_CODES,
  progressMessage,
  type ProgressEvent,
} from '@rastro/analyzer';
import type { RastroGraph } from '@rastro/core';
import { compareGraphs } from '@rastro/graph';
import { formatDiff } from '../src/compare.js';
import {
  detectLang,
  getLang,
  langArg,
  localeLang,
  MESSAGES,
  parseLang,
  setLang,
  t,
} from '../src/i18n.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = path.join(repo, 'fixtures', 'ts-basic');

/** Exemplo de evento para cada código de progresso. */
const sampleEvent = (code: ProgressEvent['code'], count = 2): ProgressEvent =>
  code === 'discovered'
    ? { code, files: count }
    : code === 'done'
      ? { code, durationMs: count }
      : ({ code } as ProgressEvent);

/** Caminho de cada folha do catálogo, com o tipo (`string`/`function`). */
function shape(value: unknown, prefix = ''): string[] {
  if (typeof value === 'function') return [`${prefix}:function`];
  if (typeof value === 'string') return [`${prefix}:string`];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    shape(v, prefix ? `${prefix}.${k}` : k),
  );
}

/**
 * Todos os textos de um catálogo, chamando as funções com argumentos de exemplo (1 e 2,
 * para passar pelos singulares e plurais).
 */
function texts(value: unknown, key = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[key, value]];
  if (typeof value === 'function') {
    if (key === 'progress')
      return PROGRESS_CODES.flatMap((code) =>
        [1, 2].map((n): [string, string] => [
          `${key}.${code}`,
          (value as (e: ProgressEvent) => string)(sampleEvent(code, n)),
        ]),
      );
    const fn = value as (...args: unknown[]) => unknown;
    const out: Array<[string, string]> = [];
    for (const sample of [1, 2, 'x', ['x', 'y']]) {
      try {
        const result = fn(...Array.from({ length: Math.max(fn.length, 1) }, () => sample));
        if (typeof result === 'string') out.push([`${key}(${JSON.stringify(sample)})`, result]);
      } catch {
        // tipo de argumento errado para esta função: tenta o próximo exemplo
      }
    }
    expect(out.length, key).toBeGreaterThan(0);
    return out;
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    texts(v, key ? `${key}.${k}` : k),
  );
}

describe('catálogo de mensagens da CLI', () => {
  it('o inglês tem exatamente as mesmas chaves (e tipos) do português', () => {
    expect(shape(MESSAGES.en).sort()).toEqual(shape(MESSAGES.pt).sort());
  });

  it('nenhum texto em inglês tem cara de português', () => {
    const portuguese = /[ãõçáéíóúâêôà]|\b(não|nenhum|arquivos?|pasta|nível|relaç|para|você)\b/i;
    const found = texts(MESSAGES.en).filter(([, text]) => portuguese.test(text));
    expect(found).toEqual([]);
  });

  it('plurais corretos nos dois idiomas', () => {
    expect(MESSAGES.pt.summary.files(1)).toBe('1 arquivo analisado');
    expect(MESSAGES.pt.summary.files(3)).toBe('3 arquivos analisados');
    expect(MESSAGES.en.summary.files(1)).toBe('1 file analyzed');
    expect(MESSAGES.en.summary.files(3)).toBe('3 files analyzed');
    expect(MESSAGES.pt.summary.kinds.class(1)).toBe('1 classe');
    expect(MESSAGES.en.summary.kinds.class(2)).toBe('2 classes');
    expect(MESSAGES.en.summary.kinds.package(1)).toBe('1 external package');
    expect(MESSAGES.pt.summary.cycles(1)).toBe('1 ciclo de importação');
    expect(MESSAGES.pt.summary.cycles(2)).toBe('2 ciclos de importação');
    expect(MESSAGES.en.summary.cycles(1)).toBe('1 import cycle');
    expect(MESSAGES.pt.summary.warnings(1)).toBe('1 aviso:');
    expect(MESSAGES.en.summary.warnings(4)).toBe('4 warnings:');
    expect(MESSAGES.pt.summary.relations(1, 0, 2)).toBe(
      'relações: 1 resolvida · 0 externas · 2 não resolvidas',
    );
    expect(MESSAGES.pt.changes.counts(1, 2)).toBe('1 arquivo alterado · 2 entidades alteradas');
    expect(MESSAGES.en.changes.counts(2, 1)).toBe('2 changed files · 1 changed entity');
    expect(MESSAGES.pt.changes.impact(1)).toBe('impacto: 1 entidade depende do que mudou');
    expect(MESSAGES.pt.changes.impact(5)).toBe('impacto: 5 entidades dependem do que mudou');
    expect(MESSAGES.en.changes.impact(1)).toBe('impact: 1 entity depends on what changed');
    expect(MESSAGES.en.changes.impact(0)).toBe('impact: 0 entities depend on what changed');
    expect(MESSAGES.pt.validate.valid(1, 1, '1.0')).toBe('válido — 1 nó, 1 relação (schema 1.0)');
    expect(MESSAGES.en.validate.valid(2, 3, '1.0')).toBe(
      'valid — 2 nodes, 3 relationships (schema 1.0)',
    );
    expect(MESSAGES.en.progress({ code: 'discovered', files: 1 })).toBe('1 file found.');
    expect(MESSAGES.en.progress({ code: 'discovered', files: 7 })).toBe('7 files found.');
  });

  it('o português continua com os textos de antes', () => {
    const help = MESSAGES.pt.help('9.9.9');
    expect(help).toContain('Rastro 9.9.9 — siga o rastro do seu código');
    expect(help).toContain(
      '  rastro analyze <caminho>          só analisa e salva o grafo em JSON',
    );
    expect(help).toContain('--lang <en|pt>');
    expect(MESSAGES.en.help('9.9.9')).toContain('--lang <en|pt>');
    // o progresso em português é o texto padrão do próprio analisador
    for (const code of PROGRESS_CODES)
      expect(MESSAGES.pt.progress(sampleEvent(code))).toBe(progressMessage(sampleEvent(code)));
    expect(progressMessage({ code: 'discovering' })).toBe(
      'Procurando arquivos JavaScript/TypeScript...',
    );
    expect(MESSAGES.pt.git.riskyConfig('core.pager')).toContain('use --trust-git-config');
    expect(MESSAGES.en.git.riskyConfig('core.pager')).toContain('use --trust-git-config');
  });
});

describe('escolha do idioma', () => {
  afterEach(() => setLang('pt'));

  it('aceita en/pt com região e codificação; o resto é desconhecido', () => {
    expect(parseLang('pt')).toBe('pt');
    expect(parseLang('PT-br')).toBe('pt');
    expect(parseLang('pt_BR.UTF-8')).toBe('pt');
    expect(parseLang(' en ')).toBe('en');
    expect(parseLang('en_US')).toBe('en');
    expect(parseLang('es')).toBeUndefined();
    expect(parseLang('portugues')).toBeUndefined();
    expect(parseLang('')).toBeUndefined();
    expect(parseLang(undefined)).toBeUndefined();
  });

  it('locale do sistema: LC_ALL, depois LC_MESSAGES, depois LANG', () => {
    expect(localeLang({})).toBeUndefined();
    expect(localeLang({ LANG: 'pt_BR.UTF-8' })).toBe('pt');
    expect(localeLang({ LANG: 'de_DE.UTF-8' })).toBe('en');
    expect(localeLang({ LANG: 'C' })).toBe('en');
    expect(localeLang({ LANG: 'pt_BR.UTF-8', LC_MESSAGES: 'en_US.UTF-8' })).toBe('en');
    expect(localeLang({ LANG: 'en_US', LC_MESSAGES: 'pt_PT', LC_ALL: '' })).toBe('pt');
    expect(localeLang({ LANG: 'en_US', LC_MESSAGES: 'en_US', LC_ALL: 'pt_BR' })).toBe('pt');
  });

  it('precedência: --lang, RASTRO_LANG, locale; sem nada, inglês', () => {
    expect(detectLang({ env: {} })).toBe('en');
    expect(detectLang({ env: { LANG: 'pt_BR.UTF-8' } })).toBe('pt');
    expect(detectLang({ env: { LANG: 'pt_BR.UTF-8', RASTRO_LANG: 'en' } })).toBe('en');
    expect(detectLang({ env: { LC_ALL: 'en_US', RASTRO_LANG: 'pt' } })).toBe('pt');
    expect(detectLang({ flag: 'en', env: { RASTRO_LANG: 'pt', LANG: 'pt_BR' } })).toBe('en');
    expect(detectLang({ flag: 'pt', env: { RASTRO_LANG: 'en' } })).toBe('pt');
    // RASTRO_LANG inválido é ignorado e o locale decide
    expect(detectLang({ env: { RASTRO_LANG: 'klingon', LANG: 'pt_BR' } })).toBe('pt');
  });

  it('lê --lang da linha de comando nas duas formas, antes do resto', () => {
    expect(langArg(['.', '--lang', 'pt'])).toBe('pt');
    expect(langArg(['--lang=en', 'analyze', '.'])).toBe('en');
    expect(langArg(['--lang'])).toBe('');
    expect(langArg(['.', '--', '--lang', 'pt'])).toBeUndefined();
    expect(langArg(['.'])).toBeUndefined();
  });

  it('setLang troca o catálogo usado', () => {
    setLang('en');
    expect(getLang()).toBe('en');
    expect(t().errorPrefix).toBe('error:');
    setLang('pt');
    expect(t().errorPrefix).toBe('erro:');
  });
});

describe('formatDiff nos dois idiomas', () => {
  let before: RastroGraph;
  let after: RastroGraph;
  beforeAll(async () => {
    before = await analyzeProject(fixture);
    after = structuredClone(before);
    const removed = 'fn:src/math.ts#double';
    after.nodes = after.nodes.filter((n) => n.id !== removed);
    after.edges = after.edges.filter((e) => e.source !== removed && e.target !== removed);
  });

  it('português e inglês, com o mesmo conteúdo', () => {
    const diff = compareGraphs(before, after);
    const pt = formatDiff(diff, 'pt');
    expect(pt).toContain('Comparação');
    expect(pt).toContain('Números');
    expect(pt).toContain('Saíram (1)');
    expect(pt).toContain('Funções (1)');
    expect(pt).toContain('- src/math.ts#double');
    expect(pt).toContain('arquivos analisados');

    const en = formatDiff(diff, 'en');
    expect(en).toContain('Comparison');
    expect(en).toContain('Numbers');
    expect(en).toContain('Removed (1)');
    expect(en).toContain('Functions (1)');
    expect(en).toContain('- src/math.ts#double');
    expect(en).toContain('analyzed files');
    expect(en).toMatch(/Removed relationships \(\d+\)\n {2}(Calls|Exports|Contains)/);
    expect(en).not.toMatch(/[ãõçáéíóú]/);

    expect(formatDiff(compareGraphs(before, before), 'en')).toContain(
      'No node, relationship or cycle changed between the two analyses.',
    );
  });

  it('rota com endereço novo aparece como alterada', () => {
    const a = structuredClone(before);
    a.nodes.push({
      id: 'route:src/server.js#r GET /x',
      kind: 'route',
      name: 'GET /api/x',
      meta: { httpMethod: 'GET', routePath: '/x', fullPath: '/api/x', mountedAt: ['/api'] },
    });
    const b = structuredClone(a);
    b.nodes[b.nodes.length - 1]!.meta = {
      httpMethod: 'GET',
      routePath: '/x',
      fullPath: '/v2/x',
      mountedAt: ['/v2'],
    };
    const diff = compareGraphs(a, b);
    expect(diff.identical).toBe(false);
    const en = formatDiff(diff, 'en');
    expect(en).toContain('Routes with a new address (1)');
    expect(en).toContain('~ src/server.js#r GET /x: /api/x → /v2/x');
    expect(formatDiff(diff, 'pt')).toContain('Rotas com outro endereço (1)');
  });
});

const bin = path.join(repo, 'apps', 'cli', 'bin', 'rastro.js');
const bundled = path.join(repo, 'apps', 'cli', 'dist', 'rastro.mjs');

/** Ambiente sem nenhuma variável de idioma (o que um usuário de outro país teria, sem pt). */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['RASTRO_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) delete env[key];
  return { ...env, ...extra };
}

const run = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd: repo, env });

describe.skipIf(!fs.existsSync(bundled))('idioma da CLI empacotada', () => {
  let saved: string;
  beforeAll(() => {
    saved = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-lang-')), 'g.json');
    const res = run(['analyze', fixture, '-o', saved], cleanEnv({ RASTRO_LANG: 'en' }));
    expect(res.status).toBe(0);
  });

  it('RASTRO_LANG=en: progresso, resumo, export e erros em inglês', () => {
    const env = cleanEnv({ RASTRO_LANG: 'en' });
    const analyzed = run(['analyze', fixture, '-o', saved], env);
    expect(analyzed.stderr).toContain('Looking for JavaScript/TypeScript files...');
    expect(analyzed.stderr).toContain('9 files found.');
    expect(analyzed.stderr).toContain('9 files analyzed');
    expect(analyzed.stderr).toMatch(/relationships: \d+ resolved · \d+ external · \d+ unresolved/);
    expect(analyzed.stderr).toMatch(/1 import cycle\b/);
    expect(analyzed.stderr).toContain('graph saved to');
    expect(analyzed.stderr).not.toMatch(/[ãõçáéíóú]/);

    const mermaid = run(['export', saved, '-f', 'mermaid'], env);
    expect(mermaid.stdout.startsWith('%% Rastro · ts-basic · level: files\n')).toBe(true);

    const noFormat = run(['export', saved], env);
    expect(noFormat.status).toBe(1);
    expect(noFormat.stderr).toContain('error: choose a format with --format');
    expect(run(['analyze', fixture, '--json'], env).stderr).toContain(
      'error: --json only works with "rastro compare".',
    );
    expect(run(['--bogus'], env).stderr).toContain('Run "rastro --help" to see the options.');

    const help = run(['--help'], env);
    expect(help.stdout).toContain('follow the trail of your code');
    expect(help.stdout).toContain('--lang <en|pt>');
  });

  it('RASTRO_LANG=pt: as mesmas mensagens em português', () => {
    const env = cleanEnv({ RASTRO_LANG: 'pt' });
    const analyzed = run(['analyze', fixture, '-o', saved], env);
    expect(analyzed.stderr).toContain('Procurando arquivos JavaScript/TypeScript...');
    expect(analyzed.stderr).toContain('9 arquivos encontrados.');
    expect(analyzed.stderr).toContain('9 arquivos analisados');
    expect(analyzed.stderr).toMatch(/1 ciclo de importação\b/);
    expect(analyzed.stderr).toContain('grafo salvo em');
    const help = run(['--help'], env);
    expect(help.stdout).toContain('siga o rastro do seu código');
    expect(run(['export', saved], env).stderr).toContain('erro: informe o formato com --format');
  });

  it('sem variáveis de idioma, inglês; LANG=pt_BR, português; --lang vence tudo', () => {
    expect(run(['--help'], cleanEnv()).stdout).toContain('follow the trail of your code');
    expect(run(['--help'], cleanEnv({ LANG: 'pt_BR.UTF-8' })).stdout).toContain(
      'siga o rastro do seu código',
    );
    expect(run(['--help', '--lang', 'en'], cleanEnv({ RASTRO_LANG: 'pt' })).stdout).toContain(
      'follow the trail of your code',
    );
    expect(run(['--lang=pt', 'validate', saved], cleanEnv({ LANG: 'en_US' })).stdout).toMatch(
      /^válido — /,
    );
    const bad = run(['--lang', 'xx', '--help'], cleanEnv());
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('error: unknown language: "xx". Use en or pt.');
  });

  it('compare em inglês', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-lang-cmp-'));
    const changed = JSON.parse(fs.readFileSync(saved, 'utf8')) as RastroGraph;
    changed.nodes = changed.nodes.filter((n) => n.id !== 'fn:src/math.ts#double');
    changed.edges = changed.edges.filter(
      (e) => e.source !== 'fn:src/math.ts#double' && e.target !== 'fn:src/math.ts#double',
    );
    const after = path.join(dir, 'after.json');
    fs.writeFileSync(after, JSON.stringify(changed));
    const res = run(['compare', saved, after], cleanEnv({ RASTRO_LANG: 'en' }));
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Comparison');
    expect(res.stdout).toContain('Removed (1)');
    expect(res.stdout).toContain('- src/math.ts#double');
  });
});

describe('bin/rastro.js sem o bundle', () => {
  it('avisa que falta compilar no idioma certo (roda antes do catálogo)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-bin-'));
    fs.mkdirSync(path.join(dir, 'bin'));
    const copy = path.join(dir, 'bin', 'rastro.js');
    fs.copyFileSync(bin, copy);
    const runCopy = (args: string[], env: NodeJS.ProcessEnv) =>
      spawnSync(process.execPath, [copy, ...args], { encoding: 'utf8', env });

    const en = runCopy(['--help'], cleanEnv());
    expect(en.status).toBe(1);
    expect(en.stderr).toContain('Rastro has not been built yet');
    expect(runCopy([], cleanEnv({ LANG: 'pt_BR.UTF-8' })).stderr).toContain(
      'O Rastro ainda não foi compilado',
    );
    expect(runCopy([], cleanEnv({ LANG: 'pt_BR.UTF-8', RASTRO_LANG: 'en' })).stderr).toContain(
      'Rastro has not been built yet',
    );
    expect(runCopy(['--lang', 'pt'], cleanEnv({ RASTRO_LANG: 'en' })).stderr).toContain(
      'O Rastro ainda não foi compilado',
    );
    expect(runCopy([], cleanEnv({ LC_ALL: 'de_DE.UTF-8', LANG: 'pt_BR' })).stderr).toContain(
      'Rastro has not been built yet',
    );
  });
});
