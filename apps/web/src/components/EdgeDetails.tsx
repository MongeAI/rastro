import {
  EDGE_KIND_LABELS,
  NODE_KIND_LABELS,
  RESOLUTION_LABELS,
  type GraphEdge,
} from '@rastro/core';
import type { GraphIndex, ViewEdge } from '@rastro/graph';
import { absolutePath, EDITORS, type EditorId } from '../lib/editor';
import { DISCOVERY_TEXT, plural } from '../lib/explain';
import { IconClose } from './Icons';
import { KindDot } from './KindBadge';

interface Props {
  index: GraphIndex;
  edge: ViewEdge;
  editor: EditorId;
  onNavigate(id: string): void;
  onClose(): void;
}

const MAX_MEMBERS = 80;

/** Detalhes de uma linha do mapa: as relações reais que ela representa e suas evidências. */
export function EdgeDetails({ index, edge, editor, onNavigate, onClose }: Props) {
  const source = index.node(edge.source);
  const target = index.node(edge.target);
  const members = edge.members
    .map((id) => index.edges.get(id))
    .filter((e): e is GraphEdge => !!e)
    .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  const root = index.graph.project.root;
  const name = (id: string) => {
    const n = index.node(id);
    if (!n) return id;
    return n.qualifiedName && n.kind !== 'module' && n.kind !== 'file'
      ? n.qualifiedName
      : (n.qualifiedName ?? n.name);
  };

  return (
    <div className="details">
      <header className="details-head">
        <div className="details-kind">
          <span className="kind-badge">
            <span className={`edge-swatch e-${edge.kind}`} aria-hidden="true" />
            Relação · {EDGE_KIND_LABELS[edge.kind]}
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Fechar detalhes"
            title="Fechar (Esc)"
          >
            <IconClose />
          </button>
        </div>
        <div className="edge-ends">
          {[source, target].map((n, i) =>
            n ? (
              <button
                key={n.id}
                type="button"
                className="rel-item edge-end"
                onClick={() => onNavigate(n.id)}
              >
                <span className="muted small">{i === 0 ? 'de' : 'para'}</span>
                <KindDot kind={n.kind} />
                <span className="rel-name">{name(n.id)}</span>
              </button>
            ) : null,
          )}
        </div>
        <div className="chips">
          <span className="tag">{RESOLUTION_LABELS[edge.resolution]}</span>
          <span className="tag">{plural(edge.count, 'ocorrência', 'ocorrências')}</span>
          {edge.aggregated && (
            <span className="tag">
              {plural(members.length, 'relação somada', 'relações somadas')}
            </span>
          )}
          {edge.typeOnly && <span className="tag">só tipos</span>}
        </div>
      </header>

      {edge.aggregated && (
        <p className="muted small details-section">
          Esta linha soma relações entre itens que estão dentro de pastas recolhidas. Abra a pasta
          (duplo clique) para ver cada uma separadamente.
        </p>
      )}

      <section className="details-section">
        <h3 className="section-title">
          {edge.aggregated ? 'Relações somadas' : 'Evidências'}{' '}
          <span className="count">
            {edge.aggregated ? members.length : members.reduce((n, m) => n + m.evidence.length, 0)}
          </span>
        </h3>
        <ul className="rel-list">
          {members.slice(0, MAX_MEMBERS).map((m) => (
            <li key={m.id} className="rel">
              {edge.aggregated && (
                <div className="member-ends">
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onNavigate(m.source)}
                  >
                    {name(m.source)}
                  </button>
                  <span className="muted"> → </span>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onNavigate(m.target)}
                  >
                    {name(m.target)}
                  </button>
                </div>
              )}
              <p className="muted small member-meta" title={DISCOVERY_TEXT[m.discovery]}>
                {NODE_KIND_LABELS[index.node(m.target)?.kind ?? 'file']} ·{' '}
                {DISCOVERY_TEXT[m.discovery]}
                {m.meta?.specifier ? ` · '${m.meta.specifier}'` : ''}
                {m.meta?.viaDeclaration ? ' · ligada via declaração .d.ts' : ''}
              </p>
              {m.evidence.map((ev) => (
                <a
                  key={`${ev.file}:${ev.line}:${ev.column}`}
                  className="evidence"
                  href={EDITORS[editor].url(absolutePath(root, ev.file), ev.line, ev.column)}
                  title="Abrir este trecho no editor"
                >
                  <span className="evidence-loc">
                    {ev.file}:{ev.line}
                  </span>
                  {ev.snippet && <code className="evidence-code">{ev.snippet}</code>}
                </a>
              ))}
              {(m.meta?.count ?? 0) > m.evidence.length && (
                <p className="muted small">
                  … e mais {(m.meta?.count ?? 0) - m.evidence.length} ocorrências.
                </p>
              )}
            </li>
          ))}
        </ul>
        {members.length > MAX_MEMBERS && (
          <p className="muted small">… e mais {members.length - MAX_MEMBERS} relações.</p>
        )}
      </section>
    </div>
  );
}
