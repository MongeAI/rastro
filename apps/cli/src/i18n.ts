import { progressMessage, type ProgressEvent } from '@rastro/analyzer';
import type { Lang, NodeKind, Resolution } from '@rastro/core';
import type { BrokenReference, ComparedStat } from '@rastro/graph';

type BrokenWhy = BrokenReference['why'];

/**
 * Mensagens da CLI em português e inglês. O dicionário em inglês precisa ter exatamente a
 * mesma forma do português (o TypeScript acusa qualquer chave faltando), como na interface
 * (`apps/web/src/lib/i18n.tsx`). Mensagens com parâmetros são funções.
 *
 * Idioma: `--lang <en|pt>`, depois `RASTRO_LANG`, depois o idioma do sistema
 * (`LC_ALL`, `LC_MESSAGES`, `LANG`: começa com `pt` → português; qualquer outro → inglês).
 * Sem nada definido, inglês.
 */

export type { Lang };

/** `1 arquivo`, `2 arquivos`. */
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const pt = {
  errorPrefix: 'erro:',
  warningPrefix: 'aviso:',
  help: (version: string) => `
Rastro ${version} — siga o rastro do seu código (mapa navegável de projetos JS/TS)

Uso:
  rastro <caminho>                  analisa o projeto e abre o mapa no navegador
                                    (equivale a "rastro open <caminho>")
  rastro analyze <caminho>          só analisa e salva o grafo em JSON
  rastro serve <grafo.json>         abre o mapa de um JSON salvo anteriormente
  rastro validate <grafo.json>      confere se um JSON exportado é válido
  rastro export <caminho|grafo.json> --format <formato>
                                    exporta o mapa: mermaid, dot, graphml, json ou html
                                    (html = relatório navegável num arquivo só, offline)
  rastro compare <a.json> <b.json>  o que entrou, saiu e mudou entre duas análises
  rastro impact <caminho|grafo.json>
                                    o impacto das mudanças do git: o que mudou, quem pode ser
                                    afetado, rotas e testes (texto, markdown ou json)
  rastro check [caminho]            confere as regras de arquitetura (rastro.rules.json):
                                    quem pode depender de quem, sem ciclos; com --changes ou
                                    --since, só o que a mudança introduziu reprova
  rastro mcp [caminho]              servidor MCP (stdio) para agentes de IA consultarem o
                                    grafo: Claude Code, Cursor, VS Code... (padrão: a pasta
                                    do projeto do Claude Code, ou a pasta atual)

Opções:
  -o, --out <arquivo>       onde salvar o JSON (padrão: cache do usuário); no export,
                            o arquivo gerado (padrão: saída padrão; html: <projeto>.rastro.html)
      --stdout              (analyze) escreve o JSON na saída padrão
  -f, --format <formato>    (export) mermaid, dot, graphml, json ou html
                            (impact, check) text (padrão), markdown ou json
      --tests               (impact) só os arquivos de teste afetados, um por linha
      --rules <arquivo>     arquivo de regras de arquitetura (padrão: rastro.rules.json
                            na pasta analisada)
      --init                (check) cria o rastro.rules.json com as regras que o projeto
                            já cumpre (camadas, ciclos, testes)
      --link <url>          (impact, check) base dos links arquivo:linha no markdown, ex.:
                            https://github.com/org/repo/blob/<commit>
      --level <nível>       (export) modules, files (padrão) ou symbols
      --folder <pasta>      (export) só esta pasta, ex.: src/services
      --edges <tipos>       (export) relações, ex.: imports,calls (padrão: imports,calls,extends)
      --external            (export) inclui pacotes externos (npm, Node.js)
      --no-unresolved       (export) omite referências não resolvidas
      --json                (compare) resultado em JSON
  -p, --port <n>            porta da interface (padrão: 4321, ou a próxima livre)
      --no-open             não abre o navegador automaticamente
  -e, --exclude <padrão>    ignora caminhos (sintaxe do .gitignore; pode repetir)
      --no-gitignore        não usa o .gitignore do projeto
      --max-files <n>       limite de arquivos analisados (padrão: 10000)
      --changes             marca o que mudou desde o último commit (git) e o impacto
      --since <ref>         marca o que mudou desde que a branch saiu de <ref> (ex.: main)
      --trust-git-config    permite rodar o git mesmo com comandos no .git/config
  -w, --watch               reanalisa ao salvar arquivos e atualiza o mapa ao vivo
      --no-watch            (mcp) não observa os arquivos (o grafo fica o da primeira análise)
      --lang <en|pt>        idioma das mensagens (padrão: RASTRO_LANG, depois o idioma do
                            sistema em LC_ALL, LC_MESSAGES ou LANG; sem nenhum, inglês)
  -h, --help                mostra esta ajuda
  -v, --version             mostra a versão

O Rastro só lê arquivos: não executa o projeto, não instala dependências e não
envia nada para a internet. A interface fica disponível apenas em 127.0.0.1; o
servidor MCP só fala pelo stdio.
`,
  /** Etapas da análise (o texto padrão do analisador, em português). */
  progress: (event: ProgressEvent): string => progressMessage(event),
  usage: {
    seeHelp: 'Use "rastro --help" para ver as opções.',
    badLang: (value: string) => `idioma desconhecido: "${value}". Use en ou pt.`,
    needPath: (command: string) =>
      `informe o caminho para "${command}". Exemplo: rastro ${command} ./meu-projeto`,
    needGraph: (command: string) =>
      `informe o arquivo JSON do grafo para "${command}". Exemplo: rastro ${command} grafo.json`,
    unknownOption: (option: string) => `opção desconhecida: ${option}`,
    needsValue: (flag: string) => `${flag} precisa de um valor`,
    dashValue: (flag: string) =>
      `${flag} precisa de um valor (para um valor que começa com "-", escreva ${flag}=<valor>)`,
    takesNoValue: (flag: string) => `${flag} não aceita valor`,
    unexpectedArg: (arg: string) => `argumento inesperado: ${arg}`,
    portRange: '--port precisa ser um número entre 0 e 65535.',
    notApplicable: (flag: string, command: string) => `${flag} não se aplica a "${command}".`,
    onlyWith: (flag: string, command: string) => `${flag} só funciona com "rastro ${command}".`,
    notTogether: (a: string, b: string) => `${a} e ${b} não podem ser usados juntos.`,
    maxFiles: '--max-files precisa ser um inteiro positivo.',
    watchOnly: '--watch só funciona ao abrir o mapa (rastro <caminho>).',
    mcpWatches:
      '--watch não se aplica a "mcp": ele já observa o projeto (use --no-watch para desligar).',
    mcpGitPerCall: (flag: string) =>
      `${flag} não se aplica a "mcp": o agente pede as mudanças do git a cada chamada (ferramenta rastro_impact, opção since).`,
    needsFolder: (flag: string, command: string) =>
      `${flag} não se aplica a "rastro ${command}" com um JSON salvo: só vale ao analisar uma pasta.`,
    trustNeedsChanges:
      '--trust-git-config só tem efeito com "rastro impact", "rastro mcp" ou junto com --changes ou --since.',
    dirNotFound: (dir: string) => `diretório não encontrado: ${dir}`,
    pathNotFound: (p: string) => `caminho não encontrado: ${p}`,
    compareNeedsTwo: 'informe dois arquivos JSON. Exemplo: rastro compare antes.json depois.json',
  },
  summary: {
    files: (count: number) => n(count, 'arquivo analisado', 'arquivos analisados'),
    kinds: {
      function: (count: number) => n(count, 'função', 'funções'),
      class: (count: number) => n(count, 'classe', 'classes'),
      method: (count: number) => n(count, 'método', 'métodos'),
      route: (count: number) => n(count, 'rota', 'rotas'),
      package: (count: number) => n(count, 'pacote externo', 'pacotes externos'),
      unresolved: (count: number) => n(count, 'não resolvido', 'não resolvidos'),
    } satisfies Partial<Record<NodeKind, (count: number) => string>>,
    relations: (resolved: number, external: number, unresolved: number) =>
      `relações: ${n(resolved, 'resolvida', 'resolvidas')} · ${n(external, 'externa', 'externas')} · ${n(unresolved, 'não resolvida', 'não resolvidas')}`,
    cycles: (count: number) => n(count, 'ciclo de importação', 'ciclos de importação'),
    warnings: (count: number) => `${n(count, 'aviso', 'avisos')}:`,
    moreWarnings: (count: number) => `… e mais ${count} (veja "diagnostics" no JSON)`,
    duration: (ms: number, typescript: string) =>
      `análise em ${ms} ms com TypeScript ${typescript}`,
    savedTo: 'grafo salvo em',
  },
  changes: {
    title: 'Mudanças',
    sinceLastCommit: 'desde o último commit',
    since: (ref: string) => `desde ${ref}`,
    none: (since: string) => `nenhuma mudança ${since}`,
    counts: (files: number, entities: number) =>
      `${n(files, 'arquivo alterado', 'arquivos alterados')} · ${n(entities, 'entidade alterada', 'entidades alteradas')}`,
    impact: (count: number) =>
      `impacto: ${count === 1 ? '1 entidade depende' : `${count} entidades dependem`} do que mudou`,
    routes: (count: number) => n(count, 'rota', 'rotas'),
    tests: (count: number) => n(count, 'arquivo de teste', 'arquivos de teste'),
    skipped: (reason: string) => `mudanças do git não incluídas: ${reason}`,
  },
  impact: {
    title: 'Impacto das mudanças',
    noChanges: 'nenhuma mudança encontrada',
    files: (count: number) => n(count, 'arquivo alterado', 'arquivos alterados'),
    changedCount: (count: number) => n(count, 'entidade alterada', 'entidades alteradas'),
    impactedCount: (count: number) =>
      count === 1 ? '1 pode ser afetada' : `${count} podem ser afetadas`,
    routesCount: (count: number) => n(count, 'rota HTTP', 'rotas HTTP'),
    testsCount: (count: number) => n(count, 'arquivo de teste', 'arquivos de teste'),
    changed: 'O que mudou',
    impacted: 'Pode ser afetado',
    nothingDepends: 'Nada conhecido depende do que mudou.',
    broken: 'Possivelmente quebrado pela mudança',
    brokenHint:
      'referências ao que mudou que não resolvem no código atual (podem já estar quebradas antes); não são relações comprovadas',
    brokenCount: (count: number) =>
      n(count, 'referência possivelmente quebrada', 'referências possivelmente quebradas'),
    brokenWhy: (kind: 'import' | 'call', why: BrokenWhy, reference: string, target: string) =>
      why === 'member-missing'
        ? `chama ${reference}, mas o tipo (declarado em ${target}) não tem esse membro`
        : why === 'name-missing'
          ? `chama ${reference}, que não está declarado nem importado em ${target}`
          : why === 'importer-moved'
            ? `importa ${reference}, que não resolve mais desde que o arquivo saiu de ${target}`
            : kind === 'import'
              ? why === 'not-exported'
                ? `importa ${reference} de ${target}, que não exporta esse nome`
                : `importa ${reference}, mas ${target} foi ${why === 'file-deleted' ? 'removido' : 'renomeado'}`
              : `chama ${reference}, importado de ${target} (${why === 'not-exported' ? 'que não exporta esse nome' : why === 'file-deleted' ? 'removido' : 'renomeado'})`,
    times: (count: number) => `(${count} vezes)`,
    routes: 'Rotas HTTP envolvidas',
    tests: 'Testes para rodar',
    outside: 'Fora do mapa',
    status: { added: 'novo', modified: 'alterado', deleted: 'removido', renamed: 'renomeado' },
    entity: 'Entidade',
    kind: 'Tipo',
    where: 'Onde',
    distance: 'Distância',
    via: 'Por meio de',
    viaText: (kind: string, target: string) =>
      `${kind === 'imports' ? 'importa' : kind === 'extends' ? 'estende' : 'chama'} ${target}`,
    more: (count: number) => `… e mais ${count}`,
    howToRead: 'Como ler este relatório',
    footnote:
      'Só relações comprovadas (chamadas, imports e herança resolvidos, com arquivo e linha) entram no impacto. Referências não resolvidas (callbacks, chamadas dinâmicas) não são seguidas, então algo pode depender do que mudou sem aparecer aqui. A distância conta quantas relações separam a entidade do que mudou.',
    generatedBy: (version: string) =>
      `Gerado pelo <a href="https://github.com/MongeAI/rastro">Rastro</a> ${version} · análise estática, nenhum código executado`,
    badFormat: (value: string) =>
      `formato desconhecido para impact: "${value}". Use text, markdown ou json.`,
    needsChanges:
      'este grafo não tem mudanças do git. Gere com "rastro analyze <pasta> --changes" (ou --since <ref>), ou rode "rastro impact <pasta>".',
    gitFailed: (reason: string) => `não foi possível ler as mudanças do git: ${reason}`,
    linkNeedsMarkdown: '--link só vale com --format markdown.',
    badLink: (value: string) =>
      `--link precisa ser um endereço http:// ou https:// (recebido: "${value}").`,
    oddTest: (file: string) =>
      `arquivo de teste com caracteres de controle no nome ficou de fora: ${file}`,
  },
  rules: {
    title: 'Regras de arquitetura',
    ruleCount: (count: number) => n(count, 'regra', 'regras'),
    violations: (count: number) => n(count, 'violação', 'violações'),
    newViolations: (count: number) => n(count, 'violação nova', 'violações novas'),
    cycles: (count: number) => n(count, 'ciclo', 'ciclos'),
    warnings: (count: number) => n(count, 'aviso', 'avisos'),
    warning: 'aviso',
    existing: (count: number) =>
      count === 1
        ? '1 já existia antes (não reprova)'
        : `${count} já existiam antes (não reprovam)`,
    noNew: 'nenhuma violação nova',
    allPassed: (count: number) =>
      count === 1 ? 'a regra é cumprida' : `todas as ${count} regras são cumpridas`,
    noRules: 'o arquivo não tem nenhuma regra',
    noFiles: 'nenhum arquivo analisado casa com "from"/"except": o padrão está certo?',
    possibleTitle: (count: number) => n(count, 'violação possível', 'violações possíveis'),
    possibleHint:
      'possível = por uma chamada não resolvida (interface ou método abstrato) que pode ir para lá; nunca reprova.',
    kind: { imports: 'import', calls: 'chamada', extends: 'herança' },
    typeOnly: 'só tipos',
    package: 'pacote',
    times: (count: number) => `(${count} vezes)`,
    cycleOf: (size: number) => `ciclo entre ${size} arquivos`,
    invalid: (source: string) => `${source} tem problemas; nenhuma regra foi conferida:`,
    notFound: (file: string) => `arquivo de regras não encontrado: ${file}`,
    noRulesFile: (dir: string) =>
      `nenhum rastro.rules.json em ${dir}. Crie um com "rastro check --init" (as regras que o projeto já cumpre) ou aponte outro arquivo com --rules.`,
    notRegular: (file: string) =>
      `${file} não é um arquivo comum (links simbólicos não são seguidos; use --rules para apontar o arquivo).`,
    tooLarge: (file: string) => `${file} passa de 1 MB.`,
    unreadable: (file: string, reason: string) => `não foi possível ler ${file}: ${reason}`,
    ignored: (reason: string) => `regras de arquitetura não conferidas: ${reason}`,
    initExists: (file: string) => `${file} já existe: edite-o (ou apague-o para gerar de novo).`,
    initWritten: (file: string, count: number) =>
      `${file} criado com ${n(count, 'regra', 'regras')} que o projeto já cumpre:`,
    initEmpty: (file: string) =>
      `${file} criado sem regras: o projeto não tem camadas claras nem fica livre de ciclos hoje. Escreva as suas (veja o README).`,
    initNext:
      'Confira com "rastro check". No CI, a Action do Rastro aponta (e reprova) as violações que um pull request introduz.',
    layerName: (folder: string, above: string[]) =>
      `${folder} não depende de ${above.length === 1 ? above[0] : `${above.slice(0, -1).join(', ')} nem ${above[above.length - 1]}`}`,
    noCyclesName: 'Sem ciclos de importação',
    testsName: 'O código não depende dos testes',
    summaryLine: (errors: number, warnings: number) =>
      `regras: ${errors ? n(errors, 'violação', 'violações') : 'nenhuma violação'}${warnings ? ` · ${n(warnings, 'aviso', 'avisos')}` : ''} (rastro check para os detalhes)`,
    initNotWithChanges: '--init não se combina com --changes ou --since.',
    initNotWithFormat: '--init não se combina com --format.',
    badFormat: (value: string) =>
      `formato desconhecido para check: "${value}". Use text, markdown ou json.`,
  },
  serve: {
    webNotBuilt:
      'a interface web não foi compilada. Rode "npm run build" na raiz do repositório do Rastro.',
    readyAt: 'pronto em',
    stopHint: '(Ctrl+C para encerrar)',
    tokenNote: 'O endereço inclui um token de acesso válido só nesta execução.',
    stopping: 'Encerrando...',
    rootMissing: (root: string) =>
      `a pasta analisada (${root}) não existe nesta máquina; o código-fonte não poderá ser exibido.`,
  },
  watch: {
    reanalyzed: (ms: number, files: number) =>
      `· reanalisado em ${ms} ms · ${n(files, 'arquivo', 'arquivos')}`,
    failed: (error: string) => `a reanálise falhou: ${error}`,
    live: 'Modo ao vivo: o mapa se atualiza quando você salva um arquivo.',
    polling:
      'Modo ao vivo por varredura: o mapa se atualiza alguns segundos depois de você salvar um arquivo.',
    fallback: (reason: string) =>
      `não foi possível observar as pastas do projeto (${reason}); o Rastro vai procurar mudanças a cada 1,5 s.`,
    limitHint:
      'No Linux, o limite vem de fs.inotify.max_user_watches e max_user_instances (sysctl); aumentá-los devolve o modo instantâneo.',
  },
  mcp: {
    serving: (root: string) => `servidor MCP de ${root} no stdio; aguardando o cliente.`,
    ttyHint:
      'este comando fala o Model Context Protocol pelo stdin/stdout e é feito para ser iniciado por um cliente de IA (Claude Code, Cursor, VS Code); veja o README. Ctrl+D encerra.',
    analyzed: (ms: number, files: number, sequence: number) =>
      `${sequence === 1 ? 'análise pronta' : 'reanalisado'} em ${ms} ms · ${n(files, 'arquivo', 'arquivos')}`,
    failed: (error: string) => `a análise falhou (a próxima chamada tenta de novo): ${error}`,
  },
  validate: {
    invalid: 'inválido',
    valid: (nodes: number, edges: number, schema: string) =>
      `válido — ${n(nodes, 'nó', 'nós')}, ${n(edges, 'relação', 'relações')} (schema ${schema})`,
  },
  git: {
    notFound: 'o comando "git" não foi encontrado neste sistema',
    failed: 'erro do git',
    riskyConfig: (keys: string) =>
      `a configuração do git deste repositório (.git/config ou .git/config.worktree) define comandos que o git executaria (${keys}). ` +
      'Por segurança o Rastro não roda o git aqui. Se você confia no repositório, use --trust-git-config.',
    badRef: (ref: string) => `referência inválida: ${ref}`,
    notRepo: (dir: string) => `a pasta não está num repositório git (${dir})`,
    unknownRef: (ref: string) => `referência desconhecida: ${ref}`,
    noMergeBase: (ref: string) => `${ref} e HEAD não têm um commit em comum`,
  },
  export: {
    needFormat: (formats: string) =>
      `informe o formato com --format (${formats}). Exemplo: rastro export . --format mermaid`,
    unknownFormat: (format: string, formats: string) =>
      `formato desconhecido: "${format}". Use um destes: ${formats}.`,
    flagNotForFormat: (flag: string, format: string) =>
      `${flag} não se aplica a --format ${format} (só a mermaid, dot e graphml).`,
    unknownLevel: (level: string, levels: string) =>
      `nível desconhecido: "${level}". Use um destes: ${levels}.`,
    badEdges: (kinds: string) => `--edges aceita uma lista separada por vírgulas de: ${kinds}.`,
    emptyFolder: (folder: string) =>
      `nenhum arquivo do grafo está na pasta "${folder}" (o caminho é relativo à raiz analisada).`,
    failed: (error: string) => `não foi possível exportar: ${error}`,
    saved: (format: string) => `${format} salvo em`,
    htmlHint:
      'Abra no navegador: o mapa funciona offline, sem servidor (o código-fonte não vai junto).',
    writeFailed: (target: string, why: string) => `não foi possível gravar ${target}: ${why}`,
    isDir: 'o destino é uma pasta; informe um nome de arquivo',
  },
  storage: {
    saveFailed: (target: string, why: string) =>
      `não foi possível salvar o grafo em ${target}: ${why}`,
    isDir: 'o destino é uma pasta; informe um nome de arquivo, ex.: -o grafo.json',
    notRegular:
      'o destino não é um arquivo comum (é um dispositivo, pipe ou socket); informe um nome de arquivo, ex.: -o grafo.json',
    noPermission: (where: string) => `sem permissão para gravar em ${where}`,
    fileNotFound: (target: string) => `arquivo não encontrado: ${target}`,
    isFolder: (target: string, arg: string) =>
      `${target} é uma pasta, e aqui é esperado o arquivo JSON de um grafo. ` +
      `Para analisar a pasta, rode "rastro ${arg}" ou "rastro analyze ${arg}".`,
    cannotRead: (target: string, error: string) => `não foi possível ler ${target}: ${error}`,
    invalidJson: (error: string) => `JSON inválido: ${error}`,
    invalidGraph: (errors: readonly string[]) => `grafo inválido:\n- ${errors.join('\n- ')}`,
  },
  compare: {
    title: 'Comparação',
    differentRoots: 'as análises são de pastas diferentes; ids iguais ainda são comparados.',
    numbers: 'Números',
    identical: 'Nenhum nó, relação ou ciclo mudou entre as duas análises.',
    added: 'Entraram',
    removed: 'Saíram',
    edgesAdded: 'Relações novas',
    edgesRemoved: 'Relações removidas',
    resolutionChanged: 'Resolução alterada',
    cyclesAdded: 'Ciclos de importação novos',
    cyclesRemoved: 'Ciclos de importação desfeitos',
    andMore: (count: number) => `… e mais ${count}`,
    kindPlural: {
      module: 'Pastas',
      file: 'Arquivos',
      function: 'Funções',
      class: 'Classes',
      method: 'Métodos',
      route: 'Rotas',
      package: 'Pacotes externos',
      unresolved: 'Não resolvidos',
    } satisfies Record<NodeKind, string>,
    stats: {
      files: 'arquivos analisados',
      functions: 'funções',
      classes: 'classes',
      methods: 'métodos',
      routes: 'rotas',
      packages: 'pacotes externos',
      unresolved: 'relações não resolvidas',
      cycles: 'ciclos de importação',
      nodes: 'nós',
      edges: 'relações',
    } satisfies Record<ComparedStat, string>,
    resolution: {
      resolved: 'resolvida',
      external: 'externa',
      unresolved: 'não resolvida',
    } satisfies Record<Resolution, string>,
  },
  server: {
    hostNotAllowed: (host: string, port: number) =>
      `Host não permitido: "${host}". Abra http://127.0.0.1:${port}/ diretamente nesta máquina ` +
      '(o Rastro recusa outros nomes de host para se proteger de DNS rebinding).',
    methodNotAllowed: 'Método não permitido.',
    badUrl: 'URL inválida.',
    badToken: 'Token inválido. Use o endereço exibido no terminal.',
    accessDenied: 'Acesso negado. Abra o endereço completo (com o token) exibido no terminal.',
    unknownEndpoint: 'Endpoint desconhecido.',
    badPath: 'Caminho inválido.',
    webMissing:
      'A interface web não foi encontrada. Rode "npm run build" na raiz do repositório do Rastro.',
    internalError: 'Erro interno do servidor do Rastro.',
    portFailed: (port: number, reason: string) =>
      `não foi possível abrir a interface a partir da porta ${port} (${reason}). ` +
      'Tente outra com --port, por exemplo --port 5050.',
    portsNoPermission: 'sem permissão para usar essas portas',
    portsBusy: 'todas estão ocupadas',
    notInGraph: 'Arquivo fora do grafo analisado.',
    outsideProject: 'Caminho fora do projeto.',
    onlyJsTs: 'Só arquivos JavaScript/TypeScript podem ser exibidos.',
    rootMissing: 'A raiz do projeto não existe nesta máquina.',
    notRegularFile: 'Não é um arquivo regular.',
    tooLarge: 'Arquivo grande demais para exibir.',
    sourceNotFound: 'Arquivo não encontrado (o projeto mudou desde a análise?).',
  },
  browser: {
    opening: 'Abrindo o Rastro…',
    continue: 'continuar',
  },
  report: {
    scriptNotFound: 'não foi possível localizar o script da interface em index.html.',
    assetNotFound: (ref: string) => `arquivo da interface não encontrado: ${ref}`,
    elkWorkerMissing: 'o worker do ELK não foi encontrado na interface compilada.',
    lazyChunk: (file: string) =>
      `a interface compilada carrega ${file} sob demanda; o relatório HTML precisa de um bundle único.`,
  },
};

export type Messages = typeof pt;

const en: Messages = {
  errorPrefix: 'error:',
  warningPrefix: 'warning:',
  help: (version) => `
Rastro ${version} — follow the trail of your code (an explorable map of JS/TS projects)

Usage:
  rastro <path>                     analyze the project and open the map in the browser
                                    (same as "rastro open <path>")
  rastro analyze <path>             only analyze and save the graph as JSON
  rastro serve <graph.json>         open the map of a previously saved JSON
  rastro validate <graph.json>      check that an exported JSON is valid
  rastro export <path|graph.json> --format <format>
                                    export the map: mermaid, dot, graphml, json or html
                                    (html = a single-file, offline, explorable report)
  rastro compare <a.json> <b.json>  what was added, removed or changed between two analyses
  rastro impact <path|graph.json>
                                    the impact of the git changes: what changed, what could be
                                    affected, routes and tests (text, markdown or json)
  rastro check [path]               check the architecture rules (rastro.rules.json): who
                                    may depend on whom, no cycles; with --changes or --since,
                                    only what the change introduced fails
  rastro mcp [path]                 MCP server (stdio) so AI agents can query the graph:
                                    Claude Code, Cursor, VS Code... (default: the Claude Code
                                    project folder, or the current folder)

Options:
  -o, --out <file>          where to save the JSON (default: user cache); with export,
                            the output file (default: standard output; html: <project>.rastro.html)
      --stdout              (analyze) write the JSON to standard output
  -f, --format <format>     (export) mermaid, dot, graphml, json or html
                            (impact, check) text (default), markdown or json
      --tests               (impact) only the affected test files, one per line
      --rules <file>        architecture rules file (default: rastro.rules.json in the
                            analyzed folder)
      --init                (check) create rastro.rules.json with the rules the project
                            already follows (layers, cycles, tests)
      --link <url>          (impact, check) base for file:line links in markdown, e.g.
                            https://github.com/org/repo/blob/<commit>
      --level <level>       (export) modules, files (default) or symbols
      --folder <path>       (export) only this folder, e.g. src/services
      --edges <kinds>       (export) relationships, e.g. imports,calls (default: imports,calls,extends)
      --external            (export) include external packages (npm, Node.js)
      --no-unresolved       (export) leave out unresolved references
      --json                (compare) output as JSON
  -p, --port <n>            interface port (default: 4321, or the next free one)
      --no-open             do not open the browser automatically
  -e, --exclude <pattern>   ignore paths (.gitignore syntax; repeatable)
      --no-gitignore        do not use the project's .gitignore
      --max-files <n>       maximum number of files to analyze (default: 10000)
      --changes             highlight what changed since the last commit (git) and its impact
      --since <ref>         highlight what changed since the branch forked from <ref> (e.g. main)
      --trust-git-config    run git even if .git/config defines commands
  -w, --watch               re-analyze when files are saved and update the map live
      --no-watch            (mcp) do not watch files (the graph stays as first analyzed)
      --lang <en|pt>        message language (default: RASTRO_LANG, then the system locale
                            from LC_ALL, LC_MESSAGES or LANG; if none is set, English)
  -h, --help                show this help
  -v, --version             show the version

Rastro only reads files: it never runs your project, installs dependencies or
sends anything over the network. The interface is only served on 127.0.0.1; the
MCP server only talks over stdio.
`,
  progress: (event) => {
    switch (event.code) {
      case 'discovering':
        return 'Looking for JavaScript/TypeScript files...';
      case 'discovered':
        return `${n(event.files, 'file', 'files')} found.`;
      case 'loading-compiler':
        return 'Building the compiler model...';
      case 'extracting':
        return 'Extracting files, functions, classes and methods...';
      case 'resolving':
        return 'Resolving imports, exports and calls...';
      case 'building-graph':
        return 'Assembling the graph...';
      case 'done':
        return `Done in ${event.durationMs} ms.`;
    }
  },
  usage: {
    seeHelp: 'Run "rastro --help" to see the options.',
    badLang: (value) => `unknown language: "${value}". Use en or pt.`,
    needPath: (command) => `missing path for "${command}". Example: rastro ${command} ./my-project`,
    needGraph: (command) =>
      `missing graph JSON file for "${command}". Example: rastro ${command} graph.json`,
    unknownOption: (option) => `unknown option: ${option}`,
    needsValue: (flag) => `${flag} needs a value`,
    dashValue: (flag) =>
      `${flag} needs a value (for a value that starts with "-", write ${flag}=<value>)`,
    takesNoValue: (flag) => `${flag} does not take a value`,
    unexpectedArg: (arg) => `unexpected argument: ${arg}`,
    portRange: '--port must be a number between 0 and 65535.',
    notApplicable: (flag, command) => `${flag} does not apply to "${command}".`,
    onlyWith: (flag, command) => `${flag} only works with "rastro ${command}".`,
    notTogether: (a, b) => `${a} and ${b} cannot be used together.`,
    maxFiles: '--max-files must be a positive integer.',
    watchOnly: '--watch only works when opening the map (rastro <path>).',
    mcpWatches:
      '--watch does not apply to "mcp": it already watches the project (use --no-watch to turn it off).',
    mcpGitPerCall: (flag) =>
      `${flag} does not apply to "mcp": the agent asks for git changes on each call (rastro_impact tool, since option).`,
    needsFolder: (flag, command) =>
      `${flag} does not apply to "rastro ${command}" with a saved JSON: it only works when analyzing a folder.`,
    trustNeedsChanges:
      '--trust-git-config only has an effect with "rastro impact", "rastro mcp" or together with --changes or --since.',
    dirNotFound: (dir) => `directory not found: ${dir}`,
    pathNotFound: (p) => `path not found: ${p}`,
    compareNeedsTwo: 'pass two JSON files. Example: rastro compare before.json after.json',
  },
  summary: {
    files: (count) => n(count, 'file analyzed', 'files analyzed'),
    kinds: {
      function: (count) => n(count, 'function', 'functions'),
      class: (count) => n(count, 'class', 'classes'),
      method: (count) => n(count, 'method', 'methods'),
      route: (count) => n(count, 'route', 'routes'),
      package: (count) => n(count, 'external package', 'external packages'),
      unresolved: (count) => `${count} unresolved`,
    },
    relations: (resolved, external, unresolved) =>
      `relationships: ${resolved} resolved · ${external} external · ${unresolved} unresolved`,
    cycles: (count) => n(count, 'import cycle', 'import cycles'),
    warnings: (count) => `${n(count, 'warning', 'warnings')}:`,
    moreWarnings: (count) => `… and ${count} more (see "diagnostics" in the JSON)`,
    duration: (ms, typescript) => `analyzed in ${ms} ms with TypeScript ${typescript}`,
    savedTo: 'graph saved to',
  },
  changes: {
    title: 'Changes',
    sinceLastCommit: 'since the last commit',
    since: (ref) => `since ${ref}`,
    none: (since) => `no changes ${since}`,
    counts: (files, entities) =>
      `${n(files, 'changed file', 'changed files')} · ${n(entities, 'changed entity', 'changed entities')}`,
    impact: (count) =>
      `impact: ${count === 1 ? '1 entity depends' : `${count} entities depend`} on what changed`,
    routes: (count) => n(count, 'route', 'routes'),
    tests: (count) => n(count, 'test file', 'test files'),
    skipped: (reason) => `git changes not included: ${reason}`,
  },
  impact: {
    title: 'Impact of the changes',
    noChanges: 'no changes found',
    files: (count) => n(count, 'changed file', 'changed files'),
    changedCount: (count) => n(count, 'changed entity', 'changed entities'),
    impactedCount: (count) => `${count} could be affected`,
    routesCount: (count) => n(count, 'HTTP route', 'HTTP routes'),
    testsCount: (count) => n(count, 'test file', 'test files'),
    changed: 'What changed',
    impacted: 'Could be affected',
    nothingDepends: 'Nothing known depends on what changed.',
    broken: 'Possibly broken by this change',
    brokenHint:
      'references to what changed that do not resolve in the current code (they may have been broken before); not proven relationships',
    brokenCount: (count) => n(count, 'reference possibly broken', 'references possibly broken'),
    brokenWhy: (kind, why, reference, target) =>
      why === 'member-missing'
        ? `calls ${reference}, but the type (declared in ${target}) has no such member`
        : why === 'name-missing'
          ? `calls ${reference}, which is not declared or imported in ${target}`
          : why === 'importer-moved'
            ? `imports ${reference}, which no longer resolves since this file moved from ${target}`
            : kind === 'import'
              ? why === 'not-exported'
                ? `imports ${reference} from ${target}, which does not export that name`
                : `imports ${reference}, but ${target} was ${why === 'file-deleted' ? 'deleted' : 'renamed'}`
              : `calls ${reference}, imported from ${target} (${why === 'not-exported' ? 'which does not export that name' : why === 'file-deleted' ? 'deleted' : 'renamed'})`,
    times: (count) => `(${count} times)`,
    routes: 'HTTP routes involved',
    tests: 'Tests to run',
    outside: 'Outside the map',
    status: { added: 'new', modified: 'modified', deleted: 'deleted', renamed: 'renamed' },
    entity: 'Entity',
    kind: 'Kind',
    where: 'Where',
    distance: 'Distance',
    via: 'Through',
    viaText: (kind, target) =>
      `${kind === 'imports' ? 'imports' : kind === 'extends' ? 'extends' : 'calls'} ${target}`,
    more: (count) => `… and ${count} more`,
    howToRead: 'How to read this report',
    footnote:
      'Only proven relationships (resolved calls, imports and inheritance, with file and line) count toward the impact. Unresolved references (callbacks, dynamic calls) are not followed, so something may depend on what changed without showing up here. The distance counts how many relationships separate the entity from what changed.',
    generatedBy: (version) =>
      `Generated by <a href="https://github.com/MongeAI/rastro">Rastro</a> ${version} · static analysis, no code executed`,
    badFormat: (value) => `unknown format for impact: "${value}". Use text, markdown or json.`,
    needsChanges:
      'this graph has no git changes. Create it with "rastro analyze <folder> --changes" (or --since <ref>), or run "rastro impact <folder>".',
    gitFailed: (reason) => `could not read the git changes: ${reason}`,
    linkNeedsMarkdown: '--link only applies to --format markdown.',
    badLink: (value) => `--link must be an http:// or https:// address (got: "${value}").`,
    oddTest: (file) => `test file left out because its name has control characters: ${file}`,
  },
  rules: {
    title: 'Architecture rules',
    ruleCount: (count: number) => n(count, 'rule', 'rules'),
    violations: (count: number) => n(count, 'violation', 'violations'),
    newViolations: (count: number) => n(count, 'new violation', 'new violations'),
    cycles: (count: number) => n(count, 'cycle', 'cycles'),
    warnings: (count: number) => n(count, 'warning', 'warnings'),
    warning: 'warning',
    existing: (count: number) => `${count} already existed (not failing)`,
    noNew: 'no new violations',
    allPassed: (count: number) => (count === 1 ? 'the rule passes' : `all ${count} rules pass`),
    noRules: 'the file has no rules',
    noFiles: 'no analyzed file matches "from"/"except": is the pattern right?',
    possibleTitle: (count: number) => n(count, 'possible violation', 'possible violations'),
    possibleHint:
      'possible = through an unresolved call (interface or abstract method) that may go there; never fails.',
    kind: { imports: 'import', calls: 'call', extends: 'inheritance' },
    typeOnly: 'types only',
    package: 'package',
    times: (count: number) => `(${count} times)`,
    cycleOf: (size: number) => `cycle among ${size} files`,
    invalid: (source: string) => `${source} has problems; no rule was checked:`,
    notFound: (file: string) => `rules file not found: ${file}`,
    noRulesFile: (dir: string) =>
      `no rastro.rules.json in ${dir}. Create one with "rastro check --init" (the rules the project already follows) or point to another file with --rules.`,
    notRegular: (file: string) =>
      `${file} is not a regular file (symbolic links are not followed; use --rules to point to the file).`,
    tooLarge: (file: string) => `${file} is larger than 1 MB.`,
    unreadable: (file: string, reason: string) => `could not read ${file}: ${reason}`,
    ignored: (reason: string) => `architecture rules not checked: ${reason}`,
    initExists: (file: string) =>
      `${file} already exists: edit it (or delete it to generate it again).`,
    initWritten: (file: string, count: number) =>
      `${file} created with ${n(count, 'rule', 'rules')} the project already follows:`,
    initEmpty: (file: string) =>
      `${file} created without rules: the project has no clear layers and is not free of cycles today. Write your own (see the README).`,
    initNext:
      'Check with "rastro check". In CI, the Rastro Action points out (and fails) the violations a pull request introduces.',
    layerName: (folder: string, above: string[]) =>
      `${folder} does not depend on ${above.length === 1 ? above[0] : `${above.slice(0, -1).join(', ')} or ${above[above.length - 1]}`}`,
    noCyclesName: 'No import cycles',
    testsName: 'Code does not depend on tests',
    summaryLine: (errors: number, warnings: number) =>
      `rules: ${errors ? n(errors, 'violation', 'violations') : 'no violations'}${warnings ? ` · ${n(warnings, 'warning', 'warnings')}` : ''} (rastro check for details)`,
    initNotWithChanges: '--init cannot be combined with --changes or --since.',
    initNotWithFormat: '--init cannot be combined with --format.',
    badFormat: (value: string) =>
      `unknown format for check: "${value}". Use text, markdown or json.`,
  },
  serve: {
    webNotBuilt:
      'the web interface has not been built. Run "npm run build" at the root of the Rastro repository.',
    readyAt: 'ready at',
    stopHint: '(Ctrl+C to stop)',
    tokenNote: 'The address includes an access token that is only valid for this run.',
    stopping: 'Shutting down...',
    rootMissing: (root) =>
      `the analyzed folder (${root}) does not exist on this machine; source code cannot be shown.`,
  },
  watch: {
    reanalyzed: (ms, files) => `· re-analyzed in ${ms} ms · ${n(files, 'file', 'files')}`,
    failed: (error) => `re-analysis failed: ${error}`,
    live: 'Live mode: the map updates whenever you save a file.',
    polling: 'Live mode (polling): the map updates a few seconds after you save a file.',
    fallback: (reason) =>
      `could not watch the project folders (${reason}); Rastro will check for changes every 1.5 s.`,
    limitHint:
      'On Linux, the limit comes from fs.inotify.max_user_watches and max_user_instances (sysctl); raising them restores instant updates.',
  },
  mcp: {
    serving: (root) => `MCP server for ${root} on stdio; waiting for the client.`,
    ttyHint:
      'this command speaks the Model Context Protocol over stdin/stdout and is meant to be started by an AI client (Claude Code, Cursor, VS Code); see the README. Ctrl+D quits.',
    analyzed: (ms, files, sequence) =>
      `${sequence === 1 ? 'analysis ready' : 're-analyzed'} in ${ms} ms · ${n(files, 'file', 'files')}`,
    failed: (error) => `analysis failed (the next call retries): ${error}`,
  },
  validate: {
    invalid: 'invalid',
    valid: (nodes, edges, schema) =>
      `valid — ${n(nodes, 'node', 'nodes')}, ${n(edges, 'relationship', 'relationships')} (schema ${schema})`,
  },
  git: {
    notFound: 'the "git" command was not found on this system',
    failed: 'git error',
    riskyConfig: (keys) =>
      `this repository's git configuration (.git/config or .git/config.worktree) defines commands that git would run (${keys}). ` +
      'For safety, Rastro does not run git here. If you trust the repository, use --trust-git-config.',
    badRef: (ref) => `invalid reference: ${ref}`,
    notRepo: (dir) => `not a git repository (${dir})`,
    unknownRef: (ref) => `unknown reference: ${ref}`,
    noMergeBase: (ref) => `${ref} and HEAD have no commit in common`,
  },
  export: {
    needFormat: (formats) =>
      `choose a format with --format (${formats}). Example: rastro export . --format mermaid`,
    unknownFormat: (format, formats) => `unknown format: "${format}". Use one of: ${formats}.`,
    flagNotForFormat: (flag, format) =>
      `${flag} does not apply to --format ${format} (only to mermaid, dot and graphml).`,
    unknownLevel: (level, levels) => `unknown level: "${level}". Use one of: ${levels}.`,
    badEdges: (kinds) => `--edges takes a comma-separated list of: ${kinds}.`,
    emptyFolder: (folder) =>
      `no file in the graph is inside the folder "${folder}" (the path is relative to the analyzed root).`,
    failed: (error) => `could not export: ${error}`,
    saved: (format) => `${format} saved to`,
    htmlHint:
      'Open it in a browser: the map works offline, with no server (source code is not included).',
    writeFailed: (target, why) => `could not write ${target}: ${why}`,
    isDir: 'the destination is a folder; give a file name',
  },
  storage: {
    saveFailed: (target, why) => `could not save the graph to ${target}: ${why}`,
    isDir: 'the destination is a folder; give a file name, e.g. -o graph.json',
    notRegular:
      'the destination is not a regular file (it is a device, pipe or socket); give a file name, e.g. -o graph.json',
    noPermission: (where) => `no permission to write to ${where}`,
    fileNotFound: (target) => `file not found: ${target}`,
    isFolder: (target, arg) =>
      `${target} is a folder, but a graph JSON file is expected here. ` +
      `To analyze the folder, run "rastro ${arg}" or "rastro analyze ${arg}".`,
    cannotRead: (target, error) => `could not read ${target}: ${error}`,
    invalidJson: (error) => `invalid JSON: ${error}`,
    invalidGraph: (errors) => `invalid graph:\n- ${errors.join('\n- ')}`,
  },
  compare: {
    title: 'Comparison',
    differentRoots: 'the analyses come from different folders; matching ids are still compared.',
    numbers: 'Numbers',
    identical: 'No node, relationship or cycle changed between the two analyses.',
    added: 'Added',
    removed: 'Removed',
    edgesAdded: 'New relationships',
    edgesRemoved: 'Removed relationships',
    resolutionChanged: 'Resolution changed',
    cyclesAdded: 'New import cycles',
    cyclesRemoved: 'Import cycles broken',
    andMore: (count) => `… and ${count} more`,
    kindPlural: {
      module: 'Folders',
      file: 'Files',
      function: 'Functions',
      class: 'Classes',
      method: 'Methods',
      route: 'Routes',
      package: 'External packages',
      unresolved: 'Unresolved',
    },
    stats: {
      files: 'analyzed files',
      functions: 'functions',
      classes: 'classes',
      methods: 'methods',
      routes: 'routes',
      packages: 'external packages',
      unresolved: 'unresolved relationships',
      cycles: 'import cycles',
      nodes: 'nodes',
      edges: 'relationships',
    },
    resolution: {
      resolved: 'resolved',
      external: 'external',
      unresolved: 'unresolved',
    },
  },
  server: {
    hostNotAllowed: (host, port) =>
      `Host not allowed: "${host}". Open http://127.0.0.1:${port}/ directly on this machine ` +
      '(Rastro refuses other host names to protect against DNS rebinding).',
    methodNotAllowed: 'Method not allowed.',
    badUrl: 'Invalid URL.',
    badToken: 'Invalid token. Use the address shown in the terminal.',
    accessDenied: 'Access denied. Open the full address (with the token) shown in the terminal.',
    unknownEndpoint: 'Unknown endpoint.',
    badPath: 'Invalid path.',
    webMissing:
      'The web interface was not found. Run "npm run build" at the root of the Rastro repository.',
    internalError: 'Internal error in the Rastro server.',
    portFailed: (port, reason) =>
      `could not open the interface starting at port ${port} (${reason}). ` +
      'Try another one with --port, e.g. --port 5050.',
    portsNoPermission: 'no permission to use those ports',
    portsBusy: 'they are all in use',
    notInGraph: 'File is not part of the analyzed graph.',
    outsideProject: 'Path is outside the project.',
    onlyJsTs: 'Only JavaScript/TypeScript files can be shown.',
    rootMissing: 'The project root does not exist on this machine.',
    notRegularFile: 'Not a regular file.',
    tooLarge: 'File is too large to show.',
    sourceNotFound: 'File not found (has the project changed since the analysis?).',
  },
  browser: {
    opening: 'Opening Rastro…',
    continue: 'continue',
  },
  report: {
    scriptNotFound: 'could not find the interface script in index.html.',
    assetNotFound: (ref) => `interface file not found: ${ref}`,
    elkWorkerMissing: 'the ELK worker was not found in the built interface.',
    lazyChunk: (file) =>
      `the built interface loads ${file} on demand; the HTML report needs a single bundle.`,
  },
};

export const MESSAGES: Record<Lang, Messages> = { pt, en };

/** `pt`, `pt-BR`, `pt_BR.UTF-8` → pt; `en`, `en-US`... → en; qualquer outra coisa → indefinido. */
export function parseLang(value: string | undefined): Lang | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  if (/^pt(?:[-_.@]|$)/.test(v)) return 'pt';
  if (/^en(?:[-_.@]|$)/.test(v)) return 'en';
  return undefined;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Idioma do sistema pelas variáveis de locale, na precedência do POSIX: a primeira não vazia
 * entre `LC_ALL`, `LC_MESSAGES` e `LANG` decide (começa com `pt` → pt; qualquer outra, como
 * `C` ou `de_DE`, → en). Indefinido quando nenhuma está definida.
 */
export function localeLang(env: Env): Lang | undefined {
  const locale = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => v?.trim());
  if (!locale) return undefined;
  return locale.trim().toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

/**
 * Idioma das mensagens: `--lang`, depois `RASTRO_LANG`, depois o locale do sistema; sem nada
 * definido, inglês. Valores desconhecidos em `--lang`/`RASTRO_LANG` são ignorados aqui (a CLI
 * recusa um `--lang` inválido antes de chamar esta função).
 */
export function detectLang(options: { flag?: string; env?: Env } = {}): Lang {
  const env = options.env ?? process.env;
  return parseLang(options.flag) ?? parseLang(env.RASTRO_LANG) ?? localeLang(env) ?? 'en';
}

/**
 * Valor de `--lang` na linha de comando (`--lang pt` ou `--lang=pt`), lido antes do resto
 * para que até os erros de opções saiam no idioma pedido.
 */
export function langArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') break;
    if (arg === '--lang') return argv[i + 1] ?? '';
    if (arg.startsWith('--lang=')) return arg.slice('--lang='.length);
  }
  return undefined;
}

let current: Lang = detectLang();

/** Troca o idioma das mensagens (a CLI chama no início, depois de ler `--lang`). */
export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

/** Mensagens no idioma atual. */
export function t(): Messages {
  return MESSAGES[current];
}
