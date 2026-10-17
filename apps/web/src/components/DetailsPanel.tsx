import { useMemo, useState } from 'react';
import {
  EDGE_KIND_INVERSE_LABELS,
  EDGE_KIND_LABELS,
  NODE_KIND_LABELS,
  RESOLUTION_LABELS,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
} from '@teia/core';
import type { GraphIndex } from '@teia/graph';
import { absolutePath, copyText, EDITORS, type EditorId } from '../lib/editor';
import { DISCOVERY_TEXT, plural, REASON_TEXT } from '../lib/explain';
import { IconClose, IconCopy, IconExpand, IconExternal, IconLayers, IconTarget } from './Icons';
import { KindBadge, KindDot } from './KindBadge';
import { SourceView } from './SourceView';

interface Props {
  index: GraphIndex;
  nodeId: string;
  editor: EditorId;
  sourceAvailable: boolean;
  focusId: string | null;
  focusDepth: number;
  expanded: boolean;
  onNavigate(id: string): void;
  onFocus(id: string | null): void;
  onFocusDepth(depth: number): void;
  onExpandNeighbors(id: string): void;
  onToggleExpand(fileId: string): void;
  onClose(): void;
}

const REL_ORDER: EdgeKind[] = ['calls', 'imports', 'extends', 'exports', 'depends_on'];
const MAX_ITEMS = 60;

export function DetailsPanel(p: Props) {
  const { index } = p;
  const node = index.node(p.nodeId);
  const [copied, setCopied] = useState(false);
  const [showImpact, setShowImpact] = useState(false);
  const impact = useMemo(
    () => (showImpact ? index.impact(p.nodeId) : []),
    [index, p.nodeId, showImpact],
  );

  if (!node) return null;
  const root = index.graph.project.root;
  const loc = node.location;
  const file = index.fileOf(node.id);
  const filePath = loc?.file ?? (node.kind === 'file' ? node.qualifiedName : undefined);
  const outgoing = index.outgoing(node.id).filter((e) => e.kind !== 'contains');
  const incoming = index.incoming(node.id).filter((e) => e.kind !== 'contains');
  const children = index
    .children(node.id)
    .filter((c) => c.kind !== 'unresolved')
    .sort(
      (a, b) =>
        (a.location?.startLine ?? 0) - (b.location?.startLine ?? 0) || a.name.localeCompare(b.name),
    );
  const editorUrl = (f: string, line: number, col = 1) =>
    EDITORS[p.editor].url(absolutePath(root, f), line, col);
  const focused = p.focusId === node.id;
  const reason = node.meta?.reason;

  const copyLocation = async () => {
    if (!filePath) return;
    const ok = await copyText(
      loc && node.kind !== 'file' ? `${filePath}:${loc.startLine}` : filePath,
    );
    setCopied(ok);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="details">
      <header className="details-head">
        <div className="details-kind">
          <KindBadge kind={node.kind} />
          <button
            type="button"
            className="icon-button"
            onClick={p.onClose}
            aria-label="Fechar detalhes"
            title="Fechar (Esc)"
          >
            <IconClose />
          </button>
        </div>
        <h2 className="details-name">
          {node.kind === 'method' ? (node.qualifiedName ?? node.name) : node.name}
        </h2>
        {node.kind === 'route' && node.qualifiedName && (
          <p className="details-sub mono">{node.qualifiedName}</p>
        )}
        {node.kind === 'file' && node.qualifiedName && (
          <p className="details-sub mono">{node.qualifiedName}</p>
        )}
        {node.kind === 'module' && <p className="details-sub mono">{node.qualifiedName}/</p>}
        <Chips node={node} />
      </header>

      {reason && (
        <div className="callout warn">
          <strong>Referência não resolvida.</strong> {REASON_TEXT[reason]}
          {node.meta?.reference && <code className="callout-code">{node.meta.reference}</code>}
        </div>
      )}
      {node.meta?.inCycle && (
        <div className="callout cycle">
          Este arquivo faz parte de um <strong>ciclo de importação</strong>: ele depende, direta ou
          indiretamente, de quem depende dele.
        </div>
      )}

      {filePath && (
        <section className="details-section">
          <h3 className="section-title">Localização</h3>
          <div className="location">
            <span className="mono">
              {filePath}
              {loc && node.kind !== 'file'
                ? `:${loc.startLine}${loc.endLine !== loc.startLine ? `–${loc.endLine}` : ''}`
                : ''}
            </span>
          </div>
          <div className="button-row">
            {node.meta?.analyzed !== false && (
              <a
                className="button"
                href={editorUrl(filePath, loc?.startLine ?? 1, loc?.startColumn ?? 1)}
              >
                <IconExternal /> Abrir no editor
              </a>
            )}
            <button type="button" className="button ghost" onClick={copyLocation}>
              <IconCopy /> {copied ? 'Copiado!' : 'Copiar caminho'}
            </button>
          </div>
        </section>
      )}

      <section className="details-section">
        <h3 className="section-title">Explorar</h3>
        <div className="button-row">
          <button
            type="button"
            className={`button${focused ? ' on' : ''}`}
            onClick={() => p.onFocus(focused ? null : node.id)}
            title="Mostra só esta entidade e suas conexões"
          >
            <IconTarget /> {focused ? 'Sair do foco' : 'Focar vizinhança'}
          </button>
          <button
            type="button"
            className="button ghost"
            onClick={() => p.onExpandNeighbors(node.id)}
            title="Adiciona ao mapa as entidades conectadas, mantendo o resto"
          >
            <IconExpand /> Expandir conexões
          </button>
          {node.kind === 'file' && children.length > 0 && (
            <button
              type="button"
              className="button ghost"
              onClick={() => p.onToggleExpand(node.id)}
            >
              <IconLayers /> {p.expanded ? 'Recolher símbolos' : 'Mostrar símbolos'}
            </button>
          )}
        </div>
        {focused && (
          <div className="depth">
            <span className="muted small">Distância</span>
            {[1, 2, 3].map((d) => (
              <button
                key={d}
                type="button"
                className={`chip-button${p.focusDepth === d ? ' on' : ''}`}
                onClick={() => p.onFocusDepth(d)}
              >
                {d}
              </button>
            ))}
          </div>
        )}
      </section>

      {REL_ORDER.map((kind) => {
        const out = outgoing.filter((e) => e.kind === kind);
        const inc = incoming.filter((e) => e.kind === kind);
        if (!out.length && !inc.length) return null;
        return (
          <section className="details-section" key={kind}>
            {out.length > 0 && (
              <RelationList
                title={EDGE_KIND_LABELS[kind]}
                edges={out}
                direction="out"
                {...{ index, onNavigate: p.onNavigate, editorUrl }}
              />
            )}
            {inc.length > 0 && (
              <RelationList
                title={EDGE_KIND_INVERSE_LABELS[kind]}
                edges={inc}
                direction="in"
                {...{ index, onNavigate: p.onNavigate, editorUrl }}
              />
            )}
          </section>
        );
      })}
      {!outgoing.length && !incoming.length && node.kind !== 'module' && (
        <p className="muted small details-section">Nenhuma relação conhecida além da hierarquia.</p>
      )}

      {children.length > 0 && (
        <section className="details-section">
          <h3 className="section-title">
            {node.kind === 'module'
              ? 'Conteúdo'
              : node.kind === 'class'
                ? 'Membros'
                : 'Definido aqui'}{' '}
            <span className="count">{children.length}</span>
          </h3>
          <ul className="rel-list">
            {children.slice(0, MAX_ITEMS).map((c) => (
              <li key={c.id}>
                <button type="button" className="rel-item" onClick={() => p.onNavigate(c.id)}>
                  <KindDot kind={c.kind} />
                  <span className="rel-name">{c.name}</span>
                  {c.location && <span className="rel-loc">:{c.location.startLine}</span>}
                  {c.meta?.exported && <span className="tag">exportado</span>}
                </button>
              </li>
            ))}
          </ul>
          {children.length > MAX_ITEMS && (
            <p className="muted small">… e mais {children.length - MAX_ITEMS}.</p>
          )}
        </section>
      )}

      {node.kind !== 'package' && node.kind !== 'module' && (
        <section className="details-section">
          <h3 className="section-title">Impacto de uma alteração</h3>
          {!showImpact ? (
            <button type="button" className="button ghost" onClick={() => setShowImpact(true)}>
              Calcular quem pode ser afetado
            </button>
          ) : impact.length === 0 ? (
            <p className="muted small">
              Nenhuma entidade conhecida depende desta (considerando só relações resolvidas).
            </p>
          ) : (
            <>
              <p className="muted small">
                {plural(impact.length, 'entidade depende', 'entidades dependem')} desta, direta ou
                indiretamente (chamadas, imports e herança resolvidos).
              </p>
              <ul className="rel-list">
                {impact.slice(0, MAX_ITEMS).map((i) => (
                  <li key={i.node.id}>
                    <button
                      type="button"
                      className="rel-item"
                      onClick={() => p.onNavigate(i.node.id)}
                    >
                      <span className="depth-pill" title="distância">
                        {i.depth}
                      </span>
                      <KindDot kind={i.node.kind} />
                      <span className="rel-name">
                        {i.node.qualifiedName && i.node.kind !== 'file'
                          ? i.node.qualifiedName
                          : i.node.name}
                      </span>
                      <span className="rel-loc">{EDGE_KIND_LABELS[i.via.kind].toLowerCase()}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {loc && node.meta?.analyzed !== false && node.kind !== 'module' && (
        <section className="details-section">
          <h3 className="section-title">Código</h3>
          <SourceView
            file={loc.file}
            startLine={node.kind === 'file' ? 1 : loc.startLine}
            endLine={node.kind === 'file' ? Math.min(loc.endLine, 40) : loc.endLine}
            available={p.sourceAvailable}
          />
        </section>
      )}
      {file && file.id !== node.id && (
        <p className="muted small details-section">
          Arquivo:{' '}
          <button type="button" className="link-button" onClick={() => p.onNavigate(file.id)}>
            {file.qualifiedName}
          </button>
        </p>
      )}
    </div>
  );
}

function Chips({ node }: { node: GraphNode }) {
  const m = node.meta ?? {};
  const chips: string[] = [];
  if (m.exported) chips.push(m.defaultExport ? 'export default' : 'exportado');
  if (m.async) chips.push('async');
  if (m.static) chips.push('static');
  if (m.memberKind && m.memberKind !== 'method')
    chips.push(
      {
        constructor: 'construtor',
        getter: 'getter',
        setter: 'setter',
        property: 'propriedade-função',
        method: '',
      }[m.memberKind],
    );
  if (m.language) chips.push(m.language.toUpperCase());
  if (m.lines) chips.push(`${m.lines} linhas`);
  if (m.analyzed === false) chips.push('não analisado');
  if (m.builtin) chips.push('nativo do Node.js');
  else if (node.kind === 'package')
    chips.push(m.declared ? 'declarado no package.json' : 'não declarado');
  if (m.outsideRoot) chips.push('fora da raiz');
  if (m.framework) chips.push(m.framework);
  if (!chips.length) return null;
  return (
    <div className="chips">
      {chips.map((c) => (
        <span key={c} className="tag">
          {c}
        </span>
      ))}
    </div>
  );
}

interface RelationListProps {
  title: string;
  edges: GraphEdge[];
  direction: 'in' | 'out';
  index: GraphIndex;
  onNavigate(id: string): void;
  editorUrl(file: string, line: number, col?: number): string;
}

function RelationList({
  title,
  edges,
  direction,
  index,
  onNavigate,
  editorUrl,
}: RelationListProps) {
  const [expanded, setExpanded] = useState(false);
  const sorted = [...edges].sort((a, b) => {
    const na = index.node(direction === 'out' ? a.target : a.source)?.name ?? '';
    const nb = index.node(direction === 'out' ? b.target : b.source)?.name ?? '';
    return na.localeCompare(nb);
  });
  const visible = expanded ? sorted : sorted.slice(0, 12);
  return (
    <>
      <h3 className="section-title">
        {title} <span className="count">{edges.length}</span>
      </h3>
      <ul className="rel-list">
        {visible.map((e) => {
          const other = index.node(direction === 'out' ? e.target : e.source);
          if (!other) return null;
          const ev = e.evidence[0];
          const count = e.meta?.count ?? e.evidence.length;
          return (
            <li key={e.id} className="rel">
              <button
                type="button"
                className="rel-item"
                onClick={() => onNavigate(other.id)}
                title={`${NODE_KIND_LABELS[other.kind]} · ${RESOLUTION_LABELS[e.resolution]} · ${DISCOVERY_TEXT[e.discovery]}`}
              >
                <KindDot kind={other.kind} />
                <span className="rel-name">
                  {other.qualifiedName && other.kind !== 'file' && other.kind !== 'module'
                    ? other.qualifiedName
                    : other.name}
                </span>
                {e.resolution !== 'resolved' && (
                  <span className={`tag res-${e.resolution}`}>
                    {e.resolution === 'external' ? 'externo' : 'não resolvido'}
                  </span>
                )}
                {e.meta?.typeOnly && <span className="tag">tipo</span>}
                {e.meta?.callKind === 'new' && <span className="tag">new</span>}
                {e.meta?.callKind === 'jsx' && <span className="tag">JSX</span>}
                {e.meta?.callKind === 'route-handler' && <span className="tag">handler</span>}
                {e.meta?.reexport && <span className="tag">reexporta</span>}
                {count > 1 && <span className="rel-count">{count}×</span>}
              </button>
              {ev && (
                <a
                  className="evidence"
                  href={editorUrl(ev.file, ev.line, ev.column)}
                  title="Abrir este trecho no editor"
                >
                  <span className="evidence-loc">
                    {ev.file}:{ev.line}
                  </span>
                  {ev.snippet && <code className="evidence-code">{ev.snippet}</code>}
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {sorted.length > visible.length && (
        <button type="button" className="link-button" onClick={() => setExpanded(true)}>
          Mostrar todas ({sorted.length})
        </button>
      )}
    </>
  );
}
