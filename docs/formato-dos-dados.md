# Formato dos dados (schema 0.1.0)

O Rastro exporta um único arquivo JSON com todo o grafo. Ele é:

- **Versionado:** campo `schemaVersion` (hoje `"0.1.0"`).
- **Validável:** JSON Schema em [`packages/core/schema/rastro-graph.schema.json`](../packages/core/schema/rastro-graph.schema.json) (draft 2020-12) e validação de integridade com `rastro validate <arquivo>` (ids únicos, toda relação aponta para nós existentes, localizações coerentes).
- **Determinístico:** nós e relações vêm ordenados por `id`.

## Estrutura geral

```jsonc
{
  "schemaVersion": "0.1.0",
  "generatedAt": "2026-10-17T22:30:00.000Z",
  "tool": { "name": "rastro", "version": "0.1.0" },
  "project": { "name": "ts-basic", "root": "/caminho/absoluto", "languages": ["ts"], "tsconfig": "tsconfig.json" },
  "analyzer": { "name": "@rastro/analyzer (ts-morph)", "version": "0.1.0", "typescriptVersion": "6.0.2", "options": { ... } },
  "nodes": [ /* GraphNode */ ],
  "edges": [ /* GraphEdge */ ],
  "stats": { /* contagens e ciclos */ },
  "diagnostics": [ /* avisos da análise */ ],
  "changes": { /* opcional: mudanças do git (--changes, --since) */ },
  "rules": { /* opcional: regras de arquitetura (rastro.rules.json) */ }
}
```

`rules` existe quando a pasta analisada tem um `rastro.rules.json` (ou foi passado `--rules`): `source` é o caminho do arquivo (relativo à raiz quando está dentro dela), `config` o conteúdo quando é válido e `issues` os problemas (`{ code, params }`, texto em `ruleIssueText`) quando não é. As violações não são gravadas: a interface, o `rastro check`/`impact` e o MCP as calculam do grafo com `checkRules` (o mesmo cálculo em todos). O formato do arquivo de regras está em `schema/rastro-rules.schema.json`.

Caminhos dentro de `nodes`/`edges` são **relativos à raiz** e sempre usam `/`. Linhas e colunas começam em **1**.

`project.tsconfig` lista as configurações usadas na resolução de módulos: a da raiz (com as `references`, entre parênteses) e, em monorepos, os `tsconfig.json`/`jsconfig.json` de subpacotes que resolveram imports (ex.: `tsconfig.json, packages/web/tsconfig.json`). Cada arquivo usa o tsconfig referenciado pela raiz que o inclui ou, senão, o mais próximo subindo as pastas (com `extends`), para imports **e** chamadas.

Com `--changes`/`--since` (e no `rastro impact`), o grafo ganha `changes`: a base comparada (`base`, `baseLabel`), `includesUntracked` e `files`, um item por arquivo alterado com `file`, `status` (`added`/`modified`/`deleted`/`renamed`), `previous` (renomeados), `ranges` (intervalos de linhas alteradas no arquivo atual), `deletionsAt` (linhas logo após trechos só removidos) e `removedNames` (nomes que aparecem nas linhas removidas, fora de chamadas `nome(...)`: pistas de declarações e imports que a mudança tirou; até 500 por arquivo).

## Nós (`nodes`)

| Campo           | Descrição                                                                         |
| --------------- | --------------------------------------------------------------------------------- |
| `id`            | Identificador estável e legível (ver tabela abaixo)                               |
| `kind`          | `module`, `file`, `function`, `class`, `method`, `route`, `package`, `unresolved` |
| `name`          | Nome curto                                                                        |
| `qualifiedName` | Nome qualificado (`UserService.create`, caminho do arquivo, caminho da pasta)     |
| `parent`        | Nó que o contém (pasta → arquivo → classe → método)                               |
| `location`      | `{ file, startLine, startColumn, endLine, endColumn }`                            |
| `meta`          | Informações extras (abaixo)                                                       |

| Tipo         | Formato do `id`                                             | Exemplo                                                  |
| ------------ | ----------------------------------------------------------- | -------------------------------------------------------- |
| `module`     | `module:<pasta>`                                            | `module:src/services` (`module:.` é a raiz)              |
| `file`       | `file:<caminho>`                                            | `file:src/math.ts`                                       |
| `function`   | `fn:<arquivo>#<nome>`                                       | `fn:src/math.ts#sum`                                     |
| `class`      | `class:<arquivo>#<nome>`                                    | `class:src/models/user.ts#User`                          |
| `method`     | `method:<arquivo>#<Classe>.<membro>`                        | `method:src/services/user-service.ts#UserService.create` |
| `route`      | `route:<arquivo>#<receptor> <MÉTODO> <caminho>`             | `route:src/server.js#app GET /users`                     |
| `package`    | `pkg:<nome>`                                                | `pkg:react`, `pkg:node:fs`                               |
| `unresolved` | `unresolved:<arquivo>#<import\|call\|extends>:<referência>` | `unresolved:src/index.ts#import:./missing`               |

Se dois símbolos geram o mesmo id no mesmo arquivo, o segundo recebe o sufixo `~2`, o terceiro `~3` etc. O mesmo vale para chamadas não resolvidas com o mesmo texto e [candidatos](#candidatos-possíveis-chamadas-por-interface) diferentes (`unresolved:src/a.ts#call:repo.save~2`).

`meta` pode conter: `language`, `exported`, `defaultExport`, `async`, `static`, `memberKind` (`method`/`constructor`/`getter`/`setter`/`property`), `lines`, `exportNames`, `exportsIncomplete` (arquivos: a lista `exportNames` pode estar incompleta, porque o arquivo reexporta tudo, com `export *`, de um módulo que a análise não vê, como um pacote não instalado ou um arquivo gerado ignorado, ou exporta de forma dinâmica em CommonJS, como `__exportStar(require(...), exports)`, `Object.assign(module.exports, ...)` ou `exports[nome] = ...`), `commonjs` (arquivos CommonJS: um import default recebe o `module.exports` inteiro), `inCycle`, `analyzed` (`false` para arquivos referenciados mas não analisados, como `.css`), `builtin` e `declared` (pacotes), `outsideRoot`, `httpMethod`/`routePath`/`framework`/`fullPath`/`mountedAt`/`routeKind`/`inlineHandler` (rotas, ver abaixo), `reason`, `reference`, `aliasTargets` (import não resolvido por um alias de `paths`, como `@/lib/x`, ou pelo `baseUrl`: os caminhos do projeto, relativos à raiz e sem extensão, para onde o especificador levaria; nenhum arquivo existe lá), `candidates` (não resolvidos, ver [candidatos possíveis](#candidatos-possíveis-chamadas-por-interface)) e `receiverFile` (chamada `obj.x()` não resolvida em TypeScript: o arquivo que declara o tipo de `obj`, que não tem o membro `x`), `undeclared` (chamada `nome()` não resolvida em TypeScript sem nenhum valor com esse nome no escopo: nem declarado, nem importado, nem global), `implements` (classes: a cláusula `implements` como escrita no código, ex.: `["Store", "Named"]`), `abstractMembers` (classes: métodos abstratos, sem corpo, como escritos no código; não viram nós) e `mentions` (funções, classes e métodos).

### Rotas

O `id` de uma rota usa o **caminho local** (como escrito no código), o que o mantém estável mesmo quando a montagem muda em outro arquivo. O receptor depende do framework:

| Framework (`meta.framework`) | Receptor no `id`                               | Caminho no `id`                        | Exemplo                                                              |
| ---------------------------- | ---------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| `express`                    | variável do app/roteador                       | o do `app.get(...)`                    | `route:src/routes/users.js#router GET /:id`                          |
| `fastify`                    | variável da instância (ou parâmetro do plugin) | o do `app.get(...)` / `route({ url })` | `route:src/routes/users.ts#fastify GET /`                            |
| `hono`                       | variável do app                                | o do `app.get(...)`                    | `route:src/users.ts#users GET /:id`                                  |
| `nestjs`                     | nome da classe do controller                   | `@Controller` + decorator do método    | `route:src/users/users.controller.ts#UsersController GET /users/:id` |
| `next`                       | `next`                                         | derivado da pasta                      | `route:app/blog/[slug]/page.tsx#next GET /blog/:slug`                |

Metadados das rotas:

- `httpMethod`: `GET`, `POST`... (`ALL` para `app.all`, `@All()` e rotas de API do Pages Router).
- `routePath`: o caminho local. No Next.js, `[id]` vira `:id`, `[...slug]` vira `*slug`, `[[...slug]]` vira `*slug?` e grupos `(x)` somem.
- `fullPath`: o caminho completo, com os prefixos de montagem (`app.use('/api', router)`, `register(plugin, { prefix })`, `app.route('/x', sub)`, `basePath`, `setGlobalPrefix` do NestJS). Só existe quando há **um único** prefixo comprovado; nesse caso o `name` do nó também mostra o caminho completo (`GET /api/users/:id`). Casos em que ele fica de fora (a rota existe, com o `routePath` como escrito):
  - NestJS: o projeto usa `RouterModule.register`, `enableVersioning` ou `@Version` (o caminho depende de configuração fora do controller); o controller tem `version`; ou existe um `setGlobalPrefix` que não dá para comprovar como do app do controller (outro pacote do monorepo, como uma biblioteca em `libs/`, ou um app criado por outra função).
  - Next.js: o `next.config` menciona `basePath`.
  - Hono: `basePath` não é montagem: o app derivado divide as rotas com o de origem e o prefixo entra depois de onde ele é montado (`root.route('/v1', new Hono().basePath('/api'))` → `/v1/api/...`).
- `mountedAt`: os prefixos completos onde o roteador foi montado. Com mais de um, o `fullPath` fica de fora e o `name` mostra o caminho local.
- `routeKind` (Next.js): `page` (página, `GET`) ou `api` (rota de API).

No Next.js, `app/` e `pages/` valem na raiz do projeto; `src/app` e `src/pages` só quando nenhuma das duas existe na raiz (como no próprio Next). `pageExtensions` do `next.config` é respeitado quando é uma lista de textos literais (`['page.tsx', 'api.ts']` faz de `index.page.tsx` a página `/` e ignora `Button.tsx`); escrito de outro jeito (variável, condição, espalhamento), nenhuma rota do Next.js é afirmada e um diagnóstico `next-routes-skipped` explica o motivo. O `next.config` é só lido como texto, nunca executado.

A rota é ligada ao handler por uma relação `calls` com `callKind: "route-handler"` e `discovery: "framework-rule"`: a função referenciada, o método do controller (NestJS) ou a função exportada (Next.js). Chamadas feitas dentro de um handler inline são atribuídas à própria rota, que fica com `meta.inlineHandler: true`.

Motivos de `unresolved` (`meta.reason`):

| Motivo               | Significado                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `module-not-found`   | Import relativo/absoluto para um arquivo que não existe                                                       |
| `undeclared-package` | Especificador de pacote que não está no `package.json` nem em `node_modules` (ou alias não resolvido)         |
| `symbol-not-found`   | Nome chamado que não tem declaração conhecida                                                                 |
| `indirect-call`      | Chamada via parâmetro, propriedade ou interface: o alvo só existe em execução                                 |
| `dynamic-import`     | `require(variavel)` / `import(variavel)`                                                                      |
| `unknown-base-class` | Classe base não localizada                                                                                    |
| `not-analyzed`       | O alvo existe, mas em um arquivo do projeto que ficou fora da análise (excluído, `.gitignore`, grande demais) |

### Candidatos possíveis (chamadas por interface)

Em `repo.save()` com `repo: Repository` (uma interface) ou `animal.sound()` com `sound` abstrato, o verificador de tipos aponta para uma assinatura sem corpo: o alvo real depende do objeto recebido em execução. A chamada continua **não resolvida** (`indirect-call`), mas o nó não resolvido ganha `meta.candidates`: os ids dos métodos (ou funções) do projeto que _podem_ atender a chamada. O mesmo vale para outros casos em que o alvo só se decide em execução (ver as regras abaixo).

```jsonc
{
  "id": "unresolved:src/main.ts#call:repo.save",
  "kind": "unresolved",
  "meta": {
    "reason": "indirect-call",
    "reference": "repo.save",
    "candidates": [
      "method:src/repo.ts#MemoryRepository.save",
      "method:src/repo.ts#SqlRepository.save",
    ],
  },
}
```

Regras:

- Os candidatos são **de cada chamada**: `repo.save()` com `repo: UserRepo` e `repo.save()` com `repo: OrderRepo` no mesmo arquivo viram dois nós (`...#call:repo.save` e `...#call:repo.save~2`), cada um com as implementações da própria interface. Assim, quem chama uma interface nunca aparece como possível chamador das implementações da outra.
- Receptor de tipo união (ou interseção) cujo método tem mais de uma declaração no projeto (`r: Foo | Bar`, `r: UserRepo | SqlOrderRepo`): em execução só uma delas atende a chamada, e qual depende do objeto recebido. Nenhuma parte é resolvida: a chamada fica **não resolvida** (`indirect-call`) e os candidatos são os métodos das classes da união (`Foo.save`, `Bar.save`) mais as implementações das interfaces dela. Uma união com uma só declaração no projeto (`r?: Foo`, `r: Foo | null`, `r: Foo | SubFoo` sem `save` próprio em `SubFoo`) continua resolvida.
- `module.exports` (ou `exports.x`) atribuído em mais de um lugar (`if (prod) module.exports = require('./a'); else module.exports = require('./b')`): quem chama o valor exportado fica **não resolvido** (`indirect-call`), com os alvos de cada atribuição como candidatos. As relações `exports` do arquivo continuam, uma por atribuição, cada uma com a evidência da própria linha.
- Só entram classes que **declaram** a relação: `implements` da interface (diretamente, por uma interface que a estende ou por uma classe base que a implementa) ou `extends` da classe abstrata. Classes que só têm "o mesmo formato" (tipagem estrutural) e objetos literais não entram.
- Vale o tipo do receptor: com `store: Store` (que estende `Repository`), uma classe que só implementa `Repository` não é candidata. Interfaces, aliases de tipo (`implements Clock` com `type Clock = {...}`) e classes abstratas são aceitos; o método pode ser próprio ou herdado de uma classe base.
- Os candidatos **nunca** viram relações: não há `calls` resolvido para eles, então caminhos, impacto e as medidas dos insights continuam só com o que é comprovado. A única exceção conservadora: um método que é candidato não é apontado como "possivelmente sem uso".
- No máximo 50 candidatos por nó, ordenados por id. Ao filtrar por pasta (`rastro export --folder`), candidatos de fora somem junto com os nós deles.
- Interfaces de pacotes externos (ex.: tipos de um framework em `node_modules`) continuam como chamadas externas, sem candidatos.

Por que não uma relação "possível"? Uma relação com destino em um método exigiria um novo valor de `resolution` (ou uma relação `unresolved` apontando para um nó que não é `unresolved`), o que quebraria leitores do schema 0.1.0 e a regra de que toda relação desenhada é comprovada. Guardar os candidatos no nó não resolvido é aditivo e mantém a honestidade: a interface mostra a lista como "Implementações possíveis", com a etiqueta _possível_, e no método mostra "Possivelmente chamado por", sempre separado das relações comprovadas.

## Relações (`edges`)

| Campo        | Descrição                                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | `<kind>:<source>-><target>`                                                                                                                                                                     |
| `kind`       | `contains`, `imports`, `exports`, `calls`, `extends`, `depends_on`                                                                                                                              |
| `source`     | Id do nó de origem                                                                                                                                                                              |
| `target`     | Id do nó de destino                                                                                                                                                                             |
| `resolution` | `resolved` (no projeto), `external` (pacote/Node.js), `unresolved`                                                                                                                              |
| `discovery`  | `static-ast` (sintaxe), `static-typecheck` (verificador de tipos), `derived` (calculada), `framework-rule` (regra de framework: rotas do Express, Fastify, Hono, NestJS e Next.js)              |
| `evidence`   | Até 20 ocorrências `{ file, line, column, snippet }`; o total fica em `meta.count`                                                                                                              |
| `meta`       | `specifier`, `typeOnly`, `importKind` (`static`/`dynamic`/`require`/`re-export`), `names`, `callKind` (`call`/`new`/`jsx`/`route-handler`), `reexport`, `exportedAs`, `viaDeclaration`, `count` |

Linhas e colunas (das evidências e das `location` dos nós) começam em 1 e só contam `\n` (ou `\r\n`) como quebra de linha, como o git e os editores: U+2028/U+2029 dentro de um texto não mudam a numeração.

Semântica de cada tipo:

- `contains`: hierarquia (pasta → pasta, pasta → arquivo, arquivo → função/classe/rota, classe → método).
- `imports`: arquivo → arquivo, pacote ou nó não resolvido. Uma relação por par; vários imports do mesmo destino viram evidências.
- `exports`: arquivo → entidade exportada (inclui reexportações, com `meta.reexport`).
- `calls`: entidade (ou arquivo, para código no topo do módulo) → função, método ou classe (`new`). Uso de componente JSX tem `callKind: "jsx"`; o handler de uma rota tem `callKind: "route-handler"`. `super.metodo()` e métodos herdados (`this.herdado()`, `obj.herdado()`) apontam para o método da classe que o declara. `super(...)` aponta para o construtor da classe base (ou para o herdado de mais acima, quando a base não declara um); se nenhuma classe da cadeia declara construtor, aponta para a própria classe base, como `new Base()`. Uma base externa (ex.: `extends Error`) conta em `externalCallsSkipped`.
- `extends`: classe → classe base.
- `depends_on`: pasta → pasta, derivada dos imports resolvidos entre arquivos de pastas diferentes.

`meta.viaDeclaration: true` indica que a ligação passou por um `.d.ts` compilado de um pacote do workspace (ex.: `packages/x/dist/index.d.ts`) e foi mapeada para o fonte correspondente (`packages/x/src/index.ts`).

## Estatísticas (`stats`)

`files`, `nodesByKind`, `edgesByKind`, `edgesByResolution`, `importCycles` (listas de ids de arquivo; imports só de tipo não formam ciclo, pois somem na execução), `durationMs` e contadores do que ficou **fora do grafo por cautela**:

- `externalCallsSkipped`: chamadas para bibliotecas e APIs nativas (ex.: `console.log`, `array.map`).
- `unknownReceiverCalls`: `obj.metodo()` em que o tipo de `obj` é desconhecido.
- `computedCalls`: `obj[nome]()`.
- `localCalls`: chamadas a funções declaradas dentro de outras funções.

## Diagnósticos (`diagnostics`)

`{ level: "info" | "warning" | "error", code, message, file?, line?, params? }`. `message` é o texto em português (mantido por compatibilidade); `params` traz as partes variáveis, para montar o texto em outro idioma com `diagnosticText(d, 'en' | 'pt')` de `@rastro/core` (códigos desconhecidos ou sem os `params` necessários usam `message`).

| Código                 | Quando                                                                                  | `params`                                                              |
| ---------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `symlink-skipped`      | link simbólico ignorado                                                                 | —                                                                     |
| `file-too-large`       | arquivo maior que o limite                                                              | `limitKb`                                                             |
| `max-files-reached`    | limite de arquivos atingido                                                             | `limit`                                                               |
| `unreadable-directory` | pasta sem permissão de leitura                                                          | `error` (código do sistema, ex.: `EACCES`)                            |
| `invalid-config`       | tsconfig/jsconfig inválido                                                              | `config`, `error`                                                     |
| `syntax-error`         | erro de sintaxe (até 50 por análise)                                                    | `error` (texto do TypeScript)                                         |
| `parse-failed`         | arquivo que não pôde ser lido ou interpretado (inclusive nomes com `\`)                 | `reason` (`too-deep`, `no-permission`, `backslash-name`) ou `error`   |
| `analysis-failed`      | uma etapa falhou em um arquivo (ex.: aninhamento extremo); o resto da análise continua  | `step` (`entities`, `calls`, `routes-nestjs`...), `reason` ou `error` |
| `no-source-files`      | nenhum arquivo JS/TS encontrado                                                         | —                                                                     |
| `next-routes-skipped`  | `next.config` define `pageExtensions` de um jeito que só seria conhecido executando-o   | `config`, `option`                                                    |
| `folder-filter`        | grafo exportado com `--folder` (os contadores de chamadas continuam do projeto inteiro) | `folder`                                                              |

Caminhos dentro de `error` são relativos à raiz analisada (a pasta do usuário não aparece).

## Exportação para outros formatos

`rastro export` converte o grafo (ou a parte que aparece em um nível da interface) para outros formatos. A conversão fica em `@rastro/graph` (`toMermaid`, `toDot`, `toGraphML`), sem APIs do Node, e usa o mesmo `computeView` da interface: no nível `modules` as pastas ficam recolhidas e as relações entre elas são somadas.

- `json`: o próprio grafo deste documento. Com `--folder`, só os nós da pasta (e as pastas acima dela, como moldura), as relações entre eles e os pacotes externos usados de dentro dela; as contagens de `stats` são recalculadas e um diagnóstico `folder-filter` avisa que os contadores de chamadas fora do grafo continuam valendo para o projeto inteiro.
- `graphml`: lista plana de nós e relações, com os atributos `label`, `kind`, `parent`, `file`, `line`, `inCycle`, `fileCount` (nós) e `kind`, `resolution`, `count`, `aggregated`, `typeOnly`, `file`, `line` (relações; arquivo e linha da primeira evidência). Relações somadas têm id `agg:<tipo>:<origem>-><destino>`.
- `mermaid` e `dot`: diagramas para leitura, com ids próprios do formato (o id original fica no `tooltip` do DOT).
- `html`: a interface completa num arquivo só, com o grafo em `<script id="rastro-graph" type="application/json">` (com `<`, `>` e `&` escapados como `\u003c`...).

`rastro compare a.json b.json --json` produz a diferença entre duas análises (`compareGraphs` em `@rastro/graph`): `nodes.added`/`nodes.removed`, `edges.added`/`edges.removed`/`edges.resolutionChanged` (sem as relações `contains`, que só repetem os nós), `cycles.added`/`cycles.removed` e `stats` (`before`, `after`, `delta` de arquivos, funções, classes, métodos, rotas, pacotes, relações não resolvidas, ciclos, nós e relações). Tudo é comparado pelo `id`.

## Exemplo

[`docs/examples/ts-basic.graph.json`](examples/ts-basic.graph.json) é o grafo do fixture `fixtures/ts-basic` (com `project.root` substituído por um caminho genérico).
