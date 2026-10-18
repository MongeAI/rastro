export class QueryBuilder {
  where(_field: string): QueryBuilder {
    return this;
  }

  orderBy(_field: string): QueryBuilder {
    return this;
  }

  run(): string[] {
    return [];
  }
}

export function query(): QueryBuilder {
  return new QueryBuilder();
}

export interface Pipeline {
  step(name: string, fn: (value: unknown) => unknown): Pipeline;
  done(): void;
}
