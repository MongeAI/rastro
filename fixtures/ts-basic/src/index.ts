import fs from 'node:fs';
import _ from 'lodash';
import { greet } from 'fake-lib';
import chalk from 'chalk';
import { sum, average } from './math.js';
import { UserService } from './services/user-service';
import { slugify } from '@lib/strings';
import { ghost } from './missing';
import type { User } from './models/user';

export function main(): void {
  const service = new UserService();
  const user: User = service.create('Ada Lovelace');
  console.log(sum(1, 2), average([1, 2, 3]), slugify(user.name));
  console.log(_.isEmpty({}), greet(), chalk, fs.existsSync('.'));
  ghost();
  // @ts-expect-error função que não existe em lugar nenhum
  notDefinedAnywhere();
  runCallback(() => sum(4, 5));
  const handlers: Record<string, () => void> = { a: main };
  handlers['a']?.();
}

function runCallback(cb: () => number): number {
  return cb();
}

main();
