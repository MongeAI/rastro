/**
 * Etapas da análise informadas a `onProgress`. Cada etapa tem um código estável e os seus
 * parâmetros, para quem chama (a CLI, por exemplo) mostrar o texto no próprio idioma.
 * O texto padrão, em português, continua sendo o primeiro argumento de `onProgress`.
 */
export type ProgressEvent =
  | { code: 'discovering' }
  | { code: 'discovered'; files: number }
  | { code: 'loading-compiler' }
  | { code: 'extracting' }
  | { code: 'resolving' }
  | { code: 'building-graph' }
  | { code: 'done'; durationMs: number };

export type ProgressCode = ProgressEvent['code'];

/** Todos os códigos de progresso, na ordem em que acontecem. */
export const PROGRESS_CODES: readonly ProgressCode[] = [
  'discovering',
  'discovered',
  'loading-compiler',
  'extracting',
  'resolving',
  'building-graph',
  'done',
];

/** Texto padrão (português) de uma etapa. */
export function progressMessage(event: ProgressEvent): string {
  switch (event.code) {
    case 'discovering':
      return 'Procurando arquivos JavaScript/TypeScript...';
    case 'discovered':
      return `${event.files} ${event.files === 1 ? 'arquivo encontrado' : 'arquivos encontrados'}.`;
    case 'loading-compiler':
      return 'Construindo o modelo do compilador...';
    case 'extracting':
      return 'Extraindo arquivos, funções, classes e métodos...';
    case 'resolving':
      return 'Resolvendo imports, exports e chamadas...';
    case 'building-graph':
      return 'Montando o grafo...';
    case 'done':
      return `Concluído em ${event.durationMs} ms.`;
  }
}
