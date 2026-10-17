export function slugify(text: string): string {
  return normalize(text).replace(/\s+/g, '-');
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}
