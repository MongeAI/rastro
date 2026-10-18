import { createContext, useContext, type ReactNode } from 'react';
import { kindLabels, type DiscoveryMethod, type Lang, type UnresolvedReason } from '@rastro/core';

/**
 * Textos da interface em português e inglês. O dicionário em inglês precisa ter exatamente
 * a mesma forma do português (o TypeScript acusa qualquer chave faltando).
 */
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const pt = {
  langName: 'Português',
  common: {
    close: 'Fechar detalhes',
    closeEsc: 'Fechar (Esc)',
    openInEditor: 'Abrir no editor',
    openSnippet: 'Abrir este trecho no editor',
    copied: 'Copiado!',
    copyPath: 'Copiar caminho',
    andMore: (count: number) => `… e mais ${count}.`,
    showAll: (count: number) => `Mostrar todas (${count})`,
    distance: 'distância',
    exported: 'exportado',
  },
  load: {
    loading: 'Carregando o grafo…',
    loadingAria: 'Carregando',
    invalid: (errors: string) => `O arquivo não é um grafo válido do Rastro:\n${errors}`,
    denied:
      'Acesso negado: esta página precisa do endereço completo exibido no terminal (ele inclui um token de acesso). Copie a URL que o comando "rastro" mostrou e abra de novo.',
    noGraph:
      'Nenhum grafo foi carregado. Rode "rastro <caminho-do-projeto>" no terminal, ou abra um JSON exportado pelo Rastro.',
    cannotRead: (name: string, error: string) => `Não foi possível ler ${name}: ${error}`,
    openJson: 'Abrir arquivo .json',
    dropHint: 'Você também pode arrastar o arquivo para esta janela.',
  },
  top: {
    showFilters: 'Mostrar filtros',
    hideFilters: 'Ocultar filtros',
    searchPlaceholder: 'Buscar arquivo, função, classe…',
    searchAria: 'Buscar no grafo',
    nothingFound: (q: string) => `Nada encontrado para “${q}”.`,
    summary: 'Resumo',
    summaryTitle: 'Resumo da análise',
    export: 'Exportar',
    exportTitle: 'Baixar o grafo completo em JSON',
    lightTheme: 'Tema claro',
    darkTheme: 'Tema escuro',
    useLight: 'Usar tema claro',
    useDark: 'Usar tema escuro',
    language: 'Idioma',
  },
  stage: {
    focus: 'Foco:',
    distance: (d: number) => ` · distância ${d}`,
    leave: 'sair',
    pinned: (count: number) => n(count, 'entidade expandida', 'entidades expandidas'),
    clear: 'limpar',
    back: 'Voltar',
    backTitle: 'Voltar para a seleção anterior',
    noMatch: 'Nenhum nó corresponde aos filtros atuais.',
    reset: 'Restaurar visualização',
    noFiles: 'Este projeto não tem arquivos JavaScript ou TypeScript analisáveis.',
    status: (nodes: number, edges: number) => `${nodes} nós · ${edges} relações visíveis`,
    hidden: (count: number) => ` · ${count} ocultos`,
    controls: 'Controles do mapa',
    zoomIn: 'Aproximar',
    zoomOut: 'Afastar',
    fit: 'Enquadrar tudo',
    fitShortcut: 'Enquadrar tudo (F)',
    relayout: 'Reorganizar',
    relayoutTitle: 'Reorganizar o mapa',
    savePng: 'Salvar imagem',
    savePngTitle: 'Salvar imagem PNG',
    pngFailed:
      'Não foi possível gerar a imagem deste mapa (grande demais para o navegador). Tente um nível menos detalhado ou use o foco.',
    mapAria: 'Mapa interativo do código',
    organizing: 'Organizando o mapa…',
    panelEdge: 'Detalhes da relação',
    panelNode: 'Detalhes da entidade',
    panelSummary: 'Resumo da análise',
  },
  tooltip: {
    openFolder: 'duplo clique para abrir a pasta',
    collapseFolder: 'duplo clique para recolher a pasta',
    collapseSymbols: 'duplo clique para recolher os símbolos',
    showSymbols: 'duplo clique para ver funções e classes',
    aggregated: ' · soma das relações internas',
    clickEvidence: ' · clique para ver as evidências',
  },
  sidebar: {
    aria: 'Filtros e legenda',
    level: 'Nível de detalhe',
    levels: { modules: 'Pastas', files: 'Arquivos', symbols: 'Símbolos' },
    levelHints: {
      modules:
        'Cada pasta é um bloco; as linhas somam os imports entre elas. Duplo clique abre a pasta.',
      files:
        'Arquivos agrupados por pasta. Duplo clique em um arquivo com + mostra suas funções e classes.',
      symbols: 'Funções, classes e métodos de todos os arquivos, com as chamadas entre eles.',
    },
    confirmSymbols: (count: number) =>
      `Mostrar ${count} símbolos de uma vez pode levar vários segundos e deixar o mapa difícil de ler. Dica: use a busca ou dê dois cliques nos arquivos que interessam. Continuar mesmo assim?`,
    layout: 'Organização',
    hierarchical: 'Hierárquica (fluxo de dependências)',
    organic: 'Orgânica (por proximidade)',
    nodes: 'Nós',
    reset: 'restaurar',
    edges: 'Relações',
    edgeHints: {
      contains: '',
      imports: 'arquivo → arquivo ou pacote',
      calls: 'função/método → o que ela chama',
      extends: 'classe → classe base',
      exports: 'arquivo → o que ele exporta',
      depends_on: 'pasta → pasta (derivado dos imports)',
    },
    hideTypeOnly: 'Ocultar imports só de tipo',
    highlightNeighbors: 'Destacar vizinhos ao selecionar',
    legend: 'Legenda das linhas',
    legendResolved: 'resolvida no projeto',
    legendExternal: 'externa (pacote ou Node.js)',
    legendUnresolved: 'não resolvida',
    legendDotted: 'import só de tipo / export',
    legendCycle: 'ciclo de importação',
    openFilesIn: 'Abrir arquivos em',
  },
  details: {
    unresolvedTitle: 'Referência não resolvida.',
    cycleBefore: 'Este arquivo faz parte de um ',
    cycleStrong: 'ciclo de importação',
    cycleAfter: ': ele depende, direta ou indiretamente, de quem depende dele.',
    location: 'Localização',
    explore: 'Explorar',
    focusTitle: 'Mostra só esta entidade e suas conexões',
    focus: 'Focar vizinhança',
    leaveFocus: 'Sair do foco',
    expandTitle: 'Adiciona ao mapa as entidades conectadas, mantendo o resto',
    expand: 'Expandir conexões',
    showSymbols: 'Mostrar símbolos',
    hideSymbols: 'Recolher símbolos',
    openFolder: 'Abrir pasta no mapa',
    collapseFolder: 'Recolher pasta no mapa',
    distanceLabel: 'Distância',
    noRelations: 'Nenhuma relação conhecida além da hierarquia.',
    content: 'Conteúdo',
    members: 'Membros',
    definedHere: 'Definido aqui',
    impact: 'Impacto de uma alteração',
    computeImpact: 'Calcular quem pode ser afetado',
    noImpact: 'Nenhuma entidade conhecida depende desta (considerando só relações resolvidas).',
    impactCount: (count: number) =>
      `${n(count, 'entidade depende', 'entidades dependem')} desta, direta ou indiretamente (chamadas, imports e herança resolvidos).`,
    code: 'Código',
    file: 'Arquivo:',
    chips: {
      exported: 'exportado',
      defaultExport: 'export default',
      constructor: 'construtor',
      getter: 'getter',
      setter: 'setter',
      property: 'propriedade-função',
      lines: (count: number) => `${count} linhas`,
      notAnalyzed: 'não analisado',
      builtin: 'nativo do Node.js',
      declared: 'declarado no package.json',
      undeclared: 'não declarado',
      outsideRoot: 'fora da raiz',
    },
    external: 'externo',
    unresolved: 'não resolvido',
    typeTag: 'tipo',
    reexports: 'reexporta',
  },
  edge: {
    relation: 'Relação',
    from: 'de',
    to: 'para',
    occurrences: (count: number) => n(count, 'ocorrência', 'ocorrências'),
    summed: (count: number) => n(count, 'relação somada', 'relações somadas'),
    typesOnly: 'só tipos',
    aggregatedHint:
      'Esta linha reúne várias relações do mesmo tipo entre os mesmos blocos do mapa (por exemplo, arquivos dentro de pastas recolhidas). Abra as pastas (duplo clique) para ver cada uma separadamente.',
    summedTitle: 'Relações somadas',
    evidence: 'Evidências',
    viaDeclaration: ' · ligada via declaração .d.ts',
    moreOccurrences: (count: number) => `… e mais ${count} ocorrências.`,
    moreRelations: (count: number) => `… e mais ${count} relações.`,
  },
  overview: {
    eyebrow: 'Resumo da análise',
    noFiles:
      'Nenhum arquivo JavaScript ou TypeScript foi encontrado neste projeto. Confira se o caminho está certo e se os arquivos não estão em pastas ignoradas (node_modules, dist, build ou o .gitignore).',
    cycles: 'Ciclos',
    relationsFound: 'Relações encontradas',
    relationsAria: 'Proporção de relações resolvidas, externas e não resolvidas',
    resolved: (count: number) => `${count} resolvidas no projeto`,
    external: (count: number) => `${count} externas`,
    unresolved: (count: number) => `${count} não resolvidas`,
    importCycles: 'Ciclos de importação',
    unresolvedTitle: 'Não resolvidos',
    unresolvedHint:
      'O Rastro não inventa conexões: estas referências existem no código, mas o destino não pôde ser comprovado.',
    leftOut: 'Fora do grafo, por cautela',
    externalCalls: 'Chamadas para bibliotecas e APIs nativas',
    unknownReceiver: 'Chamadas em objetos sem tipo conhecido',
    computedCalls: 'Chamadas por nome calculado (obj[x]())',
    localCalls: 'Chamadas a funções locais (declaradas dentro de outras)',
    warnings: 'Avisos',
    howTo: 'Como explorar',
    tips: [
      'Clique em um nó para ver detalhes, código e relações. Esc limpa a seleção.',
      'Dois cliques em um arquivo com “+” mostram as funções e classes dele.',
      '/ abre a busca. “Focar vizinhança” isola uma entidade e suas conexões.',
      'Linhas tracejadas vermelhas são referências que não puderam ser resolvidas.',
    ],
    analyzedAt: (date: string, ms: number, ts: string) =>
      `Analisado em ${date} · ${ms} ms · TypeScript ${ts}`,
  },
  insights: {
    tabSummary: 'Resumo',
    tabInsights: 'Insights',
    title: 'Onde olhar primeiro',
    intro: 'Rankings calculados só com relações comprovadas. Clique para ir ao mapa.',
    mostCalled: 'Mais chamados',
    mostCalledHint: 'Funções e métodos usados por mais lugares: mudanças aqui têm impacto amplo.',
    mostCalling: 'Que mais chamam',
    mostCallingHint: 'Orquestradores: dependem de muitas outras partes.',
    mostImported: 'Arquivos centrais',
    mostImportedHint: 'Importados por mais arquivos.',
    mostDependencies: 'Arquivos com mais dependências',
    mostDependenciesHint: 'Importam mais arquivos do projeto.',
    largestFiles: 'Maiores arquivos',
    coupled: 'Pastas mais acopladas',
    coupledHint: 'Pares de pastas com mais imports entre si.',
    unusedInternal: 'Possivelmente sem uso',
    unusedExported: 'Exportados sem uso no projeto',
    unusedHint:
      'Ninguém chama e o nome só aparece na declaração. Confira antes de apagar: o código pode ser usado de forma dinâmica.',
    unusedExportedHint:
      'Podem ser API pública usada por quem instala o pacote, ou realmente sobras.',
    callers: (count: number) => n(count, 'chamador', 'chamadores'),
    callees: (count: number) => n(count, 'chamada', 'chamadas'),
    importers: (count: number) => n(count, 'arquivo', 'arquivos'),
    lines: (count: number) => n(count, 'linha', 'linhas'),
    imports: (count: number) => n(count, 'import', 'imports'),
    none: 'Nada a mostrar aqui.',
  },
  source: {
    unavailable:
      'O código não está disponível neste modo (grafo aberto a partir de um arquivo JSON). Use o caminho e as linhas acima para localizar o trecho no editor.',
    failed: (error: string) => `Não foi possível carregar o código: ${error}`,
    aria: (file: string, from: number, to: number) => `Código de ${file}, linhas ${from} a ${to}`,
    showWhole: (lines: number) => `Ver arquivo inteiro (${lines} linhas)`,
  },
  reasons: {
    'module-not-found': 'O arquivo importado não foi encontrado no projeto.',
    'undeclared-package':
      'Parece um pacote, mas não está no package.json nem em node_modules (ou é um alias que não foi resolvido).',
    'symbol-not-found': 'Não existe declaração conhecida para este nome no código analisado.',
    'indirect-call':
      'Chamada feita por meio de uma variável, parâmetro ou interface. O alvo real só é conhecido durante a execução.',
    'dynamic-import':
      'O caminho do módulo é calculado em tempo de execução, então não pode ser resolvido estaticamente.',
    'unknown-base-class': 'A classe base não pôde ser localizada.',
    'not-analyzed':
      'O alvo está em um arquivo do projeto que ficou fora da análise (excluído, ignorado pelo .gitignore ou grande demais).',
  } satisfies Record<UnresolvedReason, string>,
  discovery: {
    'static-ast': 'lido da árvore sintática',
    'static-typecheck': 'confirmado pelo verificador de tipos',
    derived: 'derivado de outras relações',
    'framework-rule': 'regra de framework',
  } satisfies Record<DiscoveryMethod, string>,
};

export type Messages = typeof pt;

const en: Messages = {
  langName: 'English',
  common: {
    close: 'Close details',
    closeEsc: 'Close (Esc)',
    openInEditor: 'Open in editor',
    openSnippet: 'Open this snippet in the editor',
    copied: 'Copied!',
    copyPath: 'Copy path',
    andMore: (count) => `… and ${count} more.`,
    showAll: (count) => `Show all (${count})`,
    distance: 'distance',
    exported: 'exported',
  },
  load: {
    loading: 'Loading the graph…',
    loadingAria: 'Loading',
    invalid: (errors) => `This file is not a valid Rastro graph:\n${errors}`,
    denied:
      'Access denied: this page needs the full address printed in the terminal (it includes an access token). Copy the URL shown by the "rastro" command and open it again.',
    noGraph:
      'No graph was loaded. Run "rastro <project-path>" in your terminal, or open a JSON file exported by Rastro.',
    cannotRead: (name, error) => `Could not read ${name}: ${error}`,
    openJson: 'Open .json file',
    dropHint: 'You can also drop the file onto this window.',
  },
  top: {
    showFilters: 'Show filters',
    hideFilters: 'Hide filters',
    searchPlaceholder: 'Search files, functions, classes…',
    searchAria: 'Search the graph',
    nothingFound: (q) => `Nothing found for “${q}”.`,
    summary: 'Summary',
    summaryTitle: 'Analysis summary',
    export: 'Export',
    exportTitle: 'Download the full graph as JSON',
    lightTheme: 'Light theme',
    darkTheme: 'Dark theme',
    useLight: 'Use light theme',
    useDark: 'Use dark theme',
    language: 'Language',
  },
  stage: {
    focus: 'Focus:',
    distance: (d) => ` · distance ${d}`,
    leave: 'exit',
    pinned: (count) => n(count, 'expanded entity', 'expanded entities'),
    clear: 'clear',
    back: 'Back',
    backTitle: 'Back to the previous selection',
    noMatch: 'No node matches the current filters.',
    reset: 'Reset view',
    noFiles: 'This project has no JavaScript or TypeScript files to analyze.',
    status: (nodes, edges) => `${nodes} nodes · ${edges} visible relationships`,
    hidden: (count) => ` · ${count} hidden`,
    controls: 'Map controls',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    fit: 'Fit to screen',
    fitShortcut: 'Fit to screen (F)',
    relayout: 'Re-layout',
    relayoutTitle: 'Re-arrange the map',
    savePng: 'Save image',
    savePngTitle: 'Save PNG image',
    pngFailed:
      'Could not render this map as an image (too large for the browser). Try a less detailed level or use focus.',
    mapAria: 'Interactive code map',
    organizing: 'Arranging the map…',
    panelEdge: 'Relationship details',
    panelNode: 'Entity details',
    panelSummary: 'Analysis summary',
  },
  tooltip: {
    openFolder: 'double-click to open the folder',
    collapseFolder: 'double-click to collapse the folder',
    collapseSymbols: 'double-click to hide the symbols',
    showSymbols: 'double-click to show functions and classes',
    aggregated: ' · sum of inner relationships',
    clickEvidence: ' · click to see the evidence',
  },
  sidebar: {
    aria: 'Filters and legend',
    level: 'Level of detail',
    levels: { modules: 'Folders', files: 'Files', symbols: 'Symbols' },
    levelHints: {
      modules:
        'Each folder is a block; lines add up the imports between them. Double-click opens a folder.',
      files:
        'Files grouped by folder. Double-click a file marked + to see its functions and classes.',
      symbols: 'Functions, classes and methods of every file, with the calls between them.',
    },
    confirmSymbols: (count) =>
      `Showing ${count} symbols at once may take several seconds and make the map hard to read. Tip: use search or double-click only the files you care about. Continue anyway?`,
    layout: 'Layout',
    hierarchical: 'Hierarchical (dependency flow)',
    organic: 'Organic (by proximity)',
    nodes: 'Nodes',
    reset: 'reset',
    edges: 'Relationships',
    edgeHints: {
      contains: '',
      imports: 'file → file or package',
      calls: 'function/method → what it calls',
      extends: 'class → base class',
      exports: 'file → what it exports',
      depends_on: 'folder → folder (derived from imports)',
    },
    hideTypeOnly: 'Hide type-only imports',
    highlightNeighbors: 'Highlight neighbors on selection',
    legend: 'Line legend',
    legendResolved: 'resolved in the project',
    legendExternal: 'external (package or Node.js)',
    legendUnresolved: 'unresolved',
    legendDotted: 'type-only import / export',
    legendCycle: 'import cycle',
    openFilesIn: 'Open files in',
  },
  details: {
    unresolvedTitle: 'Unresolved reference.',
    cycleBefore: 'This file is part of an ',
    cycleStrong: 'import cycle',
    cycleAfter: ': it depends, directly or indirectly, on files that depend on it.',
    location: 'Location',
    explore: 'Explore',
    focusTitle: 'Show only this entity and its connections',
    focus: 'Focus neighborhood',
    leaveFocus: 'Exit focus',
    expandTitle: 'Add the connected entities to the map, keeping everything else',
    expand: 'Expand connections',
    showSymbols: 'Show symbols',
    hideSymbols: 'Hide symbols',
    openFolder: 'Open folder on the map',
    collapseFolder: 'Collapse folder on the map',
    distanceLabel: 'Distance',
    noRelations: 'No known relationships besides the hierarchy.',
    content: 'Contents',
    members: 'Members',
    definedHere: 'Defined here',
    impact: 'Impact of a change',
    computeImpact: 'Find what could be affected',
    noImpact: 'No known entity depends on this one (counting resolved relationships only).',
    impactCount: (count) =>
      `${n(count, 'entity depends', 'entities depend')} on this one, directly or indirectly (resolved calls, imports and inheritance).`,
    code: 'Code',
    file: 'File:',
    chips: {
      exported: 'exported',
      defaultExport: 'export default',
      constructor: 'constructor',
      getter: 'getter',
      setter: 'setter',
      property: 'function property',
      lines: (count) => `${count} lines`,
      notAnalyzed: 'not analyzed',
      builtin: 'Node.js built-in',
      declared: 'declared in package.json',
      undeclared: 'not declared',
      outsideRoot: 'outside the root',
    },
    external: 'external',
    unresolved: 'unresolved',
    typeTag: 'type',
    reexports: 're-exports',
  },
  edge: {
    relation: 'Relationship',
    from: 'from',
    to: 'to',
    occurrences: (count) => n(count, 'occurrence', 'occurrences'),
    summed: (count) => n(count, 'combined relationship', 'combined relationships'),
    typesOnly: 'types only',
    aggregatedHint:
      'This line combines several relationships of the same kind between the same blocks on the map (for example, files inside collapsed folders). Open the folders (double-click) to see each one separately.',
    summedTitle: 'Combined relationships',
    evidence: 'Evidence',
    viaDeclaration: ' · linked through a .d.ts declaration',
    moreOccurrences: (count) => `… and ${count} more occurrences.`,
    moreRelations: (count) => `… and ${count} more relationships.`,
  },
  overview: {
    eyebrow: 'Analysis summary',
    noFiles:
      'No JavaScript or TypeScript files were found in this project. Check that the path is right and that the files are not in ignored folders (node_modules, dist, build or .gitignore).',
    cycles: 'Cycles',
    relationsFound: 'Relationships found',
    relationsAria: 'Share of resolved, external and unresolved relationships',
    resolved: (count) => `${count} resolved in the project`,
    external: (count) => `${count} external`,
    unresolved: (count) => `${count} unresolved`,
    importCycles: 'Import cycles',
    unresolvedTitle: 'Unresolved',
    unresolvedHint:
      'Rastro does not invent connections: these references exist in the code, but their target could not be proven.',
    leftOut: 'Left out of the graph, on purpose',
    externalCalls: 'Calls into libraries and built-in APIs',
    unknownReceiver: 'Calls on objects of unknown type',
    computedCalls: 'Calls by computed name (obj[x]())',
    localCalls: 'Calls to local functions (declared inside others)',
    warnings: 'Warnings',
    howTo: 'How to explore',
    tips: [
      'Click a node to see its details, code and relationships. Esc clears the selection.',
      'Double-click a file marked “+” to see its functions and classes.',
      '/ opens search. “Focus neighborhood” isolates an entity and its connections.',
      'Dashed red lines are references that could not be resolved.',
    ],
    analyzedAt: (date, ms, ts) => `Analyzed on ${date} · ${ms} ms · TypeScript ${ts}`,
  },
  insights: {
    tabSummary: 'Summary',
    tabInsights: 'Insights',
    title: 'Where to look first',
    intro: 'Rankings computed from proven relationships only. Click to jump to the map.',
    mostCalled: 'Most called',
    mostCalledHint:
      'Functions and methods used from the most places: changes here have wide impact.',
    mostCalling: 'Calling the most',
    mostCallingHint: 'Orchestrators: they depend on many other parts.',
    mostImported: 'Central files',
    mostImportedHint: 'Imported by the most files.',
    mostDependencies: 'Files with the most dependencies',
    mostDependenciesHint: 'They import the most project files.',
    largestFiles: 'Largest files',
    coupled: 'Most coupled folders',
    coupledHint: 'Folder pairs with the most imports between them.',
    unusedInternal: 'Possibly unused',
    unusedExported: 'Exported but unused in the project',
    unusedHint:
      'Nothing calls it and its name only appears in its declaration. Double-check before deleting: it may be used dynamically.',
    unusedExportedHint:
      'They may be public API used by whoever installs the package, or real leftovers.',
    callers: (count) => n(count, 'caller', 'callers'),
    callees: (count) => n(count, 'callee', 'callees'),
    importers: (count) => n(count, 'file', 'files'),
    lines: (count) => n(count, 'line', 'lines'),
    imports: (count) => n(count, 'import', 'imports'),
    none: 'Nothing to show here.',
  },
  source: {
    unavailable:
      'Source code is not available in this mode (graph opened from a JSON file). Use the path and lines above to find the snippet in your editor.',
    failed: (error) => `Could not load the code: ${error}`,
    aria: (file, from, to) => `Code of ${file}, lines ${from} to ${to}`,
    showWhole: (lines) => `View the whole file (${lines} lines)`,
  },
  reasons: {
    'module-not-found': 'The imported file was not found in the project.',
    'undeclared-package':
      'It looks like a package, but it is not in package.json or node_modules (or it is an alias that could not be resolved).',
    'symbol-not-found': 'There is no known declaration for this name in the analyzed code.',
    'indirect-call':
      'A call through a variable, parameter or interface. The real target is only known at runtime.',
    'dynamic-import':
      'The module path is computed at runtime, so it cannot be resolved statically.',
    'unknown-base-class': 'The base class could not be located.',
    'not-analyzed':
      'The target lives in a project file that was left out of the analysis (excluded, ignored by .gitignore or too large).',
  },
  discovery: {
    'static-ast': 'read from the syntax tree',
    'static-typecheck': 'confirmed by the type checker',
    derived: 'derived from other relationships',
    'framework-rule': 'framework rule',
  },
};

export const MESSAGES: Record<Lang, Messages> = { pt, en };

/** Idioma inicial: o salvo pelo usuário ou o do navegador (português para pt-*, inglês para o resto). */
export function detectLang(saved: string | null): Lang {
  if (saved === 'pt' || saved === 'en') return saved;
  const langs =
    typeof navigator !== 'undefined' ? (navigator.languages ?? [navigator.language]) : [];
  return langs.some((l) => l?.toLowerCase().startsWith('pt')) ? 'pt' : 'en';
}

interface I18n {
  lang: Lang;
  t: Messages;
  /** Rótulos de tipos de nó/relação/resolução no idioma atual. */
  labels: ReturnType<typeof kindLabels>;
  locale: string;
}

const I18nContext = createContext<I18n>({
  lang: 'pt',
  t: pt,
  labels: kindLabels('pt'),
  locale: 'pt-BR',
});

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const value: I18n = {
    lang,
    t: MESSAGES[lang],
    labels: kindLabels(lang),
    locale: lang === 'pt' ? 'pt-BR' : 'en-US',
  };
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}
