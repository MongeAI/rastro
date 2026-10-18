import { progressMessage, type ProgressEvent } from '@rastro/analyzer';
import type { Lang, NodeKind, Resolution } from '@rastro/core';
import type { ComparedStat } from '@rastro/graph';

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

Opções:
  -o, --out <arquivo>       onde salvar o JSON (padrão: cache do usuário); no export,
                            o arquivo gerado (padrão: saída padrão; html: <projeto>.rastro.html)
      --stdout              (analyze) escreve o JSON na saída padrão
  -f, --format <formato>    (export) mermaid, dot, graphml, json ou html
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
      --lang <en|pt>        idioma das mensagens (padrão: RASTRO_LANG, depois o idioma do
                            sistema em LC_ALL, LC_MESSAGES ou LANG; sem nenhum, inglês)
  -h, --help                mostra esta ajuda
  -v, --version             mostra a versão

O Rastro só lê arquivos: não executa o projeto, não instala dependências e não
envia nada para a internet. A interface fica disponível apenas em 127.0.0.1.
`,
  /** Etapas da análise (o texto padrão do analisador, em português). */
  progress: (event: ProgressEvent): string => progressMessage(event),
  usage: {
    seeHelp: 'Use "rastro --help" para ver as opções.',
    badLang: (value: string) => `idioma desconhecido: "${value}". Use en ou pt.`,
    needPath: (command: string) =>
      `informe o caminho para "${command}". Exemplo: rastro ${command} ./meu-projeto`,
    portRange: '--port precisa ser um número entre 0 e 65535.',
    notApplicable: (flag: string, command: string) => `${flag} não se aplica a "${command}".`,
    onlyWith: (flag: string, command: string) => `${flag} só funciona com "rastro ${command}".`,
    maxFiles: '--max-files precisa ser um inteiro positivo.',
    watchOnly: '--watch só funciona ao abrir o mapa (rastro <caminho>).',
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
  },
  validate: {
    cannotRead: (error: string) => `não foi possível ler o JSON: ${error}`,
    invalid: 'inválido',
    valid: (nodes: number, edges: number, schema: string) =>
      `válido — ${n(nodes, 'nó', 'nós')}, ${n(edges, 'relação', 'relações')} (schema ${schema})`,
  },
  git: {
    notFound: 'o comando "git" não foi encontrado neste sistema',
    failed: 'erro do git',
    riskyConfig: (keys: string) =>
      `o .git/config deste repositório define comandos que o git executaria (${keys}). ` +
      'Por segurança o Rastro não roda o git aqui. Se você confia no repositório, use --trust-git-config.',
    badRef: (ref: string) => `referência inválida: ${ref}`,
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
    writeFailed: (target: string, why: string) => `Não foi possível gravar ${target}: ${why}`,
    isDir: 'o destino é uma pasta; informe um nome de arquivo',
  },
  storage: {
    saveFailed: (target: string, why: string) =>
      `Não foi possível salvar o grafo em ${target}: ${why}`,
    isDir: 'o destino é uma pasta; informe um nome de arquivo, ex.: -o grafo.json',
    noPermission: 'sem permissão para gravar nesse local',
    fileNotFound: (target: string) => `Arquivo não encontrado: ${target}`,
    invalidJson: (error: string) => `JSON inválido: ${error}`,
    invalidGraph: (errors: readonly string[]) => `Grafo inválido:\n- ${errors.join('\n- ')}`,
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
      `Não foi possível abrir a interface a partir da porta ${port} (${reason}). ` +
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

Options:
  -o, --out <file>          where to save the JSON (default: user cache); with export,
                            the output file (default: standard output; html: <project>.rastro.html)
      --stdout              (analyze) write the JSON to standard output
  -f, --format <format>     (export) mermaid, dot, graphml, json or html
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
      --lang <en|pt>        message language (default: RASTRO_LANG, then the system locale
                            from LC_ALL, LC_MESSAGES or LANG; if none is set, English)
  -h, --help                show this help
  -v, --version             show the version

Rastro only reads files: it never runs your project, installs dependencies or
sends anything over the network. The interface is only served on 127.0.0.1.
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
    portRange: '--port must be a number between 0 and 65535.',
    notApplicable: (flag, command) => `${flag} does not apply to "${command}".`,
    onlyWith: (flag, command) => `${flag} only works with "rastro ${command}".`,
    maxFiles: '--max-files must be a positive integer.',
    watchOnly: '--watch only works when opening the map (rastro <path>).',
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
  },
  validate: {
    cannotRead: (error) => `could not read the JSON: ${error}`,
    invalid: 'invalid',
    valid: (nodes, edges, schema) =>
      `valid — ${n(nodes, 'node', 'nodes')}, ${n(edges, 'relationship', 'relationships')} (schema ${schema})`,
  },
  git: {
    notFound: 'the "git" command was not found on this system',
    failed: 'git error',
    riskyConfig: (keys) =>
      `this repository's .git/config defines commands that git would run (${keys}). ` +
      'For safety, Rastro does not run git here. If you trust the repository, use --trust-git-config.',
    badRef: (ref) => `invalid reference: ${ref}`,
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
    writeFailed: (target, why) => `Could not write ${target}: ${why}`,
    isDir: 'the destination is a folder; give a file name',
  },
  storage: {
    saveFailed: (target, why) => `Could not save the graph to ${target}: ${why}`,
    isDir: 'the destination is a folder; give a file name, e.g. -o graph.json',
    noPermission: 'no permission to write to that location',
    fileNotFound: (target) => `File not found: ${target}`,
    invalidJson: (error) => `Invalid JSON: ${error}`,
    invalidGraph: (errors) => `Invalid graph:\n- ${errors.join('\n- ')}`,
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
      `Could not open the interface starting at port ${port} (${reason}). ` +
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
