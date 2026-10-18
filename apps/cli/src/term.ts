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

/**
 * Tira caracteres de controle (C0, DEL e C1, menos `\n` e `\t`) de textos que vêm do projeto
 * ou de um JSON: nomes de arquivos e entidades, diagnósticos, erros. Um nome de arquivo com
 * sequências ESC poderia mudar o título do terminal, apagar a tela ou esconder linhas.
 */
export function safeText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/** Mostra o erro em vermelho e encerra (código 1, ou o pedido). */
export function fail(message: string, code = 1): never {
  process.stderr.write(`${red(t().errorPrefix)} ${safeText(message)}\n`);
  process.exit(code);
}

/** Mostra a pasta pessoal como ~ (não expõe o nome do usuário em capturas, logs e relatórios). */
export function tildify(p: string): string {
  const home = os.homedir();
  return home && (p === home || p.startsWith(`${home}${path.sep}`))
    ? `~${p.slice(home.length)}`
    : p;
}
