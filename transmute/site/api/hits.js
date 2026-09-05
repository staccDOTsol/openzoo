// @vercel/kv on PDAs. GET reads (free simulation); POST increments (a signed
// transaction — the gateway discovers the KV account by dry-run and pays rent
// on first write).
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const hits = await kv.incr('hits');
    return res.status(200).json({ hits, wrote: true });
  }
  const hits = (await kv.get('hits')) || 0;
  res.status(200).json({ hits, wrote: false });
}
