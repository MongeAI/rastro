import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { globMatcher, parseRules, ruleIssueText, type RuleIssue } from '@rastro/core';

const matches = (pattern: string, path: string) => globMatcher(pattern)(path);

describe('padrões de caminho das regras', () => {
  it('* não atravessa pastas; ** atravessa (inclusive zero pastas)', () => {
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/*.ts', 'src/x/a.ts')).toBe(false);
    expect(matches('src/**/*.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/**/*.ts', 'src/x/y/a.ts')).toBe(true);
    expect(matches('**/*.test.ts', 'a.test.ts')).toBe(true);
    expect(matches('**/*.test.ts', 'src/deep/a.test.ts')).toBe(true);
    expect(matches('src/**', 'src/a/b.ts')).toBe(true);
    expect(matches('src/**', 'srcx/a.ts')).toBe(false);
    expect(matches('**', 'qualquer/coisa.ts')).toBe(true);
    expect(matches('src/?.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/?.ts', 'src/ab.ts')).toBe(false);
  });

  it('sem curinga vale para o arquivo ou para a pasta inteira', () => {
    expect(matches('src/db', 'src/db/client.ts')).toBe(true);
    expect(matches('src/db', 'src/db')).toBe(true);
    expect(matches('src/db', 'src/dbx/client.ts')).toBe(false);
    expect(matches('src/db/', 'src/db/a/b.ts')).toBe(true);
    expect(matches('./src/db', 'src/db/a.ts')).toBe(true);
    expect(matches('/src/db', 'src/db/a.ts')).toBe(true);
    expect(matches('src/main.ts', 'src/main.ts')).toBe(true);
    expect(matches('.', 'tudo.ts')).toBe(true);
  });

  it('chaves são alternativas; colchetes e pontos são literais', () => {
    expect(matches('src/{ui,web}/**', 'src/web/a.ts')).toBe(true);
    expect(matches('src/{ui,web}/**', 'src/db/a.ts')).toBe(false);
    expect(matches('**/*.{test,spec}.*', 'a/b.spec.tsx')).toBe(true);
    expect(matches('app/[id]/page.tsx', 'app/[id]/page.tsx')).toBe(true);
    expect(matches('app/[id]/page.tsx', 'app/i/page.tsx')).toBe(false);
    expect(matches('src/*.ts', 'src/aXts')).toBe(false);
    expect(matches('src/a\\*b.ts', 'src/a*b.ts')).toBe(true);
    expect(matches('src/a\\*b.ts', 'src/axb.ts')).toBe(false);
  });

  it('chaves sem par ou aninhadas são erro (uma "}" solta é literal)', () => {
    expect(() => globMatcher('src/{a,b')).toThrow();
    expect(matches('src/a}', 'src/a}')).toBe(true);
    expect(matches('src/*}', 'src/a}')).toBe(true);
    expect(() => globMatcher('src/{a,{b,c}}')).toThrow();
  });

  it('padrões hostis terminam rápido (nada de backtracking)', () => {
    const path = `${'a/'.repeat(200)}${'a'.repeat(300)}b`;
    const started = performance.now();
    expect(matches(`${'*a'.repeat(60)}*c`, path)).toBe(false);
    expect(matches(`${'**/'.repeat(100)}x`, path)).toBe(false);
    expect(matches(`${'**/*a*/'.repeat(30)}c`, path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(() => globMatcher('{a,b,c,d}{a,b,c,d}{a,b,c,d}{a,b,c,d}')).toThrow();
    expect(() => globMatcher('a'.repeat(501))).toThrow();
    expect(
      parseRules({ rules: [{ name: 'x', deny: '{a,b,c,d}{a,b,c,d}{a,b,c,d}{a,b}' }] }).issues,
    ).toEqual([
      expect.objectContaining({
        code: 'bad-pattern',
        params: expect.objectContaining({ reason: 'complex' }),
      }),
    ]);
  });
});

describe('parseRules', () => {
  const codes = (data: unknown) => parseRules(data).issues.map((i) => i.code);

  it('normaliza as regras válidas', () => {
    const { rules, issues } = parseRules({
      $schema: 'x',
      rules: [
        {
          name: ' UI sem banco ',
          from: 'src/ui',
          deny: ['src/db', 'pkg:pg'],
          because: 'Use os serviços.',
        },
        { name: 'Domínio puro', from: ['src/domain/**'], allow: 'pkg:zod', severity: 'warning' },
        { name: 'Sem ciclos', noCycles: true },
      ],
    });
    expect(issues).toEqual([]);
    expect(rules).toEqual([
      {
        name: 'UI sem banco',
        kind: 'deny',
        from: ['src/ui'],
        except: [],
        targets: ['src/db', 'pkg:pg'],
        ignoreTypeImports: false,
        severity: 'error',
        because: 'Use os serviços.',
      },
      {
        name: 'Domínio puro',
        kind: 'allow',
        from: ['src/domain/**'],
        except: [],
        targets: ['pkg:zod'],
        ignoreTypeImports: false,
        severity: 'warning',
      },
      {
        name: 'Sem ciclos',
        kind: 'cycles',
        from: ['**'],
        except: [],
        targets: [],
        ignoreTypeImports: false,
        severity: 'error',
      },
    ]);
  });

  it('campo desconhecido é erro (um "form" no lugar de "from" valeria para tudo)', () => {
    expect(codes({ rules: [{ name: 'a', form: 'src/ui', deny: 'src/db' }] })).toEqual([
      'unknown-key',
    ]);
    expect(codes({ rule: [] })).toEqual(['unknown-key', 'rules-missing']);
  });

  it('aponta cada problema com o campo', () => {
    expect(codes(null)).toEqual(['not-object']);
    expect(codes([])).toEqual(['not-object']);
    expect(codes({ rules: {} })).toEqual(['not-list']);
    expect(codes({ rules: [1] })).toEqual(['not-object-rule']);
    expect(codes({ rules: [{ deny: 'x' }] })).toEqual(['no-name']);
    expect(codes({ rules: [{ name: 'a' }] })).toEqual(['no-kind']);
    expect(codes({ rules: [{ name: 'a', noCycles: false }] })).toEqual(['no-kind']);
    expect(codes({ rules: [{ name: 'a', deny: 'x', allow: 'y' }] })).toEqual(['many-kinds']);
    expect(codes({ rules: [{ name: 'a', deny: [] }] })).toEqual(['not-patterns']);
    expect(codes({ rules: [{ name: 'a', deny: [1] }] })).toEqual(['not-patterns']);
    expect(codes({ rules: [{ name: 'a', deny: '' }] })).toEqual(['bad-pattern']);
    expect(codes({ rules: [{ name: 'a', deny: 'pkg:' }] })).toEqual(['bad-pattern']);
    expect(codes({ rules: [{ name: 'a', deny: 'src/{a' }] })).toEqual(['bad-pattern']);
    expect(codes({ rules: [{ name: 'a', deny: 'x', severity: 'fatal' }] })).toEqual([
      'bad-severity',
    ]);
    expect(codes({ rules: [{ name: 'a', noCycles: 'yes' }] })).toEqual(['not-boolean', 'no-kind']);
    expect(codes({ rules: [{ name: 'a', noCycles: true, ignoreTypeImports: true }] })).toEqual([
      'not-applicable',
    ]);
    expect(codes({ rules: [{ name: 'a', deny: 'x', because: 1 }] })).toEqual(['not-string']);
    expect(
      codes({
        rules: [
          { name: 'a', deny: 'x' },
          { name: 'a', deny: 'y' },
        ],
      }),
    ).toEqual(['duplicate-name']);
    expect(codes({ rules: [{ name: 'a', from: 'pkg:react', deny: 'x' }] })).toEqual([
      'package-in-from',
    ]);
  });

  it('não devolve regras quando há qualquer problema', () => {
    expect(parseRules({ rules: [{ name: 'a', deny: 'x' }, { name: 'b' }] }).rules).toBeUndefined();
  });

  it('textos nos dois idiomas, com o campo', () => {
    const issue: RuleIssue = { code: 'unknown-key', params: { field: 'rules[0].form' } };
    expect(ruleIssueText(issue, 'pt')).toBe('rules[0].form: campo desconhecido.');
    expect(ruleIssueText(issue, 'en')).toBe('rules[0].form: unknown field.');
  });
});

describe('JSON Schema das regras', () => {
  const schema = JSON.parse(
    fs.readFileSync(new URL('../schema/rastro-rules.schema.json', import.meta.url), 'utf8'),
  );
  const validate = new Ajv2020({ strict: false }).compile(schema);

  it('aceita o que parseRules aceita e recusa as formas erradas', () => {
    const cases: unknown[] = [
      { rules: [] },
      { $schema: 'x', rules: [{ name: 'a', from: 'src/ui', deny: ['src/db', 'pkg:pg'] }] },
      { rules: [{ name: 'a', allow: 'pkg:zod', severity: 'warning', because: 'b' }] },
      { rules: [{ name: 'a', noCycles: true, from: 'src/**', except: ['**/*.test.ts'] }] },
      { rules: [{ name: 'a', deny: 'x', ignoreTypeImports: true }] },
      { rules: [{ name: 'a' }] },
      { rules: [{ name: 'a', deny: 'x', allow: 'y' }] },
      { rules: [{ name: 'a', deny: 'x', noCycles: true }] },
      { rules: [{ name: 'a', noCycles: false }] },
      { rules: [{ name: 'a', noCycles: true, ignoreTypeImports: false }] },
      { rules: [{ name: 'a', form: 'x', deny: 'y' }] },
      { rules: [{ name: 'a', deny: [] }] },
      { rules: [{ name: 'a', deny: '' }] },
      { rules: [{ name: 'a', deny: 'x', severity: 'fatal' }] },
      { rule: [] },
    ];
    for (const data of cases)
      expect(validate(data), JSON.stringify(data)).toBe(parseRules(data).issues.length === 0);
  });
});
