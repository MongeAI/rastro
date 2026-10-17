import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { ts } from 'ts-morph';
import type { Diagnostic } from '@rastro/core';
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
 * descoberta pelo Rastro. Ler a configuração não executa nada do projeto.
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
    // tsconfig "solução" (padrão do Vite): `files: []` + `references` para tsconfig.app.json etc.
    // As opções de resolução (paths, baseUrl, jsx) ficam nos arquivos referenciados.
    const referenced: string[] = [];
    for (const ref of parsed.projectReferences ?? []) {
      const refFile = ts.resolveProjectReferencePath(ref);
      if (!refFile.startsWith(`${root}${path.sep}`) && !refFile.startsWith(`${root}/`)) continue;
      if (!fs.existsSync(refFile) || fs.lstatSync(refFile).isSymbolicLink()) continue;
      const refRead = ts.readConfigFile(refFile, ts.sys.readFile);
      if (refRead.error) continue;
      const refParsed = ts.parseJsonConfigFileContent(
        refRead.config,
        host,
        path.dirname(refFile),
        undefined,
        refFile,
      );
      const { paths, baseUrl, pathsBasePath, jsx, moduleResolution, module, rootDirs } =
        refParsed.options as ts.CompilerOptions & { pathsBasePath?: string };
      if (paths) {
        options.paths = { ...paths, ...options.paths };
        (options as { pathsBasePath?: string }).pathsBasePath ??= pathsBasePath;
        options.baseUrl ??= baseUrl;
      }
      options.jsx ??= jsx;
      options.moduleResolution ??= moduleResolution;
      options.module ??= module;
      options.rootDirs ??= rootDirs;
      referenced.push(path.relative(root, refFile));
    }
    // projetos sem moduleResolution moderna resolvem pior extensões e index; usamos Bundler
    const mr = options.moduleResolution;
    if (mr === undefined || mr === ts.ModuleResolutionKind.Classic) {
      options.moduleResolution = ts.ModuleResolutionKind.Bundler;
      if (options.module === undefined || options.module === ts.ModuleKind.CommonJS)
        options.module = ts.ModuleKind.ESNext;
    }
    const configFile = referenced.length ? `${name} (+ ${referenced.join(', ')})` : name;
    return { options: { ...defaults, ...options, ...enforced }, configFile, diagnostics };
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
  private readonly declaredByDir = new Map<string, Set<string>>();

  constructor(
    private readonly root: string,
    private readonly options: ts.CompilerOptions,
  ) {
    this.cache = ts.createModuleResolutionCache(root, (f) => f, options);
  }

  resolve(specifier: string, fromAbsolute: string): ResolvedTarget {
    const builtin = (): ResolvedTarget => ({
      kind: 'package',
      name: specifier.startsWith('node:') ? specifier : `node:${packageNameOf(specifier)}`,
      builtin: true,
      declared: true,
    });
    // `node:fs` é sempre nativo; já `constants`/`events` podem ser pastas do projeto (baseUrl)
    if (specifier.startsWith('node:')) return builtin();
    const result = ts.resolveModuleName(specifier, fromAbsolute, this.options, ts.sys, this.cache);
    const resolved = result.resolvedModule;
    if (resolved) {
      const file = toPosix(resolved.resolvedFileName);
      const insideRoot = file.startsWith(`${this.root}/`);
      const inNodeModules = file.includes('/node_modules/');
      if (isBuiltinModule(specifier) && (!insideRoot || inNodeModules)) return builtin();
      // pacotes do workspace chegam via link em node_modules (isExternalLibraryImport = true),
      // mas o caminho real fica dentro do projeto: decidimos pelo caminho real
      if (inNodeModules || (resolved.isExternalLibraryImport && !insideRoot)) {
        const name = packageNameOf(specifier);
        return {
          kind: 'package',
          name,
          builtin: false,
          declared: this.isDeclared(name, fromAbsolute),
        };
      }
      if (insideRoot) return { kind: 'file', absolute: file };
      // fora da raiz analisada: identificado pelo caminho, para não juntar destinos diferentes
      return {
        kind: 'package',
        name: toPosix(path.relative(this.root, file)),
        builtin: false,
        declared: false,
        outsideRoot: true,
      };
    }
    if (isBuiltinModule(specifier)) return builtin();
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
    if (this.isDeclared(name, fromAbsolute))
      return { kind: 'package', name, builtin: false, declared: true };
    return { kind: 'unresolved', reason: 'undeclared-package' };
  }

  /** O pacote está declarado no package.json mais próximo do arquivo (ou em algum acima, até a raiz)? */
  private isDeclared(name: string, fromAbsolute: string): boolean {
    for (let dir = path.dirname(fromAbsolute); ; dir = path.dirname(dir)) {
      const posix = toPosix(dir);
      if (posix !== this.root && !posix.startsWith(`${this.root}/`)) return false;
      let deps = this.declaredByDir.get(posix);
      if (!deps) this.declaredByDir.set(posix, (deps = readDeclaredDependencies(dir)));
      if (deps.has(name)) return true;
      if (posix === this.root || path.dirname(dir) === dir) return false;
    }
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
