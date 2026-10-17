import { pong } from './b';

export function ping(n: number): number {
  return n > 0 ? pong(n - 1) : 0;
}
