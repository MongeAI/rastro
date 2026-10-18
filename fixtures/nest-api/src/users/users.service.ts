import { Injectable } from '@nestjs/common';

@Injectable()
export class UsersService {
  private readonly users: Array<{ id: string; name: string }> = [];

  findAll() {
    return this.users;
  }

  findOne(id: string) {
    return this.users.find((u) => u.id === id);
  }

  create(name: string) {
    const user = { id: String(this.users.length + 1), name };
    this.users.push(user);
    return user;
  }

  remove(id: string) {
    const index = this.users.findIndex((u) => u.id === id);
    if (index >= 0) this.users.splice(index, 1);
  }
}
