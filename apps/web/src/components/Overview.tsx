import { NODE_KIND_LABELS, type NodeKind, type RastroGraph } from '@rastro/core';
import type { GraphIndex } from '@rastro/graph';
import { REASON_TEXT } from '../lib/explain';
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
  const r = stats.edgesByResolution;
  const total = (r.resolved ?? 0) + (r.external ?? 0) + (r.unresolved ?? 0) || 1;
  const unresolved = graph.nodes.filter((n) => n.kind === 'unresolved');
  const warnings = graph.diagnostics.filter((d) => d.level !== 'info');
  const generated = new Date(graph.generatedAt);

  return (
    <div className="details overview">
      <header className="details-head">
        <p className="eyebrow">Resumo da análise</p>
        <h2 className="details-name">{graph.project.name}</h2>
        <p className="details-sub mono" title={graph.project.root}>
          {displayPath(graph.project.root)}
        </p>
      </header>

      {stats.files === 0 ? (
        <div className="callout warn">
          Nenhum arquivo JavaScript ou TypeScript foi encontrado neste projeto. Confira se o caminho
          está certo e se os arquivos não estão em pastas ignoradas (node_modules, dist, build ou o
          .gitignore).
        </div>
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
                  <KindDot kind={k} /> {NODE_KIND_LABELS[k]}
                  {k === 'file' || k === 'unresolved' ? '' : ''}
                </span>
              </div>
            ))}
            <div className="stat">
              <span className="stat-value">{stats.importCycles.length}</span>
              <span className="stat-label">
                <span className="kind-dot cycle-dot" /> Ciclos
              </span>
            </div>
          </div>

          <section className="details-section">
            <h3 className="section-title">Relações encontradas</h3>
            <div
              className="res-bar"
              role="img"
              aria-label="Proporção de relações resolvidas, externas e não resolvidas"
            >
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
                <span className="sw res-resolved" /> {r.resolved ?? 0} resolvidas no projeto
              </li>
              <li>
                <span className="sw res-external" /> {r.external ?? 0} externas
              </li>
              <li>
                <span className="sw res-unresolved" /> {r.unresolved ?? 0} não resolvidas
              </li>
            </ul>
          </section>

          {stats.importCycles.length > 0 && (
            <section className="details-section">
              <h3 className="section-title">
                Ciclos de importação <span className="count">{stats.importCycles.length}</span>
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
                Não resolvidos <span className="count">{unresolved.length}</span>
              </h3>
              <p className="muted small">
                O Rastro não inventa conexões: estas referências existem no código, mas o destino
                não pôde ser comprovado.
              </p>
              <ul className="rel-list">
                {unresolved.slice(0, 40).map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      className="rel-item"
                      onClick={() => onNavigate(n.id)}
                      title={n.meta?.reason ? REASON_TEXT[n.meta.reason] : undefined}
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
            <h3 className="section-title">Fora do grafo, por cautela</h3>
            <dl className="kv">
              <dt>Chamadas para bibliotecas e APIs nativas</dt>
              <dd>{stats.externalCallsSkipped}</dd>
              <dt>Chamadas em objetos sem tipo conhecido</dt>
              <dd>{stats.unknownReceiverCalls}</dd>
              <dt>Chamadas por nome calculado (obj[x]())</dt>
              <dd>{stats.computedCalls}</dd>
              <dt>Chamadas a funções locais (declaradas dentro de outras)</dt>
              <dd>{stats.localCalls ?? 0}</dd>
            </dl>
          </section>
        </>
      )}

      {warnings.length > 0 && (
        <section className="details-section">
          <h3 className="section-title">
            Avisos <span className="count">{warnings.length}</span>
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
        <h3 className="section-title">Como explorar</h3>
        <ul className="tips">
          <li>
            Clique em um nó para ver detalhes, código e relações. <kbd>Esc</kbd> limpa a seleção.
          </li>
          <li>Dois cliques em um arquivo com “+” mostram as funções e classes dele.</li>
          <li>
            <kbd>/</kbd> abre a busca. “Focar vizinhança” isola uma entidade e suas conexões.
          </li>
          <li>Linhas tracejadas vermelhas são referências que não puderam ser resolvidas.</li>
        </ul>
      </section>

      <p className="muted small details-section">
        Analisado em {generated.toLocaleString('pt-BR')} · {stats.durationMs} ms · TypeScript{' '}
        {graph.analyzer.typescriptVersion}
        {graph.project.tsconfig ? ` · ${graph.project.tsconfig}` : ''}
      </p>
    </div>
  );
}
