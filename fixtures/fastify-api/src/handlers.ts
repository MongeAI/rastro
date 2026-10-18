const users: Array<{ id: string }> = [];

export async function health() {
  return { ok: true };
}

export async function listUsers() {
  return users;
}

export async function getUser() {
  return users[0];
}

export async function removeUser() {
  users.pop();
}

export function login(body: unknown) {
  return { token: String(body) };
}
