import type { EdgeKind, NodeKind, Resolution } from './model.js';

/** Rótulos em português usados pela CLI e pela interface. */
export const NODE_KIND_LABELS: Record<NodeKind, string> = {
  module: 'Pasta',
  file: 'Arquivo',
  function: 'Função',
  class: 'Classe',
  method: 'Método',
  route: 'Rota',
  package: 'Pacote externo',
  unresolved: 'Não resolvido',
};

export const EDGE_KIND_LABELS: Record<EdgeKind, string> = {
  contains: 'Contém',
  imports: 'Importa',
  exports: 'Exporta',
  calls: 'Chama',
  extends: 'Estende',
  depends_on: 'Depende de',
};

/** Rótulo da relação lida no sentido inverso (destino ← origem). */
export const EDGE_KIND_INVERSE_LABELS: Record<EdgeKind, string> = {
  contains: 'Contido em',
  imports: 'Importado por',
  exports: 'Exportado por',
  calls: 'Chamado por',
  extends: 'Estendido por',
  depends_on: 'Dependência de',
};

export const RESOLUTION_LABELS: Record<Resolution, string> = {
  resolved: 'Resolvida no projeto',
  external: 'Externa ao projeto',
  unresolved: 'Não resolvida',
};

/** Idiomas suportados pela interface e pela CLI. */
export type Lang = 'pt' | 'en';

export const NODE_KIND_LABELS_EN: Record<NodeKind, string> = {
  module: 'Folder',
  file: 'File',
  function: 'Function',
  class: 'Class',
  method: 'Method',
  route: 'Route',
  package: 'External package',
  unresolved: 'Unresolved',
};

export const EDGE_KIND_LABELS_EN: Record<EdgeKind, string> = {
  contains: 'Contains',
  imports: 'Imports',
  exports: 'Exports',
  calls: 'Calls',
  extends: 'Extends',
  depends_on: 'Depends on',
};

export const EDGE_KIND_INVERSE_LABELS_EN: Record<EdgeKind, string> = {
  contains: 'Contained in',
  imports: 'Imported by',
  exports: 'Exported by',
  calls: 'Called by',
  extends: 'Extended by',
  depends_on: 'Dependency of',
};

export const RESOLUTION_LABELS_EN: Record<Resolution, string> = {
  resolved: 'Resolved in the project',
  external: 'External to the project',
  unresolved: 'Unresolved',
};

/** Rótulos dos tipos de nó e de relação no idioma pedido. */
export function kindLabels(lang: Lang) {
  return lang === 'en'
    ? {
        node: NODE_KIND_LABELS_EN,
        edge: EDGE_KIND_LABELS_EN,
        edgeInverse: EDGE_KIND_INVERSE_LABELS_EN,
        resolution: RESOLUTION_LABELS_EN,
      }
    : {
        node: NODE_KIND_LABELS,
        edge: EDGE_KIND_LABELS,
        edgeInverse: EDGE_KIND_INVERSE_LABELS,
        resolution: RESOLUTION_LABELS,
      };
}
