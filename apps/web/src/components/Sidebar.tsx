import {
  EDGE_KIND_LABELS,
  NODE_KIND_LABELS,
  type EdgeKind,
  type NodeKind,
  type TeiaGraph,
} from '@teia/core';
import { EDITORS, type EditorId } from '../lib/editor';
import { KindDot } from './KindBadge';

export const NODE_KIND_ORDER: NodeKind[] = [
  'module',
  'file',
  'function',
  'class',
  'method',
  'route',
  'package',
  'unresolved',
];
export const EDGE_KIND_ORDER: EdgeKind[] = ['imports', 'calls', 'extends', 'exports', 'depends_on'];

const EDGE_HINTS: Record<EdgeKind, string> = {
  contains: '',
  imports: 'arquivo → arquivo ou pacote',
  calls: 'função/método → o que ela chama',
  extends: 'classe → classe base',
  exports: 'arquivo → o que ele exporta',
  depends_on: 'módulo → módulo (derivado dos imports)',
};

interface Props {
  graph: TeiaGraph;
  nodeKinds: ReadonlySet<NodeKind>;
  edgeKinds: ReadonlySet<EdgeKind>;
  expandAll: boolean;
  hideTypeOnly: boolean;
  highlightNeighbors: boolean;
  editor: EditorId;
  symbolCount: number;
  onToggleNodeKind(kind: NodeKind): void;
  onToggleEdgeKind(kind: EdgeKind): void;
  onExpandAll(value: boolean): void;
  onHideTypeOnly(value: boolean): void;
  onHighlightNeighbors(value: boolean): void;
  onEditor(value: EditorId): void;
  onReset(): void;
}

export function Sidebar(p: Props) {
  const { stats } = p.graph;
  return (
    <aside className="sidebar" aria-label="Filtros e legenda">
      <section className="side-section">
        <h2 className="side-title">Visualização</h2>
        <div className="segmented" role="radiogroup" aria-label="Nível de detalhe">
          <button
            type="button"
            role="radio"
            aria-checked={!p.expandAll}
            className={!p.expandAll ? 'on' : ''}
            onClick={() => p.onExpandAll(false)}
          >
            Arquivos
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={p.expandAll}
            className={p.expandAll ? 'on' : ''}
            onClick={() => {
              if (
                p.symbolCount > 1500 &&
                !confirm(
                  `Mostrar ${p.symbolCount} símbolos de uma vez pode deixar o mapa ilegível e lento. Continuar?`,
                )
              )
                return;
              p.onExpandAll(true);
            }}
          >
            Símbolos
          </button>
        </div>
        <p className="side-hint">
          {p.expandAll
            ? 'Funções, classes e métodos de todos os arquivos.'
            : 'Dê dois cliques em um arquivo marcado com + para ver as funções e classes dele.'}
        </p>
      </section>

      <section className="side-section">
        <div className="side-title-row">
          <h2 className="side-title">Nós</h2>
          <button type="button" className="link-button" onClick={p.onReset}>
            restaurar
          </button>
        </div>
        <ul className="filter-list">
          {NODE_KIND_ORDER.map((kind) => {
            const count = stats.nodesByKind[kind] ?? 0;
            return (
              <li key={kind}>
                <label className={`filter${count === 0 ? ' empty' : ''}`}>
                  <input
                    type="checkbox"
                    checked={p.nodeKinds.has(kind)}
                    onChange={() => p.onToggleNodeKind(kind)}
                  />
                  <KindDot kind={kind} />
                  <span className="filter-label">{NODE_KIND_LABELS[kind]}</span>
                  <span className="filter-count">{count}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="side-section">
        <h2 className="side-title">Relações</h2>
        <ul className="filter-list">
          {EDGE_KIND_ORDER.map((kind) => {
            const count = stats.edgesByKind[kind] ?? 0;
            return (
              <li key={kind}>
                <label className={`filter${count === 0 ? ' empty' : ''}`} title={EDGE_HINTS[kind]}>
                  <input
                    type="checkbox"
                    checked={p.edgeKinds.has(kind)}
                    onChange={() => p.onToggleEdgeKind(kind)}
                  />
                  <span className={`edge-swatch e-${kind}`} aria-hidden="true" />
                  <span className="filter-label">{EDGE_KIND_LABELS[kind]}</span>
                  <span className="filter-count">{count}</span>
                </label>
              </li>
            );
          })}
        </ul>
        <label className="toggle">
          <input
            type="checkbox"
            checked={p.hideTypeOnly}
            onChange={(e) => p.onHideTypeOnly(e.target.checked)}
          />
          Ocultar imports só de tipo
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={p.highlightNeighbors}
            onChange={(e) => p.onHighlightNeighbors(e.target.checked)}
          />
          Destacar vizinhos ao selecionar
        </label>
      </section>

      <section className="side-section">
        <h2 className="side-title">Legenda das linhas</h2>
        <ul className="legend">
          <li>
            <span className="line-sample solid" /> resolvida no projeto
          </li>
          <li>
            <span className="line-sample dashed" /> externa (pacote ou Node.js)
          </li>
          <li>
            <span className="line-sample unresolved" /> não resolvida
          </li>
          <li>
            <span className="line-sample dotted" /> import só de tipo / export
          </li>
          <li>
            <span className="cycle-sample" /> ciclo de importação
          </li>
        </ul>
      </section>

      <section className="side-section">
        <h2 className="side-title">Abrir arquivos em</h2>
        <select
          className="select"
          value={p.editor}
          onChange={(e) => p.onEditor(e.target.value as EditorId)}
          aria-label="Editor"
        >
          {(Object.keys(EDITORS) as EditorId[]).map((id) => (
            <option key={id} value={id}>
              {EDITORS[id].label}
            </option>
          ))}
        </select>
      </section>
    </aside>
  );
}
