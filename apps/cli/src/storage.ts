import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateGraph, type RastroGraph } from '@rastro/core';
import { getLang, t } from './i18n.js';

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

/**
 * Confere o destino do JSON antes da análise (que pode demorar): uma pasta ou um arquivo
 * especial (ex.: /dev/null) nunca daria certo. Lança o mesmo erro que `saveGraph` lançaria.
 */
export function checkGraphTarget(file: string): void {
  const target = path.resolve(file);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return; // ainda não existe: será criado
  }
  if (stat.isDirectory()) throw new Error(t().storage.saveFailed(target, t().storage.isDir));
  if (!stat.isFile()) throw new Error(t().storage.saveFailed(target, t().storage.notRegular));
}

/** Grava de forma atômica (arquivo temporário + rename). */
export function saveGraph(graph: RastroGraph, file: string): string {
  const target = path.resolve(file);
  checkGraphTarget(target);
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
          ? t().storage.noPermission(path.dirname(target))
          : (err as Error).message;
    throw new Error(t().storage.saveFailed(target, why), { cause: err });
  }
  return target;
}

/** O caminho como o usuário digitaria no terminal (entre aspas simples se precisar). */
function shellArg(p: string): string {
  return /^[\w./~:@%+=,-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Lê o JSON de um grafo salvo, com mensagens claras quando o arquivo não existe, é uma pasta
 * (provavelmente o usuário queria analisá-la) ou não é JSON. Não valida o conteúdo.
 */
export function readGraphJson(file: string): unknown {
  const target = path.resolve(file);
  if (!fs.existsSync(target)) throw new Error(t().storage.fileNotFound(target));
  if (fs.statSync(target).isDirectory())
    throw new Error(t().storage.isFolder(target, shellArg(file)));
  let text: string;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    throw new Error(t().storage.cannotRead(target, (err as Error).message), { cause: err });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(t().storage.invalidJson((err as Error).message), { cause: err });
  }
}

/**
 * Lê e valida um grafo salvo. Como `parseGraph` de @rastro/core, mas com as mensagens (e os
 * problemas da validação) no idioma da CLI.
 */
export function loadGraph(file: string): RastroGraph {
  const data = readGraphJson(file);
  const result = validateGraph(data, { lang: getLang() });
  if (!result.valid) throw new Error(t().storage.invalidGraph(result.errors));
  return data as RastroGraph;
}
