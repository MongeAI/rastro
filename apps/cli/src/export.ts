import fs from 'node:fs';
import path from 'node:path';
import { EDGE_KINDS, type EdgeKind, type RastroGraph } from '@rastro/core';
import {
  EXPORT_LEVELS,
  ExportTooLargeError,
  filterGraphByFolder,
  normalizeFolder,
  toDot,
  toGraphML,
  toMermaid,
  type ExportLevel,
  type ExportOptions,
} from '@rastro/graph';
import { getLang, t } from './i18n.js';
import { buildHtmlReport } from './report.js';
import { tildify } from './term.js';

export const EXPORT_FORMATS = ['mermaid', 'dot', 'graphml', 'json', 'html'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Formatos de diagrama, que aceitam nível, tipos de relação e externos/não resolvidos. */
const DIAGRAM_FORMATS = new Set<ExportFormat>(['mermaid', 'dot', 'graphml']);

export interface ExportRequest {
  format: string | undefined;
  level?: string;
  folder?: string;
  edges?: string;
  external?: boolean;
  noUnresolved?: boolean;
}

/** Erro de uso da linha de comando (mensagem pronta para o usuário). */
export class UsageError extends Error {}

/** Confere as opções de `rastro export` antes de qualquer análise demorada. */
export function parseExportRequest(req: ExportRequest): {
  format: ExportFormat;
  options: ExportOptions;
} {
  const m = t().export;
  if (!req.format) throw new UsageError(m.needFormat(EXPORT_FORMATS.join(', ')));
  const format = req.format.toLowerCase() as ExportFormat;
  if (!EXPORT_FORMATS.includes(format))
    throw new UsageError(m.unknownFormat(req.format, EXPORT_FORMATS.join(', ')));
  if (!DIAGRAM_FORMATS.has(format)) {
    const flag =
      req.level !== undefined
        ? '--level'
        : req.edges !== undefined
          ? '--edges'
          : req.external
            ? '--external'
            : req.noUnresolved
              ? '--no-unresolved'
              : undefined;
    if (flag) throw new UsageError(m.flagNotForFormat(flag, format));
  }
  if (req.level !== undefined && !EXPORT_LEVELS.includes(req.level as ExportLevel))
    throw new UsageError(m.unknownLevel(req.level, EXPORT_LEVELS.join(', ')));
  let edgeKinds: EdgeKind[] | undefined;
  if (req.edges !== undefined) {
    const allowed: EdgeKind[] = EDGE_KINDS.filter((k) => k !== 'contains');
    edgeKinds = req.edges
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as EdgeKind[];
    const unknown = edgeKinds.filter((k) => !allowed.includes(k));
    if (unknown.length || !edgeKinds.length) throw new UsageError(m.badEdges(allowed.join(', ')));
  }
  const folder = normalizeFolder(req.folder);
  return {
    format,
    options: {
      ...(req.level ? { level: req.level as ExportLevel } : {}),
      ...(edgeKinds ? { edgeKinds } : {}),
      ...(folder ? { folder } : {}),
      includeExternal: !!req.external,
      includeUnresolved: !req.noUnresolved,
    },
  };
}

/**
 * Gera o conteúdo exportado. `webRoot` é a interface compilada (só para `html`). Os
 * comentários e rótulos dos diagramas saem no idioma da CLI, a menos que `options.lang` diga outro.
 */
export function renderExport(
  graph: RastroGraph,
  format: ExportFormat,
  exportOptions: ExportOptions,
  webRoot: string,
): string {
  const options: ExportOptions = { lang: getLang(), ...exportOptions };
  if (options.folder) {
    const scoped = filterGraphByFolder(graph, options.folder);
    if (!scoped.nodes.some((n) => n.kind === 'file'))
      throw new UsageError(t().export.emptyFolder(options.folder));
  }
  try {
    switch (format) {
      case 'mermaid':
        return toMermaid(graph, options);
      case 'dot':
        return toDot(graph, options);
      case 'graphml':
        return toGraphML(graph, options);
      case 'json':
        return `${JSON.stringify(filterGraphByFolder(graph, options.folder), null, 2)}\n`;
      case 'html': {
        // o relatório é feito para circular: a pasta pessoal vira ~ (sem o nome do usuário)
        const scoped = filterGraphByFolder(graph, options.folder);
        const project = { ...scoped.project, root: tildify(scoped.project.root) };
        return buildHtmlReport({ ...scoped, project }, webRoot);
      }
    }
  } catch (err) {
    if (err instanceof ExportTooLargeError) throw new UsageError(`${err.message}\n${err.hint}`);
    throw err;
  }
}

/** Nome padrão do relatório HTML: `<projeto>.rastro.html` na pasta atual. */
export function defaultReportPath(graph: RastroGraph): string {
  const slug =
    graph.project.name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'projeto';
  return path.resolve(`${slug}.rastro.html`);
}

/** Grava o arquivo exportado (criando a pasta, se preciso). */
export function writeExport(file: string, content: string): string {
  const target = path.resolve(file);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const why =
      code === 'EISDIR'
        ? t().export.isDir
        : code === 'EACCES' || code === 'EPERM'
          ? t().storage.noPermission
          : (err as Error).message;
    throw new Error(t().export.writeFailed(target, why), { cause: err });
  }
  return target;
}
