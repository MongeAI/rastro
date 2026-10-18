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
});
