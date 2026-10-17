import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphIndex } from '@teia/graph';
import { NODE_KIND_LABELS } from '@teia/core';
import { IconSearch } from './Icons';
import { KindDot } from './KindBadge';

interface Props {
  index: GraphIndex;
  onPick(id: string): void;
}

export function Search({ index, onPick }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => index.search(query, 40), [index, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (id: string) => {
    onPick(id);
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div className="search" role="search">
      <IconSearch className="search-icon" />
      <input
        ref={inputRef}
        type="search"
        placeholder="Buscar arquivo, função, classe…"
        aria-label="Buscar no grafo"
        aria-expanded={open && results.length > 0}
        aria-controls="search-results"
        aria-autocomplete="list"
        role="combobox"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && results[active]) {
            pick(results[active].node.id);
          } else if (e.key === 'Escape') {
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
      />
      <kbd className="search-kbd" aria-hidden="true">
        /
      </kbd>
      {open && query.trim() && (
        <div className="search-results" id="search-results" role="listbox">
          {results.length === 0 && (
            <div className="search-empty">Nada encontrado para “{query}”.</div>
          )}
          {results.map((r, i) => {
            const file =
              r.node.location?.file ?? (r.node.kind === 'file' ? r.node.qualifiedName : undefined);
            return (
              <button
                key={r.node.id}
                type="button"
                role="option"
                aria-selected={i === active}
                className={`search-item${i === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(r.node.id)}
              >
                <KindDot kind={r.node.kind} />
                <span className="search-name">
                  {r.node.qualifiedName && r.node.kind !== 'file'
                    ? r.node.qualifiedName
                    : r.node.name}
                </span>
                <span className="search-meta">
                  {NODE_KIND_LABELS[r.node.kind]}
                  {file && r.node.kind !== 'file'
                    ? ` · ${file}`
                    : r.node.kind === 'file'
                      ? ` · ${file}`
                      : ''}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
