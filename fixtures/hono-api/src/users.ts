import { Hono } from 'hono';
import { createUser, getUser, listUsers } from './handlers';

const users = new Hono();

users.get('/', listUsers).get('/:id', getUser);
users.post('/', async (c) => c.json(createUser(await c.req.json())));

export default users;
