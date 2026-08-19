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
  // SMALL ON PURPOSE. This used to be ~2.2KB of prose on EVERY request —
  // corpus binding, request-size limits, payment rails, model-id matching —
  // most of which a given call never needs, all of which the caller pays for in
  // tokens and latency. An agent that needs the detail can ask; what it cannot
  // work out for itself is the base URL and the one behaviour that changes how
  // it should send a big body. Everything else was documentation shipped as
  // overhead.
  ...(selfUrl ? [`Endpoint: ${selfUrl} (already ends in /v1). Routes: /chat/completions, /hrr/bind, /models.`] : []),
  'Bodies over ~16KB are bound to holographic memory and answered by retrieval, so a large corpus can be sent whole rather than summarised or chunked. A corpus sent once is not re-uploaded.',
  'Calls are paid per request from the operator\'s wallet; there is no key to supply. Unknown model ids match the nearest served model.',
].join('\n');

/** Stable substring used to detect an already-injected brief. Must appear in
 *  briefFor() output verbatim — see injectBrief(). */
export const BRIEF_MARK = 'bound to holographic memory and answered by retrieval';

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
  // THE SENTINEL MUST BE TEXT THE BRIEF ACTUALLY CONTAINS. This checked for
  // 'connected through an openzoo proxy' — the old opening line — so shrinking
  // the brief would have silently broken idempotency and stacked a fresh copy
  // onto every single turn, growing the system block without bound.
  if (msgs.some((m) => typeof m?.content === 'string' && m.content.includes(BRIEF_MARK))) return null;

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
