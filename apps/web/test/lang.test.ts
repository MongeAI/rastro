import { describe, expect, it } from 'vitest';
import { detectLang } from '../src/lib/i18n';

describe('detectLang', () => {
  it('usa a escolha salva', () => {
    expect(detectLang('pt', ['en-US'])).toBe('pt');
    expect(detectLang('en', ['pt-BR'])).toBe('en');
  });

  it('segue a ordem de preferência do navegador', () => {
    expect(detectLang(null, ['en-US', 'pt-BR'])).toBe('en');
    expect(detectLang(null, ['pt-BR', 'en-US'])).toBe('pt');
    expect(detectLang(null, ['es-ES', 'pt-PT', 'en'])).toBe('pt');
  });

  it('sem idioma conhecido, inglês', () => {
    expect(detectLang(null, ['de-DE'])).toBe('en');
    expect(detectLang('xx', [])).toBe('en');
  });
});
