# Roadmap

O Rastro 0.1 é o núcleo: um grafo confiável e rastreável de projetos JS/TS e uma interface para explorá-lo. As próximas etapas, em ordem aproximada de prioridade:

## 0.2: mais precisão no JS/TS

- [ ] Interface e mensagens da CLI em inglês (i18n), além do português.
- [ ] `tsconfig` por pacote em monorepos (resolver `paths` de cada workspace).
- [ ] Chamadas via `super.metodo()` e métodos herdados.
- [ ] Implementações de interfaces (`implements`) e chamadas por interface com múltiplos candidatos marcados como “possíveis”.
- [ ] Funções aninhadas como nós opcionais.
- [ ] Rotas: Next.js (App/Pages Router), Fastify, Hono e NestJS.
- [ ] Análise incremental com cache (reanalisar só arquivos alterados).
- [ ] Modo `--watch`.

## 0.3: entender mudanças

- [ ] Diff entre dois grafos (o que mudou entre commits/branches).
- [ ] Impacto de um _diff_ do git: quais entidades e rotas são afetadas.
- [ ] Caminhos entre duas entidades (“como A chega em B?”).
- [ ] Métricas: acoplamento entre módulos, arquivos mais centrais, código sem uso aparente.

## Depois

- [ ] Novas linguagens (Python e Go primeiro), com o mesmo modelo de grafo.
- [ ] Exportações extras (GraphML, DOT, Mermaid).
- [ ] Extensão para editores (abrir o mapa a partir do arquivo atual).
- [ ] Assistente opcional que responde perguntas usando o grafo como fonte (sempre opcional, nunca necessário para a análise).

## Fora de escopo por enquanto

Análise dinâmica/instrumentação, execução de agentes, SaaS e contas, colaboração em tempo real e bancos de dados remotos.

## Limitações conhecidas da 0.1

Veja a seção [Limitações conhecidas](README.md#limitações-conhecidas) do README.
