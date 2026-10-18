import type { NodeKind } from '@rastro/core';
import { useI18n } from '../lib/i18n';

/** Ponto colorido + rótulo do tipo de nó. As cores vêm de variáveis CSS (--k-<tipo>). */
export function KindDot({ kind }: { kind: NodeKind }) {
  return <span className={`kind-dot k-${kind}`} aria-hidden="true" />;
}

export function KindBadge({ kind }: { kind: NodeKind }) {
  const { labels } = useI18n();
  return (
    <span className={`kind-badge k-${kind}`}>
      <KindDot kind={kind} />
      {labels.node[kind]}
    </span>
  );
}
