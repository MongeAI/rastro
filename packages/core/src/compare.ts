/**
 * Comparação de textos por unidade de código, independente do idioma da máquina.
 * `localeCompare` muda a ordem conforme o locale (ex.: "å" em sv_SE), o que quebraria
 * o determinismo do grafo.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
