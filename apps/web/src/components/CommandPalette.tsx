import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GraphNode } from '@rastro/core';
import type { GraphIndex } from '@rastro/graph';
import { fuzzyScore } from '../lib/fuzzy';
import { useI18n } from '../lib/i18n';
import { IconSearch } from './Icons';
import { KindDot } from './KindBadge';

/** Uma ação da paleta (trocar nível, tema, exportar...). */
export interface PaletteAction {
  id: string;
  label: string;
  /** Grupo exibido à direita (ex.: "Mapa", "Seleção"). */
  group: string;
  /** Atalho de teclado, quando houver. */
  shortcut?: string;
  /** Palavras extras para a busca (sinônimos, termos em inglês...). */
  keywords?: string;
  icon?: ReactNode;
  run(): void;
}

interface Props {
  index: GraphIndex;
  actions: PaletteAction[];
  /** Entidades visitadas por último (mostradas com a busca vazia). */
  recent: string[];
  onPickNode(id: string): void;
  onClose(): void;
}

type Item = { type: 'action'; action: PaletteAction } | { type: 'node'; node: GraphNode };

const optionId = (i: number) => `palette-option-${i}`;
const MAX_ACTIONS = 8;

/** Paleta de comandos (Ctrl/Cmd+K): busca entidades e ações em um só lugar. */
export function CommandPalette({ index, actions, recent, onPickNode, onClose }: Props) {
  const { t, labels } = useI18n();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<Element | null>(null);

  useEffect(() => {
    previousFocus.current = document.activeElement;
    inputRef.current?.focus();
    return () => {
      // devolve o foco para onde estava (acessibilidade)
      if (previousFocus.current instanceof HTMLElement) previousFocus.current.focus();
    };
  }, []);

  // ">" no começo busca só ações (como em editores de código)
  const onlyActions = query.startsWith('>');
  const text = onlyActions ? query.slice(1) : query;

  const items = useMemo<Item[]>(() => {
    const scored = actions
      .map((action) => ({
        action,
        score: Math.max(
          fuzzyScore(action.label, text),
          fuzzyScore(`${action.group} ${action.keywords ?? ''}`, text) * 0.6,
        ),
      }))
      .filter((a) => a.score > 0);
    if (text.trim()) scored.sort((a, b) => b.score - a.score);
    const actionItems: Item[] = scored
      .slice(0, text.trim() && !onlyActions ? MAX_ACTIONS : undefined)
      .map(({ action }) => ({ type: 'action', action }));
    if (onlyActions) return actionItems;
    if (!text.trim()) {
      const recentNodes: Item[] = recent
        .map((id) => index.node(id))
        .filter((n): n is GraphNode => !!n)
        .map((node) => ({ type: 'node', node }));
      return [...recentNodes, ...actionItems];
    }
    const nodes: Item[] = index.search(text, 40).map((r) => ({ type: 'node', node: r.node }));
    // entidades primeiro, a não ser que uma ação combine muito bem com o texto
    const strong = actionItems.filter(
      (i) => i.type === 'action' && fuzzyScore(i.action.label, text) >= 80,
    );
    const weak = actionItems.filter((i) => !strong.includes(i));
    return [...strong, ...nodes, ...weak];
  }, [actions, text, onlyActions, recent, index]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`#${optionId(active)}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    if (item.type === 'action') item.action.run();
    else onPickNode(item.node.id);
  };

  let lastSection = '';
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t.palette.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-input">
          <IconSearch />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? optionId(active) : undefined}
            aria-label={t.palette.title}
            placeholder={t.palette.placeholder}
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => (items.length ? (a + 1) % items.length : 0));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => (items.length ? (a - 1 + items.length) % items.length : 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(items[active]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              } else if (e.key === 'Tab') {
                e.preventDefault();
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">{t.top.nothingFound(text)}</div>}
          {items.map((item, i) => {
            const section =
              item.type === 'action'
                ? t.palette.actions
                : text.trim()
                  ? t.palette.entities
                  : t.palette.recent;
            const header = section !== lastSection ? section : null;
            lastSection = section;
            const key = item.type === 'action' ? `a:${item.action.id}` : `n:${item.node.id}`;
            return (
              <div key={key} role="presentation">
                {header && <div className="palette-section">{header}</div>}
                <button
                  id={optionId(i)}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === active}
                  className={`palette-item${i === active ? ' active' : ''}`}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => choose(item)}
                >
                  {item.type === 'action' ? (
                    <>
                      <span className="palette-icon">{item.action.icon}</span>
                      <span className="palette-label">{item.action.label}</span>
                      <span className="palette-meta">{item.action.group}</span>
                      {item.action.shortcut && <kbd>{item.action.shortcut}</kbd>}
                    </>
                  ) : (
                    <>
                      <span className="palette-icon">
                        <KindDot kind={item.node.kind} />
                      </span>
                      <span className="palette-label">
                        {item.node.qualifiedName && item.node.kind !== 'file'
                          ? item.node.qualifiedName
                          : item.node.name}
                      </span>
                      <span className="palette-meta">
                        {labels.node[item.node.kind]}
                        {item.node.location?.file && item.node.kind !== 'file'
                          ? ` · ${item.node.location.file}`
                          : item.node.kind === 'file' && item.node.qualifiedName
                            ? ` · ${item.node.qualifiedName}`
                            : ''}
                      </span>
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t.palette.move}
          </span>
          <span>
            <kbd>Enter</kbd> {t.palette.open}
          </span>
          <span>
            <kbd>&gt;</kbd> {t.palette.onlyActions}
          </span>
        </div>
      </div>
    </div>
  );
}
