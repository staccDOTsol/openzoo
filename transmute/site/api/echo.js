// App-router style handler with a JSON body. Bodies ride inside the
// transaction, so they are small (see /.zoo/status for the exact budget).
export async function POST(request) {
  const body = await request.json();
  const keys = Object.keys(body);
  return Response.json({ echo: body, keys, count: keys.length }, { status: 201, headers: { 'x-echo-count': String(keys.length) } });
}
export function GET() {
  return new Response('POST a JSON body here', { status: 200, headers: { 'content-type': 'text/plain' } });
}
