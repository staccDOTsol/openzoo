import { randomUUID } from 'node:crypto';
/** Report a failed turn through the client's response stream, not transport-error prose. */
export function paymentError(res, req, init, status, message) {
  let body = {};
  try { body = JSON.parse(String(init?.body || '{}')); } catch {}
  if (/\/responses(?:\?|$)/.test(req.url || '') && body.stream === true) {
    const response = { id: `resp_${randomUUID()}`, object: 'response', created_at: Math.floor(Date.now()/1000), status: 'failed',
      error: { code: 'server_error', message }, output: [], usage: null, model: body.model || '', incomplete_details: null };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', sequence_number: 0, response })}\n\n`);
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}
