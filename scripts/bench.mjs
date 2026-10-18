#!/usr/bin/env node
/**
 * Benchmarks do Rastro: gera projetos sintéticos (determinísticos) de vários tamanhos, mede o
 * tempo e a memória da análise e das consultas do grafo, e compara com limites.
 *
 *   node scripts/bench.mjs                  # 100, 1000 e 5000 arquivos
 *   node scripts/bench.mjs 100 1000         # tamanhos escolhidos
 *   node scripts/bench.mjs --check          # falha se passar dos limites (scripts/bench-limits.json)
 *   node scripts/bench.mjs --json out.json  # grava os resultados
 *
 * Cada tamanho roda num processo separado, para a memória medida ser só daquele tamanho.
 * Precisa de "npm run build" antes (usa os pacotes compilados em dist/).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const self = fileURLToPath(import.meta.url);

// ---------- gerador ----------

/** Gerador pseudoaleatório com semente (mulberry32): o mesmo projeto em toda máquina. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Projeto parecido com um real: pastas de domínio, cada arquivo com 3 funções e uma classe
 * (que às vezes estende outra), imports para arquivos "anteriores" (sem explodir em ciclos),
 * chamadas entre funções importadas e um arquivo de rotas Express a cada 50 arquivos.
 */
export function generateProject(root, files) {
  const rnd = random(files);
  const pick = (n) => Math.floor(rnd() * n);
  const domains = Math.max(4, Math.round(Math.sqrt(files) / 2));
  const fileAt = (i) => `src/d${i % domains}/m${i}.ts`;
  // escreve em `root` sem apagá-la antes: quem chama passa uma pasta nova (fs.mkdtempSync)
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: `bench-${files}`, private: true, dependencies: { express: '*' } }),
  );
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, module: 'nodenext', target: 'es2022' } }),
  );
  for (let i = 0; i < files; i++) {
    const rel = fileAt(i);
    const dir = path.dirname(rel);
    const deps = new Set();
    // ~4 imports, sempre de arquivos com índice menor (alguns ciclos raros de propósito)
    for (let k = 0; k < 4 && i > 0; k++) deps.add(pick(i));
    if (i > 10 && rnd() < 0.01) deps.add(i + 1 < files ? i + 1 : 0);
    const lines = [];
    for (const d of deps) {
      let spec = path.posix.relative(dir, fileAt(d)).replace(/\.ts$/, '.js');
      if (!spec.startsWith('.')) spec = `./${spec}`;
      lines.push(`import { f${d}a, f${d}b, C${d} } from '${spec}';`);
    }
    if (i % 7 === 0) lines.push(`import { readFileSync } from 'node:fs';`);
    lines.push('');
    const calls = [...deps].map((d) => `  total += f${d}a(n) + f${d}b(n);`).join('\n');
    lines.push(
      `export function f${i}a(n: number): number {`,
      '  let total = n;',
      calls,
      `  return total + helper${i}(n);`,
      '}',
      '',
      `export function f${i}b(n: number): number {`,
      `  return f${i}a(n - 1) * 2;`,
      '}',
      '',
      `function helper${i}(n: number): number {`,
      '  return n % 3;',
      '}',
      '',
    );
    const base = [...deps][0];
    const ext = base !== undefined && rnd() < 0.3 ? ` extends C${base}` : '';
    lines.push(
      `export class C${i}${ext} {`,
      `  run(n: number): number {`,
      `    return f${i}b(n) + this.size();`,
      '  }',
      '  size(): number {',
      `    return ${i};`,
      '  }',
      '}',
      '',
    );
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, rel), lines.join('\n'));
  }
  // rotas
  const routes = ["import express from 'express';"];
  const used = [];
  for (let i = 0; i < files; i += 50) {
    routes.push(`import { f${i}a } from './${fileAt(i).slice(4).replace(/\.ts$/, '.js')}';`);
    used.push(i);
  }
  routes.push('', 'const app = express();');
  for (const i of used)
    routes.push(`app.get('/r${i}', (req, res) => res.json(f${i}a(Number(req.query.n))));`);
  routes.push('app.listen(3000);', '');
  fs.writeFileSync(path.join(root, 'src/server.ts'), routes.join('\n'));
}

// ---------- medição (processo filho) ----------

async function measure(size) {
  const dist = (p) => pathToFileURL(path.join(repo, p)).href;
  const { analyzeProject } = await import(dist('packages/analyzer/dist/index.js'));
  const { GraphIndex, computeView, computeInsights, findPaths, toMermaid } = await import(
    dist('packages/graph/dist/index.js')
  );
  // pasta nova e exclusiva a cada execução (nada de caminho fixo e previsível no /tmp)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rastro-bench-${size}-`));
  generateProject(root, size);

  const timings = {};
  const time = async (name, fn) => {
    const start = performance.now();
    const result = await fn();
    timings[name] = Math.round(performance.now() - start);
    return result;
  };
  const graph = await time('analyze', () => analyzeProject(root, { maxFiles: size + 100 }));
  const index = await time('index', () => new GraphIndex(graph));
  await time('viewFiles', () =>
    computeView(index, {
      nodeKinds: new Set(['module', 'file', 'function', 'class', 'method', 'route', 'unresolved']),
      edgeKinds: new Set(['imports', 'calls', 'extends']),
      expandedFiles: new Set(),
    }),
  );
  await time('insights', () => computeInsights(index));
  const first = graph.nodes.find((n) => n.id.endsWith(`m${size - 1}.ts#f${size - 1}a`));
  const last = graph.nodes.find((n) => n.id.endsWith('m0.ts#f0a'));
  const found = await time('paths', () =>
    first && last ? findPaths(index, first.id, last.id) : { paths: [] },
  );
  await time('mermaid', () => {
    try {
      return toMermaid(graph, { level: 'modules' });
    } catch {
      return '';
    }
  });
  const result = {
    files: size,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    resolvedCalls: graph.edges.filter((e) => e.kind === 'calls' && e.resolution === 'resolved')
      .length,
    pathFound: found.paths.length > 0,
    ms: timings,
    // pico de memória do processo inteiro (KB → MB)
    peakMb: Math.round(process.resourceUsage().maxRSS / 1024),
    jsonMb: +(Buffer.byteLength(JSON.stringify(graph)) / 1024 / 1024).toFixed(1),
  };
  fs.rmSync(root, { recursive: true, force: true });
  process.stdout.write(JSON.stringify(result));
}

// ---------- orquestração ----------

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--child') return measure(Number(args[1]));
  const check = args.includes('--check');
  const jsonAt = args.indexOf('--json');
  const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : undefined;
  const sizes = args.filter((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--json').map(Number);
  const list = sizes.length ? sizes : [100, 1000, 5000];
  const limits = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/bench-limits.json'), 'utf8'));

  const results = [];
  const failures = [];
  for (const size of list) {
    process.stderr.write(`→ ${size} arquivos...\n`);
    const out = execFileSync(
      process.execPath,
      ['--max-old-space-size=8192', self, '--child', String(size)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
    );
    const r = JSON.parse(out);
    results.push(r);
    const limit = limits[String(size)];
    if (limit) {
      if (r.ms.analyze > limit.analyzeMs)
        failures.push(`${size}: análise levou ${r.ms.analyze} ms (limite ${limit.analyzeMs})`);
      if (r.peakMb > limit.peakMb)
        failures.push(`${size}: pico de memória ${r.peakMb} MB (limite ${limit.peakMb})`);
      const queries = r.ms.index + r.ms.viewFiles + r.ms.insights + r.ms.paths;
      if (queries > limit.queriesMs)
        failures.push(`${size}: consultas levaram ${queries} ms (limite ${limit.queriesMs})`);
    }
    if (!r.pathFound) failures.push(`${size}: nenhum caminho encontrado entre as pontas`);
  }

  const pad = (s, n) => String(s).padStart(n);
  console.log(
    '\narquivos     nós  relações   análise   índice   visão  insights  caminhos   memória   JSON',
  );
  for (const r of results)
    console.log(
      `${pad(r.files, 8)} ${pad(r.nodes, 7)} ${pad(r.edges, 9)} ${pad(r.ms.analyze, 7)}ms ${pad(r.ms.index, 6)}ms ${pad(r.ms.viewFiles, 5)}ms ${pad(r.ms.insights, 7)}ms ${pad(r.ms.paths, 7)}ms ${pad(r.peakMb, 6)} MB ${pad(r.jsonMb, 4)} MB`,
    );
  if (jsonOut)
    fs.writeFileSync(
      jsonOut,
      `${JSON.stringify({ node: process.version, cpus: os.cpus().length, results }, null, 2)}\n`,
    );
  if (check) {
    if (failures.length) {
      console.error(`\n✗ limites ultrapassados:\n  ${failures.join('\n  ')}`);
      process.exit(1);
    }
    console.log('\n✓ dentro dos limites');
  }
}

// só roda quando executado diretamente (permite importar generateProject)
if (process.argv[1] && fs.realpathSync(process.argv[1]) === self) await main();
