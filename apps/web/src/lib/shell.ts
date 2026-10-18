/**
 * Põe um argumento entre aspas simples para um shell POSIX, a menos que ele só tenha
 * caracteres que o shell lê literalmente. Os nomes vêm do projeto analisado: `;`, `|`, `>`,
 * `$(…)` e afins não podem virar comandos quando o texto copiado é colado no terminal.
 */
export function shellQuote(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
