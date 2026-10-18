import fs from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { Diagnostic, Language } from '@rastro/core';
import { compareStrings } from '@rastro/core';

/** Diretórios que quase sempre contêm código gerado, dependências ou dados de ferramentas. */
export const DEFAULT_EXCLUDED_DIRS = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vercel',
  '.netlify',
  '.angular',
  '.expo',
  '.rastro',
  'storybook-static',
  'bower_components',
  'jspm_packages',
] as const;

const SOURCE_EXTENSIONS: Record<string, Language> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
};

/** Arquivos ignorados por nome: declarações de tipo e bundles minificados. */
const IGNORED_FILE_PATTERNS = [/\.d\.[mc]?ts$/, /\.min\.[mc]?js$/, /\.bundle\.[mc]?js$/];

export interface DiscoverOptions {
  /** Padrões extras no formato do .gitignore. */
  exclude?: string[];
  respectGitignore?: boolean;
  maxFiles?: number;
  maxFileSizeBytes?: number;
}

export interface DiscoveredFile {
  /** Caminho absoluto (real) com `/`. */
  absolute: string;
  /** Caminho relativo à raiz com `/`. */
  relative: string;
  language: Language;
}

export interface DiscoverResult {
  root: string;
  files: DiscoveredFile[];
  /** Pastas percorridas (relativas à raiz, com `/`; a raiz é `.`), já sem as excluídas. */
  directories: string[];
  diagnostics: Diagnostic[];
}

export const toPosix = (p: string) => p.split(path.sep).join('/');

export function languageOf(file: string): Language | undefined {
  return SOURCE_EXTENSIONS[path.extname(file).toLowerCase()];
}

/**
 * Percorre o projeto e lista os arquivos JS/TS relevantes.
 * - Não segue links simbólicos (evita sair da raiz e loops).
 * - Respeita exclusões padrão, o .gitignore da raiz e padrões extras.
 * - Ignora arquivos muito grandes (normalmente gerados ou minificados).
 */
export function discoverFiles(rootInput: string, options: DiscoverOptions = {}): DiscoverResult {
  const maxFiles = options.maxFiles ?? 10_000;
  const maxSize = options.maxFileSizeBytes ?? 1_000_000;
  const diagnostics: Diagnostic[] = [];

  const root = fs.realpathSync(path.resolve(rootInput));
  if (!fs.statSync(root).isDirectory()) throw new Error(`Não é um diretório: ${root}`);

  const ig: Ignore = ignore();
  ig.add(DEFAULT_EXCLUDED_DIRS.map((d) => `${d}/`));
  if (options.exclude?.length) ig.add(options.exclude);
  if (options.respectGitignore !== false) {
    const gitignore = path.join(root, '.gitignore');
    try {
      const stat = fs.lstatSync(gitignore);
      if (stat.isFile()) ig.add(fs.readFileSync(gitignore, 'utf8'));
    } catch {
      // sem .gitignore
    }
  }

  const files: DiscoveredFile[] = [];
  const directories: string[] = [];
  const stack: string[] = [root];
  let truncated = false;

  while (stack.length && !truncated) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      diagnostics.push({
        level: 'warning',
        code: 'unreadable-directory',
        message: `Não foi possível ler o diretório: ${(err as Error).message}`,
        file: toPosix(path.relative(root, dir)) || '.',
      });
      continue;
    }
    directories.push(toPosix(path.relative(root, dir)) || '.');
    entries.sort((a, b) => compareStrings(a.name, b.name));
    const subdirs: string[] = [];
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));
      if (entry.isSymbolicLink()) {
        if (languageOf(entry.name) || !path.extname(entry.name)) {
          diagnostics.push({
            level: 'info',
            code: 'symlink-skipped',
            message: 'Link simbólico ignorado (o Rastro não segue links simbólicos).',
            file: rel,
          });
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (!ig.ignores(`${rel}/`)) subdirs.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const language = languageOf(entry.name);
      if (!language || IGNORED_FILE_PATTERNS.some((re) => re.test(entry.name))) continue;
      if (ig.ignores(rel)) continue;
      const size = fs.statSync(abs).size;
      if (size > maxSize) {
        diagnostics.push({
          level: 'warning',
          code: 'file-too-large',
          message: `Arquivo ignorado por ser maior que ${Math.round(maxSize / 1000)} KB (provavelmente gerado).`,
          file: rel,
        });
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        diagnostics.push({
          level: 'warning',
          code: 'max-files-reached',
          message: `Limite de ${maxFiles} arquivos atingido; o restante do projeto não foi analisado.`,
        });
        break;
      }
      files.push({ absolute: toPosix(abs), relative: rel, language });
    }
    // ordem determinística: subdiretórios em ordem alfabética
    stack.push(...subdirs.reverse());
  }

  files.sort((a, b) => compareStrings(a.relative, b.relative));
  directories.sort(compareStrings);
  return { root: toPosix(root), files, directories, diagnostics };
}
