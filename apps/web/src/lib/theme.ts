import type { EdgeKind, NodeKind } from '@rastro/core';

export type ThemeName = 'dark' | 'light';

export interface Palette {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  faint: string;
  border: string;
  selection: string;
  cycle: string;
  /** Mudanças do git: o que mudou e o que é afetado. */
  changed: string;
  unresolved: string;
  node: Record<NodeKind, string>;
  edge: Record<EdgeKind, string>;
}

/**
 * Cores dos tipos de nó e relação. A base é preto e branco (identidade MongeAI);
 * as cores existem só para diferenciar tipos no mapa, sempre acompanhadas de forma e rótulo.
 */
export const PALETTES: Record<ThemeName, Palette> = {
  dark: {
    bg: '#000000',
    surface: '#0c0c0d',
    text: '#f4f4f5',
    muted: '#8a8a93',
    faint: '#2a2a2e',
    border: '#3f3f46',
    selection: '#ffffff',
    cycle: '#fb923c',
    changed: '#4ade80',
    unresolved: '#f87171',
    node: {
      module: '#71717a',
      file: '#e4e4e7',
      function: '#60a5fa',
      class: '#c084fc',
      method: '#2dd4bf',
      route: '#fbbf24',
      package: '#a1a1aa',
      unresolved: '#f87171',
    },
    edge: {
      contains: '#3f3f46',
      imports: '#71717a',
      exports: '#52525b',
      calls: '#38bdf8',
      extends: '#c084fc',
      depends_on: '#f472b6',
    },
  },
  light: {
    bg: '#ffffff',
    surface: '#fafafa',
    text: '#09090b',
    muted: '#71717a',
    faint: '#e4e4e7',
    border: '#d4d4d8',
    selection: '#000000',
    cycle: '#ea580c',
    changed: '#16a34a',
    unresolved: '#dc2626',
    node: {
      module: '#a1a1aa',
      file: '#27272a',
      function: '#2563eb',
      class: '#9333ea',
      method: '#0d9488',
      route: '#d97706',
      package: '#71717a',
      unresolved: '#dc2626',
    },
    edge: {
      contains: '#d4d4d8',
      imports: '#a1a1aa',
      exports: '#d4d4d8',
      calls: '#0284c7',
      extends: '#9333ea',
      depends_on: '#db2777',
    },
  },
};

/** Forma de cada tipo de nó no mapa (também usada na legenda). */
export const NODE_SHAPES: Record<NodeKind, string> = {
  module: 'round-rectangle',
  file: 'round-rectangle',
  function: 'round-rectangle',
  class: 'round-hexagon',
  method: 'round-rectangle',
  route: 'round-tag',
  package: 'barrel',
  unresolved: 'round-diamond',
};
