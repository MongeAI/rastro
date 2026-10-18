import { useEffect, useRef, useState } from 'react';
import { highlightLines } from '../lib/highlight';
import { useI18n } from '../lib/i18n';

interface Props {
  file: string;
  startLine: number;
  endLine: number;
  /** A interface foi aberta pela CLI (há servidor para ler o código). */
  available: boolean;
  /** Destaca as linhas do intervalo (desligado para arquivos inteiros). */
  highlightRange?: boolean;
}

type State =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; lines: string[] };

const cache = new Map<string, Promise<string[]>>();

function fetchSource(file: string): Promise<string[]> {
  let p = cache.get(file);
  if (!p) {
    p = fetch(`/api/source?file=${encodeURIComponent(file)}`).then(async (res) => {
      const body = (await res.json().catch(() => ({}))) as { content?: string; error?: string };
      if (!res.ok || typeof body.content !== 'string')
        throw new Error(body.error ?? `Erro ${res.status}`);
      return body.content.split(/\r?\n/);
    });
    p.catch(() => cache.delete(file));
    cache.set(file, p);
  }
  return p;
}

const CONTEXT = 3;
const MAX_LINES = 80;

export function SourceView({ file, startLine, endLine, available, highlightRange = true }: Props) {
  const { t } = useI18n();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [showAll, setShowAll] = useState(false);
  const firstHighlight = useRef<HTMLDivElement>(null);

  // ao abrir o arquivo inteiro, mantém o trecho selecionado à vista
  useEffect(() => {
    if (showAll) firstHighlight.current?.scrollIntoView({ block: 'center' });
  }, [showAll]);

  useEffect(() => {
    setShowAll(false);
    if (!available) return;
    let alive = true;
    setState({ status: 'loading' });
    fetchSource(file).then(
      (lines) => alive && setState({ status: 'ok', lines }),
      (err: Error) => alive && setState({ status: 'error', message: err.message }),
    );
    return () => {
      alive = false;
    };
  }, [file, available]);

  if (!available) {
    return <p className="muted small">{t.source.unavailable}</p>;
  }
  if (state.status === 'loading') return <div className="source skeleton" aria-busy="true" />;
  if (state.status === 'error')
    return <p className="muted small">{t.source.failed(state.message)}</p>;

  const total = state.lines.length;
  const from = showAll ? 1 : Math.max(1, startLine - CONTEXT);
  const to = showAll ? total : Math.min(total, endLine + CONTEXT, from + MAX_LINES - 1);
  const truncated = !showAll && (from > 1 || to < total);
  const tokens = highlightLines(state.lines.slice(0, to));
  const width = String(to).length;

  return (
    <div className="source-wrap">
      <pre className="source" tabIndex={0} aria-label={t.source.aria(file, from, to)}>
        {state.lines.slice(from - 1, to).map((line, i) => {
          const n = from + i;
          const inRange = highlightRange && n >= startLine && n <= endLine;
          return (
            <div
              key={n}
              className={`src-line${inRange ? ' hl' : ''}`}
              ref={n === startLine && inRange ? firstHighlight : undefined}
            >
              <span className="src-num">{String(n).padStart(width, ' ')}</span>
              <code>
                {(tokens[n - 1] ?? []).map((t, j) => (
                  <span key={j} className={t.cls ? `t-${t.cls}` : undefined}>
                    {t.text}
                  </span>
                ))}
                {line.length === 0 ? ' ' : ''}
              </code>
            </div>
          );
        })}
      </pre>
      {truncated && (
        <button type="button" className="link-button" onClick={() => setShowAll(true)}>
          {t.source.showWhole(total)}
        </button>
      )}
    </div>
  );
}
