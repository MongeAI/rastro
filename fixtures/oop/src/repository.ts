export interface Repository<T> {
  save(item: T): void;
  find(id: number): T | undefined;
}

export interface Store<T> extends Repository<T> {
  clear(): void;
}

export interface Named {
  label(): string;
}

export class MemoryRepository<T> implements Store<T>, Named {
  protected items: T[] = [];

  save(item: T): void {
    this.items.push(item);
  }

  find(id: number): T | undefined {
    return this.items[id];
  }

  clear(): void {
    this.items = [];
  }

  label(): string {
    return 'memória';
  }
}

/** Implementa Store pela classe base. */
export class CachedRepository<T> extends MemoryRepository<T> {
  find(id: number): T | undefined {
    return super.find(id);
  }
}

export class SqlRepository implements Repository<string> {
  save(item: string): void {
    void item;
  }

  find(id: number): string | undefined {
    return String(id);
  }
}

/** Tem os mesmos métodos, mas não declara `implements`: não é candidata. */
export class LooksLikeRepository {
  save(item: string): void {
    void item;
  }
}

export type Clock = { now(): number };

export class SystemClock implements Clock {
  now(): number {
    return 0;
  }
}
