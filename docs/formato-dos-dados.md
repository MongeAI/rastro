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
  "diagnostics": [ /* avisos da análise */ ]
}
```

Caminhos dentro de `nodes`/`edges` são **relativos à raiz** e sempre usam `/`. Linhas e colunas começam em **1**.

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

Se dois símbolos geram o mesmo id no mesmo arquivo, o segundo recebe o sufixo `~2`, o terceiro `~3` etc.

`meta` pode conter: `language`, `exported`, `defaultExport`, `async`, `static`, `memberKind` (`method`/`constructor`/`getter`/`setter`/`property`), `lines`, `exportNames`, `inCycle`, `analyzed` (`false` para arquivos referenciados mas não analisados, como `.css`), `builtin` e `declared` (pacotes), `outsideRoot`, `httpMethod`/`routePath`/`framework` (rotas), `reason` e `reference` (não resolvidos).

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

## Relações (`edges`)

| Campo        | Descrição                                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | `<kind>:<source>-><target>`                                                                                                                                                                     |
| `kind`       | `contains`, `imports`, `exports`, `calls`, `extends`, `depends_on`                                                                                                                              |
| `source`     | Id do nó de origem                                                                                                                                                                              |
| `target`     | Id do nó de destino                                                                                                                                                                             |
| `resolution` | `resolved` (no projeto), `external` (pacote/Node.js), `unresolved`                                                                                                                              |
| `discovery`  | `static-ast` (sintaxe), `static-typecheck` (verificador de tipos), `derived` (calculada), `framework-rule` (regra do Express)                                                                   |
| `evidence`   | Até 20 ocorrências `{ file, line, column, snippet }`; o total fica em `meta.count`                                                                                                              |
| `meta`       | `specifier`, `typeOnly`, `importKind` (`static`/`dynamic`/`require`/`re-export`), `names`, `callKind` (`call`/`new`/`jsx`/`route-handler`), `reexport`, `exportedAs`, `viaDeclaration`, `count` |

Semântica de cada tipo:

- `contains`: hierarquia (pasta → pasta, pasta → arquivo, arquivo → função/classe/rota, classe → método).
- `imports`: arquivo → arquivo, pacote ou nó não resolvido. Uma relação por par; vários imports do mesmo destino viram evidências.
- `exports`: arquivo → entidade exportada (inclui reexportações, com `meta.reexport`).
- `calls`: entidade (ou arquivo, para código no topo do módulo) → função, método ou classe (`new`). Uso de componente JSX tem `callKind: "jsx"`; o handler de uma rota tem `callKind: "route-handler"`.
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

`{ level: "info" | "warning" | "error", code, message, file?, line? }`. Códigos atuais: `symlink-skipped`, `file-too-large`, `max-files-reached`, `unreadable-directory`, `invalid-config`, `syntax-error`, `no-source-files`, `analysis-failed` (uma etapa falhou em um arquivo, por exemplo por aninhamento extremo; o resto da análise continua).

## Exemplo

[`docs/examples/ts-basic.graph.json`](examples/ts-basic.graph.json) é o grafo do fixture `fixtures/ts-basic` (com `project.root` substituído por um caminho genérico).
