import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateGraph, type EdgeKind, type NodeKind, type TeiaGraph } from '@teia/core';
import { computeView, GraphIndex, groupableModules } from '@teia/graph';
import { DetailsPanel } from './components/DetailsPanel';
import { EdgeDetails } from './components/EdgeDetails';
import { GraphCanvas, type GraphCanvasHandle, type LayoutMode } from './components/GraphCanvas';
import {
  IconBack,
  IconDownload,
  IconFit,
  IconImage,
  IconInfo,
  IconLayout,
  IconMenu,
  IconMinus,
  IconMoon,
  IconPlus,
  IconSun,
  Logo,
} from './components/Icons';
import { Overview } from './components/Overview';
import { Search } from './components/Search';
import { NODE_KIND_ORDER, Sidebar } from './components/Sidebar';
import { downloadBlob, downloadText, slug } from './lib/download';
import { EDITORS, readPref, writePref, type EditorId } from './lib/editor';
import type { Level } from './lib/levels';
import { PALETTES, type ThemeName } from './lib/theme';

type Load =
  | { status: 'loading' }
  | { status: 'ready'; graph: TeiaGraph; fromServer: boolean }
  | { status: 'error'; message: string; canPickFile: boolean };

const DEFAULT_EDGES: EdgeKind[] = ['imports', 'calls', 'extends'];
/** Pacotes externos começam ocultos no mapa para não poluir; continuam nos filtros e nos detalhes. */
const DEFAULT_NODES: NodeKind[] = NODE_KIND_ORDER.filter((k) => k !== 'package');
const SYMBOL_KINDS: NodeKind[] = ['function', 'class', 'method', 'route'];

export function App() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });

  const openGraph = useCallback((data: unknown, fromServer: boolean) => {
    const result = validateGraph(data);
    if (!result.valid) {
      setLoad({
        status: 'error',
        message: `O arquivo não é um grafo válido do Teia:\n${result.errors.slice(0, 5).join('\n')}`,
        canPickFile: true,
      });
      return;
    }
    setLoad({ status: 'ready', graph: data as TeiaGraph, fromServer });
  }, []);

  useEffect(() => {
    fetch('/api/graph')
      .then(async (res) => {
        if (res.status === 401) {
          setLoad({
            status: 'error',
            message:
              'Acesso negado: esta página precisa do endereço completo exibido no terminal (ele inclui um token de acesso). Copie a URL que o comando "teia" mostrou e abra de novo.',
            canPickFile: true,
          });
          return;
        }
        if (!res.ok) throw new Error(`O servidor respondeu ${res.status}.`);
        openGraph(await res.json(), true);
      })
      .catch(() =>
        setLoad({
          status: 'error',
          message:
            'Nenhum grafo foi carregado. Rode "teia <caminho-do-projeto>" no terminal, ou abra um JSON exportado pelo Teia.',
          canPickFile: true,
        }),
      );
  }, [openGraph]);

  const readFile = (file: File) => {
    file
      .text()
      .then((text) => openGraph(JSON.parse(text), false))
      .catch((err: Error) =>
        setLoad({
          status: 'error',
          message: `Não foi possível ler ${file.name}: ${err.message}`,
          canPickFile: true,
        }),
      );
  };

  if (load.status === 'loading') {
    return (
      <div className="screen-center">
        <Logo size={36} />
        <div className="spinner" aria-label="Carregando" />
        <p className="muted">Carregando o grafo…</p>
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
        <h1 className="screen-title">Teia</h1>
        <p className="screen-message">{load.message}</p>
        {load.canPickFile && (
          <label className="button">
            Abrir arquivo .json
            <input
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])}
            />
          </label>
        )}
        <p className="muted small">Você também pode arrastar o arquivo para esta janela.</p>
      </div>
    );
  }
  return <Explorer key={load.graph.generatedAt} graph={load.graph} fromServer={load.fromServer} />;
}

function Explorer({ graph, fromServer }: { graph: TeiaGraph; fromServer: boolean }) {
  const index = useMemo(() => new GraphIndex(graph), [graph]);
  const groupable = useMemo(() => groupableModules(index), [index]);
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
  // projetos grandes abrem no nível de pastas; os pequenos, direto nos arquivos
  const [level, setLevelState] = useState<Level>(() =>
    groupable.length > 3 && graph.stats.files > 60 ? 'modules' : 'files',
  );
  /** No nível "pastas" guarda as pastas abertas; nos outros, as pastas recolhidas. */
  const [moduleToggles, setModuleToggles] = useState<Set<string>>(() => new Set());
  const [nodeKinds, setNodeKinds] = useState<Set<NodeKind>>(() => new Set(DEFAULT_NODES));
  const [edgeKinds, setEdgeKinds] = useState<Set<EdgeKind>>(() => new Set(DEFAULT_EDGES));
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(() => new Set());
  const [pinned, setPinned] = useState<Set<string>>(() => new Set());
  const [focus, setFocus] = useState<{ id: string; depth: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [hideTypeOnly, setHideTypeOnly] = useState(false);
  const [highlightNeighbors, setHighlightNeighbors] = useState(true);
  const [centerRequest, setCenterRequest] = useState<{ id: string; seq: number } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writePref('theme', theme);
  }, [theme]);
  useEffect(() => writePref('editor', editor), [editor]);
  useEffect(() => writePref('layout', layout), [layout]);
  useEffect(() => {
    document.title = `${graph.project.name} · Teia`;
  }, [graph.project.name]);

  const collapsedModules = useMemo(
    () =>
      level === 'modules'
        ? new Set(groupable.filter((id) => !moduleToggles.has(id)))
        : moduleToggles,
    [level, groupable, moduleToggles],
  );

  const view = useMemo(() => {
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

  const symbolCount = SYMBOL_KINDS.reduce((acc, k) => acc + (graph.stats.nodesByKind[k] ?? 0), 0);

  const setLevel = (next: Level) => {
    setLevelState(next);
    setModuleToggles(new Set());
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
      if (focus && focus.id !== id) {
        const hood = index.neighborhood(focus.id, focus.depth, [...edgeKinds]);
        if (!hood.has(id)) setFocus({ id, depth: focus.depth });
      }
      // abre as pastas recolhidas que escondem o nó
      for (const ancestor of index.ancestors(id))
        if (collapsedModules.has(ancestor.id)) setModuleOpen(ancestor.id, true);
      const file = index.fileOf(id);
      if (file && file.id !== id)
        setExpandedFiles((s) => (s.has(file.id) ? s : new Set(s).add(file.id)));
      if (!nodeKinds.has(node.kind)) setPinned((s) => new Set(s).add(id));
      const prev = selectedRef.current;
      if (remember && prev && prev !== id) setHistory((h) => [...h.slice(-30), prev]);
      setSelectedId(id);
      setSelectedEdgeId(null);
      if (center) setCenterRequest((r) => ({ id, seq: (r?.seq ?? 0) + 1 }));
    },
    [index, focus, edgeKinds, nodeKinds, collapsedModules, setModuleOpen],
  );

  // link direto: #n=<id> na URL seleciona a entidade ao abrir
  const initialHash = useRef(true);
  useEffect(() => {
    if (!initialHash.current) return;
    initialHash.current = false;
    const id = new URLSearchParams(window.location.hash.slice(1)).get('n');
    if (id && index.node(id)) navigate(id, false);
  }, [index, navigate]);
  useEffect(() => {
    try {
      const url = selectedId
        ? `#n=${encodeURIComponent(selectedId)}`
        : window.location.pathname + window.location.search;
      window.history.replaceState(null, '', url);
    } catch {
      // ambientes sem history (ex.: arquivo local) apenas ignoram
    }
  }, [selectedId]);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      const typing =
        (t instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(t.type)) ||
        t instanceof HTMLSelectElement ||
        t instanceof HTMLTextAreaElement;
      if (typing) return;
      if (e.key === 'Escape') {
        if (sidebarOpen) setSidebarOpen(false);
        else if (selectedEdgeId) setSelectedEdgeId(null);
        else if (selectedId) setSelectedId(null);
        else if (focus) setFocus(null);
      } else if (e.key === 'f' && !e.metaKey && !e.ctrlKey) {
        canvas.current?.fit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, selectedEdgeId, focus, sidebarOpen]);

  const exportJson = () =>
    downloadText(`${slug(graph.project.name)}.teia.json`, `${JSON.stringify(graph, null, 2)}\n`);
  const exportPng = () => {
    const blob = canvas.current?.png(PALETTES[theme].bg);
    if (blob) downloadBlob(`${slug(graph.project.name)}.teia.png`, blob);
  };

  const fitKey = `${focus?.id ?? ''}|${focus?.depth ?? ''}|${level}`;
  const focusNode = focus ? index.node(focus.id) : undefined;
  const selectedEdge = selectedEdgeId ? view.edges.find((e) => e.id === selectedEdgeId) : undefined;
  const panelMode = selectedEdge
    ? 'edge'
    : selectedId && index.node(selectedId)
      ? 'node'
      : 'overview';

  return (
    <div
      className={`app${sidebarOpen ? ' sidebar-open' : ''}${panelMode !== 'overview' ? ' has-selection' : ''}`}
    >
      <header className="topbar">
        <button
          type="button"
          className="icon-button only-narrow"
          onClick={() => setSidebarOpen((o) => !o)}
          aria-label="Filtros"
        >
          <IconMenu />
        </button>
        <div className="brand">
          <Logo />
          <span className="brand-name">Teia</span>
          <span className="brand-sep" aria-hidden="true">
            /
          </span>
          <span className="brand-project" title={graph.project.root}>
            {graph.project.name}
          </span>
          <span className="beta">v0.1</span>
        </div>
        <Search index={index} onPick={(id) => navigate(id)} />
        <div className="top-actions">
          <button
            type="button"
            className="button ghost"
            onClick={() => {
              setSelectedId(null);
              setSelectedEdgeId(null);
            }}
            title="Resumo da análise"
            aria-label="Resumo da análise"
          >
            <IconInfo /> <span className="hide-narrow">Resumo</span>
          </button>
          <button
            type="button"
            className="button"
            onClick={exportJson}
            title="Baixar o grafo completo em JSON"
          >
            <IconDownload /> <span className="hide-narrow">Exportar</span> JSON
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
            title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
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
        onLevel={setLevel}
        onLayout={setLayout}
        onToggleNodeKind={(k) => toggleSet(setNodeKinds, k)}
        onToggleEdgeKind={(k) => toggleSet(setEdgeKinds, k)}
        onHideTypeOnly={setHideTypeOnly}
        onHighlightNeighbors={setHighlightNeighbors}
        onEditor={setEditor}
        onReset={resetView}
      />
      <div className="scrim only-narrow" onClick={() => setSidebarOpen(false)} aria-hidden="true" />

      <main className="stage">
        <GraphCanvas
          ref={canvas}
          view={view}
          palette={PALETTES[theme]}
          layout={layout}
          selectedId={selectedId}
          selectedEdgeId={selectedEdge ? selectedEdge.id : null}
          highlightNeighbors={highlightNeighbors}
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
          {focusNode && (
            <div className="focus-pill">
              Foco:{' '}
              <strong>
                {focusNode.qualifiedName && focusNode.kind !== 'file'
                  ? focusNode.qualifiedName
                  : focusNode.name}
              </strong>
              <span className="muted"> · distância {focus!.depth}</span>
              <button type="button" className="link-button" onClick={() => setFocus(null)}>
                sair
              </button>
            </div>
          )}
          {pinned.size > 0 && !focus && (
            <div className="focus-pill">
              {pinned.size} {pinned.size > 1 ? 'entidades expandidas' : 'entidade expandida'}
              <button type="button" className="link-button" onClick={() => setPinned(new Set())}>
                limpar
              </button>
            </div>
          )}
          {history.length > 0 && (
            <button
              type="button"
              className="focus-pill pill-button"
              onClick={goBack}
              title="Voltar para a seleção anterior"
            >
              <IconBack /> Voltar
            </button>
          )}
        </div>

        {view.nodes.length === 0 && graph.stats.files > 0 && (
          <div className="stage-empty">
            <p>Nenhum nó corresponde aos filtros atuais.</p>
            <button type="button" className="button" onClick={resetView}>
              Restaurar visualização
            </button>
          </div>
        )}
        {graph.stats.files === 0 && (
          <div className="stage-empty">
            <p>Este projeto não tem arquivos JavaScript ou TypeScript analisáveis.</p>
          </div>
        )}

        <div className="stage-status" aria-live="polite">
          {view.nodes.length} nós · {view.edges.length} relações visíveis
          {view.hiddenCount > 0 && <span className="muted"> · {view.hiddenCount} ocultos</span>}
        </div>

        <div className="zoom-controls" role="toolbar" aria-label="Controles do mapa">
          <button
            type="button"
            className="icon-button"
            onClick={() => canvas.current?.zoom(1.25)}
            aria-label="Aproximar"
            title="Aproximar"
          >
            <IconPlus />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => canvas.current?.zoom(0.8)}
            aria-label="Afastar"
            title="Afastar"
          >
            <IconMinus />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => canvas.current?.fit()}
            aria-label="Enquadrar tudo"
            title="Enquadrar tudo (F)"
          >
            <IconFit />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => canvas.current?.relayout()}
            aria-label="Reorganizar"
            title="Reorganizar o mapa"
          >
            <IconLayout />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={exportPng}
            aria-label="Salvar imagem"
            title="Salvar imagem PNG"
          >
            <IconImage />
          </button>
        </div>
      </main>

      <aside
        className="panel"
        aria-label={
          panelMode === 'edge'
            ? 'Detalhes da relação'
            : panelMode === 'node'
              ? 'Detalhes da entidade'
              : 'Resumo da análise'
        }
      >
        {panelMode === 'edge' && selectedEdge ? (
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
            moduleCollapsed={collapsedModules.has(selectedId)}
            onNavigate={(id) => navigate(id)}
            onFocus={(id) => setFocus(id ? { id, depth: focus?.depth ?? 1 } : null)}
            onFocusDepth={(depth) => focus && setFocus({ ...focus, depth })}
            onExpandNeighbors={expandNeighbors}
            onToggleExpand={toggleExpand}
            onToggleModule={(id) => setModuleOpen(id, collapsedModules.has(id))}
            onClose={() => setSelectedId(null)}
          />
        ) : (
          <Overview graph={graph} index={index} onNavigate={(id) => navigate(id)} />
        )}
      </aside>
    </div>
  );
}
