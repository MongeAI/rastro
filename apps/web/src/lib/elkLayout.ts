import ElkConstructor, { type ELK, type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import type { Core } from 'cytoscape';

/** Espaço reservado acima de cada grupo para o rótulo (desenhado fora da caixa do Cytoscape). */
export const GROUP_LABEL_SPACE = 20;
/** Mesmo valor do `padding` dos grupos no estilo do Cytoscape. */
export const GROUP_PADDING = 14;
/** Largura aproximada de um caractere do rótulo dos grupos (fonte mono, 11px). */
export const GROUP_LABEL_CHAR = 6.8;

export type Positions = Record<string, { x: number; y: number }>;

/**
 * O ELK roda em um Web Worker: em projetos grandes o cálculo leva segundos e não pode
 * congelar a interface. Um pedido novo cancela o anterior (o worker é encerrado e recriado).
 */
let elk: ELK | null = null;
let running = false;
let embeddedWorkerUrl: string | null = null;

/**
 * Endereço do worker. No relatório HTML offline (`rastro export --format html`, aberto via
 * file://) o navegador não cria workers a partir de arquivos locais: o relatório embute o
 * código do worker em `window.__RASTRO_ELK_WORKER_SOURCE__` e ele é carregado por um Blob URL
 * (criado uma vez só). Fora do relatório, usa o arquivo normal servido pela CLI.
 */
function workerUrl(): string {
  const embedded = (globalThis as { __RASTRO_ELK_WORKER_SOURCE__?: unknown })
    .__RASTRO_ELK_WORKER_SOURCE__;
  if (typeof embedded !== 'string' || !embedded) return elkWorkerUrl;
  embeddedWorkerUrl ??= URL.createObjectURL(new Blob([embedded], { type: 'text/javascript' }));
  return embeddedWorkerUrl;
}

function getElk(): ELK {
  if (!elk)
    elk = new ElkConstructor({ workerUrl: workerUrl(), workerFactory: (url) => new Worker(url!) });
  return elk;
}

export class LayoutCancelled extends Error {}
export class LayoutTimeout extends Error {}

/** Tempo máximo do ELK; depois disso o mapa usa o layout orgânico (bem mais rápido). */
const ELK_TIMEOUT_MS = 20_000;
/** Acima disso o mapa é "grande": o ELK usa estratégias mais baratas. */
const LARGE_NODES = 1500;
const LARGE_EDGES = 4000;

/**
 * Layout hierárquico em camadas (ELK "layered"), feito de dentro para fora:
 * cada grupo (pasta, arquivo, classe) organiza seus filhos pelas relações entre eles, e
 * os grupos se organizam pelas relações entre si. Relações que atravessam grupos são
 * "elevadas" até o nível em que os dois lados são irmãos. Componentes sem ligação são
 * empacotados em grade, respeitando a proporção da tela.
 */
export async function computeElkPositions(cy: Core, aspectRatio: number): Promise<Positions> {
  if (running && elk) {
    // um layout anterior ainda está calculando: descartamos o trabalho dele
    elk.terminateWorker();
    elk = null;
  }
  const root = buildGraph(cy, aspectRatio);
  running = true;
  const instance = getElk();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // encerra o worker: o cálculo para de consumir CPU
        if (instance === elk) {
          elk.terminateWorker();
          elk = null;
          running = false;
        }
        reject(new LayoutTimeout());
      }, ELK_TIMEOUT_MS);
    });
    const result = await Promise.race([instance.layout(root), timeout]);
    const positions: Positions = {};
    const walk = (node: ElkNode, offsetX: number, offsetY: number) => {
      for (const child of node.children ?? []) {
        const x = offsetX + (child.x ?? 0);
        const y = offsetY + (child.y ?? 0);
        if (child.children?.length) walk(child, x, y);
        else
          positions[child.id] = { x: x + (child.width ?? 0) / 2, y: y + (child.height ?? 0) / 2 };
      }
    };
    walk(result, 0, 0);
    return positions;
  } catch (err) {
    if (err instanceof LayoutTimeout) throw err;
    // worker encerrado por um pedido mais novo
    if (instance !== elk) throw new LayoutCancelled();
    throw err;
  } finally {
    clearTimeout(timer);
    if (instance === elk) running = false;
  }
}

function buildGraph(cy: Core, aspectRatio: number): ElkNode {
  const containers = new Map<string, ElkNode>();
  const root: ElkNode = { id: '__root__', children: [], edges: [] };
  containers.set(root.id, root);

  const large = cy.nodes().length > LARGE_NODES || cy.edges().length > LARGE_EDGES;
  const layoutOptions = (ratio: number, isRoot: boolean): Record<string, string> => ({
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.edgeRouting': 'POLYLINE',
    'elk.layered.spacing.nodeNodeBetweenLayers': isRoot ? '70' : '42',
    'elk.spacing.nodeNode': isRoot ? '34' : '12',
    'elk.spacing.componentComponent': isRoot ? '48' : '22',
    'elk.separateConnectedComponents': 'true',
    'elk.aspectRatio': String(ratio),
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    // mapas grandes: posicionamento e compactação mais baratos (o NETWORK_SIMPLEX e a
    // compactação somam segundos com milhares de nós)
    ...(large
      ? { 'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF', 'elk.layered.thoroughness': '2' }
      : {
          'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
          'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH',
        }),
  });
  root.layoutOptions = layoutOptions(Math.max(0.6, Math.min(aspectRatio, 3)), true);

  // Lê o Cytoscape uma única vez e trabalha com ids e mapas simples: chamar ancestors()
  // repetidamente cria coleções novas e, com milhares de nós, travava a interface.
  interface Item {
    id: string;
    parent?: string;
    isParent: boolean;
    width: number;
    height: number;
    label: string;
  }
  const items = new Map<string, Item>();
  cy.nodes().forEach((node) => {
    const parent = node.data('parent') as string | undefined;
    const isParent = node.isParent();
    items.set(node.id(), {
      id: node.id(),
      ...(parent ? { parent } : {}),
      isParent,
      width: isParent ? 0 : node.outerWidth(),
      height: isParent ? 0 : node.outerHeight(),
      label: String(node.data('display') ?? ''),
    });
  });
  const chainCache = new Map<string, string[]>();
  const chain = (id: string): string[] => {
    let cached = chainCache.get(id);
    if (cached) return cached;
    const parent = items.get(id)?.parent;
    cached = parent && items.has(parent) ? [id, ...chain(parent)] : [id];
    chainCache.set(id, cached);
    return cached;
  };

  // ordem determinística: pais antes dos filhos, depois por id
  const sorted = [...items.values()].sort(
    (a, b) => chain(a.id).length - chain(b.id).length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const item of sorted) {
    const container = (item.parent && containers.get(item.parent)) || root;
    const elkNode: ElkNode = { id: item.id };
    if (item.isParent) {
      // o grupo precisa ser pelo menos tão largo quanto o próprio rótulo
      const minWidth = Math.ceil(item.label.length * GROUP_LABEL_CHAR + 16);
      elkNode.children = [];
      elkNode.edges = [];
      elkNode.layoutOptions = {
        ...layoutOptions(1.6, false),
        'elk.padding': `[top=${GROUP_PADDING + GROUP_LABEL_SPACE},left=${GROUP_PADDING},bottom=${GROUP_PADDING},right=${GROUP_PADDING}]`,
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': `(${minWidth}, 20)`,
        'elk.contentAlignment': 'H_CENTER V_TOP',
      };
      containers.set(item.id, elkNode);
    } else {
      elkNode.width = item.width;
      elkNode.height = item.height;
    }
    container.children!.push(elkNode);
  }

  // eleva cada relação até o grupo em comum mais próximo
  const lifted = new Set<string>();
  cy.edges().forEach((edge) => {
    const a = chain(edge.data('source') as string);
    const b = chain(edge.data('target') as string);
    const bSet = new Set(b);
    const common = a.find((id) => bSet.has(id));
    const containerId = common ?? root.id;
    const childA = common ? a[a.indexOf(common) - 1] : a[a.length - 1];
    const childB = common ? b[b.indexOf(common) - 1] : b[b.length - 1];
    if (!childA || !childB || childA === childB) return;
    const key = `${containerId}|${childA}|${childB}`;
    if (lifted.has(key)) return;
    lifted.add(key);
    const container = containers.get(containerId);
    if (!container) return;
    (container.edges ??= []).push({
      id: `e${lifted.size}`,
      sources: [childA],
      targets: [childB],
    } as ElkExtendedEdge);
  });

  // Grupos densos (bem mais relações que nós, ex.: pastas que se importam todas entre si)
  // não têm "fluxo" para mostrar em camadas, e o ELK layered explode em nós auxiliares
  // (cada relação longa vira dezenas). Esses grupos são empacotados em grade; as linhas
  // continuam desenhadas normalmente pelo Cytoscape.
  for (const container of containers.values()) {
    const n = container.children?.length ?? 0;
    const m = container.edges?.length ?? 0;
    if (n >= 12 && m > n * 4) {
      container.layoutOptions = {
        ...container.layoutOptions,
        'elk.algorithm': 'rectpacking',
        'elk.aspectRatio': container === root ? root.layoutOptions!['elk.aspectRatio']! : '1.6',
        'elk.spacing.nodeNode': container === root ? '40' : '16',
      };
      container.edges = [];
    }
  }
  return root;
}
