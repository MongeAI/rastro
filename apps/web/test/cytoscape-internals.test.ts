/**
 * O GraphCanvas troca duas funções internas do Cytoscape por atalhos com o mesmo resultado
 * (patchStyleCache). Este teste falha se uma versão nova do Cytoscape mudar esse código: aí é
 * preciso revisar os atalhos antes de atualizar.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
// o pacote não exporta package.json nem dist/: sobe da entrada principal até a raiz dele
let root = path.dirname(require.resolve('cytoscape'));
while (!fs.existsSync(path.join(root, 'package.json'))) root = path.dirname(root);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  version: string;
};
const source = fs.readFileSync(path.join(root, 'dist', 'cytoscape.esm.mjs'), 'utf8');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('internos do Cytoscape usados pelo patchStyleCache', () => {
  it('versão fixa', () => {
    expect(pkg.version).toBe('3.34.4');
  });

  it('checkTriggers continua invalidando o cache e conferindo os quatro gatilhos', () => {
    expect(squash(source)).toContain(
      squash(`styfn$8.checkTriggers = function (ele, name, fromValue, toValue) {
  ele.dirtyStyleCache();
  this.checkZOrderTrigger(ele, name, fromValue, toValue);
  this.checkBoundsTrigger(ele, name, fromValue, toValue);
  this.checkConnectedEdgesBoundsTrigger(ele, name, fromValue, toValue);
  this.checkParallelEdgesBoundsTrigger(ele, name, fromValue, toValue);
};`),
    );
  });

  it('dirtyStyleCache continua limpando elemento, descendentes, pais e linhas', () => {
    expect(squash(source)).toContain(
      squash(`eles = this.spawnSelf().merge(this.descendants()).merge(this.parents());
      eles.merge(eles.connectedEdges());
      eles.forEach(dirty);`),
    );
  });

  it('os estados em cache dependem só das propriedades tratadas como derivadas', () => {
    // visible / takesUpSpace / interactive / isBundledBezier
    for (const prop of ['display', 'visibility', 'opacity', 'events', 'curve-style']) {
      expect(source).toContain(`pstyle('${prop}')`);
    }
    const cached = [...source.matchAll(/cache(?:Prototype)?StyleFunction\('(\w+)'/g)].map(
      (m) => m[1],
    );
    expect(cached.sort()).toEqual(
      [
        'eleInteractive',
        'eleTakesUpSpace',
        'eleVisible',
        'interactive',
        'isBundledBezier',
        'parentInteractive',
        'takesUpSpace',
        'visible',
      ].sort(),
    );
  });
});
