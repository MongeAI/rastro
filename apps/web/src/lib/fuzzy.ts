const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/** Pontua o texto contra a busca: trecho contínuo vale mais; letras em ordem valem menos. */
export function fuzzyScore(text: string, query: string): number {
  const t = normalize(text);
  const q = normalize(query).trim();
  if (!q) return 1;
  const at = t.indexOf(q);
  if (at === 0) return 100;
  if (at > 0) return 80 - Math.min(at, 30) + (/[\s:/._-]/.test(t[at - 1]!) ? 10 : 0);
  // letras em ordem (ex.: "tmc" → "Tema claro"): cada letra vem logo depois da anterior ou no
  // começo de uma palavra; letras soltas pelo texto não contam
  let score = 0;
  let from = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    let found = t.indexOf(ch, from);
    while (found >= 0 && found !== from && !(found === 0 || /[\s:/._-]/.test(t[found - 1]!)))
      found = t.indexOf(ch, found + 1);
    if (found < 0) return 0;
    score += found === from ? 2 : 3;
    from = found + 1;
  }
  return Math.min(40, score);
}
