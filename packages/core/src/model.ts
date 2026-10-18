/**
 * Modelo de dados do Rastro.
 *
 * O grafo é a fonte da verdade: cada nó é uma entidade do código (arquivo, função, classe...)
 * e cada relação aponta para as evidências (arquivo + linha) que a sustentam.
 * Nada aqui depende de Node.js, para que a interface web possa reutilizar os tipos.
 */

export const SCHEMA_VERSION = '0.1.0';

export const NODE_KINDS = [
  'module',
  'file',
  'function',
  'class',
  'method',
  'route',
  'package',
  'unresolved',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  'contains',
  'imports',
  'exports',
  'calls',
  'extends',
  'depends_on',
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/**
 * - `resolved`: o destino foi localizado dentro do projeto.
 * - `external`: o destino é um pacote externo ou módulo nativo (fora do projeto).
 * - `unresolved`: a referência existe no código, mas o destino não pôde ser comprovado.
 */
export const RESOLUTIONS = ['resolved', 'external', 'unresolved'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/**
 * - `static-ast`: lido diretamente da árvore sintática (ex.: declaração de import).
 * - `static-typecheck`: confirmado pelo verificador de tipos do TypeScript (resolução de símbolo).
 * - `derived`: calculado a partir de outras relações (ex.: dependência entre módulos).
 * - `framework-rule`: identificado por uma regra de framework explicitamente suportada.
 */
export const DISCOVERY_METHODS = [
  'static-ast',
  'static-typecheck',
  'derived',
  'framework-rule',
] as const;
export type DiscoveryMethod = (typeof DISCOVERY_METHODS)[number];

export type Language = 'ts' | 'tsx' | 'js' | 'jsx';

/** Posição no código. Linhas e colunas começam em 1. */
export interface SourceRange {
  /** Caminho relativo à raiz do projeto, sempre com `/`. */
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** Trecho de código que sustenta uma relação. */
export interface Evidence {
  file: string;
  line: number;
  column: number;
  /** Linha de código (aparada e truncada) onde a relação aparece. */
  snippet?: string;
}

export interface NodeMeta {
  language?: Language;
  exported?: boolean;
  defaultExport?: boolean;
  async?: boolean;
  static?: boolean;
  /** Para métodos: `method`, `constructor`, `getter`, `setter`, `property`. */
  memberKind?: 'method' | 'constructor' | 'getter' | 'setter' | 'property';
  /** Para arquivos: `false` quando o arquivo é referenciado mas não é código analisado (ex.: .css, .json). */
  analyzed?: boolean;
  /** Para pacotes: o destino foi resolvido fora da raiz analisada. */
  outsideRoot?: boolean;
  /** Para arquivos: número de linhas. */
  lines?: number;
  /** Para arquivos: nomes exportados pelo módulo. */
  exportNames?: string[];
  /** Para arquivos e módulos: participa de um ciclo de importação. */
  inCycle?: boolean;
  /** Para pacotes: módulo nativo do Node.js. */
  builtin?: boolean;
  /** Para pacotes: declarado no package.json do projeto. */
  declared?: boolean;
  /** Para rotas: método HTTP e caminho como escrito no código (sem prefixos de montagem). */
  httpMethod?: string;
  routePath?: string;
  /** Para rotas: `express`, `fastify`, `hono`, `nestjs` ou `next`. */
  framework?: string;
  /**
   * Para rotas: caminho completo, com os prefixos de montagem (`app.use('/api', router)`,
   * `register(plugin, { prefix })`, `app.route('/api', sub)`, prefixo global do NestJS).
   * Só existe quando o caminho é comprovado e único.
   */
  fullPath?: string;
  /** Para rotas: prefixos completos onde o roteador foi montado (quando há montagem). */
  mountedAt?: string[];
  /** Para rotas do Next.js: `page` (página) ou `api` (rota de API). */
  routeKind?: 'page' | 'api';
  /** Para nós não resolvidos: por que não foi possível resolver. */
  reason?: UnresolvedReason;
  /**
   * Para funções, classes e métodos: quantas vezes o nome aparece como palavra no código
   * analisado (incluindo a própria declaração). Base para "possivelmente sem uso": um nome
   * citado uma única vez só existe na declaração.
   */
  mentions?: number;
  /** Para nós não resolvidos: o texto original da referência. */
  reference?: string;
  /**
   * Para chamadas não resolvidas por interface ou método abstrato: ids das implementações
   * _possíveis_ no projeto (métodos de classes que declaram `implements` da interface, ou que
   * estendem a classe abstrata). Nunca são relações resolvidas: o alvo real só existe em execução.
   */
  candidates?: string[];
  /** Para classes: interfaces (ou classes) da cláusula `implements`, como escritas no código. */
  implements?: string[];
}

export type UnresolvedReason =
  | 'module-not-found'
  | 'undeclared-package'
  | 'symbol-not-found'
  | 'indirect-call'
  | 'dynamic-import'
  | 'unknown-base-class'
  | 'not-analyzed';

export interface GraphNode {
  /** Identificador estável e legível, ex.: `fn:src/math.ts#sum`. */
  id: string;
  kind: NodeKind;
  /** Nome curto exibido na interface. */
  name: string;
  /** Nome qualificado, ex.: `UserService.create`. */
  qualifiedName?: string;
  /** Nó que contém este nó (módulo → arquivo → classe → método). */
  parent?: string;
  location?: SourceRange;
  meta?: NodeMeta;
}

export interface EdgeMeta {
  /** Especificador original do import/require. */
  specifier?: string;
  /** `import type` / `export type`. */
  typeOnly?: boolean;
  /** `import()` dinâmico ou `require()`. */
  importKind?: 'static' | 'dynamic' | 'require' | 're-export';
  /** Nomes importados/exportados. */
  names?: string[];
  /** Para chamadas: tipo de chamada. */
  callKind?: 'call' | 'new' | 'jsx' | 'route-handler';
  /** Para exports que reexportam entidades de outro arquivo. */
  reexport?: boolean;
  /** Nome sob o qual a entidade é exportada. */
  exportedAs?: string;
  /**
   * A relação foi ligada mapeando um `.d.ts` compilado de um pacote do workspace
   * (ex.: `packages/x/dist/a.d.ts`) para o código-fonte correspondente (`packages/x/src/a.ts`).
   */
  viaDeclaration?: boolean;
  /** Quantas vezes a relação foi observada (as evidências podem ser truncadas). */
  count?: number;
}

export interface GraphEdge {
  /** Identificador estável: `<kind>:<source>-><target>`. */
  id: string;
  kind: EdgeKind;
  source: string;
  target: string;
  resolution: Resolution;
  discovery: DiscoveryMethod;
  evidence: Evidence[];
  meta?: EdgeMeta;
}

export interface Diagnostic {
  level: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  file?: string;
  line?: number;
}

export interface GraphStats {
  files: number;
  nodesByKind: Partial<Record<NodeKind, number>>;
  edgesByKind: Partial<Record<EdgeKind, number>>;
  edgesByResolution: Partial<Record<Resolution, number>>;
  /** Ciclos de importação entre arquivos (cada item é uma lista de ids de arquivo). */
  importCycles: string[][];
  /** Chamadas que não foram registradas no grafo porque o alvo está fora do projeto (ex.: `console.log`). */
  externalCallsSkipped: number;
  /** Chamadas cujo receptor não tem tipo conhecido (ex.: `obj.metodo()` em JS sem tipos). */
  unknownReceiverCalls: number;
  /** Chamadas por acesso computado, ex.: `obj[nome]()`. */
  computedCalls: number;
  /** Chamadas a funções declaradas dentro de outra função (escopo local, sem nó próprio). */
  localCalls: number;
  durationMs: number;
}

export interface ProjectInfo {
  name: string;
  /** Caminho absoluto da raiz analisada (usado para abrir arquivos no editor). */
  root: string;
  languages: Language[];
  /** Arquivo de configuração do TypeScript/JavaScript usado, se houver. */
  tsconfig?: string;
}

export interface AnalyzerInfo {
  name: string;
  version: string;
  /** Versão do compilador TypeScript usado pelo ts-morph. */
  typescriptVersion: string;
  options: {
    exclude: string[];
    respectGitignore: boolean;
    maxFiles: number;
    maxFileSizeBytes: number;
  };
}

/** Um arquivo alterado segundo o git, com as linhas novas/alteradas (1-based, inclusivas). */
export interface ChangedFile {
  /** Caminho relativo à raiz analisada, com `/`. */
  file: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Caminho anterior, quando renomeado. */
  previous?: string;
  /** Intervalos de linhas alteradas no arquivo atual; vazio para arquivos removidos. */
  ranges: Array<[number, number]>;
  /** Linhas (no arquivo atual) logo após trechos apenas removidos. */
  deletionsAt?: number[];
}

/** Mudanças em relação a uma referência do git (opcional: só com `rastro --changes`/`--since`). */
export interface ChangeSet {
  /** Referência comparada: `HEAD` (mudanças locais) ou o commit base de `--since`. */
  base: string;
  /** Rótulo legível da base (ex.: `main`, `HEAD`). */
  baseLabel: string;
  /** Inclui arquivos ainda não versionados. */
  includesUntracked: boolean;
  files: ChangedFile[];
}

export interface RastroGraph {
  schemaVersion: typeof SCHEMA_VERSION;
  generatedAt: string;
  tool: { name: 'rastro'; version: string };
  project: ProjectInfo;
  analyzer: AnalyzerInfo;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
  diagnostics: Diagnostic[];
  /** Mudanças do git, quando a análise foi feita com `--changes` ou `--since`. */
  changes?: ChangeSet;
}
