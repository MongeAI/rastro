import { query, type Pipeline } from './builder';

export function listUsers(): string[] {
  return query().where('active').orderBy('name').run();
}

export function report(): string[] {
  return query()
    .where('active')
    .orderBy('name')
    .run();
}

export function build(pipeline: Pipeline): void {
  pipeline
    .step('parse', (value) => (value instanceof Error ? null : value))
    .step('save', (value) => value)
    .done();
}
