import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Core, NodeSingular } from 'cytoscape';

const elk = new ELK();

/** Espaço reservado acima de cada grupo para o rótulo (desenhado fora da caixa do Cytoscape). */
export const GROUP_LABEL_SPACE = 20;
/** Mesmo valor do `padding` dos grupos no estilo do Cytoscape. */
export const GROUP_PADDING = 14;

export type Positions = Record<string, { x: number; y: number }>;

/**
 * Layout hierárquico em camadas (ELK "layered"), feito de dentro para fora:
 * cada grupo (pasta, arquivo, classe) organiza seus filhos pelas relações entre eles, e
 * os grupos se organizam pelas relações entre si. Relações que atravessam grupos são
 * "elevadas" até o nível em que os dois lados são irmãos. Componentes sem ligação são
 * empacotados em grade, respeitando a proporção da tela.
 */
export async function computeElkPositions(cy: Core, aspectRatio: number): Promise<Positions> {
  const nodes = cy.nodes();
  const containers = new Map<string, ElkNode>();
  const root: ElkNode = { id: '__root__', children: [], edges: [] };
  containers.set(root.id, root);

  const layoutOptions = (ratio: number, isRoot: boolean): Record<string, string> => ({
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.edgeRouting': 'POLYLINE',
    'elk.layered.spacing.nodeNodeBetweenLayers': isRoot ? '70' : '42',
    'elk.spacing.nodeNode': isRoot ? '34' : '12',
    'elk.spacing.componentComponent': isRoot ? '48' : '22',
    'elk.separateConnectedComponents': 'true',
    'elk.aspectRatio': String(ratio),
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH',
  });
  root.layoutOptions = layoutOptions(Math.max(0.6, Math.min(aspectRatio, 3)), true);

  // ordem determinística: pais antes dos filhos, depois por id
  const sorted = nodes
    .toArray()
    .sort((a, b) => depth(a) - depth(b) || a.id().localeCompare(b.id())) as NodeSingular[];
  for (const node of sorted) {
    const parentId = node.isChild() ? node.parent().first().id() : root.id;
    const container = containers.get(parentId) ?? root;
    const elkNode: ElkNode = { id: node.id() };
    if (node.isParent()) {
      elkNode.children = [];
      elkNode.edges = [];
      elkNode.layoutOptions = {
        ...layoutOptions(1.6, false),
        'elk.padding': `[top=${GROUP_PADDING + GROUP_LABEL_SPACE},left=${GROUP_PADDING},bottom=${GROUP_PADDING},right=${GROUP_PADDING}]`,
      };
      containers.set(node.id(), elkNode);
    } else {
      elkNode.width = node.outerWidth();
      elkNode.height = node.outerHeight();
    }
    container.children!.push(elkNode);
  }

  // eleva cada relação até o grupo em comum mais próximo
  const chain = (n: NodeSingular) => [n.id(), ...n.ancestors().map((a) => a.id())];
  const lifted = new Set<string>();
  cy.edges().forEach((edge) => {
    const a = chain(edge.source());
    const b = chain(edge.target());
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

  const result = await elk.layout(root);

  const positions: Positions = {};
  const walk = (node: ElkNode, offsetX: number, offsetY: number) => {
    for (const child of node.children ?? []) {
      const x = offsetX + (child.x ?? 0);
      const y = offsetY + (child.y ?? 0);
      if (child.children?.length) walk(child, x, y);
      else positions[child.id] = { x: x + (child.width ?? 0) / 2, y: y + (child.height ?? 0) / 2 };
    }
  };
  walk(result, 0, 0);
  return positions;
}

function depth(n: NodeSingular): number {
  return n.ancestors().length;
}
