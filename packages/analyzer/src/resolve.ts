import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { ts } from 'ts-morph';
import type { Diagnostic } from '@teia/core';
import { toPosix } from './discover.js';

const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith('_')));

export interface LoadedCompilerOptions {
  options: ts.CompilerOptions;
  /** Arquivo de configuração usado (relativo à raiz), se houver. */
  configFile?: string;
  diagnostics: Diagnostic[];
}

/**
 * Lê `tsconfig.json` ou `jsconfig.json` da raiz apenas para aproveitar as opções de
 * resolução (paths, baseUrl, moduleResolution, jsx). A lista de arquivos é sempre a
 * descoberta pelo Teia. Ler a configuração não executa nada do projeto.
 */
export function loadCompilerOptions(root: string): LoadedCompilerOptions {
  const diagnostics: Diagnostic[] = [];
  const defaults: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    esModuleInterop: true,
    resolveJsonModule: true,
  };
  const enforced: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    // plugins de linguagem nunca são carregados, mas removemos por clareza
    plugins: [],
  };

  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) continue;
    const read = ts.readConfigFile(file, ts.sys.readFile);
    if (read.error) {
      diagnostics.push({
        level: 'warning',
        code: 'invalid-config',
        message: `Não foi possível ler ${name}: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`,
        file: name,
      });
      continue;
    }
    // readDirectory vazio: não precisamos que o TypeScript expanda "include"
    const host: ts.ParseConfigHost = { ...ts.sys, readDirectory: () => [] };
    const parsed = ts.parseJsonConfigFileContent(read.config, host, root, undefined, file);
    const options: ts.CompilerOptions = { ...parsed.options };
    // projetos sem moduleResolution moderna resolvem pior extensões e index; usamos Bundler
    const mr = options.moduleResolution;
    if (mr === undefined || mr === ts.ModuleResolutionKind.Classic) {
      options.moduleResolution = ts.ModuleResolutionKind.Bundler;
      if (options.module === undefined || options.module === ts.ModuleKind.CommonJS)
        options.module = ts.ModuleKind.ESNext;
    }
    return { options: { ...defaults, ...options, ...enforced }, configFile: name, diagnostics };
  }
  return { options: { ...defaults, ...enforced }, diagnostics };
}

/** Nome do pacote a partir de um especificador: `@scope/pkg/sub` → `@scope/pkg`. */
export function packageNameOf(specifier: string): string {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0] ?? specifier;
}

export function isBuiltinModule(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  return BUILTINS.has(packageNameOf(specifier)) || BUILTINS.has(specifier);
}

const isRelativeOrAbsolute = (s: string) =>
  s.startsWith('.') || s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s);

export type ResolvedTarget =
  | { kind: 'file'; absolute: string }
  | { kind: 'asset'; absolute: string }
  | { kind: 'package'; name: string; builtin: boolean; declared: boolean; outsideRoot?: boolean }
  | { kind: 'unresolved'; reason: 'module-not-found' | 'undeclared-package' };

/** Resolve especificadores de módulo usando o algoritmo do próprio compilador TypeScript. */
export class ModuleResolver {
  private readonly cache: ts.ModuleResolutionCache;
  private readonly declared: Set<string>;

  constructor(
    private readonly root: string,
    private readonly options: ts.CompilerOptions,
  ) {
    this.cache = ts.createModuleResolutionCache(root, (f) => f, options);
    this.declared = readDeclaredDependencies(root);
  }

  resolve(specifier: string, fromAbsolute: string): ResolvedTarget {
    if (isBuiltinModule(specifier)) {
      const name = specifier.startsWith('node:') ? specifier : `node:${packageNameOf(specifier)}`;
      return { kind: 'package', name, builtin: true, declared: true };
    }
    const result = ts.resolveModuleName(specifier, fromAbsolute, this.options, ts.sys, this.cache);
    const resolved = result.resolvedModule;
    if (resolved) {
      const file = toPosix(resolved.resolvedFileName);
      const insideRoot = file === this.root || file.startsWith(`${this.root}/`);
      if (resolved.isExternalLibraryImport || file.includes('/node_modules/')) {
        const name = packageNameOf(specifier);
        return { kind: 'package', name, builtin: false, declared: this.declared.has(name) };
      }
      if (insideRoot) return { kind: 'file', absolute: file };
      return {
        kind: 'package',
        name: specifier,
        builtin: false,
        declared: false,
        outsideRoot: true,
      };
    }
    if (isRelativeOrAbsolute(specifier)) {
      // arquivos que não são código (css, svg, imagens...) existem, mas não são analisados
      const candidate = path.resolve(path.dirname(fromAbsolute), specifier);
      const posix = toPosix(candidate);
      if (
        posix.startsWith(`${this.root}/`) &&
        fs.existsSync(candidate) &&
        fs.lstatSync(candidate).isFile()
      ) {
        return { kind: 'asset', absolute: posix };
      }
      return { kind: 'unresolved', reason: 'module-not-found' };
    }
    const name = packageNameOf(specifier);
    if (this.declared.has(name)) return { kind: 'package', name, builtin: false, declared: true };
    return { kind: 'unresolved', reason: 'undeclared-package' };
  }
}

/** Dependências declaradas no package.json da raiz (apenas leitura do JSON). */
function readDeclaredDependencies(root: string): Set<string> {
  const names = new Set<string>();
  const file = path.join(root, 'package.json');
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return names;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      const deps = pkg[field];
      if (deps && typeof deps === 'object') for (const name of Object.keys(deps)) names.add(name);
    }
    if (typeof pkg.name === 'string') names.add(pkg.name);
  } catch {
    // sem package.json ou JSON inválido
  }
  return names;
}
