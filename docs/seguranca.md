# Segurança e privacidade

O Rastro é **local-first** e **somente leitura**. Este documento lista exatamente o que ele faz e o que ele não faz.

## O que o Rastro faz

- **Lê arquivos** dentro da pasta indicada: código-fonte JS/TS, `.gitignore`, `package.json`, `tsconfig.json`/`jsconfig.json`.
- **Lê declarações de tipo** que o compilador TypeScript encontrar durante a resolução de módulos (por exemplo, `.d.ts` em `node_modules` ou em `dist/` de pacotes do workspace). Esses arquivos ajudam a classificar chamadas como externas; eles não viram nós do grafo.
- **Grava um arquivo JSON** na pasta de cache do usuário (ou em `--out`), com permissão `0600`. Nada é gravado dentro do projeto analisado.
- **Abre um servidor HTTP** em `127.0.0.1` para a interface (quando usa `rastro <caminho>` ou `rastro serve`).
- **Abre o navegador** com `xdg-open`/`open`/`start` (desative com `--no-open`).
- **Roda o `git` em modo leitura**, e só com `--changes` ou `--since` (ver [Mudanças do git](#mudanças-do-git---changes---since)).
- **Observa as pastas do projeto** no modo ao vivo (`--watch`), só para saber quando reanalisar (ver [Modo ao vivo](#modo-ao-vivo---watch)).
- **Grava um relatório HTML** com `rastro export --format html` (ver [Relatório HTML offline](#relatório-html-offline)).
- **Responde a agentes de IA pelo stdio** com `rastro mcp` (ver [Servidor MCP](#servidor-mcp-rastro-mcp)).

## O que o Rastro não faz

- Não executa, importa nem avalia código do projeto analisado. O compilador TypeScript apenas faz _parse_ e verificação de tipos.
- Não roda scripts, hooks ou comandos do `package.json` (`postinstall`, `prepare`...) e não instala dependências. Os testes conferem isso com um fixture que criaria um arquivo marcador se fosse executado.
- Não carrega plugins do `tsconfig.json` (`compilerOptions.plugins` é descartado).
- Não envia nada pela rede. A interface não usa CDN, fontes externas nem telemetria: tudo é servido localmente.
- Não segue links simbólicos dentro do projeto (evita sair da raiz e loops).

## Proteções do servidor local

- Escuta apenas em `127.0.0.1` (nunca em `0.0.0.0`).
- Gera um **token aleatório por execução**. A CLI abre `http://127.0.0.1:<porta>/?token=...`; o servidor troca o token por um cookie `HttpOnly; SameSite=Strict` e a API (`/api/*`) recusa quem não o tiver. Assim, outros usuários ou processos da máquina não conseguem ler o código pela porta local.
- Aceita só `GET` e `HEAD`.
- Recusa requisições cujo cabeçalho `Host` não seja `127.0.0.1:<porta>`, `localhost:<porta>` ou `[::1]:<porta>`, o que bloqueia ataques de DNS rebinding.
- `/api/events` (Server-Sent Events, usado pelo modo ao vivo) tem as mesmas proteções do resto da API: o mesmo cookie, a mesma checagem de `Host`, só `GET`. Ele não carrega código nem nomes: cada evento traz apenas o número da versão do grafo (`{"version": n}`); o navegador então busca `/api/graph`, que devolve a versão atual no cabeçalho `X-Rastro-Version`. Um comentário vazio a cada 25 s mantém a conexão aberta.
- `/api/source` só entrega arquivos JS/TS que estão no grafo como analisados, recusa caminhos absolutos e com `..` (mesmo vindos de um JSON adulterado aberto com `rastro serve`), confirma que o caminho real fica dentro da raiz, recusa links simbólicos e limita o tamanho a 2 MB.
- Arquivos estáticos são servidos apenas de dentro da pasta da interface (sem _path traversal_).
- Cabeçalhos: `Content-Security-Policy` restritiva (`default-src 'self'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.

Encerre o servidor com `Ctrl+C` quando terminar. Os arquivos estáticos da interface (HTML, JS, CSS) não exigem token, porque não contêm dados do projeto.

## Mudanças do git (`--changes`, `--since`, `rastro impact`)

Sem essas opções (ou o `rastro impact` de uma pasta) o Rastro não chama o `git`. Com elas, roda apenas comandos de leitura (`rev-parse`, `config --list`, `merge-base`, `diff`, `ls-files`), sem `shell`, com os argumentos passados diretamente ao processo, e:

- com `-c core.fsmonitor=false`, `-c core.hooksPath=/dev/null` e `--no-pager`, e no `diff` com `--no-ext-diff` e `--no-textconv`, o que desliga as extensões que executariam programas;
- com `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0` e `GIT_OPTIONAL_LOCKS=0`: sem configuração do sistema, sem pedir senha e sem travar o índice do repositório;
- no `diff` com `--ignore-submodules=all`: o git nunca entra num submódulo (lá ele leria a configuração de `.git/modules/<nome>/config`, que a checagem abaixo não vê, e rodaria um filtro definido nela);
- com `GIT_LITERAL_PATHSPECS=1`: a pasta analisada é sempre um caminho literal (uma pasta chamada `:(top)x` não vira “mágica” de pathspec);
- com prefixos fixos (`--src-prefix=a/ --dst-prefix=b/ --no-relative`), para que opções como `diff.noprefix` ou `diff.mnemonicPrefix` na sua configuração global não confundam a leitura dos caminhos;
- recusando referências que começam com `-` em `--since` (não viram opções do git).

**Configuração arriscada do repositório.** Um repositório baixado de fonte não confiável (por exemplo, um `.zip` com a pasta `.git`) pode trazer configurações que fazem o próprio git executar comandos ao gerar um diff: filtros (`filter.<nome>.clean`/`smudge`/`process`, ativados por um `.gitattributes`), `diff.<nome>.textconv`/`command`, `diff.external`, `core.fsmonitor`, `core.hooksPath`, `core.pager`, `core.sshCommand`, `include.path` e `includeIf.<condição>.path`. Antes de rodar o diff, o Rastro lista a configuração efetiva com o escopo de cada chave (`git config --list --show-scope`, já seguindo os `include.path`) e **recusa** o repositório se alguma dessas chaves vier de um escopo que não seja o seu (`global`) ou o do sistema (`system`): o `.git/config` (`local`), o `.git/config.worktree` (`worktree`, lido quando `extensions.worktreeConfig` está ligado) ou variáveis `GIT_CONFIG_*` (`command`). Se a listagem falhar, o Rastro também não continua. A mensagem diz quais chaves encontrou.

**`--trust-git-config`** desliga essa recusa. Use só em repositórios em que você confia tanto quanto em rodar `git diff` neles por conta própria: com essa opção, um filtro ou `textconv` definido no repositório **será executado** com as suas permissões. As proteções da lista acima continuam valendo. Sem `--changes` ou `--since` (ou fora do `rastro impact` de uma pasta, que sempre lê o git) a opção não tem efeito, e a CLI recusa o uso isolado.

Arquivos novos (não versionados) entram como adicionados. O Rastro só lê os que o analisador leria: arquivo regular (sem seguir links simbólicos, então nada de `/dev/zero` ou FIFOs), extensão JS/TS e até 1 MB. Os demais entram como uma linha alterada, sem leitura.

## Modo ao vivo (`--watch`)

O modo ao vivo **só lê**: observa as pastas que o analisador leria (as mesmas exclusões, `.gitignore` e `--exclude`; nunca `node_modules` nem `.git`), com um observador por pasta, e reanalisa quando um arquivo JS/TS ou de configuração muda. Nada é executado e nada é gravado no projeto; o JSON atualizado vai para o mesmo destino da análise inicial.

Se o sistema não deixar observar as pastas (no Linux, por exemplo, o limite `fs.inotify.max_user_watches` esgotado, erro `ENOSPC`), a CLI avisa no terminal e passa a procurar mudanças por varredura a cada 1,5 s, comparando data e tamanho dos arquivos. Ela nunca diz que está ao vivo sem estar observando nada.

## Servidor MCP (`rastro mcp`)

O `rastro mcp` é um servidor do Model Context Protocol iniciado pelo cliente de IA (Claude Code, Cursor, VS Code...) como processo filho:

- **Só stdio.** Não abre porta de rede: fala JSON-RPC pelo stdin/stdout com o processo que o iniciou, e mais ninguém. O stdout só carrega mensagens do protocolo (os avisos vão para o stderr, e até um `console.log` acidental é desviado para lá); mensagens acima de 1 MB são recusadas sem derrubar o servidor.
- **Só leitura.** As oito ferramentas consultam o grafo (anotadas como `readOnlyHint`); nenhuma grava arquivos, executa código do projeto ou instala algo. A análise roda numa worker thread com o mesmo analisador da CLI.
- **Código só de arquivos analisados.** `rastro_entity` com `source: true` usa a mesma leitura do servidor local (`readSource`): só arquivos JS/TS que estão no grafo como analisados, nada de caminhos absolutos ou com `..`, o caminho real precisa ficar dentro da raiz (links simbólicos recusados), até 2 MB por arquivo e no máximo 120 linhas por resposta.
- **Git com as mesmas proteções.** O modo git do `rastro_impact` (mudanças sem commit ou `since`) chama o mesmo `collectChanges` do `rastro impact`, com todas as proteções da seção [Mudanças do git](#mudanças-do-git---changes---since). A referência vem do agente: uma que comece com `-` é recusada, e a configuração arriscada do repositório também, a não ser que o servidor tenha sido iniciado com `--trust-git-config` (o agente não consegue ligar isso). A branch mostrada no resumo é lida do `.git/HEAD`, sem rodar o git.
- **Texto do projeto como dado.** Nomes, caminhos, ids e trechos de código chegam ao agente como código inline, numa linha só: quebras de linha, tabs, caracteres de controle e os separadores U+2028/U+2029/U+0085 viram escapes visíveis (`\n`, `\u2028`), então um arquivo ou um `name` do package.json não consegue escrever títulos ou "instruções" na resposta (e o id escapado continua valendo como alvo). O código-fonte vai num bloco cercado com uma cerca maior que qualquer sequência de crases dele. No stdout, U+2028/U+2029 também saem escapados no JSON. O agente lê código do projeto de qualquer forma; trate comentários e strings de repositórios desconhecidos como dados, não como instruções.
- **Stderr fechado não derruba.** Se o cliente fechar o pipe do stderr, os avisos são descartados e o servidor continua respondendo; quando a entrada fecha, ele espera no máximo 2 s pelas respostas em andamento e encerra.
- **Observação de arquivos.** Igual ao modo ao vivo (ver abaixo): só as pastas que o analisador leria, só para marcar o grafo como desatualizado; `--no-watch` desliga.

## Regras de arquitetura (`rastro.rules.json`)

- **Só JSON.** O arquivo de regras nunca é executado (não há configuração em JavaScript).
- **Entrada não confiável.** No CI, o arquivo vem do pull request. O `rastro.rules.json` padrão precisa ser um arquivo comum de até 1 MB: um link simbólico (que poderia apontar para um arquivo do runner) é recusado; com `--rules`, quem chamou escolheu o arquivo e o link é seguido. Um erro de JSON mostra só a mensagem e a posição, nunca um trecho do arquivo.
- **Sem travar o CI.** Os padrões são casados por programação dinâmica, não por expressões regulares: um padrão como `*a*a*a*a…` ou `**/**/**/…` não causa backtracking exponencial. As alternativas `{a,b}` são limitadas a 64 por padrão e cada padrão a 500 caracteres.
- **Nomes como dados.** O nome e o `because` de cada regra chegam ao comentário do pull request como código inline (sem links, menções ou HTML) e às respostas do MCP escapados numa linha só.
- **Um pull request pode mudar as regras.** Proteja o `rastro.rules.json` com uma entrada no `CODEOWNERS` se as regras importam.

## Relatório HTML offline

`rastro export --format html` gera um arquivo único com a interface, o grafo e as fontes tipográficas embutidos. Ele abre direto do disco e não precisa de servidor. O próprio HTML traz uma `Content-Security-Policy` que proíbe qualquer acesso à rede: `default-src 'none'`, `connect-src 'none'`, imagens e fontes só de `data:`, scripts só os embutidos (e o worker do layout, carregado de um `blob:`), `base-uri 'none'` e `form-action 'none'`. Mesmo um nome no grafo que tentasse buscar algo de fora seria bloqueado pelo navegador. Os nomes vindos do grafo são escapados (um `</script>` não fecha a tag) e o caminho da pasta pessoal aparece como `~`. O código-fonte não vai junto, só os trechos de evidência que já estão no JSON.

## Ao compartilhar um JSON exportado

O arquivo contém o **caminho absoluto** da pasta analisada (`project.root`), nomes de arquivos, funções e classes, e **trechos de código** (as evidências). Revise antes de publicar se o projeto for privado.

## Projetos não confiáveis

Analisar um repositório desconhecido é seguro no sentido de que nada dele é executado. Ainda assim:

- Um repositório pode conter arquivos enormes ou muitos arquivos para tornar a análise lenta; use `--max-files` e `--exclude`.
- Os trechos de código exibidos na interface são tratados como texto (o React escapa o conteúdo); nada é interpretado como HTML.
- No terminal, nomes de arquivos e entidades, diagnósticos e mensagens de erro saem sem caracteres de controle: um arquivo chamado com sequências ESC não muda o título do terminal nem apaga a tela.
- Em repositórios git não confiáveis, `--changes` e `--since` recusam configurações que executariam comandos (ver acima); não use `--trust-git-config` neles.
- Links “abrir no editor” apenas montam uma URL (`vscode://...`) com o caminho do arquivo; o navegador pede confirmação antes de abrir o editor.

## Reportando vulnerabilidades

Por favor, não abra uma issue pública. Envie os detalhes de forma privada para os mantenedores da MongeAI.

## GitHub Action (`uses: MongeAI/rastro`)

A action roda no pull request, então o código dele é tratado como não confiável:

- **Nada do pull request é executado.** O Rastro não é rodado com `npx` dentro do checkout (o npm leria o `.npmrc` do pull request, que pode trocar o registro ou injetar `node-options`, e até um `node_modules` commitado). Ele é instalado numa pasta do runner, do registro público (`--registry=https://registry.npmjs.org/`), com `--ignore-scripts`, e roda pelo caminho absoluto do bin com `NODE_OPTIONS` removido.
- **Entradas nunca entram direto no shell.** Todas passam por variáveis de ambiente; a base é recusada se começar com `-`; os padrões de `exclude` vão como `--exclude=<padrão>` (um padrão que começa com `-` não vira opção); o login do autor do comentário só aceita `[A-Za-z0-9-]` (e `[bot]`).
- **Config do git.** No runner, o `.git/config` é escrito pelo `actions/checkout` (que, a partir da v6, guarda credenciais num `includeIf`), não pelo pull request; por isso a action usa `--trust-git-config`. Fora do Actions, a recusa padrão continua valendo.
- **Comentário.** Só é atualizado o comentário com o marcador da pasta analisada (`<!-- rastro-impact -->` para a raiz, `<!-- rastro-impact:<pasta> -->` para as outras, com a pasta codificada parte a parte, então nada nela fecha o comentário HTML) escrito pelo autor esperado (`comment-author`): ninguém toma o comentário publicando o marcador, e duas chamadas da action para pastas diferentes não sobrescrevem o comentário uma da outra. Nomes vindos do código (arquivos, funções, rotas) entram como código inline e com tamanho limitado; links para `arquivo:linha` codificam também `( ) ! * ' ~`, para um nome de arquivo não fechar o link e injetar Markdown.
- **Saídas.** A lista de testes vai para `$GITHUB_OUTPUT` com um delimitador aleatório; nomes de teste com caracteres de controle ficam de fora da lista.
- **Forks.** Pull requests de forks recebem um token só de leitura: o comentário é pulado com um aviso e o relatório continua no resumo do job. Use o evento `pull_request`, nunca `pull_request_target`, que daria permissões de escrita a código de terceiros.
