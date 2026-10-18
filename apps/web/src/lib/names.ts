import type { GraphNode } from '@rastro/core';

/**
 * Nome de uma entidade em listas e títulos, igual em toda a interface: método como
 * `Classe.metodo`, rota como `GET /usuarios`, arquivo e pasta pelo caminho e a pasta raiz com
 * o nome do projeto (no grafo ela se chama "(raiz)").
 */
export function entityName(node: GraphNode, projectName?: string): string {
  if (node.kind === 'module' && !node.parent) return projectName ?? node.name;
  if (node.kind === 'route') return node.name;
  return node.qualifiedName ?? node.name;
}

/** Como `entityName`, mas arquivos só pelo nome (quando o caminho já aparece ao lado). */
export function shortEntityName(node: GraphNode, projectName?: string): string {
  return node.kind === 'file' ? node.name : entityName(node, projectName);
}
