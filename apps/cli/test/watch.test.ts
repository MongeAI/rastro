import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverFiles } from '@rastro/analyzer';
import { isRelevantChange, watchProject, type ProjectWatcher } from '../src/watch.js';

/** Projeto com código, dependências instaladas, uma pasta no .gitignore e outra excluída. */
function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-watch-')));
  const files: Record<string, string> = {
    'src/a.ts': 'export const a = 1;\n',
    'src/lib/b.ts': 'export const b = 1;\n',
    'node_modules/pkg/index.js': 'module.exports = 1;\n',
    'node_modules/pkg/deep/x.js': '\n',
    'gerado/c.ts': 'export const c = 1;\n',
    'vendor/d.ts': 'export const d = 1;\n',
    '.gitignore': 'gerado/\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

/** Espera uma condição (eventos do sistema chegam com algum atraso). */
async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('tempo esgotado');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

let watcher: ProjectWatcher | undefined;
afterEach(() => {
  watcher?.close();
  watcher = undefined;
  vi.restoreAllMocks();
});

describe('pastas observadas', () => {
  it('discoverFiles lista as pastas percorridas, sem as excluídas', () => {
    const root = project();
    expect(discoverFiles(root, { exclude: ['vendor/'] }).directories).toEqual([
      '.',
      'src',
      'src/lib',
    ]);
    expect(discoverFiles(root, { respectGitignore: false }).directories).toEqual([
      '.',
      'gerado',
      'src',
      'src/lib',
      'vendor',
    ]);
  });

  it('isRelevantChange: código e configuração, nunca node_modules', () => {
    expect(isRelevantChange('src/a.ts')).toBe(true);
    expect(isRelevantChange('tsconfig.base.json')).toBe(true);
    expect(isRelevantChange('node_modules/pkg/index.js')).toBe(false);
    // o compilador lê os .d.ts do projeto (tipos de interfaces chamadas, por exemplo)
    expect(isRelevantChange('src/types.d.ts')).toBe(true);
    expect(isRelevantChange('dist/types.d.ts')).toBe(false);
    expect(isRelevantChange('README.md')).toBe(false);
  });
});

describe('watchProject (ao vivo)', () => {
  it('observa uma pasta por vez, só as que o analisador lê, e avisa mudanças', async () => {
    const root = project();
    const seen: string[][] = [];
    watcher = watchProject(root, (files) => seen.push(files), {
      exclude: ['vendor/'],
      delayMs: 50,
    });
    expect(watcher.mode).toBe('live');
    expect(watcher.watched).toBe(3); // ., src, src/lib

    fs.writeFileSync(path.join(root, 'src/lib/b.ts'), 'export const b = 2;\n');
    await waitFor(() => seen.length > 0);
    expect(seen.flat()).toEqual(['src/lib/b.ts']);
  });

  it('mudanças em node_modules, pastas ignoradas e excluídas não disparam nada', async () => {
    const root = project();
    const seen: string[][] = [];
    watcher = watchProject(root, (files) => seen.push(files), {
      exclude: ['vendor/'],
      delayMs: 50,
    });
    fs.writeFileSync(path.join(root, 'node_modules/pkg/index.js'), 'module.exports = 2;\n');
    fs.writeFileSync(path.join(root, 'node_modules/pkg/novo.ts'), 'export {};\n');
    fs.writeFileSync(path.join(root, 'gerado/c.ts'), 'export const c = 2;\n');
    fs.writeFileSync(path.join(root, 'vendor/d.ts'), 'export const d = 2;\n');
    fs.mkdirSync(path.join(root, 'node_modules/outro'));
    await pause(400);
    expect(seen).toEqual([]);
  });

  it('passa a observar pastas criadas depois do início', async () => {
    const root = project();
    const seen: string[][] = [];
    watcher = watchProject(root, (files) => seen.push(files), { delayMs: 50 });
    const before = watcher.watched;

    fs.mkdirSync(path.join(root, 'src/novo/fundo'), { recursive: true });
    await waitFor(() => seen.length > 0);
    // a criação da pasta já pede uma reanálise (arquivos podem ter chegado antes do watch)
    expect(seen.flat()).toContain('src/novo');
    await waitFor(() => watcher!.watched === before + 2);

    seen.length = 0;
    fs.writeFileSync(path.join(root, 'src/novo/fundo/e.ts'), 'export const e = 1;\n');
    await waitFor(() => seen.flat().includes('src/novo/fundo/e.ts'));

    // pasta removida sai do conjunto observado
    fs.rmSync(path.join(root, 'src/novo'), { recursive: true });
    await waitFor(() => watcher!.watched === before);
  });

  it('pasta apagada e recriada no mesmo lugar: as edições seguintes dentro dela são vistas', async () => {
    const root = project();
    const seen: string[][] = [];
    watcher = watchProject(root, (files) => seen.push(files), { delayMs: 20 });
    // rm -rf src && mkdir src && escreve src/b.ts
    fs.rmSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/b.ts'), 'export const b = 1;\n');
    await waitFor(() => seen.length > 0);
    await pause(100);
    // o .refresh() da reanálise (aqui, feito à mão) não pode manter o watch da pasta antiga
    watcher.refresh();
    seen.length = 0;
    fs.writeFileSync(path.join(root, 'src/b.ts'), 'export const b = 2;\n');
    await waitFor(() => seen.flat().includes('src/b.ts'));
    seen.length = 0;
    fs.mkdirSync(path.join(root, 'src/lib'));
    await waitFor(() => seen.length > 0);
    await pause(50);
    seen.length = 0;
    fs.writeFileSync(path.join(root, 'src/lib/c.ts'), 'export const c = 1;\n');
    await waitFor(() => seen.flat().includes('src/lib/c.ts'));
  });

  it('refresh() depois de uma reanálise segue o .gitignore atual', () => {
    const root = project();
    watcher = watchProject(root, () => {}, { delayMs: 50 });
    expect(watcher.watched).toBe(4); // ., src, src/lib, vendor
    fs.writeFileSync(path.join(root, '.gitignore'), 'gerado/\nvendor/\n');
    watcher.refresh();
    expect(watcher.watched).toBe(3);
  });
});

describe('watchProject (varredura)', () => {
  it('sem limite de inotify (ENOSPC): avisa e passa a varrer o projeto', async () => {
    const root = project();
    vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), {
        code: 'ENOSPC',
      });
    });
    const fallbacks: string[] = [];
    const seen: string[][] = [];
    watcher = watchProject(root, (files) => seen.push(files), {
      delayMs: 20,
      pollMs: 100,
      onFallback: (err) => fallbacks.push(err.code ?? ''),
    });
    expect(watcher.mode).toBe('polling');
    expect(watcher.watched).toBe(0);
    expect(fallbacks).toEqual(['ENOSPC']);

    // tamanho diferente: a varredura percebe mesmo com mtime de resolução de 1 s
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 22;\n');
    fs.writeFileSync(path.join(root, 'node_modules/pkg/index.js'), 'module.exports = 3;\n');
    fs.mkdirSync(path.join(root, 'src/nova'));
    fs.writeFileSync(path.join(root, 'src/nova/f.ts'), 'export const f = 1;\n');
    await waitFor(() => seen.flat().includes('src/nova/f.ts'));
    await waitFor(() => seen.flat().includes('src/a.ts'));
    expect(seen.flat().some((f) => f.startsWith('node_modules'))).toBe(false);

    fs.rmSync(path.join(root, 'src/lib/b.ts'));
    await waitFor(() => seen.flat().includes('src/lib/b.ts'));
  });

  it('flush() compara na hora, sem esperar o intervalo da varredura', async () => {
    const root = project();
    const seen: string[][] = [];
    watcher = watchProject(root, (files) => seen.push(files), {
      polling: true,
      delayMs: 0,
      pollMs: 3_600_000,
    });
    expect(watcher.mode).toBe('polling');
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 333;\n');
    watcher.flush();
    await pause(5);
    expect(seen.flat()).toEqual(['src/a.ts']);
  });

  it('erro de um watch já aberto também cai para a varredura', async () => {
    const root = project();
    const real = fs.watch;
    const opened: fs.FSWatcher[] = [];
    vi.spyOn(fs, 'watch').mockImplementation(((...args: Parameters<typeof fs.watch>) => {
      const w = real(...args);
      opened.push(w);
      return w;
    }) as typeof fs.watch);
    const fallbacks: string[] = [];
    watcher = watchProject(root, () => {}, {
      pollMs: 100,
      onFallback: (err) => fallbacks.push(err.code ?? ''),
    });
    expect(watcher.mode).toBe('live');
    opened[0]!.emit('error', Object.assign(new Error('EMFILE'), { code: 'EMFILE' }));
    expect(watcher.mode).toBe('polling');
    expect(watcher.watched).toBe(0);
    expect(fallbacks).toEqual(['EMFILE']);
  });
});
