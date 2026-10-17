# Teia

**Transforme um repositório JavaScript/TypeScript em um mapa navegável do código.**

O Teia lê o código-fonte de um projeto, monta um grafo com arquivos, funções, classes, métodos e as relações entre eles (quem importa quem, quem chama quem, quem estende quem) e abre esse grafo em uma interface interativa no seu navegador. Tudo roda na sua máquina.

> ⚠️ **Fase inicial (v0.1).** O Teia é um MVP: funciona, tem testes, mas ainda é jovem. Hoje ele entende **apenas JavaScript e TypeScript**. Veja [limitações conhecidas](#limitações-conhecidas) e o [roadmap](ROADMAP.md).

<sub>English: Teia is a local-first, open source tool by MongeAI that statically analyzes JS/TS repositories and renders them as an explorable code graph. Docs are in Portuguese for now.</sub>

---

## Para que serve

Imagine que você acabou de cair em um projeto que nunca viu. O Teia ajuda a responder rápido:

- Quais são os principais módulos (pastas) e como eles dependem uns dos outros?
- Quais arquivos importam quais? Há **ciclos de importação**?
- Quais funções chamam outras funções? Onde algo é definido e onde é usado?
- Quais rotas HTTP existem (Express) e qual função atende cada uma?
- **Se eu mudar esta função, o que pode quebrar?** (análise de impacto)
- O que o código referencia, mas **não pôde ser resolvido**?

O princípio é simples: **toda relação no grafo aponta para o arquivo e a linha que a comprovam.** Quando o Teia não consegue provar uma ligação, ele não inventa nada: a referência aparece como “não resolvida”, com o motivo.

## O que já funciona

| Área            | O que o Teia faz                                                                                                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Análise**     | Arquivos `.js .jsx .ts .tsx .mjs .cjs .mts .cts`; funções, classes, métodos (incl. construtor, getters/setters, propriedades-função) e componentes React; ESM e CommonJS (`require`, `module.exports`, `exports.x`); `import()` dinâmico; JSX (`<Card />`) |
| **Resolução**   | Usa o próprio compilador do TypeScript (via [ts-morph](https://ts-morph.com)): respeita `tsconfig.json`/`jsconfig.json` (`paths`, `baseUrl`), extensões `.js`→`.ts`, pastas com `index`, reexportações (`export * from`) e pacotes de monorepo             |
| **Relações**    | `importa`, `exporta`, `contém`, `chama` (incluindo `new` e uso em JSX), `estende`, `depende de` (entre módulos)                                                                                                                                            |
| **Honestidade** | Separa relações **resolvidas**, **externas** (pacotes npm, Node.js) e **não resolvidas** (com motivo: módulo inexistente, pacote não declarado, chamada indireta, import dinâmico...)                                                                      |
| **Rotas**       | Rotas do **Express** (`app.get('/x', handler)`, `router.post(...)`) ligadas aos handlers                                                                                                                                                                   |
| **Interface**   | Mapa interativo (zoom, arrastar), agrupamento por pasta e arquivo, expansão progressiva, busca, filtros, legenda, painel de detalhes com código e evidências, foco na vizinhança, análise de impacto, tema claro/escuro, abrir no editor                   |
| **Exportação**  | Grafo completo em JSON versionado e validável (JSON Schema + validação de integridade), e imagem PNG do mapa                                                                                                                                               |

## Instalação

Pré-requisitos: **Node.js 22.12 ou mais novo** e **git**.

```bash
git clone <url-do-repositório> teia
cd teia
npm install
npm run build
```

Pronto. Para testar com um projeto de exemplo que já vem no repositório:

```bash
npx teia fixtures/ts-basic
```

O terminal mostra um resumo da análise e o navegador abre em `http://127.0.0.1:4321/`.

> Quer o comando `teia` disponível em qualquer pasta? Rode `npm link -w apps/cli` uma vez (para desfazer: `npm unlink -g teia`).

## Uso

```bash
teia <caminho-do-projeto>        # analisa e abre o mapa no navegador
teia analyze <caminho>           # só analisa e salva o JSON
teia analyze <caminho> --stdout  # escreve o JSON na saída padrão
teia serve <grafo.json>          # abre o mapa de um JSON salvo antes
teia validate <grafo.json>       # confere se um JSON é um grafo válido
```

Opções úteis:

| Opção                    | Para quê                                                                    |
| ------------------------ | --------------------------------------------------------------------------- |
| `-o, --out <arquivo>`    | Onde salvar o JSON (padrão: pasta de cache do usuário, ex. `~/.cache/teia`) |
| `-p, --port <n>`         | Porta da interface (padrão 4321; se estiver ocupada, usa a próxima livre)   |
| `--no-open`              | Não abre o navegador automaticamente                                        |
| `-e, --exclude <padrão>` | Ignora caminhos, com a sintaxe do `.gitignore` (pode repetir)               |
| `--no-gitignore`         | Não usa o `.gitignore` do projeto                                           |
| `--max-files <n>`        | Limite de arquivos analisados (padrão 10000)                                |

Exemplos:

```bash
teia ~/projetos/minha-api
teia . -e "**/*.test.ts" -e "scripts/"
teia analyze ~/projetos/loja -o loja.graph.json && teia serve loja.graph.json
```

O Teia **nunca grava nada dentro do projeto analisado**. O JSON vai para a pasta de cache (`$XDG_CACHE_HOME/teia`, `~/Library/Caches/teia` no macOS, `%LOCALAPPDATA%\teia\Cache` no Windows) ou para onde você indicar com `-o`.

## Como explorar o mapa

1. **Visão geral.** O mapa abre mostrando as pastas (caixas tracejadas) e os arquivos. À direita fica o **resumo**: contagens, ciclos de importação e referências não resolvidas.
2. **Clique** em qualquer nó para ver os detalhes: onde está, o trecho de código, quem ele chama, quem o chama, o que importa e o que exporta. Cada relação mostra o **arquivo:linha** e a linha de código que a comprova.
3. **Dois cliques** em um arquivo marcado com `+` mostram as funções e classes dele. O botão **Símbolos** expande todos de uma vez.
4. **Busque** com `/` (ou `Ctrl+K`) por nome de arquivo, função, classe ou caminho. `Enter` leva até o item.
5. **Focar vizinhança** isola a entidade e suas conexões (distância 1, 2 ou 3). **Expandir conexões** adiciona os vizinhos ao mapa sem esconder o resto.
6. **Calcular quem pode ser afetado** lista quem depende da entidade, direta ou indiretamente.
7. **Abrir no editor** abre o arquivo na linha certa (VS Code, Cursor, VSCodium, Zed ou JetBrains; escolha no painel da esquerda).
8. **Exportar JSON** baixa o grafo completo; o botão de imagem no canto do mapa salva um PNG.

Legenda das linhas: contínua = resolvida no projeto · tracejada cinza = externa · tracejada vermelha = não resolvida · pontilhada = import só de tipo ou export · contorno laranja = ciclo de importação.

## Como funciona

```
caminho do projeto
  └─ descoberta de arquivos (respeita .gitignore, ignora node_modules/dist/build, não segue symlinks)
      └─ ts-morph / compilador TypeScript (só lê; nada é executado)
          └─ extração: arquivos → funções/classes/métodos → imports/exports → chamadas → herança → rotas
              └─ GraphBuilder: remove duplicatas, junta evidências, deriva dependências entre módulos, detecta ciclos
                  └─ JSON versionado (schema 0.1.0) → servidor local (127.0.0.1) → interface React + Cytoscape.js
```

Detalhes em [docs/arquitetura.md](docs/arquitetura.md) e no [formato dos dados](docs/formato-dos-dados.md).

## Privacidade e segurança

- **Local-first:** nenhum código é enviado para fora da sua máquina. A análise não depende de IA, API paga, conta ou internet.
- **Só leitura:** o Teia **não executa** o projeto analisado, não roda scripts/hooks do `package.json` e não instala dependências.
- **Servidor restrito:** a interface escuta apenas em `127.0.0.1`, aceita só `GET`/`HEAD`, recusa `Host` diferente de localhost (proteção contra DNS rebinding) e só entrega código de arquivos que fazem parte do grafo.
- **Links simbólicos não são seguidos** e arquivos muito grandes (provavelmente gerados) são ignorados.

O JSON exportado contém o **caminho absoluto** da raiz do projeto (para os links “abrir no editor”), além de nomes e trechos de código. Leve isso em conta antes de compartilhar. Mais em [docs/seguranca.md](docs/seguranca.md).

## Limitações conhecidas

- **Linguagens:** só JavaScript e TypeScript por enquanto.
- **Chamadas dinâmicas** (`obj[nome]()`, callbacks, injeção de dependência, eventos) não viram ligações confirmadas: aparecem como não resolvidas ou entram só nas contagens.
- **JavaScript sem tipos:** chamadas como `obj.metodo()` só são ligadas quando o TypeScript consegue inferir o tipo de `obj`.
- **Funções declaradas dentro de outras funções** não viram nós próprios; suas chamadas são contadas à parte.
- **Rotas:** só Express, com caminho literal. Next.js, Fastify, NestJS etc. ainda não.
- **Monorepos:** usa o `tsconfig.json`/`jsconfig.json` da raiz; `paths` definidos só em subpacotes podem não ser resolvidos. Imports entre pacotes que apontam para `dist/*.d.ts` são ligados ao `src/` correspondente quando ele existe (marcado com `viaDeclaration`).
- **Escala:** testado com projetos de dezenas a algumas centenas de arquivos. Projetos muito grandes funcionam, mas a análise e o layout ficam mais lentos.

## Estrutura do repositório

```
apps/cli          CLI `teia`: análise, armazenamento local e servidor da interface
apps/web          Interface web (React + Cytoscape.js)
packages/core     Modelo de dados (nós, relações, evidências), JSON Schema e validação
packages/graph    GraphBuilder, detecção de ciclos, consultas (vizinhança, impacto, busca) e cálculo da visão
packages/analyzer Analisador JS/TS baseado em ts-morph
fixtures          Projetos de exemplo usados nos testes
docs              Arquitetura, formato dos dados e segurança
```

## Desenvolvimento

```bash
npm test             # testes (Vitest)
npm run lint         # ESLint
npm run format       # Prettier
npm run typecheck    # TypeScript em todos os pacotes
```

Para trabalhar na interface com recarga automática:

```bash
npx teia fixtures/ts-basic --port 4321 --no-open   # terminal 1: análise + API em 127.0.0.1:4321
npm run dev:web                                    # terminal 2: Vite em http://127.0.0.1:5173 (usa a API acima)
```

Veja [CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

[MIT](LICENSE) © MongeAI. As fontes Inter e JetBrains Mono embutidas na interface são distribuídas sob a SIL Open Font License 1.1.
