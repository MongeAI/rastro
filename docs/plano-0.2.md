# Plano da versão 0.2.0

> Branch de desenvolvimento: `next`. O `main` continua igual à versão publicada (0.1.1) até o lançamento.
> Regra da casa: cada atualização precisa ser **marcante**, não só "mais coisas". Nada é lançado sem testes, revisão de código e verificação no navegador.

## Tema: do "mapa" para o "copiloto de leitura de código"

A 0.1 mostra **o que existe**. A 0.2 responde **o que importa**: o que mudou, o que é perigoso, por onde a informação passa e onde estão os problemas, em qualquer idioma.

## Funcionalidades

Legenda: ⬜ a fazer · 🟨 em andamento · ✅ pronto e testado

### 1. Mundo: interface em inglês e português

- ✅ i18n completo da interface (EN/PT), escolhido automaticamente pelo idioma do navegador, com seletor manual salvo.
- ✅ Mensagens da CLI em EN/PT: `--lang`, depois `RASTRO_LANG`, depois `LC_ALL`/`LC_MESSAGES`/`LANG` (padrão inglês); progresso do analisador por código, exportadores e `compare` também traduzidos.
- ✅ Textos de motivos ("não resolvido porque…") e legendas traduzidos.

### 2. Mudanças e impacto (git): "o que este PR afeta?"

- ✅ `rastro --changes` (desde o último commit) e `rastro --since <ref>` (desde que a branch saiu de `<ref>`): lê `git diff` (só leitura, sem executar o projeto) e marca **arquivos e funções alterados** pelas linhas modificadas.
- ✅ Modo **Mudanças** na interface: o que mudou em destaque e o **raio de impacto** (quem depende do que mudou, por distância).
- ✅ Resumo "este conjunto de mudanças afeta N funções, M rotas HTTP, K arquivos de teste".

### 3. Insights: onde olhar primeiro

- ✅ Painel **Insights**: pontos críticos (mais chamados / mais dependências, fan-in e fan-out), arquivos maiores, ciclos, módulos mais acoplados.
- ✅ **Código possivelmente sem uso**: exports nunca importados e funções nunca chamadas (com o aviso honesto de que chamadas dinâmicas podem existir).
- ✅ Cada insight é clicável e leva ao mapa.

### 4. Caminhos: "como A chega em B?"

- ✅ Seleção de origem e destino e o **menor caminho** pelas chamadas, imports e herança, desenhado no mapa com as evidências de cada passo.
- ✅ Lista dos caminhos alternativos (até N).
- ✅ Visão "só o caminho": o mapa mostra apenas os passos da opção escolhida (e as pastas/arquivos que os contêm), legível mesmo quando os passos estão em pastas distantes; uma caixa volta ao mapa inteiro.

### 5. Ao vivo: modo `--watch`

- ✅ `rastro --watch`: reanálise ao salvar arquivos, com o mapa atualizado na hora pelo servidor local (SSE), sem perder a posição nem a seleção.
- ✅ Reanálise rápida no `--watch`: a sessão do analisador (`AnalysisSession`) mantém o compilador em memória e só relê os arquivos alterados; as relações são sempre recalculadas (um teste garante que o grafo é idêntico ao de uma análise nova após editar, criar, apagar, quebrar a sintaxe e mudar o tsconfig). Junto, a extração ficou ~37% mais rápida (uma passada só por arquivo direto no compilador, sem criar objetos do ts-morph para todos os nós; grafos conferidos byte a byte iguais). 5 000 arquivos: análise 6,0 s → 3,3 s; reanálise no `--watch` 6,1 s → 2,5 s.
  - Cache por arquivo das relações (pular a resolução de arquivos não afetados) ficou para depois: candidatos por interface, rotas e menções dependem do projeto inteiro, e um cache errado mostraria relações desatualizadas.

### 6. Mais frameworks de rotas

- ✅ Next.js (App Router e Pages Router, inclusive rotas de API).
- ✅ Fastify, Hono e NestJS (`@Controller` / `@Get`…).
- ✅ Rotas do Express montadas com prefixo (`app.use('/api', router)`), com o caminho completo.

### 7. Compartilhar e integrar

- ✅ `rastro export --format mermaid|dot|graphml|json` (filtros por nível/pasta).
- ✅ **Relatório HTML único e offline** (`rastro export --format html`): o mapa navegável num arquivo só, para mandar ao time ou anexar a um PR. Com `--changes`/`--since main` o relatório leva a aba Mudanças (impacto da PR, offline).
- ✅ `rastro compare a.json b.json`: o que entrou e saiu entre duas análises.

### 8. Navegação de outro nível

- ✅ **Paleta de comandos** (<kbd>Ctrl</kbd>+<kbd>K</kbd>): entidades e ~30 ações contextuais (nível, foco, caminho, exportar, tema, idioma…), busca sem acento e por iniciais, `>` para só ações, recentes com a busca vazia.
- ✅ Minimapa clicável/arrastável (tecla <kbd>M</kbd>, preferência salva) e navegação por teclado: setas vão ao nó mais próximo naquela direção, <kbd>Enter</kbd> abre/recolhe, <kbd>Alt</kbd>+<kbd>↑</kbd> sobe, <kbd>Backspace</kbd> volta, <kbd>?</kbd> lista os atalhos.
- ✅ Breadcrumb pasta › arquivo › classe › método no painel de detalhes, cada parte clicável.

### 9. Precisão do analisador

- ✅ `super.metodo()` e métodos herdados; `implements` e chamadas por interface com candidatos marcados como _possíveis_ (nunca como resolvidas). `super(...)` liga ao construtor da base; a chamada por interface/método abstrato continua não resolvida, com as implementações declaradas em `meta.candidates` do nó (sem relação), mostradas na interface como "possível" (`implementations.ts`, fixture `oop`).
- ✅ `paths` por subpacote em monorepos: cada arquivo usa o tsconfig mais próximo (com `extends`, cache por pasta), nos imports e no verificador de tipos (`resolutionHost`), então as chamadas por alias também são ligadas (fixture `monorepo-paths`).

### 10. Qualidade de lançamento

- ✅ Testes de interface ponta a ponta no CI (Chrome headless, `npm run test:e2e`): 10 cenários com a CLI real — servidor com token, busca, breadcrumb, paleta, teclado, caminho, EN/PT, celular, `--changes`, `--watch` e relatório offline sem requisições externas.
- ✅ Benchmarks (`npm run bench`): projetos sintéticos de 100, 1 000 e 5 000 arquivos (análise 0,4 s / 1,0 s / 3,3 s; 5 000 arquivos com 661 MB), com limites no CI.
- ✅ Interface em projetos enormes: com 5 000 arquivos, o nível "Arquivos" (5 mil nós, 20 mil linhas) ia de **mais de 3 min** para **~5 s** — grupos densos empacotados em grade no ELK, ELK mais leve em mapas grandes com limite de 20 s (cai para o orgânico), atalhos no cache de estilo do Cytoscape, linhas retas e imagem durante o arraste em mapas grandes, minimapa sem `boundingBox()` por nó. Projetos com tudo dentro de `src/` abrem já com a pasta aberta. Teste de interface com 1 500 arquivos guarda a regressão.
- ✅ Revisão de código independente (analisador, interface e segurança): 5 problemas altos (inclusive um desvio da verificação de configuração do git via `config.worktree`), 12 médios e vários baixos — todos corrigidos com testes que reproduzem cada caso.
- ✅ Novas capturas e GIF em EN e PT (`docs/assets/en`, `docs/assets/pt`), README e README.pt-BR reescritos, CHANGELOG e ROADMAP atualizados, versão 0.2.0.

## Fora desta versão

Outras linguagens (Python/Go) e extensões de editor ficam para a 0.3, para a 0.2 sair impecável.

## Antes de lançar (checklist)

- [ ] Rodar tudo numa máquina limpa: `npm ci && npm run build && npm test && npm run test:e2e`.
- [ ] Testar o pacote empacotado: `npm pack -w apps/cli` e `npx ./mongeai-rastro-0.2.0.tgz` num projeto real.
- [ ] `npm publish` (feito pelo dono do pacote, com 2FA) **antes** da tag: a GitHub Action usa `@mongeai/rastro@0.2.0` do npm.
- [ ] Merge de `next` em `main`, tag `v0.2.0` (é ela que `uses: MongeAI/rastro@v0.2.0` usa), release no GitHub com o CHANGELOG.
- [ ] Depois do lançamento: workflow do próprio repositório usando a action em cada PR (dogfooding).
