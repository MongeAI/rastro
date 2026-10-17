import { render } from './view.jsx';
import { load } from '../loader';

export async function start() {
  const data = await load();
  const lazy = await import('./lazy.mjs');
  return render({ ...data, extra: lazy.extra });
}
