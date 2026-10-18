# Roadmap

A 0.1 trouxe o núcleo: um grafo confiável e rastreável de projetos JS/TS e uma interface para explorá-lo. A 0.2 passou a responder o que importa: o que uma mudança afeta, como uma parte chega em outra e por onde começar. As próximas etapas, em ordem aproximada de prioridade:

## Entregue na 0.2

- [x] Interface e mensagens da CLI em inglês e português.
- [x] `tsconfig` por pacote em monorepos (os `paths` de cada workspace).
- [x] Chamadas via `super(...)`, métodos herdados e receptores de tipo união.
- [x] Chamadas por interface com implementações marcadas como “possíveis”.
- [x] Rotas: Next.js (App/Pages Router), Fastify, Hono e NestJS.
- [x] Modo `--watch`, com o compilador reaproveitado entre reanálises.
- [x] Diff entre dois grafos (`rastro compare`).
- [x] Impacto de um _diff_ do git: entidades, rotas e testes afetados (`--changes`, `--since`).
- [x] Caminhos entre duas entidades (“como A chega em B?”).
- [x] Insights: acoplamento entre pastas, arquivos centrais, código possivelmente sem uso.
- [x] Exportações Mermaid, DOT, GraphML e relatório HTML offline.

## 0.3: mais fundo no JS/TS e nas mudanças

- [ ] Cache das relações por arquivo, para reanalisar só o que foi afetado em projetos muito grandes.
- [ ] Funções aninhadas como nós opcionais.
- [ ] Métodos sobrescritos como candidatos possíveis de chamadas na classe base.
- [ ] Middleware do Next.js, `fastify-plugin`/autoload e roteadores passados como parâmetro.
- [ ] Comentário automático em pull requests (GitHub Action) com o impacto e o relatório HTML.

## Depois

- [ ] Novas linguagens (Python e Go primeiro), com o mesmo modelo de grafo.
- [ ] Extensão para editores (abrir o mapa a partir do arquivo atual).
- [ ] Assistente opcional que responde perguntas usando o grafo como fonte (sempre opcional, nunca necessário para a análise).

## Fora de escopo por enquanto

Análise dinâmica/instrumentação, execução de agentes, SaaS e contas, colaboração em tempo real e bancos de dados remotos.

## Limitações conhecidas

Veja a seção [Limitações conhecidas](README.pt-BR.md#limitações-conhecidas) do README.
