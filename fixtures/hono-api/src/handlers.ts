// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Context = any;

export const health = (c: Context) => c.json({ ok: true });
export const listUsers = (c: Context) => c.json([]);
export const getUser = (c: Context) => c.json({ id: c.req.param('id') });

export function createUser(body: unknown) {
  return { body };
}

export function echo(value: string) {
  return { value };
}
