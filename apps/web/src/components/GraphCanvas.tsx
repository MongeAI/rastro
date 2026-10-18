import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import cytoscape, { type Core, type ElementDefinition, type NodeSingular } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import layoutUtilities from 'cytoscape-layout-utilities';
import type { EdgeKind, NodeKind } from '@rastro/core';
import { useI18n } from '../lib/i18n';
import type { GraphView, ViewNode } from '@rastro/graph';
import { computeElkPositions, LayoutCancelled } from '../lib/elkLayout';
import { buildStyle, displayLabel, estimateNodeWidth } from '../lib/graphStyle';
import type { Palette } from '../lib/theme';
import { Minimap } from './Minimap';

cytoscape.use(fcose);
// necessário para o fcose empacotar componentes desconectados (packComponents)
cytoscape.use(layoutUtilities);

export type LayoutMode = 'hierarchical' | 'organic';
export type Direction = 'up' | 'down' | 'left' | 'right';

export interface GraphCanvasHandle {
  fit(): void;
  zoom(factor: number): void;
  relayout(): void;
  centerOn(id: string): void;
  /** Move a visão só o necessário para o nó ficar visível (sem mudar o zoom). */
  reveal(id: string): void;
  /**
   * O nó mais próximo na direção pedida (navegação pelo teclado). Sem `fromId`, o nó mais
   * perto do centro da tela.
   */
  nearest(fromId: string | null, direction: Direction): string | null;
  png(background: string): Blob | undefined;
}

interface Props {
  view: GraphView;
  palette: Palette;
  layout: LayoutMode;
  selectedId: string | null;
  selectedEdgeId: string | null;
  /** Caminho a destacar (ids de nós e de relações reais do grafo). */
  pathHighlight: { nodes: string[]; edges: string[] } | null;
  /** Mudanças do git a destacar: o que mudou e o que é afetado. */
  changeHighlight: { changed: string[]; impacted: string[] } | null;
  highlightNeighbors: boolean;
  /** Mostra o minimapa no canto do mapa. */
  minimap: boolean;
  /** Muda quando o mapa deve reenquadrar tudo (ex.: trocar de nível ou entrar no foco). */
  fitKey: string;
  /** Pedido para centralizar um nó (o número garante que pedidos repetidos sejam atendidos). */
  centerRequest: { id: string; seq: number; fitIds?: string[] } | null;
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

/** As classes do elemento já são exatamente estas? (evita reaplicar estilo à toa) */
function sameClasses(el: cytoscape.SingularElementReturnValue, classes: string): boolean {
  const wanted = classes.split(' ').filter(Boolean);
  const current = el.classes();
  return current.length === wanted.length && wanted.every((c) => el.hasClass(c));
}

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
  // os eventos do Cytoscape são registrados uma vez; leem o idioma atual por esta referência
  const i18n = useI18n();
  const i18nRef = useRef(i18n);
  i18nRef.current = i18n;
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [busy, setBusy] = useState(false);
  const [cyInstance, setCyInstance] = useState<Core | null>(null);
  /** Fator de ampliação dos rótulos dos grupos (lido pelo estilo, sem criar regras novas). */
  const labelScale = useRef(1);
  const groupWidths = useRef(new Map<string, number>());
  const currentLayout = useRef<cytoscape.Layouts | null>(null);
  const layoutActive = useRef(false);
  const pendingCenter = useRef<{ id: string; fitIds?: string[] } | null>(null);

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

  /** Centraliza o nó pedido (se ainda estiver no mapa). */
  const centerPending = () => {
    const cy = cyRef.current;
    const pending = pendingCenter.current;
    pendingCenter.current = null;
    if (!cy || !pending) return;
    // vários nós (ex.: um caminho): enquadra todos, sem aproximar demais
    if (pending.fitIds?.length) {
      const wanted = new Set(pending.fitIds);
      const eles = cy.nodes().filter((n) => wanted.has(n.id()));
      if (eles.nonempty()) {
        const before = { zoom: cy.zoom(), pan: { ...cy.pan() } };
        cy.fit(eles, 80);
        if (cy.zoom() > MAX_FIT_ZOOM) {
          cy.zoom(MAX_FIT_ZOOM);
          cy.center(eles);
        }
        const target = { zoom: cy.zoom(), pan: { ...cy.pan() } };
        cy.viewport(before);
        cy.animate(target, { duration: 380, easing: 'ease-out-cubic' });
        return;
      }
    }
    const node = cy.getElementById(pending.id);
    if (node.empty()) return;
    cy.animate(
      { center: { eles: node }, zoom: Math.max(cy.zoom(), 1) },
      { duration: 350, easing: 'ease-out-cubic' },
    );
  };

  /** Fim de um layout: enquadra (se pedido), libera o indicador e atende a centralização pendente. */
  const finishLayout = (run: number, fit: boolean, animate: boolean) => {
    if (run !== layoutRun.current) return;
    layoutActive.current = false;
    setBusy(false);
    // guarda a largura de cada grupo para o estilo dos rótulos (fora do Cytoscape: gravar em
    // data() dispararia recálculo de estilo de todos os descendentes)
    groupWidths.current.clear();
    cyRef.current?.nodes(':parent').forEach((n) => void groupWidths.current.set(n.id(), n.width()));
    if (fit) fitAll(animate);
    if (pendingCenter.current) setTimeout(centerPending, fit && animate ? 340 : 0);
  };

  const runLayout = (fit: boolean) => {
    const cy = cyRef.current;
    if (!cy || cy.nodes().empty()) return;
    const run = ++layoutRun.current;
    const animate = !firstLayout.current && cy.nodes().length < 500;
    firstLayout.current = false;
    // um layout novo substitui o anterior (animações em andamento param aqui)
    currentLayout.current?.stop();
    layoutActive.current = true;
    setTooltip(null);

    const runOrganic = (organicFit: boolean, organicAnimate: boolean) => {
      const layout = cy.layout({
        name: 'fcose',
        quality: cy.nodes().length > 400 ? 'draft' : 'default',
        randomize: !organicAnimate,
        animate: organicAnimate,
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
      currentLayout.current = layout;
      layout.one('layoutstop', () => finishLayout(run, organicFit, organicAnimate));
      layout.run();
    };

    if (handlers.current.layout === 'organic') {
      setBusy(false);
      runOrganic(fit, animate);
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
        currentLayout.current = layout;
        layout.one('layoutstop', () => finishLayout(run, fit, animate));
        layout.run();
      })
      .catch((err: unknown) => {
        if (err instanceof LayoutCancelled || run !== layoutRun.current || cyRef.current !== cy)
          return;
        // se o ELK falhar (grafo patológico), cai para o layout orgânico
        console.warn('Layout hierárquico falhou, usando o orgânico.', err);
        runOrganic(true, false);
      });
  };

  // criação do Cytoscape
  useEffect(() => {
    const cy = cytoscape({
      container: containerRef.current,
      style: buildStyle(
        handlers.current.palette,
        () => labelScale.current,
        (id) => groupWidths.current.get(id),
      ),
      minZoom: 0.04,
      maxZoom: 4,
      boxSelectionEnabled: false,
      autounselectify: true,
    });
    cyRef.current = cy;
    setCyInstance(cy);
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
      const { t, labels } = i18nRef.current;
      const kind = labels.node[n.data('kind') as NodeKind];
      const hint = n.data('collapsed')
        ? t.tooltip.openFolder
        : n.data('expandable')
          ? n.data('expanded')
            ? t.tooltip.collapseSymbols
            : t.tooltip.showSymbols
          : n.isParent() && n.data('kind') === 'module'
            ? t.tooltip.collapseFolder
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
      const { t, labels } = i18nRef.current;
      const label = labels.edge[edge.data('kind') as EdgeKind];
      const mid = edge.renderedMidpoint();
      show(
        `${edge.source().data('full')} → ${edge.target().data('full')}`,
        `${label}${count > 1 ? ` · ${count}×` : ''}${edge.data('aggregated') ? t.tooltip.aggregated : ''}${t.tooltip.clickEvidence}`,
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

    // rótulos dos grupos crescem quando o zoom diminui, para o mapa continuar legível de longe;
    // o estilo lê a escala de uma referência, então só recalculamos (nenhuma regra nova é criada)
    // o recálculo espera o zoom parar (uma animação muda o zoom a cada quadro) e só toca nos
    // grupos, que são os únicos afetados
    let zoomTimer: ReturnType<typeof setTimeout> | undefined;
    cy.on('zoom', () => {
      clearTimeout(zoomTimer);
      zoomTimer = setTimeout(() => {
        const scale = Math.min(4, Math.max(1, 0.9 / cy.zoom()));
        if (Math.abs(scale - labelScale.current) < 0.08) return;
        labelScale.current = scale;
        // updateStyle existe no Cytoscape, mas não está na tipagem oficial
        (cy.nodes(':parent') as unknown as { updateStyle(): void }).updateStyle();
      }, 120);
    });

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
      setCyInstance(null);
    };
  }, []);

  useEffect(() => {
    cyRef.current?.style(
      buildStyle(
        props.palette,
        () => labelScale.current,
        (id) => groupWidths.current.get(id),
      ),
    );
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
      const depth = new Map(view.nodes.map((n) => [n.id, depthOf(n, byId)]));
      const sorted = [...view.nodes].sort((a, b) => depth.get(a.id)! - depth.get(b.id)!);
      const ext = cy.extent();
      const viewportCenter = { x: (ext.x1 + ext.x2) / 2, y: (ext.y1 + ext.y2) / 2 };
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
          // só escreve o que mudou: cada alteração de estilo em um grupo invalida o cache de
          // todos os descendentes dele (caríssimo com milhares de nós)
          if (existing.data('display') !== display) {
            structural = true; // tamanho mudou
            existing.data({ display, w: estimateNodeWidth(display, n.kind, n.collapsed) });
          }
          if (
            existing.data('expandable') !== n.expandable ||
            existing.data('expanded') !== n.expanded ||
            existing.data('collapsed') !== n.collapsed
          )
            existing.data({
              expandable: n.expandable,
              expanded: n.expanded,
              collapsed: n.collapsed,
            });
          if (!sameClasses(existing, classes)) existing.classes(classes);
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
        const base = anchor ?? viewportCenter;
        cy.add({
          group: 'nodes',
          data: {
            id: n.id,
            kind: n.kind,
            display,
            w: estimateNodeWidth(display, n.kind, n.collapsed),
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
          if (existing.data('count') !== e.count || existing.data('resolution') !== e.resolution)
            existing.data({ count: e.count, resolution: e.resolution });
          if ((existing.data('members') as string[] | undefined)?.join('|') !== e.members.join('|'))
            existing.data('members', e.members);
          if (!sameClasses(existing, classes)) existing.classes(classes);
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
            members: e.members,
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
      cy.elements().removeClass('faded highlight chosen path changed impacted impact-edge');
      if (
        props.changeHighlight &&
        !props.selectedId &&
        !props.selectedEdgeId &&
        !props.pathHighlight
      ) {
        const changed = new Set(props.changeHighlight.changed);
        const impacted = new Set(props.changeHighlight.impacted);
        const changedNodes = cy.nodes().filter((n) => changed.has(n.id()));
        const impactedNodes = cy.nodes().filter((n) => impacted.has(n.id()));
        changedNodes.addClass('changed');
        impactedNodes.addClass('impacted');
        const involved = changedNodes.union(impactedNodes);
        // linhas entre o que mudou e o que é afetado mostram por onde o impacto chega
        const edges = involved.edgesWith(involved);
        edges.addClass('impact-edge');
        const keep = involved.union(edges).union(involved.ancestors());
        if (involved.nonempty()) cy.elements().not(keep).addClass('faded');
        return;
      }
      if (props.pathHighlight) {
        // caminho: os nós e as linhas que representam cada passo ficam em destaque
        const nodeIds = new Set(props.pathHighlight.nodes);
        const edgeIds = new Set(props.pathHighlight.edges);
        const nodes = cy.nodes().filter((n) => nodeIds.has(n.id()));
        const edges = cy
          .edges()
          .filter((e) =>
            ((e.data('members') as string[] | undefined) ?? [e.id()]).some((m) => edgeIds.has(m)),
          );
        nodes.addClass('path');
        edges.addClass('path');
        const keep = nodes.union(edges).union(nodes.ancestors());
        cy.elements().not(keep).addClass('faded');
        return;
      }
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
  }, [
    props.selectedId,
    props.selectedEdgeId,
    props.highlightNeighbors,
    props.view,
    props.pathHighlight,
    props.changeHighlight,
  ]);

  // centraliza quando pedido: se um layout estiver em andamento, espera ele terminar
  useEffect(() => {
    const req = props.centerRequest;
    if (!req) return;
    pendingCenter.current = { id: req.id, ...(req.fitIds ? { fitIds: req.fitIds } : {}) };
    if (!layoutActive.current) centerPending();
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
    reveal: (id) => {
      const cy = cyRef.current;
      const node = cy?.getElementById(id);
      if (!cy || !node || node.empty()) return;
      const box = node.renderedBoundingBox();
      const margin = 60;
      const dx =
        box.x1 < margin
          ? margin - box.x1
          : box.x2 > cy.width() - margin
            ? cy.width() - margin - box.x2
            : 0;
      const dy =
        box.y1 < margin
          ? margin - box.y1
          : box.y2 > cy.height() - margin
            ? cy.height() - margin - box.y2
            : 0;
      // nó maior que a tela (ex.: uma pasta inteira): centraliza
      if (box.w > cy.width() - 2 * margin || box.h > cy.height() - 2 * margin) {
        cy.animate({ center: { eles: node } }, { duration: 220, easing: 'ease-out-cubic' });
        return;
      }
      if (dx || dy) {
        const pan = cy.pan();
        cy.animate(
          { pan: { x: pan.x + dx, y: pan.y + dy } },
          { duration: 220, easing: 'ease-out-cubic' },
        );
      }
    },
    nearest: (fromId, direction) => {
      const cy = cyRef.current;
      if (!cy) return null;
      const from = fromId ? cy.getElementById(fromId) : null;
      if (!from || from.empty()) {
        // sem seleção: o nó (não grupo) mais perto do centro da tela
        const ext = cy.extent();
        const cx = (ext.x1 + ext.x2) / 2;
        const cyy = (ext.y1 + ext.y2) / 2;
        let best: string | null = null;
        let bestD = Infinity;
        cy.nodes()
          .filter((n) => !n.isParent())
          .forEach((n) => {
            const p = n.position();
            const d = (p.x - cx) ** 2 + (p.y - cyy) ** 2;
            if (d < bestD) {
              bestD = d;
              best = n.id();
            }
          });
        return best;
      }
      // ignora quem contém o nó e quem está dentro dele: andar "para cima" não deve cair na pasta
      const skip = from.ancestors().union(from.descendants()).union(from);
      const origin = from.position();
      const [ax, ay] =
        direction === 'up'
          ? [0, -1]
          : direction === 'down'
            ? [0, 1]
            : direction === 'left'
              ? [-1, 0]
              : [1, 0];
      let best: string | null = null;
      let bestScore = Infinity;
      cy.nodes()
        .not(skip)
        .forEach((n) => {
          const p = n.position();
          const dx = p.x - origin.x;
          const dy = p.y - origin.y;
          const along = dx * ax + dy * ay;
          if (along <= 1) return;
          const across = Math.abs(dx * ay - dy * ax);
          // fora do cone de 45° só conta se não houver nada dentro dele
          const score = along + across * (across > along ? 6 : 2);
          if (score < bestScore) {
            bestScore = score;
            best = n.id();
          }
        });
      return best;
    },
    png: (background) =>
      cyRef.current?.png({
        output: 'blob',
        full: true,
        scale: 2,
        bg: background,
        // mapas enormes geram imagens vazias (limite do canvas); limitamos o tamanho
        maxWidth: 8000,
        maxHeight: 8000,
      }) as Blob | undefined,
  }));

  return (
    <>
      <div
        ref={containerRef}
        className="graph-canvas"
        role="application"
        aria-label={i18n.t.stage.mapAria}
      />
      {tooltip && (
        <div className="graph-tooltip" style={{ left: tooltip.x, top: tooltip.y }} role="tooltip">
          <strong>{tooltip.title}</strong>
          <span>{tooltip.detail}</span>
        </div>
      )}
      {props.minimap && cyInstance && <Minimap cy={cyInstance} palette={props.palette} />}
      {busy && (
        <div className="layout-busy" aria-live="polite">
          {i18n.t.stage.organizing}
        </div>
      )}
    </>
  );
});
