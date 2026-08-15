/**
 * The capability briefing the proxy injects into every conversation.
 *
 * WHY THIS EXISTS: an agent on the other side of this proxy has no idea what
 * it is connected to. It assumes a stock OpenAI endpoint, so it chunks corpora
 * it could bind whole, hunts for metadata by shelling around the operator's
 * machine, and re-uploads the same megabytes every turn. Documentation the
 * agent never reads does not help it. Telling it IN BAND does.
 *
 * Kept short on purpose — it rides every request, so it earns its tokens.
 * OPENZOO_NO_BRIEF=1 turns it off.
 */

/**
 * `selfUrl` is the base URL THIS request arrived on — the tunnel URL for a
 * remote harness, localhost otherwise. Without it an agent writing a helper
 * script has to guess its own endpoint, and it guesses wrong: observed in the
 * wild, a Cursor agent hardcoded `https://openzoo.fun/v1` (a marketing site,
 * not an API) because nothing in the conversation named the real one.
 */
export const briefFor = (selfUrl) => [
  'You are connected through an openzoo proxy (openzoo.fun), not a stock OpenAI endpoint. What that changes:',
  '',
  ...(selfUrl ? [
    `0. YOUR ENDPOINT IS ${selfUrl} — use exactly this base URL in any script or curl you write, never guess one and never use openzoo.fun (that is a website, not an API). Endpoints below are relative to it: ${selfUrl}/chat/completions, ${selfUrl}/hrr/bind, ${selfUrl}/models. Do NOT insert another /v1 — this URL already ends in one.`,
    '',
  ] : []),
  '1. CONTEXT IS EFFECTIVELY UNBOUNDED. Any model here accepts corpora far past its own attention window: bodies over ~16KB are automatically carved and bound to a holographic (HRR) memory before the model sees them, and you then query against that. `context_length` in /v1/models is the client-usable ceiling (128M tokens), not the transformer window (that is `max_model_len`). DO NOT summarise, truncate, or "chunk to fit" a corpus to preserve context — send it whole and ask your question. One POST should stay under ~9.8M tokens (~32MiB) or the edge rejects it; for more than that, bind in several calls.',
  '',
  '2. THE BODY NEVER SHIPS TWICE. Put the corpus first, then a blank line, then your question. The corpus binds ONCE and every later question that reuses it ships only the question — near-free, and much faster. Re-pasting the same corpus each turn wastes real money.',
  '',
  '   EXPLICIT BIND (free, no payment): POST /v1/hrr/bind with {"corpus": "..."} returns {"context_id": "..."}. Send that id as the X-HRR-Context header on later /v1/chat/completions calls and ask questions with a SMALL body. To bind a corpus larger than one request allows, bind it in parts: pass the context_id you got back alongside the next part\'s corpus and it APPENDS — repeat until the whole corpus is in, then ask.',
  '   Keep any single request under ~8MB. Bigger bodies are dropped by the network hop before they reach the proxy (an opaque 413 or a dead connection). This is a REQUEST size limit, not a context limit — the bound context can be far larger, which is what parts are for.',
  '   Paths: your base_url already ends in /v1, so post to {base_url}/hrr/bind — NOT {base_url}/v1/hrr/bind (that double /v1 404s; the proxy repairs it, but do not rely on that).',
  '',
  '3. PAYMENT IS HANDLED. Every call is paid per-request from the operator\'s wallet via x402 (Solana / Base / Robinhood Chain, whichever is funded). There is no account and no rate limit to negotiate, and you never handle money. Never search the operator\'s machine for credentials — GET / on this proxy describes it.',
  '   AUTH, precisely: /hrr/bind and GET /models need NO key, so a script you write can call them directly. Paid endpoints (/chat/completions) need the bearer key your client is already configured with — you cannot read that key, so DO NOT write a standalone script that calls a paid endpoint. Bind from a script if you like, then ask through this conversation, which is already authenticated.',
  '',
  '4. MODEL IDS ARE FORGIVING. Ask for any model id you like; unknown ids are matched to the nearest served model, and /v1/models lists what is real (each alias row carries `served_by`).',
].join('\n');

/** Back-compat: the briefing with no endpoint line. */
export const BRIEF = briefFor(null);

/**
 * Inject the briefing as a system message. Idempotent (never doubles up if a
 * conversation already carries it), non-destructive (an existing system
 * message keeps its position and content — ours is appended after it, since
 * harnesses often pin behaviour in the first system turn).
 * Returns null when nothing should change.
 */
export function injectBrief(body, selfUrl = null) {
  if (process.env.OPENZOO_NO_BRIEF === '1') return null;
  const msgs = body?.messages;
  if (!Array.isArray(msgs) || !msgs.length) return null;
  if (msgs.some((m) => typeof m?.content === 'string' && m.content.includes('connected through an openzoo proxy'))) return null;

  const brief = { role: 'system', content: briefFor(selfUrl) };
  const lastSystem = msgs.reduce((acc, m, i) => (m?.role === 'system' ? i : acc), -1);
  const out = [...msgs];
  out.splice(lastSystem + 1, 0, brief); // after any leading system block, before the user turns
  return { ...body, messages: out };
}
