/**
 * openzoo voice — the X prehook.
 *
 * X gives no API to intercept an outgoing post: no edit endpoint, and its
 * webhooks are inbound-only. So the interception happens where the text
 * still belongs to you — the composer, before submit.
 *
 * THE MECHANISM: capture-phase listeners on the Post/Reply/Send controls
 * (and the Cmd/Ctrl+Enter shortcut). The first click is swallowed, the
 * draft is sent to the local openzoo shim to be rewritten in your voice,
 * the composer's contents are REPLACED, and then the original control is
 * clicked again — this time letting it through. Nothing is ever published
 * raw, which beats the Telegram flow (that one edits ~a second late, so
 * readers can glimpse the draft).
 *
 * WHY execCommand AND NOT textContent: X's composer is a Draft.js/Lexical
 * contenteditable backed by React state. Writing to the DOM directly
 * leaves React's model holding the OLD text, and X posts what React
 * believes — the visible edit silently does nothing. execCommand
 * insertText goes through the browser's editing pipeline, which fires the
 * beforeinput/input events React is listening for.
 *
 * FAILS OPEN, ALWAYS: if the shim is down, slow, or errors, the original
 * post goes out exactly as typed. A voice tool that can eat your posts is
 * worse than no voice tool.
 */

const ENDPOINT = 'http://127.0.0.1:8403/voice';
/**
 * Generous, because the voice model is PINNED to fable-5 for consistency
 * and that costs latency: MEASURED 34.9s on a real draft (model time plus
 * the per-call x402 settlement — recall is 0.1s and not the bottleneck).
 * A 25s ceiling here meant the hook timed out on every post and shipped
 * the raw draft, which looks exactly like the extension not working.
 */
const TIMEOUT_MS = 90_000;
/** Drafts shorter than this are left alone — "gm" needs no help. */
const MIN_CHARS = 12;
/** A leading "." means send exactly what I typed. Stripped before posting. */
const RAW_PREFIX = '.';

const SEND_BUTTONS = [
  '[data-testid="tweetButton"]',          // main composer (modal + inline)
  '[data-testid="tweetButtonInline"]',    // reply box under a post
  '[data-testid="dmComposerSendButton"]', // DM send
];

const EDITORS = [
  '[data-testid^="tweetTextarea_"]',
  '[data-testid="dmComposerTextInput"]',
];

/** Marks a control as "already voiced, let this click through". */
const PASS = new WeakSet();
let busy = false;

// ---------------------------------------------------------------- toast

let toastEl = null;
function toast(msg, ms = 2600) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    Object.assign(toastEl.style, {
      position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '2147483647', padding: '10px 14px', borderRadius: '9999px',
      font: '13px/1.3 -apple-system, system-ui, sans-serif', color: '#fff',
      background: 'rgba(0,0,0,.85)', border: '1px solid rgba(255,255,255,.15)',
      pointerEvents: 'none', maxWidth: '80vw', textAlign: 'center',
      transition: 'opacity .2s', whiteSpace: 'pre-wrap',
    });
    document.documentElement.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.style.opacity = '0'; }, ms);
}

// ---------------------------------------------------------------- composer

/** The editor the user is actually typing in, nearest the clicked control. */
function findEditor(fromEl) {
  const scope = fromEl?.closest('[role="dialog"]') || document;
  for (const sel of EDITORS) {
    const nodes = [...scope.querySelectorAll(sel)].filter((n) => n.isContentEditable);
    if (nodes.length) return nodes[nodes.length - 1];
  }
  for (const sel of EDITORS) {
    const nodes = [...document.querySelectorAll(sel)].filter((n) => n.isContentEditable);
    if (nodes.length) return nodes[nodes.length - 1];
  }
  return null;
}

function readDraft(editor) {
  return (editor?.innerText ?? '').replace(/​/g, '').replace(/\n+$/, '');
}

/**
 * Replace the composer's text through the editing pipeline so React sees
 * it. Select-all then insertText is the only reliable path across both
 * X's tweet composer and its DM box.
 */
function writeDraft(editor, text) {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const ok = document.execCommand('insertText', false, text);
  if (!ok) {
    // Fallback for browsers where execCommand is gone: paste event with
    // synthetic clipboard data, which React's editors also honour.
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }
  return readDraft(editor);
}

/** post | reply | quote | dm — steers register on the shim side. */
function kindOf(button, editor) {
  if (button.matches('[data-testid="dmComposerSendButton"]')) return 'dm';
  const dialog = button.closest('[role="dialog"]');
  const root = dialog || document;
  if (root.querySelector('[data-testid="quoteTweet"], div[role="link"][data-testid="Tweet-User-Avatar"]')
      && button.matches('[data-testid="tweetButton"]')) return 'quote';
  if (button.matches('[data-testid="tweetButtonInline"]')) return 'reply';
  const label = (editor?.getAttribute('aria-label') || '').toLowerCase();
  if (label.includes('reply')) return 'reply';
  return 'post';
}

async function voice(text, kind) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, kind }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`shim ${res.status}`);
    const j = await res.json();
    if (!j?.text) throw new Error(j?.error || 'empty rewrite');
    return j;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- intercept

async function intercept(button, resend) {
  const editor = findEditor(button);
  if (!editor) return false;
  const draft = readDraft(editor);

  if (draft.startsWith(RAW_PREFIX)) {
    writeDraft(editor, draft.slice(RAW_PREFIX.length).trimStart());
    toast('sent raw');
    return true;   // strip the marker, then let it fly untouched
  }
  if (draft.trim().length < MIN_CHARS) return true;

  const kind = kindOf(button, editor);
  busy = true;
  // A ticking counter, because a silent 35s wait after clicking Post is
  // indistinguishable from a hung page.
  const startedAt = Date.now();
  toast('voicing…');
  const tick = setInterval(
    () => toast(`voicing… ${Math.round((Date.now() - startedAt) / 1000)}s`),
    1000,
  );
  try {
    const { text, receipt } = await voice(draft, kind);
    const same = text.replace(/\s+/g, ' ').trim() === draft.replace(/\s+/g, ' ').trim();
    if (!same) writeDraft(editor, text);
    toast(same ? `already in voice · ${receipt}` : `voiced · ${receipt}`);
  } catch (e) {
    // FAIL OPEN. The draft goes out as typed.
    toast(`voice unavailable — posting as typed\n(${String(e.message || e).slice(0, 80)})`, 3600);
  } finally {
    clearInterval(tick);
    busy = false;
  }
  return true;
}

/**
 * Capture-phase, so this runs before React's own handler. The click is
 * swallowed once; after the rewrite the same control is clicked again
 * with a pass marker, and that second click reaches X untouched.
 */
document.addEventListener('click', (ev) => {
  if (busy) { ev.preventDefault(); ev.stopPropagation(); return; }
  const button = ev.target?.closest?.(SEND_BUTTONS.join(','));
  if (!button || PASS.has(button)) { PASS.delete(button); return; }
  if (button.getAttribute('aria-disabled') === 'true') return;

  ev.preventDefault();
  ev.stopPropagation();
  ev.stopImmediatePropagation();

  void intercept(button).then((ok) => {
    if (!ok) return;
    PASS.add(button);
    // Re-dispatch on the live node: X re-renders during the await, so the
    // captured reference can be detached by the time we resubmit.
    const fresh = document.querySelector(
      SEND_BUTTONS.find((s) => button.matches(s)) || SEND_BUTTONS[0],
    ) || button;
    PASS.add(fresh);
    fresh.click();
  });
}, true);

/** Cmd/Ctrl+Enter posts without touching the button — same treatment. */
document.addEventListener('keydown', (ev) => {
  if (!(ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey))) return;
  const editor = ev.target?.closest?.(EDITORS.join(','));
  if (!editor) return;
  if (busy) { ev.preventDefault(); ev.stopPropagation(); return; }

  const button = document.querySelector(SEND_BUTTONS.join(','));
  if (!button || PASS.has(button)) return;

  ev.preventDefault();
  ev.stopPropagation();
  ev.stopImmediatePropagation();

  void intercept(button).then((ok) => {
    if (!ok) return;
    const fresh = document.querySelector(SEND_BUTTONS.join(',')) || button;
    PASS.add(fresh);
    fresh.click();
  });
}, true);

console.info('[openzoo voice] prehook armed — drafts are revised before they publish. Prefix with "." to send raw.');
