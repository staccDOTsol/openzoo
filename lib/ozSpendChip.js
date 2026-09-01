/**
 * Cafe spend chip — the ⓘ $N <details> that folds formatSpendFooter.
 *
 * Cafe injects this via grokbotweb-shim concatenation. Grok Bot.app cannot
 * be patched (asar integrity), so `openzoo bot` launches Chromium with a
 * localhost CDP port and evaluates the same IIFE in the renderer.
 */
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spendChipLabel } from './spendProof.js';

export const GROKBOT_CDP_PORT = Number(process.env.OZ_GROKBOT_CDP_PORT || 9444);

/** Session totals for a floating pill when the open canvas has no footer. */
export function sessionSpendLabel(home = os.homedir()) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(home, '.openzoo', 'session.json'), 'utf8'));
    const spent = Number(s.spentUsd || s.spendUsd || 0);
    const would = Number(s.directUsd || 0);
    const saved = Number(s.savedUsd != null ? s.savedUsd : Math.max(0, would - spent));
    if (!(spent > 0.00005)) return '';
    return spendChipLabel({ spent, would, saved, pct: would > 0 ? (100 * saved) / would : 0 });
  } catch {
    return '';
  }
}

export function grokBotChromiumArgs(port = GROKBOT_CDP_PORT) {
  return [
    '--ignore-certificate-errors',
    `--remote-debugging-port=${Number(port)}`,
    '--remote-allow-origins=*',
  ];
}

function chipUsd(n) {
  const x = Number(n) || 0;
  if (Math.abs(x) >= 0.01) return `$${x.toFixed(2)}`;
  return `$${x.toFixed(4)}`;
}

/** Rebuild pill from spent/saved even if the tag is only `$0.0010`. */
export function labelFromSpendBody(body, fallback) {
  const s = String(body || '');
  const spent = Number(s.match(/spent \$([0-9.]+)/i)?.[1]);
  const saved = Number(s.match(/saved \$([0-9.]+)/i)?.[1]);
  const would = Number(s.match(/OpenRouter would \$([0-9.]+)/i)?.[1]);
  if (!Number.isFinite(spent) || !(spent > 0)) return (fallback || 'spend').trim();
  const savedN = Number.isFinite(saved) ? saved : (Number.isFinite(would) ? Math.max(0, would - spent) : 0);
  const wouldN = Number.isFinite(would) && would > 0 ? would : 0;
  const pct = wouldN > 0 ? Math.round((100 * savedN) / wouldN) : 0;
  const bits = [chipUsd(spent)];
  if (savedN > 0.00005) bits.push(`saved ${chipUsd(savedN)}`);
  const sav = [];
  if (pct >= 1) sav.push(`${pct}%`);
  if (wouldN > 0 && spent > 0) {
    const m = wouldN / spent;
    if (m >= 1.05) sav.push(m >= 10 ? `${m.toFixed(1)}×` : `${m.toFixed(2)}×`);
  }
  if (sav.length) bits.push(sav.join('/'));
  return bits.join(' · ');
}

/** Drop proves-wall / other-bot transcript that leaked into vis text. */
export function spendLinesOnly(body) {
  const raw = String(body || '').replace(/::oz-spend::[^\n]*/gi, ' ');
  const parts = raw.split(/\n|(?=this call \$)|(?=spent \$)|(?=tx )|(?=memo )|(?=proves )/i);
  const keep = [];
  let txs = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const line = String(parts[i] || '').trim();
    if (!line) continue;
    if (/^this call \$/i.test(line) || /^spent \$/i.test(line)) { keep.push(line); continue; }
    if (/^tx /i.test(line) || /^https?:\/\/(?:solscan|basescan)/i.test(line)) {
      txs += 1;
      if (txs === 1) keep.push(/^tx /i.test(line) ? line : `tx ${line}`);
      continue;
    }
    if (/^memo /i.test(line)) { keep.push(line.slice(0, 160)); continue; }
    if (/^proves /i.test(line)) continue;
    if (keep.length) break;
  }
  if (txs > 1 && keep.length) {
    const last = keep.length - 1;
    if (/^tx /i.test(keep[last])) keep[last] += `  (+${txs - 1} earlier)`;
  }
  return keep.join('\n');
}

/** Pure. Same split the renderer IIFE uses.
 *  vis text from TreeWalker has NO newlines between React text nodes, so
 *  `[^\n]+` used to swallow the whole footer and skip the pill (body < 12). */
export function splitSpendText(text) {
  const s = String(text || '');
  const mark = s.search(/::oz-spend::/i);
  let head = '';
  let raw = '';
  if (mark >= 0) {
    head = s.slice(0, mark);
    raw = s.slice(mark + '::oz-spend::'.length);
  } else {
    const m = s.match(/(?:this call \$|spent \$)[\s\S]*$/i);
    if (!m) return null;
    head = s.slice(0, m.index);
    raw = m[0];
  }
  const bodyAt = raw.search(/(?:this call \$)|(?:spent \$)/i);
  let summary = '';
  let body = raw;
  if (bodyAt > 0) {
    summary = raw.slice(0, bodyAt).replace(/^\s+|\s+$/g, '');
    body = raw.slice(bodyAt);
  } else if (bodyAt === 0) {
    summary = '';
    body = raw;
  } else {
    const nl = raw.indexOf('\n');
    if (nl >= 0) {
      summary = raw.slice(0, nl).trim();
      body = raw.slice(nl + 1);
    }
  }
  body = spendLinesOnly(body);
  if (!body || body.length < 8) return null;
  summary = labelFromSpendBody(body, summary);
  return { head, summary: summary || 'spend', body };
}

export function spendOnlyText(t) {
  const s = String(t || '').replace(/\u00a0/g, ' ').trim();
  if (!s) return false;
  if (!/::oz-spend::|this call \$|spent \$[0-9.]+[\s\S]*OpenRouter/i.test(s)) return false;
  const rest = s
    .replace(/::oz-spend::\$?[0-9.]*/gi, ' ')
    .replace(/this call \$[0-9.]+/gi, ' ')
    .replace(/OpenRouter(?: would)? \$[0-9.]+/gi, ' ')
    .replace(/spent \$[0-9.]+/gi, ' ')
    .replace(/saved \$[0-9.]+/gi, ' ')
    .replace(/balance \$[0-9.]+/gi, ' ')
    .replace(/\(\s*\d+%\s*\)/g, ' ')
    .replace(/\d+%\s*\/\s*[\d.]+×/g, ' ')
    .replace(/\d+%/g, ' ')
    .replace(/[×xX]/g, ' ')
    .replace(/\b(?:tx|memo|proves)\b[^\n]*/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[·•.,;:/$%\d\s()[\]+\-]/g, '');
  return rest.length < 4;
}

function ozEnsureSpendCss() {
  let s = document.getElementById('oz-spend-css');
  if (!s) {
    s = document.createElement('style');
    s.id = 'oz-spend-css';
    (document.head || document.documentElement).appendChild(s);
  }
  s.textContent = [
    '.oz-spend{margin:.55rem 0 0;font-size:12px;color:inherit;opacity:.82;max-width:36em}',
    '#oz-spend-float>summary{cursor:grab}',
    '.oz-spend>summary{cursor:help;list-style:none;display:inline-flex;align-items:center;gap:.35rem;',
    'padding:3px 9px;border-radius:999px;border:1px solid rgba(255,255,255,.18);white-space:nowrap;',
    'max-width:100%;overflow:hidden;text-overflow:ellipsis}',
    '.oz-spend>summary::-webkit-details-marker{display:none}',
    '.oz-spend-body{white-space:pre-wrap;margin:.55rem 0 0;font-size:11px;line-height:1.45;opacity:.88;overflow-wrap:anywhere}',
    '[data-oz-spend-hide]{display:none!important}',
    'button[aria-label="Start voice input"],button[aria-label*="voice input" i],',
    'button[aria-label*="steminvoer" i],button[aria-label^="Microphone"]{display:none!important}',
  ].join('');
}

function ozSpendHost(el) {
  let cur = el;
  let found = el;
  let card = null;
  for (let i = 0; i < 16 && cur && cur !== document.body && cur.id !== 'root'; i += 1) {
    const t = cur.textContent || '';
    if (/::oz-spend::|this call \$|spent \$/i.test(t)) found = cur;
    const cls = cur.className && String(cur.className);
    if (cls && /sand-message-card|sand-message-block/.test(cls)) {
      card = cur;
      return cur;
    }
    if (cls && /(^|\s)sand-message(\s|$)/.test(cls)) card = cur;
    cur = cur.parentElement;
  }
  if (card) return card;
  if (found && found !== document.body && found.id !== 'root' && (found.textContent || '').length < 12000) {
    return found;
  }
  return null;
}

function ozVisibleSpendText(root) {
  let s = '';
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  while (w.nextNode()) {
    const tn = w.currentNode;
    if (tn.parentElement && tn.parentElement.closest && tn.parentElement.closest('.oz-spend')) continue;
    s += tn.nodeValue || '';
  }
  return s;
}

/** Per-node. Global keepLen ate list items when vis had no newlines (head ''). */
export function stripSpendFromText(s) {
  const t = String(s || '');
  const cut = t.search(/::oz-spend::/i);
  if (cut >= 0) return cut > 0 ? t.slice(0, cut) : '';
  if (/^\s*(this call \$|spent \$[0-9.]+(?:\s|·)|tx https?:|memo |proves )/i.test(t)) return '';
  return t;
}

function ozBlankSpendIn(root) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  while (w.nextNode()) {
    const tn = w.currentNode;
    if (tn.parentElement && tn.parentElement.closest && tn.parentElement.closest('.oz-spend')) continue;
    const next = stripSpendFromText(tn.nodeValue || '');
    if (next !== tn.nodeValue) tn.nodeValue = next;
  }
}

function ozHideSpendLeftovers() {
  const nodes = document.body.querySelectorAll('div, p, span, li');
  for (let i = 0; i < nodes.length; i += 1) {
    const el = nodes[i];
    if (el.closest && el.closest('.oz-spend')) continue;
    if (el.querySelector && el.querySelector('.oz-spend')) continue;
    const vis = ozVisibleSpendText(el);
    if (!spendOnlyText(vis)) continue;
    if (vis.length > 4000) continue;
    if (el.children && el.children.length > 8) continue;
    el.setAttribute('data-oz-spend-hide', '1');
  }
}

function ozPreviousMessageCard(el) {
  let cur = el;
  for (let i = 0; i < 8 && cur && cur !== document.body; i += 1) {
    let sib = cur.previousElementSibling;
    while (sib) {
      if (sib === el) {
        sib = sib.previousElementSibling;
        continue;
      }
      const cls = String(sib.className || '');
      if (/sand-message-card|sand-message-block/.test(cls) || /(^|\s)sand-message(\s|$)/.test(cls)) {
        return sib;
      }
      const inner = sib.querySelector && sib.querySelector('.sand-message-card, .sand-message-block');
      if (inner) return inner;
      sib = sib.previousElementSibling;
    }
    cur = cur.parentElement;
  }
  return null;
}

function ozAttachSpendChip(host, split) {
  if (!host || !split) return;
  const existing = host.querySelector && host.querySelector('.oz-spend');
  if (existing) {
    const sum = existing.querySelector('summary');
    const body = existing.querySelector('.oz-spend-body');
    if (sum) sum.textContent = 'ⓘ ' + split.summary;
    if (body) body.textContent = split.body;
    return;
  }
  const d = document.createElement('details');
  d.className = 'oz-spend';
  const sum = document.createElement('summary');
  sum.textContent = 'ⓘ ' + split.summary;
  sum.title = split.body;
  const body = document.createElement('div');
  body.className = 'oz-spend-body';
  body.textContent = split.body;
  d.appendChild(sum);
  d.appendChild(body);
  try { host.appendChild(d); } catch { /* react owns some nodes */ }
}

function ozCollapseSpend() {
  if (!document.body) return;
  const hosts = [];
  const seen = new Set();
  const nodes = document.body.querySelectorAll('div, p, span, li');
  for (let i = 0; i < nodes.length; i += 1) {
    const el = nodes[i];
    if (el.closest && el.closest('.oz-spend')) continue;
    const t = ozVisibleSpendText(el);
    if (!/::oz-spend::|this call \$|spent \$/i.test(t)) continue;
    const host = ozSpendHost(el);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  for (let h = 0; h < hosts.length; h += 1) {
    const host = hosts[h];
    const vis = ozVisibleSpendText(host);
    const split = splitSpendText(vis);
    if (!split || !split.body || split.body.length < 12) continue;
    ozEnsureSpendCss();
    if (spendOnlyText(vis)) {
      const prev = ozPreviousMessageCard(host);
      if (prev && prev !== host) {
        ozAttachSpendChip(prev, split);
        host.setAttribute('data-oz-spend-hide', '1');
        continue;
      }
    }
    ozBlankSpendIn(host);
    ozAttachSpendChip(host, split);
  }
  ozHideSpendLeftovers();
  ozEnsureFloatSpend();
}

function ozEnsureFloatSpend() {
  const label = String(window.__OZ_SESSION_SPEND__ || '').trim();
  const msgPills = document.querySelectorAll('.oz-spend:not(#oz-spend-float)').length;
  let el = document.getElementById('oz-spend-float');
  if (!label || msgPills) {
    if (el) el.remove();
    return;
  }
  ozEnsureSpendCss();
  if (!el) {
    el = document.createElement('details');
    el.id = 'oz-spend-float';
    el.className = 'oz-spend';
    const sum = document.createElement('summary');
    const body = document.createElement('div');
    body.className = 'oz-spend-body';
    body.textContent = 'session spend (this openzoo bot)';
    el.appendChild(sum);
    el.appendChild(body);
    document.body.appendChild(el);
  }
  ozPlaceFloat(el);
  ozDragFloat(el);
  const sum = el.querySelector('summary');
  if (sum) sum.textContent = 'ⓘ ' + label;
}

function ozSavedFloatPos() {
  try {
    const p = JSON.parse(localStorage.getItem('oz-spend-float-pos') || 'null');
    if (p && Number.isFinite(+p.left) && Number.isFinite(+p.top)) return { left: +p.left, top: +p.top };
  } catch (e) {}
  return null;
}

function ozPlaceFloat(el) {
  if (!el) return;
  el.style.position = 'fixed';
  el.style.zIndex = '2147483646';
  el.style.opacity = '0.95';
  const saved = ozSavedFloatPos();
  if (saved) {
    el.style.left = Math.max(8, saved.left) + 'px';
    el.style.top = Math.max(8, saved.top) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    return;
  }
  el.style.left = 'auto';
  el.style.right = '16px';
  el.style.top = '48px';
  el.style.bottom = 'auto';
}

function ozDragFloat(el) {
  if (!el || el.dataset.ozDrag === '1') return;
  el.dataset.ozDrag = '1';
  const sum = el.querySelector('summary') || el;
  let dragging = false;
  let moved = false;
  let dx = 0;
  let dy = 0;
  sum.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    dragging = true;
    moved = false;
    const r = el.getBoundingClientRect();
    dx = ev.clientX - r.left;
    dy = ev.clientY - r.top;
    el.style.cursor = 'grabbing';
    try { sum.setPointerCapture(ev.pointerId); } catch (e) {}
    ev.preventDefault();
    ev.stopPropagation();
  });
  sum.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    moved = true;
    el.style.left = Math.max(8, ev.clientX - dx) + 'px';
    el.style.top = Math.max(8, ev.clientY - dy) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    el.style.cursor = 'grab';
    const r = el.getBoundingClientRect();
    try { localStorage.setItem('oz-spend-float-pos', JSON.stringify({ left: r.left, top: r.top })); } catch (e) {}
  };
  sum.addEventListener('pointerup', end);
  sum.addEventListener('pointercancel', end);
  sum.addEventListener('click', (ev) => {
    if (moved) { ev.preventDefault(); ev.stopPropagation(); }
  }, true);
}

function ozWatchSpend() {
  let t = 0;
  const run = () => {
    const a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.isContentEditable)) return;
    try { ozCollapseSpend(); } catch (e) {}
  };
  const debounced = () => { clearTimeout(t); t = setTimeout(run, 600); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
  try {
    const mo = new MutationObserver(debounced);
    const start = () => { if (document.body) mo.observe(document.body, { childList: true, subtree: false }); };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
  } catch (e) {}
  try { window.addEventListener('resize', debounced); } catch (e) {}
}

export function spendChipSource() {
  return [
    '(function ozSpendChip(){',
    "'use strict';",
    'if (window.__OZ_SPEND_CHIP__ === 12) return;',
    'window.__OZ_SPEND_CHIP__ = 12;',
    chipUsd.toString(),
    labelFromSpendBody.toString(),
    spendLinesOnly.toString(),
    splitSpendText.toString(),
    spendOnlyText.toString(),
    ozEnsureSpendCss.toString(),
    ozSpendHost.toString(),
    ozVisibleSpendText.toString(),
    stripSpendFromText.toString(),
    ozBlankSpendIn.toString(),
    ozHideSpendLeftovers.toString(),
    ozPreviousMessageCard.toString(),
    ozAttachSpendChip.toString(),
    ozCollapseSpend.toString(),
    ozEnsureFloatSpend.toString(),
    ozSavedFloatPos.toString(),
    ozPlaceFloat.toString(),
    ozDragFloat.toString(),
    ozWatchSpend.toString(),
    'ozWatchSpend();',
    '})();',
  ].join('\n');
}

function wsMaskFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const mask = crypto.randomBytes(4);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | len;
    mask.copy(header, 2);
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    mask.copy(header, 10);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, masked]);
}

function decodeWsFrames(buf) {
  const frames = [];
  let rest = buf;
  while (rest.length >= 2) {
    const opcode = rest[0] & 0x0f;
    const masked = (rest[1] & 0x80) !== 0;
    let len = rest[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (rest.length < 4) break;
      len = rest.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (rest.length < 10) break;
      len = Number(rest.readBigUInt64BE(2));
      offset = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (rest.length < offset + maskLen + len) break;
    let payload = rest.subarray(offset + maskLen, offset + maskLen + len);
    if (masked) {
      const mask = rest.subarray(offset, offset + 4);
      const decoded = Buffer.alloc(len);
      for (let i = 0; i < len; i += 1) decoded[i] = payload[i] ^ mask[i % 4];
      payload = decoded;
    }
    frames.push({ opcode, payload });
    rest = rest.subarray(offset + maskLen + len);
  }
  return { frames, rest };
}

export function cdpSession(wsUrl, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(wsUrl); } catch (e) { reject(e); return; }
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let settled = false;
    let nextId = 0;
    const pending = new Map();
    const timer = setTimeout(() => {
      if (!upgraded) fail(new Error('cdp timeout'));
    }, timeoutMs);

    function fail(err) {
      if (settled) {
        sock.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    }

    sock.on('error', fail);
    sock.on('connect', () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n`
        + `Host: ${u.host}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Sec-WebSocket-Version: 13\r\n'
        + `Sec-WebSocket-Key: ${key}\r\n`
        + `Origin: http://${u.host}\r\n`
        + '\r\n',
      );
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString('utf8');
        buf = buf.subarray(idx + 4);
        if (!/^HTTP\/1\.1 101/i.test(head)) {
          fail(new Error(`cdp upgrade ${head.split('\r\n')[0] || 'failed'}`));
          return;
        }
        upgraded = true;
        settled = true;
        clearTimeout(timer);
        resolve({
          send(method, params) {
            const id = ++nextId;
            return new Promise((res, rej) => {
              const t = setTimeout(() => {
                pending.delete(id);
                rej(new Error(`cdp ${method} timeout`));
              }, Math.max(1000, timeoutMs));
              pending.set(id, {
                res: (v) => { clearTimeout(t); res(v); },
                rej: (e) => { clearTimeout(t); rej(e); },
              });
              try { sock.write(wsMaskFrame(JSON.stringify({ id, method, params }))); } catch (e) {
                clearTimeout(t);
                pending.delete(id);
                rej(e);
              }
            });
          },
          close() {
            clearTimeout(timer);
            try { sock.destroy(); } catch { /* */ }
          },
        });
      }
      const decoded = decodeWsFrames(buf);
      buf = decoded.rest;
      for (const f of decoded.frames) {
        if (f.opcode === 0x9) {
          try { sock.write(wsMaskFrame(f.payload, 0xa)); } catch { /* */ }
          continue;
        }
        if (f.opcode === 0x8) {
          sock.destroy();
          continue;
        }
        if (f.opcode !== 0x1 && f.opcode !== 0x0) continue;
        let msg;
        try { msg = JSON.parse(f.payload.toString('utf8')); } catch { continue; }
        if (msg && msg.id != null && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          else res(msg.result);
        }
      }
    });
  });
}

export async function listCdpPages(port, fetchImpl = fetch) {
  for (const path of ['/json/list', '/json']) {
    try {
      const r = await fetchImpl(`http://127.0.0.1:${Number(port)}${path}`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const arr = Array.isArray(j) ? j : [];
      return arr.filter((t) => t && t.webSocketDebuggerUrl && t.type !== 'service_worker' && t.type !== 'worker');
    } catch { /* try next */ }
  }
  return [];
}

async function injectTarget(target, source, connect, { waitForUi = false } = {}) {
  const session = await connect(target.webSocketDebuggerUrl);
  try {
    await session.send('Page.enable').catch(() => {});
    await session.send('Runtime.enable').catch(() => {});
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source }).catch(() => {});
    if (waitForUi) {
      for (let i = 0; i < 32; i += 1) {
        try {
          const r = await session.send('Runtime.evaluate', {
            expression: '!!document.querySelector(\'[class*="sand-"], textarea, [contenteditable="true"]\')',
            returnByValue: true,
          });
          if (r?.result?.value) break;
        } catch { /* still booting */ }
        await new Promise((ok) => setTimeout(ok, 250));
      }
    }
    await session.send('Runtime.evaluate', { expression: source, awaitPromise: false });
  } finally {
    session.close();
  }
}

export async function injectSpendChip({
  port = GROKBOT_CDP_PORT,
  source = spendChipSource(),
  log = () => {},
  fetchImpl = fetch,
  connect = cdpSession,
  tries = 40,
  delayMs = 400,
  waitForUi = false,
} = {}) {
  let targets = [];
  for (let i = 0; i < Math.max(1, tries); i += 1) {
    targets = await listCdpPages(port, fetchImpl);
    if (targets.length) break;
    if (i + 1 < tries && delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  if (!targets.length) {
    log(`openzoo: spend chip CDP :${port} has no pages yet`);
    return { ok: false, injected: 0 };
  }
  const label = sessionSpendLabel();
  const src = `window.__OZ_SESSION_SPEND__=${JSON.stringify(label)};\n${source}`;
  let injected = 0;
  for (const t of targets) {
    try {
      await injectTarget(t, src, connect, { waitForUi });
      injected += 1;
    } catch (e) {
      log(`openzoo: spend chip inject ${e.message}`);
    }
  }
  if (injected) log(`openzoo: spend chip folded into ${injected} renderer(s)`);
  return { ok: injected > 0, injected };
}

/** One CDP attach, then drop the debugger. A loop here pauses the renderer
 *  so the composer accepts a keystroke and then dies. Reloads pick the chip
 *  up via Page.addScriptToEvaluateOnNewDocument from that single inject. */
export function injectSpendChipInBackground(opts = {}) {
  const log = opts.log || ((m) => console.error(m));
  const wait = Math.max(0, Number(opts.delayMs) || 400);
  setTimeout(() => {
    injectSpendChip({
      tries: 24,
      delayMs: 400,
      waitForUi: true,
      ...opts,
      log,
      connect: (ws) => cdpSession(ws, { timeoutMs: 2500 }),
    }).catch((e) => {
      log(`openzoo: spend chip inject failed ${e.message}`);
    });
  }, wait);
}

