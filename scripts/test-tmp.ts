import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `globalSetup` do Vitest: os testes criam milhares de projetos temporários (`mkdtemp` em
 * `os.tmpdir()`). Cada execução ganha uma pasta própria (TMPDIR, também para as CLIs que os
 * testes iniciam) e ela é apagada no fim, para nada se acumular no /tmp.
 */
export default function setup(): () => void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-tests-'));
  const previous = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = dir;
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
}
