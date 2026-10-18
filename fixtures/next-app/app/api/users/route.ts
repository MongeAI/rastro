import { listUsers } from '../../../lib/users';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(listUsers());
}

export async function POST(request: Request) {
  const body = await request.json();
  return Response.json(body, { status: 201 });
}

/** Não é um método HTTP: não vira rota. */
export function helper() {
  return 1;
}
