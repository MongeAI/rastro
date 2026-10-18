import os from 'node:os';
import path from 'node:path';
import { t } from './i18n.js';

/** Cores no terminal (desligadas fora de um TTY ou com NO_COLOR). */
const color = (code: number) => (s: string) =>
  process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;

export const bold = color(1);
export const dim = color(2);
export const red = color(31);
export const green = color(32);
export const yellow = color(33);
export const cyan = color(36);

/** Mostra o erro em vermelho e encerra com código 1. */
export function fail(message: string): never {
  process.stderr.write(`${red(t().errorPrefix)} ${message}\n`);
  process.exit(1);
}

/** Mostra a pasta pessoal como ~ (não expõe o nome do usuário em capturas, logs e relatórios). */
export function tildify(p: string): string {
  const home = os.homedir();
  return home && (p === home || p.startsWith(`${home}${path.sep}`))
    ? `~${p.slice(home.length)}`
    : p;
}
