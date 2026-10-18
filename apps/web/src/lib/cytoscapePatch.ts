import type { Core } from 'cytoscape';

/**
 * Propriedades de que dependem os estados derivados que o Cytoscape guarda em cache
 * (`visible`, `takesUpSpace`, `interactive`, `isBundledBezier`).
 */
export const DERIVED_STATE_PROPS = new Set([
  'display',
  'visibility',
  'opacity',
  'events',
  'curve-style',
  'width',
  'height',
]);

/** O mesmo valor de estilo? (números e textos; listas, item a item) */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

/**
 * Atalhos para um caminho quente do Cytoscape, com o mesmo resultado:
 *
 * - a cada propriedade de estilo aplicada, `checkTriggers` invalida o cache de estados
 *   derivados do elemento, dos descendentes, dos pais e das linhas conectadas. Isso só é
 *   necessário quando muda (de fato) uma propriedade da qual esses estados dependem; para
 *   cor, fonte, borda, ou para o mesmo valor reaplicado, basta o próprio elemento. Com grupos
 *   de milhares de nós, a invalidação ampla a cada propriedade custava segundos (e, no nível
 *   de símbolos de um projeto grande, minutos);
 * - para linhas, o conjunto invalidado é sempre só a própria linha, então não é montado.
 */
export function patchStyleCache(cy: Core) {
  interface Ele {
    isEdge(): boolean;
    _private: { styleCache: unknown; parent?: Ele | null; children?: Ele[]; edges?: Ele[] };
  }
  type Eles = Ele[] & { dirtyStyleCache(): unknown };
  const eles = Object.getPrototypeOf(cy.collection()) as {
    dirtyStyleCache(this: Eles): Eles;
    __rastroPatched?: boolean;
  };
  if (eles.__rastroPatched) return;
  eles.__rastroPatched = true;
  // o mesmo conjunto do original (elemento, descendentes, pais e as linhas de todos eles),
  // percorrido direto na árvore em vez de montar coleções intermediárias a cada chamada
  const clear = (el: Ele) => {
    el._private.styleCache = null;
    for (const edge of el._private.edges ?? []) edge._private.styleCache = null;
  };
  eles.dirtyStyleCache = function (this: Eles) {
    for (let i = 0; i < this.length; i++) {
      const el = this[i]!;
      if (el.isEdge()) {
        el._private.styleCache = null;
        continue;
      }
      clear(el);
      const stack = [...(el._private.children ?? [])];
      while (stack.length) {
        const child = stack.pop()!;
        clear(child);
        if (child._private.children?.length) stack.push(...child._private.children);
      }
      for (let p = el._private.parent; p; p = p._private.parent) clear(p);
    }
    return this;
  };

  type Check = (ele: Eles & Ele, name: string, from: unknown, to: unknown) => void;
  const style = Object.getPrototypeOf(cy.style()) as {
    checkTriggers: Check;
    checkZOrderTrigger: Check;
    checkBoundsTrigger: Check;
    checkConnectedEdgesBoundsTrigger: Check;
    checkParallelEdgesBoundsTrigger: Check;
  };
  style.checkTriggers = function (ele, name, from, to) {
    // `from`/`to` são os valores (pfValue ou value) antes e depois. Reaplicar o mesmo valor
    // (o caso comum ao recalcular o estilo de milhares de nós) não muda nenhum estado derivado
    if (DERIVED_STATE_PROPS.has(name) && !sameValue(from, to)) ele.dirtyStyleCache();
    else ele._private.styleCache = null;
    this.checkZOrderTrigger(ele, name, from, to);
    this.checkBoundsTrigger(ele, name, from, to);
    this.checkConnectedEdgesBoundsTrigger(ele, name, from, to);
    this.checkParallelEdgesBoundsTrigger(ele, name, from, to);
  };
}
