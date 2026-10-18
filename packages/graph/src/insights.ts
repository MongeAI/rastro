import { compareStrings, type GraphNode, type NodeKind } from '@rastro/core';
import type { GraphIndex } from './query.js';

/** Uma entrada de ranking: a entidade e o valor medido. */
export interface RankedNode {
  node: GraphNode;
  value: number;
}

export interface CoupledModules {
  from: GraphNode;
  to: GraphNode;
  /** Quantidade de imports da pasta de origem para a de destino. */
  imports: number;
}

export interface Insights {
  /** Funções/métodos/classes chamados por mais entidades diferentes (fan-in). */
  mostCalled: RankedNode[];
  /** Funções/métodos/rotas que chamam mais entidades diferentes (fan-out). */
  mostCalling: RankedNode[];
  /** Arquivos importados por mais arquivos. */
  mostImported: RankedNode[];
  /** Arquivos que importam mais arquivos do projeto. */
  mostDependencies: RankedNode[];
  /** Maiores arquivos, em linhas. */
  largestFiles: RankedNode[];
  /** Pares de pastas com mais imports entre si. */
  coupledModules: CoupledModules[];
  /**
   * Possivelmente sem uso: ninguém chama e o nome só aparece na própria declaração.
   * `exported` pode ser API pública usada por quem instala o pacote; `internal` não.
   */
  unused: { internal: GraphNode[]; exported: GraphNode[] };
}

const SYMBOLS = new Set<NodeKind>(['function', 'class', 'method']);

/**
 * Métodos chamados implicitamente pela linguagem ou por frameworks: nunca aparecem como
 * chamada no código e não devem ser apontados como "sem uso".
 */
const IMPLICIT_METHODS = new Set([
  'constructor',
  'toJSON',
  'toString',
  'valueOf',
  'toLocaleString',
  'then',
  'render',
  'componentDidMount',
  'componentDidUpdate',
  'componentWillUnmount',
  'shouldComponentUpdate',
  'getDerivedStateFromProps',
  'getSnapshotBeforeUpdate',
  'componentDidCatch',
  'getDerivedStateFromError',
  'connectedCallback',
  'disconnectedCallback',
  'attributeChangedCallback',
  'adoptedCallback',
  'ngOnInit',
  'ngOnDestroy',
  'ngOnChanges',
  'ngAfterViewInit',
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationBootstrap',
  'handle',
  'transform',
  'canActivate',
  'intercept',
  'use',
]);

/**
 * Exports que o Next.js chama sozinho em arquivos de rotas (`app/`, `pages/`): metadados, dados
 * da página, handlers de rota (`GET`, `POST`...). O export padrão desses arquivos (página,
 * layout, `_app`, `_document`, rota de API) também é chamado pelo framework.
 */
const FRAMEWORK_EXPORTS = new Set([
  'generateMetadata',
  'generateStaticParams',
  'generateViewport',
  'generateImageMetadata',
  'generateSitemaps',
  'getServerSideProps',
  'getStaticProps',
  'getStaticPaths',
  'getInitialProps',
  'reportWebVitals',
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);
/** Arquivo dentro de uma pasta de rotas baseadas em arquivos (`app/`, `pages/`, `src/app/`...). */
const ROUTING_FILE = /(^|\/)(app|pages)\//;
/** `middleware.ts` e `instrumentation.ts` (raiz ou `src/`), chamados pelo Next.js. */
const FRAMEWORK_FILE = /(^|\/)(middleware|instrumentation)\.[cm]?[jt]sx?$/;
const FRAMEWORK_FILE_EXPORTS = new Set(['middleware', 'register', 'onRequestError']);

/**
 * Export chamado implicitamente por um framework de rotas baseadas em arquivos: nunca aparece
 * como chamada no código. Regra genérica e conservadora (só deixa de acusar "sem uso").
 */
function isFrameworkEntryPoint(node: GraphNode): boolean {
  if (node.kind === 'method' || !node.meta?.exported) return false;
  const file = node.location?.file;
  if (!file) return false;
  if (ROUTING_FILE.test(file)) return !!node.meta.defaultExport || FRAMEWORK_EXPORTS.has(node.name);
  if (FRAMEWORK_FILE.test(file))
    return !!node.meta.defaultExport || FRAMEWORK_FILE_EXPORTS.has(node.name);
  return false;
}

const byValue = (a: RankedNode, b: RankedNode) =>
  b.value - a.value || compareStrings(a.node.id, b.node.id);

/**
 * Calcula os insights do grafo. As medidas usam só relações resolvidas: nada de suposições.
 * Candidatos possíveis (chamadas por interface) só servem para não acusar "sem uso" à toa.
 */
export function computeInsights(index: GraphIndex, limit = 10): Insights {
  const callers = new Map<string, Set<string>>();
  const callees = new Map<string, Set<string>>();
  const importers = new Map<string, Set<string>>();
  const imported = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, value: string) => {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(value);
  };

  for (const edge of index.edges.values()) {
    if (edge.resolution !== 'resolved' || edge.source === edge.target) continue;
    if (edge.kind === 'calls') {
      add(callers, edge.target, edge.source);
      add(callees, edge.source, edge.target);
    } else if (edge.kind === 'imports') {
      const target = index.node(edge.target);
      if (target?.kind !== 'file' || target.meta?.analyzed === false) continue;
      add(importers, edge.target, edge.source);
      add(imported, edge.source, edge.target);
    }
  }

  const rank = (map: Map<string, Set<string>>, accept: (n: GraphNode) => boolean) =>
    [...map.entries()]
      .map(([id, set]) => ({ node: index.node(id)!, value: set.size }))
      .filter((r) => r.node && accept(r.node))
      .sort(byValue)
      .slice(0, limit);

  const isSymbol = (n: GraphNode) => SYMBOLS.has(n.kind);
  const isFile = (n: GraphNode) => n.kind === 'file';

  const largestFiles = [...index.nodes.values()]
    .filter((n) => n.kind === 'file' && n.meta?.analyzed !== false && (n.meta?.lines ?? 0) > 0)
    .map((node) => ({ node, value: node.meta!.lines! }))
    .sort(byValue)
    .slice(0, limit);

  const coupledModules = [...index.edges.values()]
    .filter((e) => e.kind === 'depends_on' && !e.meta?.typeOnly)
    .map((e) => ({
      from: index.node(e.source)!,
      to: index.node(e.target)!,
      imports: e.meta?.count ?? e.evidence.length,
    }))
    .filter((c) => c.from && c.to)
    .sort((a, b) => b.imports - a.imports || compareStrings(a.from.id, b.from.id))
    .slice(0, limit);

  const unused = { internal: [] as GraphNode[], exported: [] as GraphNode[] };
  for (const node of index.nodes.values()) {
    if (!SYMBOLS.has(node.kind)) continue;
    // sem contagem de menções (grafo antigo ou nome especial): não arriscamos
    if (node.meta?.mentions !== 1) continue;
    if (callers.has(node.id)) continue;
    // implementação possível de uma chamada por interface: pode ser usada em execução
    if (index.possibleCallSites(node.id).length) continue;
    if (node.kind === 'method' && IMPLICIT_METHODS.has(node.name.replace(/^(get|set) /, '')))
      continue;
    // páginas, layouts, handlers de rota e afins do Next.js: chamados pelo framework
    if (isFrameworkEntryPoint(node)) continue;
    // classe usada só via `new` em outro lugar teria mais menções; métodos de classes exportadas
    // contam como exportados (podem ser usados por quem consome a classe)
    const owner = node.kind === 'method' && node.parent ? index.node(node.parent) : undefined;
    const exported = !!node.meta?.exported || !!owner?.meta?.exported;
    (exported ? unused.exported : unused.internal).push(node);
  }
  const byId = (a: GraphNode, b: GraphNode) => compareStrings(a.id, b.id);
  unused.internal.sort(byId);
  unused.exported.sort(byId);

  return {
    mostCalled: rank(callers, isSymbol),
    mostCalling: rank(callees, (n) => isSymbol(n) || n.kind === 'route'),
    mostImported: rank(importers, isFile),
    mostDependencies: rank(imported, isFile),
    largestFiles,
    coupledModules,
    unused,
  };
}
