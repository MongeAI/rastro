import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphIndex } from '@rastro/graph';
import { useI18n } from '../lib/i18n';
import { shortEntityName } from '../lib/names';
import { IconSearch } from './Icons';
import { KindDot } from './KindBadge';

interface Props {
  index: GraphIndex;
  onPick(id: string): void;
  /** Quando muda, a busca é limpa e recebe o foco (ex.: ao escolher o destino de um caminho). */
  focusSignal?: number;
}

const optionId = (i: number) => `search-option-${i}`;

export function Search({ index, onPick, focusSignal }: Props) {
  const { t, labels } = useI18n();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => index.search(query, 40), [index, query]);
  const showList = open && query.trim().length > 0;

  useEffect(() => {
    if (!focusSignal) return;
    setQuery('');
    inputRef.current?.focus();
  }, [focusSignal]);

  // atalho global: "/" foca a busca (Ctrl/Cmd+K abre a paleta de comandos)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      const typing =
        (t instanceof HTMLInputElement && !['checkbox', 'radio'].includes(t.type)) ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement;
      // com um diálogo aberto (atalhos, paleta), o foco fica nele
      const dialog = document.querySelector('[aria-modal="true"]');
      if (e.key === '/' && !typing && !dialog) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // fecha ao clicar fora (em vez de depender do blur, que tem corridas com o clique)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  // mantém a opção ativa visível ao navegar com as setas
  useEffect(() => {
    if (!showList) return;
    listRef.current?.querySelector(`#${optionId(active)}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, showList]);

  const pick = (id: string) => {
    onPick(id);
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div className="search" role="search" ref={rootRef}>
      <IconSearch className="search-icon" />
      <input
        ref={inputRef}
        type="search"
        placeholder={t.top.searchPlaceholder}
        aria-label={t.top.searchAria}
        aria-expanded={showList}
        aria-controls="search-results"
        aria-autocomplete="list"
        aria-activedescendant={showList && results[active] ? optionId(active) : undefined}
        role="combobox"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, Math.max(results.length - 1, 0)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && results[active]) {
            pick(results[active].node.id);
          } else if (e.key === 'Escape') {
            setOpen(false);
            inputRef.current?.blur();
          } else if (e.key === 'Tab') {
            setOpen(false);
          }
        }}
      />
      <kbd className="search-kbd" aria-hidden="true">
        /
      </kbd>
      {showList && (
        <div
          className="search-results"
          id="search-results"
          role="listbox"
          ref={listRef}
          onMouseDown={(e) => e.preventDefault()}
        >
          {results.length === 0 && <div className="search-empty">{t.top.nothingFound(query)}</div>}
          {results.map((r, i) => {
            const file =
              r.node.location?.file ?? (r.node.kind === 'file' ? r.node.qualifiedName : undefined);
            return (
              <button
                key={r.node.id}
                id={optionId(i)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                className={`search-item${i === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(r.node.id)}
              >
                <KindDot kind={r.node.kind} />
                <span className="search-name">
                  {shortEntityName(r.node, index.graph.project.name)}
                </span>
                <span className="search-meta">
                  {labels.node[r.node.kind]}
                  {file ? ` · ${file}` : ''}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
