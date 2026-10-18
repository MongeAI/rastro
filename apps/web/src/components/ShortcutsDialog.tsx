import { useEffect, useRef } from 'react';
import { useI18n } from '../lib/i18n';
import { IconClose } from './Icons';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Lista dos atalhos de teclado (tecla "?"). */
export function ShortcutsDialog({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette shortcuts"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === '?') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="shortcuts-head">
          <h2 id="shortcuts-title">{t.shortcuts.title}</h2>
          <button
            ref={closeRef}
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={t.shortcuts.close}
            title={t.shortcuts.close}
          >
            <IconClose />
          </button>
        </header>
        <dl className="shortcuts-list">
          {t.shortcuts.items.map(([keys, what]) => (
            <div key={keys} className="shortcut-row">
              <dt>
                {keys.split(' ').map((k) => (
                  <kbd key={k}>{k === 'Ctrl' && isMac ? '⌘' : k}</kbd>
                ))}
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
        <p className="muted small shortcuts-foot">{t.shortcuts.mouse}</p>
      </div>
    </div>
  );
}
