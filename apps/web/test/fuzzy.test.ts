import { describe, expect, it } from 'vitest';
import { fuzzyScore } from '../src/lib/fuzzy';

describe('fuzzyScore (paleta de comandos)', () => {
  it('trecho contínuo vale mais que letras em ordem, e o começo vale mais que o meio', () => {
    expect(fuzzyScore('Usar tema claro', 'usar')).toBe(100);
    expect(fuzzyScore('Usar tema claro', 'tema')).toBeGreaterThan(
      fuzzyScore('Usar tema claro', 'utc'),
    );
    expect(fuzzyScore('Usar tema claro', 'utc')).toBeGreaterThan(0);
  });

  it('ignora acentos e maiúsculas', () => {
    expect(fuzzyScore('Nível: Símbolos', 'nivel simb')).toBeGreaterThan(0);
    expect(fuzzyScore('Organização: Orgânica', 'organizacao')).toBe(100);
  });

  it('letras soltas pelo texto não combinam', () => {
    expect(fuzzyScore('Ir para quem contém a seleção', 'tema')).toBe(0);
    expect(fuzzyScore('Enquadrar tudo', 'xyz')).toBe(0);
  });
});
