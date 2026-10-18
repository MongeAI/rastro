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

/**
 * Arquivos que influenciam a resolução de módulos (tsconfig/jsconfig, inclusive os procurados e
 * ausentes, `extends`, package.json lidos pelo compilador) → carimbo de quando foram lidos.
 * O modo `--watch` recria o compilador quando algum deles muda.
 */
export type InputStamps = Map<string, string>;

/** `mtime:tamanho:tipo` do arquivo (sem seguir o link no último nível), ou `-` se não existe. */
export function fileStamp(file: string): string {
  try {
    const stat = fs.lstatSync(file);
    return `${stat.mtimeMs}:${stat.size}:${stat.isFile() ? 'f' : 'o'}`;
  } catch {
    return '-';
  }
}

/** Registra um arquivo lido (o carimbo é o do primeiro acesso). */
function track(inputs: InputStamps | undefined, file: string): void {
  if (!inputs) return;
  const key = toPosix(path.resolve(file));
  if (!inputs.has(key)) inputs.set(key, fileStamp(key));
}

export interface LoadedCompilerOptions {
  options: ts.CompilerOptions;
  /** tsconfig referenciados (ex.: tsconfig.app.json): cada um resolve os imports dos seus arquivos. */
  scopes: ConfigScope[];
  /** Arquivo de configuração usado (relativo à raiz), se houver. */
  configFile?: string;
  diagnostics: Diagnostic[];
  /** Arquivos de configuração procurados ou lidos (com carimbo). */
  inputs: InputStamps;
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
  const inputs: InputStamps = new Map();
  for (const name of CONFIG_NAMES) {
    const file = path.join(root, name);
    track(inputs, file);
    if (!isConfigFile(file)) continue;
    const parsed = parseConfigFile(root, file, inputs);
    if ('error' in parsed) {
      diagnostics.push({
        level: 'warning',
        code: 'invalid-config',
        message: `Não foi possível ler ${name}: ${parsed.error}`,
        file: name,
        params: { config: name, error: parsed.error },
      });
      continue;
    }
    const { options, scopes, referenced } = parsed;
    const configFile = referenced.length ? `${name} (+ ${referenced.join(', ')})` : name;
    return { options, scopes, configFile, diagnostics, inputs };
  }
  return { options: { ...DEFAULT_OPTIONS, ...ENFORCED_OPTIONS }, scopes: [], diagnostics, inputs };
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
function parseConfigFile(
  root: string,
  file: string,
  inputs?: InputStamps,
): ParsedConfig | { error: string } {
  // cada arquivo lido (o próprio, `extends`, referências) é registrado para o modo --watch
  const readFile = (f: string) => {
    track(inputs, f);
    return ts.sys.readFile(f);
  };
  const read = ts.readConfigFile(file, readFile);
  if (read.error) return { error: ts.flattenDiagnosticMessageText(read.error.messageText, ' ') };
  // readDirectory vazio: não precisamos que o TypeScript expanda "include"
  const host: ts.ParseConfigHost = { ...ts.sys, readFile, readDirectory: () => [] };
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
    track(inputs, refFile);
    if (!isConfigFile(refFile)) continue;
    const refRead = ts.readConfigFile(refFile, readFile);
    if (refRead.error) continue;
    // aqui sim expandimos "include" para saber quais arquivos pertencem a cada referência
    const refParsed = ts.parseJsonConfigFileContent(
      refRead.config,
      { ...ts.sys, readFile },
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
  /** Arquivo → pacote do qual ele é o ponto de entrada (ver `packageEntryName`). */
  private readonly entryNames = new Map<string, string | undefined>();
  private readonly base: DirConfig;
  /** Pasta (absoluta, com `/`) → configuração que vale para ela. */
  private readonly configByDir = new Map<string, DirConfig>();
  /** tsconfig de subpastas efetivamente usados (relativos à raiz). */
  private readonly nested: string[] = [];
  /**
   * Configurações procuradas (inclusive ausentes) e package.json lidos pelo compilador ao
   * resolver módulos, com o carimbo da leitura: se mudarem, a resolução feita pode mudar.
   */
  readonly inputs: InputStamps = new Map();
  /** Mesmo sistema de arquivos do TypeScript, registrando os arquivos lidos. */
  private readonly host: ts.ModuleResolutionHost = {
    fileExists: (f) => ts.sys.fileExists(f),
    directoryExists: (d) => ts.sys.directoryExists(d),
    realpath: ts.sys.realpath && ((p) => ts.sys.realpath!(p)),
    getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
    getDirectories: (d) => ts.sys.getDirectories(d),
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readFile: (f) => {
      track(this.inputs, f);
      return ts.sys.readFile(f);
    },
  };

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
      track(this.inputs, file);
      if (!isConfigFile(file)) continue;
      const rel = toPosix(path.relative(this.root, file));
      const parsed = parseConfigFile(this.root, file, this.inputs);
      if ('error' in parsed) {
        this.diagnostics.push({
          level: 'warning',
          code: 'invalid-config',
          message: `Não foi possível ler ${rel}: ${parsed.error}`,
          file: rel,
          params: { config: rel, error: parsed.error },
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
      this.host,
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
      this.host,
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
    const alias = this.resolvePathAlias(specifier, config.options);
    if (alias === 'asset-missing') {
      // alias do projeto (ex.: `@/gerado/x` de código gerado que não existe): não é um pacote
      const name = packageNameOf(specifier);
      if (this.isDeclared(name, fromAbsolute))
        return { kind: 'package', name, builtin: false, declared: true };
      return { kind: 'unresolved', reason: 'module-not-found' };
    }
    if (alias) return alias;
    const name = packageNameOf(specifier);
    if (this.isDeclared(name, fromAbsolute))
      return { kind: 'package', name, builtin: false, declared: true };
    return { kind: 'unresolved', reason: 'undeclared-package' };
  }

  /**
   * `paths` do tsconfig para o que o compilador não resolve sozinho: arquivos que não são código
   * (`@/styles/globals.css` → `styles/globals.css`, como já acontece com `./x.css`). Um alias
   * que casa mas cujo destino não existe devolve `asset-missing`: é um módulo do projeto que
   * falta, não um pacote npm não declarado. O padrão `*` sozinho (que casa com qualquer pacote)
   * não conta. Destinos fora da raiz ou em node_modules não viram arquivos do projeto.
   */
  private resolvePathAlias(
    specifier: string,
    options: ts.CompilerOptions,
  ): Extract<ResolvedTarget, { kind: 'asset' }> | 'asset-missing' | undefined {
    const base = (options as { pathsBasePath?: string }).pathsBasePath ?? options.baseUrl;
    const best = base ? bestPathPattern(specifier, options.paths) : undefined;
    if (!base || !best) return undefined;
    for (const target of best.targets) {
      const candidate = toPosix(path.resolve(base, target.replace('*', best.captured)));
      if (
        candidate.startsWith(`${this.root}/`) &&
        !NODE_MODULES_SEGMENT.test(candidate.slice(this.root.length)) &&
        isRegularFile(candidate)
      )
        return { kind: 'asset', absolute: candidate };
    }
    return 'asset-missing';
  }

  /**
   * O especificador casa com um padrão de `paths` (fora o `*` sozinho) do tsconfig que vale
   * para o arquivo? Então é um alias do projeto, não o nome de um pacote.
   */
  isPathAlias(specifier: string, fromAbsolute: string): boolean {
    return bestPathPattern(specifier, this.configFor(fromAbsolute).options.paths) !== undefined;
  }

  /**
   * Nome do pacote cujo ponto de entrada (`main`, `exports["."]` ou `index.js` do package.json
   * mais próximo) é exatamente este arquivo. No repositório do próprio framework, os exemplos
   * usam `require('../..')` em vez de `require('express')`: é o mesmo módulo, comprovado pelo
   * package.json. Qualquer outro arquivo do pacote (ex.: `lib/express.js`) não conta.
   */
  packageEntryName(absoluteFile: string): string | undefined {
    if (this.entryNames.has(absoluteFile)) return this.entryNames.get(absoluteFile);
    let found: string | undefined;
    for (let dir = path.posix.dirname(absoluteFile); ; dir = path.posix.dirname(dir)) {
      if (dir !== this.root && !dir.startsWith(`${this.root}/`)) break;
      const manifest = readPackageManifest(dir);
      if (manifest?.name) {
        if (
          packageEntries(manifest).some((entry) =>
            sameFile(path.posix.join(dir, entry), absoluteFile),
          )
        )
          found = manifest.name;
        break;
      }
      if (dir === this.root || path.posix.dirname(dir) === dir) break;
    }
    this.entryNames.set(absoluteFile, found);
    return found;
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

/**
 * Padrão de `paths` que vale para o especificador. Como no compilador, vence o de prefixo mais
 * longo (no empate, o primeiro) e só ele conta: se nenhum destino dele existe, os padrões mais
 * curtos não são tentados (`@/styles/*` sem arquivo não cai em `@/*`). O padrão `*` sozinho (que
 * casa com qualquer pacote) não conta.
 */
function bestPathPattern(
  specifier: string,
  paths: ts.MapLike<string[]> | undefined,
): { captured: string; targets: string[] } | undefined {
  let best: { prefixLength: number; captured: string; targets: string[] } | undefined;
  for (const [pattern, targets] of Object.entries(paths ?? {})) {
    const star = pattern.indexOf('*');
    let match: typeof best;
    if (star === -1) {
      if (pattern === specifier) match = { prefixLength: Infinity, captured: '', targets };
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (
        (prefix || suffix) &&
        specifier.length >= prefix.length + suffix.length &&
        specifier.startsWith(prefix) &&
        specifier.endsWith(suffix)
      )
        match = {
          prefixLength: prefix.length,
          captured: specifier.slice(prefix.length, specifier.length - suffix.length),
          targets,
        };
    }
    if (match && (!best || match.prefixLength > best.prefixLength)) best = match;
  }
  return best;
}

/** Arquivo comum (não segue links simbólicos). */
function isRegularFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

interface PackageManifest {
  name?: string;
  main?: string;
  exports?: unknown;
}

/** package.json de uma pasta (apenas leitura do JSON; links simbólicos são ignorados). */
function readPackageManifest(dir: string): PackageManifest | undefined {
  const file = path.join(dir, 'package.json');
  try {
    if (!fs.lstatSync(file).isFile()) return undefined;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    return {
      ...(typeof pkg.name === 'string' && pkg.name ? { name: pkg.name } : {}),
      ...(typeof pkg.main === 'string' ? { main: pkg.main } : {}),
      exports: pkg.exports,
    };
  } catch {
    return undefined;
  }
}

/** Pontos de entrada declarados: `exports["."]` (texto ou condições), `main`, senão `index.js`. */
function packageEntries(manifest: PackageManifest): string[] {
  const entries: string[] = [];
  const collect = (value: unknown, depth: number) => {
    if (typeof value === 'string') entries.push(value);
    else if (value && typeof value === 'object' && !Array.isArray(value) && depth < 4)
      for (const [key, inner] of Object.entries(value))
        if (!key.startsWith('.') && key !== 'types') collect(inner, depth + 1);
  };
  const exp = manifest.exports;
  if (typeof exp === 'string') entries.push(exp);
  else if (exp && typeof exp === 'object' && !Array.isArray(exp)) {
    const record = exp as Record<string, unknown>;
    // `{ ".": ... }` (subcaminhos) ou só condições (`{ "require": ..., "import": ... }`)
    if ('.' in record) collect(record['.'], 0);
    else collect(record, 0);
  }
  entries.push(manifest.main ?? 'index.js');
  return entries;
}

/** O ponto de entrada (com as extensões que o Node completa) é este arquivo? */
function sameFile(entry: string, absoluteFile: string): boolean {
  const normalized = path.posix.normalize(entry);
  return [normalized, `${normalized}.js`, `${normalized}/index.js`].includes(absoluteFile);
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
