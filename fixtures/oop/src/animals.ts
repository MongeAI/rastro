export abstract class Animal {
  constructor(protected readonly name: string) {}

  describe(): string {
    return `${this.name} faz ${this.sound()}`;
  }

  abstract sound(): string;

  move(): string {
    return 'anda';
  }
}

export class Dog extends Animal {
  constructor(name: string) {
    super(name);
  }

  sound(): string {
    return 'au';
  }

  move(): string {
    return `${super.move()} e corre`;
  }

  fetch(): string {
    return this.describe();
  }
}

/** Sem construtor próprio: usa o de Dog. */
export class Puppy extends Dog {
  sound(): string {
    return 'ai';
  }
}

export class Cat extends Animal {
  sound(): string {
    return 'miau';
  }
}

class Plain {}

export class Child extends Plain {
  constructor() {
    super();
  }
}

export class Grandchild extends Puppy {
  constructor() {
    super('neto');
  }
}

export class AppError extends Error {
  constructor(message: string) {
    super(message);
  }
}
