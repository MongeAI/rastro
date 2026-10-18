import { describe, expect, it } from 'vitest';
import { shellQuote } from '../src/lib/shell';

describe('shellQuote', () => {
  it('mantém caminhos comuns como estão', () => {
    expect(shellQuote('src/a.test.ts')).toBe('src/a.test.ts');
    expect(shellQuote('./packages/@x/y_z-1.spec.tsx')).toBe('./packages/@x/y_z-1.spec.tsx');
  });

  it('põe entre aspas o que o shell interpretaria', () => {
    expect(shellQuote('src/a;id>pwned;.test.ts')).toBe("'src/a;id>pwned;.test.ts'");
    expect(shellQuote('a b.ts')).toBe("'a b.ts'");
    expect(shellQuote('$(id).ts')).toBe("'$(id).ts'");
    expect(shellQuote('~/x*.ts')).toBe("'~/x*.ts'");
    expect(shellQuote('')).toBe("''");
  });

  it('escapa aspas simples', () => {
    expect(shellQuote("it's.test.ts")).toBe("'it'\\''s.test.ts'");
  });
});
