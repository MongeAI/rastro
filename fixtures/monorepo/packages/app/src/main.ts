import { formatName, Greeter } from '@demo/util';

export function run(): string {
  const greeter = new Greeter();
  return greeter.greet(formatName(' Ada '));
}
