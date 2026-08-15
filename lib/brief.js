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

export const BRIEF = [
  'You are connected through an openzoo proxy (openzoo.fun), not a stock OpenAI endpoint. What that changes:',
  '',
  '1. CONTEXT IS EFFECTIVELY UNBOUNDED. Any model here accepts corpora far past its own attention window: bodies over ~16KB are automatically carved and bound to a holographic (HRR) memory before the model sees them, and you then query against that. `context_length` in /v1/models is the client-usable ceiling (128M tokens), not the transformer window (that is `max_model_len`). DO NOT summarise, truncate, or "chunk to fit" a corpus to preserve context — send it whole and ask your question. One POST should stay under ~9.8M tokens (~32MiB) or the edge rejects it; for more than that, bind in several calls.',
  '',
  '2. THE BODY NEVER SHIPS TWICE. Put the corpus first, then a blank line, then your question. The corpus binds ONCE and every later question that reuses it ships only the question — near-free, and much faster. Re-pasting the same corpus each turn wastes real money. You can also bind explicitly: POST /v1/hrr/bind {"corpus": "..."} (free) returns a context_id; send it as the X-HRR-Context header on later calls.',
  '',
  '3. PAYMENT IS HANDLED. Every call is paid per-request from the operator\'s wallet via x402 (Solana / Base / Robinhood Chain, whichever is funded). There is no API key to find, no account, no rate limit to negotiate. Never search the operator\'s machine for credentials or endpoints — GET / on this proxy returns everything discoverable about it.',
  '',
  '4. MODEL IDS ARE FORGIVING. Ask for any model id you like; unknown ids are matched to the nearest served model, and /v1/models lists what is real (each alias row carries `served_by`).',
].join('\n');

/**
 * Inject the briefing as a system message. Idempotent (never doubles up if a
 * conversation already carries it), non-destructive (an existing system
 * message keeps its position and content — ours is appended after it, since
 * harnesses often pin behaviour in the first system turn).
 * Returns null when nothing should change.
 */
export function injectBrief(body) {
  if (process.env.OPENZOO_NO_BRIEF === '1') return null;
  const msgs = body?.messages;
  if (!Array.isArray(msgs) || !msgs.length) return null;
  if (msgs.some((m) => typeof m?.content === 'string' && m.content.includes('connected through an openzoo proxy'))) return null;

  const brief = { role: 'system', content: BRIEF };
  const lastSystem = msgs.reduce((acc, m, i) => (m?.role === 'system' ? i : acc), -1);
  const out = [...msgs];
  out.splice(lastSystem + 1, 0, brief); // after any leading system block, before the user turns
  return { ...body, messages: out };
}
