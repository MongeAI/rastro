import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RastroGraph } from '@rastro/core';
import { AnalysisSession, analyzeProject } from '@rastro/analyzer';

/** O grafo sem o que muda a cada execução (horário e duração). */
function stable(graph: RastroGraph) {
  return {
    ...graph,
    generatedAt: '',
    stats: { ...graph.stats, durationMs: 0 },
  };
}

function write(root: string, rel: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
  // garante data diferente mesmo em sistemas de arquivos com pouca precisão
  const future = new Date(Date.now() + 2000 + Math.random() * 1000);
  fs.utimesSync(path.join(root, rel), future, future);
}

describe('AnalysisSession (reanálise do modo --watch)', () => {
  it('depois de cada mudança, o grafo é idêntico ao de uma análise nova', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-session-')));
    write(root, 'package.json', '{"name":"sessao"}');
    write(root, 'src/math.ts', 'export function sum(a: number, b: number) {\n  return a + b;\n}\n');
    write(
      root,
      'src/main.ts',
      "import { sum } from './math';\n\nexport function main() {\n  return sum(1, 2);\n}\n",
    );
    const session = new AnalysisSession(root);
    const same = async () => {
      const incremental = await session.analyze();
      const fresh = await analyzeProject(root);
      expect(stable(incremental)).toEqual(stable(fresh));
      return incremental;
    };

    const first = await same();
    expect(first.edges.some((e) => e.kind === 'calls' && e.target === 'fn:src/math.ts#sum')).toBe(
      true,
    );

    // 1. arquivo alterado: função nova, chamada nova
    write(
      root,
      'src/math.ts',
      'export function sum(a: number, b: number) {\n  return twice(a) + b;\n}\n\nexport function twice(n: number) {\n  return n * 2;\n}\n',
    );
    const changed = await same();
    expect(changed.edges.some((e) => e.target === 'fn:src/math.ts#twice')).toBe(true);

    // 2. arquivo novo que torna resolvível um import antes quebrado
    write(
      root,
      'src/main.ts',
      "import { sum } from './math';\nimport { log } from './log';\n\nexport function main() {\n  log();\n  return sum(1, 2);\n}\n",
    );
    const missing = await same();
    expect(
      missing.nodes.some((n) => n.kind === 'unresolved' && n.meta?.reference === './log'),
    ).toBe(true);
    write(root, 'src/log.ts', 'export function log() {}\n');
    const created = await same();
    expect(created.edges.some((e) => e.kind === 'calls' && e.target === 'fn:src/log.ts#log')).toBe(
      true,
    );

    // 3. arquivo removido
    fs.rmSync(path.join(root, 'src/log.ts'));
    const removed = await same();
    expect(removed.nodes.some((n) => n.id === 'file:src/log.ts')).toBe(false);

    // 4. erro de sintaxe e depois corrigido
    write(root, 'src/math.ts', 'export function sum(a: number, b: number {\n');
    await same();
    write(root, 'src/math.ts', 'export function sum(a: number, b: number) {\n  return a + b;\n}\n');
    await same();

    // 5. tsconfig novo (alias): o compilador é recriado com as opções novas
    write(
      root,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    );
    write(
      root,
      'src/main.ts',
      "import { sum } from '@/math';\n\nexport function main() {\n  return sum(1, 2);\n}\n",
    );
    const aliased = await same();
    expect(aliased.edges.some((e) => e.kind === 'imports' && e.target === 'file:src/math.ts')).toBe(
      true,
    );
  });

  it('tsconfig de subpacote (lido sob demanda) alterado recria o compilador', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-session-')));
    const config = (target: string) =>
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@x/*': [`${target}/*`] } } });
    write(root, 'package.json', '{"name":"sub"}');
    write(root, 'packages/app/tsconfig.json', config('a'));
    write(root, 'packages/app/a/f.ts', 'export function fa() {}\n');
    write(root, 'packages/app/b/f.ts', 'export function fb() {}\n');
    write(
      root,
      'packages/app/main.ts',
      "import { fa as f } from '@x/f';\nexport function main() {\n  f();\n}\n",
    );
    const session = new AnalysisSession(root);
    const first = await session.analyze();
    expect(
      first.edges.some(
        (e) =>
          e.kind === 'calls' &&
          e.source === 'fn:packages/app/main.ts#main' &&
          e.target === 'fn:packages/app/a/f.ts#fa',
      ),
    ).toBe(true);

    // só o tsconfig do subpacote muda: `@x/f` passa a ser b/f.ts, que não exporta `fa`
    write(root, 'packages/app/tsconfig.json', config('b'));
    const incremental = await session.analyze();
    expect(stable(incremental)).toEqual(stable(await analyzeProject(root)));
    expect(
      incremental.edges.some((e) => e.kind === 'calls' && e.target === 'fn:packages/app/a/f.ts#fa'),
    ).toBe(false);

    // tsconfig novo numa pasta que antes não tinha nenhum
    write(root, 'packages/app/a/tsconfig.json', config('x'));
    const created = await session.analyze();
    expect(stable(created)).toEqual(stable(await analyzeProject(root)));
  });

  it('.d.ts escrito à mão (não descoberto) alterado é relido', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-session-')));
    write(root, 'package.json', '{"name":"dts"}');
    write(root, 'src/types.d.ts', 'export declare function a(): void;\n');
    write(root, 'src/types.js', 'export function a() {}\nexport function b() {}\n');
    write(
      root,
      'src/main.ts',
      "import * as t from './types';\nexport function m() {\n  t.a();\n}\n",
    );
    const session = new AnalysisSession(root);
    const same = async () => {
      const incremental = await session.analyze();
      expect(stable(incremental)).toEqual(stable(await analyzeProject(root)));
      return incremental;
    };
    await same();

    // o .d.ts passa a declarar `b`, e main.ts passa a chamá-la
    write(
      root,
      'src/types.d.ts',
      'export declare function a(): void;\nexport declare function b(): void;\n',
    );
    write(
      root,
      'src/main.ts',
      "import * as t from './types';\nexport function m() {\n  t.b();\n}\n",
    );
    const changed = await same();
    expect(
      changed.edges.some(
        (e) =>
          e.kind === 'calls' && e.source === 'fn:src/main.ts#m' && e.target === 'fn:src/types.js#b',
      ),
    ).toBe(true);

    // só o .d.ts muda (main.ts igual): `b` some da declaração
    write(root, 'src/types.d.ts', 'export declare function a(): void;\n');
    const removed = await same();
    expect(removed.edges.some((e) => e.kind === 'calls' && e.target === 'fn:src/types.js#b')).toBe(
      false,
    );

    // .d.ts apagado: o import passa a resolver para o .js
    fs.rmSync(path.join(root, 'src/types.d.ts'));
    await same();
  });

  it('arquivo não descoberto que passa a ganhar a resolução de um import (x.ts antes de x/index.ts)', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-session-')));
    write(root, 'package.json', '{"name":"sombra"}');
    write(root, '.gitignore', 'x.ts\n');
    write(root, 'x/index.ts', 'export function fromIndex() {}\n');
    write(root, 'main.ts', "import { fromIndex } from './x';\nfromIndex();\n");
    const session = new AnalysisSession(root);
    const first = await session.analyze();
    expect(
      first.edges.some(
        (e) =>
          e.kind === 'calls' &&
          e.target === 'fn:x/index.ts#fromIndex' &&
          e.resolution === 'resolved',
      ),
    ).toBe(true);

    // x.ts (ignorado pelo .gitignore, então fora da análise) passa a ser o destino de './x':
    // main.ts não mudou, mas a resolução guardada pelo compilador ficou velha
    write(root, 'x.ts', 'export function fromIndex() {}\n');
    const incremental = await session.analyze();
    expect(stable(incremental)).toEqual(stable(await analyzeProject(root)));
    expect(
      incremental.edges.some((e) => e.kind === 'calls' && e.target === 'fn:x/index.ts#fromIndex'),
    ).toBe(false);

    // e de volta: x.ts apagado, './x' volta a ser x/index.ts
    fs.rmSync(path.join(root, 'x.ts'));
    const back = await session.analyze();
    expect(stable(back)).toEqual(stable(await analyzeProject(root)));
    expect(
      back.edges.some((e) => e.kind === 'calls' && e.target === 'fn:x/index.ts#fromIndex'),
    ).toBe(true);
  });
});
