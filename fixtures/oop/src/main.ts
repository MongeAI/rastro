import { Puppy, type Animal } from './animals';
import type { Clock, Repository, Store } from './repository';

export function run(repo: Repository<string>, store: Store<string>, animal: Animal, clock: Clock) {
  repo.save('x');
  store.find(1);
  animal.sound();
  animal.move();
  const puppy = new Puppy('rex');
  puppy.fetch();
  puppy.describe();
  return clock.now();
}
