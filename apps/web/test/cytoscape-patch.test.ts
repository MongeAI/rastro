/**
 * O patchStyleCache precisa ter o mesmo resultado do Cytoscape original: estes testes rodam o
 * Cytoscape sem tela (headless) com o atalho ligado e conferem os estados derivados.
 */
import cytoscape from 'cytoscape';
import { describe, expect, it } from 'vitest';
import { patchStyleCache, sameValue } from '../src/lib/cytoscapePatch';

function graph() {
  const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    style: [
      // como no mapa: largura vinda dos dados, reaplicada a cada mudança de classe
      { selector: 'node', style: { opacity: 1, display: 'element', width: 'data(w)' } },
      { selector: '.tinted', style: { 'background-color': '#ff0000' } },
      { selector: '.same', style: { display: 'element', opacity: 1 } },
      { selector: '.hidden', style: { display: 'none' } },
      { selector: '.ghost', style: { opacity: 0 } },
    ],
    elements: [
      { data: { id: 'g', w: 20 } },
      { data: { id: 'a', parent: 'g', w: 20 } },
      { data: { id: 'b', parent: 'g', w: 20 } },
      { data: { id: 'c', w: 20 } },
      { data: { id: 'ab', source: 'a', target: 'b' } },
      { data: { id: 'bc', source: 'b', target: 'c' } },
    ],
  });
  patchStyleCache(cy);
  return cy;
}

/**
 * O Cytoscape aplica o estilo sob demanda; quem desenha o mapa lê o estilo de todos os elementos
 * antes de consultar os estados derivados. Aqui fazemos o mesmo.
 */
const flush = (cy: cytoscape.Core) => cy.elements().forEach((e) => void e.pstyle('display'));
/** Estados derivados de todos, já em cache (o caso em que a invalidação importa). */
const warm = (cy: cytoscape.Core) => {
  flush(cy);
  cy.elements().forEach((e) => void e.visible());
};

const cacheOf = (cy: cytoscape.Core, id: string) =>
  (cy.getElementById(id) as unknown as { _private: { styleCache: unknown } })._private.styleCache;

describe('patchStyleCache', () => {
  it('compara valores de estilo (textos, números e listas)', () => {
    expect(sameValue('none', 'none')).toBe(true);
    expect(sameValue(1, 1)).toBe(true);
    expect(sameValue([1, 2], [1, 2])).toBe(true);
    expect(sameValue('none', 'element')).toBe(false);
    expect(sameValue(null, 'element')).toBe(false);
    expect(sameValue([1, 2], [1, 3])).toBe(false);
  });

  it('esconder o grupo esconde os filhos e as linhas deles', () => {
    const cy = graph();
    warm(cy);
    expect(cy.getElementById('a').visible()).toBe(true);
    expect(cy.getElementById('bc').visible()).toBe(true);
    cy.getElementById('g').addClass('hidden');
    flush(cy);
    expect(cy.getElementById('a').visible()).toBe(false);
    expect(cy.getElementById('bc').visible()).toBe(false);
    cy.getElementById('g').removeClass('hidden');
    flush(cy);
    expect(cy.getElementById('a').visible()).toBe(true);
    expect(cy.getElementById('bc').visible()).toBe(true);
  });

  it('opacidade zero no grupo deixa os filhos invisíveis', () => {
    const cy = graph();
    warm(cy);
    expect(cy.getElementById('b').visible()).toBe(true);
    cy.getElementById('g').addClass('ghost');
    flush(cy);
    expect(cy.getElementById('b').visible()).toBe(false);
  });

  it('reaplicar o mesmo valor não invalida o cache das linhas dos filhos', () => {
    const cy = graph();
    warm(cy);
    expect(cacheOf(cy, 'ab')).toBeTruthy();
    // só a cor muda (a largura, vinda dos dados, é reaplicada com o mesmo valor): o grupo e os
    // filhos são recalculados, mas as linhas entre eles continuam com o cache
    cy.getElementById('g').addClass('tinted');
    flush(cy);
    expect(cacheOf(cy, 'ab')).toBeTruthy();
    expect(cacheOf(cy, 'bc')).toBeTruthy();
    expect(cy.getElementById('a').visible()).toBe(true);
  });

  it('largura zero (valor que muda de fato) esconde as linhas do nó', () => {
    const cy = graph();
    warm(cy);
    expect(cy.getElementById('ab').visible()).toBe(true);
    cy.getElementById('a').data('w', 0);
    flush(cy);
    expect(cy.getElementById('ab').visible()).toBe(false);
    expect(cy.getElementById('bc').visible()).toBe(true);
  });
});
