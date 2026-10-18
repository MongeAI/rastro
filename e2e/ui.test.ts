/**
 * Testes de ponta a ponta da interface: a CLI empacotada de verdade (servidor local com token)
 * aberta no Chrome headless. Rode com `npm run test:e2e` depois de `npm run build`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer, { type Browser } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bin,
  findChrome,
  fixture,
  openPage,
  pressCombo,
  repo,
  sleep,
  startRastro,
  text,
  texts,
  tmp,
  waitForMap,
  type RunningRastro,
} from './helpers';

const chrome = findChrome();
const bundled = fs.existsSync(path.join(repo, 'apps', 'cli', 'dist', 'rastro.mjs'));
if (process.env.CI && (!chrome || !bundled))
  throw new Error('no CI os testes de interface precisam do Chrome e de "npm run build"');

/** Projeto pequeno num repositório git temporário. */
function gitProject(files: Record<string, string>): string {
  const root = tmp('rastro-e2e-git-');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: root, stdio: 'pipe' },
    );
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'inicial');
  return root;
}

describe.skipIf(!chrome || !bundled)('interface (Chrome headless)', () => {
  let browser: Browser;
  let basic: RunningRastro;
  const graphOut = tmp('rastro-e2e-out-');

  beforeAll(async () => {
    browser = await puppeteer.launch({
      executablePath: chrome!,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    basic = await startRastro([fixture('ts-basic'), '-o', path.join(graphOut, 'basic.json')]);
  }, 90_000);

  afterAll(async () => {
    await basic?.stop();
    await browser?.close();
  });

  /** Seleciona uma entidade pela busca ("/"). */
  const pick = async (page: import('puppeteer-core').Page, query: string) => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('/');
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.type(query);
    await sleep(150);
    await page.keyboard.press('Enter');
    await sleep(500);
  };

  it('abre o mapa pelo servidor local (com token) sem erros', async () => {
    const { page, problems } = await openPage(browser, basic.url);
    expect(await page.title()).toBe('ts-basic · Rastro');
    expect(await text(page, '.stage-status')).toMatch(/^\d+ nós · \d+ relações visíveis/);
    expect(await page.$('canvas.minimap')).not.toBeNull();
    // sem o token, a API recusa
    const denied = await fetch(new URL('/api/graph', basic.url));
    expect(denied.status).toBe(401);
    expect(problems).toEqual([]);
    await page.close();
  });

  it('busca, detalhes e breadcrumb', async () => {
    const { page, problems } = await openPage(browser, basic.url);
    await pick(page, 'slugify');
    expect(await text(page, '.details-name')).toBe('slugify');
    expect(await texts(page, '.crumb')).toEqual(['ts-basic', 'src', 'lib', 'strings.ts']);
    // a URL guarda a seleção (link direto)
    expect(decodeURIComponent(new URL(page.url()).hash)).toContain(
      '#n=fn:src/lib/strings.ts#slugify',
    );
    // o breadcrumb navega
    const crumbs = await page.$$('.crumb');
    await crumbs[2]!.click();
    await sleep(400);
    expect(await text(page, '.details-name')).toBe('lib');
    expect(problems).toEqual([]);
    await page.close();
  });

  it('paleta de comandos: entidades e ações', async () => {
    const { page, problems } = await openPage(browser, basic.url);
    await pressCombo(page, 'Control', 'k');
    await page.waitForSelector('.palette');
    await page.keyboard.type('UserService.create');
    await sleep(150);
    await page.keyboard.press('Enter');
    await sleep(500);
    expect(await page.$('.palette')).toBeNull();
    expect(await text(page, '.details-name')).toBe('UserService.create');

    // ações contextuais da seleção aparecem com a busca vazia
    await pressCombo(page, 'Control', 'k');
    await page.waitForSelector('.palette');
    const sections = await texts(page, '.palette-section');
    expect(sections).toContain('Ações');
    expect(await texts(page, '.palette-label')).toContain('Traçar caminho a partir daqui');

    // ">" filtra só ações; sem acento também acha
    await page.keyboard.type('>simbolos');
    await sleep(150);
    expect(await texts(page, '.palette-label')).toEqual(['Nível: Símbolos']);
    await page.keyboard.press('Enter');
    await waitForMap(page);
    expect(await text(page, '.segmented .on')).toBe('Símbolos');

    await pressCombo(page, 'Control', 'k');
    await page.keyboard.type('>tema claro');
    await sleep(150);
    await page.keyboard.press('Enter');
    await sleep(200);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    expect(problems).toEqual([]);
    await page.close();
  });

  it('teclado: setas entre nós, Alt+↑ sobe, Backspace volta, ? mostra os atalhos', async () => {
    const { page, problems } = await openPage(browser, basic.url);
    // sem seleção, a seta escolhe o nó do centro
    await page.keyboard.press('ArrowRight');
    await sleep(300);
    const first = await text(page, '.details-name');
    expect(first).toBeTruthy();

    await pick(page, 'math.ts');
    const visited = new Set<string>(['math.ts']);
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'] as const) {
      await page.keyboard.press(key);
      await sleep(250);
      visited.add((await text(page, '.details-name')) ?? '');
    }
    expect(visited.size).toBeGreaterThan(2);

    await pick(page, 'sum');
    await pressCombo(page, 'Alt', 'ArrowUp');
    await sleep(300);
    expect(await text(page, '.details-name')).toBe('math.ts');
    await page.keyboard.press('Backspace');
    await sleep(300);
    expect(await text(page, '.details-name')).toBe('sum');

    await page.keyboard.press('?');
    await page.waitForSelector('.shortcuts');
    expect((await page.$$('.shortcut-row')).length).toBeGreaterThanOrEqual(8);
    await page.keyboard.press('Escape');
    await sleep(100);
    expect(await page.$('.shortcuts')).toBeNull();

    // Enter num botão da barra do mapa aciona o botão, não expande a seleção
    await pick(page, 'math.ts');
    const before = await text(page, '.stage-status');
    await page.focus('.zoom-controls .icon-button');
    await page.keyboard.press('Enter');
    await sleep(400);
    expect(await text(page, '.stage-status')).toBe(before);

    // Esc fecha a paleta mesmo depois de um clique dentro dela (foco fora do campo)
    await pressCombo(page, 'Control', 'k');
    await page.waitForSelector('.palette');
    await page.click('.palette-foot');
    await page.keyboard.press('Escape');
    await sleep(150);
    expect(await page.$('.palette')).toBeNull();

    await page.keyboard.press('m');
    await sleep(100);
    expect(await page.$('canvas.minimap')).toBeNull();
    expect(problems).toEqual([]);
    await page.close();
  });

  it('caminho A → B com os passos e as evidências', async () => {
    const { page, problems } = await openPage(browser, basic.url);
    await pick(page, 'main');
    const [start] = await page.$$('xpath/.//button[contains(., "Traçar caminho a partir daqui")]');
    await start!.click();
    await sleep(200);
    // a busca recebe o foco para escolher o destino
    await page.keyboard.type('UserService.create');
    await sleep(150);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.path-steps');
    const steps = await texts(page, '.path-option.on .path-steps .rel-name');
    expect(steps[0]).toBe('main');
    expect(steps[steps.length - 1]).toBe('UserService.create');
    // o mapa mostra só o caminho; desmarcando, volta o mapa inteiro
    await waitForMap(page);
    const count = async () =>
      Number(/^(\d+) nós/.exec((await text(page, '.stage-status')) ?? '')?.[1]);
    const onlyPath = await count();
    await page.click('.details-head .toggle input');
    await waitForMap(page);
    expect(await count()).toBeGreaterThan(onlyPath);
    expect(problems).toEqual([]);
    await page.close();
  });

  it('interface em inglês e troca de idioma', async () => {
    const { page, problems } = await openPage(browser, basic.url, { lang: 'en' });
    expect(await text(page, '.stage-status')).toMatch(/^\d+ nodes · \d+ visible relationships/);
    await page.click('.lang-button');
    await sleep(200);
    expect(await text(page, '.stage-status')).toMatch(/nós/);
    expect(problems).toEqual([]);
    await page.close();
  });

  it('celular: sem rolagem horizontal, gaveta de filtros e paleta cabem na tela', async () => {
    const { page, problems } = await openPage(browser, basic.url, { width: 390, height: 844 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.click('.topbar .icon-button');
    await sleep(300);
    expect(await page.$('.app.sidebar-open')).not.toBeNull();
    await page.keyboard.press('Escape');
    await pressCombo(page, 'Control', 'k');
    const box = await (await page.waitForSelector('.palette'))!.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(problems).toEqual([]);
    await page.close();
  });

  it('--changes: aba Mudanças com o que mudou e quem é afetado', async () => {
    const root = gitProject({
      'src/a.ts': 'export function alpha() {\n  return 1;\n}\n',
      'src/b.ts':
        "import { alpha } from './a';\n\nexport function useAlpha() {\n  return alpha();\n}\n",
    });
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export function alpha() {\n  return 2;\n}\n');
    const run = await startRastro([root, '--changes', '-o', path.join(graphOut, 'changes.json')]);
    try {
      const { page, problems } = await openPage(browser, run.url);
      expect(await text(page, '.panel-tabs [aria-selected="true"]')).toMatch(/^Mudanças\s*1$/);
      const names = await texts(page, '.details .rel-name');
      expect(names).toContain('alpha');
      expect(names).toContain('useAlpha');
      expect(problems).toEqual([]);
      await page.close();
    } finally {
      await run.stop();
    }
  });

  it('--watch: o mapa atualiza ao salvar, sem recarregar', async () => {
    const root = tmp('rastro-e2e-watch-');
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function alpha() {\n  return 1;\n}\n');
    const run = await startRastro([root, '--watch', '-o', path.join(graphOut, 'watch.json')]);
    try {
      const { page, problems } = await openPage(browser, run.url);
      await pick(page, 'alpha');
      fs.writeFileSync(
        path.join(root, 'a.ts'),
        'export function alpha() {\n  return gamma();\n}\n\nexport function gamma() {\n  return 1;\n}\n',
      );
      await page.waitForSelector('.live-dot', { timeout: 20_000 });
      // a seleção continua e a função nova já existe
      expect(await text(page, '.details-name')).toBe('alpha');
      await pick(page, 'gamma');
      expect(await text(page, '.details-name')).toBe('gamma');
      expect(problems).toEqual([]);
      await page.close();
    } finally {
      await run.stop();
    }
  });

  it('chamadas por interface: candidatos "possível", nunca como relação comprovada', async () => {
    const run = await startRastro([fixture('oop'), '-o', path.join(graphOut, 'oop.json')]);
    try {
      const { page, problems } = await openPage(browser, run.url);
      await pick(page, 'MemoryRepository.save');
      expect(await text(page, '.details-name')).toBe('MemoryRepository.save');
      const body = (await text(page, '.details')) ?? '';
      expect(body).toContain('Possivelmente chamado por');
      expect(body).toContain('possível');
      await page.screenshot({ path: path.join(graphOut, 'possible.png') });
      // a chamada continua não resolvida, com as implementações possíveis listadas
      await page.goto(
        `${run.url.split('#')[0]}#n=${encodeURIComponent('unresolved:src/main.ts#call:repo.save')}`,
      );
      await waitForMap(page);
      const unresolved = (await text(page, '.details')) ?? '';
      expect(unresolved).toContain('Implementações possíveis');
      expect(unresolved).toContain('SqlRepository.save');
      expect(problems).toEqual([]);
      await page.close();
    } finally {
      await run.stop();
    }
  });

  it('projeto grande (1500 arquivos): pastas abertas no início e nível de arquivos rápido', async () => {
    const root = tmp('rastro-e2e-big-');
    // o mesmo gerador dos benchmarks: tudo dentro de src/, pastas que se importam entre si
    const { generateProject } = (await import(
      pathToFileURL(path.join(repo, 'scripts', 'bench.mjs')).href
    )) as { generateProject(root: string, files: number): void };
    generateProject(root, 1500);
    const run = await startRastro([root, '-o', path.join(graphOut, 'big.json')]);
    try {
      const { page, problems } = await openPage(browser, run.url);
      // o projeto inteiro está em src/: a pasta já vem aberta, mostrando as subpastas
      const status = (await text(page, '.stage-status')) ?? '';
      expect(Number(/^(\d+) nós/.exec(status)?.[1])).toBeGreaterThan(10);
      const start = Date.now();
      const [files] = await page.$$(
        'xpath/.//div[contains(@class,"segmented")]//button[contains(., "Arquivos")]',
      );
      await files!.click();
      await sleep(300);
      await waitForMap(page);
      expect(Date.now() - start).toBeLessThan(30_000);
      expect(await text(page, '.stage-status')).toMatch(/^15\d\d nós/);
      expect(problems).toEqual([]);
      await page.close();
    } finally {
      await run.stop();
    }
  });

  it('relatório HTML offline: abre por file:// sem nenhuma requisição externa', async () => {
    const out = path.join(tmp('rastro-e2e-report-'), 'relatorio.html');
    execFileSync(process.execPath, [bin, 'export', fixture('ts-basic'), '-f', 'html', '-o', out], {
      stdio: 'pipe',
      env: { ...process.env, RASTRO_LANG: 'pt' },
    });
    const { page, problems } = await openPage(browser, pathToFileURL(out).href);
    expect(await text(page, '.stage-status')).toMatch(/^\d+ nós/);
    await pick(page, 'slugify');
    expect(await text(page, '.details-name')).toBe('slugify');
    expect(problems).toEqual([]);
    await page.close();
  });
});
