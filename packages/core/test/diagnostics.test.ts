import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_CODES, diagnosticText, type Diagnostic } from '@rastro/core';

const packages = fileURLToPath(new URL('../../', import.meta.url));

/** Arquivos .ts de `src/` dos pacotes (analyzer, graph, core). */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Códigos de diagnóstico produzidos no código (`level: '...', code: '...'`). */
function producedCodes(): Set<string> {
  const codes = new Set<string>();
  for (const pkg of fs.readdirSync(packages)) {
    const src = path.join(packages, pkg, 'src');
    if (!fs.existsSync(src)) continue;
    for (const file of sources(src)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/level:\s*'(?:info|warning|error)',\s*code:\s*'([\w-]+)'/g))
        codes.add(m[1]!);
    }
  }
  return codes;
}

/** Variações de params que cobrem cada etapa e cada motivo conhecidos. */
const SAMPLES: Array<Record<string, string | number>> = [
  { error: 'Unexpected token', config: 'tsconfig.json', limit: 10, limitKb: 1000 },
  { folder: 'src/api', config: 'next.config.mjs', option: 'pageExtensions' },
  ...[
    'entities',
    'imports',
    'exports',
    'calls',
    'jsx',
    'heritage',
    'routes-express',
    'routes-fastify',
    'routes-hono',
    'routes-nestjs',
    'routes-next',
    'route-paths',
  ].flatMap((step) => [
    { step, error: 'Maximum call stack size exceeded' },
    { step, reason: 'too-deep' },
    { step, reason: 'no-permission' },
  ]),
  { reason: 'backslash-name' },
];

const PORTUGUESE =
  /\b(de|do|da|dos|das|não|nao|em|um|uma|sem|com|para|que|foi|ler|arquivo|arquivos|pasta|diretório|erro|ignorado|limite|rotas?|caminhos?|análise|relações|projeto|etapa|chamadas|herança)\b/i;
const DIACRITICS = /[À-ÿ]/;

describe('diagnosticText', () => {
  it('todo código de diagnóstico produzido no código tem texto em pt e en', () => {
    const produced = producedCodes();
    // e nenhum texto sobra: a busca encontrou todos os produtores (não passa por acidente)
    expect([...produced].sort()).toEqual([...DIAGNOSTIC_CODES].sort());
  });

  it('os textos em inglês não têm palavras em português nem acentos', () => {
    for (const code of DIAGNOSTIC_CODES) {
      let built = 0;
      for (const params of SAMPLES) {
        const d: Diagnostic = { level: 'warning', code, message: '<pt>', params };
        const en = diagnosticText(d, 'en');
        const pt = diagnosticText(d, 'pt');
        if (en === '<pt>') {
          expect(pt, `${code} ${JSON.stringify(params)}`).toBe('<pt>');
          continue;
        }
        built++;
        expect(en, en).not.toMatch(PORTUGUESE);
        expect(en, en).not.toMatch(DIACRITICS);
        expect(pt).not.toBe('<pt>');
      }
      // cada código tem pelo menos um conjunto de params que monta o texto
      expect(built, code).toBeGreaterThan(0);
    }
  });

  it('usa os params e cai na mensagem gravada para códigos desconhecidos ou params faltando', () => {
    const big: Diagnostic = {
      level: 'warning',
      code: 'file-too-large',
      message: 'Arquivo ignorado por ser maior que 1000 KB (provavelmente gerado).',
      params: { limitKb: 1000 },
    };
    expect(diagnosticText(big, 'pt')).toBe(big.message);
    expect(diagnosticText(big, 'en')).toBe(
      'File skipped because it is larger than 1000 KB (probably generated).',
    );
    const failed: Diagnostic = {
      level: 'warning',
      code: 'analysis-failed',
      message: 'msg',
      params: { step: 'heritage', reason: 'too-deep' },
    };
    expect(diagnosticText(failed, 'en')).toBe(
      'Part of the analysis (inheritance) failed in this file: structure nested too deeply to analyze. Its relationships may be incomplete.',
    );
    const unknown: Diagnostic = { level: 'info', code: 'novo-codigo', message: 'Texto original' };
    expect(diagnosticText(unknown, 'en')).toBe('Texto original');
    const missing: Diagnostic = { level: 'info', code: 'invalid-config', message: 'Sem params' };
    expect(diagnosticText(missing, 'en')).toBe('Sem params');
    const proto: Diagnostic = { level: 'info', code: 'constructor', message: 'Protótipo' };
    expect(diagnosticText(proto, 'en')).toBe('Protótipo');
    const badStep: Diagnostic = {
      level: 'info',
      code: 'analysis-failed',
      message: 'Etapa estranha',
      params: { step: 'toString', error: 'x' },
    };
    expect(diagnosticText(badStep, 'en')).toBe('Etapa estranha');
  });
});
