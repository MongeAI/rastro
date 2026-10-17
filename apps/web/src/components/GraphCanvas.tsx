import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import cytoscape, { type Core, type ElementDefinition, type NodeSingular } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import layoutUtilities from 'cytoscape-layout-utilities';
import { EDGE_KIND_LABELS, NODE_KIND_LABELS, type EdgeKind, type NodeKind } from '@teia/core';
import type { GraphView, ViewNode } from '@teia/graph';
import { computeElkPositions } from '../lib/elkLayout';
import { buildStyle, displayLabel } from '../lib/graphStyle';
import type { Palette } from '../lib/theme';

cytoscape.use(fcose);
// necessário para o fcose empacotar componentes desconectados (packComponents)
cytoscape.use(layoutUtilities);

export type LayoutMode = 'hierarchical' | 'organic';

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
  layout: LayoutMode;
  selectedId: string | null;
  selectedEdgeId: string | null;
  highlightNeighbors: boolean;
  /** Muda quando o mapa deve reenquadrar tudo (ex.: trocar de nível ou entrar no foco). */
  fitKey: string;
  /** Pedido para centralizar um nó (o número garante que pedidos repetidos sejam atendidos). */
  centerRequest: { id: string; seq: number } | null;
  onSelect(id: string | null): void;
  onSelectEdge(id: string): void;
  /** Duplo clique: expande/recolhe arquivos e pastas. */
  onActivate(id: string): void;
}

interface Tooltip {
  x: number;
  y: number;
  title: string;
  detail: string;
}

const MAX_FIT_ZOOM = 1.25;

function depthOf(n: ViewNode, byId: Map<string, ViewNode>): number {
  let d = 0;
  for (let cur = n.parent ? byId.get(n.parent) : undefined; cur && d < 50; d++) {
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return d;
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas(props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const layoutRun = useRef(0);
  const lastFitKey = useRef<string | null>(null);
  const firstLayout = useRef(true);
  const handlers = useRef(props);
  handlers.current = props;
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [busy, setBusy] = useState(false);

  /** Enquadra tudo, sem aproximar demais quando há poucos nós. */
  const fitAll = (animate: boolean) => {
    const cy = cyRef.current;
    if (!cy || cy.elements().empty()) return;
    const run = () => {
      cy.fit(cy.elements(), 40);
      if (cy.zoom() > MAX_FIT_ZOOM) {
        cy.zoom(MAX_FIT_ZOOM);
        cy.center();
      }
    };
    if (!animate) return run();
    const before = { zoom: cy.zoom(), pan: { ...cy.pan() } };
    run();
    const target = { zoom: cy.zoom(), pan: { ...cy.pan() } };
    cy.viewport(before);
    cy.animate(target, { duration: 320, easing: 'ease-out-cubic' });
  };

  const runLayout = (fit: boolean) => {
    const cy = cyRef.current;
    if (!cy || cy.nodes().empty()) return;
    const run = ++layoutRun.current;
    const animate = !firstLayout.current && cy.nodes().length < 500;
    firstLayout.current = false;

    if (handlers.current.layout === 'organic') {
      const layout = cy.layout({
        name: 'fcose',
        quality: cy.nodes().length > 400 ? 'draft' : 'default',
        randomize: !animate,
        animate,
        animationDuration: 380,
        fit: false,
        nodeDimensionsIncludeLabels: true,
        packComponents: true,
        nodeRepulsion: () => 5000,
        idealEdgeLength: () => 60,
        nestingFactor: 0.7,
        gravity: 0.4,
        gravityCompound: 1.2,
        tile: true,
      } as cytoscape.LayoutOptions);
      layout.one('layoutstop', () => run === layoutRun.current && fit && fitAll(true));
      layout.run();
      return;
    }

    setBusy(true);
    const rect = containerRef.current?.getBoundingClientRect();
    const ratio = rect && rect.height > 0 ? rect.width / rect.height : 1.6;
    computeElkPositions(cy, ratio)
      .then((positions) => {
        if (run !== layoutRun.current || cyRef.current !== cy) return;
        cy.nodes()
          .filter((n) => !n.isParent() && !positions[n.id()])
          .forEach((n) => {
            positions[n.id()] = n.position();
          });
        const layout = cy.layout({
          name: 'preset',
          positions: (n: NodeSingular) => positions[n.id()] ?? n.position(),
          animate,
          animationDuration: 380,
          animationEasing: 'ease-in-out-cubic',
          fit: false,
        } as cytoscape.LayoutOptions);
        layout.one('layoutstop', () => {
          if (run !== layoutRun.current) return;
          if (fit) fitAll(animate);
        });
        layout.run();
      })
      .catch((err: unknown) => {
        // se o ELK falhar (grafo patológico), cai para o layout orgânico
        console.warn('Layout hierárquico falhou, usando o orgânico.', err);
        cy.layout({
          name: 'fcose',
          animate: false,
          packComponents: true,
          fit: true,
          padding: 40,
        } as cytoscape.LayoutOptions).run();
      })
      .finally(() => run === layoutRun.current && setBusy(false));
  };

  // criação do Cytoscape
  useEffect(() => {
    const cy = cytoscape({
      container: containerRef.current,
      style: buildStyle(handlers.current.palette),
      minZoom: 0.04,
      maxZoom: 4,
      boxSelectionEnabled: false,
      autounselectify: true,
    });
    cyRef.current = cy;
    firstLayout.current = true;
    lastFitKey.current = null;

    cy.on('tap', 'node', (e) => handlers.current.onSelect(e.target.id()));
    cy.on('tap', 'edge', (e) => handlers.current.onSelectEdge(e.target.id()));
    cy.on('tap', (e) => {
      if (e.target === cy) handlers.current.onSelect(null);
    });
    cy.on('dbltap', 'node', (e) => handlers.current.onActivate(e.target.id()));

    const show = (title: string, detail: string, x: number, y: number) =>
      setTooltip({ title, detail, x, y });
    cy.on('mouseover', 'node', (e) => {
      const n = e.target as NodeSingular;
      n.addClass('hover');
      if (containerRef.current) containerRef.current.style.cursor = 'pointer';
      const kind = NODE_KIND_LABELS[n.data('kind') as NodeKind];
      const hint = n.data('collapsed')
        ? 'duplo clique para abrir a pasta'
        : n.data('expandable')
          ? n.data('expanded')
            ? 'duplo clique para recolher os símbolos'
            : 'duplo clique para ver funções e classes'
          : n.isParent() && n.data('kind') === 'module'
            ? 'duplo clique para recolher a pasta'
            : '';
      const pos = n.renderedPosition();
      show(
        n.data('full') as string,
        hint ? `${kind} · ${hint}` : kind,
        pos.x,
        pos.y - n.renderedOuterHeight() / 2,
      );
    });
    cy.on('mouseover', 'edge', (e) => {
      const edge = e.target;
      if (containerRef.current) containerRef.current.style.cursor = 'pointer';
      const count = edge.data('count') as number;
      const label = EDGE_KIND_LABELS[edge.data('kind') as EdgeKind];
      const mid = edge.renderedMidpoint();
      show(
        `${edge.source().data('full')} → ${edge.target().data('full')}`,
        `${label}${count > 1 ? ` · ${count}×` : ''}${edge.data('aggregated') ? ' · soma das relações internas' : ''} · clique para ver as evidências`,
        mid.x,
        mid.y,
      );
    });
    cy.on('mouseout', 'node, edge', (e) => {
      e.target.removeClass('hover');
      if (containerRef.current) containerRef.current.style.cursor = '';
      setTooltip(null);
    });
    cy.on('viewport', () => setTooltip(null));

    // rótulos dos grupos crescem quando o zoom diminui, para o mapa continuar legível de longe
    let lastScale = 0;
    const scaleGroupLabels = () => {
      const scale = Math.min(4, Math.max(1, 0.9 / cy.zoom()));
      if (Math.abs(scale - lastScale) < 0.08) return;
      lastScale = scale;
      cy.style()
        .selector(':parent')
        .style({ 'font-size': 11 * scale, 'text-margin-y': -4 * scale })
        .update();
    };
    cy.on('zoom', scaleGroupLabels);
    cy.on('style', () => (lastScale = 0));

    // quando o espaço do mapa muda (painel recolhido, janela redimensionada), mantém o centro
    let size = { w: cy.width(), h: cy.height() };
    const observer = new ResizeObserver(() => {
      cy.resize();
      const next = { w: cy.width(), h: cy.height() };
      if (size.w > 0 && size.h > 0)
        cy.panBy({ x: (next.w - size.w) / 2, y: (next.h - size.h) / 2 });
      size = next;
    });
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
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
    const neighborsOf = new Map<string, string[]>();
    for (const e of view.edges) {
      if (!neighborsOf.has(e.source)) neighborsOf.set(e.source, []);
      if (!neighborsOf.has(e.target)) neighborsOf.set(e.target, []);
      neighborsOf.get(e.source)!.push(e.target);
      neighborsOf.get(e.target)!.push(e.source);
    }

    cy.batch(() => {
      const sorted = [...view.nodes].sort((a, b) => depthOf(a, byId) - depthOf(b, byId));
      // 1. adiciona nós novos (pais antes dos filhos), perto do pai ou de um vizinho
      for (const n of sorted) {
        const display = displayLabel(n);
        const classes = [
          n.inCycle && 'cycle',
          n.expandable && !n.expanded && 'expandable',
          n.collapsed && 'collapsed',
          !n.analyzed && 'not-analyzed',
        ]
          .filter(Boolean)
          .join(' ');
        const existing = cy.getElementById(n.id);
        if (existing.nonempty()) {
          if (existing.data('display') !== display) structural = true; // tamanho mudou
          existing.data({
            display,
            expandable: n.expandable,
            expanded: n.expanded,
            collapsed: n.collapsed,
          });
          existing.classes(classes);
          continue;
        }
        structural = true;
        const anchor =
          (n.parent &&
            cy.getElementById(n.parent).nonempty() &&
            cy.getElementById(n.parent).position()) ||
          (neighborsOf.get(n.id) ?? [])
            .map((id) => cy.getElementById(id))
            .find((x) => x.nonempty())
            ?.position();
        const ext = cy.extent();
        const base = anchor ?? { x: (ext.x1 + ext.x2) / 2, y: (ext.y1 + ext.y2) / 2 };
        cy.add({
          group: 'nodes',
          data: {
            id: n.id,
            kind: n.kind,
            display,
            full: n.kind === 'module' ? `${n.label}/` : n.label,
            expandable: n.expandable,
            expanded: n.expanded,
            collapsed: n.collapsed,
            ...(n.parent ? { parent: n.parent } : {}),
          },
          classes,
          position: {
            x: base.x + (Math.random() - 0.5) * 40,
            y: base.y + (Math.random() - 0.5) * 40,
          },
        } as ElementDefinition);
      }
      // 2. move nós cujo grupo mudou
      for (const n of sorted) {
        const el = cy.getElementById(n.id);
        if (((el.data('parent') as string | undefined) ?? null) !== (n.parent ?? null)) {
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
      const cycleNodes = new Set(view.nodes.filter((n) => n.inCycle).map((n) => n.id));
      for (const e of view.edges) {
        const classes = [
          e.typeOnly && 'type-only',
          e.aggregated && 'aggregated',
          e.kind === 'imports' && cycleNodes.has(e.source) && cycleNodes.has(e.target) && 'cycle',
        ]
          .filter(Boolean)
          .join(' ');
        const existing = cy.getElementById(e.id);
        if (existing.nonempty()) {
          existing.data({ count: e.count, resolution: e.resolution });
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
            aggregated: e.aggregated,
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

  // trocar o tipo de layout reorganiza tudo
  const lastLayout = useRef(props.layout);
  useEffect(() => {
    if (lastLayout.current === props.layout) return;
    lastLayout.current = props.layout;
    runLayout(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.layout]);

  // destaque da seleção e da vizinhança
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass('faded highlight chosen');
      if (props.selectedEdgeId) {
        const edge = cy.getElementById(props.selectedEdgeId);
        if (edge.nonempty()) {
          edge.addClass('chosen');
          const keep = edge.union(edge.connectedNodes());
          if (props.highlightNeighbors)
            cy.elements().not(keep.union(keep.ancestors())).addClass('faded');
        }
        return;
      }
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
  }, [props.selectedId, props.selectedEdgeId, props.highlightNeighbors, props.view]);

  // centraliza quando pedido (depois que o layout termina)
  useEffect(() => {
    const cy = cyRef.current;
    const req = props.centerRequest;
    if (!cy || !req) return;
    const t = setTimeout(() => {
      const node = cy.getElementById(req.id);
      if (node.empty()) return;
      cy.animate(
        { center: { eles: node }, zoom: Math.max(cy.zoom(), 1) },
        { duration: 350, easing: 'ease-out-cubic' },
      );
    }, 520);
    return () => clearTimeout(t);
  }, [props.centerRequest]);

  useImperativeHandle(ref, () => ({
    fit: () => fitAll(true),
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
    relayout: () => runLayout(true),
    centerOn: (id) => {
      const cy = cyRef.current;
      const node = cy?.getElementById(id);
      if (cy && node?.nonempty())
        cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1) }, { duration: 350 });
    },
    png: (background) =>
      cyRef.current?.png({ output: 'blob', full: true, scale: 2, bg: background }) as
        Blob | undefined,
  }));

  return (
    <>
      <div
        ref={containerRef}
        className="graph-canvas"
        role="application"
        aria-label="Mapa interativo do código"
      />
      {tooltip && (
        <div className="graph-tooltip" style={{ left: tooltip.x, top: tooltip.y }} role="tooltip">
          <strong>{tooltip.title}</strong>
          <span>{tooltip.detail}</span>
        </div>
      )}
      {busy && (
        <div className="layout-busy" aria-live="polite">
          Organizando o mapa…
        </div>
      )}
    </>
  );
});
