import type { NodeKind, RastroGraph } from '@rastro/core';
import type { GraphIndex } from '@rastro/graph';
import { useI18n } from '../lib/i18n';
import { displayPath } from '../lib/paths';
import { KindDot } from './KindBadge';

interface Props {
  graph: RastroGraph;
  index: GraphIndex;
  onNavigate(id: string): void;
}

const CARD_KINDS: NodeKind[] = [
  'file',
  'function',
  'class',
  'method',
  'route',
  'package',
  'unresolved',
];

/** Resumo da análise, exibido quando nada está selecionado. */
export function Overview({ graph, index, onNavigate }: Props) {
  const { stats } = graph;
  const { t, labels, locale } = useI18n();
  const o = t.overview;
  const r = stats.edgesByResolution;
  const total = (r.resolved ?? 0) + (r.external ?? 0) + (r.unresolved ?? 0) || 1;
  const unresolved = graph.nodes.filter((n) => n.kind === 'unresolved');
  const warnings = graph.diagnostics.filter((d) => d.level !== 'info');
  const generated = new Date(graph.generatedAt);

  return (
    <div className="details overview">
      <header className="details-head">
        <p className="eyebrow">{o.eyebrow}</p>
        <h2 className="details-name">{graph.project.name}</h2>
        <p className="details-sub mono" title={graph.project.root}>
          {displayPath(graph.project.root)}
        </p>
      </header>

      {stats.files === 0 ? (
        <div className="callout warn">{o.noFiles}</div>
      ) : (
        <>
          <div className="stat-grid">
            {CARD_KINDS.map((k) => (
              <div
                key={k}
                className={`stat${k === 'unresolved' && stats.nodesByKind[k] ? ' stat-warn' : ''}`}
              >
                <span className="stat-value">{stats.nodesByKind[k] ?? 0}</span>
                <span className="stat-label">
                  <KindDot kind={k} /> {labels.node[k]}
                </span>
              </div>
            ))}
            <div className="stat">
              <span className="stat-value">{stats.importCycles.length}</span>
              <span className="stat-label">
                <span className="kind-dot cycle-dot" /> {o.cycles}
              </span>
            </div>
          </div>

          <section className="details-section">
            <h3 className="section-title">{o.relationsFound}</h3>
            <div className="res-bar" role="img" aria-label={o.relationsAria}>
              <span
                className="res-resolved"
                style={{ width: `${((r.resolved ?? 0) / total) * 100}%` }}
              />
              <span
                className="res-external"
                style={{ width: `${((r.external ?? 0) / total) * 100}%` }}
              />
              <span
                className="res-unresolved"
                style={{ width: `${((r.unresolved ?? 0) / total) * 100}%` }}
              />
            </div>
            <ul className="res-legend">
              <li>
                <span className="sw res-resolved" /> {o.resolved(r.resolved ?? 0)}
              </li>
              <li>
                <span className="sw res-external" /> {o.external(r.external ?? 0)}
              </li>
              <li>
                <span className="sw res-unresolved" /> {o.unresolved(r.unresolved ?? 0)}
              </li>
            </ul>
          </section>

          {stats.importCycles.length > 0 && (
            <section className="details-section">
              <h3 className="section-title">
                {o.importCycles} <span className="count">{stats.importCycles.length}</span>
              </h3>
              <ul className="cycle-list">
                {stats.importCycles.slice(0, 20).map((cycle) => (
                  <li key={cycle.join('|')}>
                    {cycle.map((id, i) => (
                      <span key={id}>
                        <button
                          type="button"
                          className="link-button mono"
                          onClick={() => onNavigate(id)}
                        >
                          {index.node(id)?.qualifiedName ?? id}
                        </button>
                        {i < cycle.length - 1 ? <span className="muted"> ⇄ </span> : null}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {unresolved.length > 0 && (
            <section className="details-section">
              <h3 className="section-title">
                {o.unresolvedTitle} <span className="count">{unresolved.length}</span>
              </h3>
              <p className="muted small">{o.unresolvedHint}</p>
              <ul className="rel-list">
                {unresolved.slice(0, 40).map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      className="rel-item"
                      onClick={() => onNavigate(n.id)}
                      title={n.meta?.reason ? t.reasons[n.meta.reason] : undefined}
                    >
                      <KindDot kind="unresolved" />
                      <span className="rel-name mono">{n.name}</span>
                      <span className="rel-loc">{n.location?.file}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="details-section">
            <h3 className="section-title">{o.leftOut}</h3>
            <dl className="kv">
              <dt>{o.externalCalls}</dt>
              <dd>{stats.externalCallsSkipped}</dd>
              <dt>{o.unknownReceiver}</dt>
              <dd>{stats.unknownReceiverCalls}</dd>
              <dt>{o.computedCalls}</dt>
              <dd>{stats.computedCalls}</dd>
              <dt>{o.localCalls}</dt>
              <dd>{stats.localCalls ?? 0}</dd>
            </dl>
          </section>
        </>
      )}

      {warnings.length > 0 && (
        <section className="details-section">
          <h3 className="section-title">
            {o.warnings} <span className="count">{warnings.length}</span>
          </h3>
          <ul className="diag-list">
            {warnings.slice(0, 30).map((d, i) => (
              <li key={i}>
                {d.file && (
                  <span className="mono">
                    {d.file}
                    {d.line ? `:${d.line}` : ''}
                  </span>
                )}{' '}
                {d.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="details-section">
        <h3 className="section-title">{o.howTo}</h3>
        <ul className="tips">
          {o.tips.map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
      </section>

      <p className="muted small details-section">
        {o.analyzedAt(
          generated.toLocaleString(locale),
          stats.durationMs,
          graph.analyzer.typescriptVersion,
        )}
        {graph.project.tsconfig ? ` · ${graph.project.tsconfig}` : ''}
      </p>
    </div>
  );
}
