/**
 * Componentes fortemente conexos (Tarjan, versão iterativa para não estourar a pilha
 * em projetos grandes). Cada componente com mais de um nó é um ciclo de dependência.
 */
export function stronglyConnectedComponents(adjacency: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  let counter = 0;

  const vertices = new Set<string>(adjacency.keys());
  for (const targets of adjacency.values()) for (const t of targets) vertices.add(t);

  for (const start of vertices) {
    if (index.has(start)) continue;
    const work: Array<{ v: string; i: number }> = [{ v: start, i: 0 }];
    index.set(start, counter);
    lowlink.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);

    while (work.length) {
      const frame = work[work.length - 1]!;
      const targets = adjacency.get(frame.v) ?? [];
      if (frame.i < targets.length) {
        const w = targets[frame.i++]!;
        if (!index.has(w)) {
          index.set(w, counter);
          lowlink.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          lowlink.set(frame.v, Math.min(lowlink.get(frame.v)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) lowlink.set(parent.v, Math.min(lowlink.get(parent.v)!, lowlink.get(frame.v)!));
      if (lowlink.get(frame.v) === index.get(frame.v)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== frame.v);
        result.push(component);
      }
    }
  }
  return result;
}
