import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyzeProject } from '@rastro/analyzer';
import { parseRules, type ChangeSet, type RuleSpec } from '@rastro/core';
import { checkRules, GraphIndex, suggestRules, type SuggestionNames } from '@rastro/graph';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<GraphIndex> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-rules-')));
  dirs.push(root);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return new GraphIndex(await analyzeProject(root));
}

const rulesOf = (specs: RuleSpec[]) => {
  const parsed = parseRules({ rules: specs });
  expect(parsed.issues).toEqual([]);
  return parsed.rules!;
};

/** ui → services → db; ui também usa db direto (proibido) e o pacote pg. */
const layered = {
  'package.json': JSON.stringify({ name: 'app', dependencies: { pg: '1' } }),
  'src/db/client.ts': 'export function query(sql: string) { return sql; }\n',
  'src/services/users.ts':
    "import { query } from '../db/client';\nexport function listUsers() { return query('x'); }\n",
  'src/ui/page.ts': [
    "import { listUsers } from '../services/users';",
    "import { query } from '../db/client';",
    "import type { Pool } from 'pg';",
    'export function render(pool?: Pool) {',
    '  listUsers();',
    "  return query('y');",
    '}',
    '',
  ].join('\n'),
  'src/ui/page.test.ts': "import { query } from '../db/client';\nquery('t');\n",
};

describe('checkRules', () => {
  it('deny: cada par de arquivos vira uma violação com as evidências (import e chamada)', async () => {
    const index = await project(layered);
    const check = checkRules(
      index,
      rulesOf([
        {
          name: 'UI sem banco',
          from: 'src/ui',
          except: '**/*.test.ts',
          deny: ['src/db', 'pkg:pg'],
        },
      ]),
    );
    const [outcome] = check.outcomes;
    expect(outcome!.files).toBe(1);
    expect(
      outcome!.violations.map((v) => ({
        from: v.from,
        to: v.to,
        package: v.package,
        kinds: v.kinds,
        lines: v.evidence.map((e) => e.line),
        typeOnly: v.typeOnly,
      })),
    ).toEqual([
      {
        from: 'src/ui/page.ts',
        to: 'pg',
        package: true,
        kinds: ['imports'],
        lines: [3],
        typeOnly: true,
      },
      {
        from: 'src/ui/page.ts',
        to: 'src/db/client.ts',
        package: false,
        kinds: ['imports', 'calls'],
        lines: [2, 6],
        typeOnly: false,
      },
    ]);
    expect(check.errors).toBe(2);
    expect(check.warnings).toBe(0);
    expect(outcome!.violations[1]!.edges.length).toBe(2);
  });

  it('ignoreTypeImports tira o import só de tipo; severity warning não conta como erro', async () => {
    const index = await project(layered);
    const check = checkRules(
      index,
      rulesOf([
        {
          name: 'a',
          from: 'src/ui',
          except: '**/*.test.ts',
          deny: 'pkg:*',
          ignoreTypeImports: true,
        },
        { name: 'b', from: 'src/ui', deny: 'src/db', severity: 'warning' },
      ]),
    );
    expect(check.outcomes[0]!.violations).toEqual([]);
    expect(check.outcomes[1]!.violations.map((v) => v.from)).toEqual([
      'src/ui/page.test.ts',
      'src/ui/page.ts',
    ]);
    expect(check).toMatchObject({ errors: 0, warnings: 2 });
  });

  it('allow: só o que está na lista ou dentro da própria regra', async () => {
    const index = await project(layered);
    const check = checkRules(
      index,
      rulesOf([{ name: 'ui só usa services', from: 'src/ui', allow: 'src/services' }]),
    );
    expect(check.outcomes[0]!.violations.map((v) => `${v.from} → ${v.to}`)).toEqual([
      'src/ui/page.test.ts → src/db/client.ts',
      'src/ui/page.ts → pg',
      'src/ui/page.ts → src/db/client.ts',
    ]);
  });

  it('regra que não casa com nenhum arquivo fica com files = 0', async () => {
    const index = await project(layered);
    const check = checkRules(index, rulesOf([{ name: 'x', from: 'src/iu', deny: 'src/db' }]));
    expect(check.outcomes[0]).toMatchObject({ files: 0, violations: [] });
  });

  it('noCycles: o ciclo mais curto com o import de cada passo; só de tipo não conta', async () => {
    const index = await project({
      'src/a.ts': "import { b } from './b';\nexport const a = () => b();\n",
      'src/b.ts': "import { c } from './c';\nexport const b = () => c();\n",
      'src/c.ts': "import { a } from './a';\nexport const c = () => a();\n",
      'src/t1.ts': "import type { T2 } from './t2';\nexport type T1 = T2 | 1;\n",
      'src/t2.ts': "import type { T1 } from './t1';\nexport type T2 = T1 | 2;\n",
    });
    const check = checkRules(index, rulesOf([{ name: 'sem ciclos', noCycles: true }]));
    const [v] = check.outcomes[0]!.violations;
    expect(check.outcomes[0]!.violations).toHaveLength(1);
    expect(v!.cycle!.map((s) => `${s.file}:${s.evidence?.line}`)).toEqual([
      'src/a.ts:1',
      'src/b.ts:1',
      'src/c.ts:1',
    ]);
    expect(v!.cycleSize).toBe(3);
    expect(v!.edges).toHaveLength(3);
    // fora do escopo da regra, o ciclo não existe
    const scoped = checkRules(
      index,
      rulesOf([{ name: 's', noCycles: true, from: 'src/{a,b}.ts' }]),
    );
    expect(scoped.outcomes[0]!.violations).toEqual([]);
  });

  it('com mudanças: marca o que foi introduzido e o ciclo passa pelo import alterado', async () => {
    const index = await project({
      'src/a.ts':
        "import { b } from './b';\nimport { d } from './d';\nexport const a = () => b() + d();\n",
      'src/b.ts':
        "import { a } from './a';\nexport const b = () => 1;\nexport const x = () => a();\n",
      'src/d.ts':
        "import { a } from './a';\nexport const d = () => 2;\nexport const y = () => a();\n",
      'src/ui.ts': "import { b } from './b';\nexport const u = () => b();\n",
    });
    const changes: ChangeSet = {
      base: 'HEAD',
      baseLabel: 'HEAD',
      includesUntracked: true,
      files: [{ file: 'src/d.ts', status: 'modified', ranges: [[1, 1]] }],
    };
    const check = checkRules(
      index,
      rulesOf([
        { name: 'ciclos', noCycles: true },
        { name: 'ui', from: 'src/ui.ts', deny: 'src/b.ts' },
      ]),
      changes,
    );
    const [cycle] = check.outcomes[0]!.violations;
    expect(cycle!.introduced).toBe(true);
    expect(cycle!.cycle!.map((s) => s.file)).toEqual(['src/a.ts', 'src/d.ts']);
    expect(check.outcomes[1]!.violations[0]!.introduced).toBe(false);
    expect(check.introduced).toEqual({ errors: 1, warnings: 0 });
    expect(check.errors).toBe(2);
  });

  it('chamada por interface: o destino possível nunca reprova', async () => {
    const index = await project({
      'src/port.ts': 'export interface Store { save(): void }\n',
      'src/db/store.ts':
        "import type { Store } from '../port';\nexport class DbStore implements Store { save() {} }\n",
      'src/ui/use.ts':
        "import type { Store } from '../port';\nexport function go(s: Store) { s.save(); }\n",
    });
    const check = checkRules(index, rulesOf([{ name: 'ui', from: 'src/ui', deny: 'src/db' }]));
    expect(check.outcomes[0]!.violations).toEqual([]);
    expect(check.outcomes[0]!.possible.map((v) => `${v.from} → ${v.to}`)).toEqual([
      'src/ui/use.ts → src/db/store.ts',
    ]);
    expect(check).toMatchObject({ errors: 0, possible: 1 });
  });
});

const names: SuggestionNames = {
  layer: (folder, above) => `${folder} não depende de ${above.join(', ')}`,
  noCycles: 'Sem ciclos',
  tests: 'Código não depende de testes',
};

describe('suggestRules', () => {
  it('trava as camadas atuais, ciclos e testes, e nada começa violado', async () => {
    const index = await project({
      ...layered,
      'src/ui/page.ts': "import { listUsers } from '../services/users';\nlistUsers();\n",
      'vite.config.ts': 'export default {};\n',
    });
    const specs = suggestRules(index, names);
    expect(specs).toEqual([
      {
        name: 'src/db não depende de src/services, src/ui',
        from: 'src/db',
        except: ['**/{__tests__,test,tests,spec,e2e}/**', '**/*.{test,spec,e2e}.*'],
        deny: ['src/services', 'src/ui'],
      },
      {
        name: 'src/services não depende de src/ui',
        from: 'src/services',
        except: ['**/{__tests__,test,tests,spec,e2e}/**', '**/*.{test,spec,e2e}.*'],
        deny: ['src/ui'],
      },
      { name: 'Sem ciclos', noCycles: true },
      {
        name: 'Código não depende de testes',
        from: '**',
        except: ['**/{__tests__,test,tests,spec,e2e}/**', '**/*.{test,spec,e2e}.*'],
        deny: ['**/{__tests__,test,tests,spec,e2e}/**', '**/*.{test,spec,e2e}.*'],
      },
    ]);
    const check = checkRules(index, rulesOf(specs));
    expect(check.errors).toBe(0);
  });

  it('monorepo: camadas também entre os pacotes de packages/', async () => {
    const index = await project({
      'packages/common/src/util.ts': 'export const u = () => 1;\n',
      'packages/core/src/app.ts':
        "import { u } from '../../common/src/util';\nexport const a = () => u();\n",
      'packages/http/index.ts':
        "import { a } from '../core/src/app';\nexport const h = () => a();\n",
      'sample/main.ts': "import { h } from '../packages/http/index';\nh();\n",
    });
    expect(suggestRules(index, names).map((r) => r.name)).toEqual([
      'packages não depende de sample',
      'packages/common não depende de packages/core, packages/http',
      'packages/core não depende de packages/http',
      'Sem ciclos',
    ]);
  });

  it('pastas que se usam mutuamente e ciclos existentes não viram regra', async () => {
    const index = await project({
      'lib/a/x.ts': "import { y } from '../b/y';\nexport const x = () => y();\n",
      'lib/b/y.ts': "import { x } from '../a/x';\nexport const y = () => x();\n",
    });
    expect(suggestRules(index, names)).toEqual([]);
  });
});
