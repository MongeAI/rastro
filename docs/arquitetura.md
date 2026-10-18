# Arquitetura

O Rastro é um monorepo npm com pacotes pequenos e independentes. A regra principal: **o grafo é a fonte da verdade**. Analisadores produzem o grafo; a CLI armazena e serve; a interface só lê.

```
            ┌──────────────┐     ┌────────────────┐     ┌──────────────┐
caminho ──▶ │  analyzer    │ ──▶ │  graph         │ ──▶ │  core        │ ──▶ JSON (schema 0.1.0)
            │  (ts-morph)  │     │  GraphBuilder  │     │  modelo +    │
            └──────────────┘     └────────────────┘     │  validação   │
                                                         └──────┬───────┘
                                                                │
                         ┌──────────────────────────────────────┴──────────┐
                         ▼                                                 ▼
                 ┌──────────────┐   /api/graph, /api/source,       ┌──────────────┐
                 │  cli         │   /api/events                    │  web         │
                 │  storage +   │ ───────────────────────────────▶ │  React +     │
                 │  servidor    │   (127.0.0.1, somente leitura)   │  Cytoscape   │
                 └──────────────┘                                  └──────────────┘
```

## Pacotes

| Pacote                | Responsabilidade                                                                                                                                                                                                                                                                                | Depende de                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `@rastro/core`        | Tipos (`GraphNode`, `GraphEdge`, `Evidence`...), ids, rótulos (pt/en), JSON Schemas, `validateGraph` (problemas em pt/en), `parseRules` e os padrões de caminho das regras                                                                                                                      | nada                             |
| `@rastro/graph`       | `GraphBuilder` (deduplicação, evidências, `depends_on`, ciclos via Tarjan iterativo), `GraphIndex` (vizinhança, impacto, busca), `computeView` (o que aparece na tela), exportadores (`toMermaid`, `toDot`, `toGraphML`) e `compareGraphs`, `checkRules`/`suggestRules` (regras de arquitetura) | core                             |
| `@rastro/analyzer`    | Descoberta de arquivos, leitura do tsconfig, resolução de módulos e extração com ts-morph; regras de rotas (Express, Fastify, Hono, NestJS, Next.js)                                                                                                                                            | core, graph, ts-morph, ignore    |
| `rastro` (`apps/cli`) | Comandos, armazenamento no cache do usuário, servidor HTTP local, relatório HTML offline (`report.ts`), servidor MCP (`mcp*.ts`)                                                                                                                                                                | core, graph, analyzer            |
| `@rastro/web`         | Interface; usa `@rastro/graph` diretamente no navegador                                                                                                                                                                                                                                         | core, graph, React, Cytoscape.js |

`core` e `graph` não usam APIs do Node.js, para rodarem no navegador.

## Pipeline do analisador

1. **Descoberta** (`discover.ts`): percorre a pasta sem seguir links simbólicos; aplica exclusões padrão (`node_modules`, `dist`, `build`, `.git`, `.next`, `coverage`...), o `.gitignore` da raiz e padrões `--exclude`; ignora `.d.ts`, `*.min.js` e arquivos acima de 1 MB.
2. **Configuração** (`resolve.ts`): lê `tsconfig.json`/`jsconfig.json` apenas para opções de resolução. Sem configuração, usa `moduleResolution: Bundler` (aceita imports sem extensão, `index`, `.js`→`.ts`). Cada arquivo resolve seus imports com o tsconfig referenciado pela raiz que o inclui ou, senão, com o `tsconfig.json`/`jsconfig.json` mais próximo (subindo as pastas até a raiz, seguindo `extends`; nunca dentro de `node_modules`). A busca é feita uma vez por pasta, com um cache de resolução por configuração. O mesmo `ModuleResolver` é usado pelo programa do TypeScript (`resolutionHost` do ts-morph), então os `paths` de cada subpacote valem também para o verificador de tipos que liga as chamadas.
3. **Passo 1, entidades**: arquivos (agrupados por pasta), funções (declarações, `const f = () => {}`, funções embrulhadas como `memo(...)`), classes e membros, exports CommonJS e rotas HTTP (`routes/`: uma regra por framework, ver abaixo).
4. **Passo 2, relações**: imports (estáticos, reexportações, `require`, `import()`), exports (pelo verificador de tipos, incluindo `module.exports`), chamadas, uso de JSX e herança.
5. **Fechamento** (`GraphBuilder.finalize`): deriva `depends_on` entre pastas, marca ciclos de importação, calcula estatísticas e ordena tudo.

### Sessão de análise

`analyzeProject` faz uma análise do zero. `AnalysisSession` (usada pela CLI) guarda o projeto do ts-morph entre análises: cada `analyze()` refaz a descoberta, compara data e tamanho de cada arquivo com os da leitura anterior e só relê os que mudaram; arquivos removidos ou excluídos saem do compilador. Se as opções do compilador (tsconfig) ou os manifestos de dependências (`package.json`, lockfiles) mudarem, o compilador é recriado. O grafo é sempre montado inteiro de novo, então o resultado é o mesmo de uma análise do zero.

### Rotas HTTP

Cada framework tem uma regra em `packages/analyzer/src/routes/` (`express.ts`, `fastify.ts`, `hono.ts`, `nest.ts`, `next.ts`), com as utilidades comuns em `common.ts`. A regra da casa vale para todas: **uma rota só existe quando o framework é comprovado**. O receptor (`app`, `router`, instância) precisa vir de uma fábrica importada do pacote do framework (`express()`, `fastify()`, `new Hono()`), seguida pelo verificador de tipos através de imports, `require`, `export default` e `module.exports`; decorators do NestJS precisam vir de `@nestjs/common`; as rotas por arquivo do Next.js só valem com `next` declarado no `package.json` do projeto. Imports só de tipo, homônimos de outros pacotes e funções locais com o mesmo nome não contam.

As montagens (`app.use('/api', router)`, `register(plugin, { prefix })`, `app.route('/x', sub)`, `basePath`, `setGlobalPrefix`) formam um pequeno grafo de donos. No fim do passo 1 o caminho completo de cada rota é composto por ele: só um prefixo comprovado vira `meta.fullPath` e o nome da rota; vários prefixos ficam em `meta.mountedAt`, sem escolher um; prefixo não literal deixa o caminho completo desconhecido.

### Como uma chamada é resolvida

Para `alvo()` ou `obj.alvo()`, o Rastro pede ao verificador de tipos o **símbolo** do nome chamado, segue aliases (`import`, `require`, reexportações) e olha as declarações:

| A declaração é...                                         | Resultado                                           |
| --------------------------------------------------------- | --------------------------------------------------- |
| uma função/classe/método registrado no grafo              | relação `calls` **resolvida** (`static-typecheck`)  |
| um método herdado (`this.x()`, `obj.x()`, `super.x()`)    | resolvida, para o método da classe que o declara    |
| um `.d.ts` de pacote do workspace com fonte em `src/`     | relação resolvida com `meta.viaDeclaration`         |
| algo em `node_modules` ou nas libs do TypeScript          | não entra no grafo; conta em `externalCallsSkipped` |
| função declarada dentro de outra função                   | não entra no grafo; conta em `localCalls`           |
| valor produzido por uma chamada externa (ex.: `useState`) | tratado como externo                                |
| parâmetro, propriedade ou interface                       | **não resolvida**, motivo `indirect-call`           |
| membro de interface ou método abstrato                    | não resolvida, com `meta.candidates` (_possíveis_)  |
| inexistente                                               | **não resolvida**, motivo `symbol-not-found`        |

`super(...)` usa a assinatura escolhida pelo verificador de tipos: o construtor da base (ou o herdado de mais acima) ou, sem nenhum construtor declarado, a própria classe base.

Os candidatos de uma chamada por interface vêm de `implementations.ts`: um índice (montado uma vez, a partir das classes do grafo) de tudo o que cada classe declara implementar ou estender, direta ou indiretamente. Para o tipo do receptor, cada classe que o implementa contribui com o membro de mesmo nome (próprio ou herdado), se ele for uma entidade do grafo. Os candidatos ficam no nó não resolvido e nunca viram relações (ver [formato dos dados](formato-dos-dados.md#candidatos-possíveis-chamadas-por-interface)).

`obj.metodo()` sem tipo conhecido e `obj[nome]()` não viram nós: entram em `unknownReceiverCalls` e `computedCalls`, para não poluir o mapa com suposições.

## Servidor local e modo ao vivo

A CLI (`apps/cli/src/server.ts`) serve a interface compilada e três endpoints, todos atrás do token da execução (ver [segurança](seguranca.md)):

| Endpoint      | O que entrega                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/graph`  | O grafo atual em JSON, com a versão no cabeçalho `X-Rastro-Version`                                                                         |
| `/api/source` | O conteúdo de um arquivo JS/TS do grafo, sob demanda                                                                                        |
| `/api/events` | Server-Sent Events: `hello` ao conectar e `graph` a cada grafo novo, ambos com `{"version": n}`; um comentário a cada 25 s mantém a conexão |

A versão começa em 1 e sobe a cada `update()` do servidor. Com `rastro <caminho> --watch`:

1. `watch.ts` observa só as pastas que a descoberta percorreria (`discoverFiles(...).directories`: as mesmas exclusões, `.gitignore` e `--exclude`), com um `fs.watch` não recursivo por pasta. O modo recursivo do Node no Linux percorreria a árvore inteira (inclusive `node_modules` e `.git`) e estouraria o limite de observadores do inotify em projetos grandes. Pastas criadas disparam uma reanálise e passam a ser observadas; depois de cada reanálise o conjunto de pastas é atualizado.
2. Salvamentos em rajada são juntados (300 ms) e só arquivos JS/TS ou de configuração (`package.json`, `tsconfig*.json`, `jsconfig.json`, `.gitignore`) contam.
3. A `AnalysisSession` reanalisa (nunca duas ao mesmo tempo; mudanças durante uma análise disparam outra no fim), o JSON salvo é atualizado e o servidor troca o grafo e avisa os navegadores pelo `/api/events`.
4. A interface busca `/api/graph` de novo e mantém a seleção, comparando a versão do evento com a do cabeçalho para ignorar respostas antigas.

Se observar falhar (por exemplo `ENOSPC` ou `EMFILE`), a CLI avisa e passa a varrer o projeto a cada 1,5 s, comparando data e tamanho dos arquivos relevantes.

## Servidor MCP (`rastro mcp`)

Três módulos em `apps/cli/src/`, sem dependências novas:

1. `mcp.ts` — o protocolo: JSON-RPC 2.0 pelo stdio, uma mensagem por linha (até 1 MB). `initialize` escolhe a era legada (2024-11-05 a 2025-11-25); uma requisição com `_meta["io.modelcontextprotocol/protocolVersion"]` é servida na era sem estado (2026-07-28: `server/discover`, `resultType`, cache da lista de ferramentas). Erros do protocolo viram erros JSON-RPC; argumentos inválidos, nomes não encontrados e falhas da análise viram resultados com `isError`, para o agente corrigir. Requisições canceladas enquanto rodam ficam sem resposta.
2. `mcp-project.ts` — o grafo fresco: a `AnalysisSession` roda numa worker thread que carrega o próprio bundle da CLI (o `index.ts` não roda o `main` dentro dela), então o protocolo responde mesmo durante uma análise longa. O observador do `--watch` (`watch.ts`) só marca o grafo como desatualizado; a próxima chamada reanalisa, e chamadas simultâneas esperam a mesma análise. Antes de decidir que o grafo está em dia, a chamada deixa o laço de eventos girar (o evento de uma edição feita logo antes pode estar na fila; na varredura, compara os arquivos na hora) e, com eventos muito recentes, espera ~100 ms de calma. Cada análise vira um `Snapshot` com o `GraphIndex` e os insights calculados sob demanda.
3. `mcp-tools.ts` — as oito ferramentas, funções puras sobre o `Snapshot` que devolvem Markdown compacto. Reaproveitam `GraphIndex` (busca, vizinhança, `impactOfAll`), `findPaths` e `findPossiblePath`, `computeInsights`, `changesWithImpact`/`routesAndTests` (o mesmo cálculo do `rastro impact`), `collectChanges` e `readSource`. A resolução de nomes aceita id, `arquivo:linha` (também `:linha:coluna` e `:início-fim`), caminho (também o `.js` de um `.ts`), nome qualificado e nome, e devolve os candidatos quando há ambiguidade. A saída é montada em blocos (`Out`): acima de 40 mil caracteres, todas as listas encolhem por igual (itens inteiros, com o `offset` para continuar) em vez de cortar o fim; todo texto do projeto passa por `plain`/`tick`, que escapam quebras de linha e controles.

## Regras de arquitetura (`rastro check`)

- `core/src/rules.ts` confere o `rastro.rules.json` (`parseRules`: campo desconhecido é erro, problemas como códigos traduzíveis) e casa os padrões. Os padrões nunca viram expressões regulares: as chaves são expandidas (até 64 variantes), cada variante vira uma lista de pedaços (`*`, `?`, `**/`, `/**` no fim) e o casamento é por programação dinâmica com memória, em tempo proporcional a padrão × caminho. Um caminho sem curinga vale para o arquivo ou a pasta inteira.
- `graph/src/rules.ts` transforma as relações comprovadas (`imports`, `calls`, `extends`, resolvidas ou para pacotes) em dependências entre arquivos e confere cada regra (`checkRules`). As chamadas não resolvidas com candidatos viram dependências **possíveis** (nunca reprovam). Ciclos: componentes fortemente conexos dos imports (sem os só de tipo) entre os arquivos da regra; o ciclo mostrado é o mais curto e, com mudanças do git, passa pelo import alterado. Com um `ChangeSet`, cada violação ganha `introduced` (alguma evidência numa linha alterada). `suggestRules` (o `--init`) acha a pasta-base das camadas, monta o grafo entre as pastas principais sem os testes e propõe `deny` só onde a direção já é única (A alcança B e B nunca alcança A), mais `noCycles` e "código não depende de testes" quando já valem; tudo é conferido antes de sair.
- `apps/cli/src/check.ts` lê o arquivo com segurança (`readRules`), monta o relatório (texto, Markdown, JSON) e o `--init`. O `rastro impact`, o servidor (o grafo leva `rules`), a aba **Regras** (`RulesPanel`) e a ferramenta `rastro_check` usam o mesmo `checkRules`.

## Interface

- `computeView` (em `@rastro/graph`) decide o que aparece. Há três níveis: **Pastas** (cada pasta recolhida vira um nó, e as relações dos arquivos internos são somadas em uma linha só, com a lista das relações originais em `members`), **Arquivos** e **Símbolos**. Também cuida do foco e da "expansão de conexões". Relações de um grupo para o próprio filho não são desenhadas, o que evita laços.
- O layout padrão é **hierárquico** (ELK _layered_, `lib/elkLayout.ts`), feito de dentro para fora: cada grupo (pasta, arquivo, classe) organiza seus filhos pelas relações entre eles. As relações que atravessam grupos são elevadas até o grupo em comum mais próximo, e componentes sem ligação são empacotados respeitando a proporção da tela. O layout **orgânico** (fcose + layout-utilities) continua disponível.
- `GraphCanvas` sincroniza a visão com o Cytoscape **de forma incremental** (adiciona, move e remove só o que mudou) e anima as posições novas. Os rótulos dos grupos crescem quando o zoom diminui, para o mapa continuar legível de longe.
- O código-fonte é pedido sob demanda a `/api/source`, que só entrega arquivos presentes no grafo.

## Como adicionar uma nova linguagem

1. Crie `packages/analyzer-<linguagem>` que produza nós e relações pelo `GraphBuilder` (mesmos ids e tipos do `@rastro/core`).
2. Registre evidências (arquivo + linha) para toda relação resolvida e use `unresolved` com motivo quando não houver prova.
3. Adicione fixtures e testes; o restante (armazenamento, servidor, interface, exportação) funciona sem mudanças.

O MVP não tem um sistema de plugins de propósito: a interface entre analisador e grafo (`GraphBuilder` + tipos do core) já é o ponto de extensão.
