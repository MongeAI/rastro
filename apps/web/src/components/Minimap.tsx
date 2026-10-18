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
      const bb = nodes.boundingBox({ includeLabels: false });
      const scale = Math.min((WIDTH - 2 * PAD) / (bb.w || 1), (HEIGHT - 2 * PAD) / (bb.h || 1));
      const f: Frame = {
        x1: bb.x1,
        y1: bb.y1,
        scale,
        offX: (WIDTH - bb.w * scale) / 2,
        offY: (HEIGHT - bb.h * scale) / 2,
      };
      frame.current = f;
      const rect = (n: NodeSingular) => {
        const b = n.boundingBox({ includeLabels: false });
        return [
          f.offX + (b.x1 - f.x1) * scale,
          f.offY + (b.y1 - f.y1) * scale,
          Math.max(1.5, b.w * scale),
          Math.max(1.5, b.h * scale),
        ] as const;
      };
      // grupos (pastas, arquivos expandidos) só com contorno; nós com a cor do tipo
      layerCtx.lineWidth = 1;
      layerCtx.strokeStyle = p.border;
      nodes.parents().forEach((n) => {
        const [x, y, w, h] = rect(n);
        layerCtx.strokeRect(x + 0.5, y + 0.5, w, h);
      });
      nodes
        .filter((n) => !n.isParent())
        .forEach((n) => {
          const [x, y, w, h] = rect(n);
          const faded = n.hasClass('faded');
          layerCtx.globalAlpha = faded ? 0.25 : 0.9;
          layerCtx.fillStyle = n.hasClass('chosen')
            ? p.selection
            : n.hasClass('changed')
              ? p.changed
              : p.node[n.data('kind') as NodeKind];
          layerCtx.fillRect(x, y, w, h);
        });
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
