import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_EXCLUDED_DIRS,
  discoverFiles,
  languageOf,
  type DiscoverOptions,
} from '@rastro/analyzer';

const IGNORED = new Set<string>(DEFAULT_EXCLUDED_DIRS);
/** Arquivos de configuração que mudam a resolução de módulos. */
const CONFIG_FILES = new Set([
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  '.gitignore',
  'rastro.rules.json',
]);

/** O arquivo alterado importa para a análise? (código JS/TS ou configuração, fora de pastas ignoradas) */
export function isRelevantChange(relative: string): boolean {
  const parts = relative.split(/[\\/]/);
  if (parts.some((p) => IGNORED.has(p))) return false;
  const name = parts[parts.length - 1] ?? '';
  if (/\.d\.[mc]?ts$/.test(name)) return false;
  return !!languageOf(name) || CONFIG_FILES.has(name) || /^tsconfig\..*\.json$/.test(name);
}

export interface WatchOptions extends DiscoverOptions {
  /** Espera depois do último evento antes de avisar (junta rajadas de salvamentos). */
  delayMs?: number;
  /** Intervalo da varredura quando o sistema não deixa observar as pastas. */
  pollMs?: number;
  /** Começa direto na varredura (testes). */
  polling?: boolean;
  /** Chamado uma vez quando a observação falha e o Rastro passa a varrer o projeto. */
  onFallback?: (error: NodeJS.ErrnoException) => void;
}

export interface ProjectWatcher {
  /** `live`: eventos do sistema por pasta; `polling`: varredura periódica. */
  readonly mode: 'live' | 'polling';
  /** Quantas pastas estão sendo observadas (0 na varredura). */
  readonly watched: number;
  /** Relê as pastas do projeto e passa a observar as novas (chamar depois de cada reanálise). */
  refresh(): void;
  /**
   * Na varredura, compara os arquivos agora (sem esperar o intervalo); ao vivo, não faz nada
   * (os eventos chegam sozinhos). Mudanças encontradas seguem o caminho normal (`onChange`).
   */
  flush(): void;
  close(): void;
}

/** Varredura padrão: a cada 1,5 s. */
export const POLL_MS = 1500;

/**
 * Observa o projeto e chama `onChange` com os arquivos alterados, juntando rajadas de
 * salvamentos (debounce).
 *
 * Observa só as pastas que o analisador leria (as mesmas exclusões, .gitignore e --exclude),
 * com um `fs.watch` não recursivo por pasta. O modo recursivo do Node no Linux percorre a
 * árvore inteira (node_modules e .git inclusive) e cria um watch do inotify por pasta: em
 * projetos grandes ele estoura o limite do sistema sem avisar. Se observar falhar (ENOSPC,
 * EMFILE ou qualquer erro), a observação passa a ser por varredura: a cada `pollMs`, compara
 * data e tamanho dos arquivos relevantes.
 */
export function watchProject(
  root: string,
  onChange: (files: string[]) => void,
  options: WatchOptions = {},
): ProjectWatcher {
  const delayMs = options.delayMs ?? 300;
  const pollMs = options.pollMs ?? POLL_MS;
  const discover: DiscoverOptions = {
    ...(options.exclude ? { exclude: options.exclude } : {}),
    ...(options.respectGitignore !== undefined
      ? { respectGitignore: options.respectGitignore }
      : {}),
    ...(options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
  };
  /** Pastas do projeto agora (vazio se a raiz sumiu). */
  const directories = (): string[] => {
    try {
      return discoverFiles(root, discover).directories;
    } catch {
      return [];
    }
  };
  const absolute = (dir: string) => (dir === '.' ? root : path.join(root, ...dir.split('/')));
  const join = (dir: string, name: string) => (dir === '.' ? name : `${dir}/${name}`);

  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const queue = (relative: string) => {
    pending.add(relative);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...pending].sort();
      pending.clear();
      onChange(files);
    }, delayMs);
  };

  let mode: 'live' | 'polling' = 'live';
  const watchers = new Map<string, fs.FSWatcher>();
  /** Identidade (dispositivo e inode) da pasta observada: muda se ela for apagada e recriada. */
  const inodes = new Map<string, string>();
  let poller: ReturnType<typeof setInterval> | undefined;

  const closeWatchers = () => {
    for (const w of watchers.values()) w.close();
    watchers.clear();
    inodes.clear();
  };

  /** Arquivos relevantes de cada pasta → `mtime:tamanho`, para a varredura. */
  const snapshot = (): Map<string, string> => {
    const stamps = new Map<string, string>();
    for (const dir of directories()) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absolute(dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const relative = join(dir, entry.name);
        if (!entry.isFile() || !isRelevantChange(relative)) continue;
        try {
          const stat = fs.statSync(path.join(absolute(dir), entry.name));
          stamps.set(relative, `${stat.mtimeMs}:${stat.size}`);
        } catch {
          // sumiu entre a listagem e o stat: a próxima varredura percebe
        }
      }
    }
    return stamps;
  };

  let previous: Map<string, string> | undefined;
  const scan = () => {
    if (!previous) return;
    const current = snapshot();
    for (const [file, stamp] of current) if (previous.get(file) !== stamp) queue(file);
    for (const file of previous.keys()) if (!current.has(file)) queue(file);
    previous = current;
  };

  const startPolling = () => {
    mode = 'polling';
    closeWatchers();
    previous = snapshot();
    poller = setInterval(scan, pollMs);
  };

  const fallBack = (error: NodeJS.ErrnoException) => {
    if (closed || mode === 'polling') return;
    startPolling();
    options.onFallback?.(error);
  };

  /** Evento numa pasta observada. */
  const onEvent = (dir: string, filename: string | Buffer | null) => {
    if (!filename) return;
    const relative = join(dir, filename.toString().split(path.sep).join('/'));
    if (isRelevantChange(relative)) return queue(relative);
    if (relative.split('/').some((p) => IGNORED.has(p))) return;
    // pasta criada, removida ou renomeada: observa as novas e reanalisa (arquivos podem ter
    // sido escritos nela antes de o watch existir)
    let isDir = false;
    try {
      isDir = fs.statSync(path.join(absolute(dir), filename.toString())).isDirectory();
    } catch {
      // não existe mais
    }
    const wasWatched = watchers.has(relative);
    if (!isDir && !wasWatched) return;
    // pasta observada apagada (e talvez recriada no mesmo lugar): o watch antigo ficou preso à
    // pasta removida e não vê mais nada; ela e as de dentro voltam a ser observadas do zero
    if (wasWatched) forget(relative);
    refresh();
    // pastas excluídas (--exclude, .gitignore) não disparam reanálise
    if (wasWatched || watchers.has(relative)) queue(relative);
  };

  /** Para de observar a pasta e as de dentro dela. */
  const forget = (dir: string) => {
    for (const [watched, watcher] of watchers)
      if (watched === dir || dir === '.' || watched.startsWith(`${dir}/`)) {
        watcher.close();
        watchers.delete(watched);
        inodes.delete(watched);
      }
  };
  const identity = (dir: string) => {
    try {
      const stat = fs.statSync(absolute(dir));
      return `${stat.dev}:${stat.ino}`;
    } catch {
      return undefined;
    }
  };

  const watchDir = (dir: string) => {
    const watcher = fs.watch(absolute(dir), { persistent: true }, (_event, filename) =>
      onEvent(dir, filename),
    );
    const id = identity(dir);
    if (id) inodes.set(dir, id);
    watcher.on('error', (err: NodeJS.ErrnoException) => {
      // a própria pasta foi apagada: só deixa de observá-la
      if (!fs.existsSync(absolute(dir))) {
        watcher.close();
        if (watchers.get(dir) === watcher) {
          watchers.delete(dir);
          inodes.delete(dir);
        }
        return;
      }
      fallBack(err);
    });
    watchers.set(dir, watcher);
  };

  const refresh = () => {
    if (closed || mode === 'polling') return;
    // a raiz não tem pasta mãe observada para avisar que foi recriada: confere a identidade
    if (watchers.has('.') && identity('.') !== inodes.get('.')) forget('.');
    const wanted = new Set(directories());
    for (const [dir, watcher] of watchers)
      if (!wanted.has(dir)) {
        watcher.close();
        watchers.delete(dir);
        inodes.delete(dir);
      }
    for (const dir of wanted) {
      if (watchers.has(dir)) continue;
      try {
        watchDir(dir);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        // pasta apagada entre a listagem e o watch: a próxima atualização resolve
        if (e.code === 'ENOENT') continue;
        return fallBack(e);
      }
    }
  };

  if (!options.polling) refresh();
  // varredura pedida ou nada observado: nunca finge estar ao vivo
  if (mode === 'live' && watchers.size === 0) startPolling();

  return {
    get mode() {
      return mode;
    },
    get watched() {
      return watchers.size;
    },
    refresh,
    flush() {
      if (!closed && mode === 'polling') scan();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(poller);
      closeWatchers();
    },
  };
}
