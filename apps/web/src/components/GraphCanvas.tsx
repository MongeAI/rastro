import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import cytoscape, {
  type Core,
  type ElementDefinition,
  type NodeSingular,
  type StylesheetJson,
} from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { GraphView, ViewNode } from '@teia/graph';
import type { Palette } from '../lib/theme';

cytoscape.use(fcose);

export interface GraphCanvasHandle {
  fit(): void;
  zoom(factor: number): void;
  relayout(): void;
  centerOn(id: string): void;
  png(background: string): Blob | undefined;
}

interface Props {
  view: GraphView;
  palette: Palette;
  selectedId: string | null;
  highlightNeighbors: boolean;
  /** Muda quando o mapa deve reenquadrar tudo (ex.: entrar/sair do foco). */
  fitKey: string;
  /** Pedido para centralizar um nó (o número garante que pedidos repetidos sejam atendidos). */
  centerRequest: { id: string; seq: number } | null;
  onSelect(id: string | null): void;
  onToggleExpand(id: string): void;
}

const LABEL_FONT = 'Inter, ui-sans-serif, system-ui, sans-serif';

const nodeWidth = (n: NodeSingular) => {
  const label = String(n.data('display') ?? '');
  const size = n.data('kind') === 'method' ? 6.1 : 6.7;
  return Math.max(36, Math.min(320, label.length * size + 26));
};

function buildStyle(p: Palette): StylesheetJson {
  const kinds = Object.keys(p.node) as Array<keyof Palette['node']>;
  return [
    {
      selector: 'node',
      style: {
        label: 'data(display)',
        'font-family': LABEL_FONT,
        'font-size': 11,
        'font-weight': 500,
        color: p.text,
        'text-valign': 'center',
        'text-halign': 'center',
        'min-zoomed-font-size': 5,
        width: nodeWidth,
        height: 26,
        shape: 'round-rectangle',
        'background-color': p.surface,
        'border-width': 1.2,
        'border-color': p.border,
        'transition-property': 'opacity',
        'transition-duration': 160,
      },
    },
    ...kinds.map((kind) => ({
      selector: `node[kind = "${kind}"]`,
      style: {
        'border-color': p.node[kind],
        'background-color': p.node[kind],
        'background-opacity': kind === 'file' ? 0.07 : 0.16,
      },
    })),
    { selector: 'node[kind = "function"]', style: { 'corner-radius': '13' } },
    {
      selector: 'node[kind = "method"]',
      style: { 'corner-radius': '11', height: 22, 'font-size': 10 },
    },
    { selector: 'node[kind = "class"]', style: { shape: 'cut-rectangle', height: 28 } },
    {
      selector: 'node[kind = "route"]',
      style: {
        shape: 'round-tag',
        'font-family': 'JetBrains Mono, ui-monospace, monospace',
        'font-size': 10,
      },
    },
    {
      selector: 'node[kind = "package"]',
      style: { shape: 'barrel', 'border-style': 'dashed', color: p.muted },
    },
    {
      selector: 'node[kind = "unresolved"]',
      style: { 'border-style': 'dashed', color: p.unresolved, 'background-opacity': 0.08 },
    },
    { selector: 'node.not-analyzed', style: { 'border-style': 'dotted', color: p.muted } },
    {
      selector: 'node.expandable',
      style: { 'border-width': 1.6 },
    },
    {
      selector: ':parent',
      style: {
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -5,
        'font-size': 10,
        color: p.muted,
        padding: '14px',
        'background-opacity': 0.035,
        shape: 'round-rectangle',
        'corner-radius': '8',
      },
    },
    {
      selector: 'node[kind = "module"]:parent',
      style: {
        'border-style': 'dashed',
        'border-color': p.border,
        'font-family': 'JetBrains Mono, ui-monospace, monospace',
        'font-size': 10,
      },
    },
    {
      selector: 'node[kind = "file"]:parent',
      style: {
        'border-color': p.node.file,
        'border-opacity': 0.55,
        color: p.text,
        padding: '10px',
      },
    },
    { selector: 'node[kind = "class"]:parent', style: { padding: '8px', color: p.node.class } },
    { selector: 'node.cycle', style: { 'border-color': p.cycle, 'border-width': 2 } },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        width: 'mapData(count, 1, 12, 1.1, 3)',
        'line-color': p.edge.imports,
        'target-arrow-color': p.edge.imports,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.75,
        opacity: 0.75,
        'transition-property': 'opacity',
        'transition-duration': 160,
      },
    },
    ...(Object.keys(p.edge) as Array<keyof Palette['edge']>).map((kind) => ({
      selector: `edge[kind = "${kind}"]`,
      style: { 'line-color': p.edge[kind], 'target-arrow-color': p.edge[kind] },
    })),
    {
      selector: 'edge[kind = "extends"]',
      style: { 'target-arrow-fill': 'hollow', 'arrow-scale': 1 },
    },
    { selector: 'edge[kind = "exports"]', style: { 'line-style': 'dotted' } },
    {
      selector: 'edge[kind = "depends_on"]',
      style: { width: 'mapData(count, 1, 20, 1.5, 4)', 'curve-style': 'unbundled-bezier' },
    },
    {
      selector: 'edge[resolution = "external"]',
      style: { 'line-style': 'dashed', 'line-dash-pattern': [5, 4] },
    },
    {
      selector: 'edge[resolution = "unresolved"]',
      style: {
        'line-style': 'dashed',
        'line-color': p.unresolved,
        'target-arrow-color': p.unresolved,
        'line-dash-pattern': [3, 3],
      },
    },
    { selector: 'edge.type-only', style: { 'line-style': 'dotted' } },
    { selector: 'edge.cycle', style: { 'line-color': p.cycle, 'target-arrow-color': p.cycle } },
    { selector: '.faded', style: { opacity: 0.12 } },
    { selector: 'edge.faded', style: { opacity: 0.04 } },
    { selector: 'edge.highlight', style: { opacity: 1, width: 2.2, 'z-index': 10 } },
    {
      selector: 'node.chosen',
      style: {
        'border-width': 2.5,
        'border-color': p.selection,
        'underlay-color': p.selection,
        'underlay-opacity': 0.12,
        'underlay-padding': 6,
        'z-index': 20,
      },
    },
    { selector: 'node:active', style: { 'overlay-opacity': 0.06, 'overlay-color': p.selection } },
  ];
}

function depthOf(n: ViewNode, byId: Map<string, ViewNode>): number {
  let d = 0;
  let cur = n.parent ? byId.get(n.parent) : undefined;
  while (cur && d < 50) {
    d++;
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return d;
}

const display = (n: ViewNode) =>
  n.kind === 'file' && n.expandable && !n.expanded ? `${n.label}  +` : n.label;

export const GraphCanvas = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas(props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const firstLayout = useRef(true);
  const lastFitKey = useRef<string | null>(null);
  const handlers = useRef(props);
  handlers.current = props;

  const runLayout = (fit: boolean) => {
    const cy = cyRef.current;
    if (!cy || cy.nodes().length === 0) return;
    const randomize = firstLayout.current;
    firstLayout.current = false;
    const big = cy.nodes().length > 350;
    const layout = cy.layout({
      name: 'fcose',
      quality: big ? 'draft' : 'default',
      randomize,
      animate: !randomize && !big,
      animationDuration: 380,
      fit,
      padding: 48,
      nodeDimensionsIncludeLabels: true,
      packComponents: true,
      nodeRepulsion: () => 4500,
      idealEdgeLength: () => 55,
      edgeElasticity: () => 0.35,
      nestingFactor: 0.7,
      gravity: 0.45,
      gravityCompound: 1.2,
      numIter: big ? 1200 : 2500,
      tile: true,
      tilingPaddingVertical: 14,
      tilingPaddingHorizontal: 14,
    } as cytoscape.LayoutOptions);
    if (fit) {
      // com poucos nós o enquadramento aproxima demais; limitamos o zoom inicial
      layout.one('layoutstop', () => {
        if (cy.zoom() > 1.3) {
          cy.zoom(1.3);
          cy.center();
        }
      });
    }
    layout.run();
  };

  // criação do Cytoscape
  useEffect(() => {
    const cy = cytoscape({
      container: containerRef.current,
      style: buildStyle(handlers.current.palette),
      minZoom: 0.05,
      maxZoom: 3.5,
      boxSelectionEnabled: false,
      autounselectify: true,
      wheelSensitivity: 0.25,
    });
    cyRef.current = cy;
    firstLayout.current = true;
    lastFitKey.current = null;
    cy.on('tap', 'node', (e) => handlers.current.onSelect(e.target.id()));
    cy.on('tap', (e) => {
      if (e.target === cy) handlers.current.onSelect(null);
    });
    cy.on('dbltap', 'node', (e) => {
      const n = e.target as NodeSingular;
      if (n.data('kind') === 'file' && n.data('expandable'))
        handlers.current.onToggleExpand(n.id());
    });
    cy.on('mouseover', 'node', () => {
      if (containerRef.current) containerRef.current.style.cursor = 'pointer';
    });
    cy.on('mouseout', 'node', () => {
      if (containerRef.current) containerRef.current.style.cursor = '';
    });
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  useEffect(() => {
    cyRef.current?.style(buildStyle(props.palette));
  }, [props.palette]);

  // sincroniza os elementos com a visão calculada (diferencial, preservando posições)
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const { view } = props;
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    const wanted = new Set<string>([...byId.keys(), ...view.edges.map((e) => e.id)]);
    let structural = false;

    const center = () => {
      const ext = cy.extent();
      return { x: (ext.x1 + ext.x2) / 2, y: (ext.y1 + ext.y2) / 2 };
    };
    const jitter = (p: { x: number; y: number }) => ({
      x: p.x + (Math.random() - 0.5) * 60,
      y: p.y + (Math.random() - 0.5) * 60,
    });
    const neighborsOf = new Map<string, string[]>();
    for (const e of view.edges) {
      (neighborsOf.get(e.source) ?? neighborsOf.set(e.source, []).get(e.source)!).push(e.target);
      (neighborsOf.get(e.target) ?? neighborsOf.set(e.target, []).get(e.target)!).push(e.source);
    }

    cy.batch(() => {
      const sorted = [...view.nodes].sort((a, b) => depthOf(a, byId) - depthOf(b, byId));
      // 1. adiciona nós novos (pais antes dos filhos)
      for (const n of sorted) {
        const data = {
          id: n.id,
          kind: n.kind,
          display: display(n),
          expandable: n.expandable,
          ...(n.parent ? { parent: n.parent } : {}),
        };
        const classes = [
          n.inCycle && 'cycle',
          n.expandable && !n.expanded && 'expandable',
          !n.analyzed && 'not-analyzed',
        ]
          .filter(Boolean)
          .join(' ');
        const existing = cy.getElementById(n.id);
        if (existing.nonempty()) {
          existing.data({ display: data.display, expandable: n.expandable });
          existing.classes(classes);
          continue;
        }
        structural = true;
        let anchor: { x: number; y: number } | undefined;
        const parent = n.parent ? cy.getElementById(n.parent) : undefined;
        if (parent?.nonempty()) anchor = parent.position();
        if (!anchor) {
          const neighbor = (neighborsOf.get(n.id) ?? [])
            .map((id) => cy.getElementById(id))
            .find((x) => x.nonempty());
          anchor = neighbor?.position();
        }
        cy.add({
          group: 'nodes',
          data,
          classes,
          position: jitter(anchor ?? center()),
        } as ElementDefinition);
      }
      // 2. move nós cujo grupo mudou
      for (const n of sorted) {
        const el = cy.getElementById(n.id);
        const current = el.data('parent') as string | undefined;
        if ((current ?? null) !== (n.parent ?? null)) {
          structural = true;
          el.move({ parent: n.parent ?? null });
        }
      }
      // 3. remove o que saiu da visão
      const stale = cy.elements().filter((el) => !wanted.has(el.id()));
      if (stale.nonempty()) {
        structural = true;
        cy.remove(stale);
      }
      // 4. relações
      const cycleFiles = new Set(view.nodes.filter((n) => n.inCycle).map((n) => n.id));
      for (const e of view.edges) {
        const existing = cy.getElementById(e.id);
        const classes = [
          e.typeOnly && 'type-only',
          e.kind === 'imports' && cycleFiles.has(e.source) && cycleFiles.has(e.target) && 'cycle',
        ]
          .filter(Boolean)
          .join(' ');
        if (existing.nonempty()) {
          existing.classes(classes);
          continue;
        }
        structural = true;
        cy.add({
          group: 'edges',
          data: {
            id: e.id,
            source: e.source,
            target: e.target,
            kind: e.kind,
            resolution: e.resolution,
            count: e.count,
          },
          classes,
        });
      }
    });

    const fit = lastFitKey.current !== props.fitKey;
    lastFitKey.current = props.fitKey;
    if (structural || fit) runLayout(fit || firstLayout.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.view, props.fitKey]);

  // destaque da seleção e da vizinhança
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass('faded highlight chosen');
      if (!props.selectedId) return;
      const node = cy.getElementById(props.selectedId);
      if (node.empty()) return;
      node.addClass('chosen');
      if (!props.highlightNeighbors) return;
      const base = node.union(node.descendants());
      const edges = base.connectedEdges();
      let keep = base.union(edges).union(edges.connectedNodes());
      keep = keep.union(keep.ancestors());
      edges.addClass('highlight');
      cy.elements().not(keep).addClass('faded');
    });
  }, [props.selectedId, props.highlightNeighbors, props.view]);

  // centraliza quando pedido (após a visão ter sido sincronizada)
  useEffect(() => {
    const cy = cyRef.current;
    const req = props.centerRequest;
    if (!cy || !req) return;
    const node = cy.getElementById(req.id);
    if (node.empty()) return;
    const t = setTimeout(() => {
      cy.animate(
        { center: { eles: node }, zoom: Math.max(cy.zoom(), 1.05) },
        { duration: 350, easing: 'ease-out-cubic' },
      );
    }, 420);
    return () => clearTimeout(t);
  }, [props.centerRequest]);

  useImperativeHandle(ref, () => ({
    fit: () =>
      cyRef.current?.animate(
        { fit: { eles: cyRef.current.elements(), padding: 48 } },
        { duration: 300 },
      ),
    zoom: (factor) => {
      const cy = cyRef.current;
      if (!cy) return;
      cy.animate(
        {
          zoom: {
            level: cy.zoom() * factor,
            renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
          },
        },
        { duration: 180 },
      );
    },
    relayout: () => {
      firstLayout.current = true;
      runLayout(true);
    },
    centerOn: (id) => {
      const cy = cyRef.current;
      const node = cy?.getElementById(id);
      if (cy && node?.nonempty())
        cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1.05) }, { duration: 350 });
    },
    png: (background) =>
      cyRef.current?.png({ output: 'blob', full: true, scale: 2, bg: background }) as
        Blob | undefined,
  }));

  return (
    <div
      ref={containerRef}
      className="graph-canvas"
      role="application"
      aria-label="Mapa interativo do código"
    />
  );
});
