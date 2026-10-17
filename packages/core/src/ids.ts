import type { EdgeKind } from './model.js';

/** Funções que geram ids estáveis e legíveis. Caminhos são sempre relativos à raiz, com `/`. */
export const nodeId = {
  module: (dir: string) => `module:${dir === '' ? '.' : dir}`,
  file: (file: string) => `file:${file}`,
  function: (file: string, name: string) => `fn:${file}#${name}`,
  class: (file: string, name: string) => `class:${file}#${name}`,
  method: (file: string, className: string, member: string) =>
    `method:${file}#${className}.${member}`,
  route: (file: string, receiver: string, httpMethod: string, path: string) =>
    `route:${file}#${receiver} ${httpMethod} ${path}`,
  package: (name: string) => `pkg:${name}`,
  unresolved: (file: string, kind: 'import' | 'call' | 'extends', reference: string) =>
    `unresolved:${file}#${kind}:${reference}`,
};

export function edgeId(kind: EdgeKind, source: string, target: string): string {
  return `${kind}:${source}->${target}`;
}
