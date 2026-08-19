/**
 * Client side of "the body never ships twice."
 *
 * bindCorpus: hash the corpus; on a manifest hit return the recorded
 * context_id without touching the network. On a miss, POST the corpus ONCE to
 * the zoo's free bind endpoint (the gateway chunks it with leCore server-side)
 * and record the id.
 *
 * askWithContext: send the SMALL ask with X-HRR-Context. If the gateway says
 * the context is gone (sidecar wiped — HTTP 404 code context_not_found,
 * returned BEFORE the 402 so nothing was paid), forget the stale entry,
 * re-bind once, and retry. A stale manifest must never fail a call.
 */
import { config } from './config.js';
import { corpusHash, lookupContext, rememberContext, forgetContext } from './contexts.js';
import { postWithUploadSignal } from './spinner.js';
import { withNamespace } from './namespace.js';

/** Corpora under this many chars ride inline — binding has a round-trip cost
 *  and the reuse win only matters when the body is actually big. */
export const BIND_MIN_CHARS = Number(process.env.OPENZOO_CONTEXT_MIN_CHARS || 16384);

export const contextCacheDisabled = () => process.env.OPENZOO_NO_CONTEXT_CACHE === '1';

/**
 * Ensure `corpus` is bound on the zoo. Returns
 * { contextId, hash, reused, bytes } — reused=true means zero bytes shipped.
 */
export async function bindCorpus(corpus, { onStage, force = false, appendTo = null } = {}) {
  const hash = corpusHash(corpus);
  const bytes = Buffer.byteLength(corpus);
  if (!force) {
    const hit = lookupContext(config.apiBase, hash);
    if (hit) {
      onStage?.('reused', { contextId: hit.context_id, boundAt: hit.boundAt, bytes });
      return { contextId: hit.context_id, hash, reused: true, bytes };
    }
  }
  onStage?.('binding', { bytes });
  // APPEND, don't re-upload. The gateway takes context_id on /v1/hrr/bind and
  // adds to that context — which is the difference between paying for the
  // delta and paying for the whole transcript again on every single turn.
  const r = await postWithUploadSignal(`${config.apiBase}/v1/hrr/bind`,
    JSON.stringify(appendTo ? { corpus, context_id: appendTo } : { corpus }), {
    headers: withNamespace(),
    onUploaded: () => onStage?.('bound-uploading-done', { bytes }),
  });
  if (r.status !== 200) {
    throw new Error(`bind failed: HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  const j = await r.json();
  if (!j?.context_id) throw new Error('bind returned no context_id');
  rememberContext(config.apiBase, hash, j.context_id);
  return { contextId: j.context_id, hash, reused: false, bytes, bound: j.bound };
}

const isContextGone = (status, text) =>
  status === 404 && /context_not_found/.test(text);

/**
 * One paid ask against a bound corpus. bodyObj should already be SMALL (the
 * question, not the corpus). Retries exactly once through a fresh bind when
 * the context is gone. Returns { data, receipt, contextId, reused }.
 */
export async function askWithContext(client, corpus, bodyObj, { onStage } = {}) {
  let bind = await bindCorpus(corpus, { onStage });
  for (let attempt = 0; ; attempt++) {
    const { response, receipt } = await client.fetch(`${config.apiBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-HRR-Context': bind.contextId },
      body: JSON.stringify(bodyObj),
    }, { onStage });
    if (response.ok) {
      return { data: await response.json(), receipt, contextId: bind.contextId, reused: bind.reused };
    }
    const text = (await response.text()).slice(0, 500);
    if (attempt === 0 && isContextGone(response.status, text)) {
      onStage?.('rebinding', { contextId: bind.contextId });
      forgetContext(config.apiBase, bind.hash);
      bind = await bindCorpus(corpus, { onStage, force: true });
      continue;
    }
    throw new Error(`zoo returned HTTP ${response.status}: ${text}`);
  }
}
