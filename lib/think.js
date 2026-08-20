/**
 * Model reasoning arrives on several wires:
 *   - leaked `<think>…</think>` / `<thinking>…` in the visible reply
 *   - `reasoning_content` / `reasoning` / `thinking` / `thought` on the delta
 *   - provider objects with a plaintext summary next to encrypted blobs
 *
 * Encrypted reasoning is not a thought we can show — never dump ciphertext
 * into the canvas. Empty plaintext means no thinking chip.
 */

const THINK_BLOCK = /<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi;
const THINK_OPEN = /<think(?:ing)?\b[^>]*>[\s\S]*$/i;
const THINK_CLOSE = /<\/think(?:ing)?>/gi;

const REASON_KEYS = [
  'reasoning_content',
  'reasoning',
  'reasoning_details',
  'thinking',
  'thought',
  'thoughts',
  'reasoning_text',
  'summary',
  'text',
];

export function looksEncryptedReasoning(s) {
  const t = String(s || '').trim();
  if (t.length < 48) return false;
  if (/\s/.test(t)) return false;
  return /^[A-Za-z0-9+/_=-]+$/.test(t);
}

function keyLooksEncrypted(key) {
  return /encrypt/i.test(String(key || ''));
}

/**
 * Pull displayable reasoning out of a provider field. Strings that look like
 * ciphertext, and objects typed/keyed as encrypted, become ''.
 */
export function reasoningPlaintext(value, depth = 0) {
  if (value == null || depth > 6) return '';
  if (typeof value === 'string') return looksEncryptedReasoning(value) ? '' : value;
  if (typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    return value.map((x) => reasoningPlaintext(x, depth + 1)).filter(Boolean).join('');
  }
  const type = String(value.type || value.kind || '');
  if (/encrypt/i.test(type)) return '';
  const parts = [];
  for (const key of REASON_KEYS) {
    if (!(key in value) || keyLooksEncrypted(key)) continue;
    const inner = reasoningPlaintext(value[key], depth + 1);
    if (inner) parts.push(inner);
  }
  return parts.join('');
}

/** True when a delta/message carried a reasoning field, including encrypted. */
export function reasoningPresent(delta, message) {
  for (const src of [delta, message]) {
    if (!src || typeof src !== 'object') continue;
    if (src.reasoning_content != null || src.reasoning != null
      || src.reasoning_details != null || src.thinking != null
      || src.thought != null || src.thoughts != null
      || src.reasoning_text != null || src.encrypted_content != null
      || src.reasoning_encrypted_content != null) return true;
  }
  return false;
}

/** Reasoning on a chat message or stream delta — never `message.content`. */
export function messageReasoning(msg, delta) {
  const blobs = [];
  for (const src of [delta, msg]) {
    if (!src || typeof src !== 'object') continue;
    blobs.push(reasoningPlaintext(src.reasoning_content));
    blobs.push(reasoningPlaintext(src.reasoning));
    blobs.push(reasoningPlaintext(src.reasoning_details));
    blobs.push(reasoningPlaintext(src.thinking));
    blobs.push(reasoningPlaintext(src.thought));
    blobs.push(reasoningPlaintext(src.thoughts));
    blobs.push(reasoningPlaintext(src.reasoning_text));
  }
  return blobs.filter((s) => String(s || '').trim()).join('');
}

export function splitThink(text) {
  const thoughts = [];
  let s = String(text ?? '');
  s = s.replace(THINK_BLOCK, (m) => {
    const a = m.indexOf('>');
    const b = m.toLowerCase().lastIndexOf('</think');
    if (a >= 0 && b > a) thoughts.push(m.slice(a + 1, b));
    return '';
  });
  s = s.replace(THINK_OPEN, (m) => {
    const a = m.indexOf('>');
    thoughts.push(a >= 0 ? m.slice(a + 1) : '');
    return '';
  });
  s = s.replace(THINK_CLOSE, '');
  const visible = s.replace(/^\n+|\n+$/g, '').trim();
  const thinking = thoughts.join('\n').replace(/^\n+|\n+$/g, '').trim();
  return { visible, thinking };
}

export function stripThinkTags(text) {
  return splitThink(text).visible;
}

export function wrapThink(thinking, visible) {
  const t = String(thinking || '').trim();
  const v = String(visible || '');
  if (!t) return v;
  return `<think>${t}</think>\n${v}`;
}

/** Persist thinking on a history row; never leave tags in the visible text. */
export function takeThink(raw, extraThink) {
  const parts = splitThink(raw);
  const extra = String(extraThink || '').trim();
  const thinking = [extra, parts.thinking].filter(Boolean).join('\n').trim();
  return { text: parts.visible, thinking: thinking || undefined };
}
