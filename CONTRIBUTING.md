# Contribuindo com o Teia

Obrigado pelo interesse! O Teia está em fase inicial e contribuições são bem-vindas: correções, novos casos de teste, melhorias na interface e, principalmente, exemplos de código que o analisador entende errado.

## Preparando o ambiente

```bash
npm install
npm run build
npm test
```

Requer Node.js 22.12+. O `npm test` roda os testes do analisador, do grafo, do modelo e da CLI (incluindo o servidor local).

## Como o projeto é organizado

- `packages/core`: tipos do grafo, JSON Schema (`schema/teia-graph.schema.json`) e validação. **Mudou o formato? Atualize o schema, a validação, `docs/formato-dos-dados.md` e incremente `SCHEMA_VERSION`.**
- `packages/graph`: código sem dependência de Node.js (é usado também pela interface): `GraphBuilder`, ciclos, consultas e cálculo da visão.
- `packages/analyzer`: análise JS/TS com ts-morph. Novos analisadores (outras linguagens) devem produzir nós e relações pelo `GraphBuilder`.
- `apps/cli`: comandos, armazenamento e servidor.
- `apps/web`: interface React + Cytoscape.js.

Mais em [docs/arquitetura.md](docs/arquitetura.md).

## Regras de ouro

1. **Nunca invente conexões.** Se o analisador não consegue provar uma relação, ela deve ficar como `unresolved` (com motivo) ou entrar só nas contagens. Toda relação resolvida precisa de evidência (arquivo + linha).
2. **Nunca execute o código analisado.** Nada de `require`/`import` de arquivos do projeto-alvo, nada de rodar scripts.
3. **Determinismo.** A mesma entrada deve gerar o mesmo grafo (exceto `generatedAt` e `durationMs`).
4. **Teste com fixtures.** Para um caso novo, crie (ou estenda) um projeto em `fixtures/` e um teste em `packages/analyzer/test/`.

## Antes de abrir um pull request

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
```

Mensagens de commit curtas e no imperativo (ex.: "Resolve chamadas via super"). Descreva no PR o que muda no grafo gerado, se mudar.

## Reportando um problema de análise

Inclua, se possível, um trecho mínimo de código que reproduz o problema, o que o Teia mostrou e o que você esperava. Não compartilhe código privado que você não pode divulgar.
