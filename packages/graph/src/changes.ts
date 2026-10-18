import {
  compareStrings,
  nodeId,
  type ChangedFile,
  type ChangeSet,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
} from '@rastro/core';
import type { GraphIndex, ImpactEntry } from './query.js';

/**
 * Uma referência que aponta para algo alterado ou removido pela mudança e que não resolve no
 * código atual: import de um arquivo removido ou renomeado, nome que o arquivo alterado não
 * exporta mais, chamada a esse nome ou a um membro que o tipo (declarado num arquivo alterado)
 * não tem. Provavelmente quebrada pela mudança (ou já estava): nunca vira relação.
 */
export interface BrokenReference {
  /** Quem faz a referência: o arquivo que importa ou a entidade que chama. */
  from: GraphNode;
  kind: 'import' | 'call';
  /** O texto da referência: o especificador (`./term.js`), o nome (`sum`) ou `obj.metodo`. */
  reference: string;
  /** Arquivo alterado ou removido para onde ela aponta (relativo à raiz). */
  target: string;
  /**
   * `file-deleted`/`file-renamed`: o arquivo importado não existe mais nesse caminho;
   * `not-exported`: o arquivo alterado não exporta o nome; `member-missing`: o tipo declarado
   * no arquivo alterado não tem o membro chamado; `name-missing`: o arquivo alterado (TypeScript)
   * chama um nome que não está declarado nem importado nele.
   */
  why: 'file-deleted' | 'file-renamed' | 'not-exported' | 'member-missing' | 'name-missing';
  /** Onde aparece (a primeira ocorrência) e quantas vezes. */
  evidence?: Evidence;
  count: number;
}

export interface ChangeImpact {
  /** Arquivos alterados que existem no grafo. */
  changedFiles: GraphNode[];
  /** Arquivos alterados fora do grafo (removidos, não analisados, ignorados). */
  outsideGraph: ChangedFile[];
  /** Entidades cujo código foi alterado (a mais específica: o método, não a classe inteira). */
  changedEntities: GraphNode[];
  /** Quem depende do que mudou (chamadas, imports e herança resolvidos), por distância. */
  impacted: ImpactEntry[];
  /** Rotas HTTP alteradas ou afetadas. */
  routes: GraphNode[];
  /** Arquivos de teste alterados ou afetados (pistas de quais testes rodar). */
  tests: GraphNode[];
  /** Referências para o que mudou que não resolvem mais (possivelmente quebradas). */
  broken: BrokenReference[];
}

const SYMBOLS = new Set<NodeKind>(['function', 'class', 'method', 'route']);
const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$/i;

export const isTestFile = (path: string) => TEST_FILE.test(path);

type Lines = [number, number];

// `deletionsAt` é a linha logo depois do trecho removido: removido logo acima da entidade
// aponta para a primeira linha dela, mas não a altera (o código no topo do arquivo é que mudou).
// O trecho removido ficava entre as linhas `line - 1` e `line`: dentro da entidade só se as
// duas são dela.
const removedInside = (node: GraphNode, line: number) =>
  !!node.location && line > node.location.startLine && line <= node.location.endLine;

function touches(node: GraphNode, file: ChangedFile): boolean {
  const loc = node.location;
  if (!loc) return false;
  return (
    file.ranges.some(([a, b]) => a <= loc.endLine && b >= loc.startLine) ||
    (file.deletionsAt ?? []).some((line) => removedInside(node, line))
  );
}

/** Junta intervalos de linhas que se sobrepõem ou se encostam (`[1,5]` e `[6,9]` → `[1,9]`). */
function mergeLines(list: Lines[]): Lines[] {
  const merged: Lines[] = [];
  for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** Todas as linhas de `[a, b]` estão em algum dos intervalos (já juntados por `mergeLines`)? */
const covered = (merged: Lines[], a: number, b: number) =>
  merged.some(([start, end]) => a >= start && b <= end);

const linesOf = (nodes: GraphNode[]): Lines[] =>
  mergeLines(
    nodes.flatMap((n) => (n.location ? [[n.location.startLine, n.location.endLine]] : [])),
  );

/**
 * A entidade mudou por si, além do que mudou nas entidades de dentro dela? Um método
 * alterado não muda a classe; um campo ou o construtor alterado junto, sim.
 */
function changedOutside(node: GraphNode, inner: GraphNode[], file: ChangedFile): boolean {
  const loc = node.location!;
  const innerLines = linesOf(inner);
  return (
    file.ranges.some(([a, b]) => {
      const from = Math.max(a, loc.startLine);
      const to = Math.min(b, loc.endLine);
      return from <= to && !covered(innerLines, from, to);
    }) ||
    (file.deletionsAt ?? []).some(
      (line) => removedInside(node, line) && !inner.some((d) => removedInside(d, line)),
    )
  );
}

/** O que mudou e quem pode ser afetado, a partir das mudanças do git anexadas ao grafo. */
export function computeChangeImpact(index: GraphIndex, changes: ChangeSet): ChangeImpact {
  const changedFiles: GraphNode[] = [];
  const outsideGraph: ChangedFile[] = [];
  const changed = new Set<string>();

  for (const file of changes.files) {
    const fileNode = index.node(nodeId.file(file.file));
    if (!fileNode || file.status === 'deleted' || fileNode.meta?.analyzed === false) {
      outsideGraph.push(file);
      continue;
    }
    changedFiles.push(fileNode);
    const symbols = index.descendants(fileNode.id).filter((n) => SYMBOLS.has(n.kind));
    const hit = new Set(symbols.filter((n) => touches(n, file)));
    // fica a entidade mais específica: se só um método mudou, a classe não entra por isso
    // (mas entra se também mudou fora dos métodos alterados, ex.: um campo)
    for (const node of hit) {
      const inner = index.descendants(node.id).filter((d) => hit.has(d));
      if (!inner.length || changedOutside(node, inner, file)) changed.add(node.id);
    }
    // código no topo do arquivo (fora de qualquer entidade) também muda o arquivo: linhas
    // alteradas ou trechos removidos (ex.: um `export const` apagado) fora das entidades.
    // Linha a linha: um trecho que pega o fim de uma função e o começo da seguinte continua
    // dentro de entidades
    const symbolLines = linesOf(symbols);
    const outsideSymbols =
      file.ranges.some(([a, b]) => !covered(symbolLines, a, b)) ||
      (file.deletionsAt ?? []).some((line) => !symbols.some((n) => removedInside(n, line)));
    if (outsideSymbols || file.status === 'added') changed.add(fileNode.id);
  }

  // uma busca só a partir de tudo o que mudou (o mesmo que juntar o impacto de cada um)
  const impactedList = index.impactOfAll(changed);

  const changedEntities = [...changed]
    .map((id) => index.node(id)!)
    .filter((n) => n && n.kind !== 'file')
    .sort((a, b) => compareStrings(a.id, b.id));

  const { routes, tests } = routesAndTests(index, [
    ...changedEntities,
    ...changedFiles,
    ...impactedList.map((i) => i.node),
  ]);

  changedFiles.sort((a, b) => compareStrings(a.id, b.id));
  return {
    changedFiles,
    outsideGraph,
    changedEntities,
    impacted: impactedList,
    routes,
    tests,
    broken: brokenReferences(index, changes),
  };
}

const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
/** Extensão escrita no import (ESM) → extensões do código-fonte que o TypeScript aceita no lugar. */
const SOURCE_FOR: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
};

/** Normaliza `a/b/../c/./d` (caminho relativo à raiz, com `/`); `undefined` se sair da raiz. */
function joinPath(dir: string, specifier: string): string | undefined {
  const parts: string[] = [];
  for (const part of `${dir}/${specifier}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

/** Caminhos de arquivo que um especificador relativo pode ser (regras de resolução do TypeScript). */
export function specifierCandidates(importer: string, specifier: string): string[] {
  if (!specifier.startsWith('.')) return [];
  const slash = importer.lastIndexOf('/');
  const base = joinPath(slash >= 0 ? importer.slice(0, slash) : '', specifier);
  if (base === undefined) return [];
  const ext = /\.[cm]?jsx?$/.exec(base)?.[0];
  const stem = ext ? base.slice(0, -ext.length) : base;
  return [
    base,
    ...(ext ? (SOURCE_FOR[ext] ?? []).map((e) => stem + e) : []),
    ...EXTENSIONS.map((e) => base + e),
    ...EXTENSIONS.map((e) => `${base}/index${e}`),
  ];
}

/** A evidência mais específica: a primeira ocorrência cujo trecho cita o nome. */
function evidenceFor(edge: GraphEdge, name?: string): Evidence | undefined {
  const escaped = name?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = escaped && new RegExp(`(^|[^\\w$])${escaped}([^\\w$]|$)`);
  return (word && edge.evidence.find((ev) => word.test(ev.snippet ?? ''))) || edge.evidence[0];
}

/**
 * Referências quebradas pela mudança (ver `BrokenReference`). Só o que se liga à mudança por
 * prova: o especificador relativo resolve para o caminho removido; o nome importado de um
 * arquivo alterado não está entre os exportados dele (pelo verificador de tipos); a chamada sem
 * declaração usa um desses nomes no arquivo que o importa; o tipo do receptor está num arquivo
 * alterado e não tem o membro.
 */
export function brokenReferences(index: GraphIndex, changes: ChangeSet): BrokenReference[] {
  const gone = new Map<string, BrokenReference['why']>();
  const changed = new Set<string>();
  for (const f of changes.files) {
    if (f.status === 'deleted') gone.set(f.file, 'file-deleted');
    else {
      if (f.status === 'renamed' && f.previous && f.previous !== f.file)
        gone.set(f.previous, 'file-renamed');
      changed.add(f.file);
    }
  }
  // um caminho removido que voltou a existir (outro arquivo no lugar) não está quebrado
  for (const file of gone.keys()) if (index.node(nodeId.file(file))) gone.delete(file);
  if (!gone.size && !changed.size) return [];

  const found: BrokenReference[] = [];
  /** Arquivo que importa → nome → arquivo alterado/removido de onde o nome vinha. */
  const missingNames = new Map<
    string,
    Map<string, { target: string; why: BrokenReference['why'] }>
  >();
  const addName = (importer: string, name: string, target: string, why: BrokenReference['why']) => {
    if (name === '*' || name === 'default') return;
    if (!missingNames.has(importer)) missingNames.set(importer, new Map());
    missingNames.get(importer)!.set(name, { target, why });
  };

  // imports de arquivos removidos ou renomeados (o especificador não resolve mais)
  if (gone.size)
    for (const node of index.nodes.values()) {
      if (node.kind !== 'unresolved' || node.meta?.reason !== 'module-not-found') continue;
      for (const edge of index.incoming(node.id, ['imports'])) {
        const importer = index.node(edge.source);
        const specifier = edge.meta?.specifier ?? node.meta?.reference ?? node.name;
        if (!importer || importer.kind !== 'file') continue;
        const importerPath = importer.qualifiedName ?? importer.name;
        const target = specifierCandidates(importerPath, specifier).find((c) => gone.has(c));
        if (!target) continue;
        const why = gone.get(target)!;
        found.push({
          from: importer,
          kind: 'import',
          reference: specifier,
          target,
          why,
          ...(edge.evidence[0] ? { evidence: edge.evidence[0] } : {}),
          count: Math.max(edge.meta?.count ?? 0, edge.evidence.length, 1),
        });
        for (const name of edge.meta?.names ?? []) addName(importer.id, name, target, why);
      }
    }

  // nomes que os arquivos alterados não exportam mais
  for (const file of changed) {
    const fileNode = index.node(nodeId.file(file));
    if (!fileNode || fileNode.meta?.analyzed === false || !CODE_EXT.test(file)) continue;
    const exported = new Set(fileNode.meta?.exportNames ?? []);
    // CommonJS (`module.exports = ...`): os nomes dependem do valor, não dá para provar a falta
    if (exported.has('module.exports')) continue;
    for (const edge of index.incoming(fileNode.id, ['imports'])) {
      const kind = edge.meta?.importKind;
      if (edge.resolution !== 'resolved' || edge.meta?.viaDeclaration) continue;
      if (kind !== 'static' && kind !== 're-export') continue;
      const importer = index.node(edge.source);
      if (!importer) continue;
      for (const name of edge.meta?.names ?? []) {
        if (name === '*' || exported.has(name)) continue;
        const evidence = evidenceFor(edge, name);
        found.push({
          from: importer,
          kind: 'import',
          reference: name,
          target: file,
          why: 'not-exported',
          ...(evidence ? { evidence } : {}),
          count: 1,
        });
        addName(importer.id, name, file, 'not-exported');
      }
    }
  }

  // nomes soltos sem declaração em arquivos não alterados (ex.: globais de testes sem os tipos
  // instalados): faltavam antes da mudança, então não contam como quebrados por ela. Os que
  // vêm de um import quebrado pela mudança (acima) não contam como "faltavam antes".
  const missingElsewhere = new Set<string>();
  const loose = (node: GraphNode) => {
    const reference = node.meta?.reference ?? node.name;
    // só `nome()` sem nada com esse nome no escopo (o analisador confere): um nome importado
    // de um pacote não instalado também não resolve, mas continua declarado
    return node.kind === 'unresolved' &&
      node.meta?.reason === 'symbol-not-found' &&
      node.meta.undeclared === true &&
      /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(reference)
      ? reference
      : undefined;
  };
  for (const node of index.nodes.values()) {
    const name = loose(node);
    const file = name ? index.fileOf(node.id) : undefined;
    if (
      name &&
      file &&
      !changed.has(file.qualifiedName ?? file.name) &&
      !missingNames.get(file.id)?.has(name)
    )
      missingElsewhere.add(name);
  }

  // chamadas sem declaração: a um nome importado que sumiu, a um membro que o tipo não tem ou,
  // dentro de um arquivo alterado, a um nome que não existe mais nele (função renomeada)
  for (const node of index.nodes.values()) {
    if (node.kind !== 'unresolved' || node.meta?.reason !== 'symbol-not-found') continue;
    const reference = node.meta.reference ?? node.name;
    let target: string | undefined;
    let why: BrokenReference['why'] | undefined;
    const receiverFile = node.meta.receiverFile;
    if (receiverFile && changed.has(receiverFile)) {
      target = receiverFile;
      why = 'member-missing';
    } else {
      const fileId = node.parent ?? index.fileOf(node.id)?.id;
      const names = fileId ? missingNames.get(fileId) : undefined;
      const hit = names?.get(reference.split('.')[0]!);
      if (hit) ({ target, why } = hit);
      else {
        const file = index.fileOf(node.id);
        const path = file && (file.qualifiedName ?? file.name);
        const name = loose(node);
        if (
          path &&
          name &&
          changed.has(path) &&
          /\.[cm]?tsx?$/.test(path) &&
          !missingElsewhere.has(name)
        ) {
          target = path;
          why = 'name-missing';
        }
      }
    }
    if (!target || !why) continue;
    for (const edge of index.incoming(node.id, ['calls'])) {
      const from = index.node(edge.source);
      if (!from) continue;
      found.push({
        from,
        kind: 'call',
        reference,
        target,
        why,
        ...(edge.evidence[0] ? { evidence: edge.evidence[0] } : {}),
        count: Math.max(edge.meta?.count ?? 0, edge.evidence.length, 1),
      });
    }
  }

  // imports primeiro (um por arquivo, o mais direto de corrigir), depois as chamadas
  return found.sort(
    (a, b) =>
      Number(a.kind === 'call') - Number(b.kind === 'call') ||
      compareStrings(a.evidence?.file ?? a.from.id, b.evidence?.file ?? b.from.id) ||
      (a.evidence?.line ?? 0) - (b.evidence?.line ?? 0) ||
      compareStrings(a.reference, b.reference) ||
      compareStrings(a.from.id, b.from.id),
  );
}

/**
 * Rotas HTTP e arquivos de teste entre as entidades envolvidas (o que mudou e quem depende
 * disso): as rotas para revisar e os testes para rodar, sem repetição e em ordem estável.
 */
export function routesAndTests(
  index: GraphIndex,
  involved: readonly GraphNode[],
): { routes: GraphNode[]; tests: GraphNode[] } {
  return {
    routes: uniqueSorted(involved.filter((n) => n.kind === 'route')),
    tests: uniqueSorted(
      involved
        .map((n) => (n.kind === 'file' ? n : index.fileOf(n.id)))
        .filter((f): f is GraphNode => !!f && isTestFile(f.qualifiedName ?? f.name)),
    ),
  };
}

function uniqueSorted(nodes: GraphNode[]): GraphNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return [...byId.values()].sort((a, b) => compareStrings(a.id, b.id));
}
