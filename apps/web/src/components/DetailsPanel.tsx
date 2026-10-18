import { useMemo, useState } from 'react';
import { type EdgeKind, type GraphEdge, type GraphNode } from '@rastro/core';
import type { GraphIndex } from '@rastro/graph';
import { absolutePath, copyText, EDITORS, type EditorId } from '../lib/editor';
import { useI18n, type Messages } from '../lib/i18n';
import {
  IconClose,
  IconCopy,
  IconExpand,
  IconExternal,
  IconLayers,
  IconRoute,
  IconTarget,
} from './Icons';
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
  /** Nível "Símbolos": todos os arquivos já estão expandidos (não há o que alternar). */
  allSymbols: boolean;
  /** Para pastas: está recolhida no mapa. */
  moduleCollapsed: boolean;
  onNavigate(id: string): void;
  onFocus(id: string | null): void;
  onFocusDepth(depth: number): void;
  onExpandNeighbors(id: string): void;
  onToggleExpand(fileId: string): void;
  onToggleModule(moduleId: string): void;
  onStartPath(id: string): void;
  onClose(): void;
}

const REL_ORDER: EdgeKind[] = ['calls', 'imports', 'extends', 'exports', 'depends_on'];
const MAX_ITEMS = 60;

export function DetailsPanel(p: Props) {
  const { index } = p;
  const { t, labels } = useI18n();
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
  // implementações possíveis (chamadas por interface): nunca são relações comprovadas
  const candidates = (node.meta?.candidates ?? [])
    .map((id) => index.node(id))
    .filter((c): c is GraphNode => !!c);
  const possibleCalls = index
    .possibleCallSites(node.id)
    .flatMap((site) => index.incoming(site.id, ['calls']));

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
            aria-label={t.common.close}
            title={t.common.closeEsc}
          >
            <IconClose />
          </button>
        </div>
        <Breadcrumb
          index={index}
          node={node}
          label={t.stage.breadcrumb}
          onNavigate={p.onNavigate}
        />
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
        <Chips node={node} t={t} />
      </header>

      {reason && (
        <div className="callout warn">
          <strong>{t.details.unresolvedTitle}</strong> {t.reasons[reason]}
          {node.meta?.reference && <code className="callout-code">{node.meta.reference}</code>}
        </div>
      )}
      {candidates.length > 0 && (
        <section className="details-section">
          <h3 className="section-title">
            {t.details.possibleTargets} <span className="count">{candidates.length}</span>
          </h3>
          <p className="muted small">{t.details.possibleTargetsHint}</p>
          <ul className="rel-list">
            {candidates.map((c) => (
              <li key={c.id}>
                <button type="button" className="rel-item" onClick={() => p.onNavigate(c.id)}>
                  <KindDot kind={c.kind} />
                  <span className="rel-name">{c.qualifiedName ?? c.name}</span>
                  <span className="tag res-possible">{t.details.possibleTag}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {node.meta?.inCycle && (
        <div className="callout cycle">
          {t.details.cycleBefore}
          <strong>{t.details.cycleStrong}</strong>
          {t.details.cycleAfter}
        </div>
      )}

      {filePath && (
        <section className="details-section">
          <h3 className="section-title">{t.details.location}</h3>
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
                <IconExternal /> {t.common.openInEditor}
              </a>
            )}
            <button type="button" className="button ghost" onClick={copyLocation}>
              <IconCopy /> {copied ? t.common.copied : t.common.copyPath}
            </button>
          </div>
        </section>
      )}

      <section className="details-section">
        <h3 className="section-title">{t.details.explore}</h3>
        <div className="button-row">
          <button
            type="button"
            className={`button${focused ? ' on' : ''}`}
            onClick={() => p.onFocus(focused ? null : node.id)}
            title={t.details.focusTitle}
          >
            <IconTarget /> {focused ? t.details.leaveFocus : t.details.focus}
          </button>
          <button
            type="button"
            className="button ghost"
            onClick={() => p.onExpandNeighbors(node.id)}
            title={t.details.expandTitle}
          >
            <IconExpand /> {t.details.expand}
          </button>
          <button
            type="button"
            className="button ghost"
            onClick={() => p.onStartPath(node.id)}
            title={t.paths.startTitle}
          >
            <IconRoute /> {t.paths.start}
          </button>
          {node.kind === 'file' && children.length > 0 && !p.allSymbols && (
            <button
              type="button"
              className="button ghost"
              onClick={() => p.onToggleExpand(node.id)}
            >
              <IconLayers /> {p.expanded ? t.details.hideSymbols : t.details.showSymbols}
            </button>
          )}
          {node.kind === 'module' && children.some((c) => c.kind === 'file') && (
            <button
              type="button"
              className="button ghost"
              onClick={() => p.onToggleModule(node.id)}
            >
              <IconLayers /> {p.moduleCollapsed ? t.details.openFolder : t.details.collapseFolder}
            </button>
          )}
        </div>
        {focused && (
          <div className="depth">
            <span className="muted small">{t.details.distanceLabel}</span>
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
                title={labels.edge[kind]}
                edges={out}
                direction="out"
                {...{ index, onNavigate: p.onNavigate, editorUrl }}
              />
            )}
            {inc.length > 0 && (
              <RelationList
                title={labels.edgeInverse[kind]}
                edges={inc}
                direction="in"
                {...{ index, onNavigate: p.onNavigate, editorUrl }}
              />
            )}
          </section>
        );
      })}
      {possibleCalls.length > 0 && (
        <section className="details-section">
          <h3 className="section-title">
            {t.details.possibleCallers} <span className="count">{possibleCalls.length}</span>
          </h3>
          <p className="muted small">{t.details.possibleCallersHint}</p>
          <ul className="rel-list">
            {possibleCalls.slice(0, MAX_ITEMS).map((e) => {
              const caller = index.node(e.source);
              if (!caller) return null;
              const ev = e.evidence[0];
              return (
                <li key={e.id} className="rel">
                  <button
                    type="button"
                    className="rel-item"
                    onClick={() => p.onNavigate(caller.id)}
                  >
                    <KindDot kind={caller.kind} />
                    <span className="rel-name">
                      {caller.qualifiedName && caller.kind !== 'file'
                        ? caller.qualifiedName
                        : caller.name}
                    </span>
                    <span className="tag res-possible">{t.details.possibleTag}</span>
                  </button>
                  {ev && (
                    <a
                      className="evidence"
                      href={editorUrl(ev.file, ev.line, ev.column)}
                      title={t.common.openSnippet}
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
        </section>
      )}
      {!outgoing.length && !incoming.length && !possibleCalls.length && node.kind !== 'module' && (
        <p className="muted small details-section">{t.details.noRelations}</p>
      )}

      {children.length > 0 && (
        <section className="details-section">
          <h3 className="section-title">
            {node.kind === 'module'
              ? t.details.content
              : node.kind === 'class'
                ? t.details.members
                : t.details.definedHere}{' '}
            <span className="count">{children.length}</span>
          </h3>
          <ul className="rel-list">
            {children.slice(0, MAX_ITEMS).map((c) => (
              <li key={c.id}>
                <button type="button" className="rel-item" onClick={() => p.onNavigate(c.id)}>
                  <KindDot kind={c.kind} />
                  <span className="rel-name">{c.name}</span>
                  {c.location && <span className="rel-loc">:{c.location.startLine}</span>}
                  {c.meta?.exported && <span className="tag">{t.common.exported}</span>}
                </button>
              </li>
            ))}
          </ul>
          {children.length > MAX_ITEMS && (
            <p className="muted small">{t.common.andMore(children.length - MAX_ITEMS)}</p>
          )}
        </section>
      )}

      {node.kind !== 'package' && node.kind !== 'module' && (
        <section className="details-section">
          <h3 className="section-title">{t.details.impact}</h3>
          {!showImpact ? (
            <button type="button" className="button ghost" onClick={() => setShowImpact(true)}>
              {t.details.computeImpact}
            </button>
          ) : impact.length === 0 ? (
            <p className="muted small">{t.details.noImpact}</p>
          ) : (
            <>
              <p className="muted small">{t.details.impactCount(impact.length)}</p>
              <ul className="rel-list">
                {impact.slice(0, MAX_ITEMS).map((i) => (
                  <li key={i.node.id}>
                    <button
                      type="button"
                      className="rel-item"
                      onClick={() => p.onNavigate(i.node.id)}
                    >
                      <span className="depth-pill" title={t.common.distance}>
                        {i.depth}
                      </span>
                      <KindDot kind={i.node.kind} />
                      <span className="rel-name">
                        {i.node.qualifiedName && i.node.kind !== 'file'
                          ? i.node.qualifiedName
                          : i.node.name}
                      </span>
                      <span className="rel-loc">{labels.edge[i.via.kind].toLowerCase()}</span>
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
          <h3 className="section-title">{t.details.code}</h3>
          <SourceView
            file={loc.file}
            startLine={node.kind === 'file' ? 1 : loc.startLine}
            endLine={node.kind === 'file' ? Math.min(loc.endLine, 40) : loc.endLine}
            available={p.sourceAvailable}
            highlightRange={node.kind !== 'file'}
          />
        </section>
      )}
      {file && file.id !== node.id && (
        <p className="muted small details-section">
          {t.details.file}{' '}
          <button type="button" className="link-button" onClick={() => p.onNavigate(file.id)}>
            {file.qualifiedName}
          </button>
        </p>
      )}
    </div>
  );
}

function Chips({ node, t }: { node: GraphNode; t: Messages }) {
  const c = t.details.chips;
  const m = node.meta ?? {};
  const chips: string[] = [];
  if (m.exported) chips.push(m.defaultExport ? c.defaultExport : c.exported);
  if (m.async) chips.push('async');
  if (m.static) chips.push('static');
  if (m.memberKind && m.memberKind !== 'method')
    chips.push(
      {
        constructor: c.constructor,
        getter: c.getter,
        setter: c.setter,
        property: c.property,
        method: '',
      }[m.memberKind],
    );
  if (m.language) chips.push(m.language.toUpperCase());
  if (m.lines) chips.push(c.lines(m.lines));
  if (m.analyzed === false) chips.push(c.notAnalyzed);
  if (m.builtin) chips.push(c.builtin);
  else if (node.kind === 'package') chips.push(m.declared ? c.declared : c.undeclared);
  if (m.outsideRoot) chips.push(c.outsideRoot);
  if (m.framework) chips.push(m.framework);
  if (m.implements?.length) chips.push(c.implements(m.implements.join(', ')));
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
  const { t, labels } = useI18n();
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
                title={`${labels.node[other.kind]} · ${labels.resolution[e.resolution]} · ${t.discovery[e.discovery]}`}
              >
                <KindDot kind={other.kind} />
                <span className="rel-name">
                  {other.qualifiedName && other.kind !== 'file' && other.kind !== 'module'
                    ? other.qualifiedName
                    : other.name}
                </span>
                {e.resolution !== 'resolved' && (
                  <span className={`tag res-${e.resolution}`}>
                    {e.resolution === 'external' ? t.details.external : t.details.unresolved}
                  </span>
                )}
                {e.meta?.typeOnly && <span className="tag">{t.details.typeTag}</span>}
                {e.meta?.callKind === 'new' && <span className="tag">new</span>}
                {e.meta?.callKind === 'jsx' && <span className="tag">JSX</span>}
                {e.meta?.callKind === 'route-handler' && <span className="tag">handler</span>}
                {e.meta?.reexport && <span className="tag">{t.details.reexports}</span>}
                {count > 1 && <span className="rel-count">{count}×</span>}
              </button>
              {ev && (
                <a
                  className="evidence"
                  href={editorUrl(ev.file, ev.line, ev.column)}
                  title={t.common.openSnippet}
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
          {t.common.showAll(sorted.length)}
        </button>
      )}
    </>
  );
}

/** pasta › arquivo › classe: onde a entidade fica; cada parte leva até ela. */
function Breadcrumb({
  index,
  node,
  label,
  onNavigate,
}: {
  index: GraphIndex;
  node: GraphNode;
  label: string;
  onNavigate(id: string): void;
}) {
  const chain = index.ancestors(node.id).reverse();
  if (!chain.length) return null;
  return (
    <nav className="breadcrumb" aria-label={label}>
      <ol>
        {chain.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              className="crumb"
              onClick={() => onNavigate(a.id)}
              title={a.qualifiedName ?? a.name}
            >
              <KindDot kind={a.kind} />
              {/* a pasta raiz aparece com o nome do projeto */}
              {a.kind === 'module' && !a.parent ? index.graph.project.name : a.name}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
