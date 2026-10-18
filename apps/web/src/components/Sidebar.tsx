import type { EdgeKind, NodeKind, RastroGraph } from '@rastro/core';
import { useI18n } from '../lib/i18n';
import type { Level } from '../lib/levels';
import { EDITORS, type EditorId } from '../lib/editor';
import type { LayoutMode } from './GraphCanvas';
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

const LEVELS: Level[] = ['modules', 'files', 'symbols'];

interface Props {
  graph: RastroGraph;
  nodeKinds: ReadonlySet<NodeKind>;
  edgeKinds: ReadonlySet<EdgeKind>;
  level: Level;
  layout: LayoutMode;
  moduleCount: number;
  hideTypeOnly: boolean;
  highlightNeighbors: boolean;
  editor: EditorId;
  symbolCount: number;
  onToggleNodeKind(kind: NodeKind): void;
  onToggleEdgeKind(kind: EdgeKind): void;
  onLevel(value: Level): void;
  onLayout(value: LayoutMode): void;
  onHideTypeOnly(value: boolean): void;
  onHighlightNeighbors(value: boolean): void;
  onEditor(value: EditorId): void;
  onReset(): void;
}

export function Sidebar(p: Props) {
  const { stats } = p.graph;
  const { t, labels } = useI18n();
  const s = t.sidebar;
  return (
    <aside className="sidebar" id="rastro-sidebar" aria-label={s.aria}>
      <section className="side-section">
        <h2 className="side-title">{s.level}</h2>
        <div className="segmented three" role="radiogroup" aria-label={s.level}>
          {LEVELS.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={p.level === id}
              className={p.level === id ? 'on' : ''}
              disabled={id === 'modules' && p.moduleCount < 2}
              onClick={() => {
                if (
                  id === 'symbols' &&
                  p.symbolCount > 1000 &&
                  !confirm(s.confirmSymbols(p.symbolCount))
                )
                  return;
                p.onLevel(id);
              }}
            >
              {s.levels[id]}
            </button>
          ))}
        </div>
        <p className="side-hint">{s.levelHints[p.level]}</p>
        <label className="field">
          <span>{s.layout}</span>
          <select
            className="select"
            value={p.layout}
            onChange={(e) => p.onLayout(e.target.value as LayoutMode)}
          >
            <option value="hierarchical">{s.hierarchical}</option>
            <option value="organic">{s.organic}</option>
          </select>
        </label>
      </section>

      <section className="side-section">
        <div className="side-title-row">
          <h2 className="side-title">{s.nodes}</h2>
          <button type="button" className="link-button" onClick={p.onReset}>
            {s.reset}
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
                  <span className="filter-label">{labels.node[kind]}</span>
                  <span className="filter-count">{count}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="side-section">
        <h2 className="side-title">{s.edges}</h2>
        <ul className="filter-list">
          {EDGE_KIND_ORDER.map((kind) => {
            const count = stats.edgesByKind[kind] ?? 0;
            return (
              <li key={kind}>
                <label className={`filter${count === 0 ? ' empty' : ''}`} title={s.edgeHints[kind]}>
                  <input
                    type="checkbox"
                    checked={p.edgeKinds.has(kind)}
                    onChange={() => p.onToggleEdgeKind(kind)}
                  />
                  <span className={`edge-swatch e-${kind}`} aria-hidden="true" />
                  <span className="filter-label">{labels.edge[kind]}</span>
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
          {s.hideTypeOnly}
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={p.highlightNeighbors}
            onChange={(e) => p.onHighlightNeighbors(e.target.checked)}
          />
          {s.highlightNeighbors}
        </label>
      </section>

      <section className="side-section">
        <h2 className="side-title">{s.legend}</h2>
        <ul className="legend">
          <li>
            <span className="line-sample solid" /> {s.legendResolved}
          </li>
          <li>
            <span className="line-sample dashed" /> {s.legendExternal}
          </li>
          <li>
            <span className="line-sample unresolved" /> {s.legendUnresolved}
          </li>
          <li>
            <span className="line-sample dotted" /> {s.legendDotted}
          </li>
          <li>
            <span className="cycle-sample" /> {s.legendCycle}
          </li>
        </ul>
      </section>

      <section className="side-section">
        <h2 className="side-title">{s.openFilesIn}</h2>
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
