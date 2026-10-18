import type { GraphNode } from '@rastro/core';
import type { GraphIndex, PathSearch } from '@rastro/graph';
import { absolutePath, EDITORS, type EditorId } from '../lib/editor';
import { useI18n } from '../lib/i18n';
import { entityName } from '../lib/names';
import { IconClose } from './Icons';
import { KindDot } from './KindBadge';

interface Props {
  index: GraphIndex;
  from: string;
  to: string;
  result: PathSearch;
  active: number;
  editor: EditorId;
  onActive(i: number): void;
  onNavigate(id: string): void;
  /** O mapa mostra só os caminhos (em vez do mapa inteiro com o resto apagado). */
  pathOnly: boolean;
  onPathOnly(value: boolean): void;
  onSwap(): void;
  onClose(): void;
}

/** "Como A chega em B?": os caminhos encontrados, passo a passo, com a evidência de cada passo. */
export function PathPanel(p: Props) {
  const name = (n: GraphNode | undefined) => (n ? entityName(n, p.index.graph.project.name) : '?');
  const { t, labels } = useI18n();
  const root = p.index.graph.project.root;
  const from = p.index.node(p.from);
  const to = p.index.node(p.to);
  return (
    <div className="details">
      <header className="details-head">
        <div className="details-kind">
          <span className="kind-badge">{t.paths.title}</span>
          <button
            type="button"
            className="icon-button"
            onClick={p.onClose}
            aria-label={t.paths.close}
            title={t.paths.close}
          >
            <IconClose />
          </button>
        </div>
        <div className="edge-ends">
          {[from, to].map((n, i) =>
            n ? (
              <button
                key={n.id}
                type="button"
                className="rel-item edge-end"
                onClick={() => p.onNavigate(n.id)}
              >
                <span className="muted small">{i === 0 ? t.edge.from : t.edge.to}</span>
                <KindDot kind={n.kind} />
                <span className="rel-name">{name(n)}</span>
              </button>
            ) : null,
          )}
        </div>
        <div className="button-row">
          <button type="button" className="button ghost" onClick={p.onSwap}>
            ⇄ {t.paths.swap}
          </button>
        </div>
        {p.result.paths.length > 0 && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={p.pathOnly}
              onChange={(e) => p.onPathOnly(e.target.checked)}
            />
            {t.paths.onlyPath}
          </label>
        )}
      </header>

      {p.result.reversed && <div className="callout cycle">{t.paths.reversed}</div>}
      {p.result.paths.length === 0 && <p className="muted small details-section">{t.paths.none}</p>}

      {p.result.paths.map((path, i) => (
        <section key={i} className={`details-section path-option${i === p.active ? ' on' : ''}`}>
          <button
            type="button"
            className="path-option-head"
            onClick={() => p.onActive(i)}
            aria-pressed={i === p.active}
          >
            {t.paths.option(i + 1, path.edges.length)}
          </button>
          {i === p.active && (
            <ol className="path-steps">
              {path.nodes.map((id, step) => {
                const node = p.index.node(id);
                const edge = path.edges[step];
                const ev = edge?.evidence[0];
                return (
                  <li key={`${id}-${step}`}>
                    <button type="button" className="rel-item" onClick={() => p.onNavigate(id)}>
                      <KindDot kind={node?.kind ?? 'function'} />
                      <span className="rel-name">{name(node)}</span>
                    </button>
                    {edge && (
                      <div className="path-link">
                        <span className={`edge-swatch e-${edge.kind}`} aria-hidden="true" />
                        <span className="muted small">{labels.edge[edge.kind].toLowerCase()}</span>
                        {ev && (
                          <a
                            className="evidence"
                            href={EDITORS[p.editor].url(
                              absolutePath(root, ev.file),
                              ev.line,
                              ev.column,
                            )}
                            title={t.common.openSnippet}
                          >
                            <span className="evidence-loc">
                              {ev.file}:{ev.line}
                            </span>
                            {ev.snippet && <code className="evidence-code">{ev.snippet}</code>}
                          </a>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      ))}
    </div>
  );
}
