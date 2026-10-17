import type { DiscoveryMethod, UnresolvedReason } from '@teia/core';

export const REASON_TEXT: Record<UnresolvedReason, string> = {
  'module-not-found': 'O arquivo importado não foi encontrado no projeto.',
  'undeclared-package':
    'Parece um pacote, mas não está no package.json nem em node_modules (ou é um alias que não foi resolvido).',
  'symbol-not-found': 'Não existe declaração conhecida para este nome no código analisado.',
  'indirect-call':
    'Chamada feita por meio de uma variável, parâmetro ou interface. O alvo real só é conhecido durante a execução.',
  'dynamic-import':
    'O caminho do módulo é calculado em tempo de execução, então não pode ser resolvido estaticamente.',
  'unknown-base-class': 'A classe base não pôde ser localizada.',
};

export const DISCOVERY_TEXT: Record<DiscoveryMethod, string> = {
  'static-ast': 'lido da árvore sintática',
  'static-typecheck': 'confirmado pelo verificador de tipos',
  derived: 'derivado de outras relações',
  'framework-rule': 'regra de framework (Express)',
};

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
