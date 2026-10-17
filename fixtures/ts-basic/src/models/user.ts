export class BaseModel {
  toJSON(): Record<string, unknown> {
    return { ...this };
  }
}

export class User extends BaseModel {
  constructor(
    public readonly id: number,
    public readonly name: string,
  ) {
    super();
  }

  get displayName(): string {
    return `#${this.id} ${this.name}`;
  }
}
