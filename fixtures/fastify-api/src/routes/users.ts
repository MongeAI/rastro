import type { FastifyInstance } from 'fastify';
import { getUser, listUsers, removeUser } from '../handlers';

export default async function usersRoutes(fastify: FastifyInstance) {
  fastify.get('/', listUsers);
  fastify.get('/:id', getUser);
  fastify.register(adminRoutes, { prefix: '/admin' });
}

async function adminRoutes(app: FastifyInstance) {
  app.delete('/:id', { handler: removeUser });
}
