import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { ts } from 'ts-morph';
import type { Diagnostic } from '@rastro/core';
import { toPosix } from './discover.js';

const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith('_')));

/** Opções de um tsconfig referenciado, válidas só para os arquivos que ele inclui. */
export interface ConfigScope {
  name: string;
  files: Set<string>;
  options: ts.CompilerOptions;
}

export interface LoadedCompilerOptions {
  options: ts.CompilerOptions;
  /** tsconfig referenciados (ex.: tsconfig.app.json): cada um resolve os imports dos seus arquivos. */
  scopes: ConfigScope[];
  /** Arquivo de configuração usado (relativo à raiz), se houver. */
  configFile?: string;
  diagnostics: Diagnostic[];
}

const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'];

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  esModuleInterop: true,
  resolveJsonModule: true,
};

const ENFORCED_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  noEmit: true,
  skipLibCheck: true,
  // plugins de linguagem nunca são carregados, mas removemos por clareza
  plugins: [],
};

interface ParsedConfig {
  /** Opções finais (padrões + configuração + opções impostas pelo Rastro). */
  options: ts.CompilerOptions;
  scopes: ConfigScope[];
  /** tsconfig referenciados (relativos à raiz). */
  referenced: string[];
}

/**
 * Lê `tsconfig.json`/`jsconfig.json` da raiz apenas para aproveitar as opções de
 * resolução (paths, baseUrl, moduleResolution, jsx). A lista de arquivos é sempre a
 * descoberta pelo Rastro. Ler a configuração não executa nada do projeto.
 * Os tsconfig de subpastas (subpacotes de um monorepo) são lidos sob demanda pelo `ModuleResolver`.
 */
export function loadCompilerOptions(root: string): LoadedCompilerOptions {
  const diagnostics: Diagnostic[] = [];
  for (const name of CONFIG_NAMES) {
    const file = path.join(root, name);
    if (!isConfigFile(file)) continue;
    const parsed = parseConfigFile(root, file);
    if ('error' in parsed) {
      diagnostics.push({
        level: 'warning',
        code: 'invalid-config',
        message: `Não foi possível ler ${name}: ${parsed.error}`,
        file: name,
      });
      continue;
    }
    const { options, scopes, referenced } = parsed;
    const configFile = referenced.length ? `${name} (+ ${referenced.join(', ')})` : name;
    return { options, scopes, configFile, diagnostics };
  }
  return { options: { ...DEFAULT_OPTIONS, ...ENFORCED_OPTIONS }, scopes: [], diagnostics };
}

/** Arquivo de configuração existente e que não é link simbólico. */
function isConfigFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

/** Lê um tsconfig/jsconfig (seguindo `extends` e `references`) só pelas opções de resolução. */
function parseConfigFile(root: string, file: string): ParsedConfig | { error: string } {
  const read = ts.readConfigFile(file, ts.sys.readFile);
  if (read.error) return { error: ts.flattenDiagnosticMessageText(read.error.messageText, ' ') };
  // readDirectory vazio: não precisamos que o TypeScript expanda "include"
  const host: ts.ParseConfigHost = { ...ts.sys, readDirectory: () => [] };
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    host,
    path.dirname(file),
    undefined,
    file,
  );
  const options: ts.CompilerOptions = { ...parsed.options };
  // tsconfig "solução" (padrão do Vite): `files: []` + `references` para tsconfig.app.json etc.
  // As opções de resolução (paths, baseUrl, jsx) ficam nos arquivos referenciados.
  // Cada referência resolve os imports dos próprios arquivos (escopo). Nas opções gerais (para
  // arquivos fora de todas as referências), só juntamos o que não conflita: dois apps com "@/*"
  // apontando para pastas diferentes não podem ser misturados, ou o grafo inventaria ligações.
  const referenced: string[] = [];
  const scopes: ConfigScope[] = [];
  const mergedPaths: Record<string, { targets: string; base: string | undefined }> = {};
  const conflicts = new Set<string>();
  const settings = {
    jsx: new Set<unknown>(),
    moduleResolution: new Set<unknown>(),
    module: new Set<unknown>(),
  };
  for (const ref of parsed.projectReferences ?? []) {
    const refFile = ts.resolveProjectReferencePath(ref);
    if (!refFile.startsWith(`${root}${path.sep}`) && !refFile.startsWith(`${root}/`)) continue;
    if (!isConfigFile(refFile)) continue;
    const refRead = ts.readConfigFile(refFile, ts.sys.readFile);
    if (refRead.error) continue;
    // aqui sim expandimos "include" para saber quais arquivos pertencem a cada referência
    const refParsed = ts.parseJsonConfigFileContent(
      refRead.config,
      ts.sys,
      path.dirname(refFile),
      undefined,
      refFile,
    );
    const refOptions = refParsed.options as ts.CompilerOptions & { pathsBasePath?: string };
    scopes.push({
      name: toPosix(path.relative(root, refFile)),
      files: new Set(refParsed.fileNames.map((f) => toPosix(path.resolve(f)))),
      options: withModernResolution({ ...DEFAULT_OPTIONS, ...refOptions, ...ENFORCED_OPTIONS }),
    });
    for (const [key, targets] of Object.entries(refOptions.paths ?? {})) {
      const entry = {
        targets: JSON.stringify(targets),
        base: refOptions.pathsBasePath ?? refOptions.baseUrl,
      };
      const previous = mergedPaths[key];
      if (previous && (previous.targets !== entry.targets || previous.base !== entry.base))
        conflicts.add(key);
      else mergedPaths[key] = entry;
    }
    settings.jsx.add(refOptions.jsx);
    settings.moduleResolution.add(refOptions.moduleResolution);
    settings.module.add(refOptions.module);
    referenced.push(toPosix(path.relative(root, refFile)));
  }
  if (scopes.length) {
    const paths: ts.MapLike<string[]> = { ...options.paths };
    let base: string | undefined;
    for (const [key, entry] of Object.entries(mergedPaths)) {
      if (conflicts.has(key) || paths[key]) continue;
      if (base !== undefined && entry.base !== base) continue;
      base = entry.base;
      paths[key] = JSON.parse(entry.targets) as string[];
    }
    if (Object.keys(paths).length) {
      options.paths = paths;
      if (base) (options as { pathsBasePath?: string }).pathsBasePath ??= base;
    }
    // configurações de módulo só valem para todos quando as referências concordam
    const single = <T>(values: Set<unknown>) =>
      values.size === 1 ? ([...values][0] as T | undefined) : undefined;
    options.jsx ??= single<ts.JsxEmit>(settings.jsx);
    options.moduleResolution ??= single<ts.ModuleResolutionKind>(settings.moduleResolution);
    options.module ??= single<ts.ModuleKind>(settings.module);
  }
  // projetos sem moduleResolution moderna resolvem pior extensões e index; usamos Bundler
  withModernResolution(options);
  return {
    options: { ...DEFAULT_OPTIONS, ...options, ...ENFORCED_OPTIONS },
    scopes,
    referenced,
  };
}

/** Projetos sem moduleResolution moderna resolvem pior extensões e index; usamos Bundler. */
function withModernResolution(options: ts.CompilerOptions): ts.CompilerOptions {
  const mr = options.moduleResolution;
  if (mr === undefined || mr === ts.ModuleResolutionKind.Classic) {
    options.moduleResolution = ts.ModuleResolutionKind.Bundler;
    if (options.module === undefined || options.module === ts.ModuleKind.CommonJS)
      options.module = ts.ModuleKind.ESNext;
  }
  return options;
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

interface ResolutionConfig {
  options: ts.CompilerOptions;
  cache: ts.ModuleResolutionCache;
}

/** Configuração que vale para uma pasta: a do tsconfig mais próximo (ou a da raiz). */
interface DirConfig extends ResolutionConfig {
  scopes: Array<ConfigScope & ResolutionConfig>;
}

const NODE_MODULES_SEGMENT = /\/node_modules(\/|$)/;

/**
 * Resolve especificadores de módulo usando o algoritmo do próprio compilador TypeScript.
 * Cada arquivo usa as opções do tsconfig que o inclui (referências da raiz) ou do
 * `tsconfig.json`/`jsconfig.json` mais próximo, subindo até a raiz: em um monorepo, cada
 * subpacote resolve os próprios aliases (`paths`/`baseUrl`). A busca é feita uma vez por pasta.
 */
export class ModuleResolver {
  private readonly declaredByDir = new Map<string, DeclaredPackage>();
  private readonly base: DirConfig;
  /** Pasta (absoluta, com `/`) → configuração que vale para ela. */
  private readonly configByDir = new Map<string, DirConfig>();
  /** tsconfig de subpastas efetivamente usados (relativos à raiz). */
  private readonly nested: string[] = [];

  constructor(
    private readonly root: string,
    options: ts.CompilerOptions,
    scopes: ConfigScope[] = [],
    /** Recebe avisos de tsconfig de subpastas inválidos. */
    private readonly diagnostics: Diagnostic[] = [],
  ) {
    this.base = { ...this.withCache(options), scopes: scopes.map((s) => this.withScopeCache(s)) };
    this.configByDir.set(root, this.base);
  }

  private withCache(options: ts.CompilerOptions): ResolutionConfig {
    return { options, cache: ts.createModuleResolutionCache(this.root, (f) => f, options) };
  }

  private withScopeCache(scope: ConfigScope): ConfigScope & ResolutionConfig {
    return { ...scope, ...this.withCache(scope.options) };
  }

  /** tsconfig de subpastas (subpacotes) usados até agora, relativos à raiz. */
  nestedConfigs(): string[] {
    return [...this.nested].sort();
  }

  /**
   * Opções para resolver os imports de um arquivo: o tsconfig referenciado pela raiz que o
   * inclui, senão o tsconfig mais próximo (e as referências dele), senão o da raiz.
   */
  private configFor(fromAbsolute: string): ResolutionConfig {
    const rootScope = this.base.scopes.find((s) => s.files.has(fromAbsolute));
    if (rootScope) return rootScope;
    const dir = this.nearestConfig(path.posix.dirname(fromAbsolute));
    return dir.scopes.find((s) => s.files.has(fromAbsolute)) ?? dir;
  }

  private nearestConfig(dir: string): DirConfig {
    const visited: string[] = [];
    let found: DirConfig = this.base;
    for (let cur = dir; ; cur = path.posix.dirname(cur)) {
      const cached = this.configByDir.get(cur);
      if (cached) {
        found = cached;
        break;
      }
      // fora da raiz ou dentro de node_modules: tsconfig de terceiros nunca são usados
      if (
        !cur.startsWith(`${this.root}/`) ||
        NODE_MODULES_SEGMENT.test(cur.slice(this.root.length))
      )
        break;
      visited.push(cur);
      const own = this.readDirConfig(cur);
      if (own) {
        found = own;
        break;
      }
      if (path.posix.dirname(cur) === cur) break;
    }
    for (const d of visited) this.configByDir.set(d, found);
    return found;
  }

  private readDirConfig(dir: string): DirConfig | undefined {
    for (const name of CONFIG_NAMES) {
      const file = path.join(dir, name);
      if (!isConfigFile(file)) continue;
      const rel = toPosix(path.relative(this.root, file));
      const parsed = parseConfigFile(this.root, file);
      if ('error' in parsed) {
        this.diagnostics.push({
          level: 'warning',
          code: 'invalid-config',
          message: `Não foi possível ler ${rel}: ${parsed.error}`,
          file: rel,
        });
        continue;
      }
      this.nested.push(rel);
      return {
        ...this.withCache(parsed.options),
        scopes: parsed.scopes.map((s) => this.withScopeCache(s)),
      };
    }
    return undefined;
  }

  /**
   * Resolução usada pelo programa do TypeScript (e, portanto, pelo verificador de tipos que
   * liga chamadas): as mesmas opções por arquivo de `resolve`, para que um alias de subpacote
   * leve a chamada ao arquivo certo.
   */
  resolveForProgram(
    specifier: string,
    containingFile: string,
    mode?: ts.ResolutionMode,
  ): ts.ResolvedModuleFull | undefined {
    const config = this.configFor(toPosix(containingFile));
    return ts.resolveModuleName(
      specifier,
      containingFile,
      config.options,
      ts.sys,
      config.cache,
      undefined,
      mode,
    ).resolvedModule;
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
    const config = this.configFor(fromAbsolute);
    const result = ts.resolveModuleName(
      specifier,
      fromAbsolute,
      config.options,
      ts.sys,
      config.cache,
    );
    const resolved = result.resolvedModule;
    if (resolved) {
      const file = toPosix(resolved.resolvedFileName);
      const insideRoot = file.startsWith(`${this.root}/`);
      // testado no caminho relativo: a própria raiz pode estar dentro de um node_modules
      const inNodeModules = (insideRoot ? file.slice(this.root.length) : file).includes(
        '/node_modules/',
      );
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
    return (
      this.findPackageDir(fromAbsolute, (pkg) => pkg.deps.has(name) || pkg.name === name) !==
      undefined
    );
  }

  /**
   * Pasta (absoluta, com `/`) do package.json mais próximo do arquivo, até a raiz, que declara
   * `name` como dependência (o nome do próprio pacote não conta). Só lê os JSON, nada é executado.
   */
  packageDirDeclaring(name: string, fromAbsolute: string): string | undefined {
    return this.findPackageDir(fromAbsolute, (pkg) => pkg.deps.has(name));
  }

  private findPackageDir(
    fromAbsolute: string,
    matches: (pkg: DeclaredPackage) => boolean,
  ): string | undefined {
    for (let dir = path.dirname(fromAbsolute); ; dir = path.dirname(dir)) {
      const posix = toPosix(dir);
      if (posix !== this.root && !posix.startsWith(`${this.root}/`)) return undefined;
      let pkg = this.declaredByDir.get(posix);
      if (!pkg) this.declaredByDir.set(posix, (pkg = readDeclaredDependencies(dir)));
      if (matches(pkg)) return posix;
      if (posix === this.root || path.dirname(dir) === dir) return undefined;
    }
  }
}

interface DeclaredPackage {
  /** Dependências declaradas (dependencies, devDependencies, peer e optional). */
  deps: Set<string>;
  /** Nome do próprio pacote. */
  name?: string;
}

/** Dependências declaradas no package.json de uma pasta (apenas leitura do JSON). */
function readDeclaredDependencies(root: string): DeclaredPackage {
  const deps = new Set<string>();
  const file = path.join(root, 'package.json');
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return { deps };
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      const declared = pkg[field];
      if (declared && typeof declared === 'object')
        for (const name of Object.keys(declared)) deps.add(name);
    }
    return typeof pkg.name === 'string' ? { deps, name: pkg.name } : { deps };
  } catch {
    // sem package.json ou JSON inválido
    return { deps };
  }
}
