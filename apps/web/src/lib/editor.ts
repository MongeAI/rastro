/** Links para abrir um arquivo na linha certa no editor do usuário. */
export const EDITORS = {
  vscode: {
    label: 'VS Code',
    url: (p: string, l: number, c: number) => `vscode://file${encodePath(p)}:${l}:${c}`,
  },
  cursor: {
    label: 'Cursor',
    url: (p: string, l: number, c: number) => `cursor://file${encodePath(p)}:${l}:${c}`,
  },
  vscodium: {
    label: 'VSCodium',
    url: (p: string, l: number, c: number) => `vscodium://file${encodePath(p)}:${l}:${c}`,
  },
  zed: { label: 'Zed', url: (p: string, l: number) => `zed://file${encodePath(p)}:${l}` },
  jetbrains: {
    label: 'JetBrains (IDEA, WebStorm)',
    url: (p: string, l: number) => `idea://open?file=${encodeURIComponent(p)}&line=${l}`,
  },
} as const;

export type EditorId = keyof typeof EDITORS;

function encodePath(p: string): string {
  const withSlash = p.startsWith('/') ? p : `/${p}`;
  return withSlash.split('/').map(encodeURIComponent).join('/');
}

export function absolutePath(root: string, file: string): string {
  return `${root.replace(/\/+$/, '')}/${file}`;
}

/** localStorage pode não existir (modo privado, bloqueio): sempre com try/catch. */
export function readPref<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly string[],
): T {
  try {
    const v = localStorage.getItem(`teia:${key}`);
    return v && allowed.includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(`teia:${key}`, value);
  } catch {
    // preferências são apenas conveniência
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
