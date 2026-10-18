import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateGraph, type RastroGraph } from '@rastro/core';
import { t } from './i18n.js';

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
        ? t().storage.isDir
        : code === 'EACCES' || code === 'EPERM'
          ? t().storage.noPermission
          : (err as Error).message;
    throw new Error(t().storage.saveFailed(target, why), { cause: err });
  }
  return target;
}

/**
 * Lê e valida um grafo salvo. Como `parseGraph` de @rastro/core, mas com as mensagens no
 * idioma da CLI (os itens da validação continuam vindo do validador, em português).
 */
export function loadGraph(file: string): RastroGraph {
  const target = path.resolve(file);
  if (!fs.existsSync(target)) throw new Error(t().storage.fileNotFound(target));
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (err) {
    throw new Error(t().storage.invalidJson((err as Error).message), { cause: err });
  }
  const result = validateGraph(data);
  if (!result.valid) throw new Error(t().storage.invalidGraph(result.errors));
  return data as RastroGraph;
}
