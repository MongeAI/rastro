# Arquitetura

O Teia é um monorepo npm com pacotes pequenos e independentes. A regra principal: **o grafo é a fonte da verdade**. Analisadores produzem o grafo; a CLI armazena e serve; a interface só lê.

```
            ┌──────────────┐     ┌────────────────┐     ┌──────────────┐
caminho ──▶ │  analyzer    │ ──▶ │  graph         │ ──▶ │  core        │ ──▶ JSON (schema 0.1.0)
            │  (ts-morph)  │     │  GraphBuilder  │     │  modelo +    │
            └──────────────┘     └────────────────┘     │  validação   │
                                                         └──────┬───────┘
                                                                │
                         ┌──────────────────────────────────────┴──────────┐
                         ▼                                                 ▼
                 ┌──────────────┐   /api/graph, /api/source        ┌──────────────┐
                 │  cli         │ ───────────────────────────────▶ │  web         │
                 │  storage +   │   (127.0.0.1, somente leitura)   │  React +     │
                 │  servidor    │                                  │  Cytoscape   │
                 └──────────────┘                                  └──────────────┘
```

## Pacotes

| Pacote              | Responsabilidade                                                                                                                                                       | Depende de                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `@teia/core`        | Tipos (`GraphNode`, `GraphEdge`, `Evidence`...), ids, rótulos em português, JSON Schema, `validateGraph`                                                               | nada                             |
| `@teia/graph`       | `GraphBuilder` (deduplicação, evidências, `depends_on`, ciclos via Tarjan iterativo), `GraphIndex` (vizinhança, impacto, busca), `computeView` (o que aparece na tela) | core                             |
| `@teia/analyzer`    | Descoberta de arquivos, leitura do tsconfig, resolução de módulos e extração com ts-morph; regra de rotas do Express                                                   | core, graph, ts-morph, ignore    |
| `teia` (`apps/cli`) | Comandos, armazenamento no cache do usuário, servidor HTTP local                                                                                                       | core, graph, analyzer            |
| `@teia/web`         | Interface; usa `@teia/graph` diretamente no navegador                                                                                                                  | core, graph, React, Cytoscape.js |

`core` e `graph` não usam APIs do Node.js, para rodarem no navegador.

## Pipeline do analisador

1. **Descoberta** (`discover.ts`): percorre a pasta sem seguir links simbólicos; aplica exclusões padrão (`node_modules`, `dist`, `build`, `.git`, `.next`, `coverage`...), o `.gitignore` da raiz e padrões `--exclude`; ignora `.d.ts`, `*.min.js` e arquivos acima de 1 MB.
2. **Configuração** (`resolve.ts`): lê `tsconfig.json`/`jsconfig.json` apenas para opções de resolução. Sem configuração, usa `moduleResolution: Bundler` (aceita imports sem extensão, `index`, `.js`→`.ts`).
3. **Passo 1, entidades**: arquivos (agrupados por pasta), funções (declarações, `const f = () => {}`, funções embrulhadas como `memo(...)`), classes e membros, exports CommonJS, rotas do Express.
4. **Passo 2, relações**: imports (estáticos, reexportações, `require`, `import()`), exports (pelo verificador de tipos, incluindo `module.exports`), chamadas, uso de JSX e herança.
5. **Fechamento** (`GraphBuilder.finalize`): deriva `depends_on` entre pastas, marca ciclos de importação, calcula estatísticas e ordena tudo.

### Como uma chamada é resolvida

Para `alvo()` ou `obj.alvo()`, o Teia pede ao verificador de tipos o **símbolo** do nome chamado, segue aliases (`import`, `require`, reexportações) e olha as declarações:

| A declaração é...                                         | Resultado                                           |
| --------------------------------------------------------- | --------------------------------------------------- |
| uma função/classe/método registrado no grafo              | relação `calls` **resolvida** (`static-typecheck`)  |
| um `.d.ts` de pacote do workspace com fonte em `src/`     | relação resolvida com `meta.viaDeclaration`         |
| algo em `node_modules` ou nas libs do TypeScript          | não entra no grafo; conta em `externalCallsSkipped` |
| função declarada dentro de outra função                   | não entra no grafo; conta em `localCalls`           |
| valor produzido por uma chamada externa (ex.: `useState`) | tratado como externo                                |
| parâmetro, propriedade ou interface                       | **não resolvida**, motivo `indirect-call`           |
| inexistente                                               | **não resolvida**, motivo `symbol-not-found`        |

`obj.metodo()` sem tipo conhecido e `obj[nome]()` não viram nós: entram em `unknownReceiverCalls` e `computedCalls`, para não poluir o mapa com suposições.

## Interface

- `computeView` (em `@teia/graph`) decide o que aparece: por padrão, pastas e arquivos; símbolos só quando o arquivo é expandido, no modo “Símbolos”, no foco ou via “expandir conexões”. Pastas e arquivos viram grupos (_compound nodes_).
- `GraphCanvas` sincroniza a visão com o Cytoscape **de forma incremental** (adiciona, move e remove só o que mudou) e roda o layout fcose a partir das posições atuais, para o mapa não “pular” a cada interação.
- O código-fonte é pedido sob demanda a `/api/source`, que só entrega arquivos presentes no grafo.

## Como adicionar uma nova linguagem

1. Crie `packages/analyzer-<linguagem>` que produza nós e relações pelo `GraphBuilder` (mesmos ids e tipos do `@teia/core`).
2. Registre evidências (arquivo + linha) para toda relação resolvida e use `unresolved` com motivo quando não houver prova.
3. Adicione fixtures e testes; o restante (armazenamento, servidor, interface, exportação) funciona sem mudanças.

O MVP não tem um sistema de plugins de propósito: a interface entre analisador e grafo (`GraphBuilder` + tipos do core) já é o ponto de extensão.
