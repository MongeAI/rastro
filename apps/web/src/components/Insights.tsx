import { useMemo } from 'react';
import type { GraphNode } from '@rastro/core';
import { computeInsights, type GraphIndex, type RankedNode } from '@rastro/graph';
import { useI18n } from '../lib/i18n';
import { KindDot } from './KindBadge';

interface Props {
  index: GraphIndex;
  onNavigate(id: string): void;
}

const label = (n: GraphNode) => n.qualifiedName ?? n.name;

/** Painel "Insights": rankings e possíveis sobras, todos clicáveis. */
export function Insights({ index, onNavigate }: Props) {
  const { t } = useI18n();
  const i = t.insights;
  const data = useMemo(() => computeInsights(index, 8), [index]);

  const ranking = (
    title: string,
    hint: string,
    rows: RankedNode[],
    unit: (n: number) => string,
  ) => (
    <section className="details-section">
      <h3 className="section-title">{title}</h3>
      <p className="muted small insight-hint">{hint}</p>
      {rows.length === 0 ? (
        <p className="muted small">{i.none}</p>
      ) : (
        <ul className="rel-list">
          {rows.map((r) => (
            <li key={r.node.id}>
              <button
                type="button"
                className="rel-item insight-row"
                onClick={() => onNavigate(r.node.id)}
              >
                <KindDot kind={r.node.kind} />
                <span className="rel-name">{label(r.node)}</span>
                <span className="rel-count">{unit(r.value)}</span>
                <span
                  className="insight-bar"
                  style={{
                    width: `${Math.max(4, (r.value / Math.max(1, rows[0]!.value)) * 100)}%`,
                  }}
                  aria-hidden="true"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  const unusedList = (title: string, hint: string, nodes: GraphNode[]) =>
    nodes.length > 0 && (
      <section className="details-section">
        <h3 className="section-title">
          {title} <span className="count">{nodes.length}</span>
        </h3>
        <p className="muted small insight-hint">{hint}</p>
        <ul className="rel-list">
          {nodes.slice(0, 40).map((n) => (
            <li key={n.id}>
              <button type="button" className="rel-item" onClick={() => onNavigate(n.id)}>
                <KindDot kind={n.kind} />
                <span className="rel-name">{label(n)}</span>
                <span className="rel-loc">
                  {n.location?.file}:{n.location?.startLine}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {nodes.length > 40 && <p className="muted small">{t.common.andMore(nodes.length - 40)}</p>}
      </section>
    );

  return (
    <div className="details insights">
      <header className="details-head">
        <p className="eyebrow">{i.tabInsights}</p>
        <h2 className="details-name">{i.title}</h2>
        <p className="muted small">{i.intro}</p>
      </header>
      {ranking(i.mostCalled, i.mostCalledHint, data.mostCalled, i.callers)}
      {ranking(i.mostCalling, i.mostCallingHint, data.mostCalling, i.callees)}
      {ranking(i.mostImported, i.mostImportedHint, data.mostImported, i.importers)}
      {ranking(i.mostDependencies, i.mostDependenciesHint, data.mostDependencies, i.importers)}
      {ranking(i.largestFiles, '', data.largestFiles, i.lines)}
      {data.coupledModules.length > 0 && (
        <section className="details-section">
          <h3 className="section-title">{i.coupled}</h3>
          <p className="muted small insight-hint">{i.coupledHint}</p>
          <ul className="rel-list">
            {data.coupledModules.map((c) => (
              <li key={`${c.from.id}->${c.to.id}`}>
                <button type="button" className="rel-item" onClick={() => onNavigate(c.from.id)}>
                  <KindDot kind="module" />
                  <span className="rel-name mono">
                    {c.from.qualifiedName} → {c.to.qualifiedName}
                  </span>
                  <span className="rel-count">{i.imports(c.imports)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {unusedList(i.unusedInternal, i.unusedHint, data.unused.internal)}
      {unusedList(i.unusedExported, i.unusedExportedHint, data.unused.exported)}
    </div>
  );
}
