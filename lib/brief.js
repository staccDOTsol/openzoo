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
  'Environment notes for this endpoint (descriptive — verify anything you rely on):',
  '',
  ...(selfUrl ? [
    `- Base URL: ${selfUrl}. It already ends in /v1, so routes are ${selfUrl}/chat/completions, ${selfUrl}/hrr/bind, ${selfUrl}/models. A doubled /v1 is repaired by the proxy but logs a warning. openzoo.fun is a website, not an API host.`,
    '',
  ] : []),
  '- Long bodies: requests over ~16KB are carved and bound to a holographic (HRR) memory before the model sees them, and the model answers from retrieval over that. So a large corpus can be sent whole; summarising or chunking it to fit is not required here, though nothing stops you. `context_length` in /v1/models reports the client-usable ceiling (128M tokens); the transformer window is `max_model_len`. A single POST over ~9.8M tokens (~32MiB) is rejected by the edge.',
  '',
  '- Repeat sends: a corpus placed first, followed by a blank line and then a question, binds once. Later questions reusing it ship only the question, which is cheaper and faster. Re-sending the same corpus each turn costs full price each time.',
  '',
  '  Explicit bind (unpaid): POST /v1/hrr/bind with {"corpus": "..."} returns {"context_id": "..."}. Passing that id as the X-HRR-Context header on later /v1/chat/completions calls lets the body stay small. Passing an existing context_id alongside a new corpus appends to it, which is how a corpus larger than one request gets bound in parts.',
  '  Request size: single requests over ~8MB are dropped by the network hop before reaching the proxy (opaque 413 or dead connection). That is a request limit, not a context limit.',
  '',
  '- Payment: calls are settled per request from the operator\'s own wallet via x402 (Solana / Base / Robinhood Chain, whichever is funded). There is no account to create and no key for you to supply or handle. GET / on this proxy returns the same description. /hrr/bind and GET /models are unpaid; /chat/completions is paid and uses the bearer key the client is already configured with, which is not readable from inside the conversation.',
  '',
  '- Model ids: unknown ids are matched to the nearest served model rather than erroring. /v1/models lists what is actually served, and each alias row carries `served_by`.',
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
  // THE LEADING SYSTEM RUN ONLY — NOT THE LAST SYSTEM ANYWHERE.
  //
  // This used to reduce over the WHOLE array for the last `role === 'system'`,
  // which is the same thing only while every system message sits at the front.
  // The moment anything injects one later, the brief is spliced in AFTER the
  // user's turn, and the conversation the model receives ends with operator
  // notes instead of a question.
  //
  // OBSERVED live: forwarded tail `s a t a t a u s a u s s` — two system
  // messages after the last user message. The agent replied "I don't see an
  // explicit question or task for this turn", answered the PREVIOUS turn, and
  // read as one message behind for an entire session.
  let lead = -1;
  while (lead + 1 < msgs.length && msgs[lead + 1]?.role === 'system') lead += 1;
  const out = [...msgs];
  out.splice(lead + 1, 0, brief); // after the leading system block, before any turn
  return { ...body, messages: out };
}
