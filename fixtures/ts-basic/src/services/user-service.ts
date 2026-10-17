import { User } from '../models/user';
import { slugify } from '../lib/strings';

export class UserService {
  private readonly users: User[] = [];
  private counter = 0;

  create(name: string): User {
    const user = new User(this.nextId(), name);
    this.validate(user);
    this.users.push(user);
    return user;
  }

  findBySlug(slug: string): User | undefined {
    return this.users.find((u) => slugify(u.name) === slug);
  }

  static withSeed(): UserService {
    const service = new UserService();
    service.create('Grace Hopper');
    return service;
  }

  onCreate = (name: string): User => this.create(name);

  private validate(user: User): void {
    if (!user.name) throw new Error('nome obrigatório');
  }

  private nextId(): number {
    return ++this.counter;
  }
}
