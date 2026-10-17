# Segurança e privacidade

O Rastro é **local-first** e **somente leitura**. Este documento lista exatamente o que ele faz e o que ele não faz.

## O que o Rastro faz

- **Lê arquivos** dentro da pasta indicada: código-fonte JS/TS, `.gitignore`, `package.json`, `tsconfig.json`/`jsconfig.json`.
- **Lê declarações de tipo** que o compilador TypeScript encontrar durante a resolução de módulos (por exemplo, `.d.ts` em `node_modules` ou em `dist/` de pacotes do workspace). Esses arquivos ajudam a classificar chamadas como externas; eles não viram nós do grafo.
- **Grava um arquivo JSON** na pasta de cache do usuário (ou em `--out`), com permissão `0600`. Nada é gravado dentro do projeto analisado.
- **Abre um servidor HTTP** em `127.0.0.1` para a interface (quando usa `rastro <caminho>` ou `rastro serve`).
- **Abre o navegador** com `xdg-open`/`open`/`start` (desative com `--no-open`).

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
- `/api/source` só entrega arquivos JS/TS que estão no grafo como analisados, recusa caminhos absolutos e com `..` (mesmo vindos de um JSON adulterado aberto com `rastro serve`), confirma que o caminho real fica dentro da raiz, recusa links simbólicos e limita o tamanho a 2 MB.
- Arquivos estáticos são servidos apenas de dentro da pasta da interface (sem _path traversal_).
- Cabeçalhos: `Content-Security-Policy` restritiva (`default-src 'self'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.

Encerre o servidor com `Ctrl+C` quando terminar. Os arquivos estáticos da interface (HTML, JS, CSS) não exigem token, porque não contêm dados do projeto.

## Ao compartilhar um JSON exportado

O arquivo contém o **caminho absoluto** da pasta analisada (`project.root`), nomes de arquivos, funções e classes, e **trechos de código** (as evidências). Revise antes de publicar se o projeto for privado.

## Projetos não confiáveis

Analisar um repositório desconhecido é seguro no sentido de que nada dele é executado. Ainda assim:

- Um repositório pode conter arquivos enormes ou muitos arquivos para tornar a análise lenta; use `--max-files` e `--exclude`.
- Os trechos de código exibidos na interface são tratados como texto (o React escapa o conteúdo); nada é interpretado como HTML.
- Links “abrir no editor” apenas montam uma URL (`vscode://...`) com o caminho do arquivo; o navegador pede confirmação antes de abrir o editor.

## Reportando vulnerabilidades

Por favor, não abra uma issue pública. Envie os detalhes de forma privada para os mantenedores da MongeAI.
