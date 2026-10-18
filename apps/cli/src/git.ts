import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { languageOf } from '@rastro/analyzer';
import type { ChangedFile, ChangeSet } from '@rastro/core';
import { t } from './i18n.js';

/** Árvore vazia do git: base para repositórios ainda sem commits. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Configurações do repositório que fazem o git EXECUTAR comandos ao gerar um diff. Um
 * repositório baixado de fonte não confiável (ex.: um .zip com a pasta .git) pode trazê-las
 * no `.git/config` ou no `.git/config.worktree` (lido quando `extensions.worktreeConfig` está
 * ligado), direto ou por `include.path`.
 */
const RISKY_CONFIG = [
  /^filter\..+\.(clean|smudge|process)$/,
  /^diff\..+\.(textconv|command)$/,
  /^diff\.external$/,
  /^core\.fsmonitor$/,
  /^core\.hookspath$/,
  /^core\.pager$/,
  /^core\.sshcommand$/,
  /^include\.path$/,
  /^includeif\..+\.path$/,
];

/** Opções que neutralizam extensões do git que poderiam executar código. */
const SAFE_FLAGS = [
  '-c',
  'core.quotePath=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '--no-pager',
];

/** Chaves que as próprias opções acima definem (aparecem no escopo `command` da listagem). */
const OWN_KEYS = new Set(['core.quotepath', 'core.fsmonitor', 'core.hookspath']);

/** Escopos que vêm da máquina do usuário, não do repositório analisado. */
const TRUSTED_SCOPES = new Set(['global', 'system']);

/**
 * Opções fixas do diff. Os prefixos explícitos anulam `diff.noprefix`, `diff.mnemonicPrefix`
 * e `diff.srcPrefix`/`dstPrefix` da configuração do usuário, que mudariam o `a/` e o `b/`.
 */
const DIFF_FLAGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--unified=0',
  '--inter-hunk-context=0',
  '-M',
  // nunca entra em submódulos: o git rodaria o status dentro deles, lendo a configuração de
  // .git/modules/<nome>/config (que a checagem de configurações arriscadas não vê) e
  // executando, por exemplo, um filter.<x>.clean definido lá
  '--ignore-submodules=all',
];

/** Limite para contar as linhas de arquivos novos (o mesmo tamanho máximo do analisador). */
const MAX_UNTRACKED_BYTES = 1_000_000;

export class GitError extends Error {}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', [...SAFE_FLAGS, ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      // sem prompts, sem travas no índice, sem configuração global de sistema; caminhos são
      // sempre literais (uma pasta chamada ":(top)x" não vira "mágica" de pathspec)
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_LITERAL_PATHSPECS: '1',
      },
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') throw new GitError(t().git.notFound);
    // a primeira linha do próprio git (no idioma do git), sem o prefixo "fatal:"/"error:"
    const first = (e.stderr ?? e.message)
      .toString()
      .trim()
      .split('\n')[0]!
      .replace(/^(fatal|error):\s*/i, '');
    throw new GitError(first || t().git.failed);
  }
}

/** Se `dir` (ou uma pasta acima) tem um `.git`: distingue "não é repositório" de outros erros. */
function insideRepo(dir: string): boolean {
  if (process.env.GIT_DIR) return true;
  for (let cur = path.resolve(dir); ; cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, '.git'))) return true;
    if (path.dirname(cur) === cur) return false;
  }
}

interface GitBase {
  top: string;
  prefix: string;
  base: string;
  baseLabel: string;
}

/**
 * Raiz do repositório e o commit base da comparação, com erros claros: pasta fora de um
 * repositório, configuração arriscada, referência desconhecida. Só chamadas rápidas do git.
 */
function resolveBase(root: string, options: CollectOptions): GitBase {
  let top: string;
  try {
    top = git(root, ['rev-parse', '--show-toplevel']).trim();
  } catch (err) {
    if (err instanceof GitError && err.message !== t().git.notFound && !insideRepo(root))
      throw new GitError(t().git.notRepo(root));
    throw err;
  }
  const prefix = git(root, ['rev-parse', '--show-prefix']).trim();

  if (!options.trustConfig) {
    const risky = riskyGitConfig(root);
    if (risky.length) throw new GitError(t().git.riskyConfig(risky.join(', ')));
  }

  if (options.since) {
    const since = options.since;
    if (since.startsWith('-')) throw new GitError(t().git.badRef(since));
    try {
      git(root, ['rev-parse', '--verify', '--quiet', `${since}^{commit}`]);
    } catch {
      throw new GitError(t().git.unknownRef(since));
    }
    let base: string;
    try {
      base = git(root, ['merge-base', since, 'HEAD']).trim();
    } catch {
      throw new GitError(t().git.noMergeBase(since));
    }
    return { top, prefix, base, baseLabel: since };
  }
  let base: string;
  try {
    base = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).trim();
  } catch {
    base = EMPTY_TREE; // repositório sem commits: tudo é novo
  }
  return { top, prefix, base, baseLabel: 'HEAD' };
}

/**
 * Confere, antes da análise (que pode demorar), se as mudanças do git poderão ser lidas:
 * repositório, configuração e referência de `since`. Lança `GitError` com a mensagem pronta.
 */
export function checkGit(root: string, options: CollectOptions = {}): void {
  resolveBase(root, options);
}

/**
 * Configurações arriscadas que o git usaria neste repositório (vazio = seguro). Lista a
 * configuração efetiva com o escopo de cada chave (já seguindo `include.path`) e considera
 * todos os escopos menos `global` e `system`: `local` (.git/config), `worktree`
 * (.git/config.worktree) e `command` (variáveis GIT_CONFIG_*). Se a listagem falhar, o erro
 * sobe: nunca supõe que está tudo bem.
 */
export function riskyGitConfig(repoDir: string): string[] {
  const listing = git(repoDir, ['config', '--list', '--show-scope', '--name-only', '-z']);
  const found = new Set<string>();
  // com -z, cada entrada é "escopo\0chave\0"
  const parts = listing.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i]!.trim().toLowerCase();
    const name = parts[i + 1]!.trim().toLowerCase();
    if (!name || TRUSTED_SCOPES.has(scope)) continue;
    if (scope === 'command' && OWN_KEYS.has(name)) continue;
    if (RISKY_CONFIG.some((re) => re.test(name))) found.add(name);
  }
  return [...found];
}

/** Escapes de um caractere que o git usa em caminhos entre aspas (estilo C). */
const C_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/**
 * Remove as aspas e decodifica os escapes que o git usa em caminhos com caracteres especiais:
 * `\t`, `\n`, `\"`, `\\` e octais (`\303\251` são os bytes UTF-8 de "é").
 */
export function unquote(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== '\\') {
      const code = inner.codePointAt(i)!;
      const char = String.fromCodePoint(code);
      bytes.push(...Buffer.from(char, 'utf8'));
      i += char.length - 1;
      continue;
    }
    const octal = /^[0-7]{3}/.exec(inner.slice(i + 1, i + 4));
    const next = inner[i + 1] ?? '';
    if (octal) {
      bytes.push(parseInt(octal[0], 8) & 0xff);
      i += 3;
    } else {
      bytes.push(...(next in C_ESCAPES ? [C_ESCAPES[next]!] : Buffer.from(next, 'utf8')));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Caminho de uma linha `---`/`+++`, sem o TAB que o git põe depois de nomes com espaço. */
function headerPath(rest: string): string {
  return unquote(rest.endsWith('\t') ? rest.slice(0, -1) : rest);
}

/**
 * Lê a saída de `git diff --unified=0` e devolve, por arquivo, as linhas alteradas no
 * arquivo atual. Trechos só removidos viram `deletionsAt` (a linha onde estavam).
 */
export function parseUnifiedDiff(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | null = null;
  // depois do primeiro @@ de um arquivo, tudo é conteúdo (linhas com +, -, espaço ou \) até o
  // próximo "diff --git": uma linha adicionada "++ n;" aparece como "+++ n;" e não é cabeçalho
  let inHunk = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { file: '', status: 'modified', ranges: [] };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (inHunk && !line.startsWith('@@')) continue;
    if (line.startsWith('new file mode')) current.status = 'added';
    else if (line.startsWith('deleted file mode')) current.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      current.status = 'renamed';
      current.previous = unquote(line.slice('rename from '.length));
    } else if (line.startsWith('rename to '))
      current.file = unquote(line.slice('rename to '.length));
    else if (line.startsWith('--- ')) {
      const p = headerPath(line.slice(4));
      if (p !== '/dev/null' && !current.file) current.file = p.replace(/^a\//, '');
    } else if (line.startsWith('+++ ')) {
      const p = headerPath(line.slice(4));
      if (p !== '/dev/null') current.file = p.replace(/^b\//, '');
    } else if (line.startsWith('@@')) {
      inHunk = true;
      const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const start = Number(m[2]);
      const count = m[3] === undefined ? 1 : Number(m[3]);
      if (count > 0) current.ranges.push([start, start + count - 1]);
      else (current.deletionsAt ??= []).push(Math.max(1, start + 1));
    }
  }
  return files.filter((f) => f.file);
}

export interface CollectOptions {
  /** Referência para comparar (ex.: `main`): usa o ponto em que a branch atual saiu dela. */
  since?: string;
  /** Ignora o aviso de configurações locais arriscadas. */
  trustConfig?: boolean;
}

/**
 * Mudanças do repositório em relação a `HEAD` (padrão: o que ainda não foi commitado) ou ao
 * ponto em que a branch saiu de `since`. Inclui arquivos novos não versionados. Só leitura.
 */
export function collectChanges(root: string, options: CollectOptions = {}): ChangeSet {
  const { top, prefix, base, baseLabel } = resolveBase(root, options);

  const scope = prefix ? prefix : '.';
  const diff = git(top, ['diff', ...DIFF_FLAGS, base, '--', scope]);
  const untracked = git(top, ['ls-files', '--others', '--exclude-standard', '-z', '--', scope])
    .split('\0')
    .filter(Boolean);

  // caminhos do git são relativos ao topo do repositório; o grafo usa a raiz analisada
  const toRoot = (p: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
  const files: ChangedFile[] = parseUnifiedDiff(diff).map((f) => ({
    ...f,
    file: toRoot(f.file),
    ...(f.previous ? { previous: toRoot(f.previous) } : {}),
  }));
  for (const p of untracked) {
    const lines = countLines(path.join(top, p));
    if (lines === undefined) continue;
    files.push({ file: toRoot(p), status: 'added', ranges: [[1, lines]] });
  }
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { base, baseLabel, includesUntracked: true, files };
}

/**
 * Linhas de um arquivo novo (não versionado), lendo só o que o analisador leria: arquivo
 * regular (sem seguir links simbólicos: nada de /dev/zero ou FIFOs), JS/TS e até o tamanho
 * máximo. Qualquer outro conta como uma linha. `undefined` se o arquivo sumiu.
 */
function countLines(abs: string): number | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES || !languageOf(abs)) return 1;
  try {
    const text = fs.readFileSync(abs, 'utf8');
    return Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
  } catch {
    return 1;
  }
}
