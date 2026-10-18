import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_EXCLUDED_DIRS, languageOf } from '@rastro/analyzer';

const IGNORED = new Set<string>(DEFAULT_EXCLUDED_DIRS);
/** Arquivos de configuração que mudam a resolução de módulos. */
const CONFIG_FILES = new Set(['package.json', 'tsconfig.json', 'jsconfig.json', '.gitignore']);

/** O arquivo alterado importa para a análise? (código JS/TS ou configuração, fora de pastas ignoradas) */
export function isRelevantChange(relative: string): boolean {
  const parts = relative.split(/[\\/]/);
  if (parts.some((p) => IGNORED.has(p))) return false;
  const name = parts[parts.length - 1] ?? '';
  if (/\.d\.[mc]?ts$/.test(name)) return false;
  return !!languageOf(name) || CONFIG_FILES.has(name) || /^tsconfig\..*\.json$/.test(name);
}

/**
 * Observa o projeto e chama `onChange` com os arquivos alterados, juntando rajadas de
 * salvamentos (debounce). Devolve uma função para parar de observar.
 */
export function watchProject(
  root: string,
  onChange: (files: string[]) => void,
  delayMs = 300,
): () => void {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const relative = filename.toString().split(path.sep).join('/');
    if (!isRelevantChange(relative)) return;
    pending.add(relative);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...pending].sort();
      pending.clear();
      onChange(files);
    }, delayMs);
  });
  watcher.on('error', () => {});
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
