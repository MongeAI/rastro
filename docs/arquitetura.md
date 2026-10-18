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
                 ┌──────────────┐   /api/graph, /api/source        ┌──────────────┐
                 │  cli         │ ───────────────────────────────▶ │  web         │
                 │  storage +   │   (127.0.0.1, somente leitura)   │  React +     │
                 │  servidor    │                                  │  Cytoscape   │
                 └──────────────┘                                  └──────────────┘
```

## Pacotes

| Pacote                | Responsabilidade                                                                                                                                                       | Depende de                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `@rastro/core`        | Tipos (`GraphNode`, `GraphEdge`, `Evidence`...), ids, rótulos em português, JSON Schema, `validateGraph`                                                               | nada                             |
| `@rastro/graph`       | `GraphBuilder` (deduplicação, evidências, `depends_on`, ciclos via Tarjan iterativo), `GraphIndex` (vizinhança, impacto, busca), `computeView` (o que aparece na tela) | core                             |
| `@rastro/analyzer`    | Descoberta de arquivos, leitura do tsconfig, resolução de módulos e extração com ts-morph; regras de rotas (Express, Fastify, Hono, NestJS, Next.js)                   | core, graph, ts-morph, ignore    |
| `rastro` (`apps/cli`) | Comandos, armazenamento no cache do usuário, servidor HTTP local                                                                                                       | core, graph, analyzer            |
| `@rastro/web`         | Interface; usa `@rastro/graph` diretamente no navegador                                                                                                                | core, graph, React, Cytoscape.js |

`core` e `graph` não usam APIs do Node.js, para rodarem no navegador.

## Pipeline do analisador

1. **Descoberta** (`discover.ts`): percorre a pasta sem seguir links simbólicos; aplica exclusões padrão (`node_modules`, `dist`, `build`, `.git`, `.next`, `coverage`...), o `.gitignore` da raiz e padrões `--exclude`; ignora `.d.ts`, `*.min.js` e arquivos acima de 1 MB.
2. **Configuração** (`resolve.ts`): lê `tsconfig.json`/`jsconfig.json` apenas para opções de resolução. Sem configuração, usa `moduleResolution: Bundler` (aceita imports sem extensão, `index`, `.js`→`.ts`).
3. **Passo 1, entidades**: arquivos (agrupados por pasta), funções (declarações, `const f = () => {}`, funções embrulhadas como `memo(...)`), classes e membros, exports CommonJS e rotas HTTP (`routes/`: uma regra por framework, ver abaixo).
4. **Passo 2, relações**: imports (estáticos, reexportações, `require`, `import()`), exports (pelo verificador de tipos, incluindo `module.exports`), chamadas, uso de JSX e herança.
5. **Fechamento** (`GraphBuilder.finalize`): deriva `depends_on` entre pastas, marca ciclos de importação, calcula estatísticas e ordena tudo.

### Rotas HTTP

Cada framework tem uma regra em `packages/analyzer/src/routes/` (`express.ts`, `fastify.ts`, `hono.ts`, `nest.ts`, `next.ts`), com as utilidades comuns em `common.ts`. A regra da casa vale para todas: **uma rota só existe quando o framework é comprovado**. O receptor (`app`, `router`, instância) precisa vir de uma fábrica importada do pacote do framework (`express()`, `fastify()`, `new Hono()`), seguida pelo verificador de tipos através de imports, `require`, `export default` e `module.exports`; decorators do NestJS precisam vir de `@nestjs/common`; as rotas por arquivo do Next.js só valem com `next` declarado no `package.json` do projeto. Imports só de tipo, homônimos de outros pacotes e funções locais com o mesmo nome não contam.

As montagens (`app.use('/api', router)`, `register(plugin, { prefix })`, `app.route('/x', sub)`, `basePath`, `setGlobalPrefix`) formam um pequeno grafo de donos. No fim do passo 1 o caminho completo de cada rota é composto por ele: só um prefixo comprovado vira `meta.fullPath` e o nome da rota; vários prefixos ficam em `meta.mountedAt`, sem escolher um; prefixo não literal deixa o caminho completo desconhecido.

### Como uma chamada é resolvida

Para `alvo()` ou `obj.alvo()`, o Rastro pede ao verificador de tipos o **símbolo** do nome chamado, segue aliases (`import`, `require`, reexportações) e olha as declarações:

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

- `computeView` (em `@rastro/graph`) decide o que aparece. Há três níveis: **Pastas** (cada pasta recolhida vira um nó, e as relações dos arquivos internos são somadas em uma linha só, com a lista das relações originais em `members`), **Arquivos** e **Símbolos**. Também cuida do foco e da "expansão de conexões". Relações de um grupo para o próprio filho não são desenhadas, o que evita laços.
- O layout padrão é **hierárquico** (ELK _layered_, `lib/elkLayout.ts`), feito de dentro para fora: cada grupo (pasta, arquivo, classe) organiza seus filhos pelas relações entre eles. As relações que atravessam grupos são elevadas até o grupo em comum mais próximo, e componentes sem ligação são empacotados respeitando a proporção da tela. O layout **orgânico** (fcose + layout-utilities) continua disponível.
- `GraphCanvas` sincroniza a visão com o Cytoscape **de forma incremental** (adiciona, move e remove só o que mudou) e anima as posições novas. Os rótulos dos grupos crescem quando o zoom diminui, para o mapa continuar legível de longe.
- O código-fonte é pedido sob demanda a `/api/source`, que só entrega arquivos presentes no grafo.

## Como adicionar uma nova linguagem

1. Crie `packages/analyzer-<linguagem>` que produza nós e relações pelo `GraphBuilder` (mesmos ids e tipos do `@rastro/core`).
2. Registre evidências (arquivo + linha) para toda relação resolvida e use `unresolved` com motivo quando não houver prova.
3. Adicione fixtures e testes; o restante (armazenamento, servidor, interface, exportação) funciona sem mudanças.

O MVP não tem um sistema de plugins de propósito: a interface entre analisador e grafo (`GraphBuilder` + tipos do core) já é o ponto de extensão.
