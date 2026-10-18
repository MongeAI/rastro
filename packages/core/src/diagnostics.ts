import type { Lang } from './labels.js';
import type { Diagnostic } from './model.js';

/**
 * Textos dos diagnósticos em português e inglês, montados a partir do `code` e de `params`.
 * O analisador grava em `message` o texto em português (compatibilidade com leitores antigos);
 * a CLI e a interface mostram `diagnosticText(d, lang)`.
 */

type Params = Record<string, string | number>;
type Texts = Record<Lang, (p: Params) => string | undefined>;

/** Etapas da análise que podem falhar em um arquivo (`analysis-failed`, `params.step`). */
const STEPS: Record<string, Record<Lang, string>> = {
  entities: { pt: 'entidades', en: 'entities' },
  imports: { pt: 'imports', en: 'imports' },
  exports: { pt: 'exports', en: 'exports' },
  calls: { pt: 'chamadas', en: 'calls' },
  jsx: { pt: 'JSX', en: 'JSX' },
  heritage: { pt: 'herança', en: 'inheritance' },
  'routes-express': { pt: 'rotas (Express)', en: 'routes (Express)' },
  'routes-fastify': { pt: 'rotas (Fastify)', en: 'routes (Fastify)' },
  'routes-hono': { pt: 'rotas (Hono)', en: 'routes (Hono)' },
  'routes-nestjs': { pt: 'rotas (NestJS)', en: 'routes (NestJS)' },
  'routes-next': { pt: 'rotas (Next.js)', en: 'routes (Next.js)' },
};

/** Motivos conhecidos de falha (`params.reason`); sem motivo conhecido vale `params.error`. */
const REASONS: Record<string, Record<Lang, string>> = {
  'too-deep': {
    pt: 'estrutura aninhada demais para analisar',
    en: 'structure nested too deeply to analyze',
  },
  'no-permission': { pt: 'sem permissão de leitura', en: 'no read permission' },
  'backslash-name': {
    pt: 'o nome contém "\\", que o compilador trata como separador de pastas',
    en: 'the name contains "\\", which the compiler treats as a folder separator',
  },
};

const text = (v: string | number | undefined) => (v === undefined ? undefined : String(v));

/** Entrada própria de uma tabela (nunca do protótipo, ex.: `constructor`). */
const own = <T>(table: Record<string, T>, key: unknown): T | undefined =>
  typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;

/** Motivo traduzido, ou o texto do erro como veio. */
function reasonOf(p: Params, lang: Lang): string | undefined {
  const known = own(REASONS, p.reason)?.[lang];
  return known ?? text(p.error);
}

/** Monta o texto só quando todas as partes existem (senão vale a mensagem gravada). */
function needs(values: Array<string | undefined>, build: (...v: string[]) => string) {
  return values.every((v) => v !== undefined) ? build(...(values as string[])) : undefined;
}

export const DIAGNOSTIC_TEXTS: Record<string, Texts> = {
  'analysis-failed': {
    pt: (p) =>
      p.step === 'route-paths'
        ? needs(
            [reasonOf(p, 'pt')],
            (r) => `Não foi possível compor os caminhos completos das rotas: ${r}.`,
          )
        : needs(
            [own(STEPS, p.step)?.pt, reasonOf(p, 'pt')],
            (step, r) =>
              `Parte da análise (${step}) falhou neste arquivo: ${r}. As relações dele podem estar incompletas.`,
          ),
    en: (p) =>
      p.step === 'route-paths'
        ? needs([reasonOf(p, 'en')], (r) => `Could not compose the full route paths: ${r}.`)
        : needs(
            [own(STEPS, p.step)?.en, reasonOf(p, 'en')],
            (step, r) =>
              `Part of the analysis (${step}) failed in this file: ${r}. Its relationships may be incomplete.`,
          ),
  },
  'unreadable-directory': {
    pt: (p) => needs([text(p.error)], (e) => `Não foi possível ler o diretório: ${e}`),
    en: (p) => needs([text(p.error)], (e) => `Could not read the directory: ${e}`),
  },
  'unreadable-file': {
    pt: (p) => needs([text(p.error)], (e) => `Arquivo ignorado: não foi possível ler (${e}).`),
    en: (p) => needs([text(p.error)], (e) => `File skipped: it could not be read (${e}).`),
  },
  'syntax-error': {
    pt: (p) => needs([text(p.error)], (e) => `Erro de sintaxe: ${e}`),
    en: (p) => needs([text(p.error)], (e) => `Syntax error: ${e}`),
  },
  'symlink-skipped': {
    pt: () => 'Link simbólico ignorado (o Rastro não segue links simbólicos).',
    en: () => 'Symbolic link skipped (Rastro does not follow symbolic links).',
  },
  'parse-failed': {
    pt: (p) =>
      needs(
        [reasonOf(p, 'pt')],
        (r) => `Arquivo ignorado: não foi possível ler ou interpretar (${r}).`,
      ),
    en: (p) =>
      needs([reasonOf(p, 'en')], (r) => `File skipped: it could not be read or parsed (${r}).`),
  },
  'no-source-files': {
    pt: () => 'Nenhum arquivo .js/.jsx/.ts/.tsx foi encontrado (após aplicar as exclusões).',
    en: () => 'No .js/.jsx/.ts/.tsx files were found (after applying the exclusions).',
  },
  'max-files-reached': {
    pt: (p) =>
      needs(
        [text(p.limit)],
        (n) => `Limite de ${n} arquivos atingido; o restante do projeto não foi analisado.`,
      ),
    en: (p) =>
      needs(
        [text(p.limit)],
        (n) => `Limit of ${n} files reached; the rest of the project was not analyzed.`,
      ),
  },
  'file-too-large': {
    pt: (p) =>
      needs(
        [text(p.limitKb)],
        (kb) => `Arquivo ignorado por ser maior que ${kb} KB (provavelmente gerado).`,
      ),
    en: (p) =>
      needs(
        [text(p.limitKb)],
        (kb) => `File skipped because it is larger than ${kb} KB (probably generated).`,
      ),
  },
  'invalid-config': {
    pt: (p) => needs([text(p.config), text(p.error)], (c, e) => `Não foi possível ler ${c}: ${e}`),
    en: (p) => needs([text(p.config), text(p.error)], (c, e) => `Could not read ${c}: ${e}`),
  },
  'folder-filter': {
    pt: (p) =>
      needs(
        [text(p.folder)],
        (f) =>
          `Grafo restrito à pasta "${f}". Os contadores de chamadas fora do grafo (externalCallsSkipped, unknownReceiverCalls...) continuam valendo para o projeto inteiro.`,
      ),
    en: (p) =>
      needs(
        [text(p.folder)],
        (f) =>
          `Graph restricted to the folder "${f}". The counters of calls left out of the graph (externalCallsSkipped, unknownReceiverCalls...) still refer to the whole project.`,
      ),
  },
  'next-routes-skipped': {
    pt: (p) =>
      needs(
        [text(p.config), text(p.option)],
        (c, o) =>
          `Rotas do Next.js não detectadas: ${c} define ${o} de um jeito que só seria conhecido executando o arquivo.`,
      ),
    en: (p) =>
      needs(
        [text(p.config), text(p.option)],
        (c, o) =>
          `Next.js routes not detected: ${c} sets ${o} in a way that could only be known by running the file.`,
      ),
  },
};

/** Códigos de diagnóstico com texto conhecido em todos os idiomas. */
export const DIAGNOSTIC_CODES = Object.keys(DIAGNOSTIC_TEXTS);

/**
 * Texto do diagnóstico no idioma pedido, a partir do `code` e de `params`. Códigos
 * desconhecidos (ou sem as partes necessárias) usam a mensagem gravada (`message`).
 */
export function diagnosticText(d: Diagnostic, lang: Lang): string {
  const texts = own(DIAGNOSTIC_TEXTS, d.code);
  if (!texts) return d.message;
  try {
    return texts[lang](d.params ?? {}) ?? d.message;
  } catch {
    return d.message;
  }
}
