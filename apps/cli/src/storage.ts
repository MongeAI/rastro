import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGraph, type TeiaGraph } from '@teia/core';

/**
 * Armazenamento local dos resultados. Por padrão o Teia grava no diretório de cache do
 * usuário — nunca dentro do repositório analisado.
 */
export function cacheDir(): string {
  if (process.env.TEIA_CACHE_DIR) return path.resolve(process.env.TEIA_CACHE_DIR);
  if (process.platform === 'win32') {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
      'teia',
      'Cache',
    );
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'teia');
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'teia');
}

/** Caminho padrão do JSON de um projeto: `<cache>/<nome>-<hash da raiz>.graph.json`. */
export function defaultGraphPath(graph: TeiaGraph): string {
  const hash = crypto.createHash('sha256').update(graph.project.root).digest('hex').slice(0, 10);
  const slug =
    graph.project.name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'projeto';
  return path.join(cacheDir(), `${slug}-${hash}.graph.json`);
}

/** Grava de forma atômica (arquivo temporário + rename). */
export function saveGraph(graph: TeiaGraph, file: string): string {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(graph, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return target;
}

export function loadGraph(file: string): TeiaGraph {
  const target = path.resolve(file);
  if (!fs.existsSync(target)) throw new Error(`Arquivo não encontrado: ${target}`);
  return parseGraph(fs.readFileSync(target, 'utf8'));
}
