import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REDIRECT_LIFETIME_MS = 60_000;

/**
 * Abre a URL no navegador padrão. Falhas são silenciosas: a URL sempre é impressa no terminal.
 *
 * A URL tem o token de acesso. Passá-la direto para `xdg-open`/`open` a deixaria visível na
 * lista de processos (`/proc/<pid>/cmdline`) para outros usuários da máquina, inclusive no
 * processo do navegador. Por isso abrimos um HTML temporário, legível só pelo usuário, que
 * redireciona para a URL — a mesma técnica usada pelo Jupyter.
 */
export function openBrowser(url: string): void {
  let target = url;
  let cleanup = () => {};
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-'));
    const file = path.join(dir, 'abrir-rastro.html');
    const safe = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    fs.writeFileSync(
      file,
      `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safe}">` +
        `<title>Rastro</title><p>Abrindo o Rastro… <a href="${safe}">continuar</a></p>`,
      { mode: 0o600, flag: 'wx' },
    );
    target = pathToFileURL(file).href;
    cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    setTimeout(cleanup, REDIRECT_LIFETIME_MS).unref();
    process.once('exit', cleanup);
  } catch {
    // sem pasta temporária gravável: abre a URL diretamente
  }

  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [target]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', target]]
        : ['xdg-open', [target]];
  try {
    const child = spawn(command, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => cleanup());
    child.unref();
  } catch {
    cleanup();
  }
}
