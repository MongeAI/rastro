declare function fastify(): {
  get(path: string, handler: () => unknown): void;
  register(plugin: unknown, options?: { prefix?: string }): void;
};

export = fastify;
