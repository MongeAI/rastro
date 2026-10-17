import { NODE_KIND_LABELS, type NodeKind } from '@rastro/core';

/** Ponto colorido + rótulo do tipo de nó. As cores vêm de variáveis CSS (--k-<tipo>). */
export function KindDot({ kind }: { kind: NodeKind }) {
  return <span className={`kind-dot k-${kind}`} aria-hidden="true" />;
}

export function KindBadge({ kind }: { kind: NodeKind }) {
  return (
    <span className={`kind-badge k-${kind}`}>
      <KindDot kind={kind} />
      {NODE_KIND_LABELS[kind]}
    </span>
  );
}
