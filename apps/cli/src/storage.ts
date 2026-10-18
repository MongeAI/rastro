import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGraph, type RastroGraph } from '@rastro/core';

/**
 * Armazenamento local dos resultados. Por padrão o Rastro grava no diretório de cache do
 * usuário — nunca dentro do repositório analisado.
 */
export function cacheDir(): string {
  if (process.env.RASTRO_CACHE_DIR) return path.resolve(process.env.RASTRO_CACHE_DIR);
  if (process.platform === 'win32') {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
      'rastro',
      'Cache',
    );
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'rastro');
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'rastro');
}

/** Caminho padrão do JSON de um projeto: `<cache>/<nome>-<hash da raiz>.graph.json`. */
export function defaultGraphPath(graph: RastroGraph): string {
  const hash = crypto.createHash('sha256').update(graph.project.root).digest('hex').slice(0, 10);
  const slug =
    graph.project.name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'projeto';
  return path.join(cacheDir(), `${slug}-${hash}.graph.json`);
}

/** Grava de forma atômica (arquivo temporário + rename). */
export function saveGraph(graph: RastroGraph, file: string): string {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // nome imprevisível e criação exclusiva ("wx"): não segue um link plantado com o mesmo nome
  const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(graph, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    const code = (err as NodeJS.ErrnoException).code;
    const why =
      code === 'EISDIR'
        ? 'o destino é uma pasta; informe um nome de arquivo, ex.: -o grafo.json'
        : code === 'EACCES' || code === 'EPERM'
          ? 'sem permissão para gravar nesse local'
          : (err as Error).message;
    throw new Error(`Não foi possível salvar o grafo em ${target}: ${why}`, { cause: err });
  }
  return target;
}

export function loadGraph(file: string): RastroGraph {
  const target = path.resolve(file);
  if (!fs.existsSync(target)) throw new Error(`Arquivo não encontrado: ${target}`);
  return parseGraph(fs.readFileSync(target, 'utf8'));
}
