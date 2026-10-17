/**
 * Encurta a pasta pessoal para `~` ao exibir caminhos (ex.: `/home/ana/projetos/x` → `~/projetos/x`).
 * Evita expor o nome do usuário em capturas de tela e apresentações.
 */
export function displayPath(absolute: string): string {
  return absolute
    .replace(/^\/home\/[^/]+(?=\/|$)/, '~')
    .replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
    .replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+(?=[\\/]|$)/, '~');
}
