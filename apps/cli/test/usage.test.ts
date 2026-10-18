import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { argsErrorMessage } from '../src/args.js';
import { checkGit, GitError } from '../src/git.js';
import { MESSAGES, setLang } from '../src/i18n.js';
import { checkGraphTarget, readGraphJson } from '../src/storage.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = path.join(repo, 'fixtures', 'ts-basic');
const bin = path.join(repo, 'apps', 'cli', 'bin', 'rastro.js');
const bundled = path.join(repo, 'apps', 'cli', 'dist', 'rastro.mjs');

const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/** O erro que o `parseArgs` do Node lança para estes argumentos. */
function argsError(args: string[]): unknown {
  try {
    parseArgs({
      args,
      allowPositionals: args[0] !== 'nopos',
      options: {
        port: { type: 'string', short: 'p' },
        'max-files': { type: 'string' },
        stdout: { type: 'boolean' },
      },
    });
  } catch (err) {
    return err;
  }
  throw new Error('parseArgs aceitou os argumentos');
}

describe('erros do parseArgs', () => {
  afterEach(() => setLang('pt'));

  it('viram mensagens curtas nos dois idiomas', () => {
    setLang('en');
    expect(argsErrorMessage(argsError(['--bogus']))).toBe('unknown option: --bogus');
    expect(argsErrorMessage(argsError(['-x']))).toBe('unknown option: -x');
    expect(argsErrorMessage(argsError(['--max-files']))).toBe('--max-files needs a value');
    expect(argsErrorMessage(argsError(['-p']))).toBe('--port needs a value');
    expect(argsErrorMessage(argsError(['--max-files', '-3']))).toBe(
      '--max-files needs a value (for a value that starts with "-", write --max-files=<value>)',
    );
    expect(argsErrorMessage(argsError(['--stdout=1']))).toBe('--stdout does not take a value');
    expect(argsErrorMessage(argsError(['nopos']))).toBe('unexpected argument: nopos');
    setLang('pt');
    expect(argsErrorMessage(argsError(['--bogus']))).toBe('opção desconhecida: --bogus');
    expect(argsErrorMessage(argsError(['--max-files']))).toBe('--max-files precisa de um valor');
    expect(argsErrorMessage(argsError(['--stdout=1']))).toBe('--stdout não aceita valor');
  });

  it('erros desconhecidos passam como vieram', () => {
    expect(argsErrorMessage(new Error('outro erro'))).toBe('outro erro');
  });
});

describe('ajuda', () => {
  /** Linhas de continuação fora da coluna das descrições da seção. */
  function misaligned(help: string): string[] {
    const bad: string[] = [];
    let column: number | undefined;
    for (const line of help.split('\n')) {
      const lead = line.length - line.trimStart().length;
      if (!line.trim() || lead === 0) {
        column = undefined; // título de seção ou parágrafo final
        continue;
      }
      if (lead <= 6) {
        const entry = /^( +\S.*?) {2,}\S/.exec(line);
        if (!entry) continue; // comando sem descrição na mesma linha
        const at = entry[0].length - 1;
        if (column === undefined) column = at;
        else if (at !== column) bad.push(line);
        continue;
      }
      if (lead !== column) bad.push(line);
    }
    return bad;
  }

  it('linhas de continuação alinhadas com as descrições, nos dois idiomas', () => {
    for (const lang of ['pt', 'en'] as const) {
      const help = MESSAGES[lang].help('9.9.9');
      expect(misaligned(help), lang).toEqual([]);
      expect(help).toContain(`\n${' '.repeat(36)}(`);
    }
  });
});

describe('mensagens de erro', () => {
  it('começam com minúscula depois de "erro:"/"error:", nos dois idiomas', () => {
    const samples = (fn: unknown): string[] => {
      if (typeof fn === 'string') return [fn];
      const f = fn as (...args: unknown[]) => unknown;
      // números para as portas, listas para os problemas da validação
      for (const sample of ['x', 1, ['x']])
        try {
          const out = f(...Array.from({ length: f.length }, () => sample));
          if (typeof out === 'string') return [out];
        } catch {
          // tipo de argumento errado: tenta o próximo
        }
      return [];
    };
    for (const lang of ['pt', 'en'] as const) {
      const m = MESSAGES[lang];
      // seeHelp fica na linha de baixo, não depois de "erro:"
      const usage = Object.entries(m.usage).filter(([key]) => key !== 'seeHelp');
      const groups = [
        Object.fromEntries(usage),
        m.storage,
        m.git,
        m.report,
        {
          needFormat: m.export.needFormat,
          unknownFormat: m.export.unknownFormat,
          writeFailed: m.export.writeFailed,
          isDir: m.export.isDir,
          failed: m.export.failed,
          badFormat: m.impact.badFormat,
          needsChanges: m.impact.needsChanges,
          gitFailed: m.impact.gitFailed,
          badLink: m.impact.badLink,
          webNotBuilt: m.serve.webNotBuilt,
          portFailed: m.server.portFailed,
        },
      ];
      const capitalized = groups
        .flatMap((g) => Object.values(g).flatMap(samples))
        // "JSON inválido", "HEAD": siglas podem começar a frase
        .filter((text) => /^[A-ZÀ-Ý][a-zà-ÿ]/.test(text));
      expect(capitalized, lang).toEqual([]);
    }
  });
});

describe('leitura e destino do grafo', () => {
  afterEach(() => setLang('pt'));

  it('uma pasta no lugar do JSON sugere analisá-la', () => {
    setLang('en');
    const dir = tmp('rastro-dir-');
    expect(() => readGraphJson(dir)).toThrow(
      `${dir} is a folder, but a graph JSON file is expected here. To analyze the folder, run "rastro ${dir}" or "rastro analyze ${dir}".`,
    );
    const spaced = path.join(dir, 'my project');
    fs.mkdirSync(spaced);
    expect(() => readGraphJson(spaced)).toThrow(`"rastro '${spaced}'"`);
    expect(() => readGraphJson(path.join(dir, 'nope.json'))).toThrow(/^file not found: /);
  });

  it.skipIf(process.platform === 'win32')(
    'destino especial (/dev/null) ou pasta: o motivo real, antes de analisar',
    () => {
      setLang('en');
      expect(() => checkGraphTarget('/dev/null')).toThrow(
        'could not save the graph to /dev/null: the destination is not a regular file',
      );
      expect(() => checkGraphTarget(os.tmpdir())).toThrow(/the destination is a folder/);
      expect(() => checkGraphTarget(path.join(tmp('rastro-out-'), 'g.json'))).not.toThrow();
    },
  );
});

describe('git conferido antes da análise', () => {
  afterEach(() => setLang('pt'));

  it('pasta fora de um repositório e referência desconhecida, sem "fatal:"', () => {
    setLang('en');
    const plain = tmp('rastro-plain-');
    expect(() => checkGit(plain)).toThrow(GitError);
    expect(() => checkGit(plain)).toThrow(`not a git repository (${plain})`);

    const root = tmp('rastro-ref-');
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
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
        ].concat(args),
        { cwd: root, stdio: 'pipe' },
      );
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'inicial');
    expect(() => checkGit(root)).not.toThrow();
    expect(() => checkGit(root, { since: 'main' })).not.toThrow();
    expect(() => checkGit(root, { since: 'nope' })).toThrow('unknown reference: nope');
    setLang('pt');
    expect(() => checkGit(root, { since: 'nope' })).toThrow('referência desconhecida: nope');
  });
});

/** Ambiente sem variáveis de idioma, com o idioma pedido. */
function env(lang: 'en' | 'pt'): NodeJS.ProcessEnv {
  const e = { ...process.env };
  for (const key of ['RASTRO_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) delete e[key];
  return { ...e, RASTRO_LANG: lang, RASTRO_CACHE_DIR: cache };
}
let cache = '';

const run = (args: string[], lang: 'en' | 'pt' = 'en') =>
  spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd: repo, env: env(lang) });

/** A análise não começou (o progresso sai no stderr). */
const notAnalyzed = (stderr: string) =>
  expect(stderr).not.toMatch(/files found|Looking for|arquivos encontrados/);

describe.skipIf(!fs.existsSync(bundled))('CLI empacotada: uso e entradas inválidas', () => {
  beforeAll(() => {
    cache = tmp('rastro-cache-');
  });

  it('validate e compare mostram os problemas no idioma da CLI', () => {
    const bad = path.join(tmp('rastro-bad-'), 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ schemaVersion: '0.9', nodes: [], edges: [] }));
    const en = run(['validate', bad]);
    expect(en.status).toBe(1);
    expect(en.stderr).toContain('schemaVersion must be "0.1.0" (got: "0.9").');
    expect(en.stderr).toContain('project.root is required.');
    expect(en.stderr).not.toMatch(/deve ser|obrigatório/);
    const compared = run(['compare', bad, bad]);
    expect(compared.stderr).toContain('error: invalid graph:\n- schemaVersion must be');
    const pt = run(['validate', bad], 'pt');
    expect(pt.stderr).toContain('schemaVersion deve ser "0.1.0" (recebido: "0.9").');
  });

  it('exemplos certos quando falta o argumento', () => {
    expect(run(['serve']).stderr).toContain(
      'error: missing graph JSON file for "serve". Example: rastro serve graph.json',
    );
    expect(run(['validate']).stderr).toContain('Example: rastro validate graph.json');
    expect(run(['compare']).stderr).toContain('Example: rastro compare before.json after.json');
    expect(run(['analyze']).stderr).toContain('Example: rastro analyze ./my-project');
    expect(run(['serve'], 'pt').stderr).toContain('Exemplo: rastro serve grafo.json');
  });

  it('serve e validate com uma pasta explicam que esperam um JSON', () => {
    for (const command of ['serve', 'validate']) {
      const res = run([command, fixture]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('is a folder, but a graph JSON file is expected here');
      expect(res.stderr).toContain(`rastro analyze ${fixture}`);
      expect(res.stderr).not.toContain('EISDIR');
    }
  });

  it('opções inválidas falham antes da análise, com mensagens claras', () => {
    const cases: Array<[string[], string]> = [
      [['--bogus'], 'error: unknown option: --bogus\n'],
      [[fixture, '--max-files', '-3'], 'error: --max-files needs a value'],
      [[fixture, '-p', '99999', '--no-open'], 'error: --port must be a number'],
      [['analyze', fixture, '--stdout', '-o', 'x.json'], '--stdout and --out cannot be used'],
      [
        ['impact', fixture, '--format', 'markdown', '--link', 'javascript:alert(1)'],
        'error: --link must be an http:// or https:// address',
      ],
      [
        ['impact', fixture, '--format', 'markdown', '--link', 'file:///etc/passwd'],
        'error: --link must be an http:// or https:// address',
      ],
    ];
    // argumentos a mais, valores vazios e --no-open fora do mapa: nunca ignorados em silêncio
    cases.push(
      [['impact', fixture, 'main'], 'error: unexpected argument: main\n'],
      [[fixture, 'outra-pasta'], 'error: unexpected argument: outra-pasta\n'],
      [['compare', 'a.json', 'b.json', 'c.json'], 'error: unexpected argument: c.json\n'],
      [['analyze', fixture, '--since', ''], 'error: --since needs a value\n'],
      [['impact', fixture, '--since='], 'error: --since needs a value\n'],
      [['impact', fixture, '-o', ''], 'error: --out needs a value\n'],
      [['export', fixture, '-f', 'json', '-o', ''], 'error: --out needs a value\n'],
      [['analyze', fixture, '-o', ''], 'error: --out needs a value\n'],
      [['analyze', fixture, '-e', ''], 'error: --exclude needs a value\n'],
      [['analyze', fixture, '--no-open'], 'error: --no-open does not apply to "analyze".'],
      [['impact', fixture, '--no-open'], 'error: --no-open does not apply to "impact".'],
      [['export', fixture, '--no-open'], 'error: --no-open does not apply to "export".'],
      [['validate', 'g.json', '--no-open'], 'error: --no-open does not apply to "validate".'],
    );
    if (process.platform !== 'win32')
      cases.push([
        ['analyze', fixture, '-o', '/dev/null'],
        'error: could not save the graph to /dev/null: the destination is not a regular file',
      ]);
    for (const [args, message] of cases) {
      const res = run(args);
      expect(res.status, args.join(' ')).toBe(1);
      expect(res.stderr, args.join(' ')).toContain(message);
      notAnalyzed(res.stderr);
    }
  });

  it('impact fora de um repositório git ou com --since desconhecido: antes de analisar', () => {
    const plain = tmp('rastro-plain-');
    fs.cpSync(fixture, plain, { recursive: true });
    const res = run(['impact', plain]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`error: could not read the git changes: not a git repository`);
    expect(res.stderr).not.toContain('fatal:');
    notAnalyzed(res.stderr);
    const pt = run(['impact', plain], 'pt');
    expect(pt.stderr).toContain('erro: não foi possível ler as mudanças do git: a pasta não está');
    const since = run(['analyze', plain, '--since', 'nope']);
    expect(since.status).toBe(1);
    notAnalyzed(since.stderr);
    // a fixture está dentro do repositório do Rastro
    const badRef = run(['impact', fixture, '--since', 'rastro-ref-que-nao-existe']);
    expect(badRef.status).toBe(1);
    expect(badRef.stderr).toContain(
      'error: could not read the git changes: unknown reference: rastro-ref-que-nao-existe',
    );
    notAnalyzed(badRef.stderr);
  });
});
