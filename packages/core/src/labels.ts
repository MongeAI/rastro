import type { EdgeKind, NodeKind, Resolution } from './model.js';

/** Rótulos em português usados pela CLI e pela interface. */
export const NODE_KIND_LABELS: Record<NodeKind, string> = {
  module: 'Módulo',
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
