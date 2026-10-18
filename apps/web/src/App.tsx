import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  graphIssues,
  nodeId,
  validateGraph,
  validationText,
  type EdgeKind,
  type Lang,
  type NodeKind,
  type RastroGraph,
} from '@rastro/core';
import {
  checkRules,
  computeChangeImpact,
  computeView,
  findPaths,
  GraphIndex,
  graphRules,
  groupableModules,
  initialOpenModules,
  type RulesCheck,
  type RuleViolation,
} from '@rastro/graph';
import { ChangesPanel } from './components/ChangesPanel';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { DetailsPanel } from './components/DetailsPanel';
import { EdgeDetails } from './components/EdgeDetails';
import {
  GraphCanvas,
  type Direction,
  type GraphCanvasHandle,
  type LayoutMode,
} from './components/GraphCanvas';
import {
  IconBack,
  IconCommand,
  IconDownload,
  IconFit,
  IconImage,
  IconInfo,
  IconKeyboard,
  IconLayout,
  IconMenu,
  IconMinimap,
  IconMinus,
  IconMoon,
  IconPlus,
  IconSun,
  Logo,
} from './components/Icons';
import { Insights } from './components/Insights';
import { Overview } from './components/Overview';
import { PathPanel } from './components/PathPanel';
import { RulesPanel } from './components/RulesPanel';
import { Search } from './components/Search';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { clearSourceCache } from './components/SourceView';
import { NODE_KIND_ORDER, Sidebar } from './components/Sidebar';
import { downloadBlob, downloadText, slug } from './lib/download';
import { copyText, EDITORS, readPref, writePref, type EditorId } from './lib/editor';
import type { Level } from './lib/levels';
import { detectLang, I18nProvider, useI18n, type Messages } from './lib/i18n';
import { entityName } from './lib/names';
import { displayPath } from './lib/paths';
import { PALETTES, type ThemeName } from './lib/theme';

type Load =
  | { status: 'loading' }
  | { status: 'ready'; graph: RastroGraph; fromServer: boolean; updatedAt?: number }
  | { status: 'error'; message: (t: Messages, lang: Lang) => string; canPickFile: boolean };

/** Versão do grafo informada pelo servidor (modo --watch). */
const versionOf = (res: Response) => Number(res.headers.get('X-Rastro-Version')) || 0;

const DEFAULT_EDGES: EdgeKind[] = ['imports', 'calls', 'extends'];
/** Pacotes externos começam ocultos no mapa para não poluir; continuam nos filtros e nos detalhes. */
const DEFAULT_NODES: NodeKind[] = NODE_KIND_ORDER.filter((k) => k !== 'package');
const SYMBOL_KINDS: NodeKind[] = ['function', 'class', 'method', 'route'];
/**
 * Nível de símbolos em projetos grandes: acima de CONFIRM pede confirmação; acima de SLOW avisa
 * que pode levar minutos; acima de MAX não é oferecido (no Chrome, ~6 mil símbolos levam uns
 * 15 s e ~30 mil, vários minutos com a página travada).
 */
const SYMBOLS_CONFIRM = 1000;
const SYMBOLS_SLOW = 5000;
const SYMBOLS_MAX = 20000;

export function App() {
  // idioma: o escolhido pelo usuário ou o do navegador
  const [lang, setLang] = useState<Lang>(() =>
    detectLang(readPref('lang', '', ['pt', 'en']) || null),
  );
  useEffect(() => {
    writePref('lang', lang);
    document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
  }, [lang]);
  return (
    <I18nProvider lang={lang}>
      <Loader onLang={setLang} />
    </I18nProvider>
  );
}

function Loader({ onLang }: { onLang(lang: Lang): void }) {
  const { t, lang } = useI18n();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  /** Versão do grafo mostrado (cabeçalho X-Rastro-Version do servidor; 0 = desconhecida). */
  const graphVersion = useRef(0);

  const openGraph = useCallback((data: unknown, fromServer: boolean) => {
    const result = graphIssues(data, 5);
    if (!result.valid) {
      setLoad({
        status: 'error',
        // os problemas vêm com código: o texto sai no idioma atual da interface
        message: (tr, lang) =>
          tr.load.invalid(result.issues.map((issue) => validationText(issue, lang)).join('\n')),
        canPickFile: true,
      });
      return;
    }
    setLoad({ status: 'ready', graph: data as RastroGraph, fromServer });
  }, []);

  useEffect(() => {
    // Relatório HTML offline (`rastro export --format html`): o grafo vem embutido na própria
    // página e não há servidor. Sem servidor, o código-fonte fica indisponível (fromServer=false).
    const embedded = document.getElementById('rastro-graph');
    if (embedded) {
      try {
        openGraph(JSON.parse(embedded.textContent ?? ''), false);
      } catch (err) {
        setLoad({
          status: 'error',
          message: (t) => t.load.corruptReport((err as Error).message),
          canPickFile: true,
        });
      }
      return;
    }
    fetch('/api/graph')
      .then(async (res) => {
        if (res.status === 401) {
          setLoad({
            status: 'error',
            message: (tr) => tr.load.denied,
            canPickFile: true,
          });
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        graphVersion.current = versionOf(res);
        openGraph(await res.json(), true);
      })
      .catch(() =>
        setLoad({
          status: 'error',
          message: (tr) => tr.load.noGraph,
          canPickFile: true,
        }),
      );
  }, [openGraph]);

  // modo ao vivo (--watch): o servidor avisa quando o grafo muda; trocamos sem recarregar a página
  const live = load.status === 'ready' && load.fromServer;
  useEffect(() => {
    if (!live || typeof EventSource === 'undefined') return;
    const events = new EventSource('/api/events');
    // cada grafo tem uma versão: respostas fora de ordem ou repetidas são descartadas, e uma
    // reconexão ("hello") com versão mais nova busca o que foi perdido
    const refresh = (announced: number) => {
      fetch('/api/graph')
        .then(async (res) => {
          if (!res.ok) return;
          const version = versionOf(res) || announced;
          if (version && version <= graphVersion.current) return;
          const data: unknown = await res.json();
          if (!validateGraph(data).valid) return;
          if (version && version <= graphVersion.current) return;
          graphVersion.current = version;
          clearSourceCache();
          setLoad({
            status: 'ready',
            graph: data as RastroGraph,
            fromServer: true,
            updatedAt: Date.now(),
          });
        })
        .catch(() => {});
    };
    const versionIn = (e: MessageEvent<string>) => {
      try {
        return Number((JSON.parse(e.data) as { version?: unknown }).version) || 0;
      } catch {
        return 0;
      }
    };
    // "hello" (conexão ou reconexão) só busca se o servidor já tiver um grafo mais novo
    events.addEventListener('hello', (e: MessageEvent<string>) => {
      const version = versionIn(e);
      // versão do grafo inicial desconhecida: o que acabou de ser carregado é o atual
      if (!graphVersion.current) graphVersion.current = version;
      else if (version > graphVersion.current) refresh(version);
    });
    events.addEventListener('graph', (e: MessageEvent<string>) => {
      const version = versionIn(e);
      if (!version || version > graphVersion.current) refresh(version);
    });
    return () => events.close();
  }, [live]);

  const readFile = (file: File) => {
    file
      .text()
      .then((text) => openGraph(JSON.parse(text), false))
      .catch((err: Error) =>
        setLoad({
          status: 'error',
          message: (tr) => tr.load.cannotRead(file.name, err.message),
          canPickFile: true,
        }),
      );
  };

  if (load.status === 'loading') {
    return (
      <div className="screen-center">
        <Logo size={36} />
        <div className="spinner" aria-label={t.load.loadingAria} />
        <p className="muted">{t.load.loading}</p>
      </div>
    );
  }
  if (load.status === 'error') {
    return (
      <div
        className="screen-center"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (file) readFile(file);
        }}
      >
        <Logo size={36} />
        <h1 className="screen-title">Rastro</h1>
        <p className="screen-message">{load.message(t, lang)}</p>
        {load.canPickFile && (
          <label className="button">
            {t.load.openJson}
            <input
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])}
            />
          </label>
        )}
        <p className="muted small">{t.load.dropHint}</p>
      </div>
    );
  }
  return (
    <Explorer
      key={load.graph.project.root}
      graph={load.graph}
      fromServer={load.fromServer}
      updatedAt={load.updatedAt}
      onLang={onLang}
    />
  );
}

/** Nível inicial: projetos grandes abrem no nível de pastas; os pequenos, direto nos arquivos. */
const level0 = (groupable: number, files: number): Level =>
  groupable > 3 && files > 60 ? 'modules' : 'files';

type PanelTab = 'summary' | 'insights' | 'changes' | 'rules';

/** Contador da aba Regras: violações (vermelho quando há erros) ou "!" para um arquivo inválido. */
function RulesCount({ check }: { check: RulesCheck | null }) {
  if (!check) return <span className="tab-count bad">!</span>;
  const total = check.errors + check.warnings;
  if (!total) return null;
  return <span className={`tab-count${check.errors ? ' bad' : ''}`}>{total}</span>;
}

function Explorer({
  graph,
  fromServer,
  updatedAt,
  onLang,
}: {
  graph: RastroGraph;
  fromServer: boolean;
  /** Quando o grafo foi atualizado ao vivo (modo --watch). */
  updatedAt?: number;
  onLang(lang: Lang): void;
}) {
  const { t, lang, locale } = useI18n();
  const index = useMemo(() => new GraphIndex(graph), [graph]);
  const groupable = useMemo(() => groupableModules(index), [index]);
  const groupableSet = useMemo(() => new Set(groupable), [groupable]);
  const canvas = useRef<GraphCanvasHandle>(null);

  const [theme, setTheme] = useState<ThemeName>(() =>
    readPref<ThemeName>(
      'theme',
      window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
      ['dark', 'light'],
    ),
  );
  const [editor, setEditor] = useState<EditorId>(() =>
    readPref<EditorId>('editor', 'vscode', Object.keys(EDITORS)),
  );
  const [layout, setLayout] = useState<LayoutMode>(() =>
    readPref<LayoutMode>('layout', 'hierarchical', ['hierarchical', 'organic']),
  );
  const [level, setLevelState] = useState<Level>(() => level0(groupable.length, graph.stats.files));
  /** Pastas abertas de início no nível "pastas" (ex.: o `src/` de um projeto todo dentro dele). */
  const autoOpen = useMemo(() => initialOpenModules(index, groupable), [index, groupable]);
  /** No nível "pastas" guarda as pastas abertas; nos outros, as pastas recolhidas. */
  const [moduleToggles, setModuleToggles] = useState<Set<string>>(() =>
    level0(groupable.length, graph.stats.files) === 'modules' ? new Set(autoOpen) : new Set(),
  );
  const [nodeKinds, setNodeKinds] = useState<Set<NodeKind>>(() => new Set(DEFAULT_NODES));
  const [edgeKinds, setEdgeKinds] = useState<Set<EdgeKind>>(() => new Set(DEFAULT_EDGES));
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(() => new Set());
  const [pinned, setPinned] = useState<Set<string>>(() => new Set());
  const [focus, setFocus] = useState<{ id: string; depth: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [hideTypeOnly, setHideTypeOnly] = useState(false);
  const [highlightNeighbors, setHighlightNeighbors] = useState(true);
  const [centerRequest, setCenterRequest] = useState<{
    id: string;
    seq: number;
    fitIds?: string[];
  } | null>(null);
  /** Gaveta de filtros em telas estreitas. */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** Painel de filtros recolhido em telas largas (o mapa ganha a largura). */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => readPref<'shown' | 'hidden'>('sidebar', 'shown', ['shown', 'hidden']) === 'hidden',
  );
  const [history, setHistory] = useState<string[]>([]);
  // com mudanças do git, a aba "Mudanças" abre primeiro
  const [panelTab, setPanelTab] = useState<PanelTab>(() =>
    graph.changes?.files.length ? 'changes' : 'summary',
  );
  const [highlightChanges, setHighlightChanges] = useState(true);
  const [highlightRules, setHighlightRules] = useState(true);
  /** Caminho A → B: origem escolhida e, depois, o destino. */
  const [pathMode, setPathMode] = useState<{ from: string; to?: string } | null>(null);
  const [activePath, setActivePath] = useState(0);
  const [pathOnly, setPathOnly] = useState(true);
  const [searchFocus, setSearchFocus] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [minimap, setMinimap] = useState(
    () => readPref<'shown' | 'hidden'>('minimap', 'shown', ['shown', 'hidden']) === 'shown',
  );
  const pathModeRef = useRef(pathMode);
  pathModeRef.current = pathMode;
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writePref('theme', theme);
  }, [theme]);
  useEffect(() => writePref('editor', editor), [editor]);
  useEffect(() => writePref('layout', layout), [layout]);
  useEffect(() => writePref('sidebar', sidebarCollapsed ? 'hidden' : 'shown'), [sidebarCollapsed]);
  useEffect(() => writePref('minimap', minimap ? 'shown' : 'hidden'), [minimap]);
  useEffect(() => {
    document.title = `${graph.project.name} · Rastro`;
  }, [graph.project.name]);

  const collapsedModules = useMemo(
    () =>
      level === 'modules'
        ? new Set(groupable.filter((id) => !moduleToggles.has(id)))
        : moduleToggles,
    [level, groupable, moduleToggles],
  );

  const baseView = useMemo(() => {
    const v = computeView(index, {
      nodeKinds,
      edgeKinds,
      expandedFiles,
      expandAll: level === 'symbols',
      collapsedModules,
      pinned,
      ...(focus ? { focus } : {}),
    });
    return hideTypeOnly ? { ...v, edges: v.edges.filter((e) => !e.typeOnly) } : v;
  }, [
    index,
    nodeKinds,
    edgeKinds,
    expandedFiles,
    level,
    collapsedModules,
    pinned,
    focus,
    hideTypeOnly,
  ]);

  const pathResult = useMemo(
    () => (pathMode?.to ? findPaths(index, pathMode.from, pathMode.to) : null),
    [index, pathMode],
  );
  /**
   * Com um caminho na tela, o mapa mostra só ele (os passos e as pastas/arquivos que os
   * contêm): no mapa inteiro, passos em pastas distantes ficam pequenos demais para ler.
   */
  const view = useMemo(() => {
    if (!pathOnly || !pathResult?.paths.length) return baseView;
    const byId = new Map(baseView.nodes.map((n) => [n.id, n]));
    // só a opção escolhida: as alternativas aparecem ao serem escolhidas no painel
    const path = pathResult.paths[activePath] ?? pathResult.paths[0]!;
    const pathEdges = new Set(path.edges.map((e) => e.id));
    const keep = new Set<string>();
    for (const id of path.nodes) {
      // o passo, ou quem o representa no mapa (ex.: o arquivo recolhido que contém a função)
      let cur =
        byId.get(id) ??
        index
          .ancestors(id)
          .map((a) => byId.get(a.id))
          .find((n) => !!n);
      for (; cur && !keep.has(cur.id); cur = cur.parent ? byId.get(cur.parent) : undefined)
        keep.add(cur.id);
    }
    const nodes = baseView.nodes.filter((n) => keep.has(n.id));
    return {
      ...baseView,
      nodes,
      edges: baseView.edges.filter(
        (e) => keep.has(e.source) && keep.has(e.target) && e.members.some((m) => pathEdges.has(m)),
      ),
      hiddenCount: baseView.hiddenCount + baseView.nodes.length - nodes.length,
    };
  }, [baseView, pathOnly, pathResult, activePath, index]);

  const symbolCount = SYMBOL_KINDS.reduce((acc, k) => acc + (graph.stats.nodesByKind[k] ?? 0), 0);

  /** Muitos símbolos de uma vez: pede confirmação no próprio mapa (sem travar a página). */
  const [confirmSymbols, setConfirmSymbols] = useState(false);
  const requestLevel = (next: Level) => {
    if (next === 'symbols' && level !== 'symbols' && symbolCount > SYMBOLS_CONFIRM) {
      setConfirmSymbols(true);
      return;
    }
    setConfirmSymbols(false);
    setLevel(next);
  };

  const setLevel = (next: Level) => {
    setLevelState(next);
    setModuleToggles(new Set(next === 'modules' ? autoOpen : []));
    setPinned(new Set());
  };

  /** Abre (ou recolhe) uma pasta, respeitando o significado de `moduleToggles` em cada nível. */
  const setModuleOpen = useCallback(
    (moduleId: string, open: boolean) =>
      setModuleToggles((s) => {
        const next = new Set(s);
        const add = level === 'modules' ? open : !open;
        if (add) next.add(moduleId);
        else next.delete(moduleId);
        return next;
      }),
    [level],
  );

  /** Garante que um nó apareça no mapa, seleciona e (opcionalmente) centraliza. */
  const navigate = useCallback(
    (id: string, remember = true, center = true) => {
      const node = index.node(id);
      if (!node) return;
      // escolhendo o destino de um caminho: a próxima entidade escolhida vira o destino
      const picking = pathModeRef.current;
      if (picking && !picking.to && id !== picking.from) {
        setPathMode({ from: picking.from, to: id });
        setActivePath(0);
        return;
      }
      if (focus && focus.id !== id) {
        const hood = index.neighborhood(focus.id, focus.depth, [...edgeKinds]);
        if (!hood.has(id)) setFocus({ id, depth: focus.depth });
      }
      // pasta sem arquivos diretos (ex.: packages/) não aparece no mapa: centraliza na primeira
      // subpasta que aparece
      let centerOn = id;
      if (node.kind === 'module' && !groupableSet.has(id)) {
        const sub = index.descendants(id).find((d) => groupableSet.has(d.id));
        if (sub) centerOn = sub.id;
      }
      // abre as pastas recolhidas que escondem o nó
      for (const ancestor of index.ancestors(centerOn))
        if (collapsedModules.has(ancestor.id)) setModuleOpen(ancestor.id, true);
      const file = index.fileOf(id);
      if (file && file.id !== id)
        setExpandedFiles((s) => (s.has(file.id) ? s : new Set(s).add(file.id)));
      if (!nodeKinds.has(node.kind)) setPinned((s) => new Set(s).add(id));
      const prev = selectedRef.current;
      if (remember && prev && prev !== id) setHistory((h) => [...h.slice(-30), prev]);
      setSelectedId(id);
      setSelectedEdgeId(null);
      if (center) setCenterRequest((r) => ({ id: centerOn, seq: (r?.seq ?? 0) + 1 }));
    },
    [index, focus, edgeKinds, nodeKinds, collapsedModules, setModuleOpen, groupableSet],
  );

  // a versão mais recente de navigate, para efeitos que não devem depender dela
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // link direto: #n=<id> na URL seleciona a entidade (ao abrir e quando a URL muda)
  useEffect(() => {
    const fromHash = () => {
      const id = new URLSearchParams(window.location.hash.slice(1)).get('n');
      // voltar enquanto escolhe o destino de um caminho cancela a escolha (não vira o destino)
      if (pathModeRef.current && !pathModeRef.current.to) {
        pathModeRef.current = null;
        setPathMode(null);
      }
      if (id && index.node(id) && id !== selectedRef.current) navigateRef.current(id, false);
      // voltar (no navegador) até antes da primeira seleção limpa a seleção
      else if (!id && selectedRef.current) setSelectedId(null);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [index]);

  // ao trocar de nível, a seleção é levada para onde ela aparece no novo nível
  const previousLevel = useRef(level);
  useEffect(() => {
    if (previousLevel.current === level) return;
    previousLevel.current = level;
    if (selectedRef.current) navigateRef.current(selectedRef.current, false);
  }, [level]);
  useEffect(() => {
    try {
      // cada seleção vira uma entrada do histórico: o botão Voltar do navegador percorre as
      // seleções em vez de sair do Rastro
      const hash = selectedId ? `#n=${encodeURIComponent(selectedId)}` : '';
      if (window.location.hash === hash) return;
      if (selectedId) window.history.pushState(null, '', hash);
      else window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch {
      // ambientes sem history (ex.: arquivo local) apenas ignoram
    }
  }, [selectedId]);

  // nova análise (--watch) sem a entidade selecionada (apagada ou renomeada): limpa a seleção
  // e o histórico interno, em vez de manter um id que não existe mais
  useEffect(() => {
    if (selectedRef.current && !index.node(selectedRef.current)) setSelectedId(null);
    setHistory((h) => (h.every((id) => index.node(id)) ? h : h.filter((id) => index.node(id))));
  }, [index]);

  const goBack = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    navigate(prev, false);
  };

  const toggleExpand = useCallback((fileId: string) => {
    setExpandedFiles((s) => {
      const next = new Set(s);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }, []);

  /** Duplo clique no mapa. */
  const activate = (id: string) => {
    const node = index.node(id);
    if (!node) return;
    if (node.kind === 'module') {
      setModuleOpen(id, collapsedModules.has(id));
      return;
    }
    if (node.kind === 'file' && level !== 'symbols') toggleExpand(id);
  };

  const expandNeighbors = (id: string) => {
    const hood = index.neighborhood(id, 1, [...edgeKinds]);
    for (const n of hood)
      for (const ancestor of index.ancestors(n))
        if (collapsedModules.has(ancestor.id)) setModuleOpen(ancestor.id, true);
    setPinned((s) => new Set([...s, ...hood]));
    if (index.node(id)?.kind === 'file') setExpandedFiles((s) => new Set(s).add(id));
  };

  const toggleSet = <T,>(setter: (fn: (s: Set<T>) => Set<T>) => void, value: T) =>
    setter((s) => {
      const next = new Set(s);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });

  const resetView = () => {
    setNodeKinds(new Set(DEFAULT_NODES));
    setEdgeKinds(new Set(DEFAULT_EDGES));
    setExpandedFiles(new Set());
    setModuleToggles(new Set());
    setPinned(new Set());
    setFocus(null);
    setHideTypeOnly(false);
  };

  /** Setas: vai para o nó mais próximo naquela direção (ou o do centro, sem seleção). */
  const moveSelection = (direction: Direction) => {
    const next = canvas.current?.nearest(selectedId, direction);
    if (!next) return;
    navigate(next, false, false);
    canvas.current?.reveal(next);
  };
  const goToParent = () => {
    const parent = selectedId ? index.node(selectedId)?.parent : undefined;
    if (parent) navigate(parent);
  };

  // atalhos globais; o manipulador muda a cada render, o ouvinte é registrado uma vez
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  onKeyRef.current = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey) {
      e.preventDefault();
      setShortcutsOpen(false);
      setPaletteOpen((o) => !o);
      return;
    }
    if (paletteOpen || shortcutsOpen) {
      // com o foco fora do diálogo (ex.: depois de um clique dentro dele), Esc ainda fecha
      if (e.key === 'Escape') {
        setPaletteOpen(false);
        setShortcutsOpen(false);
      }
      return;
    }
    if (e.isComposing) return;
    const target = e.target;
    const typing =
      (target instanceof HTMLInputElement &&
        !['checkbox', 'radio', 'button'].includes(target.type)) ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    if (typing || e.ctrlKey || e.metaKey) return;
    // setas e Enter têm significado próprio em controles, listas e painéis (que rolam com as
    // setas); no mapa ou sem foco, navegam pelo mapa
    const control =
      target instanceof Element &&
      !!target.closest('button, a, input, select, textarea, [role="button"]');
    const onMap =
      target === document.body ||
      (target instanceof Element && !!target.closest('.graph-canvas, .stage') && !control);
    const arrowsFree =
      !(target instanceof Element) ||
      !target.closest(
        '[role="listbox"], [role="tablist"], [role="radiogroup"], pre, .panel, .sidebar, select',
      );
    const picking = !!pathModeRef.current && !pathModeRef.current.to;
    const arrows: Record<string, Direction> = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
    };

    if (e.key === 'Escape') {
      if (sidebarOpen) setSidebarOpen(false);
      else if (pathModeRef.current) setPathMode(null);
      else if (selectedEdgeId) setSelectedEdgeId(null);
      else if (selectedId) setSelectedId(null);
      else if (focus) setFocus(null);
    } else if (e.key === 'ArrowUp' && e.altKey) {
      e.preventDefault();
      goToParent();
    } else if (arrows[e.key] && !e.altKey && !e.shiftKey && arrowsFree && !picking) {
      e.preventDefault();
      moveSelection(arrows[e.key]!);
    } else if (e.key === 'Enter' && onMap && selectedId) {
      e.preventDefault();
      activate(selectedId);
    } else if (e.key === 'Backspace' && !e.altKey) {
      if (history.length) {
        e.preventDefault();
        goBack();
      }
    } else if (e.key === '?') {
      e.preventDefault();
      setShortcutsOpen(true);
    } else if (e.altKey || e.shiftKey) {
      return;
    } else if (e.key === 'f') {
      canvas.current?.fit();
    } else if (e.key === 'm') {
      setMinimap((v) => !v);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const exportJson = () =>
    downloadText(`${slug(graph.project.name)}.rastro.json`, `${JSON.stringify(graph, null, 2)}\n`);
  const exportPng = () => {
    const blob = canvas.current?.png(PALETTES[theme].bg);
    if (blob && blob.size > 0) downloadBlob(`${slug(graph.project.name)}.rastro.png`, blob);
    else alert(t.stage.pngFailed);
  };

  // o mesmo botão abre a gaveta (telas estreitas) ou recolhe o painel (telas largas)
  const isNarrow = () => window.matchMedia?.('(max-width: 900px)').matches ?? false;
  const sidebarVisible = isNarrow() ? sidebarOpen : !sidebarCollapsed;
  const toggleSidebar = () => {
    if (isNarrow()) {
      setSidebarOpen((o) => !o);
      return;
    }
    setSidebarCollapsed((c) => !c);
    // depois da transição do painel, reenquadra para aproveitar o espaço novo
    setTimeout(() => canvas.current?.fit(), 260);
  };

  const fitKey = `${focus?.id ?? ''}|${focus?.depth ?? ''}|${level}`;
  const focusNode = focus ? index.node(focus.id) : undefined;
  const selectedEdge = selectedEdgeId ? view.edges.find((e) => e.id === selectedEdgeId) : undefined;
  // se a linha selecionada sumir (outro nível, pasta recolhida), segue para a linha que agora
  // representa as mesmas relações; se nenhuma representar, limpa a seleção
  const selectedEdgeMembers = useRef<string[]>([]);
  if (selectedEdge) selectedEdgeMembers.current = selectedEdge.members;
  useEffect(() => {
    if (!selectedEdgeId || view.edges.some((e) => e.id === selectedEdgeId)) return;
    const members = new Set(selectedEdgeMembers.current);
    const replacement = view.edges.find((e) => e.members.some((m) => members.has(m)));
    setSelectedEdgeId(replacement ? replacement.id : null);
  }, [view, selectedEdgeId]);
  const pathHighlight = useMemo(() => {
    const path = pathResult?.paths[activePath];
    return path ? { nodes: path.nodes, edges: path.edges.map((e) => e.id) } : null;
  }, [pathResult, activePath]);
  // os nós dos caminhos precisam aparecer no mapa: abre pastas e arquivos e fixa os nós
  const collapsedRef = useRef(collapsedModules);
  collapsedRef.current = collapsedModules;
  const setModuleOpenRef = useRef(setModuleOpen);
  setModuleOpenRef.current = setModuleOpen;
  // só ao abrir um caminho (ou trocar de alternativa): uma nova análise (--watch) refaz o
  // índice, mas não deve mexer de novo no mapa que a pessoa está olhando
  const shownPath = useRef<string | null>(null);
  useEffect(() => {
    const key = pathResult?.paths.length
      ? `${pathModeRef.current?.from}\n${pathModeRef.current?.to}\n${activePath}`
      : null;
    if (key === shownPath.current) return;
    shownPath.current = key;
    if (!pathResult?.paths.length) return;
    const ids = new Set(pathResult.paths.flatMap((p) => p.nodes));
    for (const id of ids) {
      for (const ancestor of index.ancestors(id))
        if (collapsedRef.current.has(ancestor.id)) setModuleOpenRef.current(ancestor.id, true);
      const file = index.fileOf(id);
      if (file && file.id !== id)
        setExpandedFiles((s) => (s.has(file.id) ? s : new Set(s).add(file.id)));
    }
    setPinned((s) => new Set([...s, ...ids]));
    const origin = pathModeRef.current?.from;
    const shown = pathResult.paths[activePath]?.nodes ?? [...ids];
    if (origin) setCenterRequest((r) => ({ id: origin, seq: (r?.seq ?? 0) + 1, fitIds: shown }));
  }, [pathResult, activePath, index]);

  const changeImpact = useMemo(
    () => (graph.changes ? computeChangeImpact(index, graph.changes) : null),
    [index, graph.changes],
  );
  const showChanges = !!changeImpact && panelTab === 'changes' && highlightChanges && !pathMode?.to;
  const changeHighlight = useMemo(() => {
    if (!showChanges || !changeImpact) return null;
    // o que está escondido (ex.: uma rota dentro de um arquivo fechado) é destacado em quem o
    // representa no mapa: o arquivo ou a pasta visível mais próxima
    const shown = new Set(view.nodes.map((n) => n.id));
    const rep = (id: string) =>
      shown.has(id) ? id : index.ancestors(id).find((a) => shown.has(a.id))?.id;
    const changed = new Set(
      [...changeImpact.changedEntities, ...changeImpact.changedFiles]
        .map((n) => rep(n.id))
        .filter((id): id is string => !!id),
    );
    const impacted = new Set(
      changeImpact.impacted
        .map((i) => rep(i.node.id))
        .filter((id): id is string => !!id && !changed.has(id)),
    );
    return { changed: [...changed], impacted: [...impacted] };
  }, [showChanges, changeImpact, view, index]);

  // regras de arquitetura (rastro.rules.json): conferidas aqui, com o mesmo cálculo do
  // `rastro check` (e as violações novas, quando o mapa tem as mudanças do git)
  const rulesState = useMemo(() => {
    const parsed = graphRules(graph);
    if (!parsed || !graph.rules) return null;
    return {
      rules: graph.rules,
      issues: parsed.issues,
      check: parsed.rules ? checkRules(index, parsed.rules, graph.changes) : null,
    };
  }, [graph, index]);
  const showRules = !!rulesState?.check && panelTab === 'rules' && highlightRules && !pathMode?.to;
  const ruleHighlight = useMemo(() => {
    if (!showRules || !rulesState?.check) return null;
    const shown = new Set(view.nodes.map((n) => n.id));
    const rep = (id: string) =>
      shown.has(id) ? id : index.ancestors(id).find((a) => shown.has(a.id))?.id;
    const nodes = new Set<string>();
    const edges: string[] = [];
    for (const outcome of rulesState.check.outcomes)
      for (const v of outcome.violations) {
        edges.push(...v.edges);
        for (const id of [
          nodeId.file(v.from),
          v.package ? nodeId.package(v.to) : nodeId.file(v.to),
        ]) {
          const shownId = rep(id);
          if (shownId) nodes.add(shownId);
        }
      }
    return { nodes: [...nodes], edges };
  }, [showRules, rulesState, view, index]);
  // ao abrir a aba (não a cada nova análise do --watch), o mapa enquadra o que quebra regras
  const rulesShown = useRef(false);
  useEffect(() => {
    const was = rulesShown.current;
    rulesShown.current = showRules;
    if (was || !showRules || !rulesState?.check) return;
    const ids = rulesState.check.outcomes
      .flatMap((o) => o.violations.map((v) => nodeId.file(v.from)))
      .filter((id) => index.node(id))
      .slice(0, 60);
    if (ids.length) setCenterRequest((r) => ({ id: ids[0]!, seq: (r?.seq ?? 0) + 1, fitIds: ids }));
  }, [showRules, rulesState, index]);
  /** Abre a entidade onde a violação aparece (a origem da primeira relação). */
  const openViolation = (v: RuleViolation) => {
    const edge = v.edges.length ? index.edges.get(v.edges[0]!) : undefined;
    navigate(edge?.source ?? nodeId.file(v.from));
  };

  // o que mudou (e o que é afetado diretamente) aparece no mapa quando a aba está aberta
  // só quando a aba (ou o destaque) é aberta, não a cada nova análise do --watch
  const changesShown = useRef(false);
  useEffect(() => {
    const was = changesShown.current;
    changesShown.current = showChanges;
    if (was || !showChanges || !changeImpact) return;
    const ids = [
      ...changeImpact.changedEntities.map((n) => n.id),
      ...changeImpact.impacted.filter((i) => i.depth === 1).map((i) => i.node.id),
    ];
    if (!ids.length) return;
    for (const id of ids) {
      for (const ancestor of index.ancestors(id))
        if (collapsedRef.current.has(ancestor.id)) setModuleOpenRef.current(ancestor.id, true);
      const file = index.fileOf(id);
      if (file && file.id !== id)
        setExpandedFiles((s) => (s.has(file.id) ? s : new Set(s).add(file.id)));
    }
    setCenterRequest((r) => ({ id: ids[0]!, seq: (r?.seq ?? 0) + 1, fitIds: ids }));
  }, [showChanges, changeImpact, index]);

  /** Ações da paleta de comandos (só montadas com a paleta aberta). */
  const paletteActions = (): PaletteAction[] => {
    const g = t.palette.groups;
    const kw = t.palette.keywords;
    const showPanel = (tab: PanelTab) => {
      setSelectedId(null);
      setSelectedEdgeId(null);
      setPathMode(null);
      setPanelTab(tab);
    };
    const actions: PaletteAction[] = [];
    const selected = selectedId ? index.node(selectedId) : undefined;
    if (selected) {
      const name =
        selected.kind === 'file' ? selected.name : entityName(selected, graph.project.name);
      const group = `${g.selection} · ${name}`;
      actions.push(
        {
          id: 'focus',
          label: focus?.id === selected.id ? t.palette.leaveFocus : t.details.focus,
          group,
          icon: <IconFit />,
          run: () =>
            setFocus(
              focus?.id === selected.id ? null : { id: selected.id, depth: focus?.depth ?? 1 },
            ),
        },
        {
          id: 'path',
          label: t.paths.start,
          group,
          icon: <IconLayout />,
          run: () => {
            setPathMode({ from: selected.id });
            setActivePath(0);
            setSearchFocus((n) => n + 1);
          },
        },
        {
          id: 'expand',
          label: t.details.expand,
          group,
          icon: <IconPlus />,
          run: () => expandNeighbors(selected.id),
        },
      );
      if (selected.kind === 'module' || (selected.kind === 'file' && level !== 'symbols'))
        actions.push({
          id: 'toggle',
          label: t.palette.toggleOpen,
          group,
          shortcut: 'Enter',
          icon: <IconPlus />,
          run: () => activate(selected.id),
        });
      if (selected.parent)
        actions.push({
          id: 'parent',
          label: t.palette.parent,
          group,
          shortcut: 'Alt ↑',
          icon: <IconBack />,
          run: goToParent,
        });
      actions.push(
        {
          id: 'link',
          label: t.palette.copyLink,
          group,
          icon: <IconCommand />,
          run: () => {
            const url = `${window.location.href.split('#')[0]}#n=${encodeURIComponent(selected.id)}`;
            void copyText(url);
          },
        },
        {
          id: 'clear',
          label: t.palette.clearSelection,
          group,
          shortcut: 'Esc',
          run: () => setSelectedId(null),
        },
      );
    }
    if (history.length)
      actions.push({
        id: 'back',
        label: t.stage.backTitle,
        group: g.selection,
        shortcut: '⌫',
        icon: <IconBack />,
        run: goBack,
      });
    if (focus && focus.id !== selectedId)
      actions.push({
        id: 'unfocus',
        label: t.palette.leaveFocus,
        group: g.map,
        run: () => setFocus(null),
      });
    if (pinned.size)
      actions.push({
        id: 'unpin',
        label: t.palette.clearPinned,
        group: g.map,
        run: () => setPinned(new Set()),
      });
    for (const id of ['modules', 'files', 'symbols'] as const)
      if (id !== level)
        actions.push({
          id: `level-${id}`,
          label: t.palette.level(t.sidebar.levels[id]),
          group: g.map,
          keywords: kw.level,
          icon: <IconLayout />,
          run: () => requestLevel(id),
        });
    actions.push(
      {
        id: 'layout',
        label: t.palette.layout(
          layout === 'hierarchical' ? t.sidebar.organic : t.sidebar.hierarchical,
        ),
        group: g.map,
        keywords: kw.layout,
        icon: <IconLayout />,
        run: () => setLayout(layout === 'hierarchical' ? 'organic' : 'hierarchical'),
      },
      {
        id: 'fit',
        label: t.stage.fit,
        group: g.map,
        shortcut: 'F',
        icon: <IconFit />,
        run: () => canvas.current?.fit(),
      },
      {
        id: 'relayout',
        label: t.palette.relayout,
        group: g.map,
        icon: <IconLayout />,
        run: () => canvas.current?.relayout(),
      },
      {
        id: 'minimap',
        label: minimap ? t.stage.hideMinimap : t.stage.showMinimap,
        group: g.map,
        icon: <IconMinimap />,
        run: () => setMinimap((v) => !v),
      },
      { id: 'reset', label: t.stage.reset, group: g.map, run: resetView },
      {
        id: 'summary',
        label: t.palette.showSummary,
        group: g.panel,
        icon: <IconInfo />,
        run: () => showPanel('summary'),
      },
      {
        id: 'insights',
        label: t.palette.showInsights,
        group: g.panel,
        icon: <IconInfo />,
        run: () => showPanel('insights'),
      },
    );
    if (changeImpact)
      actions.push({
        id: 'changes',
        label: t.palette.showChanges,
        group: g.panel,
        icon: <IconInfo />,
        run: () => showPanel('changes'),
      });
    if (rulesState)
      actions.push({
        id: 'rules',
        label: t.palette.showRules,
        group: g.panel,
        icon: <IconInfo />,
        run: () => showPanel('rules'),
      });
    actions.push(
      {
        id: 'sidebar',
        label: sidebarVisible ? t.top.hideFilters : t.top.showFilters,
        group: g.panel,
        icon: <IconMenu />,
        run: toggleSidebar,
      },
      {
        id: 'export-json',
        label: t.top.exportTitle,
        group: g.prefs,
        keywords: kw.export,
        icon: <IconDownload />,
        run: exportJson,
      },
      {
        id: 'export-png',
        label: t.stage.savePngTitle,
        group: g.prefs,
        keywords: kw.export,
        icon: <IconImage />,
        run: exportPng,
      },
      {
        id: 'theme',
        label: theme === 'dark' ? t.top.useLight : t.top.useDark,
        group: g.prefs,
        keywords: kw.theme,
        icon: theme === 'dark' ? <IconSun /> : <IconMoon />,
        run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      },
      {
        id: 'lang',
        label: t.palette.toggleLang,
        group: g.prefs,
        keywords: kw.lang,
        run: () => onLang(lang === 'pt' ? 'en' : 'pt'),
      },
      {
        id: 'shortcuts',
        label: t.palette.shortcuts,
        group: g.prefs,
        shortcut: '?',
        icon: <IconKeyboard />,
        run: () => setShortcutsOpen(true),
      },
    );
    return actions;
  };

  const panelMode =
    pathMode?.to && pathResult
      ? 'path'
      : selectedEdge
        ? 'edge'
        : selectedId && index.node(selectedId)
          ? 'node'
          : 'overview';

  return (
    <div
      className={`app${sidebarOpen ? ' sidebar-open' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}${panelMode !== 'overview' ? ' has-selection' : ''}`}
    >
      <header className="topbar">
        <button
          type="button"
          className="icon-button"
          onClick={toggleSidebar}
          aria-label={sidebarVisible ? t.top.hideFilters : t.top.showFilters}
          aria-expanded={sidebarVisible}
          aria-controls="rastro-sidebar"
          title={sidebarVisible ? t.top.hideFilters : t.top.showFilters}
        >
          <IconMenu />
        </button>
        <div className="brand">
          <Logo />
          <span className="brand-name">Rastro</span>
          <span className="brand-sep" aria-hidden="true">
            /
          </span>
          <span className="brand-project" title={displayPath(graph.project.root)}>
            {graph.project.name}
          </span>
          <span className="beta">v{graph.tool.version.split('.').slice(0, 2).join('.')}</span>
        </div>
        <Search index={index} onPick={(id) => navigate(id)} focusSignal={searchFocus} />
        <div className="top-actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => setPaletteOpen(true)}
            aria-label={t.palette.openPalette}
            title={t.palette.openPalette}
          >
            <IconCommand />
          </button>
          <button
            type="button"
            className="button ghost"
            onClick={() => {
              setSelectedId(null);
              setSelectedEdgeId(null);
              setPanelTab('summary');
            }}
            title={t.top.summaryTitle}
            aria-label={t.top.summaryTitle}
          >
            <IconInfo /> <span className="hide-narrow">{t.top.summary}</span>
          </button>
          <button
            type="button"
            className="button export-button"
            onClick={exportJson}
            title={t.top.exportTitle}
          >
            <IconDownload /> <span className="hide-narrow">{t.top.export}</span> JSON
          </button>
          <button
            type="button"
            className="lang-button"
            onClick={() => onLang(lang === 'pt' ? 'en' : 'pt')}
            aria-label={`${t.top.language}: ${t.langName}`}
            title={`${t.top.language}: ${t.langName}`}
          >
            {lang === 'pt' ? 'PT' : 'EN'}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
            aria-label={theme === 'dark' ? t.top.useLight : t.top.useDark}
            title={theme === 'dark' ? t.top.lightTheme : t.top.darkTheme}
          >
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
        </div>
      </header>

      <Sidebar
        graph={graph}
        level={level}
        layout={layout}
        nodeKinds={nodeKinds}
        edgeKinds={edgeKinds}
        hideTypeOnly={hideTypeOnly}
        highlightNeighbors={highlightNeighbors}
        editor={editor}
        symbolCount={symbolCount}
        moduleCount={groupable.length}
        onLevel={requestLevel}
        onLayout={setLayout}
        onToggleNodeKind={(k) => toggleSet(setNodeKinds, k)}
        onToggleEdgeKind={(k) => toggleSet(setEdgeKinds, k)}
        onHideTypeOnly={setHideTypeOnly}
        onHighlightNeighbors={setHighlightNeighbors}
        onEditor={setEditor}
        onReset={resetView}
      />
      <div className="scrim" onClick={() => setSidebarOpen(false)} aria-hidden="true" />

      <main className="stage">
        <GraphCanvas
          ref={canvas}
          view={view}
          palette={PALETTES[theme]}
          layout={layout}
          selectedId={selectedId}
          selectedEdgeId={selectedEdge ? selectedEdge.id : null}
          pathHighlight={pathHighlight}
          changeHighlight={changeHighlight}
          ruleHighlight={ruleHighlight}
          highlightNeighbors={highlightNeighbors}
          minimap={minimap}
          fitKey={fitKey}
          centerRequest={centerRequest}
          onSelect={(id) => {
            if (id) navigate(id, true, false);
            else {
              setSelectedId(null);
              setSelectedEdgeId(null);
            }
          }}
          onSelectEdge={(id) => {
            setSelectedEdgeId(id);
            setSelectedId(null);
          }}
          onActivate={activate}
        />

        <div className="stage-top">
          {confirmSymbols && (
            <div className="focus-pill confirm-pill" role="alertdialog" aria-live="polite">
              {symbolCount > SYMBOLS_MAX ? (
                <>
                  <span>{t.sidebar.tooManySymbols(symbolCount, SYMBOLS_MAX)}</span>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setConfirmSymbols(false)}
                  >
                    {t.sidebar.understood}
                  </button>
                </>
              ) : (
                <>
                  <span>
                    {symbolCount > SYMBOLS_SLOW
                      ? t.sidebar.confirmSymbolsSlow(symbolCount)
                      : t.sidebar.confirmSymbols(symbolCount)}
                  </span>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setConfirmSymbols(false);
                      setLevel('symbols');
                    }}
                  >
                    {t.sidebar.confirmShow}
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setConfirmSymbols(false)}
                  >
                    {t.paths.cancel}
                  </button>
                </>
              )}
            </div>
          )}
          {pathMode && !pathMode.to && (
            <div className="focus-pill pick-pill" role="status">
              {t.paths.pick}
              <button type="button" className="link-button" onClick={() => setPathMode(null)}>
                {t.paths.cancel}
              </button>
            </div>
          )}
          {focusNode && (
            <div className="focus-pill">
              {t.stage.focus}{' '}
              <strong>
                {focusNode.kind !== 'file'
                  ? entityName(focusNode, graph.project.name)
                  : focusNode.name}
              </strong>
              <span className="muted">{t.stage.distance(focus!.depth)}</span>
              <button type="button" className="link-button" onClick={() => setFocus(null)}>
                {t.stage.leave}
              </button>
            </div>
          )}
          {pinned.size > 0 && !focus && (
            <div className="focus-pill">
              {t.stage.pinned(pinned.size)}
              <button type="button" className="link-button" onClick={() => setPinned(new Set())}>
                {t.stage.clear}
              </button>
            </div>
          )}
          {history.length > 0 && (
            <button
              type="button"
              className="focus-pill pill-button"
              onClick={goBack}
              title={t.stage.backTitle}
            >
              <IconBack /> {t.stage.back}
            </button>
          )}
        </div>

        {view.nodes.length === 0 && graph.stats.files > 0 && (
          <div className="stage-empty">
            <p>{t.stage.noMatch}</p>
            <button type="button" className="button" onClick={resetView}>
              {t.stage.reset}
            </button>
          </div>
        )}
        {graph.stats.files === 0 && (
          <div className="stage-empty">
            <p>{t.stage.noFiles}</p>
          </div>
        )}

        <div className="stage-status" aria-live="polite">
          {t.stage.status(view.nodes.length, view.edges.length)}
          {view.hiddenCount > 0 && (
            <span className="muted">{t.stage.hidden(view.hiddenCount)}</span>
          )}
          {updatedAt && (
            <span className="live-dot">
              {t.stage.live(new Date(updatedAt).toLocaleTimeString(locale))}
            </span>
          )}
        </div>

        <div className="zoom-controls" role="toolbar" aria-label={t.stage.controls}>
          <button
            type="button"
            className="icon-button"
            onClick={() => canvas.current?.zoom(1.25)}
            aria-label={t.stage.zoomIn}
            title={t.stage.zoomIn}
          >
            <IconPlus />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => canvas.current?.zoom(0.8)}
            aria-label={t.stage.zoomOut}
            title={t.stage.zoomOut}
          >
            <IconMinus />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => canvas.current?.fit()}
            aria-label={t.stage.fit}
            title={t.stage.fitShortcut}
          >
            <IconFit />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => canvas.current?.relayout()}
            aria-label={t.stage.relayout}
            title={t.stage.relayoutTitle}
          >
            <IconLayout />
          </button>
          <button
            type="button"
            className={`icon-button${minimap ? ' on' : ''}`}
            onClick={() => setMinimap((v) => !v)}
            aria-label={minimap ? t.stage.hideMinimap : t.stage.showMinimap}
            aria-pressed={minimap}
            title={minimap ? t.stage.hideMinimap : t.stage.showMinimap}
          >
            <IconMinimap />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={exportPng}
            aria-label={t.stage.savePng}
            title={t.stage.savePngTitle}
          >
            <IconImage />
          </button>
        </div>
      </main>

      <aside
        className="panel"
        aria-label={
          panelMode === 'path' && pathMode?.to
            ? t.stage.panelPath
            : panelMode === 'edge'
              ? t.stage.panelEdge
              : panelMode === 'node'
                ? t.stage.panelNode
                : t.stage.panelSummary
        }
      >
        {panelMode === 'path' && pathMode?.to && pathResult ? (
          <PathPanel
            index={index}
            from={pathMode.from}
            to={pathMode.to}
            result={pathResult}
            active={activePath}
            editor={editor}
            onActive={setActivePath}
            onNavigate={(id) => {
              setPathMode(null);
              navigate(id);
            }}
            pathOnly={pathOnly}
            onPathOnly={setPathOnly}
            onSwap={() => {
              setPathMode({ from: pathMode.to!, to: pathMode.from });
              setActivePath(0);
            }}
            onClose={() => setPathMode(null)}
          />
        ) : panelMode === 'edge' && selectedEdge ? (
          <EdgeDetails
            key={selectedEdge.id}
            index={index}
            edge={selectedEdge}
            editor={editor}
            onNavigate={(id) => navigate(id)}
            onClose={() => setSelectedEdgeId(null)}
          />
        ) : panelMode === 'node' && selectedId ? (
          <DetailsPanel
            key={selectedId}
            index={index}
            nodeId={selectedId}
            editor={editor}
            sourceAvailable={fromServer}
            focusId={focus?.id ?? null}
            focusDepth={focus?.depth ?? 1}
            expanded={level === 'symbols' || expandedFiles.has(selectedId)}
            allSymbols={level === 'symbols'}
            moduleCollapsed={collapsedModules.has(selectedId)}
            onNavigate={(id) => navigate(id)}
            onFocus={(id) => setFocus(id ? { id, depth: focus?.depth ?? 1 } : null)}
            onFocusDepth={(depth) => focus && setFocus({ ...focus, depth })}
            onExpandNeighbors={expandNeighbors}
            onToggleExpand={toggleExpand}
            onToggleModule={(id) => setModuleOpen(id, collapsedModules.has(id))}
            onStartPath={(id) => {
              setPathMode({ from: id });
              setActivePath(0);
              setSearchFocus((n) => n + 1);
            }}
            onClose={() => setSelectedId(null)}
          />
        ) : (
          <>
            <div className="panel-tabs" role="tablist">
              {(
                [
                  ...(changeImpact ? ['changes'] : []),
                  'summary',
                  'insights',
                  ...(rulesState ? ['rules'] : []),
                ] as PanelTab[]
              ).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={panelTab === tab}
                  className={panelTab === tab ? 'on' : ''}
                  onClick={() => setPanelTab(tab)}
                >
                  {tab === 'summary'
                    ? t.insights.tabSummary
                    : tab === 'insights'
                      ? t.insights.tabInsights
                      : tab === 'rules'
                        ? t.rules.tab
                        : t.changes.tab}
                  {tab === 'changes' && graph.changes && (
                    <span className="tab-count">{graph.changes.files.length}</span>
                  )}
                  {tab === 'rules' && rulesState && <RulesCount check={rulesState.check} />}
                </button>
              ))}
            </div>
            {panelTab === 'changes' && changeImpact && graph.changes ? (
              <ChangesPanel
                changes={graph.changes}
                impact={changeImpact}
                highlight={highlightChanges}
                onHighlight={setHighlightChanges}
                onNavigate={(id) => navigate(id)}
              />
            ) : panelTab === 'rules' && rulesState ? (
              <RulesPanel
                rules={rulesState.rules}
                issues={rulesState.issues}
                check={rulesState.check}
                highlight={highlightRules}
                onHighlight={setHighlightRules}
                onOpen={openViolation}
              />
            ) : panelTab !== 'insights' ? (
              <Overview graph={graph} index={index} onNavigate={(id) => navigate(id)} />
            ) : (
              <Insights index={index} onNavigate={(id) => navigate(id)} />
            )}
          </>
        )}
      </aside>

      {paletteOpen && (
        <CommandPalette
          index={index}
          actions={paletteActions()}
          recent={[...new Set([...history].reverse())]
            .filter((id) => id !== selectedId)
            .slice(0, 5)}
          onPickNode={(id) => navigate(id)}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}
