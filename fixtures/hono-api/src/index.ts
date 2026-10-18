import { Hono } from 'hono';
import users from './users';
import { echo, health } from './handlers';

const app = new Hono();

app.get('/health', health);
app.route('/users', users);

const api = app.basePath('/api');
api.on(['GET', 'POST'], '/echo', (c) => c.json(echo(c.req.url)));

export default app;
