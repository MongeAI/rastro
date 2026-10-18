import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'puppeteer-core';

export const repo = fileURLToPath(new URL('../', import.meta.url));
export const bin = path.join(repo, 'apps', 'cli', 'bin', 'rastro.js');
export const fixture = (name: string) => path.join(repo, 'fixtures', name);
export const tmp = (prefix: string) =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/** Chrome/Chromium instalado (CHROME_PATH tem prioridade). */
export function findChrome(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return candidates.find((c): c is string => !!c && fs.existsSync(c));
}

export interface RunningRastro {
  url: string;
  output: () => string;
  /** Espera um texto aparecer na saída da CLI. */
  waitForOutput(pattern: RegExp, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

/** Roda a CLI empacotada com `--no-open` numa porta livre e devolve a URL (com o token). */
export function startRastro(args: string[], cwd = repo): Promise<RunningRastro> {
  const child: ChildProcess = spawn(process.execPath, [bin, ...args, '--no-open', '-p', '0'], {
    cwd,
    env: { ...process.env, NO_COLOR: '1', RASTRO_LANG: 'pt' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const listeners = new Set<() => void>();
  const onData = (chunk: Buffer) => {
    output += chunk.toString();
    for (const l of listeners) l();
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);

  const waitForOutput = (pattern: RegExp, timeoutMs = 30_000) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (pattern.test(output)) {
          listeners.delete(check);
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`a CLI não mostrou ${pattern} a tempo. Saída:\n${output}`));
      }, timeoutMs);
      listeners.add(check);
      check();
    });

  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    });

  return new Promise((resolve, reject) => {
    child.once('exit', (code) =>
      reject(new Error(`a CLI terminou antes de abrir o servidor (código ${code}):\n${output}`)),
    );
    const url = /http:\/\/127\.0\.0\.1:\d+\/\S+/;
    waitForOutput(url, 60_000)
      .then(() => resolve({ url: url.exec(output)![0], output: () => output, waitForOutput, stop }))
      .catch(reject);
  });
}

export interface OpenPage {
  page: Page;
  /** Erros e avisos do console, exceções da página e requisições a outros endereços. */
  problems: string[];
}

/** Abre uma página no idioma pedido, registrando qualquer erro do console. */
export async function openPage(
  browser: Browser,
  url: string,
  {
    lang = 'pt',
    width = 1440,
    height = 900,
  }: { lang?: 'pt' | 'en'; width?: number; height?: number } = {},
): Promise<OpenPage> {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  const problems: string[] = [];
  const origin = url.startsWith('file:') ? 'file:' : new URL(url).origin;
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warn') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${(e as Error).message}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:'))
      problems.push(`request: ${u}`);
  });
  await page.evaluateOnNewDocument((l) => {
    try {
      localStorage.setItem('rastro:lang', l);
    } catch {
      // file:// sem localStorage: o idioma vem do navegador
    }
  }, lang);
  await page.goto(url, { waitUntil: 'load' });
  await waitForMap(page);
  return { page, problems };
}

/** Espera o mapa ser desenhado e o layout terminar. */
export async function waitForMap(page: Page): Promise<void> {
  await page.waitForSelector('.graph-canvas canvas', { timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector('.layout-busy'), { timeout: 30_000 });
  await sleep(300);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const text = (page: Page, selector: string) =>
  page.$eval(selector, (el) => el.textContent ?? '').catch(() => null);

export const texts = (page: Page, selector: string) =>
  page.$$eval(selector, (els) => els.map((el) => el.textContent ?? ''));

export async function pressCombo(page: Page, modifier: 'Control' | 'Alt', key: string) {
  await page.keyboard.down(modifier);
  await page.keyboard.press(key as Parameters<Page['keyboard']['press']>[0]);
  await page.keyboard.up(modifier);
}

/**
 * Roda uma função com a instância do Cytoscape do mapa (o Cytoscape guarda a instância em
 * `_cyreg` no elemento do container). A função vai como texto: só pode usar os argumentos.
 */
export async function cyEval<T, A extends unknown[]>(
  page: Page,
  fn: (cy: import('cytoscape').Core, ...args: A) => T,
  ...args: A
): Promise<T> {
  return (await page.evaluate(
    `(${fn.toString()})(document.querySelector('.graph-canvas')._cyreg.cy, ...${JSON.stringify(args)})`,
  )) as T;
}
