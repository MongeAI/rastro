import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ChangedFile, ChangeSet } from '@rastro/core';
import { t } from './i18n.js';

/** Árvore vazia do git: base para repositórios ainda sem commits. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Configurações locais (`.git/config`) que fazem o git EXECUTAR comandos ao gerar um diff.
 * Um repositório baixado de fonte não confiável (ex.: um .zip com a pasta .git) pode trazê-las.
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

export class GitError extends Error {}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', [...SAFE_FLAGS, ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      // sem prompts, sem travas no índice, sem configuração global de sistema
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') throw new GitError(t().git.notFound);
    // a primeira linha do próprio git (no idioma do git)
    throw new GitError((e.stderr ?? e.message).toString().trim().split('\n')[0] || t().git.failed);
  }
}

/** Configurações locais arriscadas presentes no repositório (vazio = seguro). */
export function riskyGitConfig(repoDir: string): string[] {
  let listing: string;
  try {
    listing = git(repoDir, ['config', '--local', '--list', '--name-only']);
  } catch {
    return [];
  }
  return listing
    .split('\n')
    .map((l) => l.trim().toLowerCase())
    .filter((name) => name && RISKY_CONFIG.some((re) => re.test(name)));
}

/** Remove aspas e escapes que o git usa em caminhos com caracteres especiais. */
function unquote(p: string): string {
  if (!p.startsWith('"')) return p;
  return p.slice(1, -1).replace(/\\(.)/g, '$1');
}

/**
 * Lê a saída de `git diff --unified=0` e devolve, por arquivo, as linhas alteradas no
 * arquivo atual. Trechos só removidos viram `deletionsAt` (a linha onde estavam).
 */
export function parseUnifiedDiff(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { file: '', status: 'modified', ranges: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode')) current.status = 'added';
    else if (line.startsWith('deleted file mode')) current.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      current.status = 'renamed';
      current.previous = unquote(line.slice('rename from '.length));
    } else if (line.startsWith('rename to '))
      current.file = unquote(line.slice('rename to '.length));
    else if (line.startsWith('--- ')) {
      const p = unquote(line.slice(4));
      if (p !== '/dev/null' && !current.file) current.file = p.replace(/^a\//, '');
    } else if (line.startsWith('+++ ')) {
      const p = unquote(line.slice(4));
      if (p !== '/dev/null') current.file = p.replace(/^b\//, '');
    } else if (line.startsWith('@@')) {
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
  const top = git(root, ['rev-parse', '--show-toplevel']).trim();
  const prefix = git(root, ['rev-parse', '--show-prefix']).trim();

  const risky = riskyGitConfig(root);
  if (risky.length && !options.trustConfig) {
    throw new GitError(t().git.riskyConfig(risky.join(', ')));
  }

  let base: string;
  let baseLabel: string;
  if (options.since) {
    if (options.since.startsWith('-')) throw new GitError(t().git.badRef(options.since));
    base = git(root, ['merge-base', options.since, 'HEAD']).trim();
    baseLabel = options.since;
  } else {
    try {
      base = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).trim();
    } catch {
      base = EMPTY_TREE; // repositório sem commits: tudo é novo
    }
    baseLabel = 'HEAD';
  }

  const scope = prefix ? prefix : '.';
  const diff = git(top, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--unified=0',
    '-M',
    base,
    '--',
    scope,
  ]);
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
    const abs = path.join(top, p);
    let lines: number;
    try {
      const text = fs.readFileSync(abs, 'utf8');
      lines = Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
    } catch {
      continue;
    }
    files.push({ file: toRoot(p), status: 'added', ranges: [[1, lines]] });
  }
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { base, baseLabel, includesUntracked: true, files };
}
