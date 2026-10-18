import { useEffect, useRef } from 'react';
import type { Core, NodeSingular } from 'cytoscape';
import type { NodeKind } from '@rastro/core';
import { useI18n } from '../lib/i18n';
import type { Palette } from '../lib/theme';

const WIDTH = 200;
const HEIGHT = 128;
const PAD = 6;
/** Intervalo mínimo entre redesenhos dos nós (o retângulo da tela acompanha cada quadro). */
const NODES_EVERY_MS = 120;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Frame {
  x1: number;
  y1: number;
  scale: number;
  offX: number;
  offY: number;
}

/**
 * Visão geral do mapa: todos os nós em miniatura e o retângulo do que está na tela.
 * Clicar ou arrastar move a visão. Os nós são desenhados numa camada guardada à parte, então
 * mover o mapa só redesenha o retângulo.
 */
export function Minimap({ cy, palette }: { cy: Core; palette: Palette }) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  const frame = useRef<Frame | null>(null);
  const redrawRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    const ctx = canvas.getContext('2d');
    const layer = document.createElement('canvas');
    layer.width = canvas.width;
    layer.height = canvas.height;
    const layerCtx = layer.getContext('2d');
    if (!ctx || !layerCtx) return;

    let lastNodes = 0;
    let pending = 0;
    let dirty = true;
    let trailing: ReturnType<typeof setTimeout> | undefined;

    const drawNodes = () => {
      const p = paletteRef.current;
      layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      layerCtx.clearRect(0, 0, WIDTH, HEIGHT);
      const nodes = cy.nodes();
      if (nodes.empty()) {
        frame.current = null;
        return;
      }
      // retângulos em coordenadas do mapa; nós simples só precisam de posição e tamanho
      // (boundingBox() de milhares de nós custava mais de um segundo por desenho)
      const groups: Box[] = [];
      const leaves: Array<Box & { node: NodeSingular }> = [];
      let x1 = Infinity;
      let y1 = Infinity;
      let x2 = -Infinity;
      let y2 = -Infinity;
      nodes.forEach((n) => {
        let b: Box;
        if (n.isParent()) {
          const bb = n.boundingBox({ includeLabels: false });
          b = { x: bb.x1, y: bb.y1, w: bb.w, h: bb.h };
          groups.push(b);
        } else {
          const pos = n.position();
          const w = n.width();
          const h = n.height();
          b = { x: pos.x - w / 2, y: pos.y - h / 2, w, h };
          leaves.push({ ...b, node: n });
        }
        x1 = Math.min(x1, b.x);
        y1 = Math.min(y1, b.y);
        x2 = Math.max(x2, b.x + b.w);
        y2 = Math.max(y2, b.y + b.h);
      });
      const bw = x2 - x1 || 1;
      const bh = y2 - y1 || 1;
      const scale = Math.min((WIDTH - 2 * PAD) / bw, (HEIGHT - 2 * PAD) / bh);
      const f: Frame = {
        x1,
        y1,
        scale,
        offX: (WIDTH - bw * scale) / 2,
        offY: (HEIGHT - bh * scale) / 2,
      };
      frame.current = f;
      const rect = (b: Box) =>
        [
          f.offX + (b.x - f.x1) * scale,
          f.offY + (b.y - f.y1) * scale,
          Math.max(1.5, b.w * scale),
          Math.max(1.5, b.h * scale),
        ] as const;
      // grupos (pastas, arquivos expandidos) só com contorno; nós com a cor do tipo
      layerCtx.lineWidth = 1;
      layerCtx.strokeStyle = p.border;
      for (const g of groups) {
        const [x, y, w, h] = rect(g);
        layerCtx.strokeRect(x + 0.5, y + 0.5, w, h);
      }
      for (const leaf of leaves) {
        const n = leaf.node;
        const [x, y, w, h] = rect(leaf);
        layerCtx.globalAlpha = n.hasClass('faded') ? 0.25 : 0.9;
        layerCtx.fillStyle = n.hasClass('chosen')
          ? p.selection
          : n.hasClass('changed')
            ? p.changed
            : p.node[n.data('kind') as NodeKind];
        layerCtx.fillRect(x, y, w, h);
      }
      layerCtx.globalAlpha = 1;
      lastNodes = performance.now();
    };

    const draw = () => {
      pending = 0;
      if (dirty) {
        if (performance.now() - lastNodes >= NODES_EVERY_MS) {
          dirty = false;
          drawNodes();
        } else if (!trailing) {
          // a última mudança de uma rajada (ex.: fim de uma animação) também aparece
          trailing = setTimeout(() => {
            trailing = undefined;
            schedule();
          }, NODES_EVERY_MS);
        }
      }
      const p = paletteRef.current;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(layer, 0, 0);
      const f = frame.current;
      if (!f) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const ext = cy.extent();
      const x = f.offX + (ext.x1 - f.x1) * f.scale;
      const y = f.offY + (ext.y1 - f.y1) * f.scale;
      const w = ext.w * f.scale;
      const h = ext.h * f.scale;
      ctx.fillStyle = p.text;
      ctx.globalAlpha = 0.07;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = p.text;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.globalAlpha = 1;
    };

    const schedule = () => {
      if (!pending) pending = requestAnimationFrame(draw);
    };
    const markDirty = () => {
      dirty = true;
      schedule();
    };
    redrawRef.current = () => {
      lastNodes = 0;
      markDirty();
    };
    // nós mudam com posições, classes (seleção, destaque) e entradas/saídas; a câmera só
    // move o retângulo
    cy.on('add remove position class', markDirty);
    cy.on('viewport resize', schedule);
    redrawRef.current();
    return () => {
      cy.off('add remove position class', markDirty);
      cy.off('viewport resize', schedule);
      clearTimeout(trailing);
      if (pending) cancelAnimationFrame(pending);
      redrawRef.current = null;
    };
  }, [cy]);

  useEffect(() => redrawRef.current?.(), [palette]);

  /** Centraliza o mapa no ponto do minimapa sob o ponteiro. */
  const panTo = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const f = frame.current;
    if (!f) return;
    const box = e.currentTarget.getBoundingClientRect();
    const mx = (e.clientX - box.left - f.offX) / f.scale + f.x1;
    const my = (e.clientY - box.top - f.offY) / f.scale + f.y1;
    const zoom = cy.zoom();
    cy.stop();
    cy.pan({ x: cy.width() / 2 - mx * zoom, y: cy.height() / 2 - my * zoom });
  };

  return (
    <canvas
      ref={canvasRef}
      className="minimap"
      style={{ width: WIDTH, height: HEIGHT }}
      role="img"
      aria-label={t.stage.minimap}
      title={t.stage.minimapTitle}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        panTo(e);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) panTo(e);
      }}
    />
  );
}
