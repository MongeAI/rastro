import { useState } from 'react';
import type { ChangeSet, GraphNode } from '@rastro/core';
import type { ChangeImpact } from '@rastro/graph';
import { copyText } from '../lib/editor';
import { useI18n } from '../lib/i18n';
import { entityName } from '../lib/names';
import { shellQuote } from '../lib/shell';
import { IconCopy } from './Icons';
import { KindDot } from './KindBadge';

interface Props {
  changes: ChangeSet;
  impact: ChangeImpact;
  highlight: boolean;
  onHighlight(value: boolean): void;
  onNavigate(id: string): void;
}

const MAX = 40;

/** Aba "Mudanças": o que mudou no git e quem pode ser afetado. */
export function ChangesPanel({ changes, impact, highlight, onHighlight, onNavigate }: Props) {
  const { t, labels } = useI18n();
  const c = t.changes;
  const newFiles = impact.changedFiles.filter((f) =>
    changes.files.some((cf) => cf.file === (f.qualifiedName ?? f.name) && cf.status === 'added'),
  );

  const list = (nodes: GraphNode[], extra?: (n: GraphNode) => string) => (
    <ul className="rel-list">
      {nodes.slice(0, MAX).map((n) => (
        <li key={n.id}>
          <button type="button" className="rel-item" onClick={() => onNavigate(n.id)}>
            <KindDot kind={n.kind} />
            <span className="rel-name">{entityName(n)}</span>
            {extra && <span className="rel-loc">{extra(n)}</span>}
          </button>
        </li>
      ))}
      {nodes.length > MAX && (
        <li className="muted small">{t.common.andMore(nodes.length - MAX)}</li>
      )}
    </ul>
  );

  return (
    <div className="details">
      <header className="details-head">
        <p className="eyebrow">{c.eyebrow}</p>
        <h2 className="details-name">
          {changes.baseLabel === 'HEAD' ? c.sinceHead : c.since(changes.baseLabel)}
        </h2>
        {changes.files.length > 0 && (
          <>
            <p className="muted small">
              {c.stats(changes.files.length, impact.changedEntities.length)}
            </p>
            <p className="muted small">{c.impactSummary(impact.impacted.length)}</p>
            <label className="toggle">
              <input
                type="checkbox"
                checked={highlight}
                onChange={(e) => onHighlight(e.target.checked)}
              />
              {c.highlight}
              <span className="change-legend">
                <span className="sw change-sw" /> {c.legendChanged}
                <span className="sw impact-sw" /> {c.legendImpacted}
              </span>
            </label>
          </>
        )}
      </header>

      {changes.files.length === 0 && <p className="muted small details-section">{c.none}</p>}

      {impact.changedEntities.length > 0 && (
        <section className="details-section">
          <h3 className="section-title">
            {c.changed} <span className="count">{impact.changedEntities.length}</span>
          </h3>
          {list(impact.changedEntities, (n) => n.location?.file ?? '')}
        </section>
      )}

      {newFiles.length > 0 && (
        <section className="details-section">
          <h3 className="section-title">
            {c.newFiles} <span className="count">{newFiles.length}</span>
          </h3>
          {list(newFiles)}
        </section>
      )}

      {impact.broken.length > 0 && (
        <section className="details-section">
          <h3 className="section-title">
            {c.broken} <span className="count">{impact.broken.length}</span>
          </h3>
          <p className="muted small insight-hint">{c.brokenHint}</p>
          <ul className="rel-list">
            {impact.broken.slice(0, MAX).map((b, i) => (
              <li key={`${b.from.id}|${b.reference}|${i}`}>
                <button
                  type="button"
                  className="rel-item"
                  title={b.evidence ? `${b.evidence.file}:${b.evidence.line}` : undefined}
                  onClick={() => onNavigate(b.from.id)}
                >
                  <KindDot kind={b.from.kind} />
                  <span className="rel-name">
                    {entityName(b.from)} → <span className="mono">{b.reference}</span>
                  </span>
                  <span className="rel-loc">
                    {b.target} · {c.brokenWhy(b.why)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {impact.broken.length > MAX && (
            <p className="muted small">{t.common.andMore(impact.broken.length - MAX)}</p>
          )}
        </section>
      )}

      {impact.routes.length > 0 && (
        <section className="details-section">
          <h3 className="section-title">
            {c.routes} <span className="count">{impact.routes.length}</span>
          </h3>
          {list(impact.routes, (n) => n.location?.file ?? '')}
        </section>
      )}

      {impact.tests.length > 0 && (
        <section className="details-section">
          <h3 className="section-title">
            {c.tests} <span className="count">{impact.tests.length}</span>
          </h3>
          <p className="muted small insight-hint">{c.testsHint}</p>
          {list(impact.tests)}
          <CopyTests files={impact.tests.map((f) => f.qualifiedName ?? f.name)} />
        </section>
      )}

      {impact.impacted.length > 0 && (
        <section className="details-section">
          <h3 className="section-title">
            {c.impacted} <span className="count">{impact.impacted.length}</span>
          </h3>
          <ul className="rel-list">
            {impact.impacted.slice(0, MAX).map((i) => (
              <li key={i.node.id}>
                <button type="button" className="rel-item" onClick={() => onNavigate(i.node.id)}>
                  <span className="depth-pill" title={t.common.distance}>
                    {i.depth}
                  </span>
                  <KindDot kind={i.node.kind} />
                  <span className="rel-name">{entityName(i.node)}</span>
                  <span className="rel-loc">{labels.edge[i.via.kind].toLowerCase()}</span>
                </button>
              </li>
            ))}
          </ul>
          {impact.impacted.length > MAX && (
            <p className="muted small">{t.common.andMore(impact.impacted.length - MAX)}</p>
          )}
        </section>
      )}

      {impact.outsideGraph.length > 0 && (
        <section className="details-section">
          <h3 className="section-title">
            {c.outside} <span className="count">{impact.outsideGraph.length}</span>
          </h3>
          <p className="muted small insight-hint">{c.outsideHint}</p>
          <ul className="diag-list">
            {impact.outsideGraph.slice(0, MAX).map((f) => (
              <li key={f.file}>
                <span className="mono">{f.file}</span>{' '}
                <span className="tag">{c.status[f.status]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Copia os caminhos dos testes (separados por espaço) para colar no executor de testes. */
function CopyTests({ files }: { files: string[] }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="button-row">
      <button
        type="button"
        className="button ghost"
        title={t.changes.copyTestsTitle}
        onClick={async () => {
          // o texto vai para um shell: o que não for um caminho comum vai entre aspas simples
          // (os nomes vêm do projeto analisado, e `;`, `|`, `>`… executariam comandos)
          const ok = await copyText(files.map(shellQuote).join(' '));
          setCopied(ok);
          setTimeout(() => setCopied(false), 1400);
        }}
      >
        <IconCopy /> {copied ? t.common.copied : t.changes.copyTests}
      </button>
    </div>
  );
}
