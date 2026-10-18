import Fastify from 'fastify';
import usersRoutes from './routes/users';
import { health, login } from './handlers';

const app = Fastify({ logger: true });

app.get('/health', health);
app.get('/version', { schema: {} }, async () => ({ version: 1 }));
app.route({ method: ['GET', 'HEAD'], url: '/status', handler: health });

app.register(usersRoutes, { prefix: '/v1/users' });
app.register(
  async (instance) => {
    instance.post('/login', async (request) => login(request.body));
  },
  { prefix: '/auth' },
);

app.listen({ port: 3000 });
